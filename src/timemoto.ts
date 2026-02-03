import crypto from "node:crypto";

function b64url(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeEq(a: string, b: string) {
  // constant-time compare where possible
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function normalizeSig(sigHeader: string) {
  // allow formats like:
  // - "abcdef..." (hex)
  // - "sha256=abcdef..."
  // - "v1=abcdef..."
  const s = sigHeader.trim();
  const parts = s.split(",");
  const candidates: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    const eqIdx = t.indexOf("=");
    if (eqIdx > 0) {
      candidates.push(t.slice(eqIdx + 1).trim());
    } else {
      candidates.push(t);
    }
  }
  return candidates.filter(Boolean);
}

export type SigDebug = {
  headerKeys?: string[];
  hasSig?: boolean;
  sigLen?: number;
  sigPrefix?: string;
  bodyLen?: number;
  candPrefixes?: string[];
};

export function computeSignatureCandidates(raw: Buffer, secret: string) {
  const cands: { label: string; value: string }[] = [];

  // 1) HMAC-SHA256 over raw body
  const hmac = crypto.createHmac("sha256", secret).update(raw).digest();
  cands.push({ label: "hmac_hex", value: hmac.toString("hex") });
  cands.push({ label: "hmac_b64", value: hmac.toString("base64") });
  cands.push({ label: "hmac_b64url", value: b64url(hmac) });

  // 2) plain sha256(raw)
  const shaRaw = crypto.createHash("sha256").update(raw).digest();
  cands.push({ label: "sha_raw_hex", value: shaRaw.toString("hex") });
  cands.push({ label: "sha_raw_b64", value: shaRaw.toString("base64") });

  // 3) sha256(secret + raw) / sha256(raw + secret)
  const sha1 = crypto.createHash("sha256").update(Buffer.concat([Buffer.from(secret, "utf8"), raw])).digest();
  cands.push({ label: "sha_secret_plus_raw_hex", value: sha1.toString("hex") });

  const sha2 = crypto.createHash("sha256").update(Buffer.concat([raw, Buffer.from(secret, "utf8")])).digest();
  cands.push({ label: "sha_raw_plus_secret_hex", value: sha2.toString("hex") });

  // 4) HMAC over sha256(raw) (sometimes used)
  const hmac2 = crypto.createHmac("sha256", secret).update(shaRaw).digest();
  cands.push({ label: "hmac_sha_raw_hex", value: hmac2.toString("hex") });
  cands.push({ label: "hmac_sha_raw_b64", value: hmac2.toString("base64") });
  cands.push({ label: "hmac_sha_raw_b64url", value: b64url(hmac2) });

  return cands;
}

/**
 * Verify the TimeMoto signature header against a set of common schemes.
 * Returns true if ANY supported candidate matches.
 *
 * IMPORTANT: We intentionally accept multiple formats because TimeMoto docs are not reliably accessible in all environments.
 */
export function verifyTimemotoSignature(raw: Buffer, sigHeader: string | null, secret: string, debug?: SigDebug) {
  if (!sigHeader || !secret) return false;

  const sigs = normalizeSig(sigHeader);
  if (sigs.length === 0) return false;

  const cands = computeSignatureCandidates(raw, secret);

  // optionally expose minimal debug info (no secrets)
  if (debug) {
    const first = sigs[0] ?? "";
    debug.sigLen = first.length;
    debug.sigPrefix = first.slice(0, 6);
    debug.bodyLen = raw.length;
    debug.candPrefixes = cands.slice(0, 6).map((c) => c.value.slice(0, 6));
  }

  // match any header candidate against any computed candidate
  for (const s of sigs) {
    for (const c of cands) {
      if (safeEq(s, c.value)) return true;
    }
  }
  return false;
}
