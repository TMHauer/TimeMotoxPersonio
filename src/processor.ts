import type { Env } from "./env";
import type { Redis } from "./redis";
import { log } from "./log";
import { recordAnomaly } from "./anomalies";
import {
  extractEmailFromEvent,
  extractStampUtcMillis,
  toBerlinISO,
  berlinDayEndUtcMillis,
  getClockingType
} from "./timemoto";
import { getOpenSession, setOpenSession, clearOpenSession, pushHistory, type OpenSession } from "./session";
import { getEmployeeIdByEmail, createAttendanceOpenEnded, patchAttendanceEnd } from "./personio";

async function markEventOnce(redis: Redis, eventId: string): Promise<boolean> {
  // true = first time, false = duplicate
  const key = `evt:${eventId}`;
  const res = await redis.set(key, "1", { NX: true, EX: 7 * 24 * 3600 });
  return res === "OK";
}

function clampAutoClose(utcStart: number): number {
  const twelveH = utcStart + 12 * 3600 * 1000;
  const dayEnd = berlinDayEndUtcMillis(utcStart);
  return Math.min(twelveH, dayEnd);
}

export async function handleAttendance(env: Env, redis: Redis, body: any): Promise<void> {
  const eventId = String(body?.id ?? "");
  if (!eventId) {
    await recordAnomaly(redis, { type: "EVENT_ID_MISSING", details: { event: body?.event } });
    return;
  }

  const first = await markEventOnce(redis, eventId);
  if (!first) {
    log("info", "attendance.duplicate", { eventId });
    return;
  }

  const clockingType = getClockingType(body);
  if (!clockingType) {
    await recordAnomaly(redis, { type: "CLOCKING_TYPE_MISSING", eventId, details: { event: body?.event } });
    return;
  }

  const email = extractEmailFromEvent(body);
  if (!email) {
    await recordAnomaly(redis, { type: "EMAIL_MISSING", eventId, details: { userId: body?.data?.userId } });
    return;
  }

  const stampUtc = extractStampUtcMillis(body);
  if (!stampUtc) {
    await recordAnomaly(redis, { type: "STAMP_TIME_MISSING", email, eventId });
    return;
  }

  const stampBerlinISO = toBerlinISO(stampUtc);

  if (clockingType === "In") {
    const existing = await getOpenSession(redis, email);

    if (existing) {
      // Double-IN: close previous at min(prevStart+1h, now) to avoid overlaps
      const closeUtc = Math.min(existing.startUtcMs + 60 * 60 * 1000, stampUtc);
      const closeBerlin = toBerlinISO(closeUtc);

      await recordAnomaly(redis, {
        type: "DOUBLE_IN",
        email,
        eventId,
        details: { prevStart: existing.startBerlinISO, closeAt: closeBerlin }
      });

      if (!env.SHADOW_MODE) {
        await patchAttendanceEnd(env, redis, existing.personioPeriodId, closeBerlin);
      } else {
        log("info", "personio.shadow_skip_patch_end", { email, periodId: existing.personioPeriodId, end: closeBerlin });
      }

      await pushHistory(redis, {
        email,
        start: existing.startBerlinISO,
        end: closeBerlin,
        reason: "DOUBLE_IN_CLOSE",
        periodId: existing.personioPeriodId
      });

      await clearOpenSession(redis, email);
    }

    // Create open-ended attendance immediately (real-time)
    const employeeId = await getEmployeeIdByEmail(env, redis, email);
    if (!employeeId) {
      await recordAnomaly(redis, { type: "PERSONIO_EMPLOYEE_NOT_FOUND", email, eventId });
      return;
    }

    let periodId = "shadow-period";
    if (!env.SHADOW_MODE) {
      periodId = await createAttendanceOpenEnded(env, redis, employeeId, stampBerlinISO);
    } else {
      log("info", "personio.shadow_skip_create", { email, start: stampBerlinISO });
    }

    const autoCloseAtUtcMs = clampAutoClose(stampUtc);

    const sess: OpenSession = {
      email,
      startUtcMs: stampUtc,
      startBerlinISO: stampBerlinISO,
      autoCloseAtUtcMs,
      personioPeriodId: periodId,
      openedEventId: eventId,
      updatedAt: new Date().toISOString()
    };

    await setOpenSession(redis, sess);

    log("info", "attendance.in.opened", {
      email,
      start: stampBerlinISO,
      autoCloseAt: toBerlinISO(autoCloseAtUtcMs),
      periodId
    });

    return;
  }

  // Out
  const open = await getOpenSession(redis, email);
  if (!open) {
    await recordAnomaly(redis, { type: "OUT_WITHOUT_IN", email, eventId, details: { out: stampBerlinISO } });
    log("warn", "attendance.out.without_in", { email, out: stampBerlinISO });
    return;
  }

  // Enforce Personio constraint: attendance cannot span two days → if OUT next day, split
  const startDay = open.startBerlinISO.slice(0, 10);
  const outDay = stampBerlinISO.slice(0, 10);

  if (outDay !== startDay) {
    // Close first day at min(autoClose, dayEnd)
    const firstEndUtc = Math.min(open.autoCloseAtUtcMs, berlinDayEndUtcMillis(open.startUtcMs));
    const firstEndBerlin = toBerlinISO(firstEndUtc);

    if (!env.SHADOW_MODE) {
      await patchAttendanceEnd(env, redis, open.personioPeriodId, firstEndBerlin);
    } else {
      log("info", "personio.shadow_skip_patch_end", { email, periodId: open.personioPeriodId, end: firstEndBerlin });
    }

    await pushHistory(redis, {
      email,
      start: open.startBerlinISO,
      end: firstEndBerlin,
      reason: "OUT_NEXT_DAY_SPLIT_DAY1",
      periodId: open.personioPeriodId
    });

    await clearOpenSession(redis, email);

    await recordAnomaly(redis, {
      type: "OUT_NEXT_DAY_SPLIT",
      email,
      eventId,
      details: { start: open.startBerlinISO, out: stampBerlinISO }
    });

    log("warn", "attendance.out.next_day_split", { email, start: open.startBerlinISO, out: stampBerlinISO });

    // Optional: create day2 attendance from 00:00 to out (best-effort)
    // If you *never* want this, delete the block below.
    const employeeId = await getEmployeeIdByEmail(env, redis, email);
    if (!employeeId) return;

    const midnightBerlin = `${outDay}T00:00:00+01:00`; // ok for Berlin in winter; Luxon not used here by design
    if (!env.SHADOW_MODE) {
      const newId = await createAttendanceOpenEnded(env, redis, employeeId, midnightBerlin);
      await patchAttendanceEnd(env, redis, newId, stampBerlinISO);
      await pushHistory(redis, { email, start: midnightBerlin, end: stampBerlinISO, reason: "OUT_NEXT_DAY_SPLIT_DAY2", periodId: newId });
    } else {
      log("info", "personio.shadow_skip_create", { email, start: midnightBerlin, end: stampBerlinISO });
    }

    return;
  }

  // Normal same-day OUT: patch end (even if already auto-closed earlier, overwrite is ok)
  const endBerlin = stampBerlinISO;

  if (!env.SHADOW_MODE) {
    await patchAttendanceEnd(env, redis, open.personioPeriodId, endBerlin);
  } else {
    log("info", "personio.shadow_skip_patch_end", { email, periodId: open.personioPeriodId, end: endBerlin });
  }

  await pushHistory(redis, { email, start: open.startBerlinISO, end: endBerlin, reason: "OUT", periodId: open.personioPeriodId });
  await clearOpenSession(redis, email);

  log("info", "attendance.out.closed", { email, start: open.startBerlinISO, end: endBerlin, periodId: open.personioPeriodId });
}
