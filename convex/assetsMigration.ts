/**
 * One-shot migration: videos → assets.
 *
 * Run via the migration HTTP endpoint (gated by MIGRATION_TOKEN). The
 * mutation is idempotent — re-running is safe.
 *
 *   1. For every videos row, ensure a matching assets row exists
 *      (assetKind="video", legacyVideoId=videos._id).
 *   2. For every comments row that has videoId but no assetId, set
 *      assetId to the new asset's _id (looked up via the
 *      by_legacy_video_id index).
 *   3. Same for shareLinks rows.
 *
 * Fields with no semantic change copy 1:1. After this runs in prod and
 * we verify counts, drop the videos table + legacy fields.
 *
 * Pagination uses Convex `.paginate({cursor, numItems})` which is the
 * platform-correct way to walk a table — earlier `_id`-filter+take
 * bookkeeping silently skipped rows because Convex's natural ordering
 * is by `_creationTime`, not `_id`, so the cursor inequality didn't
 * align with the take window.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

const BATCH = 100;

function inferAssetKind(_contentType: string | undefined): Doc<"assets">["assetKind"] {
  // Videos table only ever held videos — keep it simple.
  return "video";
}

export const migrateVideosBatch = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? BATCH;

    const page = await ctx.db
      .query("videos")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    let copied = 0;
    let skipped = 0;

    for (const video of page.page) {
      const existing = await ctx.db
        .query("assets")
        .withIndex("by_legacy_video_id", (qb) => qb.eq("legacyVideoId", video._id))
        .unique();
      if (existing) {
        skipped++;
        continue;
      }

      await ctx.db.insert("assets", {
        projectId: video.projectId,
        folderId: undefined,
        assetKind: inferAssetKind(video.contentType),
        uploadedByClerkId: video.uploadedByClerkId,
        uploaderName: video.uploaderName,
        title: video.title,
        description: video.description,
        visibility: video.visibility,
        publicId: video.publicId,
        muxUploadId: video.muxUploadId,
        muxAssetId: video.muxAssetId,
        muxPlaybackId: video.muxPlaybackId,
        muxAssetStatus: video.muxAssetStatus,
        s3Key: video.s3Key,
        duration: video.duration,
        thumbnailUrl: video.thumbnailUrl,
        fileSize: video.fileSize,
        contentType: video.contentType,
        uploadError: video.uploadError,
        status: video.status,
        workflowStatus: video.workflowStatus,
        legacyVideoId: video._id,
      });
      copied++;
    }

    return {
      processed: page.page.length,
      copied,
      skipped,
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

export const rewireCommentsBatch = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? BATCH;

    const page = await ctx.db
      .query("comments")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    let updated = 0;
    let skipped = 0;
    let orphaned = 0;

    for (const comment of page.page) {
      if (comment.assetId) {
        skipped++;
        continue;
      }
      if (!comment.videoId) {
        skipped++;
        continue;
      }

      const asset = await ctx.db
        .query("assets")
        .withIndex("by_legacy_video_id", (qb) => qb.eq("legacyVideoId", comment.videoId!))
        .unique();
      if (!asset) {
        orphaned++;
        continue;
      }

      await ctx.db.patch(comment._id, { assetId: asset._id });
      updated++;
    }

    return {
      processed: page.page.length,
      updated,
      skipped,
      orphaned,
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

export const rewireShareLinksBatch = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? BATCH;

    const page = await ctx.db
      .query("shareLinks")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    let updated = 0;
    let skipped = 0;
    let orphaned = 0;

    for (const link of page.page) {
      if (link.assetId) {
        skipped++;
        continue;
      }
      if (!link.videoId) {
        skipped++;
        continue;
      }

      const asset = await ctx.db
        .query("assets")
        .withIndex("by_legacy_video_id", (qb) => qb.eq("legacyVideoId", link.videoId!))
        .unique();
      if (!asset) {
        orphaned++;
        continue;
      }

      await ctx.db.patch(link._id, { assetId: asset._id });
      updated++;
    }

    return {
      processed: page.page.length,
      updated,
      skipped,
      orphaned,
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

export const migrationStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const videos = await ctx.db.query("videos").collect();
    const assets = await ctx.db.query("assets").collect();
    const comments = await ctx.db.query("comments").collect();
    const shareLinks = await ctx.db.query("shareLinks").collect();

    return {
      videosTotal: videos.length,
      assetsTotal: assets.length,
      assetsMigrated: assets.filter((a) => a.legacyVideoId !== undefined).length,
      commentsTotal: comments.length,
      commentsWithAssetId: comments.filter((c) => c.assetId !== undefined).length,
      commentsLegacyOnly: comments.filter(
        (c) => c.videoId !== undefined && c.assetId === undefined,
      ).length,
      shareLinksTotal: shareLinks.length,
      shareLinksWithAssetId: shareLinks.filter((s) => s.assetId !== undefined).length,
      shareLinksLegacyOnly: shareLinks.filter(
        (s) => s.videoId !== undefined && s.assetId === undefined,
      ).length,
    };
  },
});
