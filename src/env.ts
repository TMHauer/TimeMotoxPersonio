export type Env = {
  PORT: number;
  SHADOW_MODE: boolean;
  ALLOW_INVALID_SIGNATURE: boolean;

  // NEW: auth via URL path token
  WEBHOOK_PATH_TOKEN: string;

  ADMIN_TOKEN: string;
  TIMEMOTO_WEBHOOK_SECRET: string;

  PERSONIO_CLIENT_ID: string;
  PERSONIO_CLIENT_SECRET: string;

  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
};

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function opt(name: string, def: string): string {
  return process.env[name] ?? def;
}

function bool(v: string): boolean {
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

export function loadEnv(): Env {
  return {
    PORT: Number(opt("PORT", "10000")),
    SHADOW_MODE: bool(opt("SHADOW_MODE", "true")),
    ALLOW_INVALID_SIGNATURE: bool(opt("ALLOW_INVALID_SIGNATURE", "false")),

    WEBHOOK_PATH_TOKEN: req("WEBHOOK_PATH_TOKEN"),

    ADMIN_TOKEN: req("ADMIN_TOKEN"),
    TIMEMOTO_WEBHOOK_SECRET: req("TIMEMOTO_WEBHOOK_SECRET"),

    PERSONIO_CLIENT_ID: req("PERSONIO_CLIENT_ID"),
    PERSONIO_CLIENT_SECRET: req("PERSONIO_CLIENT_SECRET"),

    UPSTASH_REDIS_REST_URL: req("UPSTASH_REDIS_REST_URL"),
    UPSTASH_REDIS_REST_TOKEN: req("UPSTASH_REDIS_REST_TOKEN")
  };
}
