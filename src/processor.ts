import type { Env } from "./env.js";
import { log } from "./log.js";
import { normalizeEmail, extractStampUtc, toBerlinISO, berlinDayEndUtcMillis } from "./timemoto.js";
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

function addMinutesIso(iso: string, minutes: number): string {
  const d = new Date(iso);
  const ms = d.getTime();
  return new Date(ms + minutes * 60_000).toISOString();
}

function minIso(a: string, b: string): string {
  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

/**
 * Idempotency claim using Redis SET NX PX
 * Fixes TS overload issue by using positional args order supported by ioredis:
 * redis.set(key, value, "PX", ttlMs, "NX")
 */
async function claimEvent(redis: RedisLike, eventId: string): Promise<boolean> {
  const ttlMs = 14 * 24 * 3600_000; // 14 days
  const res = await redis.set(IDEMP_KEY(eventId), "1", "PX", ttlMs, "NX");
  return res === "OK";
}

function computeAutoClose(stampUtc: Date): { autoCloseAtUtcMs: number; autoCloseAtBerlinISO: string } {
  const startMs = stampUtc.getTime();
  const max12h = startMs + 12 * 3600_000;
  const dayEnd = berlinDayEndUtcMillis(stampUtc); // returns UTC millis for 23:59 Berlin
  const autoCloseAtUtcMs = Math.min(max12h, dayEnd);
  const autoCloseAtBerlinISO = toBerlinISO(new Date(autoCloseAtUtcMs));
  return { autoCloseAtUtcMs, autoCloseAtBerlinISO };
}

export async function handleAttendance(env: Env, redis: RedisLike, body: TimeMotoEvent) {
  const eventId = String(body?.id ?? "");
  if (!eventId) {
    log("warn", "attendance.missing_event_id");
    await recordAnomaly(redis as any, {
      type: "EVENT_ID_MISSING",
      email: null,
      event_id: null,
      details: JSON.stringify({ event: body?.event ?? null })
    });
    return;
  }

  // 1) Idempotency FIRST → prevents the duplicate processing you saw
  const first = await claimEvent(redis, eventId);
  if (!first) {
    log("info", "attendance.duplicate", { eventId });
    return;
  }

  // 2) Only process attendance.inserted (IN/OUT)
  if (String(body?.event ?? "") !== "attendance.inserted") {
    log("info", "attendance.ignored", { eventId, event: body?.event });
    return;
  }

  const clockingType = String(body?.data?.clockingType ?? "").toLowerCase();

  // Mapping: we use userEmployeeNumber (you filled it with email)
  const email =
    normalizeEmail(String(body?.data?.userEmployeeNumber ?? "")) ??
    normalizeEmail(String(body?.data?.emailAddress ?? "")) ??
    null;

  if (!email) {
    log("warn", "attendance.email_missing", { eventId });
    await recordAnomaly(redis as any, {
      type: "EMAIL_MISSING",
      email: null,
      event_id: eventId,
      details: JSON.stringify({ userId: body?.data?.userId ?? null })
    });
    return;
  }

  const stampUtc: Date = extractStampUtc(body);
  const stampBerlinISO = toBerlinISO(stampUtc);

  // -----------------------
  // IN
  // -----------------------
  if (clockingType === "in") {
    const existing: OpenSession | null = await getOpenSession(redis as any, email);

    // DOUBLE-IN: close previous session at prevStart+60min (or earlier if needed)
    if (existing) {
      const closeAt = addMinutesIso(existing.startBerlinISO, 60);
      log("warn", "attendance.double_in", { email, prevStart: existing.startBerlinISO, closeAt });

      // ensure Personio period exists for previous session:
      // We patch the existing period end (preferred) to avoid duplicates.
      try {
        await patchAttendanceEnd(env, redis as any, existing.personioPeriodId, closeAt);
      } catch (e: any) {
        log("error", "attendance.double_in.patch_failed", { email, err: String(e?.message ?? e) });
      }

      await clearOpenSession(redis as any, email);
    }

    // Resolve employeeId by email (cached)
    const employeeId = await getEmployeeIdByEmail(env, redis as any, email);
    if (!employeeId) {
      log("warn", "personio.employee_not_found", { email });
      await recordAnomaly(redis as any, {
        type: "PERSONIO_NOT_FOUND",
        email,
        event_id: eventId,
        details: JSON.stringify({})
      });
      return;
    }

    // Create period with a placeholder end (+1 min), then we patch on OUT/autoclose.
    const placeholderEnd = addMinutesIso(stampBerlinISO, 1);
    const personioPeriodId = await createAttendance(env, redis as any, employeeId, stampBerlinISO, placeholderEnd);

    const { autoCloseAtUtcMs, autoCloseAtBerlinISO } = computeAutoClose(stampUtc);

    const open: OpenSession = {
      email,
      startAtUtcMs: stampUtc.getTime(),
      startBerlinISO: stampBerlinISO,
      autoCloseAtUtcMs,
      autoCloseAtBerlinISO,
      personioPeriodId,
      openedEventId: eventId
    };

    await setOpenSession(redis as any, open);

    log("info", "attendance.in.opened", {
      email,
      start: stampBerlinISO,
      autoCloseAt: autoCloseAtBerlinISO,
      periodId: personioPeriodId
    });

    return;
  }

  // -----------------------
  // OUT
  // -----------------------
  if (clockingType === "out") {
    const open: OpenSession | null = await getOpenSession(redis as any, email);
    if (!open) {
      log("warn", "attendance.out.without_in", { email, out: stampBerlinISO });
      await recordAnomaly(redis as any, {
        type: "OUT_WITHOUT_IN",
        email,
        event_id: eventId,
        details: JSON.stringify({ out: stampBerlinISO })
      });
      return;
    }

    // Prevent end < start (device time issues)
    const safeEnd = minIso(stampBerlinISO, addMinutesIso(open.startBerlinISO, 12 * 60));
    const endFinal = new Date(safeEnd).getTime() < new Date(open.startBerlinISO).getTime()
      ? addMinutesIso(open.startBerlinISO, 1)
      : safeEnd;

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

  // Unknown clocking type
  log("info", "attendance.ignored_clockingType", { email, eventId, clockingType });
}
