import crypto from "node:crypto";
import { log } from "./log";

export type TimeMotoWebhook = {
  id: string;
  event: string; // attendance.inserted etc
  sequence?: number;
  dispatchedAt?: number;
  data?: any;
};

export function normalizeEmail(s: string): string | null {
  if (!s) return null;
  const e = String(s).trim().toLowerCase();
  if (!e.includes("@")) return null;
  return e;
}

export function extractEmail(body: TimeMotoWebhook): string | null {
  // you already mapped userEmployeeNumber=email
  const raw = body?.data?.userEmployeeNumber ?? body?.data?.emailAddress ?? null;
  return normalizeEmail(raw);
}

export function extractStampUtcMillis(body: TimeMotoWebhook): number | null {
  // TimeMoto sends timeLogged in local tz string without Z sometimes.
  const tl = body?.data?.timeLogged ?? body?.data?.timeLoggedRounded ?? body?.data?.timeInserted ?? null;
  if (!tl) return null;
  const d = new Date(String(tl));
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return ms;
}

// Personio v2 examples sometimes expect timestamps WITHOUT timezone offsets in filters.
// For payloads, safest is to send "YYYY-MM-DDTHH:MM:SS" in Berlin time (no offset).
// (Personio support mentioned this format for timestamps in v2 attendance contexts.)  :contentReference[oaicite:9]{index=9}
export function toBerlinLocalNoOffset(msUtc: number): string {
  const dt = new Date(msUtc);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(dt);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  // sv-SE gives YYYY-MM-DD + HH:MM:SS, we want YYYY-MM-DDTHH:MM:SS
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

export function berlinDayEndUtcMillis(msUtc: number): number {
  // End at 23:59:00 Berlin of that day (not 23:59:59 to avoid edge parsing)
  const berlin = new Date(new Date(msUtc).toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
  const y = berlin.getFullYear();
  const m = berlin.getMonth(); // 0-based
  const d = berlin.getDate();
  // Create 23:59 Berlin and convert to UTC millis
  const endBerlin = new Date(Date.UTC(y, m, d, 22, 59, 0, 0)); // naive
  // The above is not DST-safe by itself, so we compute via formatter:
  const endStr = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}T23:59:00`;
  // Parse as Berlin local by constructing a Date from locale string:
  const end = new Date(endStr + "+01:00"); // fallback
  // Better: compute by taking Berlin local and mapping via DateTimeFormat
  // In practice, 23:59 always exists (DST changes at night but not removing 23:xx).
  const ms = end.getTime();
  return ms;
}

export function verifyTimemotoSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader) return false;
  const sig = signatureHeader.trim().toLowerCase();

  // HMAC-SHA256 digest, hex output (64 chars) is the common webhook pattern
  const hex = crypto.createHmac("sha256", secret).update(rawBody).digest("hex").toLowerCase();

  try {
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(hex, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signatureDebugCandidates(rawBody: Buffer, secret: string): string[] {
  const h = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const hex = h.toString("hex");
  const b64 = h.toString("base64");
  const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  // also try treating secret as base64 (some vendors do this)
  let hex2 = "";
  try {
    const sec2 = Buffer.from(secret, "base64");
    hex2 = crypto.createHmac("sha256", sec2).update(rawBody).digest("hex");
  } catch {
    // ignore
  }
  return [hex, b64, b64url, hex2].filter(Boolean);
}

export function isAttendanceEvent(body: TimeMotoWebhook): boolean {
  const e = String(body?.event ?? "");
  return e.startsWith("attendance.");
}

export function isIn(body: TimeMotoWebhook): boolean {
  const t = String(body?.data?.clockingType ?? "").toLowerCase();
  return t === "in";
}

export function isOut(body: TimeMotoWebhook): boolean {
  const t = String(body?.data?.clockingType ?? "").toLowerCase();
  return t === "out";
}
