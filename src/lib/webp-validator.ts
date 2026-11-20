export interface WebPValidationResult {
  valid: boolean;
  isAnimated: boolean;
  width: number;
  height: number;
  sizeBytes: number;
  hasVp8x: boolean;
  hasAnimChunk: boolean;
  error?: string;
}

export const MAX_STICKER_SIZE_BYTES = 500 * 1024; // 500 KB (512,000 bytes)
export const REQUIRED_STICKER_WIDTH = 512;
export const REQUIRED_STICKER_HEIGHT = 512;

export function validateWebPSticker(buffer: Buffer): WebPValidationResult {
  const sizeBytes = buffer.length;

  if (sizeBytes > MAX_STICKER_SIZE_BYTES) {
    return {
      valid: false,
      isAnimated: false,
      width: 0,
      height: 0,
      sizeBytes,
      hasVp8x: false,
      hasAnimChunk: false,
      error: `File size ${sizeBytes} bytes exceeds maximum WhatsApp sticker size of ${MAX_STICKER_SIZE_BYTES} bytes`,
    };
  }

  if (sizeBytes < 30) {
    return {
      valid: false,
      isAnimated: false,
      width: 0,
      height: 0,
      sizeBytes,
      hasVp8x: false,
      hasAnimChunk: false,
      error: "Buffer too small to contain valid WebP header",
    };
  }

  const riff = buffer.toString("ascii", 0, 4);
  const webp = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || webp !== "WEBP") {
    return {
      valid: false,
      isAnimated: false,
      width: 0,
      height: 0,
      sizeBytes,
      hasVp8x: false,
      hasAnimChunk: false,
      error: "Missing RIFF/WEBP signature",
    };
  }

  const firstChunk = buffer.toString("ascii", 12, 16);
  if (firstChunk !== "VP8X") {
    return {
      valid: false,
      isAnimated: false,
      width: 0,
      height: 0,
      sizeBytes,
      hasVp8x: false,
      hasAnimChunk: false,
      error: `Expected VP8X extended WebP header, found ${firstChunk}`,
    };
  }

  const flags = buffer[20] ?? 0;
  const isAnimated = (flags & 0x02) !== 0;

  // 24-bit canvas dimensions: 1-based (stored as value - 1)
  const widthMinusOne =
    (buffer[24] ?? 0) | ((buffer[25] ?? 0) << 8) | ((buffer[26] ?? 0) << 16);
  const heightMinusOne =
    (buffer[27] ?? 0) | ((buffer[28] ?? 0) << 8) | ((buffer[29] ?? 0) << 16);

  const width = widthMinusOne + 1;
  const height = heightMinusOne + 1;

  // Scan chunks after VP8X for ANIM chunk
  let offset = 30; // 12 + 4 (VP8X) + 4 (size=10) + 10 (payload)
  let hasAnimChunk = false;

  while (offset + 8 <= sizeBytes) {
    const chunkFourCC = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkFourCC === "ANIM") {
      hasAnimChunk = true;
      break;
    }
    // Chunks are padded to even length
    const paddedSize = chunkSize + (chunkSize % 2);
    offset += 8 + paddedSize;
  }

  const valid =
    isAnimated &&
    hasAnimChunk &&
    width === REQUIRED_STICKER_WIDTH &&
    height === REQUIRED_STICKER_HEIGHT &&
    sizeBytes <= MAX_STICKER_SIZE_BYTES;

  let error: string | undefined;
  if (!isAnimated) {
    error = "VP8X animation flag is not set";
  } else if (!hasAnimChunk) {
    error = "Missing required ANIM chunk in WebP container";
  } else if (width !== REQUIRED_STICKER_WIDTH || height !== REQUIRED_STICKER_HEIGHT) {
    error = `Canvas dimensions ${width}x${height} do not match required 512x512`;
  }

  return {
    valid,
    isAnimated,
    width,
    height,
    sizeBytes,
    hasVp8x: true,
    hasAnimChunk,
    error,
  };
}
