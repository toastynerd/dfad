import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("0.0.0.0"),
  APPS_BASE_URL: z.string().url().default("http://localhost:3000"),
  TTL_HOURS: z.coerce.number().positive().default(24),
  MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  IP_HASH_SALT: z.string().default("change-me"),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW: z.string().default("10 minutes"),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  // Allowed browser origin for direct-to-S3 uploads (the UI host). "*" in dev.
  UPLOAD_CORS_ORIGIN: z.string().default("*"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  LOCAL_DATA_DIR: z.string().default("./.data"),
  AWS_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("dfad-apps"),
  DYNAMODB_TABLE: z.string().default("dfad-deployments"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  /** TTL in seconds, derived from TTL_HOURS (supports fractional hours for tests). */
  ttlSeconds: Math.max(1, Math.round(parsed.data.TTL_HOURS * 3600)),
};

export type Config = typeof config;
