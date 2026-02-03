import type { Env } from "./env";
import type { Redis } from "./redis";
import { log } from "./log";
import { listDueAutoClose, getOpenSession, clearOpenSession, pushHistory } from "./session";
import { patchAttendanceEnd } from "./personio";
import { toBerlinISO } from "./timemoto";
import { recordAnomaly } from "./anomalies";

export async function runAutoClose(env: Env, redis: Redis): Promise<{ closed: number }> {
  const now = Date.now();
  const dueEmails = await listDueAutoClose(redis, now, 50);

  let closed = 0;

  for (const email of dueEmails) {
    const open = await getOpenSession(redis, email);
    if (!open) {
      await clearOpenSession(redis, email);
      continue;
    }

    // close at stored autoCloseAtUtcMs (hard cap)
    const endBerlin = toBerlinISO(open.autoCloseAtUtcMs);

    try {
      if (!env.SHADOW_MODE) {
        await patchAttendanceEnd(env, redis, open.personioPeriodId, endBerlin);
      } else {
        log("info", "personio.shadow_skip_patch_end", { email, periodId: open.personioPeriodId, end: endBerlin });
      }

      await pushHistory(redis, { email, start: open.startBerlinISO, end: endBerlin, reason: "AUTO_CLOSE", periodId: open.personioPeriodId });
      await clearOpenSession(redis, email);

      closed++;
      log("info", "attendance.auto_closed", { email, start: open.startBerlinISO, end: endBerlin, periodId: open.personioPeriodId });
    } catch (e: any) {
      await recordAnomaly(redis, { type: "AUTO_CLOSE_FAILED", email, details: { err: String(e?.message ?? e) } });
      log("error", "attendance.auto_close_failed", { email, err: String(e?.message ?? e) });
    }
  }

  return { closed };
}
