"use node";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
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

import { classifyAssetKind, normalizeContentType as normalizeContentTypeShared, shouldRunMux } from "./assetKind";

const GIBIBYTE = 1024 ** 3;
const MAX_PRESIGNED_PUT_FILE_SIZE_BYTES = 5 * GIBIBYTE;

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
  const base = trimmed.length > 0 ? trimmed : "asset";
  const sanitized = base
    .replace(/["']/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_+/g, "_");
  return sanitized.slice(0, 120);
}

function buildDownloadFilename(title: string | undefined, key: string) {
  const ext = getExtensionFromKey(key);
  const safeTitle = sanitizeFilename(title ?? "asset");
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
      contentType: options.contentType ?? "application/octet-stream",
    }),
    filename,
  };
}

function getDownloadUnavailableMessage(status: string) {
  switch (status) {
    case "uploading":
      return "This asset is still uploading and isn't ready to download yet.";
    case "processing":
      return "This asset is still processing and isn't ready to download yet.";
    case "failed":
      return "This asset couldn't be processed, so it isn't available to download.";
    default:
      return "This asset isn't ready to download yet.";
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

const normalizeContentType = normalizeContentTypeShared;

/**
 * Frame accepts every file type — we classify into assetKind and only the
 * Mux pipeline gates on "is this a video". The only hard limits are
 * (a) non-empty + (b) under the 5 GiB presigned-PUT cap; oversized files
 * route through the multipart path on the migrate side.
 */
function validateUploadRequestOrThrow(args: { fileSize: number; contentType: string }) {
  if (!Number.isFinite(args.fileSize) || args.fileSize <= 0) {
    throw new Error("Asset file size must be greater than zero.");
  }
  if (args.fileSize > MAX_PRESIGNED_PUT_FILE_SIZE_BYTES) {
    throw new Error("Asset file is too large for direct upload.");
  }
  return normalizeContentType(args.contentType);
}

function shouldDeleteUploadedObjectOnFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("Asset file is too large") ||
    error.message.includes("Uploaded asset file not found") ||
    error.message.includes("Storage limit reached")
  );
}

async function requireAssetMemberAccess(
  ctx: ActionCtx,
  assetId: Id<"assets">
) {
  const asset = (await ctx.runQuery(api.assets.get, { assetId })) as
    | { role?: string }
    | null;
  if (!asset || asset.role === "viewer") {
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
    assetId?: Id<"assets">;
    muxAssetId?: string | null;
    muxPlaybackId: string;
  },
): Promise<string> {
  const { assetId, muxAssetId, muxPlaybackId } = params;
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
  if (assetId && resolvedPlaybackId !== muxPlaybackId) {
    await ctx.runMutation(internal.assets.setMuxPlaybackId, {
      assetId,
      muxPlaybackId: resolvedPlaybackId,
      thumbnailUrl: buildMuxThumbnailUrl(resolvedPlaybackId),
    });
  }

  return resolvedPlaybackId;
}

