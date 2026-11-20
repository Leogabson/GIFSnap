import { describe, expect, it } from "vitest";
import {
  fetcher,
  FetcherError,
  generateSyndicationToken,
} from "@/lib/fetcher";
import {
  validateWebPSticker,
  MAX_STICKER_SIZE_BYTES,
  REQUIRED_STICKER_WIDTH,
  REQUIRED_STICKER_HEIGHT,
} from "@/lib/webp-validator";

/**
 * Helper to construct a synthetic WebP RIFF buffer for testing the parser
 */
function buildSyntheticWebP({
  width = 512,
  height = 512,
  isAnimated = true,
  hasAnimChunk = true,
  totalSize = 500,
  validRiff = true,
  hasVp8x = true,
}: {
  width?: number;
  height?: number;
  isAnimated?: boolean;
  hasAnimChunk?: boolean;
  totalSize?: number;
  validRiff?: boolean;
  hasVp8x?: boolean;
} = {}): Buffer {
  const buf = Buffer.alloc(Math.max(totalSize, 40));

  if (validRiff) {
    buf.write("RIFF", 0, 4, "ascii");
    buf.writeUInt32LE(buf.length - 8, 4);
    buf.write("WEBP", 8, 4, "ascii");
  }

  if (hasVp8x) {
    buf.write("VP8X", 12, 4, "ascii");
    buf.writeUInt32LE(10, 16); // VP8X chunk payload size is 10 bytes

    // Flags byte at offset 20: bit 1 is Animation flag (0x02)
    buf[20] = isAnimated ? 0x02 : 0x00;

    // 24-bit canvas dimensions stored as 1-based (value - 1)
    const wMinus1 = width - 1;
    const hMinus1 = height - 1;
    buf[24] = wMinus1 & 0xff;
    buf[25] = (wMinus1 >> 8) & 0xff;
    buf[26] = (wMinus1 >> 16) & 0xff;

    buf[27] = hMinus1 & 0xff;
    buf[28] = (hMinus1 >> 8) & 0xff;
    buf[29] = (hMinus1 >> 16) & 0xff;

    if (hasAnimChunk) {
      // Write ANIM chunk at offset 30
      buf.write("ANIM", 30, 4, "ascii");
      buf.writeUInt32LE(6, 34); // payload size 6 bytes
      // Background color and loop count in ANIM payload
    }
  }

  return buf;
}

describe("Twitter URL Validation", () => {
  it("extracts tweet ID from valid twitter.com URL", () => {
    const id = fetcher.validateUrl("https://twitter.com/jack/status/20");
    expect(id).toBe("20");
  });

  it("extracts tweet ID from valid x.com URL", () => {
    const id = fetcher.validateUrl(
      "https://x.com/honest30bgfan_/status/2123045579404071423"
    );
    expect(id).toBe("2123045579404071423");
  });

  it("extracts tweet ID from /i/status/<id> URL", () => {
    const id = fetcher.validateUrl(
      "https://x.com/i/status/2123355537987240105"
    );
    expect(id).toBe("2123355537987240105");
  });

  it("extracts tweet ID from www.twitter.com and www.x.com", () => {
    expect(
      fetcher.validateUrl("https://www.twitter.com/foo/status/987654321")
    ).toBe("987654321");
    expect(
      fetcher.validateUrl("https://www.x.com/foo/status/987654321")
    ).toBe("987654321");
  });

  it("ignores query params and hash fragments", () => {
    const id = fetcher.validateUrl(
      "https://x.com/user/status/123456789?ref_src=twsrc&s=20#top"
    );
    expect(id).toBe("123456789");
  });

  it("rejects non-HTTPS URLs", () => {
    expect(() =>
      fetcher.validateUrl("http://x.com/user/status/123456789")
    ).toThrowError(FetcherError);

    try {
      fetcher.validateUrl("http://x.com/user/status/123456789");
    } catch (e) {
      expect((e as FetcherError).code).toBe("INVALID_URL");
    }
  });

  it("rejects lookalike hosts and malicious domains", () => {
    const invalidHosts = [
      "https://twitter.com.attacker.com/user/status/123456",
      "https://x.com.evil.org/user/status/123456",
      "https://notx.com/user/status/123456",
      "https://faketwitter.com/user/status/123456",
      "https://sub.twitter.com/user/status/123456",
    ];

    for (const url of invalidHosts) {
      expect(() => fetcher.validateUrl(url)).toThrowError(FetcherError);
    }
  });

  it("rejects non-status paths", () => {
    const invalidPaths = [
      "https://x.com/home",
      "https://x.com/user",
      "https://x.com/user/status",
      "https://x.com/user/status/notdigits",
      "https://x.com/user/likes",
    ];

    for (const url of invalidPaths) {
      expect(() => fetcher.validateUrl(url)).toThrowError(FetcherError);
    }
  });

  it("generates deterministic syndication token without dots or leading zeros", () => {
    const token = generateSyndicationToken("2123355537987240105");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(token).not.toContain(".");
    expect(token.startsWith("0")).toBe(false);
  });
});

