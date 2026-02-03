import type { Env } from "./env.js";
import { log } from "./log.js";
import { pushAnomaly } from "./anomalies.js";
import { normalizeEmail, extractStampUtc, toBerlinISO, berlinDayEndUtcMillis } from "./timemoto.js";
import { getEmployeeIdByEmail, createAttendance, patchAttendanceEnd } from "./personio.js";

type RedisLike = {
  get(key: string): Promise<any>;
  set(key: string, value: any, opts?: any): Promise<any>;
  del(key: string): Promise<any>;
  zadd(key: string, ...args: any[]): Promise<any>;
  zrem(key: string, member: string): Promise<any>;
};

type TMEvent = {
  id: string;
  event: string;
  dispatchedAt?: number;
  data?: any;
};

type OpenSession = {
  email: string;
  employeeId: string;
  startUtcMs: number;
  startBerlinISO: string;
  autoCloseAtUtcMs: number;
  autoCloseAtBerlinISO: string;
  personioPeriodId: string;
  openedEventId: string;
  openedAtIso: string;
};

type LastSession = {
  email: string;
  employeeId: string;
  startUtcMs: number;
  endUtcMs: number;
  startBerlinISO: string;
  endBerlinISO: string;
  personioPeriodId: string;
  endReason: "OUT" | "AUTO_CLOSE" | "DOUBLE_IN_CLOSE";
  closedEventId?: string | null;
  closedAtIso: string;
};

const KEY_EVENT = (id: string) => `event:seen:${id}`;
const KEY_OPEN = (email: string) => `session:open:${email}`;
const KEY_LAST = (email: string) => `session:last:${email}`;
const ZSET_AUTOCLOSE = `session:autoclose`; // score=utcMs, member=email

function nowIso() {
  return new Date().toISOString();
}

function addMs(d: Date, ms: number) {
  return new Date(d.getTime() + ms);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function autoCloseUtcMs(startUtc: Date): number {
  const t12h = startUtc.getTime() + 12 * 60 * 60 * 1000;
  const dayEnd = berlinDayEndUtcMillis(startUtc);
  // Endzeit = min(ClockIn + 12h, Tagesgrenze 23:59 Europe/Berlin)
  return Math.min(t12h, dayEnd);
}

function getEmailFromEvent(ev: TMEvent): string | null {
  // Best: employeeNumber contains email (you’re filling it)
  const e1 = normalizeEmail(ev?.data?.userEmployeeNumber);
  if (e1) return e1;

  // Some user events include emailAddress
  const e2 = normalizeEmail(ev?.data?.emailAddress);
  if (e2) return e2;

  return null;
}

async function markEventSeen(redis: RedisLike, id: string): Promise<boolean> {
  // Upstash supports NX
  const r = await redis.set(KEY_EVENT(id), "1", { nx: true, ex: 60 * 60 * 24 * 30 });
  // If already exists -> r is null/undefined/false depending on client
  return r === "OK" || r === true;
}

async function loadOpen(redis: RedisLike, email: string): Promise<OpenSession | null> {
  const raw = await redis.get(KEY_OPEN(email));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as OpenSession) : (raw as OpenSession);
  } catch {
    return null;
  }
}

async function saveOpen(redis: RedisLike, s: OpenSession): Promise<void> {
  await redis.set(KEY_OPEN(s.email), JSON.stringify(s));
  await redis.zadd(ZSET_AUTOCLOSE, { score: s.autoCloseAtUtcMs, member: s.email });
}

async function clearOpen(redis: RedisLike, email: string): Promise<void> {
  await redis.del(KEY_OPEN(email));
  await redis.zrem(ZSET_AUTOCLOSE, email);
}

async function saveLast(redis: RedisLike, last: LastSession): Promise<void> {
  await redis.set(KEY_LAST(last.email), JSON.stringify(last), { ex: 60 * 60 * 24 * 7 }); // keep 7d
}

async function loadLast(redis: RedisLike, email: string): Promise<LastSession | null> {
  const raw = await redis.get(KEY_LAST(email));
  if (!raw) return null;
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as LastSession) : (raw as LastSession);
  } catch {
    return null;
  }
}

