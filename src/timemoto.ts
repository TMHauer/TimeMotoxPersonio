import crypto from "node:crypto";

const TZ = "Europe/Berlin";

export function normalizeEmail(s: any): string | null {
  if (typeof s !== "string") return null;
  const e = s.trim().toLowerCase();
  return e.includes("@") ? e : null;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const aa = a.toLowerCase();
  const bb = b.toLowerCase();
  if (aa.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < aa.length; i++) out |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return out === 0;
}

export function verifyTimemotoSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return timingSafeEqualHex(expected, signatureHeader);
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
    // timeLogged e.g. "2026-02-02T17:06:00" in Europe/Berlin
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
  // get Berlin local date of the start
  const p = partsInTimeZone(startUtc, TZ);
  // 23:59:00 local
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
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
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
