import type { Env } from "./env";
import type { Redis } from "./redis";
import { log } from "./log";
import { DateTime } from "luxon";

function formEncode(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function personioFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const url = `${env.PERSONIO_BASE_URL}${path}`;
  return fetch(url, init);
}

/**
 * Personio v2 expects LocalDateTime (no timezone offset).
 * Convert any ISO (with/without offset) into Europe/Berlin local datetime string: YYYY-MM-DDTHH:mm:ss
 */
function toPersonioLocalDateTime(input: string): string {
  const raw = String(input ?? "").trim();
  if (!raw) return raw;

  // Try parsing ISO (with or without offset)
  const dt = DateTime.fromISO(raw, { setZone: true });
  if (dt.isValid) {
    return dt.setZone("Europe/Berlin").toFormat("yyyy-MM-dd'T'HH:mm:ss");
  }

  // Fallback: strip trailing timezone offset/Z if present
  return raw.replace(/([+-]\d{2}:\d{2}|Z)$/i, "");
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

  const body = formEncode({
    client_id: env.PERSONIO_CLIENT_ID,
    client_secret: env.PERSONIO_CLIENT_SECRET,
    grant_type: "client_credentials"
  });

  // IMPORTANT: no Accept: application/json (your logs showed Personio can reject it)
  const r = await personioFetch(env, "/v2/auth/token", {
    method: "POST",
    headers: {
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

  if (typeof access !== "string" || !access) {
    throw new Error(`Personio token response missing access_token: ${txt}`);
  }

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

  // v1 employee lookup is fine with accept: application/json
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
    log("warn", "personio.employee_lookup_failed", { email, status: r.status, body: txt.slice(0, 200) });
    return null;
  }

  const json = JSON.parse(txt) as any;
  const first = json?.data?.[0];

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

export async function createAttendanceOpenEnded(
  env: Env,
  redis: Redis,
  employeeId: string,
  startLocalBerlin: string
): Promise<string> {
  const token = await getPersonioToken(env, redis);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${token}`
  };
  if (env.PERSONIO_BETA_HEADER) headers["Beta"] = "true";

  const payload = {
    person: { id: employeeId },
    type: "WORK",
    start: { date_time: toPersonioLocalDateTime(startLocalBerlin) },
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

  const json = JSON.parse(txt) as any;
  const id = json?.data?.id ?? json?.id ?? json?.data?.attributes?.id;
  if (!id) throw new Error(`Personio create returned no id: ${txt}`);
  return String(id);
}

export async function patchAttendanceEnd(env: Env, redis: Redis, periodId: string, endLocalBerlin: string): Promise<void> {
  const token = await getPersonioToken(env, redis);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "authorization": `Bearer ${token}`
  };
  if (env.PERSONIO_BETA_HEADER) headers["Beta"] = "true";

  const payload = {
    end: { date_time: toPersonioLocalDateTime(endLocalBerlin) }
  };

  const qs = env.PERSONIO_SKIP_APPROVAL ? "?skip_approval=true" : "";
  const r = await personioFetch(env, `/v2/attendance-periods/${encodeURIComponent(periodId)}${qs}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(payload)
  });

  const txt = await r.text();
  if (!r.ok) throw new Error(`Personio patch end failed ${r.status}: ${txt}`);
}