async function anomaly(redis: RedisLike, type: string, email: string | null, eventId: string | null, details: any) {
  await pushAnomaly(redis as any, {
    type,
    email,
    eventId,
    details
  });
}

export async function handleAttendance(env: Env, redis: RedisLike, ev: TMEvent): Promise<void> {
  const eventId = String(ev?.id ?? "");
  const eventName = String(ev?.event ?? "");

  if (!eventId || !eventName) return;

  // Idempotency (webhooks can repeat)
  const firstTime = await markEventSeen(redis, eventId);
  if (!firstTime) {
    log("info", "attendance.duplicate", { eventId, event: eventName, email: getEmailFromEvent(ev) ?? null });
    return;
  }

  if (eventName !== "attendance.inserted" && !eventName.startsWith("attendance.")) {
    log("info", "attendance.ignored_event", { eventId, event: eventName });
    return;
  }

  const clockingType = String(ev?.data?.clockingType ?? "").toLowerCase(); // "In"/"Out"
  const email = getEmailFromEvent(ev);

  if (!email) {
    log("warn", "attendance.email_missing", { eventId, event: eventName });
    await anomaly(redis, "EMAIL_MISSING", null, eventId, { have: Object.keys(ev?.data ?? {}) });
    return;
  }

  const stampUtc = extractStampUtc(ev);
  const stampBerlinISO = toBerlinISO(stampUtc);

  if (clockingType === "in") {
    await handleIn(env, redis, ev, email, stampUtc, stampBerlinISO);
    return;
  }

  if (clockingType === "out") {
    await handleOut(env, redis, ev, email, stampUtc, stampBerlinISO);
    return;
  }

  log("info", "attendance.ignored_clocking_type", { eventId, email, clockingType });
}

async function handleIn(
  env: Env,
  redis: RedisLike,
  ev: TMEvent,
  email: string,
  inUtc: Date,
  inBerlinISO: string
) {
  const eventId = String(ev.id);
  const open = await loadOpen(redis, email);

  // Resolve Personio personId once per IN (cached inside personio.ts)
  let employeeId: string;
  try {
    employeeId = await getEmployeeIdByEmail(env, redis as any, email);
  } catch (e: any) {
    log("warn", "personio.person_not_found", { email, err: String(e?.message ?? e) });
    await anomaly(redis, "PERSONIO_NOT_FOUND", email, eventId, { err: String(e?.message ?? e) });
    return;
  }

  // DOUBLE-IN: close previous session at (new IN - 1 minute), then open a new one
  if (open) {
    const prevEndUtc = addMs(inUtc, -60_000);
    const prevEndUtcMs = Math.max(open.startUtcMs + 60_000, prevEndUtc.getTime());
    const prevEndBerlin = toBerlinISO(new Date(prevEndUtcMs));

    log("warn", "attendance.double_in", { email, prevStart: open.startBerlinISO, closeAt: prevEndBerlin });

    if (!env.SHADOW_MODE) {
      try {
        await patchAttendanceEnd(env, redis as any, open.personioPeriodId, prevEndBerlin);
      } catch (e: any) {
        log("error", "personio.patch_end_failed", { email, periodId: open.personioPeriodId, err: String(e?.message ?? e) });
        await anomaly(redis, "PERSONIO_PATCH_FAILED", email, eventId, { periodId: open.personioPeriodId, err: String(e?.message ?? e) });
        // We still continue to open new session to keep operational flow
      }
    }

    await saveLast(redis, {
      email,
      employeeId: open.employeeId,
      startUtcMs: open.startUtcMs,
      endUtcMs: prevEndUtcMs,
      startBerlinISO: open.startBerlinISO,
      endBerlinISO: prevEndBerlin,
      personioPeriodId: open.personioPeriodId,
      endReason: "DOUBLE_IN_CLOSE",
      closedEventId: eventId,
      closedAtIso: nowIso()
    });

    await clearOpen(redis, email);
  }

  // Create provisional attendance period on IN:
  // Personio needs start+end. We set end = start + 1 minute and patch later on OUT/autoclose.
  const provisionalEndUtc = addMs(inUtc, 60_000);
  const provisionalEndBerlin = toBerlinISO(provisionalEndUtc);

  let periodId = "shadow-period";
  if (!env.SHADOW_MODE) {
    periodId = await createAttendance(env, redis as any, employeeId, inBerlinISO, provisionalEndBerlin);
  } else {
    log("info", "personio.shadow_skip_create", { email, start: inBerlinISO, end: provisionalEndBerlin });
  }

  const acUtcMs = autoCloseUtcMs(inUtc);
  const acBerlinISO = toBerlinISO(new Date(acUtcMs));

  const sess: OpenSession = {
    email,
    employeeId,
    startUtcMs: inUtc.getTime(),
    startBerlinISO: inBerlinISO,
    autoCloseAtUtcMs: acUtcMs,
    autoCloseAtBerlinISO: acBerlinISO,
    personioPeriodId: periodId,
    openedEventId: eventId,
    openedAtIso: nowIso()
  };

  await saveOpen(redis, sess);

  log("info", "attendance.in.opened", {
    email,
    start: inBerlinISO,
    autoCloseAt: acBerlinISO,
    periodId
  });
}