export const getUploadUrl = action({
  args: {
    assetId: v.id("assets"),
    filename: v.string(),
    fileSize: v.number(),
    contentType: v.string(),
  },
  returns: v.object({
    url: v.string(),
    uploadId: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireAssetMemberAccess(ctx, args.assetId);
    const normalizedContentType = validateUploadRequestOrThrow({
      fileSize: args.fileSize,
      contentType: args.contentType,
    });

    const s3 = getS3Client();
    const ext = getExtensionFromKey(args.filename);
    const key = `assets/${args.assetId}/${Date.now()}.${ext}`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: normalizedContentType,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

    await ctx.runMutation(internal.assets.setUploadInfo, {
      assetId: args.assetId,
      s3Key: key,
      fileSize: args.fileSize,
      contentType: normalizedContentType,
    });

    return { url, uploadId: key };
  },
});

export const markUploadComplete = action({
  args: {
    assetId: v.id("assets"),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAssetMemberAccess(ctx, args.assetId);

    const asset = await ctx.runQuery(api.assets.getAssetForPlayback, {
      assetId: args.assetId,
    });

    if (!asset || !asset.s3Key) {
      throw new Error("Original bucket file not found for this asset");
    }

    try {
      const s3 = getS3Client();
      const head = await s3.send(
        new HeadObjectCommand({
          Bucket: BUCKET_NAME,
          Key: asset.s3Key,
        }),
      );
      const contentLengthRaw = head.ContentLength;
      if (
        typeof contentLengthRaw !== "number" ||
        !Number.isFinite(contentLengthRaw) ||
        contentLengthRaw <= 0
      ) {
        throw new Error("Uploaded asset file not found or empty.");
      }
      const contentLength = contentLengthRaw;
      if (contentLength > MAX_PRESIGNED_PUT_FILE_SIZE_BYTES) {
        throw new Error("Asset file is too large for direct upload.");
      }

      const normalizedContentType = normalizeContentType(
        head.ContentType ?? asset.contentType,
      );

      await ctx.runMutation(internal.assets.reconcileUploadedObjectMetadata, {
        assetId: args.assetId,
        fileSize: contentLength,
        contentType: normalizedContentType,
      });

      // Non-video kinds skip the Mux pipeline entirely — they're viewable
      // straight from B2 via signed download URLs.
      if (!shouldRunMux(asset.assetKind)) {
        await ctx.runMutation(internal.assets.markNonVideoReady, {
          assetId: args.assetId,
        });
        return { success: true };
      }

      await ctx.runMutation(internal.assets.markAsProcessing, {
        assetId: args.assetId,
      });

      const ingestUrl = await buildSignedBucketObjectUrl(asset.s3Key, {
        expiresIn: 60 * 60 * 24,
      });
      const muxAsset = await createMuxAssetFromInputUrl(args.assetId, ingestUrl);
      if (muxAsset.id) {
        await ctx.runMutation(internal.assets.setMuxAssetReference, {
          assetId: args.assetId,
          muxAssetId: muxAsset.id,
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
              Key: asset.s3Key,
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
      await ctx.runMutation(internal.assets.markAsFailed, {
        assetId: args.assetId,
        uploadError,
      });
      throw error;
    }

    return { success: true };
  },
});

export const markUploadFailed = action({
  args: {
    assetId: v.id("assets"),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAssetMemberAccess(ctx, args.assetId);

    await ctx.runMutation(internal.assets.markAsFailed, {
      assetId: args.assetId,
      uploadError: "Upload failed before Mux could process the asset.",
    });

    return { success: true };
  },
});

/**
 * Full asset removal: deletes the B2 object, the Mux asset (for video kinds),
 * and the Convex row + cascaded comments + share links + grants. Best-effort
 * on the external resources — if B2 / Mux fail, we still drop the Convex
 * row so the user's UI reflects the deletion. Failures are logged for manual
 * cleanup.
 */
export const remove = action({
  args: { assetId: v.id("assets") },
  returns: v.object({
    success: v.boolean(),
    b2Deleted: v.boolean(),
    muxDeleted: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ success: boolean; b2Deleted: boolean; muxDeleted: boolean }> => {
    // Use the asset query to enforce admin role + load metadata.
    const asset = (await ctx.runQuery(api.assets.get, {
      assetId: args.assetId,
    })) as
      | {
          role?: string;
          s3Key?: string;
          muxAssetId?: string;
          assetKind?: string;
        }
      | null;
    if (!asset) {
      throw new Error("Asset not found");
    }
    if (asset.role !== "owner" && asset.role !== "admin") {
      throw new Error("Requires admin role or higher");
    }

    let b2Deleted = false;
    if (asset.s3Key) {
      try {
        const s3 = getS3Client();
        await s3.send(
          new DeleteObjectCommand({
            Bucket: BUCKET_NAME,
            Key: asset.s3Key,
          }),
        );
        b2Deleted = true;
      } catch (err) {
        console.error("Failed to delete B2 object during asset removal", {
          assetId: args.assetId,
          s3Key: asset.s3Key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let muxDeleted = false;
    if (asset.assetKind === "video" && asset.muxAssetId) {
      try {
        const { deleteMuxAsset } = await import("./mux");
        await deleteMuxAsset(asset.muxAssetId);
        muxDeleted = true;
      } catch (err) {
        console.error("Failed to delete Mux asset during asset removal", {
          assetId: args.assetId,
          muxAssetId: asset.muxAssetId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await ctx.runMutation(internal.assets.removeRow, {
      assetId: args.assetId,
    });

    return { success: true, b2Deleted, muxDeleted };
  },
});

export const getPlaybackSession = action({
  args: { assetId: v.id("assets") },
  returns: v.object({
    url: v.string(),
    posterUrl: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; posterUrl: string }> => {
    const asset = await ctx.runQuery(api.assets.getAssetForPlayback, {
      assetId: args.assetId,
    });

    if (!asset || !asset.muxPlaybackId || asset.status !== "ready") {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      assetId: args.assetId,
      muxAssetId: asset.muxAssetId,
      muxPlaybackId: asset.muxPlaybackId,
    });
    return buildPublicPlaybackSession(playbackId);
  },
});

export const getPlaybackUrl = action({
  args: { assetId: v.id("assets") },
  returns: v.object({
    url: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const asset = await ctx.runQuery(api.assets.getAssetForPlayback, {
      assetId: args.assetId,
    });

    if (!asset || !asset.muxPlaybackId || asset.status !== "ready") {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      assetId: args.assetId,
      muxAssetId: asset.muxAssetId,
      muxPlaybackId: asset.muxPlaybackId,
    });
    const session = buildPublicPlaybackSession(playbackId);
    return { url: session.url };
  },
});

export const getOriginalPlaybackUrl = action({
  args: { assetId: v.id("assets") },
  returns: v.object({
    url: v.string(),
    contentType: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; contentType: string }> => {
    const asset = await ctx.runQuery(api.assets.getAssetForPlayback, {
      assetId: args.assetId,
    });

    if (!asset || !asset.s3Key) {
      throw new Error("Original bucket file not found for this asset");
    }

    const contentType = asset.contentType ?? "asset/mp4";
    return {
      url: await buildSignedBucketObjectUrl(asset.s3Key, {
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
    const result = await ctx.runQuery(api.assets.getByPublicId, {
      publicId: args.publicId,
    });

    if (!result?.asset?.muxPlaybackId) {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      assetId: result.asset._id,
      muxAssetId: result.asset.muxAssetId,
      muxPlaybackId: result.asset.muxPlaybackId,
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
    const result = await ctx.runQuery(api.assets.getByShareGrant, {
      grantToken: args.grantToken,
    });

    if (!result?.asset?.muxPlaybackId) {
      throw new Error("Video not found or not ready");
    }

    const playbackId = await ensurePublicPlaybackId(ctx, {
      assetId: result.asset._id,
      muxAssetId: result.asset.muxAssetId,
      muxPlaybackId: result.asset.muxPlaybackId,
    });
    return buildPublicPlaybackSession(playbackId);
  },
});

export const getDownloadUrl = action({
  args: { assetId: v.id("assets") },
  returns: v.object({
    url: v.string(),
    filename: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; filename: string }> => {
    const asset = await ctx.runQuery(api.assets.getAssetForPlayback, {
      assetId: args.assetId,
    });

    if (!asset) {
      throw new Error("Video not found");
    }

    if (asset.status !== "ready") {
      throw new Error(getDownloadUnavailableMessage(asset.status));
    }

    const key = getValueString(asset, "s3Key");
    if (!key) {
      throw new Error("Original bucket file not found for this asset");
    }

    return await buildDownloadResult(key, {
      title: asset.title,
      contentType: asset.contentType,
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
    const result = await ctx.runQuery(api.assets.getByPublicIdForDownload, {
      publicId: args.publicId,
    });

    if (!result?.asset) {
      throw new Error("Video not found");
    }

    if (result.asset.status !== "ready") {
      throw new Error(getDownloadUnavailableMessage(result.asset.status));
    }

    const key = getValueString(result.asset, "s3Key");
    if (!key) {
      throw new Error("Original bucket file not found for this asset");
    }

    return await buildDownloadResult(key, {
      title: result.asset.title,
      contentType: result.asset.contentType,
    });
  },
});

/**
 * View URL for shared non-video assets. Same signed-URL builder as the
 * download endpoint, but bypasses the allowDownload check — for renderable
 * formats (image, PDF, audio) the page itself is the viewer, and we want
 * those to display even when the share owner disabled file downloads.
 */
export const getSharedViewUrl = action({
  args: { grantToken: v.string() },
  returns: v.object({
    url: v.string(),
    filename: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string; filename: string }> => {
    const result = await ctx.runQuery(api.assets.getByShareGrantForDownload, {
      grantToken: args.grantToken,
    });

    if (!result?.asset) {
      throw new Error("Asset not found");
    }
    if (result.asset.status !== "ready") {
      throw new Error(getDownloadUnavailableMessage(result.asset.status));
    }
    const key = getValueString(result.asset, "s3Key");
    if (!key) {
      throw new Error("Original bucket file not found for this asset");
    }
    return await buildDownloadResult(key, {
      title: result.asset.title,
      contentType: result.asset.contentType,
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
    const result = await ctx.runQuery(api.assets.getByShareGrantForDownload, {
      grantToken: args.grantToken,
    });

    if (!result?.asset) {
      throw new Error("Video not found");
    }

    if (!result.allowDownload) {
      throw new Error("Downloads are disabled for this shared link.");
    }

    if (result.asset.status !== "ready") {
      throw new Error(getDownloadUnavailableMessage(result.asset.status));
    }

    const key = getValueString(result.asset, "s3Key");
    if (!key) {
      throw new Error("Original bucket file not found for this asset");
    }

    return await buildDownloadResult(key, {
      title: result.asset.title,
      contentType: result.asset.contentType,
    });
  },
});
