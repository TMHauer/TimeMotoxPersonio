import crypto from "node:crypto";

const TZ = "Europe/Berlin";

export function normalizeEmail(s: any): string | null {
  if (typeof s !== "string") return null;
  const e = s.trim().toLowerCase();
  return e.includes("@") ? e : null;
}

// Prefer timeInserted (UTC Z). Fallback to timeLogged (assume Berlin local)
export function extractStampUtc(ev: any): Date {
  const ti = ev?.data?.timeInserted;
  if (typeof ti === "string" && ti.endsWith("Z")) {
    const d = new Date(ti);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const tl = ev?.data?.timeLogged;
  if (typeof tl === "string") {
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
  }

  return new Date();
}

// Convert UTC instant to ISO string with Berlin offset, e.g. 2026-02-02T17:06:00+01:00
export function toBerlinISO(dateUtc: Date): string {
  const parts = partsInTimeZone(dateUtc, TZ);
  const offsetMin = getOffsetMinutes(dateUtc, TZ);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return `${parts.y}-${parts.mo}-${parts.d}T${parts.h}:${parts.mi}:${parts.s}${sign}${oh}:${om}`;
}

export function berlinDayEndUtcMillis(startUtc: Date): number {
  const p = partsInTimeZone(startUtc, TZ);
  const endUtc = zonedLocalToUtcDate(Number(p.y), Number(p.mo), Number(p.d), 23, 59, 0, TZ);
  return endUtc.getTime();
}

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
  // if local time is ahead of UTC, offset is positive
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
  // initial guess: treat local as UTC
  let utcMillis = Date.UTC(year, month - 1, day, hour, minute, second);

  // refine 2x for DST correctness
  for (let i = 0; i < 2; i++) {
    const guessDate = new Date(utcMillis);
    const offset = getOffsetMinutes(guessDate, timeZone);
    utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000;
  }

  return new Date(utcMillis);
}

/**
 * TimeMoto signature verification (robust, safe):
 * Accepts common provider encodings/variants:
 * - HMAC-SHA256(secret, rawBody) encoded as:
 *   - hex
 *   - base64
 *   - base64url (no padding)
 * - Compatibility fallbacks (still secret-based):
 *   - SHA256(rawBody + secret)
 *   - SHA256(secret + rawBody)
 *
 * Header formats supported:
 * - "<sig>"
 * - "sha256=<sig>"
 * - "t=...,v1=<sig>"
 * - "v1=<sig>"
 * - "signature=<sig>"
 */
export function verifyTimemotoSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const provided = extractSignatureToken(signatureHeader);
  if (!provided) return false;

  const cand: string[] = [];

  // HMAC-SHA256
  const hmacBytes = crypto.createHmac("sha256", secret).update(rawBody).digest();
  cand.push(hmacBytes.toString("hex"));
  cand.push(hmacBytes.toString("base64"));
  cand.push(toBase64UrlNoPad(hmacBytes.toString("base64")));

  // Compatibility fallbacks (still secret-protected)
  const sha1 = crypto.createHash("sha256").update(Buffer.concat([rawBody, Buffer.from(secret, "utf8")])).digest("hex");
  const sha2 = crypto.createHash("sha256").update(Buffer.concat([Buffer.from(secret, "utf8"), rawBody])).digest("hex");
  cand.push(sha1);
  cand.push(sha2);

  return cand.some((c) => signatureEquals(provided, c));
}

function extractSignatureToken(headerValue: string): string | null {
  const v = headerValue.trim();

  const m1 = v.match(/sha256=([A-Za-z0-9+/=._-]+)/i);
  if (m1?.[1]) return m1[1];

  const m2 = v.match(/v1=([A-Za-z0-9+/=._-]+)/i);
  if (m2?.[1]) return m2[1];

  const m3 = v.match(/signature=([A-Za-z0-9+/=._-]+)/i);
  if (m3?.[1]) return m3[1];

  if (v.includes(",")) {
    const parts = v.split(",").map((s) => s.trim());
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      const mm = p.match(/(?:sha256|v1|sig|signature)=([A-Za-z0-9+/=._-]+)/i);
      if (mm?.[1]) return mm[1];
    }
  }

  // fallback: raw token
  return v.length > 10 ? v : null;
}

function signatureEquals(providedRaw: string, expectedRaw: string): boolean {
  // normalize both sides for:
  // - hex case
  // - base64 padding
  // - base64url variants
  const p = normalizeSig(providedRaw);
  const e = normalizeSig(expectedRaw);

  if (p.length !== e.length) return false;

  // timing safe compare
  const pb = Buffer.from(p, "utf8");
  const eb = Buffer.from(e, "utf8");
  return crypto.timingSafeEqual(pb, eb);
}

function normalizeSig(s: string): string {
  const v = s.trim();

  // If it looks like hex -> normalize to lowercase hex
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();

  // base64/base64url:
  // 1) convert urlsafe to standard
  // 2) remove padding (because some providers omit it)
  const std = v.replace(/-/g, "+").replace(/_/g, "/");
  return std.replace(/=+$/g, "");
}

function toBase64UrlNoPad(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
