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
  const cached = await redis.get<TokenCache>(TOKEN_KEY);
  const now = Date.now();

  if (cached?.token && cached.expiresAt > now + 60_000) return cached.token;

  const { res, body, text } = await fetchText("https://api.personio.de/v2/auth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.PERSONIO_CLIENT_ID,
      client_secret: env.PERSONIO_CLIENT_SECRET
    })
  });

  if (!res.ok) throw new Error(`Personio token failed ${res.status}: ${text}`);

  const token = body?.data?.token ?? body?.token;
  const expiresIn = Number(body?.data?.expires_in ?? body?.expires_in ?? 1800);

  if (!token) throw new Error("Personio token missing");

  const expiresAt = now + expiresIn * 1000;
  await redis.set(TOKEN_KEY, { token, expiresAt }, { ex: Math.floor(expiresIn) });

  return token;
}

async function personioRequest(env: Env, redis: Redis, method: string, path: string, payload?: any) {
  const token = await getPersonioToken(env, redis);
  const url = `https://api.personio.de${path}`;

  const { res, body, text } = await fetchText(url, {
    method,
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: payload ? JSON.stringify(payload) : undefined
  });

  if (res.status === 429 || res.status >= 500) {
    const err: any = new Error(`Personio transient ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  if (!res.ok) {
    const err: any = new Error(`Personio error ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }

  return body;
}

async function withRetry<T>(fn: () => Promise<T>, retries = 6): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e: any) {
      attempt++;
      const status = e?.status ?? 0;
      if (attempt > retries || !(status === 429 || status >= 500 || status === 0)) throw e;
      const backoff = Math.min(10_000, 250 * Math.pow(2, attempt));
      await new Promise(r => setTimeout(r, backoff));
    }
  }
}

export async function getEmployeeIdByEmail(env: Env, redis: Redis, email: string): Promise<string> {
  const key = `${EMP_CACHE_PREFIX}${email}`;
  const cached = await redis.get<string>(key);
  if (cached) return cached;

  const data = await withRetry(() =>
    personioRequest(env, redis, "GET", `/v1/company/employees?email=${encodeURIComponent(email)}`)
  );

  const list = data?.data ?? data?.employees ?? data?.data?.employees ?? [];
  const employees = Array.isArray(list) ? list : [];

  if (employees.length !== 1) {
    throw new Error(`Personio employee lookup not unique (count=${employees.length}) for ${email}`);
  }

  const employeeId = String(employees[0]?.id ?? employees[0]?.employee_id ?? employees[0]?.employeeId);
  if (!employeeId) throw new Error("Personio employeeId missing");

  await redis.set(key, employeeId, { ex: 60 * 60 * 24 });
  return employeeId;
}

export async function createAttendance(env: Env, redis: Redis, employeeId: string, startBerlin: string): Promise<string> {
  const payload = { employee_id: employeeId, type: "WORK", start: startBerlin, end: null };
  const data = await withRetry(() => personioRequest(env, redis, "POST", "/v2/attendance-periods", payload));
  const id = String(data?.data?.id ?? data?.id);
  if (!id) throw new Error("Personio create attendance: missing id");
  log("info", "personio.create_attendance.ok", { employeeId, startBerlin, periodId: id });
  return id;
}

export async function patchAttendanceEnd(env: Env, redis: Redis, periodId: string, endBerlin: string): Promise<void> {
  const payload = { end: endBerlin };
  await withRetry(() => personioRequest(env, redis, "PATCH", `/v2/attendance-periods/${encodeURIComponent(periodId)}`, payload));
  log("info", "personio.patch_end.ok", { periodId, endBerlin });
}
