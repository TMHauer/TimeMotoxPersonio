export type Env = {
  PORT: number;
  SHADOW_MODE: boolean;
  ALLOW_INVALID_SIGNATURE: boolean;

  TIMEMOTO_WEBHOOK_SECRET: string;

  PERSONIO_BASE_URL: string;
  PERSONIO_CLIENT_ID: string;
  PERSONIO_CLIENT_SECRET: string;

  REDIS_URL: string;

  ADMIN_TOKEN: string;
  PERSONIO_SKIP_APPROVAL: boolean;
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v == null) return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function loadEnv(): Env {
  return {
    PORT: Number(process.env.PORT ?? "10000"),
    SHADOW_MODE: bool("SHADOW_MODE", true),
    ALLOW_INVALID_SIGNATURE: bool("ALLOW_INVALID_SIGNATURE", false),

    TIMEMOTO_WEBHOOK_SECRET: must("TIMEMOTO_WEBHOOK_SECRET"),

    PERSONIO_BASE_URL: process.env.PERSONIO_BASE_URL ?? "https://api.personio.de",
    PERSONIO_CLIENT_ID: must("PERSONIO_CLIENT_ID"),
    PERSONIO_CLIENT_SECRET: must("PERSONIO_CLIENT_SECRET"),

    REDIS_URL: must("REDIS_URL"),

    ADMIN_TOKEN: must("ADMIN_TOKEN"),
    PERSONIO_SKIP_APPROVAL: bool("PERSONIO_SKIP_APPROVAL", true)
  };
}
