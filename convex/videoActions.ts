"use node";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v } from "convex/values";
import { action, ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  buildMuxPlaybackUrl,
  buildMuxThumbnailUrl,
  createMuxAssetFromInputUrl,
  createPublicPlaybackId,
  getMuxAsset,
} from "./mux";
import { BUCKET_NAME, getS3Client } from "./s3";

const MEBIBYTE = 1024 ** 2;
const DEFAULT_MULTIPART_PART_SIZE_BYTES = 16 * MEBIBYTE;
const MAX_MULTIPART_PARTS = 10_000;
const MAX_PART_URLS_PER_REQUEST = 32;
const ALLOWED_UPLOAD_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
]);

function getExtensionFromKey(key: string, fallback = "mp4") {
  let source = key;
  if (key.startsWith("http://") || key.startsWith("https://")) {
    try {
      source = new URL(key).pathname;
    } catch {
      source = key;
    }
  }

  const ext = source.split(".").pop();
  if (!ext) return fallback;
  if (ext.length > 8 || /[^a-zA-Z0-9]/.test(ext)) return fallback;
  return ext.toLowerCase();
}

function sanitizeFilename(input: string) {
  const trimmed = input.trim();
  const base = trimmed.length > 0 ? trimmed : "video";
  const sanitized = base
    .replace(/["']/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_");
  return sanitized.slice(0, 120);
}

function buildDownloadFilename(title: string | undefined, key: string) {
  const ext = getExtensionFromKey(key);
  const safeTitle = sanitizeFilename(title ?? "video");
  return safeTitle.endsWith(`.${ext}`) ? safeTitle : `${safeTitle}.${ext}`;
}

async function buildDownloadResult(
  key: string,
  options: {
    title?: string;
    contentType?: string;
  },
): Promise<{ url: string; filename: string }> {
  const filename = buildDownloadFilename(options.title, key);

  return {
    url: await buildSignedBucketObjectUrl(key, {
      expiresIn: 600,
      filename,
      contentType: options.contentType ?? "video/mp4",
    }),
    filename,
  };
}

function getDownloadUnavailableMessage(status: string) {
  switch (status) {
    case "uploading":
      return "This video is still uploading and isn't ready to download yet.";
    case "processing":
      return "This video is still processing and isn't ready to download yet.";
    case "failed":
      return "This video couldn't be processed, so it isn't available to download.";
    default:
      return "This video isn't ready to download yet.";
  }
}

function normalizeBucketKey(key: string): string {
  if (key.startsWith("http://") || key.startsWith("https://")) {
    try {
      const pathname = new URL(key).pathname.replace(/^\/+/, "");
      const bucketPrefix = `${BUCKET_NAME}/`;
      return pathname.startsWith(bucketPrefix)
        ? pathname.slice(bucketPrefix.length)
        : pathname;
    } catch {
      return key;
    }
  }
  return key;
}

async function buildSignedBucketObjectUrl(
  key: string,
  options?: {
    expiresIn?: number;
    filename?: string;
    contentType?: string;
  },
): Promise<string> {
  const normalizedKey = normalizeBucketKey(key);
  const s3 = getS3Client();
  const filename = options?.filename;
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: normalizedKey,
    ResponseContentDisposition: filename
      ? `attachment; filename="${filename}"`
      : undefined,
    ResponseContentType: options?.contentType,
  });
  return await getSignedUrl(s3, command, { expiresIn: options?.expiresIn ?? 600 });
}

