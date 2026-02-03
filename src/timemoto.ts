import crypto from "node:crypto";

export type TimemotoEvent = {
  id: string;
  event: string; // attendance.inserted | attendance.updated | user.updated | ...
  sequence?: number;
  dispatchedAt?: number;
  data: any;
};

/**
 * TimeMoto sends header: timemoto-signature
 * Expected: hex string of HMAC-SHA256 over the RAW request body using your shared secret.
 */
export function verifyTimemotoSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined | null,
  secret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // constant-time compare (must be same length)
  const a = Buffer.from(signatureHeader.trim(), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  if (!e.includes("@")) return null;
  return e;
}

/**
 * Prefer timeLogged (Berlin local without offset) using timeZone, fallback to timeInserted (UTC Z).
 * - timeLogged example: "2026-02-02T17:06:00" (no Z) + timeZone "Europe/Berlin"
 * - timeInserted example: "2026-02-02T16:06:10Z"
 */
export function extractStampUtc(ev: TimemotoEvent): Date {
  const tz = String(ev?.data?.timeZone ?? "Europe/Berlin");
  const timeLogged = ev?.data?.timeLogged as string | undefined;
  const timeInserted = ev?.data?.timeInserted as string | undefined;

  if (timeLogged && tz === "Europe/Berlin") {
    return berlinLocalToUtc(normalizeLocalIso(timeLogged));
  }
  if (timeInserted) return new Date(timeInserted);
  if (typeof ev.dispatchedAt === "number") return new Date(ev.dispatchedAt * 1000);

  throw new Error("No timestamp in event (timeLogged/timeInserted/dispatchedAt missing)");
}

/**
 * Normalize strings like "2026-02-02T17:06:00.123" -> "2026-02-02T17:06:00"
 */
function normalizeLocalIso(s: string): string {
  const trimmed = s.trim();
  // Keep only "YYYY-MM-DDTHH:mm:ss"
  if (trimmed.length >= 19) return trimmed.slice(0, 19);
  return trimmed;
}

/**
 * Convert "YYYY-MM-DDTHH:mm:ss" interpreted as Europe/Berlin local time to UTC Date.
 * DST-safe via Intl offset trick.
 */
export function berlinLocalToUtc(localIso: string): Date {
  const [d, t] = localIso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);

  // Construct a UTC date with same components (temporary anchor)
  const asUtc = new Date(Date.UTC(Y, M - 1, D, h, mi, s || 0));

  // Format that instant in Europe/Berlin to derive its local components
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const parts = fmt.formatToParts(asUtc);
  const yy = Number(parts.find(p => p.type === "year")!.value);
  const mm = Number(parts.find(p => p.type === "month")!.value);
  const dd = Number(parts.find(p => p.type === "day")!.value);
  const hh = Number(parts.find(p => p.type === "hour")!.value);
  const mii = Number(parts.find(p => p.type === "minute")!.value);
  const ss = Number(parts.find(p => p.type === "second")!.value);

  // berlinAsUtc is the UTC instant that would show the Berlin-local wall clock values
  const berlinAsUtc = new Date(Date.UTC(yy, mm - 1, dd, hh, mii, ss));
  const offsetMs = berlinAsUtc.getTime() - asUtc.getTime();

  // localIso was Berlin local, so actual UTC instant is anchor minus offset
  return new Date(asUtc.getTime() - offsetMs);
}

/**
 * Convert UTC Date to Berlin local ISO-like string "YYYY-MM-DDTHH:mm:ss" (no offset).
 */
export function utcToBerlinLocalIso(dtUtc: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  const parts = fmt.formatToParts(dtUtc);
  const y = parts.find(p => p.type === "year")!.value;
  const m = parts.find(p => p.type === "month")!.value;
  const d = parts.find(p => p.type === "day")!.value;
  const hh = parts.find(p => p.type === "hour")!.value;
  const mi = parts.find(p => p.type === "minute")!.value;
  const ss = parts.find(p => p.type === "second")!.value;

  return `${y}-${m}-${d}T${hh}:${mi}:${ss}`;
}

/**
 * 23:59 of the start day (Berlin local) for "YYYY-MM-DDTHH:mm:ss"
 */
export function berlinDayEnd(berlinIso: string): string {
  return `${berlinIso.slice(0, 10)}T23:59:00`;
}

/**
 * Add hours to a Berlin-local iso time, DST-safe by converting via UTC.
 */
export function addHoursBerlin(berlinIso: string, hours: number): string {
  const utc = berlinLocalToUtc(berlinIso);
  const plus = new Date(utc.getTime() + hours * 3600_000);
  return utcToBerlinLocalIso(plus);
}

export function minIso(a: string, b: string): string {
  return a < b ? a : b;
}
