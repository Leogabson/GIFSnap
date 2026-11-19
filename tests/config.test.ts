import { describe, expect, it } from "vitest";
import { validateConfig } from "@/lib/config";

describe("Config validation", () => {
  it("passes with an empty environment", () => {
    const config = validateConfig({});
    expect(config.NODE_ENV).toBe("development");
    expect(config.BLOB_READ_WRITE_TOKEN).toBeUndefined();
    expect(config.UPSTASH_REDIS_REST_URL).toBeUndefined();
    expect(config.UPSTASH_REDIS_REST_TOKEN).toBeUndefined();
    expect(config.TURNSTILE_SITE_KEY).toBeUndefined();
    expect(config.TURNSTILE_SECRET_KEY).toBeUndefined();
    expect(config.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(config.TELEGRAM_WEBHOOK_SECRET).toBeUndefined();
    expect(config.CRON_SECRET).toBeUndefined();
  });

  it("passes when optional fields are empty strings (treating them as undefined)", () => {
    const config = validateConfig({
      UPSTASH_REDIS_REST_URL: "",
      BLOB_READ_WRITE_TOKEN: "   ",
    });
    expect(config.UPSTASH_REDIS_REST_URL).toBeUndefined();
    expect(config.BLOB_READ_WRITE_TOKEN).toBeUndefined();
  });

  it("fails when a malformed URL is provided for UPSTASH_REDIS_REST_URL", () => {
    expect(() =>
      validateConfig({
        UPSTASH_REDIS_REST_URL: "not-a-valid-url",
      })
    ).toThrow();
  });

  it("fails when an invalid NODE_ENV is provided", () => {
    expect(() =>
      validateConfig({
        NODE_ENV: "invalid_env" as unknown as string,
      })
    ).toThrow();
  });

  it("accepts valid values", () => {
    const config = validateConfig({
      NODE_ENV: "production",
      UPSTASH_REDIS_REST_URL: "https://redis.example.com",
      TELEGRAM_BOT_TOKEN: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    });
    expect(config.NODE_ENV).toBe("production");
    expect(config.UPSTASH_REDIS_REST_URL).toBe("https://redis.example.com");
    expect(config.TELEGRAM_BOT_TOKEN).toBe(
      "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
    );
  });
});
