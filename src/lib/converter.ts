import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import {
  validateWebPSticker,
  WebPValidationResult,
  MAX_STICKER_SIZE_BYTES,
} from "./webp-validator";

export interface EncodeAttempt {
  attempt: number;
  q: number;
  fps: number;
  sizeBytes: number;
}

export interface StickerConversionResult {
  stickerBuffer: Buffer;
  attempts: EncodeAttempt[];
  validation: WebPValidationResult;
  durationMs: number;
}

export interface GifConversionResult {
  sizeBytes: number;
  durationMs: number;
}

export interface FfmpegInfo {
  version: string;
  hasLibwebp: boolean;
}

let cachedFfmpegPath: string | null = null;

export function getFfmpegBinary(): string {
  if (cachedFfmpegPath && fs.existsSync(/*turbopackIgnore: true*/ cachedFfmpegPath)) {
    return cachedFfmpegPath;
  }

  const rawPath = ffmpegPath as unknown as string;
  if (!rawPath) {
    throw new Error("ffmpeg-static did not resolve a valid binary path");
  }

  // On Linux/Vercel serverless functions, the bundled binary may lack execute permissions.
  // We copy it to /tmp and chmod 755 if needed.
  if (process.platform === "linux") {
    const tmpBinary = path.join("/tmp", "ffmpeg");
    try {
      if (!fs.existsSync(/*turbopackIgnore: true*/ tmpBinary)) {
        fs.copyFileSync(rawPath, tmpBinary);
        fs.chmodSync(tmpBinary, 0o755);
      }
      cachedFfmpegPath = tmpBinary;
      return tmpBinary;
    } catch {
      // Fallback to rawPath if /tmp copy fails
    }
  }

  cachedFfmpegPath = rawPath;
  return rawPath;
}

export function runFfmpeg(
  args: string[],
  timeoutMs = 30_000
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const binary = getFfmpegBinary();
    const proc = spawn(/*turbopackIgnore: true*/ binary, args, {
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
      reject(new Error(`ffmpeg execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });

    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) {
        resolve({ stdout, stderr, exitCode: code });
      } else {
        reject(
          new Error(
            `ffmpeg process exited with code ${code}. Stderr: ${stderr.slice(-500)}`
          )
        );
      }
    });
  });
}

export async function getFfmpegInfo(): Promise<FfmpegInfo> {
  const { stdout: versionOut, stderr: versionErr } = await runFfmpeg(
    ["-version"],
    5000
  );
  const versionLine = (versionOut || versionErr).split("\n")[0] || "unknown";

  const { stdout: encodersOut, stderr: encodersErr } = await runFfmpeg(
    ["-hide_banner", "-encoders"],
    5000
  );
  const encodersText = encodersOut + encodersErr;
  const hasLibwebp = encodersText.includes("libwebp");

  return {
    version: versionLine.trim(),
    hasLibwebp,
  };
}

// Tuned compression_level=4 for fast, efficient WebP encoding within Vercel's CPU budget
const COMPRESSION_LEVEL = "4";

export const STICKER_ATTEMPT_PROFILES = [
  { q: 60, fps: 15 },
  { q: 40, fps: 10 },
  { q: 30, fps: 8 },
  { q: 20, fps: 8 },
];

export async function convertToWebPSticker(
  inputVideoPath: string
): Promise<StickerConversionResult> {
  const startTime = Date.now();
  const attempts: EncodeAttempt[] = [];
  const tempOutPath = path.join(
    os.tmpdir(),
    `gifsnap-sticker-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.webp`
  );

  let bestBuffer: Buffer | null = null;
  let bestValidation: WebPValidationResult | null = null;

  try {
    for (let i = 0; i < STICKER_ATTEMPT_PROFILES.length; i++) {
      const profile = STICKER_ATTEMPT_PROFILES[i];
      if (!profile) break;
      const attemptNum = i + 1;

      const filterGraph = `fps=${profile.fps},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`;

      const args = [
        "-y",
        "-t", "10",
        "-i", inputVideoPath,
        "-vf", filterGraph,
        "-c:v", "libwebp",
        "-loop", "0",
        "-lossless", "0",
        "-q:v", String(profile.q),
        "-compression_level", COMPRESSION_LEVEL,
        "-an",
        tempOutPath,
      ];

      await runFfmpeg(args, 25_000);

      const buffer = fs.readFileSync(tempOutPath);
      const sizeBytes = buffer.length;
      attempts.push({
        attempt: attemptNum,
        q: profile.q,
        fps: profile.fps,
        sizeBytes,
      });

      const validation = validateWebPSticker(buffer);

      if (validation.valid && sizeBytes <= MAX_STICKER_SIZE_BYTES) {
        bestBuffer = buffer;
        bestValidation = validation;
        break; // Within target WhatsApp sticker budget!
      }

      // If over size, save current buffer as fallback and continue next profile attempt
      bestBuffer = buffer;
      bestValidation = validation;
    }

    if (!bestBuffer || !bestValidation) {
      throw new Error("No sticker was produced during ffmpeg encoding attempts");
    }

    return {
      stickerBuffer: bestBuffer,
      attempts,
      validation: bestValidation,
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (fs.existsSync(tempOutPath)) {
      try {
        fs.unlinkSync(tempOutPath);
      } catch {}
    }
  }
}

export async function convertToWhatsAppGif(
  inputVideoPath: string
): Promise<GifConversionResult> {
  const startTime = Date.now();
  const tempOutPath = path.join(
    os.tmpdir(),
    `gifsnap-gif-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`
  );

  try {
    const filterGraph =
      "scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p";

    const args = [
      "-y",
      "-t", "10",
      "-i", inputVideoPath,
      "-vf", filterGraph,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-an",
      "-movflags", "+faststart",
      tempOutPath,
    ];

    await runFfmpeg(args, 25_000);

    const stat = fs.statSync(tempOutPath);

    return {
      sizeBytes: stat.size,
      durationMs: Date.now() - startTime,
    };
  } finally {
    if (fs.existsSync(tempOutPath)) {
      try {
        fs.unlinkSync(tempOutPath);
      } catch {}
    }
  }
}
