import type { Redis } from "./redis";

export type OpenSession = {
  email: string;

  startUtcMs: number;
  startBerlinISO: string;

  // min(start+12h, dayEnd(23:59 Berlin))
  autoCloseAtUtcMs: number;

  // Personio attendance period id (we create on IN as open-ended)
  personioPeriodId: string;

  openedEventId: string;

  updatedAt: string;
};

const OPEN_PREFIX = "session:open:";     // session:open:<email>
const AUTOCLOSE_ZSET = "session:autoclose"; // score=autoCloseAtUtcMs, member=email
const HISTORY_LIST = "session:history";  // global list of json lines

export async function getOpenSession(redis: Redis, email: string): Promise<OpenSession | null> {
  const raw = await redis.get(OPEN_PREFIX + email);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OpenSession;
  } catch {
    return null;
  }
}

export async function setOpenSession(redis: Redis, s: OpenSession): Promise<void> {
  await redis.set(OPEN_PREFIX + s.email, JSON.stringify(s));
  await redis.zAdd(AUTOCLOSE_ZSET, [{ score: s.autoCloseAtUtcMs, value: s.email }]);
}

export async function clearOpenSession(redis: Redis, email: string): Promise<void> {
  await redis.del(OPEN_PREFIX + email);
  await redis.zRem(AUTOCLOSE_ZSET, email);
}

export async function listDueAutoClose(redis: Redis, nowUtcMs: number, limit: number): Promise<string[]> {
  const res = await redis.zRangeByScore(AUTOCLOSE_ZSET, 0, nowUtcMs, { LIMIT: { offset: 0, count: limit } });
  return res ?? [];
}

export async function pushHistory(redis: Redis, item: Record<string, unknown>): Promise<void> {
  const line = { ts: new Date().toISOString(), ...item };
  await redis.lPush(HISTORY_LIST, JSON.stringify(line));
  await redis.lTrim(HISTORY_LIST, 0, 1999);
}
