import type { Env } from "./env";
import { log } from "./log";
import type { RedisClient } from "./redis";

type TokenCache = { access_token: string; expires_at: number };

const TOKEN_KEY = "personio:token";
const EMP_CACHE_PREFIX = "personio:emp:"; // personio:emp:<email>

async function httpJson(url: string, init: RequestInit): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

export async function getPersonioToken(env: Env, redis: RedisClient): Promise<string> {
  const cached = await redis.get(TOKEN_KEY);
  if (cached) {
    try {
      const t = JSON.parse(cached) as TokenCache;
      if (t.access_token && t.expires_at > Date.now() + 30_000) return t.access_token;
    } catch {
      // ignore
    }
  }

  // Personio requires x-www-form-urlencoded for client_credentials grant :contentReference[oaicite:10]{index=10}
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", env.PERSONIO_CLIENT_ID);
  body.set("client_secret", env.PERSONIO_CLIENT_SECRET);

  const url = `${env.PERSONIO_BASE_URL}/v2/auth/token`;
  const { status, json, text } = await httpJson(url, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (status >= 300) {
    throw new Error(`Personio token failed ${status}: ${text}`);
  }

  const access = String(json?.access_token ?? "");
  const expiresIn = Number(json?.expires_in ?? 3600);
  if (!access) throw new Error(`Personio token missing: ${text}`);

  const cache: TokenCache = { access_token: access, expires_at: Date.now() + expiresIn * 1000 };
  await redis.set(TOKEN_KEY, JSON.stringify(cache), "PX", Math.max(60_000, expiresIn * 1000));
  return access;
}

export async function getEmployeeIdByEmail(env: Env, redis: RedisClient, email: string): Promise<string | null> {
  const key = EMP_CACHE_PREFIX + email;
  const cached = await redis.get(key);
  if (cached) return cached;

  const token = await getPersonioToken(env, redis);

  // v1 employees endpoint supports email filter :contentReference[oaicite:11]{index=11}
  const url = `${env.PERSONIO_BASE_URL}/v1/company/employees?email=${encodeURIComponent(email)}`;
  const { status, json, text } = await httpJson(url, {
    method: "GET",
    headers: {
      "accept": "application/json",
      "authorization": `Bearer ${token}`
    }
  });

  if (status >= 300) {
    log("warn", "personio.employee_lookup_failed", { status, email });
    return null;
  }

  const arr = json?.data;
  const emp = Array.isArray(arr) ? arr[0] : null;
  const id = emp?.attributes?.id?.value ?? emp?.attributes?.id ?? emp?.id ?? null;

  const employeeId = id ? String(id) : null;
  if (!employeeId) return null;

  // cache 24h
  await redis.set(key, employeeId, "PX", 24 * 3600 * 1000);
  return employeeId;
}

export async function createAttendance(env: Env, redis: RedisClient, employeeId: string, startBerlin: string, endBerlin: string): Promise<string> {
  if (env.SHADOW_MODE) {
    log("info", "personio.shadow_skip_create", { employeeId, start: startBerlin, end: endBerlin });
    return "shadow-period";
  }

  const token = await getPersonioToken(env, redis);

  // v2 create attendance period :contentReference[oaicite:12]{index=12}
  const url = `${env.PERSONIO_BASE_URL}/v2/attendance-periods?skip_approval=${env.PERSONIO_SKIP_APPROVAL ? "true" : "false"}`;
  const payload = {
    person: { id: employeeId },
    type: "WORK",
    start: { date_time: startBerlin },
    end: { date_time: endBerlin }
  };

  const { status, json, text } = await httpJson(url, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (status >= 300) {
    throw new Error(`Personio create attendance failed ${status}: ${text}`);
  }

  const id = String(json?.data?.id ?? json?.id ?? "");
  if (!id) throw new Error(`Personio create attendance missing id: ${text}`);
  return id;
}

export async function patchAttendanceEnd(env: Env, redis: RedisClient, periodId: string, endBerlin: string): Promise<void> {
  if (env.SHADOW_MODE) {
    log("info", "personio.shadow_skip_patch_end", { periodId, end: endBerlin });
    return;
  }
  const token = await getPersonioToken(env, redis);

  // v2 patch attendance period by id :contentReference[oaicite:13]{index=13}
  const url = `${env.PERSONIO_BASE_URL}/v2/attendance-periods/${encodeURIComponent(periodId)}?skip_approval=${env.PERSONIO_SKIP_APPROVAL ? "true" : "false"}`;
  const payload = { end: { date_time: endBerlin } };

  const { status, text } = await httpJson(url, {
    method: "PATCH",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "authorization": `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  if (status >= 300) {
    throw new Error(`Personio patch attendance failed ${status}: ${text}`);
  }
}
