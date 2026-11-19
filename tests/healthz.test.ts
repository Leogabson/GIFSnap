import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/healthz/route";

describe("GET /api/healthz", () => {
  it("returns 200 with expected JSON shape and Cache-Control: no-store", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const data = await response.json();

    expect(data).toHaveProperty("status", "ok");
    expect(data).toHaveProperty("time");
    expect(typeof data.time).toBe("string");
    expect(Number.isNaN(Date.parse(data.time))).toBe(false);
    expect(data).toHaveProperty("commit");
    expect(typeof data.commit).toBe("string");
  });
});
