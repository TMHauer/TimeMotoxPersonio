import type { Env } from "./env";
import type { RedisClient } from "./redis";
import { log } from "./log";
import type { TimeMotoWebhook } from "./timemoto";
import { extractEmail, extractStampUtcMillis, isIn, isOut, toBerlinLocalNoOffset } from "./timemoto";
import { recordAnomaly } from "./anomalies";
import { createAttendance, getEmployeeIdByEmail, patchAttendanceEnd } from "./personio";
import { clearOpen, computeAutoClose, getOpen, getRecentHistory, pushHistory, setOpen } from "./session";

const IDEMP_PREFIX = "idemp:";

async function markIdempotent(redis: RedisClient, eventId: string): Promise<boolean> {
  const key = IDEMP_PREFIX + eventId;
  // set if not exists, ttl 14d
  const ok = await redis.set(key, "1", "NX", "PX", 14 * 24 * 3600_000);
  return ok === "OK";
}

export async function handleAttendance(env: Env, redis: RedisClient, body: TimeMotoWebhook) {
  const eventId = String(body?.id ?? "");
  if (!eventId) {
    await recordAnomaly(redis, { ts: new Date().toISOString(), type: "EVENT_ID_MISSING", details: { event: body?.event } });
    return;
  }

  const first = await markIdempotent(redis, eventId);
  if (!first) {
    log("info", "attendance.duplicate", { eventId });
    return;
  }

  const email = extractEmail(body);
  if (!email) {
    await recordAnomaly(redis, { ts: new Date().toISOString(), type: "EMAIL_MISSING", eventId, details: { userEmployeeNumber: body?.data?.userEmployeeNumber } });
    return;
  }

  const stampUtc = extractStampUtcMillis(body);
  if (!stampUtc) {
    await recordAnomaly(redis, { ts: new Date().toISOString(), type: "STAMP_MISSING", email, eventId });
    return;
  }

  const stampBerlin = toBerlinLocalNoOffset(stampUtc);

  if (isIn(body)) {
    const prev = await getOpen(redis, email);
    if (prev) {
      // DOUBLE-IN: close previous at min(prevStart+60min? no, close at newIn if possible but >= prevStart+60s)
      const minEndUtc = prev.startUtc + 60_000;
      const closeUtc = Math.max(minEndUtc, stampUtc);
      const closeBerlin = toBerlinLocalNoOffset(closeUtc);

      await recordAnomaly(redis, {
        ts: new Date().toISOString(),
        type: "DOUBLE_IN",
        email,
        eventId,
        details: { prevStart: prev.startBerlin, closeAt: closeBerlin }
      });

      // patch previous
      await patchAttendanceEnd(env, redis, prev.periodId, closeBerlin);
      await pushHistory(redis, email, {
        start: prev.startBerlin,
        end: closeBerlin,
        end_reason: "DOUBLE_IN_CLOSE",
        periodId: prev.periodId,
        openedEventId: prev.openedEventId,
        closedEventId: eventId,
        ts: new Date().toISOString()
      });
      await clearOpen(redis, email);
    }

    const employeeId = await getEmployeeIdByEmail(env, redis, email);
    if (!employeeId) {
      await recordAnomaly(redis, { ts: new Date().toISOString(), type: "PERSONIO_NOT_FOUND", email, eventId });
      return;
    }

    // Create attendance immediately with placeholder end (+60s) then patch end later on OUT/autoclose.
    const placeholderEndBerlin = toBerlinLocalNoOffset(stampUtc + 60_000);
    const periodId = await createAttendance(env, redis, employeeId, stampBerlin, placeholderEndBerlin);

    const { autoCloseAtUtc, autoCloseAtBerlin } = computeAutoClose(stampUtc);
    await setOpen(redis, {
      email,
      startUtc: stampUtc,
      startBerlin,
      autoCloseAtUtc,
      autoCloseAtBerlin,
      periodId,
      openedEventId: eventId
    });

    log("info", "attendance.in.opened", { email, start: stampBerlin, autoCloseAt: autoCloseAtBerlin, periodId });
    return;
  }

  if (isOut(body)) {
    const open = await getOpen(redis, email);
    if (!open) {
      // late OUT after autoclose? try fix last history if it was AUTO_CLOSE today
      const recent = await getRecentHistory(redis, email, 10);
      const candidate = recent.find((h: any) => h?.end_reason === "AUTO_CLOSE");
      if (candidate && candidate?.periodId && typeof candidate?.start === "string" && typeof candidate?.end === "string") {
        // if OUT within 12h window and after end -> patch
        await patchAttendanceEnd(env, redis, String(candidate.periodId), stampBerlin);
        await pushHistory(redis, email, {
          start: candidate.start,
          end: stampBerlin,
          end_reason: "OUT_LATE_AFTER_AUTOCLOSE",
          periodId: candidate.periodId,
          closedEventId: eventId,
          ts: new Date().toISOString()
        });
        log("info", "attendance.out.late_patched", { email, periodId: candidate.periodId, end: stampBerlin });
        return;
      }

      await recordAnomaly(redis, { ts: new Date().toISOString(), type: "OUT_WITHOUT_IN", email, eventId, details: { out: stampBerlin } });
      log("warn", "attendance.out.without_in", { email, out: stampBerlin });
      return;
    }

    // normal close
    await patchAttendanceEnd(env, redis, open.periodId, stampBerlin);
    await pushHistory(redis, email, {
      start: open.startBerlin,
      end: stampBerlin,
      end_reason: "OUT",
      periodId: open.periodId,
      openedEventId: open.openedEventId,
      closedEventId: eventId,
      ts: new Date().toISOString()
    });
    await clearOpen(redis, email);

    log("info", "attendance.out.closed", { email, start: open.startBerlin, end: stampBerlin, periodId: open.periodId });
    return;
  }

  // ignore other attendance.* types safely
  log("info", "attendance.ignored", { eventId, email, event: body?.event });
}
