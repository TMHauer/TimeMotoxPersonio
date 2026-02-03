import crypto from "node:crypto";

const TZ = "Europe/Berlin";

export type TimeMotoWebhook = {
  id: string;
  event: string;
  sequence?: number;
  dispatchedAt?: number;
  data?: any;
};

// ----------------------
// Email helpers
// ----------------------
export function normalizeEmail(s: any): string | null {
  if (typeof s !== "string") return null;
  const e = s.trim().toLowerCase();
  return e.includes("@") ? e : null;
}

export function extractEmail(body: TimeMotoWebhook): string | null {
  return (
    normalizeEmail(body?.data?.userEmployeeNumber) ??
    normalizeEmail(body?.data?.emailAddress) ??
    null
  );
}

// ----------------------
// Time helpers
// ----------------------

// Prefer UTC "timeInserted" (ends with Z). Fallback to "timeLogged" (Berlin local)
export function extractStampUtc(body: any): Date {
  const ti = body?.data?.timeInserted;
  if (typeof ti === "string") {
    const d = new Date(ti);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const tl = body?.data?.timeLogged ?? body?.data?.timeLoggedRounded;
  if (typeof tl === "string") {
    // "2026-02-02T17:06:00" (no Z) → treat as Berlin local
    const m = tl.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const y = Number(m[1]),
        mo = Number(m[2]),
        da = Number(m[3]);
      const hh = Number(m[4]),
        mi = Number(m[5]),
        ss = Number(m[6]);
      return zonedLocalToUtcDate(y, mo, da, hh, mi, ss, TZ);
    }
    const d = new Date(tl);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return new Date();
}

export function extractStampUtcMillis(body: any): number {
  return extractStampUtc(body).getTime();
}

/**
 * Berlin ISO with offset, e.g. 2026-02-03T12:38:22+01:00
 * (Good for debugging + Personio usually accepts date_time with offset.)
 */
export function toBerlinISO(dateUtc: Date): string {
  const p = partsInTimeZone(dateUtc, TZ);
  const offsetMin = getOffsetMinutes(dateUtc, TZ);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}${sign}${oh}:${om}`;
}

/**
 * Berlin local without offset, e.g. 2026-02-03T12:38:22
 * (Some Personio setups are picky; this format is also widely accepted.)
 */
export function toBerlinLocalNoOffset(msUtc: number): string {
  const dt = new Date(msUtc);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(dt);

  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Berlin day end 23:59 for the day of "start", returned as UTC millis.
 * Accepts Date OR number (fixes your TS error "Date not assignable to number").
 */
export function berlinDayEndUtcMillis(start: Date | number): number {
  const d = typeof start === "number" ? new Date(start) : start;
  const p = partsInTimeZone(d, TZ);
  const endUtc = zonedLocalToUtcDate(Number(p.y), Number(p.mo), Number(p.d), 23, 59, 0, TZ);
  return endUtc.getTime();
}

// ----------------------
// Signature verification
// ----------------------

/**
 * TimeMoto sends header "timemoto-signature" (64 hex).
 * We assume HMAC-SHA256 hex over RAW body with secret (common webhook pattern).
 */
export function verifyTimemotoSignature(rawBody: Buffer, signatureHeader: string | undefined | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const provided = signatureHeader.trim().toLowerCase();
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex").toLowerCase();

  try {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
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
  return [hex, b64, b64url];
}

// ----------------------
// Event helpers
// ----------------------

export function isAttendanceEvent(body: TimeMotoWebhook): boolean {
  return String(body?.event ?? "").startsWith("attendance.");
}

export function isIn(body: TimeMotoWebhook): boolean {
  return String(body?.data?.clockingType ?? "").toLowerCase() === "in";
}

export function isOut(body: TimeMotoWebhook): boolean {
  return String(body?.data?.clockingType ?? "").toLowerCase() === "out";
}

// ----------------------
// Internal TZ utils
// ----------------------

function partsInTimeZone(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const parts = dtf.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    y: get("year"),
    mo: get("month"),
    d: get("day"),
    h: get("hour"),
    mi: get("minute"),
    s: get("second")
  };
}

function getOffsetMinutes(date: Date, timeZone: string): number {
  const p = partsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(Number(p.y), Number(p.mo) - 1, Number(p.d), Number(p.h), Number(p.mi), Number(p.s));
  return Math.round((asUtc - date.getTime()) / 60000);
}

function zonedLocalToUtcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): Date {
  let utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);

  for (let i = 0; i < 2; i++) {
    const guess = new Date(utcMillis);
    const offset = getOffsetMinutes(guess, timeZone);
    utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000;
  }

  return new Date(utcMillis);
}
