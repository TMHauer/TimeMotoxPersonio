import type { Env } from "./env.js";
import type { Redis } from "@upstash/redis";
import { log } from "./log.js";

type TokenCache = { token: string; expiresAt: number };

const TOKEN_KEY = "personio:token";
const EMP_CACHE_PREFIX = "personio:emp:";

async function fetchText(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body, text };
}

export async function getPersonioToken(env: Env, redis: Redis): Promise<string> {
  const cached = await r
