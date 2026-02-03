import { Redis } from "@upstash/redis";
import type { Env } from "./env.js";

export type RedisClient = ReturnType<typeof createRedis>;

export function createRedis(env: Env) {
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });
}
