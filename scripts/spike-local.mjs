#!/usr/bin/env node

/**
 * Local feasibility spike runner for GIFSnap.
 * Runs without HTTP against X's public syndication endpoint and ffmpeg-static.
 *
 * Usage:
 *   node scripts/spike-local.mjs <tweet-url>
 *   node scripts/spike-local.mjs --all
 */

import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import ffmpegPath from "ffmpeg-static";

const ALLOWED_TWEET_HOSTS = new Set([
  "twitter.com",
  "x.com",
  "www.twitter.com",
  "www.x.com",
]);

const ALLOWED_VIDEO_HOST = "video.twimg.com";
const MAX_VIDEO_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 25_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function generateSyndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, "");
}

export function validateTweetUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("INVALID_URL: Invalid URL format");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("INVALID_URL: Only HTTPS URLs are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_TWEET_HOSTS.has(hostname)) {
    throw new Error(
      `INVALID_URL: Invalid host ${hostname}. Only twitter.com and x.com are supported.`
    );
  }

  const match = /^\/(?:i|[a-zA-Z0-9_]+)\/status\/(\d+)/.exec(parsed.pathname);
  if (!match || !match[1]) {
    throw new Error(
      "INVALID_URL: Path must follow /<user>/status/<id> or /i/status/<id>"
    );
  }

  return match[1];
}

export async function resolveTweet(urlStr) {
  const tweetId = validateTweetUrl(urlStr);
  const token = generateSyndicationToken(tweetId);
  const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`;

  let response;
  try {
    response = await fetch(syndicationUrl, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`UPSTREAM_UNKNOWN_ERROR: ${err.message}`);
  }

  if (response.status === 404) {
    throw new Error("NOT_FOUND_OR_PRIVATE: Tweet not found or is private");
  }
  if (response.status === 429 || response.status === 403) {
    throw new Error(`UPSTREAM_BLOCKED_OR_RATE_LIMITED: Upstream returned ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`UPSTREAM_UNKNOWN_ERROR: Upstream returned ${response.status}`);
  }

  const data = await response.json();

  if (data.tombstone || (!data.text && !data.mediaDetails && !data.video)) {
    throw new Error("NOT_FOUND_OR_PRIVATE: Tweet not found or deleted");
  }

  const media = data.mediaDetails?.find(
    (m) => m.type === "animated_gif" || m.type === "video"
  );

  const isAnimatedGif =
    media?.type === "animated_gif" || data.video?.contentType === "gif";

  const variants = media?.video_info?.variants || data.video?.variants || [];
  const mp4Variants = variants.filter((v) => {
    const type = v.content_type || v.type;
    const url = v.url || v.src;
    return type === "video/mp4" && typeof url === "string";
  });

  if (mp4Variants.length === 0) {
    throw new Error("NO_MEDIA: No MP4 video or animated GIF found in tweet");
  }

  mp4Variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  const bestUrl = mp4Variants[0]?.url || mp4Variants[0]?.src;

  const parsedVideoUrl = new URL(bestUrl);
  if (parsedVideoUrl.hostname.toLowerCase() !== ALLOWED_VIDEO_HOST) {
    throw new Error(`UPSTREAM_UNKNOWN_ERROR: Disallowed video host ${parsedVideoUrl.hostname}`);
  }

  const durationMs =
    media?.video_info?.duration_millis ?? data.video?.durationMs ?? 0;

  if (durationMs > 60_000) {
    throw new Error(`VIDEO_TOO_LONG: Video duration (${Math.round(durationMs / 1000)}s) exceeds 60s`);
  }

  return {
    tweetId,
    videoUrl: bestUrl,
    durationMs,
    width: media?.original_info?.width || 512,
    height: media?.original_info?.height || 512,
    isAnimatedGif,
  };
}

export async function downloadVideo(videoUrl) {
  const parsedUrl = new URL(videoUrl);
  if (parsedUrl.hostname.toLowerCase() !== ALLOWED_VIDEO_HOST) {
    throw new Error(`UPSTREAM_UNKNOWN_ERROR: Disallowed host ${parsedUrl.hostname}`);
  }

  const res = await fetch(videoUrl, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!res.ok || !res.body) {
    throw new Error(`UPSTREAM_UNKNOWN_ERROR: Download failed with status ${res.status}`);
  }

  const tempFilePath = path.join(
    os.tmpdir(),
    `gifsnap-in-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`
  );

  const fileStream = fs.createWriteStream(tempFilePath);
  let downloadedBytes = 0;

  try {
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.on("data", (chunk) => {
      downloadedBytes += chunk.length;
      if (downloadedBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
        nodeStream.destroy(new Error("Video exceeds 25MB limit"));
      }
    });

    await pipeline(nodeStream, fileStream);

    return { filePath: tempFilePath, sizeBytes: downloadedBytes };
  } catch (err) {
    fileStream.close();
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
    throw err;
  }
}

