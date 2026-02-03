import crypto from "node:crypto";

export type TimemotoEvent = {
  id: string;
  event: string; // attendance.inserted | attendance.updated | user.updated | ...
  sequence?: number;
  dispatchedAt?: number;
  data: any;
};

export function verifyTimemotoSignature(rawBody: Buffer, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  // constant-time compare
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
 * Prefer timeLogged (Berlin local w/out offset) using timeZone, fallback to timeInserted (UTC Z).
 */
export function extractStampUtc(ev: TimemotoEvent): Date {
  const tz = String(ev?.data?.timeZone ?? "Europe/Berlin");
  const timeLogged = ev?.data?.timeLogged as string | undefined;
  const timeInserted = ev?.data?.timeInserted as string | undefined;

  if (timeLogged && tz === "Europe/Berlin") {
    // timeLogged like "2026-02-02T17:06:00" (no Z). Interpret as Berlin local.
    return berlinLocalToUtc(timeLogged);
  }
  if (timeInserted) return new Date(timeInserted);
  if (typeof ev.dispatchedAt === "number") return new Date(ev.dispatchedAt * 1000);
  throw new Error("No timestamp in event");
}

// Convert "YYYY-MM-DDTHH:mm:ss" Berlin local to UTC Date
export function berlinLocalToUtc(localIso: string): Date {
  const [d, t] = localIso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);

  // Start with a UTC date of same components
  const asUtc = new Date(Date.UTC(Y, M - 1, D, h, mi, s || 0));

  // Determine Berlin offset at that instant by formatting in Berlin and comparing
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const parts = fmt.formatToParts(asUtc);
  const yy = Number(parts.find(p => p.type === "year")!.value);
  const mm = Number(parts.find(p => p.type === "month")!.value);
  const dd = Number(parts.find(p => p.type === "day")!.value);
  const hh = Number(parts.find(p => p.type === "hour")!.value);
  const mii = Number(parts.find(p => p.type === "minute")!.value);
  const ss = Number(parts.find(p => p.type === "second")!.value);

  const berlinAsUtc = new Date(Date.UTC(yy, mm - 1, dd, hh, mii, ss));
  const offsetMs = berlinAsUtc.getTime() - asUtc.getTime();
  return new Date(asUtc.getTime() - offsetMs);
}

export function utcToBerlinLocalIso(dtUtc: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
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

export function berlinDayEnd(berlinIso: string): string {
  return `${berlinIso.slice(0, 10)}T23:59:00`;
}

export function addHoursBerlin(berlinIso: string, hours: number): string {
  const utc = berlinLocalToUtc(berlinIso);
  const plus = new Date(utc.getTime() + hours * 3600_000);
  return utcToBerlinLocalIso(plus);
}

export function minIso(a: string, b: string): string {
  return a < b ? a : b;
}
