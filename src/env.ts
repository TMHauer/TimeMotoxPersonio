export type Env = {
  PORT: number;

  REDIS_URL: string;

  // TimeMoto
  TIMEMOTO_WEBHOOK_SECRET: string;
  ALLOW_INVALID_SIGNATURE: boolean;
  WEBHOOK_PATH_TOKEN?: string;

  // Personio
  PERSONIO_CLIENT_ID: string;
  PERSONIO_CLIENT_SECRET: string;
  PERSONIO_BASE_URL: string; // default https://api.personio.de
  PERSONIO_BETA_HEADER: boolean; // add Beta:true on v2 calls
  PERSONIO_SKIP_APPROVAL: boolean;

  // Ops
  SHADOW_MODE: boolean;
  ADMIN_TOKEN: string;
};

function must(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`Missing env var: ${name}`);
  return v.trim();
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadEnv(): Env {
  return {
    PORT: Number(process.env.PORT ?? "10000"),

    REDIS_URL: must("REDIS_URL"),

    TIMEMOTO_WEBHOOK_SECRET: must("TIMEMOTO_WEBHOOK_SECRET"),
    ALLOW_INVALID_SIGNATURE: bool("ALLOW_INVALID_SIGNATURE", false),
    WEBHOOK_PATH_TOKEN: process.env.WEBHOOK_PATH_TOKEN?.trim() || undefined,

    PERSONIO_CLIENT_ID: must("PERSONIO_CLIENT_ID"),
    PERSONIO_CLIENT_SECRET: must("PERSONIO_CLIENT_SECRET"),
    PERSONIO_BASE_URL: (process.env.PERSONIO_BASE_URL ?? "https://api.personio.de").trim(),
    PERSONIO_BETA_HEADER: bool("PERSONIO_BETA_HEADER", true),
    PERSONIO_SKIP_APPROVAL: bool("PERSONIO_SKIP_APPROVAL", true),

    SHADOW_MODE: bool("SHADOW_MODE", true),
    ADMIN_TOKEN: must("ADMIN_TOKEN")
  };
}
