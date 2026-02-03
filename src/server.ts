import express from "express";
import type { Request, Response } from "express";
import { loadEnv } from "./env";
import { createRedis } from "./redis";
import { log } from "./log";
import { signatureDebugCandidates, verifyTimemotoSignature } from "./timemoto";
import { handleAttendance } from "./processor";
import { listAnomalies, recordAnomaly } from "./anomalies";
import { runAutoClose } from "./cron";

const env = loadEnv();
const redis = createRedis(env);

const app = express();

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString(), shadow: env.SHADOW_MODE });
});

app.get("/health/deps", async (_req: Request, res: Response) => {
  try {
    await redis.set("health:ping", "1", "PX", 30_000);
    const v = await redis.get("health:ping");
    res.json({ ok: true, redis: v ? "ok" : "warn", shadow: env.SHADOW_MODE });
  } catch (e: any) {
    res.json({ ok: true, redis: "error", err: String(e?.message ?? e), shadow: env.SHADOW_MODE });
  }
});

// Webhook receiver
app.post("/webhook/timemoto", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
  const raw = req.body as Buffer;
  const sig = req.header("timemoto-signature") ?? undefined;

  let body: any;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return res.status(400).json({ ok: false, code: "INVALID_JSON" });
  }

  // TimeMoto test event (your logs show "webhook.test_event_received")
  if (body?.event === "test") {
    log("info", "webhook.test_event_received");
    return res.json({ ok: true });
  }

  const valid = verifyTimemotoSignature(raw, sig, env.TIMEMOTO_WEBHOOK_SECRET);
  if (!valid) {
    log("warn", "webhook.signature_invalid", {
      hasSig: Boolean(sig),
      sigLen: sig?.length ?? 0,
      sigPrefix: sig?.slice(0, 6) ?? "",
      bodyLen: raw?.length ?? 0,
      candPrefixes: signatureDebugCandidates(raw, env.TIMEMOTO_WEBHOOK_SECRET).map((x) => x.slice(0, 6))
    });

    await recordAnomaly(redis, {
      ts: new Date().toISOString(),
      type: "SIGNATURE_INVALID",
      eventId: String(body?.id ?? ""),
      details: { sigPrefix: sig?.slice(0, 10), bodyLen: raw?.length }
    });

    if (!env.ALLOW_INVALID_SIGNATURE) {
      return res.status(401).json({ ok: false, code: "SIGNATURE_INVALID" });
    }
  }

  try {
    if (typeof body?.event === "string" && body.event.startsWith("attendance.")) {
      await handleAttendance(env, redis, body);
    }
    return res.json({ ok: true });
  } catch (e: any) {
    log("error", "webhook.processing_error", { err: String(e?.message ?? e) });
    return res.status(500).json({ ok: false, code: "PROCESSING_ERROR", message: String(e?.message ?? e) });
  }
});

// Auto-close trigger (use external cron if Render free)
app.post("/cron/autoclose", async (req: Request, res: Response) => {
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token !== env.ADMIN_TOKEN) return res.status(401).json({ ok: false });

  try {
    const r = await runAutoClose(env, redis);
    res.json({ ok: true, ...r });
  } catch (e: any) {
    log("error", "cron.autoclose_failed", { err: String(e?.message ?? e) });
    res.status(500).json({ ok: false });
  }
});

// Admin: anomalies list
app.get("/admin/anomalies", async (req: Request, res: Response) => {
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token !== env.ADMIN_TOKEN) return res.status(401).json({ ok: false });

  const limit = Number(req.query.limit ?? "100");
  const items = await listAnomalies(redis, Math.min(200, Math.max(1, limit)));
  res.json({ ok: true, items });
});

app.listen(env.PORT, async () => {
  try { await redis.connect(); } catch {}
  log("info", "server.started", { port: env.PORT, shadow: env.SHADOW_MODE });
});
