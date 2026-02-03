import crypto from "node:crypto";
import { DateTime } from "luxon";

export function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

export function extractEmailFromEvent(body: any): string | null {
  const n = body?.data?.userEmployeeNumber;
  if (typeof n === "string" && n.includes("@")) return normalizeEmail(n);
  const e = body?.data?.emailAddress;
  if (typeof e === "string" && e.includes("@")) return normalizeEmail(e);
  return null;
}

export function extractStampUtcMillis(body: any): number | null {
  const tz = (typeof body?.data?.timeZone === "string" && body.data.timeZone) || "Europe/Berlin";

  // IMPORTANT:
  // Prefer non-rounded time first to avoid duplicate_punch when the provider re-sends rounded timestamps.
  const iso =
    body?.data?.timeLogged ??
    body?.data?.timeInserted ??
    body?.data?.timeLoggedRounded;

  if (typeof iso !== "string") return null;

  const dt = DateTime.fromISO(iso, { zone: tz });
  if (!dt.isValid) return null;
  return dt.toUTC().toMillis();
}

export function toBerlinISO(utcMillis: number): string {
  // keep as ISO with offset for logs/session; Personio formatting is handled in personio.ts now
  return DateTime.fromMillis(utcMillis, { zone: "utc" })
    .setZone("Europe/Berlin")
    .toISO({ suppressMilliseconds: true }) as string;
}

export function berlinDayEndUtcMillis(utcMillis: number): number {
  const berlin = DateTime.fromMillis(utcMillis, { zone: "utc" }).setZone("Europe/Berlin");
  const end = berlin.set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
  return end.toUTC().toMillis();
}

function timingSafeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function looksBase64(s: string): boolean {
  return /^[A-Za-z0-9+/=_-]+$/.test(s) && s.length >= 16;
}

function base64ToBuf(s: string): Buffer | null {
  try {
    const norm = s.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(norm, "base64");
  } catch {
    return null;
  }
}

function stripSigPrefix(sig: string): string {
  return String(sig ?? "")
    .trim()
    .replace(/^sha256=/i, "")
    .trim();
}

export function verifyTimemotoSignature(rawBody: Buffer, headerSig: string, secret: string): boolean {
  const sig = stripSigPrefix(headerSig);
  if (!sig) return false;

  const candidates: Buffer[] = [];
  candidates.push(Buffer.from(secret, "utf8"));

  if (looksBase64(secret)) {
    const b = base64ToBuf(secret);
    if (b && b.length > 0) candidates.push(b);
  }

  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
    try {
      candidates.push(Buffer.from(secret, "hex"));
    } catch {
      // ignore
    }
  }

  for (const key of candidates) {
    const hHex = crypto.createHmac("sha256", key).update(rawBody).digest("hex");
    if (timingSafeEq(hHex.toLowerCase(), sig.toLowerCase())) return true;

    const hB64 = crypto.createHmac("sha256", key).update(rawBody).digest("base64");
    if (timingSafeEq(hB64, sig)) return true;

    const hB64Url = hB64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    if (timingSafeEq(hB64Url, sig)) return true;

    // non-HMAC fallbacks some vendors use
    const sha1 = crypto.createHash("sha256").update(Buffer.concat([key, rawBody])).digest("hex");
    if (timingSafeEq(sha1.toLowerCase(), sig.toLowerCase())) return true;

    const sha2 = crypto.createHash("sha256").update(Buffer.concat([rawBody, key])).digest("hex");
    if (timingSafeEq(sha2.toLowerCase(), sig.toLowerCase())) return true;
  }

  return false;
}

export function getClockingType(body: any): "In" | "Out" | null {
  const t = body?.data?.clockingType;
  if (t === "In" || t === "Out") return t;
  return null;
}
