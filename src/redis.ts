import { Redis } from "@upstash/redis";
import type { Env } from "./env";

export function createRedis(env: Env) {
  return new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN
  });
}
