import type { Redis } from "@upstash/redis";
import { addHoursBerlin, berlinDayEnd, minIso } from "./timemoto.js";

export type OpenSession = {
  email: string;
  startBerlin: string;
  autoCloseBerlin: string;
  personioPeriodId: string;
  openedEventId: string;
  updatedAt: string;
};

const SESSION_PREFIX = "session:open:"; // session:open:<email>
const AUTOCLOSE_ZSET = "session:autoclose"; // score = epochSeconds, value=email

export async function getOpenSession(redis: Redis, email: string): Promise<OpenSession | null> {
  return (await redis.get<OpenSession>(`${SESSION_PREFIX}${email}`)) ?? null;
}

export async function setOpenSession(redis: Redis, s: OpenSession): Promise<void> {
  await redis.set(`${SESSION_PREFIX}${s.email}`, s);
  const epochSeconds = Math.floor(new Date(s.autoCloseBerlin + "+01:00").getTime() / 1000); // rough; used only for ordering
  await redis.zadd(AUTOCLOSE_ZSET, { score: epochSeconds, member: s.email });
}

export async function clearOpenSession(redis: Redis, email: string): Promise<void> {
  await redis.del(`${SESSION_PREFIX}${email}`);
  await redis.zrem(AUTOCLOSE_ZSET, email);
}

export function computeAutoClose(startBerlin: string): string {
  return minIso(addHoursBerlin(startBerlin, 12), berlinDayEnd(startBerlin));
}

export async function dueAutoCloses(redis: Redis, nowEpochSeconds: number, limit = 50): Promise<string[]> {
  // returns emails
 const emails = await redis.zrange<string[]>(
  AUTOCLOSE_ZSET,
  0,
  nowEpochSeconds,
  { byScore: true, offset: 0, count: limit }
);
  return emails ?? [];
}
