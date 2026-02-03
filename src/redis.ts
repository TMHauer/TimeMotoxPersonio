import Redis from "ioredis";
import type { Env } from "./env";
import { log } from "./log";

export type RedisClient = Redis;

export function createRedis(env: Env): RedisClient {
  const r = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true
  });

  r.on("error", (e) => log("warn", "redis.error", { err: String(e?.message ?? e) }));
  return r;
}
