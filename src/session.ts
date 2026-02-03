import type { Redis } from "@upstash/redis";
import { toBerlinISO, berlinDayEndUtcMillis } from "./timemoto.js";

const OPEN_PREFIX = "session:open:";      // session:open:<email> -> JSON
const AUTOCLOSE_ZSET = "session:autoclose"; // member=email score=epochSeconds

export type OpenSession = {
  email: string;
  startUtcMillis: number;
  autoCloseUtcMillis: number;
  startBerlin: string;
  autoCloseBerlin: string;
  personioPeriodId: string;
  openedEventId: string;
  updatedAt: string;
};

export function computeAutoCloseUtcMillis(startUtc: Date): number {
  const plus12h = startUtc.getTime() + 12 * 60 * 60 * 1000;
  const dayEnd = berlinDayEndUtcMillis(startUtc);
  return Math.min(plus12h, dayEnd);
}

export async function setOpenSession(redis: Redis, s: OpenSession) {
  await redis.set(`${OPEN_PREFIX}${s.email}`, s);
}

export async function getOpenSession(redis: Redis, email: string): Promise<OpenSession | null> {
  const s = await redis.get<OpenSession>(`${OPEN_PREFIX}${email}`);
  return s ?? null;
}

export async function clearOpenSession(redis: Redis, email: string) {
  await redis.del(`${OPEN_PREFIX}${email}`);
  await redis.zrem(AUTOCLOSE_ZSET, email);
}

export async function upsertAutoCloseIndex(redis: Redis, email: string, autoCloseEpochSeconds: number) {
  await redis.zadd(AUTOCLOSE_ZSET, { score: autoCloseEpochSeconds, member: email });
}

export async function dueAutoCloses(redis: Redis, nowEpochSeconds: number, limit: number): Promise<string[]> {
  // IMPORTANT: Upstash expects offset/count at top-level (not nested limit:{})
  const emails = await redis.zrange<string[]>(
    AUTOCLOSE_ZSET,
    0,
    nowEpochSeconds,
    { byScore: true, offset: 0, count: limit }
  );
  return emails ?? [];
}