export function validateWebP(buffer) {
  const sizeBytes = buffer.length;
  if (sizeBytes > 500 * 1024) {
    return { valid: false, error: `Exceeds 500KB limit (${sizeBytes} bytes)` };
  }
  if (sizeBytes < 30) {
    return { valid: false, error: "Too small for WebP header" };
  }

  const riff = buffer.toString("ascii", 0, 4);
  const webp = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || webp !== "WEBP") {
    return { valid: false, error: "Invalid RIFF/WEBP header" };
  }

  const firstChunk = buffer.toString("ascii", 12, 16);
  if (firstChunk !== "VP8X") {
    return { valid: false, error: `Expected VP8X, got ${firstChunk}` };
  }

  const flags = buffer[20] ?? 0;
  const isAnimated = (flags & 0x02) !== 0;

  const width = ((buffer[24] ?? 0) | ((buffer[25] ?? 0) << 8) | ((buffer[26] ?? 0) << 16)) + 1;
  const height = ((buffer[27] ?? 0) | ((buffer[28] ?? 0) << 8) | ((buffer[29] ?? 0) << 16)) + 1;

  let offset = 30;
  let hasAnimChunk = false;
  while (offset + 8 <= sizeBytes) {
    const chunkFourCC = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkFourCC === "ANIM") {
      hasAnimChunk = true;
      break;
    }
    const paddedSize = chunkSize + (chunkSize % 2);
    offset += 8 + paddedSize;
  }

  const valid = isAnimated && hasAnimChunk && width === 512 && height === 512 && sizeBytes <= 500 * 1024;
  return {
    valid,
    isAnimated,
    hasAnimChunk,
    width,
    height,
    sizeBytes,
    error: valid ? undefined : "Header criteria not met",
  };
}

export function runFfmpegCmd(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("ffmpeg timed out"));
    }, 35_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });
  });
}

const STICKER_PROFILES = [
  { q: 60, fps: 15 },
  { q: 40, fps: 10 },
  { q: 30, fps: 8 },
  { q: 20, fps: 8 },
];

export async function convertSticker(inputPath) {
  const attempts = [];
  const tempOut = path.join(os.tmpdir(), `test-sticker-${Date.now()}.webp`);

  try {
    let bestBuffer = null;
    let bestValidation = null;

    for (let i = 0; i < STICKER_PROFILES.length; i++) {
      const p = STICKER_PROFILES[i];
      const vf = `fps=${p.fps},scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=yuva420p`;

      const args = [
        "-y",
        "-t", "10",
        "-i", inputPath,
        "-vf", vf,
        "-c:v", "libwebp",
        "-loop", "0",
        "-lossless", "0",
        "-q:v", String(p.q),
        "-compression_level", "4",
        "-an",
        tempOut,
      ];

      await runFfmpegCmd(args);
      const buf = fs.readFileSync(tempOut);
      const val = validateWebP(buf);

      attempts.push({
        attempt: i + 1,
        q: p.q,
        fps: p.fps,
        sizeBytes: buf.length,
      });

      bestBuffer = buf;
      bestValidation = val;

      if (val.valid && buf.length <= 500 * 1024) {
        break;
      }
    }

    return { buffer: bestBuffer, validation: bestValidation, attempts };
  } finally {
    if (fs.existsSync(tempOut)) {
      try { fs.unlinkSync(tempOut); } catch {}
    }
  }
}

export async function convertGif(inputPath) {
  const tempOut = path.join(os.tmpdir(), `test-gif-${Date.now()}.mp4`);
  try {
    const vf = "scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p";
    const args = [
      "-y",
      "-t", "10",
      "-i", inputPath,
      "-vf", vf,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-an",
      "-movflags", "+faststart",
      tempOut,
    ];
    await runFfmpegCmd(args);
    const stat = fs.statSync(tempOut);
    return { sizeBytes: stat.size };
  } finally {
    if (fs.existsSync(tempOut)) {
      try { fs.unlinkSync(tempOut); } catch {}
    }
  }
}

