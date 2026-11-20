import dns from "node:dns";
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type FetcherErrorCode =
  | "INVALID_URL"
  | "NOT_FOUND_OR_PRIVATE"
  | "NO_MEDIA"
  | "VIDEO_TOO_LONG"
  | "UPSTREAM_BLOCKED_OR_RATE_LIMITED"
  | "UPSTREAM_UNKNOWN_ERROR";

export class FetcherError extends Error {
  readonly code: FetcherErrorCode;
  readonly status?: number;

  constructor(
    code: FetcherErrorCode,
    message: string,
    status?: number
  ) {
    super(message);
    this.name = "FetcherError";
    this.code = code;
    this.status = status;
  }
}

export interface TweetMediaInfo {
  tweetId: string;
  videoUrl: string;
  durationMs: number;
  width: number;
  height: number;
  isAnimatedGif: boolean;
}

export interface DownloadResult {
  filePath: string;
  sizeBytes: number;
}

export interface Fetcher {
  validateUrl(urlStr: string): string;
  resolveTweet(urlStr: string): Promise<TweetMediaInfo>;
  downloadVideo(videoUrl: string): Promise<DownloadResult>;
}

const ALLOWED_TWEET_HOSTS = new Set([
  "twitter.com",
  "x.com",
  "www.twitter.com",
  "www.x.com",
]);

const ALLOWED_VIDEO_HOST = "video.twimg.com";
const MAX_VIDEO_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_TIMEOUT_MS = 10_000; // 10 s for metadata requests
const DOWNLOAD_TIMEOUT_MS = 25_000; // 25 s for downloading up to 25 MB payload
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export function generateSyndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2)
    .replace(/(0+|\.)/g, "");
}

interface SyndicationVariant {
  bitrate?: number;
  content_type?: string;
  type?: string;
  url?: string;
  src?: string;
}

interface SyndicationMediaDetail {
  type?: string;
  original_info?: {
    width?: number;
    height?: number;
  };
  video_info?: {
    duration_millis?: number;
    variants?: SyndicationVariant[];
  };
}

interface SyndicationResponse {
  __typename?: string;
  text?: string;
  mediaDetails?: SyndicationMediaDetail[];
  video?: {
    contentType?: string;
    durationMs?: number;
    variants?: SyndicationVariant[];
    aspectRatio?: [number, number];
  };
  tombstone?: unknown;
}

export class TwitterSyndicationFetcher implements Fetcher {
  validateUrl(urlStr: string): string {
    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      throw new FetcherError("INVALID_URL", "Invalid URL format");
    }

    if (parsed.protocol !== "https:") {
      throw new FetcherError("INVALID_URL", "Only HTTPS URLs are allowed");
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!ALLOWED_TWEET_HOSTS.has(hostname)) {
      throw new FetcherError(
        "INVALID_URL",
        `Invalid host: ${hostname}. Only twitter.com and x.com are supported.`
      );
    }

    const match = /^\/(?:i|[a-zA-Z0-9_]+)\/status\/(\d+)/.exec(parsed.pathname);
    if (!match || !match[1]) {
      throw new FetcherError(
        "INVALID_URL",
        "Path must follow /<user>/status/<id> or /i/status/<id>"
      );
    }

