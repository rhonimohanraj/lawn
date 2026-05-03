"use node";

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { createMuxAssetFromInputUrl } from "./mux";
import { BUCKET_NAME, getS3Client } from "./s3";
import { assetKindValidator } from "./schema";
import { shouldRunMux } from "./assetKind";

function extFromName(name: string, fallback = "mp4"): string {
  const ext = name.split(".").pop();
  if (!ext || ext.length > 8 || /[^a-zA-Z0-9]/.test(ext)) return fallback;
  return ext.toLowerCase();
}

/**
 * Generate a presigned PUT URL for the migration CLI to stream Frame.io
 * originals into B2. Skips Clerk auth — gated upstream by MIGRATION_TOKEN
 * on the HTTP route.
 */
export const presignMigrationUpload = internalAction({
  args: {
    videoId: v.id("videos"),
    filename: v.string(),
    contentType: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; s3Key: string }> => {
    const s3 = getS3Client();
    const ext = extFromName(args.filename);
    const s3Key = `videos/${args.videoId}/${Date.now()}.${ext}`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: args.contentType,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

    await ctx.runMutation(internal.migration.setVideoS3Key, {
      videoId: args.videoId,
      s3Key,
    });

    return { url, s3Key };
  },
});

/**
 * After CLI has finished the B2 PUT, call this to verify the upload via
 * head_object, then trigger Mux ingest from a 24h signed B2 GET URL.
 */
export const completeMigrationUpload = internalAction({
  args: { videoId: v.id("videos") },
  handler: async (
    ctx,
    args,
  ): Promise<{ muxAssetId: string | null; bytes: number }> => {
    const video = await ctx.runQuery(internal.migration.getVideoForMigration, {
      videoId: args.videoId,
    });
    if (!video || !video.s3Key) {
      throw new Error("Video or s3Key missing");
    }

    const s3 = getS3Client();
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: video.s3Key }),
    );
    const bytes = head.ContentLength;
    if (typeof bytes !== "number" || bytes <= 0) {
      throw new Error("Uploaded object is empty or missing");
    }

    const ingestCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: video.s3Key,
    });
    const ingestUrl = await getSignedUrl(s3, ingestCommand, {
      expiresIn: 60 * 60 * 24,
    });

    let muxAssetId: string | null = null;
    try {
      const asset = await createMuxAssetFromInputUrl(args.videoId, ingestUrl);
      muxAssetId = asset.id ?? null;
      if (muxAssetId) {
        await ctx.runMutation(internal.migration.setVideoMuxAsset, {
          videoId: args.videoId,
          muxAssetId,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.migration.markVideoFailed, {
        videoId: args.videoId,
        uploadError: `Mux ingest failed: ${msg}`,
      });
      throw err;
    }

    return { muxAssetId, bytes };
  },
});

// ───────────────────────── v2: assets-aware actions ─────────────────────────

export const presignMigrationAssetUpload = internalAction({
  args: {
    assetId: v.id("assets"),
    filename: v.string(),
    contentType: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string; s3Key: string }> => {
    const s3 = getS3Client();
    const ext = extFromName(args.filename);
    const s3Key = `assets/${args.assetId}/${Date.now()}.${ext}`;
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: args.contentType,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });

    await ctx.runMutation(internal.migration.setAssetS3Key, {
      assetId: args.assetId,
      s3Key,
    });

    return { url, s3Key };
  },
});

/**
 * After CLI has finished the B2 PUT, call this to verify the upload via
 * head_object. For video assets, also kick off Mux ingest. For non-video
 * assets, mark as ready immediately (no transcode pipeline).
 */
export const completeMigrationAssetUpload = internalAction({
  args: {
    assetId: v.id("assets"),
    assetKind: assetKindValidator,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ muxAssetId: string | null; bytes: number; kind: string }> => {
    const asset = await ctx.runQuery(internal.migration.getAssetForMigration, {
      assetId: args.assetId,
    });
    if (!asset || !asset.s3Key) {
      throw new Error("Asset or s3Key missing");
    }

    const s3 = getS3Client();
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: asset.s3Key }),
    );
    const bytes = head.ContentLength;
    if (typeof bytes !== "number" || bytes <= 0) {
      throw new Error("Uploaded object is empty or missing");
    }

    if (!shouldRunMux(args.assetKind)) {
      // Non-video assets: no transcode. They're immediately viewable.
      await ctx.runMutation(internal.migration.markAssetReady, {
        assetId: args.assetId,
      });
      return { muxAssetId: null, bytes, kind: args.assetKind };
    }

    // Video path: hand off to Mux for transcode + playback.
    const ingestCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: asset.s3Key,
    });
    const ingestUrl = await getSignedUrl(s3, ingestCommand, {
      expiresIn: 60 * 60 * 24,
    });

    let muxAssetId: string | null = null;
    try {
      // createMuxAssetFromInputUrl accepts an Id<"videos"> typed param today;
      // the Mux module will be migrated to assets in the frontend-rename
      // session. For now we cast — the value is only used as a passthrough
      // string for Mux passthrough metadata.
      const muxAsset = await createMuxAssetFromInputUrl(
        args.assetId as unknown as never,
        ingestUrl,
      );
      muxAssetId = muxAsset.id ?? null;
      if (muxAssetId) {
        await ctx.runMutation(internal.migration.setAssetMuxAsset, {
          assetId: args.assetId,
          muxAssetId,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.migration.markAssetFailed, {
        assetId: args.assetId,
        uploadError: `Mux ingest failed: ${msg}`,
      });
      throw err;
    }

    return { muxAssetId, bytes, kind: args.assetKind };
  },
});