export async function runSpike(tweetUrl, label = "") {
  console.log("\n=======================================================");
  console.log(`SPIKE TEST: ${label || tweetUrl}`);
  console.log(`URL: ${tweetUrl}`);
  console.log("=======================================================");

  const start = Date.now();
  let downloadedPath = null;

  try {
    const t0 = Date.now();
    const tweetId = validateTweetUrl(tweetUrl);
    const validateTime = Date.now() - t0;
    console.log(`[1] Validated: tweetId = ${tweetId} (${validateTime}ms)`);

    const t1 = Date.now();
    const mediaInfo = await resolveTweet(tweetUrl);
    const resolveTime = Date.now() - t1;
    console.log(
      `[2] Resolved (${resolveTime}ms):\n` +
      `    - isAnimatedGif: ${mediaInfo.isAnimatedGif}\n` +
      `    - durationMs: ${mediaInfo.durationMs}\n` +
      `    - dimensions: ${mediaInfo.width}x${mediaInfo.height}\n` +
      `    - videoUrl: ${mediaInfo.videoUrl}`
    );

    const t2 = Date.now();
    const download = await downloadVideo(mediaInfo.videoUrl);
    downloadedPath = download.filePath;
    const downloadTime = Date.now() - t2;
    console.log(`[3] Downloaded (${downloadTime}ms): ${(download.sizeBytes / 1024).toFixed(1)} KB`);

    const { stdout: vOut } = await runFfmpegCmd(["-version"]);
    const versionLine = vOut.split("\n")[0];
    const { stdout: encOut, stderr: encErr } = await runFfmpegCmd(["-hide_banner", "-encoders"]);
    const hasLibwebp = (encOut + encErr).includes("libwebp");
    console.log(`[4] FFmpeg: ${versionLine} | libwebp: ${hasLibwebp}`);

    const t3 = Date.now();
    const sticker = await convertSticker(downloadedPath);
    const stickerTime = Date.now() - t3;
    console.log(`[5] Sticker Encoded (${stickerTime}ms):`);
    for (const att of sticker.attempts) {
      console.log(`    - Attempt ${att.attempt} (q=${att.q}, fps=${att.fps}): ${(att.sizeBytes / 1024).toFixed(1)} KB`);
    }
    console.log(`    - WebP Validation:`, sticker.validation);

    const t4 = Date.now();
    const gif = await convertGif(downloadedPath);
    const gifTime = Date.now() - t4;
    console.log(`[6] WhatsApp GIF Encoded (${gifTime}ms): ${(gif.sizeBytes / 1024).toFixed(1)} KB`);

    const totalTime = Date.now() - start;
    console.log(`>>> TOTAL PIPELINE TIME: ${totalTime}ms | GO STATUS: YES`);

    return {
      ok: true,
      label,
      tweetUrl,
      timings: {
        validate: validateTime,
        resolve: resolveTime,
        download: downloadTime,
        sticker: stickerTime,
        gif: gifTime,
        total: totalTime,
      },
      stickerSize: sticker.buffer.length,
      stickerValid: sticker.validation.valid,
      gifSize: gif.sizeBytes,
    };
  } catch (err) {
    const totalTime = Date.now() - start;
    console.log(`>>> EXPECTED ERROR: ${err.message} (${totalTime}ms) Cause:`, err.cause);
    return {
      ok: false,
      label,
      tweetUrl,
      error: err.message,
      totalTime,
    };
  } finally {
    if (downloadedPath && fs.existsSync(downloadedPath)) {
      try { fs.unlinkSync(downloadedPath); } catch {}
    }
  }
}

const TEST_TWEETS = [
  { name: "ANIMATED GIF tweet", url: "https://x.com/i/status/2123355537987240105" },
  { name: "NORMAL VIDEO tweet", url: "https://x.com/honest30bgfan_/status/2123045579404071423?a=PPDwMZ3nVa6JdhLFsV4&s=20" },
  { name: "NO MEDIA tweet", url: "https://x.com/SirJarus/status/2123341824962056407?a=ShvnH3pzOK_YTHaqDvo&s=20" },
];

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--all") {
    console.log("Starting GIFSnap Feasibility Spike (All 3 Tweets)...");
    for (const t of TEST_TWEETS) {
      await runSpike(t.url, t.name);
    }
  } else {
    await runSpike(arg);
  }
}

main().catch(console.error);