    return match[1];
  }

  async resolveTweet(urlStr: string): Promise<TweetMediaInfo> {
    const tweetId = this.validateUrl(urlStr);
    const token = generateSyndicationToken(tweetId);
    const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`;

    let response: Response;
    try {
      response = await fetch(syndicationUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new FetcherError(
          "UPSTREAM_UNKNOWN_ERROR",
          "Request to Twitter syndication timed out"
        );
      }
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Failed to reach Twitter syndication: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (response.status === 404) {
      throw new FetcherError(
        "NOT_FOUND_OR_PRIVATE",
        "Tweet not found or is private",
        404
      );
    }

    if (response.status === 429 || response.status === 403) {
      throw new FetcherError(
        "UPSTREAM_BLOCKED_OR_RATE_LIMITED",
        `Upstream syndication returned status ${response.status}`,
        response.status
      );
    }

    if (!response.ok) {
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Upstream syndication returned unexpected status: ${response.status}`,
        response.status
      );
    }

    let data: SyndicationResponse;
    try {
      data = (await response.json()) as SyndicationResponse;
    } catch (err: unknown) {
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Failed to parse syndication JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (data.tombstone || (!data.text && !data.mediaDetails && !data.video)) {
      throw new FetcherError(
        "NOT_FOUND_OR_PRIVATE",
        "Tweet not found or is deleted/private"
      );
    }

    const media = data.mediaDetails?.find(
      (m) => m.type === "animated_gif" || m.type === "video"
    );

    const isAnimatedGif =
      media?.type === "animated_gif" || data.video?.contentType === "gif";

    const variants: SyndicationVariant[] =
      media?.video_info?.variants || data.video?.variants || [];

    const mp4Variants = variants.filter((v) => {
      const type = v.content_type || v.type;
      const url = v.url || v.src;
      return type === "video/mp4" && typeof url === "string";
    });

    if (mp4Variants.length === 0) {
      throw new FetcherError(
        "NO_MEDIA",
        "No MP4 video or animated GIF found in this tweet"
      );
    }

    mp4Variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    const bestVariant = mp4Variants[0];
    const bestUrl = bestVariant?.url || bestVariant?.src;

    if (!bestUrl) {
      throw new FetcherError("NO_MEDIA", "No downloadable video variant found");
    }

    let parsedVideoUrl: URL;
    try {
      parsedVideoUrl = new URL(bestUrl);
    } catch {
      throw new FetcherError("UPSTREAM_UNKNOWN_ERROR", "Invalid video URL returned");
    }

    if (parsedVideoUrl.hostname.toLowerCase() !== ALLOWED_VIDEO_HOST) {
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Disallowed video host: ${parsedVideoUrl.hostname}`
      );
    }

    const durationMs =
      media?.video_info?.duration_millis ?? data.video?.durationMs ?? 0;

    if (durationMs > 60_000) {
      throw new FetcherError(
        "VIDEO_TOO_LONG",
        `Video duration (${Math.round(durationMs / 1000)}s) exceeds 60s limit`
      );
    }

    const width = media?.original_info?.width || 512;
    const height = media?.original_info?.height || 512;

    return {
      tweetId,
      videoUrl: bestUrl,
      durationMs,
      width,
      height,
      isAnimatedGif,
    };
  }

  async downloadVideo(videoUrl: string): Promise<DownloadResult> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(videoUrl);
    } catch {
      throw new FetcherError("INVALID_URL", "Invalid video URL");
    }

    if (parsedUrl.hostname.toLowerCase() !== ALLOWED_VIDEO_HOST) {
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Download host ${parsedUrl.hostname} is not allowed`
      );
    }

    let res: Response;
    try {
      res = await fetch(videoUrl, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new FetcherError(
          "UPSTREAM_UNKNOWN_ERROR",
          "Video download timed out"
        );
      }
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Failed to start video download: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!res.ok || !res.body) {
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Video download failed with HTTP status ${res.status}`
      );
    }

    const contentLength = Number(res.headers.get("content-length") || "0");
    if (contentLength > MAX_VIDEO_DOWNLOAD_BYTES) {
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Video exceeds maximum allowed size of 25MB (size: ${contentLength} bytes)`
      );
    }

    const tempFilePath = path.join(
      os.tmpdir(),
      `gifsnap-in-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`
    );

    const fileStream = fs.createWriteStream(tempFilePath);
    let downloadedBytes = 0;

    try {
      const nodeStream = Readable.fromWeb(
        res.body as unknown as import("stream/web").ReadableStream
      );

      nodeStream.on("data", (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > MAX_VIDEO_DOWNLOAD_BYTES) {
          nodeStream.destroy(
            new FetcherError(
              "UPSTREAM_UNKNOWN_ERROR",
              "Video exceeds maximum allowed size of 25MB during stream"
            )
          );
        }
      });

      await pipeline(nodeStream, fileStream);

      return {
        filePath: tempFilePath,
        sizeBytes: downloadedBytes,
      };
    } catch (err: unknown) {
      fileStream.close();
      if (fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch {}
      }
      if (err instanceof FetcherError) {
        throw err;
      }
      throw new FetcherError(
        "UPSTREAM_UNKNOWN_ERROR",
        `Failed while streaming video to disk: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

export const fetcher = new TwitterSyndicationFetcher();
