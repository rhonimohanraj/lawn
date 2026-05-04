/**
 * Internal queries + mutations called by `convex/assetRecovery.ts`.
 *
 * Split into a separate file because `assetRecovery.ts` runs in the Node
 * runtime (`"use node"`) for the AWS SDK XML parser, and Convex doesn't
 * allow `internalQuery` / `internalMutation` definitions in node-runtime
 * files.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { classifyAssetKind } from "./assetKind";
import type { Id } from "./_generated/dataModel";

export const getExistingAssetIds = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const all = await ctx.db.query("assets").collect();
    return all.map((a) => a._id as string);
  },
});

export const findOrCreateRecoveryProject = internalMutation({
  args: { teamId: v.id("teams") },
  handler: async (ctx, args): Promise<Id<"projects">> => {
    const existing = await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .collect();
    const found = existing.find((p) => p.name === "Recovered Assets");
    if (found) return found._id;

    return await ctx.db.insert("projects", {
      teamId: args.teamId,
      name: "Recovered Assets",
      description:
        "Assets restored from B2 after a project deletion. Re-organize into the right projects/folders, then drop this holding project.",
    });
  },
});

export const findTeamBySlug = internalQuery({
  args: { teamSlug: v.string() },
  handler: async (ctx, args) => {
    const slug = args.teamSlug;
    const team = await ctx.db
      .query("teams")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (!team) return null;
    return { _id: team._id, name: team.name, ownerClerkId: team.ownerClerkId };
  },
});

export const generateRecoveryPublicId = internalMutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    for (let i = 0; i < 5; i++) {
      const candidate = Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const conflict = await ctx.db
        .query("assets")
        .withIndex("by_public_id", (q) => q.eq("publicId", candidate))
        .unique();
      if (!conflict) return candidate;
    }
    throw new Error("Failed to generate unique publicId after 5 tries.");
  },
});

export const insertRecoveredAsset = internalMutation({
  args: {
    projectId: v.id("projects"),
    s3Key: v.string(),
    fileSize: v.number(),
    contentType: v.string(),
    title: v.string(),
    publicId: v.string(),
    uploadedByClerkId: v.string(),
  },
  handler: async (ctx, args) => {
    const kind = classifyAssetKind({
      contentType: args.contentType,
      filename: args.title,
    });

    const assetId = await ctx.db.insert("assets", {
      projectId: args.projectId,
      folderId: undefined,
      assetKind: kind,
      uploadedByClerkId: args.uploadedByClerkId,
      uploaderName: "Recovered",
      title: args.title,
      description: "Recovered from B2 storage after project deletion.",
      visibility: "public",
      publicId: args.publicId,
      muxAssetStatus: undefined,
      s3Key: args.s3Key,
      duration: undefined,
      thumbnailUrl: undefined,
      fileSize: args.fileSize,
      contentType: args.contentType,
      status: "ready",
      workflowStatus: "review",
      lastModifiedAt: Date.now(),
    });
    return assetId;
  },
});
