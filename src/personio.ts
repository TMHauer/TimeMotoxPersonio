import type { Env } from "./env";
import type { Redis } from "./redis";
import { log } from "./log";

function formEncode(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString();
}

async function personioFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const url = `${env.PERSONIO_BASE_URL}${path}`;
  return fetch(url, init);
}

export async function getPersonioToken(env: Env, redis: Redis): Promise<string> {
  const tokenKey = "personio:token";
  const expKey = "personio:token:exp";

  const expRaw = await redis.get(expKey);
  const tok = await redis.get(tokenKey);

  const now = Date.now();
  if (tok && expRaw) {
    const exp = Number(expRaw);
    if (Number.isFinite(exp) && exp - now > 60_000) return tok; // 60s buffer
  }

  // Robust: use x-www-form-urlencoded to avoid 415 Unsupported Media Type :contentReference[oaicite:1]{index=1}
  const body = formEncode({
    client_id: env.PERSONIO_CLIENT_ID,
    client_secret: env.PERSONIO_CLIENT_SECRET,
    grant_type: "client_credentials"
  });

  const r = await personioFetch(env, "/v2/auth/token", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const txt = await r.text();
  if (!r.ok) {
    throw new Error(`Personio token failed ${r.status}: ${txt}`);
  }

  const json = JSON.parse(txt) as any;
  const access = json?.access_token;
  const expiresIn = Number(json?.expires_in ?? 3600);

  if (typeof access !== "string" || !access) throw new Error(`Personio token response missing access_token: ${txt}`);

  const exp = Date.now() + Math.max(300, expiresIn - 60) * 1000;
  await redis.set(tokenKey, access, { EX: Math.max(300, expiresIn - 60) });
  await redis.set(expKey, String(exp), { EX: Math.max(300, expiresIn - 60) });

  return access;
}

export async function getEmployeeIdByEmail(env: Env, redis: Redis, email: string): Promise<string | null> {
  const cacheKey = `personio:emp:${email}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const token = await getPersonioToken(env, redis);

  // Employee API email filter exists on v1/company/employees :contentReference[oaicite:2]{index=2}
  const url = `${env.PERSONIO_BASE_URL}/v1/company/employees?limit=1&offset=0&email=${encodeURIComponent(email)}`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "accept": "application/json",
      "authorization": `Bearer ${token}`
    }
  });

  const txt = await r.text();
  if (!r.ok) {
    log("warn", "personio.employee_lookup_failed", { email, status: r.status });
    return null;
  }

  const json = JSON.parse(txt) as any;
  const first = json?.data?.[0];

  // try multiple shapes
  const idVal =
    first?.attributes?.id?.value ??
    first?.id?.value ??
    first?.attributes?.id ??
    first?.id;

  if (idVal === undefined || idVal === null) return null;

  const id = String(idVal);
  await redis.set(cacheKey, id, { EX: 7 * 24 * 3600 });
  return id;
}

export async function createAttendanceOpenEnded(env: Env, redis: Redis, employeeId: string, startLocalBerlin: string): Promise<string> {
  const token = await getPersonioToken(env, redis);

  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/json",
    "authorization": `Bearer ${token}`
  };
  if (env.PERSONIO_BETA_HEADER) headers["Beta"] = "true";

  // v2 attendance-periods accepts open-ended end (or missing) :contentReference[oaicite:3]{index=3}
  const payload = {
    person: { id: employeeId },
    type: "WORK",
    start: { date_time: startLocalBerlin },
    comment: "TimeMoto"
  };

  const qs = env.PERSONIO_SKIP_APPROVAL ? "?skip_approval=true" : "";
  const r = await personioFetch(env, `/v2/attendance-periods${qs}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const txt = await r.text();
  if (!r.ok) throw new Error(`Personio create attendance failed ${r.status}: ${txt}`);

  // Try to extract id robustly
  const json = JSON.parse(txt) as any;
  const id = json?.data?.id ?? json?.id ?? json?.data?.attributes?.id;
  if (!id) throw new Error(`Personio create returned no id: ${txt}`);
  return String(id);
}

export async function patchAttendanceEnd(env: Env, redis: Redis, periodId: string, endLocalBerlin: string): Promise<void> {
  const token = await getPersonioToken(env, redis);

  const headers: Record<string, string> = {
    "accept": "application/json",
    "content-type": "application/json",
    "authorization": `Bearer ${token}`
  };
  if (env.PERSONIO_BETA_HEADER) headers["Beta"] = "true";

  const payload = {
    end: { date_time: endLocalBerlin }
  };

  const qs = env.PERSONIO_SKIP_APPROVAL ? "?skip_approval=true" : "";
  const r = await personioFetch(env, `/v2/attendance-periods/${encodeURIComponent(periodId)}${qs}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload)
  });

  const txt = await r.text();
  // PATCH often returns 204 with empty body (ok)
  if (!r.ok) throw new Error(`Personio patch end failed ${r.status}: ${txt}`);
}