function getValueString(value: unknown, field: string): string | null {
  const raw = (value as Record<string, unknown>)[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function normalizeContentType(contentType: string | null | undefined): string {
  if (!contentType) return "";
  return contentType
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function isAllowedUploadContentType(contentType: string): boolean {
  return ALLOWED_UPLOAD_CONTENT_TYPES.has(contentType);
}

function validateUploadRequestOrThrow(args: { fileSize: number; contentType: string }) {
  if (!Number.isFinite(args.fileSize) || args.fileSize <= 0) {
    throw new Error("Video file size must be greater than zero.");
  }

  const normalizedContentType = normalizeContentType(args.contentType);
  if (!isAllowedUploadContentType(normalizedContentType)) {
    throw new Error("Unsupported video format. Allowed: mp4, mov, webm, mkv.");
  }

  return normalizedContentType;
}

function buildUploadKey(videoId: Id<"videos">, filename: string) {
  const ext = getExtensionFromKey(filename);
  return `videos/${videoId}/${Date.now()}.${ext}`;
}

function getMultipartPartSizeBytes(fileSize: number) {
  const minimumSizeForPartCount = Math.ceil(fileSize / MAX_MULTIPART_PARTS);
  const targetPartSize = Math.max(
    DEFAULT_MULTIPART_PART_SIZE_BYTES,
    minimumSizeForPartCount,
  );
  return Math.ceil(targetPartSize / MEBIBYTE) * MEBIBYTE;
}

function validatePartNumberOrThrow(partNumber: number) {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_MULTIPART_PARTS) {
    throw new Error("Invalid multipart upload part number.");
  }
  return partNumber;
}

function validatePartNumbersOrThrow(partNumbers: number[]) {
  if (partNumbers.length === 0) {
    throw new Error("At least one multipart upload part number is required.");
  }

  if (partNumbers.length > MAX_PART_URLS_PER_REQUEST) {
    throw new Error("Too many multipart upload parts requested at once.");
  }

  const seenPartNumbers = new Set<number>();
  return partNumbers.map((partNumber) => {
    const normalizedPartNumber = validatePartNumberOrThrow(partNumber);
    if (seenPartNumbers.has(normalizedPartNumber)) {
      throw new Error("Duplicate multipart upload part number.");
    }
    seenPartNumbers.add(normalizedPartNumber);
    return normalizedPartNumber;
  });
}

function normalizeCompletedPartsOrThrow(
  parts: Array<{ partNumber: number; etag: string }>,
  expectedPartCount?: number,
) {
  if (parts.length === 0) {
    throw new Error("At least one completed multipart upload part is required.");
  }

  if (expectedPartCount !== undefined && parts.length !== expectedPartCount) {
    throw new Error("Multipart upload completed with the wrong number of parts.");
  }

  const seenPartNumbers = new Set<number>();
  return [...parts]
    .map((part) => {
      const partNumber = validatePartNumberOrThrow(part.partNumber);
      if (expectedPartCount !== undefined && partNumber > expectedPartCount) {
        throw new Error("Multipart upload completed with an unexpected part number.");
      }
      const etag = part.etag.trim();
      if (!etag) {
        throw new Error(`Missing multipart upload ETag for part ${partNumber}.`);
      }
      if (seenPartNumbers.has(partNumber)) {
        throw new Error("Duplicate completed multipart upload part.");
      }
      seenPartNumbers.add(partNumber);
      return { partNumber, etag };
    })
    .sort((a, b) => a.partNumber - b.partNumber);
}

async function requireMatchingUploadKey(
  ctx: ActionCtx,
  params: {
    videoId: Id<"videos">;
    key: string;
    multipartUploadId?: string;
  },
) {
  const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
    videoId: params.videoId,
  });

  if (!video?.s3Key) {
    throw new Error("Upload session not found for this video.");
  }

  if (video.s3Key !== params.key) {
    throw new Error("Upload session no longer matches this video.");
  }

  if (
    params.multipartUploadId !== undefined &&
    video.multipartUploadId !== params.multipartUploadId
  ) {
    throw new Error("Multipart upload session no longer matches this video.");
  }

  return video;
}

function shouldDeleteUploadedObjectOnFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Unsupported video format") ||
    error.message.includes("Video file is too large") ||
    error.message.includes("Uploaded video file not found") ||
    error.message.includes("Uploaded video file size did not match") ||
    error.message.includes("Multipart upload completed with") ||
    error.message.includes("Storage limit reached")
  );
}

async function requireVideoMemberAccess(
  ctx: ActionCtx,
  videoId: Id<"videos">
) {
  const video = (await ctx.runQuery(api.videos.get, { videoId })) as
    | { role?: string }
    | null;
  if (!video || video.role === "viewer") {
    throw new Error("Requires member role or higher");
  }
}

function buildPublicPlaybackSession(
  playbackId: string,
): { url: string; posterUrl: string } {
  return {
    url: buildMuxPlaybackUrl(playbackId),
    posterUrl: buildMuxThumbnailUrl(playbackId),
  };
}

