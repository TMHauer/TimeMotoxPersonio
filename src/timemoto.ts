import crypto from "node:crypto";

const TZ = "Europe/Berlin";

export function normalizeEmail(s: any): string | null {
  if (typeof s !== "string") return null;
  const e = s.trim().toLowerCase();
  return e.includes("@") ? e : null;
}

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
      const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
      const hh = Number(m[4]), mi = Number(m[5]), ss = Number(m[6]);
      return zonedLocalToUtcDate(y, mo, da, hh, mi, ss, TZ);
    }
  }

  return new Date();
}

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
  return { y: get("year"), mo: get("month"), d: get("day"), h: get("hour"), mi: get("minute"), s: get("second") };
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
    const guessDate = new Date(utcMillis);
    const offset = getOffsetMinutes(guessDate, timeZone);
    utcMillis = Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000;
  }

  return new Date(utcMillis);
}

/**
 * Robust signature validation:
 * - Supports hex / base64 / base64url output
 * - Supports keys interpreted as:
 *   - UTF-8 string
 *   - base64-decoded bytes (if applicable)
 *   - hex-decoded bytes (if applicable)
 * - Also tries SHA256(secret+body) and SHA256(body+secret) (hex) as compatibility fallback.
 *
 * Header formats supported:
 * - "<sig>"
 * - "sha256=<sig>"
 * - "t=...,v1=<sig>"
 * - "v1=<sig>"
 * - "signature=<sig>"
 */
export function verifyTimemotoSignature(rawBody: Buffer, signatureHeader: string | undefined | null, secret: string): boolean {
  if (!signatureHeader) return false;

  const provided = extractSignatureToken(signatureHeader);
  if (!provided) return false;

  const candidates = computeCandidates(rawBody, secret);
  return candidates.some((c) => signatureEquals(provided, c));
}

// Minimal debug info WITHOUT leaking secrets/body/signature contents
export function signatureDebugInfo(rawBody: Buffer, signatureHeader: string | undefined | null, secret: string) {
  const provided = signatureHeader ? extractSignatureToken(signatureHeader) : null;
  const candidates = computeCandidates(rawBody, secret);

  return {
    sigLen: provided ? provided.length : 0,
    sigPrefix: provided ? provided.slice(0, 6) : null,
    bodyLen: rawBody?.length ?? 0,
    candPrefixes: candidates.slice(0, 5).map((c) => c.slice(0, 6))
  };
}

function computeCandidates(rawBody: Buffer, secret: string): string[] {
  const cand: string[] = [];

  // Key variants: utf8, base64-decoded, hex-decoded
  const keys: Buffer[] = [];
  keys.push(Buffer.from(secret, "utf8"));

  const b64 = tryDecodeBase64(secret);
  if (b64) keys.push(b64);

  const hex = tryDecodeHex(secret);
  if (hex) keys.push(hex);

  // HMAC variants for each key
  for (const key of keys) {
    const hmacBytes = crypto.createHmac("sha256", key).update(rawBody).digest();
    cand.push(hmacBytes.toString("hex"));
    cand.push(hmacBytes.toString("base64"));
    cand.push(toBase64UrlNoPad(hmacBytes.toString("base64")));
  }

  // Compatibility fallback (still secret-protected, but not ideal)
  cand.push(
    crypto.createHash("sha256").update(Buffer.concat([rawBody, Buffer.from(secret, "utf8")])).digest("hex")
  );
  cand.push(
    crypto.createHash("sha256").update(Buffer.concat([Buffer.from(secret, "utf8"), rawBody])).digest("hex")
  );

  return uniq(cand);
}

function uniq(arr: string[]): string[] {
  const s = new Set<string>();
  for (const a of arr) s.add(a);
  return Array.from(s);
}

function tryDecodeHex(s: string): Buffer | null {
  const v = s.trim();
  if (!/^[0-9a-fA-F]+$/.test(v)) return null;
  if (v.length % 2 !== 0) return null;
  try {
    const b = Buffer.from(v, "hex");
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
}

function tryDecodeBase64(s: string): Buffer | null {
  const v = s.trim();
  // very permissive: only attempt if it looks like base64-ish
  if (!/^[A-Za-z0-9+/=_-]+$/.test(v)) return null;
  try {
    const std = v.replace(/-/g, "+").replace(/_/g, "/");
    const pad = std.length % 4 === 0 ? std : std + "=".repeat(4 - (std.length % 4));
    const b = Buffer.from(pad, "base64");
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
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

  return v.length > 10 ? v : null;
}

function signatureEquals(providedRaw: string, expectedRaw: string): boolean {
  const p = normalizeSig(providedRaw);
  const e = normalizeSig(expectedRaw);

  if (p.length !== e.length) return false;

  const pb = Buffer.from(p, "utf8");
  const eb = Buffer.from(e, "utf8");
  return crypto.timingSafeEqual(pb, eb);
}

function normalizeSig(s: string): string {
  const v = s.trim();

  // hex digest (64 chars) -> normalize to lowercase
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();

  // base64/base64url -> normalize (urlsafe -> std, remove padding)
  const std = v.replace(/-/g, "+").replace(/_/g, "/");
  return std.replace(/=+$/g, "");
}

function toBase64UrlNoPad(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
