import express from "express";
import type { Request, Response } from "express";
import { loadEnv } from "./env.js";
import { createRedis } from "./redis.js";
import { log } from "./log.js";
import { verifyTimemotoSignature, type SigDebug } from "./timemoto.js";
import { handleAttendance } from "./processor.js";
import { listAnomalies, recordAnomaly } from "./anomalies.js";

const env = loadEnv();
const redis = createRedis(env);

const app = express();

/**
 * Health
 */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString(), shadow: env.SHADOW_MODE });
});

/**
 * Optional: deps/redis check (if you have it already elsewhere, keep yours)
 */
app.get("/health/deps", async (_req: Request, res: Response) => {
  try {
    const ok = await redis.ping();
    res.json({ ok: true, redis: ok ? "ok" : "warn", shadow: env.SHADOW_MODE });
  } catch (e: any) {
    res.json({ ok: true, redis: "warn", err: String(e?.message ?? e), shadow: env.SHADOW_MODE });
  }
});

/**
 * TimeMoto Webhook receiver (POST only)
 */
app.post(
  "/webhook/timemoto",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const raw = req.body as Buffer;

    const sig = (req.header("timemoto-signature") ?? null) as string | null;

    const debug: SigDebug = {
      headerKeys: Object.keys(req.headers ?? {}),
      hasSig: !!sig,
    };

    const okSig = verifyTimemotoSignature(raw, sig, env.TIMEMOTO_WEBHOOK_SECRET, debug);

    if (!okSig) {
      log("warn", "webhook.signature_invalid", debug);

      // record anomaly (minimal)
      await recordAnomaly(redis, {
        type: "SIGNATURE_INVALID",
        email: null,
        event_id: null,
        details: JSON.stringify({
          sigPrefix: debug.sigPrefix,
          sigLen: debug.sigLen,
          bodyLen: debug.bodyLen,
        }),
      });

      // IMPORTANT:
      // - In Shadow Mode OR if ALLOW_INVALID_SIGNATURE is true, we continue so you can test end-to-end.
      // - In Prod, set SHADOW_MODE=false and ALLOW_INVALID_SIGNATURE=false to enforce security.
      if (!(env.SHADOW_MODE || env.ALLOW_INVALID_SIGNATURE)) {
        return res.status(401).json({ ok: false, code: "SIGNATURE_INVALID" });
      }
    }

    let body: any;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ ok: false, code: "INVALID_JSON" });
    }

    // ignore TimeMoto test event
    if (body?.event === "test") return res.json({ ok: true });

    try {
      if (typeof body?.event === "string" && body.event.startsWith("attendance.")) {
        await handleAttendance(env, redis, body);
      }
      // user.* events optional; we rely on employeeNumber=email in attendance payload
      return res.json({ ok: true });
    } catch (e: any) {
      log("error", "webhook.processing_error", { err: String(e?.message ?? e) });
      return res.status(500).json({ ok: false, code: "PROCESSING_ERROR", message: String(e?.message ?? e) });
    }
  }
);

/**
 * Admin endpoint: anomalies (protected)
 */
app.get("/admin/anomalies", async (req: Request, res: Response) => {
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (token !== env.ADMIN_TOKEN) return res.status(401).json({ ok: false });

  const limit = Number(req.query.limit ?? "100");
  const items = await listAnomalies(redis, Math.min(200, Math.max(1, limit)));
  res.json({ ok: true, items });
});

app.listen(env.PORT, () => {
  log("info", "server.started", { port: env.PORT, shadow: env.SHADOW_MODE });
});
