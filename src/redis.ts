import { createClient, type RedisClientType } from "redis";
import type { Env } from "./env";
import { log } from "./log";

export type Redis = RedisClientType;

export async function createRedis(env: Env): Promise<Redis> {
  const client = createClient({ url: env.REDIS_URL });
  client.on("error", (err) => log("error", "redis.error", { err: String(err) }));
  await client.connect();
  return client;
}
