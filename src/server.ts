import express from "express";
import type { Request, Response } from "express";
import { loadEnv } from "./env.js";
import { createRedis } from "./redis.js";
import { log } from "./log.js";
import { verifyTimemotoSignature, signatureDebugInfo } from "./timemoto.js";
import { handleAttendance } from "./processor.js";
import { listAnomalies, recordAnomaly } from "./anomalies.js";

const env = loadEnv();
const redis = createRedis(env);

const app = express();

function getSignatureHeader(req: Request): string | undefined {
  return (
    req.header("timemoto-signature") ??
    req.header("x-timemoto-signature") ??
    req.header("x-webhook-signature") ??
    req.header("x-signature") ??
    req.header("signature") ??
    req.header("authorization")
  );
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString(), shadow: env.SHADOW_MODE });
});

app.get("/health/deps", async (_req: Request, res: Response) => {
  try {
    const key = `health:ping:${Math.random().toString(16).slice(2)}`;
    const wrote = await redis.set(key, "1", { ex: 30 });
    const got = await redis.get(key);
    const gotStr = got === null || got === undefined ? null : String(got);
    const okRedis = wrote === "OK" && gotStr === "1";

    res.json({
      ok: true,
      redis: okRedis ? "ok" : "warn",
      details: { wrote, gotType: got === null ? "null" : typeof got, gotStr },
      shadow: env.SHADOW_MODE
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// NEW: webhook with path token (recommended)
app.post(
  "/webhook/timemoto/:token",
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    const token = String(req.params.token ?? "");
    if (token !== env.WEBHOOK_PATH_TOKEN) {
      log("warn", "webhook.path_token_invalid");
      return res.status(401).json({ ok: false, code: "TOKEN_INVALID" });
    }

    return handleWebhook(req, res);
  }
);

// Legacy endpoint (optional): keep for transition, but should NOT be used in TimeMoto
app.post(
  "/webhook/timemoto",
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    // if someone calls this, enforce signature unless explicitly allowed (shadow/dev)
    return handleWebhook(req, res, { enforceSignature: true });
  }
);

async function handleWebhook(
  req: Request,
  res: Response,
  opts?: { enforceSignature?: boolean }
) {
  const raw = req.body as Buffer;

  let body: any;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    log("warn", "webhook.invalid_json", { contentType: req.header("content-type") ?? null });
    return res.status(400).json({ ok: false, code: "INVALID_JSON" });
  }

  // ignore TimeMoto test event
  if (body?.event === "test") {
    log("info", "webhook.test_event_received");
    return res.json({ ok: true });
  }

  // Best effort signature check (log + anomaly)
  const sig = getSignatureHeader(req);
  const okSig = verifyTimemotoSignature(raw, sig, env.TIMEMOTO_WEBHOOK_SECRET);

  if (!okSig) {
    const dbg = signatureDebugInfo(raw, sig, env.TIMEMOTO_WEBHOOK_SECRET);
    log("warn", "webhook.signature_invalid", {
      headerKeys: Object.keys(req.headers),
      hasSig: Boolean(sig),
      sigLen: dbg.sigLen,
      sigPrefix: dbg.sigPrefix,
      bodyLen: dbg.bodyLen,
      candPrefixes: dbg.candPrefixes
    });

    await recordAnomaly(redis as any, {
      type: "SIGNATURE_INVALID",
      email: null,
      event_id: body?.id ?? null,
      details: JSON.stringify({ sigPrefix: dbg.sigPrefix, sigLen: dbg.sigLen, bodyLen: dbg.bodyLen })
    });

    // Only enforce for legacy endpoint (or if you explicitly want it)
    if (opts?.enforceSignature && !(env.SHADOW_MODE || env.ALLOW_INVALID_SIGNATURE)) {
      return res.status(401).json({ ok: false, code: "SIGNATURE_INVALID" });
    }
  }

  try {
    if (typeof body?.event === "string" && body.event.startsWith("attendance.")) {
      await handleAttendance(env, redis as any, body);
    }
    return res.json({ ok: true });
  } catch (e: any) {
    log("error", "webhook.processing_error", { err: String(e?.message ?? e) });
    return res.status(500).json({ ok: false, code: "PROCESSING_ERROR", message: String(e?.message ?? e) });
  }
}

app.get("/admin/anomalies", async (req: Request, res: Response) => {
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token !== env.ADMIN_TOKEN) return res.status(401).json({ ok: false });

  const limit = Number(req.query.limit ?? "100");
  const items = await listAnomalies(redis as any, Math.min(200, Math.max(1, limit)));
  res.json({ ok: true, items });
});

app.listen(env.PORT, () => {
  log("info", "server.started", { port: env.PORT, shadow: env.SHADOW_MODE });
});
