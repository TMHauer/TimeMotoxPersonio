export type Env = {
  PORT: number;
  ADMIN_TOKEN: string;
  SHADOW_MODE: boolean;

  TIMEMOTO_WEBHOOK_SECRET: string;

  PERSONIO_CLIENT_ID: string;
  PERSONIO_CLIENT_SECRET: string;

  UPSTASH_REDIS_REST_URL: string;
  UPSTASH_REDIS_REST_TOKEN: string;
};

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export function loadEnv(): Env {
  return {
    PORT: Number(process.env.PORT ?? "3000"),
    ADMIN_TOKEN: must("ADMIN_TOKEN"),
    SHADOW_MODE: (process.env.SHADOW_MODE ?? "true").toLowerCase() === "true",

    TIMEMOTO_WEBHOOK_SECRET: must("TIMEMOTO_WEBHOOK_SECRET"),

    PERSONIO_CLIENT_ID: must("PERSONIO_CLIENT_ID"),
    PERSONIO_CLIENT_SECRET: must("PERSONIO_CLIENT_SECRET"),

    UPSTASH_REDIS_REST_URL: must("UPSTASH_REDIS_REST_URL"),
    UPSTASH_REDIS_REST_TOKEN: must("UPSTASH_REDIS_REST_TOKEN")
  };
}
