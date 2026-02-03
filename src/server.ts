import express from "express";
import type { Request, Response } from "express";
import { loadEnv } from "./env.js";
import { createRedis } from "./redis.js";
import { log } from "./log.js";
import { verifyTimemotoSignature } from "./timemoto.js";
import { handleAttendance } from "./processor.js";
import { listAnomalies } from "./anomalies.js";

const env = loadEnv();
const redis = createRedis(env);

const app = express();

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString(), shadow: env.SHADOW_MODE });
});

// IMPORTANT: raw body needed for signature validation
app.post(
  "/webhook/timemoto",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const raw = req.body as Buffer;
    const sig = req.header("timemoto-signature");

    if (!verifyTimemotoSignature(raw, sig, env.TIMEMOTO_WEBHOOK_SECRET)) {
      log("warn", "webhook.signature_invalid");
      return res.status(401).json({ ok: false, code: "SIGNATURE_INVALID" });
    }

    let body: any;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ ok: false, code: "INVALID_JSON" });
    }

    if (body?.event === "test") return res.json({ ok: true });

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
