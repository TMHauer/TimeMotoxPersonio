export function log(level: "info" | "warn" | "error", msg: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta } : {})
  };
  // minimal logging: no raw payloads
  console.log(JSON.stringify(entry));
}
