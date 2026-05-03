/**
 * Migration helpers — auth-bypassed mutations used ONLY by the
 * one-shot Frame.io → Lawn migration HTTP endpoints in http.ts.
 *
 * Every public surface here is gated by a shared MIGRATION_TOKEN that
 * lives only on Convex prod (no Clerk identity required). Don't use
 * these from the browser.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { assetKindValidator } from "./schema";

const MIGRATION_CLERK_ID = "migration:frameio";
const MIGRATION_USER_NAME = "Frame.io migration";

export const lookupTeamBySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("teams")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique();
  },
});

export const listAllTeams = internalQuery({
  args: {},
  handler: async (ctx) => {
    const teams = await ctx.db.query("teams").collect();
    return teams.map((t) => ({
      _id: t._id,
      name: t.name,
      slug: t.slug,
      ownerClerkId: t.ownerClerkId,
    }));
  },
});

export const listProjectsInTeam = internalQuery({
  args: { teamId: v.id("teams") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .collect();
  },
});

export const findProjectInTeam = internalQuery({
  args: { teamId: v.id("teams"), name: v.string() },
  handler: async (ctx, args) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .collect();
    return projects.find((p) => p.name === args.name) ?? null;
  },
});

export const createProject = internalMutation({
  args: { teamId: v.id("teams"), name: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("projects", {
      teamId: args.teamId,
      name: args.name,
    });
  },
});

export const createVideoStub = internalMutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    fileSize: v.number(),
    contentType: v.string(),
    publicId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("videos", {
      projectId: args.projectId,
      uploadedByClerkId: MIGRATION_CLERK_ID,
      uploaderName: MIGRATION_USER_NAME,
      title: args.title,
      fileSize: args.fileSize,
      contentType: args.contentType,
      status: "uploading",
      muxAssetStatus: "preparing",
      workflowStatus: "review",
      visibility: "public",
      publicId: args.publicId,
    });
  },
});

export const setVideoS3Key = internalMutation({
  args: { videoId: v.id("videos"), s3Key: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.videoId, { s3Key: args.s3Key });
  },
});

export const setVideoMuxAsset = internalMutation({
  args: { videoId: v.id("videos"), muxAssetId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.videoId, {
      muxAssetId: args.muxAssetId,
      muxAssetStatus: "preparing",
      status: "processing",
    });
  },
});

export const markVideoFailed = internalMutation({
  args: { videoId: v.id("videos"), uploadError: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.videoId, {
      status: "failed",
      uploadError: args.uploadError,
    });
  },
});

export const addMigrationComment = internalMutation({
  args: {
    videoId: v.id("videos"),
    text: v.string(),
    userName: v.string(),
    timestampSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("comments", {
      videoId: args.videoId,
      userName: args.userName,
      text: args.text,
      timestampSeconds: args.timestampSeconds,
      resolved: false,
    });
  },
});

export const getVideoForMigration = internalQuery({
  args: { videoId: v.id("videos") },
  handler: async (ctx, args): Promise<Doc<"videos"> | null> => {
    return await ctx.db.get(args.videoId);
  },
});

// ───────────────────────── v2: assets-aware migration ─────────────────────────
// Same flow as the legacy createVideoStub/setVideoS3Key/etc. above, but writes
// to the new `assets` table with assetKind + folderId. Used by the
// /migration/v2/prepare + /migration/v2/complete HTTP routes.

export const createAssetStub = internalMutation({
  args: {
    projectId: v.id("projects"),
    folderId: v.optional(v.id("folders")),
    assetKind: assetKindValidator,
    title: v.string(),
    fileSize: v.number(),
    contentType: v.string(),
    publicId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("assets", {
      projectId: args.projectId,
      folderId: args.folderId,
      assetKind: args.assetKind,
      uploadedByClerkId: MIGRATION_CLERK_ID,
      uploaderName: MIGRATION_USER_NAME,
      title: args.title,
      fileSize: args.fileSize,
      contentType: args.contentType,
      status: "uploading",
      // Mux fields are populated only when assetKind === "video".
      muxAssetStatus: args.assetKind === "video" ? "preparing" : undefined,
      workflowStatus: "review",
      visibility: "public",
      publicId: args.publicId,
    });
  },
});

export const setAssetS3Key = internalMutation({
  args: { assetId: v.id("assets"), s3Key: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, { s3Key: args.s3Key });
  },
});

export const setAssetMuxAsset = internalMutation({
  args: { assetId: v.id("assets"), muxAssetId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      muxAssetId: args.muxAssetId,
      muxAssetStatus: "preparing",
      status: "processing",
    });
  },
});

export const markAssetReady = internalMutation({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      status: "ready",
      uploadError: undefined,
    });
  },
});

export const markAssetFailed = internalMutation({
  args: { assetId: v.id("assets"), uploadError: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      status: "failed",
      uploadError: args.uploadError,
    });
  },
});

export const addMigrationAssetComment = internalMutation({
  args: {
    assetId: v.id("assets"),
    text: v.string(),
    userName: v.string(),
    timestampSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("comments", {
      assetId: args.assetId,
      userName: args.userName,
      text: args.text,
      timestampSeconds: args.timestampSeconds,
      resolved: false,
    });
  },
});

export const getAssetForMigration = internalQuery({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args): Promise<Doc<"assets"> | null> => {
    return await ctx.db.get(args.assetId);
  },
});
