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
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";

const BATCH = 100;

function inferAssetKind(contentType: string | undefined): Doc<"assets">["assetKind"] {
  // Videos table only ever held videos — keep it simple.
  return "video";
}

export const migrateVideosBatch = internalMutation({
  args: {
    cursor: v.optional(v.id("videos")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? BATCH;

    let q = ctx.db.query("videos");
    if (args.cursor) {
      // Convex doesn't expose cursor pagination by id directly; use
      // _id ordering with a filter.
      q = q.filter((qb) => qb.gt(qb.field("_id"), args.cursor!));
    }
    const videos = await q.take(limit);

    let copied = 0;
    let skipped = 0;
    let lastId: Id<"videos"> | undefined = undefined;

    for (const video of videos) {
      lastId = video._id;

      // Already migrated?
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
      processed: videos.length,
      copied,
      skipped,
      cursor: lastId,
      done: videos.length < limit,
    };
  },
});

export const rewireCommentsBatch = internalMutation({
  args: {
    cursor: v.optional(v.id("comments")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? BATCH;

    let q = ctx.db.query("comments");
    if (args.cursor) {
      q = q.filter((qb) => qb.gt(qb.field("_id"), args.cursor!));
    }
    const comments = await q.take(limit);

    let updated = 0;
    let skipped = 0;
    let orphaned = 0;
    let lastId: Id<"comments"> | undefined = undefined;

    for (const comment of comments) {
      lastId = comment._id;

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
      processed: comments.length,
      updated,
      skipped,
      orphaned,
      cursor: lastId,
      done: comments.length < limit,
    };
  },
});

export const rewireShareLinksBatch = internalMutation({
  args: {
    cursor: v.optional(v.id("shareLinks")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? BATCH;

    let q = ctx.db.query("shareLinks");
    if (args.cursor) {
      q = q.filter((qb) => qb.gt(qb.field("_id"), args.cursor!));
    }
    const links = await q.take(limit);

    let updated = 0;
    let skipped = 0;
    let orphaned = 0;
    let lastId: Id<"shareLinks"> | undefined = undefined;

    for (const link of links) {
      lastId = link._id;

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
      processed: links.length,
      updated,
      skipped,
      orphaned,
      cursor: lastId,
      done: links.length < limit,
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
