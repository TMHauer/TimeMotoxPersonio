import { loadEnv } from "./env.js";
import { createRedis } from "./redis.js";
import { log } from "./log.js";
import { dueAutoCloses, getOpenSession, clearOpenSession } from "./session.js";
import { patchAttendanceEnd } from "./personio.js";
import { pushAnomaly } from "./anomalies.js";

const env = loadEnv();
const redis = createRedis(env);

async function runOnce() {
  const now = Math.floor(Date.now() / 1000);
  const emails = await dueAutoCloses(redis as any, now, 100);

  if (emails.length === 0) {
    log("info", "cron.no_due_autoclose");
    return;
  }

  log("info", "cron.due_autoclose", { count: emails.length });

  for (const email of emails) {
    const open = await getOpenSession(redis as any, email);
    if (!open) {
      // stale zset entry
      await clearOpenSession(redis as any, email);
      continue;
    }

    try {
      if (!env.SHADOW_MODE) {
        await patchAttendanceEnd(env, redis as any, open.personioPeriodId, open.autoCloseBerlin);
      }
      await clearOpenSession(redis as any, email);
      await pushAnomaly(redis as any, { ts: new Date().toISOString(), type: "AUTO_CLOSED", email, details: { end: open.autoCloseBerlin } });
      log("info", "cron.autoclosed", { email, end: open.autoCloseBerlin, shadow: env.SHADOW_MODE });
    } catch (e: any) {
      await pushAnomaly(redis as any, { ts: new Date().toISOString(), type: "AUTO_CLOSE_FAILED", email, details: { err: String(e?.message ?? e) } });
      log("error", "cron.autoclose_failed", { email, err: String(e?.message ?? e) });
    }
  }
}

runOnce().catch((e) => {
  log("error", "cron.fatal", { err: String((e as any)?.message ?? e) });
  process.exit(1);
});