describe("WebP RIFF Validator", () => {
  it("validates a compliant 512x512 animated WebP under 500 KB", () => {
    const buf = buildSyntheticWebP({
      width: REQUIRED_STICKER_WIDTH,
      height: REQUIRED_STICKER_HEIGHT,
      isAnimated: true,
      hasAnimChunk: true,
      totalSize: 10_000,
    });

    const result = validateWebPSticker(buf);
    expect(result.valid).toBe(true);
    expect(result.isAnimated).toBe(true);
    expect(result.hasAnimChunk).toBe(true);
    expect(result.width).toBe(512);
    expect(result.height).toBe(512);
    expect(result.error).toBeUndefined();
  });

  it("rejects WebP exceeding 500 KB", () => {
    const bigBuf = buildSyntheticWebP({
      width: 512,
      height: 512,
      isAnimated: true,
      hasAnimChunk: true,
      totalSize: MAX_STICKER_SIZE_BYTES + 1024,
    });

    const result = validateWebPSticker(bigBuf);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("exceeds maximum WhatsApp sticker size");
  });

  it("rejects non-animated WebP (animation flag not set)", () => {
    const staticBuf = buildSyntheticWebP({
      width: 512,
      height: 512,
      isAnimated: false,
      hasAnimChunk: true,
    });

    const result = validateWebPSticker(staticBuf);
    expect(result.valid).toBe(false);
    expect(result.isAnimated).toBe(false);
    expect(result.error).toContain("animation flag is not set");
  });

  it("rejects animated WebP missing ANIM chunk", () => {
    const noAnimBuf = buildSyntheticWebP({
      width: 512,
      height: 512,
      isAnimated: true,
      hasAnimChunk: false,
    });

    const result = validateWebPSticker(noAnimBuf);
    expect(result.valid).toBe(false);
    expect(result.hasAnimChunk).toBe(false);
    expect(result.error).toContain("Missing required ANIM chunk");
  });

  it("rejects non-512x512 dimensions", () => {
    const badDimsBuf = buildSyntheticWebP({
      width: 256,
      height: 512,
      isAnimated: true,
      hasAnimChunk: true,
    });

    const result = validateWebPSticker(badDimsBuf);
    expect(result.valid).toBe(false);
    expect(result.width).toBe(256);
    expect(result.height).toBe(512);
    expect(result.error).toContain("256x512 do not match required 512x512");
  });

  it("rejects corrupt or non-RIFF/WEBP buffers", () => {
    const badSigBuf = buildSyntheticWebP({
      validRiff: false,
    });

    const result = validateWebPSticker(badSigBuf);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Missing RIFF/WEBP signature");
  });

  it("rejects tiny buffers smaller than header", () => {
    const tinyBuf = Buffer.from("RIFF");
    const result = validateWebPSticker(tinyBuf);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Buffer too small");
  });
});
