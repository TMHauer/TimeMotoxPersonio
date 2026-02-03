import type { Env } from "./env.js";
import type { Redis } from "@upstash/redis";
import { log } from "./log.js";
import { pushAnomaly } from "./anomalies.js";
import { normalizeEmail, extractStampUtc, utcToBerlinLocalIso, berlinDayEnd } from "./timemoto.js";
import { getEmployeeIdByEmail, createAttendance, patchAttendanceEnd } from "./personio.js";
import { getOpenSession, setOpenSession, clearOpenSession, computeAutoClose } from "./session.js";

const IDEMP_PREFIX = "idemp:event:"; // idemp:event:<eventId> = 1 (ttl)
const IDEMP_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days

export async function acquireIdempotency(redis: Redis, eventId: string): Promise<boolean> {
  const key = `${IDEMP_PREFIX}${eventId}`;
  // NX set
  const ok = await redis.set(key, "1", { nx: true, ex: IDEMP_TTL_SECONDS });
  return ok === "OK";
}

type TimemotoAttendance = {
  id: string;
  event: string;
  data: {
    clockingType: "In" | "Out";
    userEmployeeNumber?: string;
    timeZone?: string;
    timeLogged?: string;
    timeInserted?: string;
    userFirstName?: string;
    userLastName?: string;
  };
};

export async function handleAttendance(env: Env, redis: Redis, ev: TimemotoAttendance): Promise<void> {
  const email = normalizeEmail(ev?.data?.userEmployeeNumber);
  if (!email) {
    await pushAnomaly(redis, { ts: new Date().toISOString(), type: "EMAIL_MISSING", eventId: ev.id, details: { event: ev.event } });
    log("warn", "attendance.ignored.email_missing", { eventId: ev.id });
    return;
  }

  const stampUtc = extractStampUtc(ev as any);
  const stampBerlin = utcToBerlinLocalIso(stampUtc);

  // idempotency
  const first = await acquireIdempotency(redis, ev.id);
  if (!first) {
    log("info", "attendance.duplicate", { eventId: ev.id, email });
    return;
  }

  const open = await getOpenSession(redis, email);

  if (ev.data.clockingType === "In") {
    if (open) {
      // DOUBLE-IN => auto-close previous at min(newIn, autoClose)
      const endBerlin = open.autoCloseBerlin < stampBerlin ? open.autoCloseBerlin : stampBerlin;
      await pushAnomaly(redis, { ts: new Date().toISOString(), type: "DOUBLE_IN", email, eventId: ev.id, details: { prevStart: open.startBerlin, newIn: stampBerlin, closedAt: endBerlin } });

      if (!env.SHADOW_MODE) await patchAttendanceEnd(env, redis, open.personioPeriodId, endBerlin);
      await clearOpenSession(redis, email);
    }

    const employeeId = await getEmployeeIdByEmail(env, redis, email);
    const periodId = env.SHADOW_MODE ? `shadow_${Date.now()}` : await createAttendance(env, redis, employeeId, stampBerlin);
    const autoCloseBerlin = computeAutoClose(stampBerlin);

    await setOpenSession(redis, {
      email,
      startBerlin: stampBerlin,
      autoCloseBerlin,
      personioPeriodId: periodId,
      openedEventId: ev.id,
      updatedAt: new Date().toISOString()
    });

    log("info", "attendance.in.processed", { email, startBerlin: stampBerlin, autoCloseBerlin, shadow: env.SHADOW_MODE });
    return;
  }

  // OUT
  if (!open) {
    await pushAnomaly(redis, { ts: new Date().toISOString(), type: "OUT_WITHOUT_IN", email, eventId: ev.id, details: { out: stampBerlin } });
    log("warn", "attendance.out.without_in", { email, out: stampBerlin });
    return;
  }

  // guard
  if (stampBerlin < open.startBerlin) {
    await pushAnomaly(redis, { ts: new Date().toISOString(), type: "OUT_BEFORE_IN", email, eventId: ev.id, details: { start: open.startBerlin, out: stampBerlin } });
    log("warn", "attendance.out.before_in", { email });
    return;
  }

  // clamp to 23:59 of start day (nachtschicht kommt bei euch nicht vor; wir halten es safe)
  const dayEnd = berlinDayEnd(open.startBerlin);
  const endBerlin = stampBerlin > dayEnd ? dayEnd : stampBerlin;

  if (!env.SHADOW_MODE) await patchAttendanceEnd(env, redis, open.personioPeriodId, endBerlin);
  await clearOpenSession(redis, email);

  log("info", "attendance.out.processed", { email, endBerlin, shadow: env.SHADOW_MODE });
}
