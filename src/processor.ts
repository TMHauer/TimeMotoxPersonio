import type { Env } from "./env.js";
import { log } from "./log.js";
import {
  normalizeEmail,
  extractStampUtc,
  toBerlinISO,
  berlinDayEndUtcMillis
} from "./timemoto.js";
import { getEmployeeIdByEmail, createAttendance, patchAttendanceEnd } from "./personio.js";
import { recordAnomaly } from "./anomalies.js";
import { getOpenSession, setOpenSession, clearOpenSession } from "./session.js";

type RedisLike = {
  get(key: string): Promise<any>;
  set(key: string, value: any, ...args: any[]): Promise<any>;
  del(key: string): Promise<any>;
};

type TimeMotoEvent = {
  id: string;
  event: string;
  data: any;
};

type OpenSession = {
  email: string;
  startAtUtcMs: number;
  startBerlinISO: string;
  autoCloseAtUtcMs: number;
  autoCloseAtBerlinISO: string;
  personioPeriodId: string;
  openedEventId: string;
};

const IDEMP_KEY = (eventId: string) => `idemp:${eventId}`;

function addMinutesISO(iso: string, minutes: number): string {
  const d = new Date(iso);
  return new Date(d.getTime() + minutes * 60_000).toISOString();
}

function minIso(a: string, b: string): string {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

async function claimEvent(redis: RedisLike, eventId: string): Promise<boolean> {
  // Use "any" to be compatible with Upstash or ioredis typings
  const r: any = redis as any;
  const ttlSeconds = 14 * 24 * 3600;

  // Try Upstash style: set(key, val, { nx:true, ex: ttl })
  try {
    const res = await r.set(IDEMP_KEY(eventId), "1", { nx: true, ex: ttlSeconds });
    return res === "OK" || res === true;
  } catch {
    // Fallback ioredis style: set(key, val, "EX", ttl, "NX")
    const res = await r.set(IDEMP_KEY(eventId), "1", "EX", ttlSeconds, "NX");
    return res === "OK";
  }
}

function computeAutoClose(stampUtc: Date): { autoCloseAtUtcMs: number; autoCloseAtBerlinISO: string } {
  const startMs = stampUtc.getTime();
  const max12h = startMs + 12 * 3600_000;
  const dayEndMs = berlinDayEndUtcMillis(stampUtc); // accepts Date|number now
  const autoCloseAtUtcMs = Math.min(max12h, dayEndMs);
  return { autoCloseAtUtcMs, autoCloseAtBerlinISO: toBerlinISO(new Date(autoCloseAtUtcMs)) };
}

export async function handleAttendance(env: Env, redis: RedisLike, body: TimeMotoEvent) {
  const eventId = String(body?.id ?? "");
  if (!eventId) {
    log("warn", "attendance.missing_event_id");
    await recordAnomaly(redis as any, {
      type: "EVENT_ID_MISSING",
      email: undefined,
      eventId: undefined,
      details: { event: body?.event ?? null }
    });
    return;
  }

  // 1) Idempotency FIRST
  const first = await claimEvent(redis, eventId);
  if (!first) {
    log("info", "attendance.duplicate", { eventId });
    return;
  }

  // 2) Only attendance.inserted
  if (String(body?.event ?? "") !== "attendance.inserted") {
    log("info", "attendance.ignored", { eventId, event: body?.event });
    return;
  }

  const clockingType = String(body?.data?.clockingType ?? "").toLowerCase();

  const email =
    normalizeEmail(String(body?.data?.userEmployeeNumber ?? "")) ??
    normalizeEmail(String(body?.data?.emailAddress ?? "")) ??
    null;

  if (!email) {
    log("warn", "attendance.email_missing", { eventId });
    await recordAnomaly(redis as any, {
      type: "EMAIL_MISSING",
      email: undefined,
      eventId,
      details: { userId: body?.data?.userId ?? null }
    });
    return;
  }

  const stampUtc = extractStampUtc(body);
  const stampBerlinISO = toBerlinISO(stampUtc);

  // IN
  if (clockingType === "in") {
    const existing: OpenSession | null = await getOpenSession(redis as any, email);

    if (existing) {
      const closeAt = addMinutesISO(existing.startBerlinISO, 60);
      log("warn", "attendance.double_in", { email, prevStart: existing.startBerlinISO, closeAt });

      try {
        await patchAttendanceEnd(env, redis as any, existing.personioPeriodId, closeAt);
      } catch (e: any) {
        log("error", "attendance.double_in.patch_failed", { email, err: String(e?.message ?? e) });
      }

      await clearOpenSession(redis as any, email);
    }

    const employeeId = await getEmployeeIdByEmail(env, redis as any, email);
    if (!employeeId) {
      log("warn", "personio.employee_not_found", { email });
      await recordAnomaly(redis as any, {
        type: "PERSONIO_NOT_FOUND",
        email,
        eventId,
        details: {}
      });
      return;
    }

    const placeholderEnd = addMinutesISO(stampBerlinISO, 1);
    const periodId = await createAttendance(env, redis as any, employeeId, stampBerlinISO, placeholderEnd);

    const { autoCloseAtUtcMs, autoCloseAtBerlinISO } = computeAutoClose(stampUtc);

    const open: OpenSession = {
      email,
      startAtUtcMs: stampUtc.getTime(),
      startBerlinISO: stampBerlinISO,
      autoCloseAtUtcMs,
      autoCloseAtBerlinISO,
      personioPeriodId: periodId,
      openedEventId: eventId
    };

    await setOpenSession(redis as any, open);

    log("info", "attendance.in.opened", {
      email,
      start: stampBerlinISO,
      autoCloseAt: autoCloseAtBerlinISO,
      periodId
    });
    return;
  }

  // OUT
  if (clockingType === "out") {
    const open: OpenSession | null = await getOpenSession(redis as any, email);
    if (!open) {
      log("warn", "attendance.out.without_in", { email, out: stampBerlinISO });
      await recordAnomaly(redis as any, {
        type: "OUT_WITHOUT_IN",
        email,
        eventId,
        details: { out: stampBerlinISO }
      });
      return;
    }

    // Safety: end should never be before start; also never exceed start+12h in this guard
    const cappedEnd = minIso(stampBerlinISO, addMinutesISO(open.startBerlinISO, 12 * 60));
    const endFinal =
      new Date(cappedEnd).getTime() < new Date(open.startBerlinISO).getTime()
        ? addMinutesISO(open.startBerlinISO, 1)
        : cappedEnd;

    await patchAttendanceEnd(env, redis as any, open.personioPeriodId, endFinal);
    await clearOpenSession(redis as any, email);

    log("info", "attendance.out.closed", {
      email,
      start: open.startBerlinISO,
      end: endFinal,
      periodId: open.personioPeriodId
    });
    return;
  }

  log("info", "attendance.ignored_clockingType", { email, eventId, clockingType });
}
