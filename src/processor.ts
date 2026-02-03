import type { Env } from "./env.js";
import type { Redis } from "@upstash/redis";
import { log } from "./log.js";
import { pushAnomaly } from "./anomalies.js";
import { normalizeEmail, extractStampUtc, toBerlinISO, berlinDayEndUtcMillis } from "./timemoto.js";
import { getEmployeeIdByEmail, createAttendance, patchAttendanceEnd } from "./personio.js";
import { getOpenSession, setOpenSession, clearOpenSession, computeAutoCloseUtcMillis, upsertAutoCloseIndex } from "./session.js";

const IDEMP_PREFIX = "idemp:event:";
const IDEMP_TTL_SECONDS = 60 * 60 * 24 * 14;

async function acquireIdempotency(redis: Redis, eventId: string): Promise<boolean> {
  const key = `${IDEMP_PREFIX}${eventId}`;
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
    await pushAnomaly(redis, {
      ts: new Date().toISOString(),
      type: "EMAIL_MISSING",
      eventId: ev.id,
      details: { event: ev.event }
    });
    log("warn", "attendance.ignored.email_missing", { eventId: ev.id });
    return;
  }

  const first = await acquireIdempotency(redis, ev.id);
  if (!first) {
    log("info", "attendance.duplicate", { eventId: ev.id, email });
    return;
  }

  const stampUtc = extractStampUtc(ev as any);
  const stampBerlin = toBerlinISO(stampUtc);

  const open = await getOpenSession(redis, email);

  if (ev.data.clockingType === "In") {
    if (open) {
      // DOUBLE-IN: close previous session at min(newIn, autoClose)
      const endUtcMillis = Math.min(stampUtc.getTime(), open.autoCloseUtcMillis);
      const endBerlin = toBerlinISO(new Date(endUtcMillis));

      await pushAnomaly(redis, {
        ts: new Date().toISOString(),
        type: "DOUBLE_IN",
        email,
        eventId: ev.id,
        details: { prevStart: open.startBerlin, newIn: stampBerlin, closedAt: endBerlin }
      });

      if (!env.SHADOW_MODE) await patchAttendanceEnd(env, redis, open.personioPeriodId, endBerlin);
      await clearOpenSession(redis, email);
    }

    const employeeId = await getEmployeeIdByEmail(env, redis, email);
    const periodId = env.SHADOW_MODE ? `shadow_${Date.now()}` : await createAttendance(env, redis, employeeId, stampBerlin);

    const autoCloseUtcMillis = computeAutoCloseUtcMillis(stampUtc);
    const autoCloseBerlin = toBerlinISO(new Date(autoCloseUtcMillis));

    await setOpenSession(redis, {
      email,
      startUtcMillis: stampUtc.getTime(),
      autoCloseUtcMillis,
      startBerlin: stampBerlin,
      autoCloseBerlin,
      personioPeriodId: periodId,
      openedEventId: ev.id,
      updatedAt: new Date().toISOString()
    });

    await upsertAutoCloseIndex(redis, email, Math.floor(autoCloseUtcMillis / 1000));

    log("info", "attendance.in.processed", {
      email,
      startBerlin: stampBerlin,
      autoCloseBerlin,
      shadow: env.SHADOW_MODE
    });
    return;
  }

  // OUT
  if (!open) {
    await pushAnomaly(redis, {
      ts: new Date().toISOString(),
      type: "OUT_WITHOUT_IN",
      email,
      eventId: ev.id,
      details: { out: stampBerlin }
    });
    log("warn", "attendance.ou
