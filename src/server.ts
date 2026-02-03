import express, { type Request, type Response } from "express";
import { loadEnv } from "./env";
import { createRedis } from "./redis";
import { log } from "./log";
import { verifyTimemotoSignature } from "./timemoto";
import { handleAttendance } from "./processor";
import { listAnomalies, recordAnomaly } from "./anomalies";
import { runAutoClose } from "./cron";

async function main() {
  const env = loadEnv();
  const redis = await createRedis(env);

  const app = express();

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, shadow: env.SHADOW_MODE });
  });

  app.get("/health/deps", async (_req: Request, res: Response) => {
    try {
      const k = `health:${Date.now()}`;
      await redis.set(k, "1", { EX: 30 });
      const v = await redis.get(k);
      res.json({ ok: true, redis: v === "1" ? "ok" : "warn", shadow: env.SHADOW_MODE });
    } catch (e: any) {
      res.json({ ok: true, redis: "error", err: String(e?.message ?? e), shadow: env.SHADOW_MODE });
    }
  });

  // IMPORTANT: TimeMoto sends POST
  app.post("/webhook/timemoto", express.raw({ type: "application/json" }), async (req: Request, res: Response) => {
    const raw = req.body as Buffer;

    const sig = (req.header("timemoto-signature") ?? "").trim();
    const okSig = sig && verifyTimemotoSignature(raw, sig, env.TIMEMOTO_WEBHOOK_SECRET);

    if (!okSig) {
      log("warn", "webhook.signature_invalid", {
        hasSig: !!sig,
        sigLen: sig.length,
        sigPrefix: sig.slice(0, 6),
        bodyLen: raw.length
      });

      await recordAnomaly(redis, {
        type: "SIGNATURE_INVALID",
        details: { hasSig: !!sig, sigPrefix: sig.slice(0, 10), bodyLen: raw.length }
      });

      if (!env.ALLOW_INVALID_SIGNATURE) {
        return res.status(401).json({ ok: false, code: "SIGNATURE_INVALID" });
      }
    }

    let body: any;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ ok: false, code: "INVALID_JSON" });
    }

    // TimeMoto "test" event
    if (body?.event === "test") {
      log("info", "webhook.test_event_received");
      return res.json({ ok: true });
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

  // Admin: anomalies
  app.get("/admin/anomalies", async (req: Request, res: Response) => {
    const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (token !== env.ADMIN_TOKEN) return res.status(401).json({ ok: false });

    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? "50")));
    const items = await listAnomalies(redis, limit);
    return res.json({ ok: true, items });
  });

  // Admin: run auto-close manually (Render free: no cron guarantee)
  app.post("/admin/run-autoclose", async (req: Request, res: Response) => {
    const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (token !== env.ADMIN_TOKEN) return res.status(401).json({ ok: false });

    const out = await runAutoClose(env, redis);
    return res.json({ ok: true, ...out });
  });

  // Lightweight scheduler: best-effort every 5 minutes
  setInterval(() => {
    runAutoClose(env, redis).catch((e) => log("error", "autoclose.interval_failed", { err: String((e as any)?.message ?? e) }));
  }, 5 * 60 * 1000);

  app.listen(env.PORT, () => {
    log("info", "server.started", { port: env.PORT, shadow: env.SHADOW_MODE });
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
