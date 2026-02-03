import type { Redis } from "@upstash/redis";

const KEY = "anomalies:list";
const MAX = 500;

export type Anomaly = {
  ts?: string;
  type: string;
  email?: string | null;
  eventId?: string | null;
  event_id?: string | null; // backward compat
  details?: any;
};

export async function pushAnomaly(redis: Redis, a: Anomaly) {
  const payload = {
    ts: a.ts ?? new Date().toISOString(),
    type: a.type,
    email: a.email ?? null,
    eventId: a.eventId ?? a.event_id ?? null,
    details: a.details ?? null
  };
  await redis.lpush(KEY, JSON.stringify(payload));
  await redis.ltrim(KEY, 0, MAX - 1);
}

// Compatibility alias (server.ts may call this)
export async function recordAnomaly(redis: Redis, a: { type: string; email: any; event_id: any; details: any }) {
  await pushAnomaly(redis, {
    type: a.type,
    email: a.email ?? null,
    eventId: a.event_id ?? null,
    details: a.details
  });
}

export async function listAnomalies(redis: Redis, limit: number): Promise<Anomaly[]> {
  const raw = await redis.lrange(KEY, 0, Math.max(0, limit - 1));
  const arr: string[] = Array.isArray(raw) ? (raw as string[]) : [];

  return arr.map((s) => {
    try {
      return JSON.parse(s) as Anomaly;
    } catch {
      return { ts: new Date().toISOString(), type: "ANOMALY_PARSE_ERROR", details: { raw: s } };
    }
  });
}
