import type { Env } from "./env";
import type { RedisClient } from "./redis";
import { log } from "./log";
import { patchAttendanceEnd } from "./personio";
import { clearOpen, getOpen, pushHistory } from "./session";
import { toBerlinLocalNoOffset } from "./timemoto";

const AUTOCLOSE_ZSET = "session:autoclose";

export async function runAutoClose(env: Env, redis: RedisClient): Promise<{ closed: number }> {
  const now = Date.now();
  // get up to 50 due sessions
  const emails = await redis.zrangebyscore(AUTOCLOSE_ZSET, 0, now, "LIMIT", 0, 50);
  let closed = 0;

  for (const email of emails) {
    const s = await getOpen(redis, email);
    if (!s) {
      await redis.zrem(AUTOCLOSE_ZSET, email);
      continue;
    }
    if (s.autoCloseAtUtc > now) continue;

    const endBerlin = toBerlinLocalNoOffset(s.autoCloseAtUtc);

    await patchAttendanceEnd(env, redis, s.periodId, endBerlin);
    await pushHistory(redis, email, {
      start: s.startBerlin,
      end: endBerlin,
      end_reason: "AUTO_CLOSE",
      periodId: s.periodId,
      openedEventId: s.openedEventId,
      ts: new Date().toISOString()
    });
    await clearOpen(redis, email);
    closed++;
    log("info", "attendance.autoclosed", { email, periodId: s.periodId, end: endBerlin });
  }

  return { closed };
}
