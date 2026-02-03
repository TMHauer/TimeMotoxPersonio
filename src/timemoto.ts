import crypto from "node:crypto";
import { DateTime } from "luxon";

export function normalizeEmail(v: string): string {
  return v.trim().toLowerCase();
}

export function extractEmailFromEvent(body: any): string | null {
  const n = body?.data?.userEmployeeNumber;
  if (typeof n === "string" && n.includes("@")) return normalizeEmail(n);
  // fallback (less ideal)
  const e = body?.data?.emailAddress;
  if (typeof e === "string" && e.includes("@")) return normalizeEmail(e);
  return null;
}

export function extractStampUtcMillis(body: any): number | null {
  const tz = (typeof body?.data?.timeZone === "string" && body.data.timeZone) || "Europe/Berlin";
  const iso =
    body?.data?.timeLoggedRounded ??
    body?.data?.timeLogged ??
    body?.data?.timeInserted;

  if (typeof iso !== "string") return null;

  // timeLogged often has no offset -> interpret in provided timeZone
  // timeInserted is usually Z -> Luxon handles it fine
  const dt = DateTime.fromISO(iso, { zone: tz });
  if (!dt.isValid) return null;
  return dt.toUTC().toMillis();
}

export function toBerlinISO(utcMillis: number): string {
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

function signatureCandidates(headerSig: string): string[] {
  const trimmed = (headerSig ?? "").trim();
  if (!trimmed) return [];

  const out = new Set<string>();
  out.add(trimmed);

  const normalized = trimmed.replace(/^sha256=/i, "").replace(/^hmac-sha256=/i, "");
  out.add(normalized);

  for (const token of trimmed.split(/,\s*/)) {
    if (!token) continue;
    out.add(token);
    const idx = token.indexOf("=");
    if (idx !== -1 && idx + 1 < token.length) {
      out.add(token.slice(idx + 1));
    }
  }

  return [...out].map((v) => v.trim()).filter(Boolean);
}

export function verifyTimemotoSignature(rawBody: Buffer, headerSig: string, secret: string): boolean {
  const sigs = signatureCandidates(headerSig);
  if (sigs.length === 0) return false;

  const candidates: Buffer[] = [];

  // 1) secret as utf8
  candidates.push(Buffer.from(secret, "utf8"));

  // 2) secret as base64 decoded (common gotcha)
  if (looksBase64(secret)) {
    const b = base64ToBuf(secret);
    if (b && b.length > 0) candidates.push(b);
  }

  // 3) secret as hex decoded
  if (/^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0) {
    try {
      candidates.push(Buffer.from(secret, "hex"));
    } catch {
      // ignore
    }
  }

  // compare against hex signature (most common: 64 hex chars)
  for (const key of candidates) {
    const h = crypto.createHmac("sha256", key).update(rawBody).digest("hex");
    for (const sig of sigs) {
      if (timingSafeEq(h.toLowerCase(), sig.toLowerCase())) return true;
    }

    // sometimes sent as base64
    const b64 = crypto.createHmac("sha256", key).update(rawBody).digest("base64");
    for (const sig of sigs) {
      if (timingSafeEq(b64, sig)) return true;
    }

    const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    for (const sig of sigs) {
      if (timingSafeEq(b64url, sig)) return true;
    }
  }

  return false;
}

export function getClockingType(body: any): "In" | "Out" | null {
  const t = body?.data?.clockingType;
  if (t === "In" || t === "Out") return t;
  return null;
}
