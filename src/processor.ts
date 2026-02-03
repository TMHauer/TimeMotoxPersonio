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
  const key = `evt:${eventId}`;
  const res = await redis.set(key, "1", { NX: true, EX: 7 * 24 * 3600 });
  return res === "OK";
}

async function markPunchOnce(redis: Redis, email: string, clockingType: "In" | "Out", stampUtc: number): Promise<boolean> {
  const key = `punch:${email}:${clockingType}:${stampUtc}`;
  const res = await redis.set(key, "1", { NX: true, EX: 7 * 24 * 3600 });
  return res === "OK";
}

function clampAutoClose(utcStart: number): number {
  const twelveH = utcStart + 12 * 3600 * 1000;
  const dayEnd = berlinDayEndUtcMillis(utcStart);
  return Math.min(twelveH, dayEnd);
}

function isShadowPeriodId(id: string): boolean {
  return !id || id === "shadow-period" || id.startsWith("shadow");
}

export async function handleAttendance(env: Env, redis: Redis, body: any): Promise<void> {
  const eventId = String(body?.id ?? "");
  if (!eventId) {
    await recordAnomaly(redis, { type: "EVENT_ID_MISSING", details: { event: body?.event } });
    return;
  }

  const firstById = await markEventOnce(redis, eventId);
  if (!firstById) {
    log("info", "attendance.duplicate_event_id", { eventId });
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

  const firstPunch = await markPunchOnce(redis, email, clockingType, stampUtc);
  if (!firstPunch) {
    log("info", "attendance.duplicate_punch", { email, clockingType, stampUtc, eventId });
    return;
  }

  const stampBerlinISO = toBerlinISO(stampUtc);

  // =========================
  // IN
  // =========================
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
        // If existing was shadow, we cannot patch it — just clear it.
        if (!isShadowPeriodId(existing.personioPeriodId)) {
          await patchAttendanceEnd(env, redis, existing.personioPeriodId, closeBerlin);
        } else {
          await recordAnomaly(redis, {
            type: "SHADOW_SESSION_DROPPED_ON_DOUBLE_IN",
            email,
            eventId,
            details: { prevStart: existing.startBerlinISO }
          });
        }
      } else {
        log("info", "personio.shadow_skip_patch_end", {
          email,
          periodId: existing.personioPeriodId,
          end: closeBerlin
        });
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

  // =========================
  // OUT
  // =========================
  const open = await getOpenSession(redis, email);
  if (!open) {
    await recordAnomaly(redis, { type: "OUT_WITHOUT_IN", email, eventId, details: { out: stampBerlinISO } });
    log("warn", "attendance.out.without_in", { email, out: stampBerlinISO });
    return;
  }

  // If the open session was created while SHADOW_MODE=true earlier, it has "shadow-period".
  // Recover by creating a new attendance in Personio and closing it immediately.
  if (!env.SHADOW_MODE && isShadowPeriodId(open.personioPeriodId)) {
    await recordAnomaly(redis, {
      type: "SHADOW_PERIOD_RECOVER",
      email,
      eventId,
      details: { start: open.startBerlinISO, out: stampBerlinISO }
    });

    const employeeId = await getEmployeeIdByEmail(env, redis, email);
    if (!employeeId) {
      await recordAnomaly(redis, { type: "PERSONIO_EMPLOYEE_NOT_FOUND", email, eventId });
      await clearOpenSession(redis, email);
      return;
    }

    const newId = await createAttendanceOpenEnded(env, redis, employeeId, open.startBerlinISO);
    await patchAttendanceEnd(env, redis, newId, stampBerlinISO);

    await pushHistory(redis, {
      email,
      start: open.startBerlinISO,
      end: stampBerlinISO,
      reason: "RECOVER_FROM_SHADOW",
      periodId: newId
    });

    await clearOpenSession(redis, email);

    log("info", "attendance.out.closed_recovered", {
      email,
      start: open.startBerlinISO,
      end: stampBerlinISO,
      periodId: newId
    });

    return;
  }

  // Enforce: if OUT next day, split
  const startDay = open.startBerlinISO.slice(0, 10);
  const outDay = stampBerlinISO.slice(0, 10);

  if (outDay !== startDay) {
    const firstEndUtc = Math.min(open.autoCloseAtUtcMs, berlinDayEndUtcMillis(open.startUtcMs));
    const firstEndBerlin = toBerlinISO(firstEndUtc);

    if (!env.SHADOW_MODE) {
      if (!isShadowPeriodId(open.personioPeriodId)) {
        await patchAttendanceEnd(env, redis, open.personioPeriodId, firstEndBerlin);
      }
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

    // Optional: create day2 attendance from 00:00 to out
    const employeeId = await getEmployeeIdByEmail(env, redis, email);
    if (!employeeId) return;

    const midnightBerlin = `${outDay}T00:00:00+01:00`;
    if (!env.SHADOW_MODE) {
      const newId = await createAttendanceOpenEnded(env, redis, employeeId, midnightBerlin);
      await patchAttendanceEnd(env, redis, newId, stampBerlinISO);
      await pushHistory(redis, { email, start: midnightBerlin, end: stampBerlinISO, reason: "OUT_NEXT_DAY_SPLIT_DAY2", periodId: newId });
    } else {
      log("info", "personio.shadow_skip_create", { email, start: midnightBerlin, end: stampBerlinISO });
    }

    return;
  }

  // Normal same-day OUT
  const endBerlin = stampBerlinISO;

  if (!env.SHADOW_MODE) {
    if (isShadowPeriodId(open.personioPeriodId)) {
      // If we somehow got here with shadow id, just drop to avoid 400s
      await recordAnomaly(redis, {
        type: "SHADOW_PERIOD_CANNOT_PATCH",
        email,
        eventId,
        details: { periodId: open.personioPeriodId, end: endBerlin }
      });
    } else {
      await patchAttendanceEnd(env, redis, open.personioPeriodId, endBerlin);
    }
  } else {
    log("info", "personio.shadow_skip_patch_end", { email, periodId: open.personioPeriodId, end: endBerlin });
  }

  await pushHistory(redis, { email, start: open.startBerlinISO, end: endBerlin, reason: "OUT", periodId: open.personioPeriodId });
  await clearOpenSession(redis, email);

  log("info", "attendance.out.closed", { email, start: open.startBerlinISO, end: endBerlin, periodId: open.personioPeriodId });
}
