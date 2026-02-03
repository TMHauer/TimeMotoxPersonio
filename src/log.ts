export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, event: string, extra?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(extra ?? {})
  };
  // minimal PII: email only if necessary in extra
  console.log(JSON.stringify(payload));
}
