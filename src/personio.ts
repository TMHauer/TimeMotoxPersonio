// src/personio.ts
import { log } from "./log.js";
import type { Env } from "./env.js";

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: any): Promise<any>;
};

type PersonioTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number; // seconds
};

type PersonioAttendanceCreateResponse = {
  data?: { id?: string } | any;
  affected_periods?: any[];
};

const PERSONIO_BASE = "https://api.personio.de";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetryableStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 6,
  baseDelayMs = 300
): Promise<Response> {
  let lastErr: any = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (!isRetryableStatus(res.status)) return res;

      const retryAfter = res.headers.get("retry-after");
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : null;
      const backoff = retryAfterMs ?? Math.min(10_000, baseDelayMs * Math.pow(2, i));
      log("warn", "personio.retry", { status: res.status, url, backoffMs: backoff, attempt: i + 1 });
      await sleep(backoff);
      continue;
    } catch (e: any) {
      lastErr = e;
      const backoff = Math.min(10_000, baseDelayMs * Math.pow(2, i));
      log("warn", "personio.network_retry", { url, backoffMs: backoff, attempt: i + 1, err: String(e?.message ?? e) });
      await sleep(backoff);
    }
  }

  throw new Error(`Personio request failed after retries: ${String(lastErr?.message ?? lastErr)}`);
}

async function readJsonSafe(res: Response): Promise<any> {
  const txt = await res.text();
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: txt };
  }
}

export async function getAccessToken(env: Env, redis: RedisLike): Promise<string> {
  // SHADOW: niemals Personio callen, aber Processor soll nicht crashen
  if (env.SHADOW_MODE) return "shadow-token";

  const cacheKey = "personio:token:v2";
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      const obj = JSON.parse(cached) as { token: string; exp: number };
      if (Date.now() < obj.exp - 60_000) return obj.token; // 60s safety
    } catch {
      // ignore
    }
  }

  // Personio v2 auth token endpoint: x-www-form-urlencoded required :contentReference[oaicite:4]{index=4}
  const url = `${PERSONIO_BASE}/v2/auth/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.PERSONIO_CLIENT_ID,
    client_secret: env.PERSONIO_CLIENT_SECRET,
  }).toString();

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const data = await readJsonSafe(res);
    throw new Error(`Personio token failed ${res.status}: ${JSON.stringify(data)}`);
  }

  const tok = (await res.json()) as PersonioTokenResponse;
  const expiresIn = typeof tok.expires_in === "number" ? tok.expires_in : 3600;
  const exp = Date.now() + expiresIn * 1000;

  await redis.set(cacheKey, JSON.stringify({ token: tok.access_token, exp }));
  log("info", "personio.token_cached", { expiresInSec: expiresIn });

  return tok.access_token;
}

async function personioJson(env: Env, redis: RedisLike, path: string, init: RequestInit) {
  if (env.SHADOW_MODE) {
    log("info", "personio.shadow_skip", { path, method: init.method ?? "GET" });
    return { ok: true, shadow: true };
  }

  const token = await getAccessToken(env, redis);
  const url = `${PERSONIO_BASE}${path}`;

  const res = await fetchWithRetry(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });

  if (!res.ok) {
    const data = await readJsonSafe(res);
    throw new Error(`Personio API failed ${res.status} ${path}: ${JSON.stringify(data)}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return readJsonSafe(res);
}

/**
 * Create attendance period (v2) :contentReference[oaicite:5]{index=5}
 * Uses skip_approval=true by default (see changelog) :contentReference[oaicite:6]{index=6}
 */
export async function createAttendancePeriod(
  env: Env,
  redis: RedisLike,
  personId: string,
  startISO: string,
  endISO: string
): Promise<string> {
  const path = `/v2/attendance-periods?skip_approval=true`;
  const payload = {
    person: { id: personId },
    type: "WORK",
    start: { date_time: startISO },
    end: { date_time: endISO },
  };

  const data = (await personioJson(env, redis, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })) as PersonioAttendanceCreateResponse;

  const id = (data as any)?.data?.id ?? (data as any)?.id;
  if (!id) {
    // Personio can return affected_periods etc; we still need a stable id
    throw new Error(`Personio create attendance: missing id in response: ${JSON.stringify(data)}`);
  }
  return String(id);
}

export async function updateAttendancePeriod(
  env: Env,
  redis: RedisLike,
  periodId: string,
  startISO: string,
  endISO: string
): Promise<void> {
  const path = `/v2/attendance-periods/${encodeURIComponent(periodId)}?skip_approval=true`;
  const payload = {
    start: { date_time: startISO },
    end: { date_time: endISO },
  };

  await personioJson(env, redis, path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deleteAttendancePeriod(env: Env, redis: RedisLike, periodId: string): Promise<void> {
  const path = `/v2/attendance-periods/${encodeURIComponent(periodId)}`;
  await personioJson(env, redis, path, { method: "DELETE" });
}

/**
 * Person lookup by email:
 * Personio v2 persons list doesn't clearly expose email filters; we do a small pagination scan.
 * For small/mid org this is fine and we cache the result.
 */
export async function resolvePersonIdByEmail(env: Env, redis: RedisLike, email: string): Promise<string> {
  const key = `personio:personId:${email.toLowerCase()}`;
  const cached = await redis.get(key);
  if (cached) return cached;

  if (env.SHADOW_MODE) {
    // stable fake id for shadow mode
    const fake = `shadow-${Buffer.from(email).toString("hex").slice(0, 16)}`;
    await redis.set(key, fake);
    return fake;
  }

  // Pagination scan over /v2/persons (limit 50) :contentReference[oaicite:7]{index=7}
  let url = `${PERSONIO_BASE}/v2/persons?limit=50`;
  for (let i = 0; i < 20; i++) {
    const token = await getAccessToken(env, redis);
    const res = await fetchWithRetry(url, { method: "GET", headers: { accept: "application/json", authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const data = await readJsonSafe(res);
      throw new Error(`Personio persons list failed ${res.status}: ${JSON.stringify(data)}`);
    }
    const json = await res.json();
    const items: any[] = json?.data ?? json?.persons ?? json?.items ?? [];
    for (const p of items) {
      const pEmail =
        (p?.email ?? p?.attributes?.email?.value ?? p?.attributes?.email ?? p?.meta?.email ?? "").toString().toLowerCase();
      if (pEmail && pEmail === email.toLowerCase()) {
        const id = String(p?.id ?? p?.data?.id ?? p?.attributes?.id_v2 ?? p?.attributes?.id ?? "");
        if (!id) throw new Error(`Personio person found for email but missing id: ${JSON.stringify(p)}`);
        await redis.set(key, id);
        return id;
      }
    }

    const next = json?.links?.next;
    if (!next) break;
    url = String(next);
  }

  throw new Error(`Personio person not found for email=${email}`);
}