async function ensurePublicPlaybackId(
  ctx: ActionCtx,
  params: {
    videoId?: Id<"videos">;
    muxAssetId?: string | null;
    muxPlaybackId: string;
  },
): Promise<string> {
  const { videoId, muxAssetId, muxPlaybackId } = params;
  if (!muxAssetId) return muxPlaybackId;

  const asset = await getMuxAsset(muxAssetId);
  const playbackIds = (asset.playback_ids ?? []) as Array<{
    id?: string;
    policy?: string;
  }>;

  let publicPlaybackId = playbackIds.find((entry) => entry.policy === "public" && entry.id)?.id;
  if (!publicPlaybackId) {
    const created = await createPublicPlaybackId(muxAssetId);
    publicPlaybackId = created.id;
  }

  const resolvedPlaybackId = publicPlaybackId ?? muxPlaybackId;
  if (videoId && resolvedPlaybackId !== muxPlaybackId) {
    await ctx.runMutation(internal.videos.setMuxPlaybackId, {
      videoId,
      muxPlaybackId: resolvedPlaybackId,
      thumbnailUrl: buildMuxThumbnailUrl(resolvedPlaybackId),
    });
  }

  return resolvedPlaybackId;
}

export const createMultipartUpload = action({
  args: {
    videoId: v.id("videos"),
    filename: v.string(),
    fileSize: v.number(),
    contentType: v.string(),
  },
  returns: v.object({
    key: v.string(),
    multipartUploadId: v.string(),
    partSizeBytes: v.number(),
    totalParts: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);
    const normalizedContentType = validateUploadRequestOrThrow({
      fileSize: args.fileSize,
      contentType: args.contentType,
    });

    const key = buildUploadKey(args.videoId, args.filename);
    const partSizeBytes = getMultipartPartSizeBytes(args.fileSize);
    const totalParts = Math.max(1, Math.ceil(args.fileSize / partSizeBytes));
    const s3 = getS3Client();
    const result = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        ContentType: normalizedContentType,
      }),
    );

    if (!result.UploadId) {
      throw new Error("Could not create multipart upload session.");
    }

    await ctx.runMutation(internal.videos.setUploadInfo, {
      videoId: args.videoId,
      s3Key: key,
      fileSize: args.fileSize,
      contentType: normalizedContentType,
      multipartUploadId: result.UploadId,
      uploadPartSizeBytes: partSizeBytes,
      uploadTotalParts: totalParts,
    });

    return {
      key,
      multipartUploadId: result.UploadId,
      partSizeBytes,
      totalParts,
    };
  },
});

export const getMultipartUploadPartUrls = action({
  args: {
    videoId: v.id("videos"),
    key: v.string(),
    multipartUploadId: v.string(),
    partNumbers: v.array(v.number()),
  },
  returns: v.object({
    parts: v.array(
      v.object({
        partNumber: v.number(),
        url: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);
    const video = await requireMatchingUploadKey(ctx, {
      videoId: args.videoId,
      key: args.key,
      multipartUploadId: args.multipartUploadId,
    });
    const normalizedPartNumbers = validatePartNumbersOrThrow(args.partNumbers);
    const expectedTotalParts = video.uploadTotalParts;
    if (
      expectedTotalParts !== undefined &&
      normalizedPartNumbers.some((partNumber) => partNumber > expectedTotalParts)
    ) {
      throw new Error("Requested multipart upload part is outside this upload session.");
    }

    const s3 = getS3Client();
    const parts = await Promise.all(
      normalizedPartNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          s3,
          new UploadPartCommand({
            Bucket: BUCKET_NAME,
            Key: args.key,
            UploadId: args.multipartUploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: 3600 },
        ),
      })),
    );

    return { parts };
  },
});

export const completeMultipartUpload = action({
  args: {
    videoId: v.id("videos"),
    key: v.string(),
    multipartUploadId: v.string(),
    parts: v.array(
      v.object({
        partNumber: v.number(),
        etag: v.string(),
      }),
    ),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);
    const video = await requireMatchingUploadKey(ctx, {
      videoId: args.videoId,
      key: args.key,
      multipartUploadId: args.multipartUploadId,
    });

    const completedParts = normalizeCompletedPartsOrThrow(
      args.parts,
      video.uploadTotalParts,
    );
    const s3 = getS3Client();
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: BUCKET_NAME,
        Key: args.key,
        UploadId: args.multipartUploadId,
        MultipartUpload: {
          Parts: completedParts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );

    return { success: true };
  },
});

