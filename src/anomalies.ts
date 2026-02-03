import type { Redis } from "./redis";

export type Anomaly = {
  ts?: string; // optional in callers, we add it
  type: string;
  email?: string;
  eventId?: string;
  details?: Record<string, unknown>;
};

const KEY = "anomalies:list";

export async function recordAnomaly(redis: Redis, a: Anomaly) {
  const item = {
    ts: a.ts ?? new Date().toISOString(),
    type: a.type,
    email: a.email,
    eventId: a.eventId,
    details: a.details ?? {}
  };
  await redis.lPush(KEY, JSON.stringify(item));
  await redis.lTrim(KEY, 0, 499); // keep last 500
}

export async function listAnomalies(redis: Redis, limit: number) {
  const raw = await redis.lRange(KEY, 0, Math.max(0, limit - 1));
  return raw.map((x) => {
    try {
      return JSON.parse(x);
    } catch {
      return { ts: new Date().toISOString(), type: "ANOMALY_PARSE_ERROR", details: { raw: x } };
    }
  });
}
