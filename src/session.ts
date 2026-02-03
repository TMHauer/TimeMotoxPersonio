import type { RedisClient } from "./redis";
import { toBerlinLocalNoOffset, berlinDayEndUtcMillis } from "./timemoto";

export type OpenSession = {
  email: string;
  startUtc: number;
  startBerlin: string;
  autoCloseAtUtc: number;
  autoCloseAtBerlin: string;
  periodId: string;
  openedEventId: string;
};

const OPEN_PREFIX = "open:";
const AUTOCLOSE_ZSET = "session:autoclose";
const HISTORY_PREFIX = "history:"; // history:<email> list

export async function getOpen(redis: RedisClient, email: string): Promise<OpenSession | null> {
  const key = OPEN_PREFIX + email;
  const v = await redis.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v) as OpenSession;
  } catch {
    return null;
  }
}

export async function setOpen(redis: RedisClient, s: OpenSession): Promise<void> {
  const key = OPEN_PREFIX + s.email;
  await redis.set(key, JSON.stringify(s));
  await redis.zadd(AUTOCLOSE_ZSET, s.autoCloseAtUtc, s.email);
}

export async function clearOpen(redis: RedisClient, email: string): Promise<void> {
  await redis.del(OPEN_PREFIX + email);
  await redis.zrem(AUTOCLOSE_ZSET, email);
}

export async function pushHistory(redis: RedisClient, email: string, item: Record<string, unknown>): Promise<void> {
  const key = HISTORY_PREFIX + email;
  await redis.lpush(key, JSON.stringify(item));
  await redis.ltrim(key, 0, 49);
}

export async function getRecentHistory(redis: RedisClient, email: string, limit: number): Promise<any[]> {
  const key = HISTORY_PREFIX + email;
  const raws = await redis.lrange(key, 0, Math.max(0, limit - 1));
  return raws
    .map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    })
    .filter(Boolean);
}

export function computeAutoClose(startUtc: number): { autoCloseAtUtc: number; autoCloseAtBerlin: string } {
  const max12h = startUtc + 12 * 3600_000;
  const dayEnd = berlinDayEndUtcMillis(startUtc);
  const autoCloseAtUtc = Math.min(max12h, dayEnd);
  return { autoCloseAtUtc, autoCloseAtBerlin: toBerlinLocalNoOffset(autoCloseAtUtc) };
}
