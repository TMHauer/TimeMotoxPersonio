export type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, event: string, data: Record<string, any> = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...data
  };
  // Render picks up stdout
  console.log(JSON.stringify(line));
}
