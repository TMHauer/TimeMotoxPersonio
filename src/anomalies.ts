import type { RedisClient } from "./redis";
import { log } from "./log";

export type Anomaly = {
  ts: string;
  type: string;
  email?: string;
  eventId?: string;
  details?: Record<string, unknown>;
};

const KEY = "anomalies:list";

export async function recordAnomaly(redis: RedisClient, a: Anomaly) {
  const item = { ...a, ts: a.ts ?? new Date().toISOString() };
  await redis.lpush(KEY, JSON.stringify(item));
  await redis.ltrim(KEY, 0, 499);
  log("warn", `anomaly.${a.type}`, { email: a.email, eventId: a.eventId });
}

export async function listAnomalies(redis: RedisClient, limit: number): Promise<Anomaly[]> {
  const raws = await redis.lrange(KEY, 0, Math.max(0, limit - 1));
  return raws
    .map((s) => {
      try {
        return JSON.parse(s) as Anomaly;
      } catch {
        return null;
      }
    })
    .filter((x): x is Anomaly => Boolean(x));
}
