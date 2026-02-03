import type { Redis } from "@upstash/redis";

export type Anomaly = {
  ts: string;
  type: string;
  email?: string;
  eventId?: string;
  details?: Record<string, unknown>;
};

const KEY = "anomalies:list";
const MAX = 500;

export async function pushAnomaly(redis: Redis, a: Anomaly) {
  await redis.lpush(KEY, JSON.stringify(a));
  await redis.ltrim(KEY, 0, MAX - 1);
}

export async function listAnomalies(redis: Redis, limit = 100): Promise<Anomaly[]> {
  const rows = await redis.lrange<string>(KEY, 0, Math.min(limit, MAX) - 1);
  return (rows ?? []).map(r => JSON.parse(r));
}