export const abortMultipartUpload = action({
  args: {
    videoId: v.id("videos"),
    key: v.string(),
    multipartUploadId: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);
    await requireMatchingUploadKey(ctx, {
      videoId: args.videoId,
      key: args.key,
      multipartUploadId: args.multipartUploadId,
    });

    const s3 = getS3Client();
    try {
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: BUCKET_NAME,
          Key: args.key,
          UploadId: args.multipartUploadId,
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchUpload") {
        return { success: true };
      }
      throw error;
    }

    return { success: true };
  },
});

export const markUploadComplete = action({
  args: {
    videoId: v.id("videos"),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);

    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || !video.s3Key) {
      throw new Error("Original bucket file not found for this video");
    }

    try {
      const s3 = getS3Client();
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: BUCKET_NAME,
          Key: video.s3Key,
        }),
      );
      const contentLengthRaw = head.ContentLength;
      if (
        typeof contentLengthRaw !== "number" ||
        !Number.isFinite(contentLengthRaw) ||
        contentLengthRaw <= 0
      ) {
        throw new Error("Uploaded video file not found or empty.");
      }
      const contentLength = contentLengthRaw;
      if (
        typeof video.fileSize === "number" &&
        Number.isFinite(video.fileSize) &&
        contentLength !== video.fileSize
      ) {
        throw new Error("Uploaded video file size did not match the requested upload.");
      }

      const normalizedContentType = normalizeContentType(
        head.ContentType ?? video.contentType,
      );
      if (!isAllowedUploadContentType(normalizedContentType)) {
        throw new Error("Unsupported video format. Allowed: mp4, mov, webm, mkv.");
      }

      await ctx.runMutation(internal.videos.reconcileUploadedObjectMetadata, {
        videoId: args.videoId,
        fileSize: contentLength,
        contentType: normalizedContentType,
      });

      await ctx.runMutation(internal.videos.markAsProcessing, {
        videoId: args.videoId,
      });

      const ingestUrl = await buildSignedBucketObjectUrl(video.s3Key, {
        expiresIn: 60 * 60 * 24,
      });
      const asset = await createMuxAssetFromInputUrl(args.videoId, ingestUrl);
      if (asset.id) {
        await ctx.runMutation(internal.videos.setMuxAssetReference, {
          videoId: args.videoId,
          muxAssetId: asset.id,
        });
      }
    } catch (error) {
      const shouldDeleteObject = shouldDeleteUploadedObjectOnFailure(error);
      if (shouldDeleteObject) {
        const s3 = getS3Client();
        try {
          await s3.send(
            new DeleteObjectCommand({
              Bucket: BUCKET_NAME,
              Key: video.s3Key,
            }),
          );
        } catch {
          // No-op: preserve original processing failure.
        }
      }

      const uploadError =
        shouldDeleteObject && error instanceof Error
          ? error.message
          : "Mux ingest failed after upload.";
      await ctx.runMutation(internal.videos.markAsFailed, {
        videoId: args.videoId,
        uploadError,
      });
      throw error;
    }

    return { success: true };
  },
});

export const markUploadFailed = action({
  args: {
    videoId: v.id("videos"),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireVideoMemberAccess(ctx, args.videoId);

    await ctx.runMutation(internal.videos.markAsFailed, {
      videoId: args.videoId,
      uploadError: "Upload failed before Mux could process the asset.",
    });

    return { success: true };
  },
});

export const getPlaybackSession = action({
  args: { videoId: v.id("videos") },
  returns: v.object({
    url: v.string(),
    posterUrl: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; posterUrl: string }> => {
    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || !video.muxPlaybackId || video.status !== "ready") {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      videoId: args.videoId,
      muxAssetId: video.muxAssetId,
      muxPlaybackId: video.muxPlaybackId,
    });
    return buildPublicPlaybackSession(playbackId);
  },
});

