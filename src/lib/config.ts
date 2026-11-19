import { z } from "zod";

const emptyStringToUndefined = (val: unknown) =>
  typeof val === "string" && val.trim() === "" ? undefined : val;

export const configSchema = z.object({
  NODE_ENV: z
    .preprocess(
      emptyStringToUndefined,
      z.enum(["development", "production", "test"]).optional()
    )
    .default("development"),
  VERCEL_GIT_COMMIT_SHA: z.preprocess(
    emptyStringToUndefined,
    z.string().optional()
  ),
  BLOB_READ_WRITE_TOKEN: z.preprocess(
    emptyStringToUndefined,
    z.string().min(1).optional()
  ),
  UPSTASH_REDIS_REST_URL: z.preprocess(
    emptyStringToUndefined,
    z.string().url().optional()
  ),
  UPSTASH_REDIS_REST_TOKEN: z.preprocess(
    emptyStringToUndefined,
    z.string().min(1).optional()
  ),
  TURNSTILE_SITE_KEY: z.preprocess(
    emptyStringToUndefined,
    z.string().min(1).optional()
  ),
  TURNSTILE_SECRET_KEY: z.preprocess(
    emptyStringToUndefined,
    z.string().min(1).optional()
  ),
  TELEGRAM_BOT_TOKEN: z.preprocess(
    emptyStringToUndefined,
    z.string().min(1).optional()
  ),
  TELEGRAM_WEBHOOK_SECRET: z.preprocess(
    emptyStringToUndefined,
    z.string().min(1).optional()
  ),
  CRON_SECRET: z.preprocess(
    emptyStringToUndefined,
    z.string().min(1).optional()
  ),
});

export type Config = z.infer<typeof configSchema>;

export function validateConfig(
  env: Record<string, string | undefined> = process.env
): Config {
  return configSchema.parse(env);
}

export const config: Config = validateConfig();
