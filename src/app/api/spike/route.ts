/**
 * TEMPORARY FEASIBILITY SPIKE ENDPOINT
 * Answers: Can one Vercel serverless function fetch a public tweet's video and
 * convert it into a WhatsApp-compliant animated sticker using ffmpeg-static?
 *
 * DO NOT expose publicly: Protected by x-spike-secret header.
 */

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import { config } from "@/lib/config";
import { fetcher, FetcherError } from "@/lib/fetcher";
import {
  getFfmpegInfo,
  convertToWebPSticker,
  convertToWhatsAppGif,
} from "@/lib/converter";

export const runtime = "nodejs";
export const maxDuration = 60;

function checkAuth(req: NextRequest): boolean {
  const secret = config.SPIKE_SECRET;
  if (!secret) {
    return false;
  }
  const provided = req.headers.get("x-spike-secret");
  return provided === secret;
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const urlParam = req.nextUrl.searchParams.get("url");
  const isDownload = req.nextUrl.searchParams.get("download") === "sticker";

  if (!urlParam) {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_URL", message: "Missing 'url' search param" } },
      { status: 400 }
    );
  }

  return handlePipeline(urlParam, isDownload);
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const isDownload = req.nextUrl.searchParams.get("download") === "sticker";

  let body: { url?: string };
  try {
    body = (await req.json()) as { url?: string };
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_URL", message: "Invalid JSON body" } },
      { status: 400 }
    );
  }

  const url = body?.url;
  if (!url || typeof url !== "string") {
    return NextResponse.json(
      { ok: false, error: { code: "INVALID_URL", message: "Missing 'url' field in body" } },
      { status: 400 }
    );
  }

  return handlePipeline(url, isDownload);
}

async function handlePipeline(tweetUrl: string, isDownload: boolean) {
  const overallStart = Date.now();
  let downloadedFilePath: string | null = null;

  const stageTimings = {
    validate: 0,
    resolve: 0,
    download: 0,
    stickerEncode: 0,
    gifEncode: 0,
    total: 0,
  };

  try {
    // Stage 1: Validate URL
    const t0 = Date.now();
    fetcher.validateUrl(tweetUrl);
    stageTimings.validate = Date.now() - t0;

    // Stage 2: Resolve Tweet & Video URL
    const t1 = Date.now();
    const mediaInfo = await fetcher.resolveTweet(tweetUrl);
    stageTimings.resolve = Date.now() - t1;

    // Stage 3: Download Video
    const t2 = Date.now();
    const download = await fetcher.downloadVideo(mediaInfo.videoUrl);
    downloadedFilePath = download.filePath;
    stageTimings.download = Date.now() - t2;

    // Ffmpeg diagnostic info
    const ffmpegInfo = await getFfmpegInfo();

    // Stage 4: Sticker Conversion with size-fitting
    const t3 = Date.now();
    const stickerResult = await convertToWebPSticker(downloadedFilePath);
    stageTimings.stickerEncode = Date.now() - t3;

    // If download requested, stream raw sticker immediately
    if (isDownload) {
      return new NextResponse(new Uint8Array(stickerResult.stickerBuffer), {
        status: 200,
        headers: {
          "Content-Type": "image/webp",
          "Content-Disposition": 'inline; filename="sticker.webp"',
          "Cache-Control": "no-store",
        },
      });
    }

    // Stage 5: WhatsApp GIF (MP4) Conversion
    const t4 = Date.now();
    const gifResult = await convertToWhatsAppGif(downloadedFilePath);
    stageTimings.gifEncode = Date.now() - t4;

    stageTimings.total = Date.now() - overallStart;

    return NextResponse.json(
      {
        ok: true,
        stageTimingsMs: stageTimings,
        ffmpegVersion: ffmpegInfo.version,
        hasLibwebp: ffmpegInfo.hasLibwebp,
        attempts: stickerResult.attempts,
        finalStickerSizeBytes: stickerResult.stickerBuffer.length,
        webpValidation: stickerResult.validation,
        gifSizeBytes: gifResult.sizeBytes,
        vercelRegion: process.env.VERCEL_REGION || null,
        stickerBase64: stickerResult.stickerBuffer.toString("base64"),
      },
      {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } catch (err: unknown) {
    stageTimings.total = Date.now() - overallStart;

    let code = "UPSTREAM_UNKNOWN_ERROR";
    let message = "An unknown error occurred during processing";
    let httpStatus = 500;

    if (err instanceof FetcherError) {
      code = err.code;
      message = err.message;
      if (err.code === "INVALID_URL") httpStatus = 400;
      else if (err.code === "NOT_FOUND_OR_PRIVATE" || err.code === "NO_MEDIA") httpStatus = 404;
      else if (err.code === "VIDEO_TOO_LONG") httpStatus = 422;
      else if (err.code === "UPSTREAM_BLOCKED_OR_RATE_LIMITED") httpStatus = 502;
    } else if (err instanceof Error) {
      message = err.message;
    }

    return NextResponse.json(
      {
        ok: false,
        error: { code, message },
        stageTimingsMs: stageTimings,
      },
      {
        status: httpStatus,
        headers: {
          "Cache-Control": "no-store",
        },
      }
    );
  } finally {
    if (downloadedFilePath && fs.existsSync(/*turbopackIgnore: true*/ downloadedFilePath)) {
      try {
        fs.unlinkSync(/*turbopackIgnore: true*/ downloadedFilePath);
      } catch {}
    }
  }
}
