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
      const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
      const hh = Number(m[4]), mi = Number(m[5]), ss = Number(m[6]);
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
  const asUtc = Date.UTC(
    Number(p.y),
    Number(p.mo) - 1,
    Number(p.d),
    Number(p.h),
    Number(p.mi),
    Number(p.s)
  );
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
 * TimeMoto signature verification (robust):
 * - supports hex or base64 digest
 * - supports headers like: "sha256=<sig>", "t=...,v1=<sig>", "<sig>"
 */
export function verifyTimemotoSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const provided = extractSignatureToken(signatureHeader);
  if (!provided) return false;

  const h = crypto.createHmac("sha256", secret).update(rawBody);
  const expectedHex = h.digest("hex");

  const h2 = crypto.createHmac("sha256", secret).update(rawBody);
  const expectedB64 = h2.digest("base64");

  return safeEqual(provided, expectedHex) || safeEqual(provided, expectedB64);
}

function extractSignatureToken(headerValue: string): string | null {
  const v = headerValue.trim();

  // Common patterns:
  // - "sha256=<sig>"
  // - "t=123,v1=<sig>"
  // - "v1=<sig>"
  // - plain "<sig>"
  const m1 = v.match(/sha256=([A-Za-z0-9+/=._-]+)/i);
  if (m1?.[1]) return m1[1];

  const m2 = v.match(/v1=([A-Za-z0-9+/=._-]+)/i);
  if (m2?.[1]) return m2[1];

  const m3 = v.match(/signature=([A-Za-z0-9+/=._-]+)/i);
  if (m3?.[1]) return m3[1];

  // if comma-separated, try last token
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

function safeEqual(a: string, b: string): boolean {
  const aa = a.trim();
  const bb = b.trim();
  if (aa.length !== bb.length) return false;

  const ba = Buffer.from(aa);
  const bb2 = Buffer.from(bb);
  return crypto.timingSafeEqual(ba, bb2);
}