export const getPlaybackUrl = action({
  args: { videoId: v.id("videos") },
  returns: v.object({
    url: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || !video.muxPlaybackId || video.status !== "ready") {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      videoId: args.videoId,
      muxAssetId: video.muxAssetId,
      muxPlaybackId: video.muxPlaybackId,
    });
    const session = buildPublicPlaybackSession(playbackId);
    return { url: session.url };
  },
});

export const getOriginalPlaybackUrl = action({
  args: { videoId: v.id("videos") },
  returns: v.object({
    url: v.string(),
    contentType: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; contentType: string }> => {
    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video || !video.s3Key) {
      throw new Error("Original bucket file not found for this video");
    }

    const contentType = video.contentType ?? "video/mp4";
    return {
      url: await buildSignedBucketObjectUrl(video.s3Key, {
        expiresIn: 600,
        contentType,
      }),
      contentType,
    };
  },
});

export const getPublicPlaybackSession = action({
  args: { publicId: v.string() },
  returns: v.object({
    url: v.string(),
    posterUrl: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; posterUrl: string }> => {
    const result = await ctx.runQuery(api.videos.getByPublicId, {
      publicId: args.publicId,
    });

    if (!result?.video?.muxPlaybackId) {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      videoId: result.video._id,
      muxAssetId: result.video.muxAssetId,
      muxPlaybackId: result.video.muxPlaybackId,
    });
    return buildPublicPlaybackSession(playbackId);
  },
});

export const getSharedPlaybackSession = action({
  args: { grantToken: v.string() },
  returns: v.object({
    url: v.string(),
    posterUrl: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; posterUrl: string }> => {
    const result = await ctx.runQuery(api.videos.getByShareGrant, {
      grantToken: args.grantToken,
    });

    if (!result?.video?.muxPlaybackId) {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      videoId: result.video._id,
      muxAssetId: result.video.muxAssetId,
      muxPlaybackId: result.video.muxPlaybackId,
    });
    return buildPublicPlaybackSession(playbackId);
  },
});

export const getDownloadUrl = action({
  args: { videoId: v.id("videos") },
  returns: v.object({
    url: v.string(),
    filename: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; filename: string }> => {
    const video = await ctx.runQuery(api.videos.getVideoForPlayback, {
      videoId: args.videoId,
    });

    if (!video) {
      throw new Error("Video not found");
    }

    if (video.status !== "ready") {
      throw new Error(getDownloadUnavailableMessage(video.status));
    }

    const key = getValueString(video, "s3Key");
    if (!key) {
      throw new Error("Original bucket file not found for this video");
    }

    return await buildDownloadResult(key, {
      title: video.title,
      contentType: video.contentType,
    });
  },
});

export const getPublicDownloadUrl = action({
  args: { publicId: v.string() },
  returns: v.object({
    url: v.string(),
    filename: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; filename: string }> => {
    const result = await ctx.runQuery(api.videos.getByPublicIdForDownload, {
      publicId: args.publicId,
    });

    if (!result?.video) {
      throw new Error("Video not found");
    }

    if (result.video.status !== "ready") {
      throw new Error(getDownloadUnavailableMessage(result.video.status));
    }

    const key = getValueString(result.video, "s3Key");
    if (!key) {
      throw new Error("Original bucket file not found for this video");
    }

    return await buildDownloadResult(key, {
      title: result.video.title,
      contentType: result.video.contentType,
    });
  },
});

export const getSharedDownloadUrl = action({
  args: { grantToken: v.string() },
  returns: v.object({
    url: v.string(),
    filename: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; filename: string }> => {
    const result = await ctx.runQuery(api.videos.getByShareGrantForDownload, {
      grantToken: args.grantToken,
    });

    if (!result?.video) {
      throw new Error("Video not found");
    }

    if (!result.allowDownload) {
      throw new Error("Downloads are disabled for this shared link.");
    }

    if (result.video.status !== "ready") {
      throw new Error(getDownloadUnavailableMessage(result.video.status));
    }

    const key = getValueString(result.video, "s3Key");
    if (!key) {
      throw new Error("Original bucket file not found for this video");
    }

    return await buildDownloadResult(key, {
      title: result.video.title,
      contentType: result.video.contentType,
    });
  },
});