async function handleOut(
  env: Env,
  redis: RedisLike,
  ev: TMEvent,
  email: string,
  outUtc: Date,
  outBerlinISO: string
) {
  const eventId = String(ev.id);
  const open = await loadOpen(redis, email);

  // OUT without IN -> try late OUT after AUTO_CLOSE
  if (!open) {
    const last = await loadLast(redis, email);

    if (last && last.endReason === "AUTO_CLOSE") {
      // If OUT arrives later but should replace auto-closed end
      const maxEnd = last.startUtcMs + 12 * 60 * 60 * 1000;
      const outMs = outUtc.getTime();

      if (outMs > last.endUtcMs && outMs <= maxEnd) {
        // Patch end to real OUT
        const endBerlin = outBerlinISO;
        log("info", "attendance.out.updating_autoclosed", {
          email,
          periodId: last.personioPeriodId,
          oldEnd: last.endBerlinISO,
          newEnd: endBerlin
        });

        if (!env.SHADOW_MODE) {
          try {
            await patchAttendanceEnd(env, redis as any, last.personioPeriodId, endBerlin);
          } catch (e: any) {
            log("error", "personio.patch_end_failed", {
              email,
              periodId: last.personioPeriodId,
              err: String(e?.message ?? e)
            });
            await anomaly(redis, "PERSONIO_PATCH_FAILED", email, eventId, {
              periodId: last.personioPeriodId,
              err: String(e?.message ?? e)
            });
            return;
          }
        }

        await saveLast(redis, {
          ...last,
          endUtcMs: outMs,
          endBerlinISO: endBerlin,
          endReason: "OUT",
          closedEventId: eventId,
          closedAtIso: nowIso()
        });

        return;
      }
    }

    log("warn", "attendance.out.without_in", { email, out: outBerlinISO });
    await anomaly(redis, "OUT_WITHOUT_IN", email, eventId, { out: outBerlinISO });
    return;
  }

  // Normal OUT closes open session
  const startMs = open.startUtcMs;
  const outMsRaw = outUtc.getTime();

  // If OUT timestamp earlier than IN -> clamp to at least start + 1 min
  const outMs = Math.max(outMsRaw, startMs + 60_000);

  // If it exceeds auto-close limit, clamp to auto-close (safety)
  const clampedMs = clamp(outMs, startMs + 60_000, open.autoCloseAtUtcMs);
  const endBerlin = toBerlinISO(new Date(clampedMs));

  if (!env.SHADOW_MODE) {
    await patchAttendanceEnd(env, redis as any, open.personioPeriodId, endBerlin);
  } else {
    log("info", "personio.shadow_skip_patch_end", { email, periodId: open.personioPeriodId, end: endBerlin });
  }

  await saveLast(redis, {
    email,
    employeeId: open.employeeId,
    startUtcMs: open.startUtcMs,
    endUtcMs: clampedMs,
    startBerlinISO: open.startBerlinISO,
    endBerlinISO: endBerlin,
    personioPeriodId: open.personioPeriodId,
    endReason: "OUT",
    closedEventId: eventId,
    closedAtIso: nowIso()
  });

  await clearOpen(redis, email);

  log("info", "attendance.out.closed", {
    email,
    start: open.startBerlinISO,
    end: endBerlin,
    periodId: open.personioPeriodId
  });
}
