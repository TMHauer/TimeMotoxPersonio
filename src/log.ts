export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, event: string, data: Record<string, unknown> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}
