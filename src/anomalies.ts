import type { Redis } from "@upstash/redis";

const KEY = "anomalies:list";
const MAX = 500;

export type Anomaly = {
  ts: string;
  type: string;
  email?: string;
  eventId?: string;
  details?: any;
};

export async function pushAnomaly(redis: Redis, a: Anomaly) {
  await redis.lpush(KEY, JSON.stringify(a));
  await redis.ltrim(KEY, 0, MAX - 1);
}

export async function listAnomalies(redis: Redis, limit: number): Promise<Anomaly[]> {
  // Upstash returns string[]
  const raw = await redis.lrange(KEY, 0, Math.max(0, limit - 1));

  // raw can be unknown/any depending on lib version -> normalize safely
  const arr: string[] = Array.isArray(raw) ? (raw as string[]) : [];

  return arr.map((s) => {
    try {
      return JSON.parse(s) as Anomaly;
    } catch {
      return { ts: new Date().toISOString(), type: "ANOMALY_PARSE_ERROR", details: { raw: s } };
    }
  });
}
