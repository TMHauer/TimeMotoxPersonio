import express from "express";
import type { Request, Response } from "express";
import { loadEnv } from "./env.js";
import { createRedis } from "./redis.js";
import { log } from "./log.js";
import { verifyTimemotoSignature, signatureDebugInfo } from "./timemoto.js";
import { handleAttendance } from "./processor.js";
import { listAnomalies } from "./anomalies.js";

const env = loadEnv();
const redis = createRedis(env);

const app = express();

function getSignatureHeader(req: Request): string | undefined {
  // Express headers are case-insensitive
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

// Basic connectivity check (no secrets returned)
app.get("/health/deps", async (_req: Request, res: Response) => {
  try {
    // Redis ping-ish
    await redis.set("health:ping", "1", { ex: 30 });
    const v = await redis.get("health:ping");

    res.json({
      ok: true,
      redis: v === "1" ? "ok" : "warn",
      shadow: env.SHADOW_MODE
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// Webhook: keep RAW bytes for signature verification
app.post(
  "/webhook/timemoto",
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    const raw = req.body as Buffer;
    const sig = getSignatureHeader(req);

    // parse JSON first to detect "test" events (some providers sign them differently)
    let body: any = null;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      log("warn", "webhook.invalid_json", { contentType: req.header("content-type") ?? null });
      return res.status(400).json({ ok: false, code: "INVALID_JSON" });
    }

    // Optional: allow unsigned TimeMoto "test" events (keeps production secure)
    if (body?.event === "test") {
      log("info", "webhook.test_event_received");
      return res.json({ ok: true });
    }

    const ok = verifyTimemotoSignature(raw, sig, env.TIMEMOTO_WEBHOOK_SECRET);
    if (!ok) {
      const dbg = signatureDebugInfo(raw, sig, env.TIMEMOTO_WEBHOOK_SECRET);
      log("warn", "webhook.signature_invalid", {
        headerKeys: Object.keys(req.headers),
        hasSig: Boolean(sig),
        ...dbg
      });
      return res.status(401).json({ ok: false, code: "SIGNATURE_INVALID" });
    }

    try {
      if (typeof body?.event === "string" && body.event.startsWith("attendance.")) {
        await handleAttendance(env, redis as any, body);
      }
      return res.json({ ok: true });
    } catch (e: any) {
      log("error", "webhook.processing_error", { err: String(e?.message ?? e) });
      return res.status(500).json({
        ok: false,
        code: "PROCESSING_ERROR",
        message: String(e?.message ?? e)
      });
    }
  }
);

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
