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

/** Patch a Convex row's s3Key to point at the actual B2 location.
 *  Used by the fixBrokenS3Keys action to repair rows whose s3Key
 *  references a non-existent path (typical case: row says
 *  "assets/<id>/foo.mp4" but B2 has the file at "videos/<id>/foo.mp4"
 *  because the videos→assets rename was code-only, never re-keyed
 *  the bucket). */
export const repairAssetS3Key = internalMutation({
  args: {
    assetId: v.id("assets"),
    newS3Key: v.string(),
  },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get(args.assetId);
    if (!asset) return { patched: false, reason: "missing" } as const;
    if (asset.s3Key === args.newS3Key) {
      return { patched: false, reason: "noop" } as const;
    }
    await ctx.db.patch(args.assetId, { s3Key: args.newS3Key });
    return { patched: true } as const;
  },
});

/** Set of every Convex `s3Key` currently in use. The recovery action
 *  uses this to skip B2 keys we've already given a row to (otherwise
 *  every batch would re-recover the same first N orphans and we'd
 *  end up with 36 duplicates per real recovery — speaking from
 *  experience). */
export const getExistingS3Keys = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const all = await ctx.db.query("assets").collect();
    const keys: string[] = [];
    for (const a of all) {
      if (a.s3Key) keys.push(a.s3Key);
    }
    return keys;
  },
});

/** Drop the empty "Recovered Assets" holding project. Used to clean up
 *  after cross-project dedupe leaves it empty (or near-empty). Hard
 *  delete — assets in it are wiped too, but that should be 0 by this
 *  point. */
export const removeRecoveryProject = internalMutation({
  args: {},
  handler: async (ctx) => {
    const recoveryProjects = await ctx.db
      .query("projects")
      .filter((q) => q.eq(q.field("name"), "Recovered Assets"))
      .collect();
    let deletedAssets = 0;
    let deletedProjects = 0;
    for (const project of recoveryProjects) {
      const assets = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const a of assets) {
        await ctx.db.delete(a._id);
        deletedAssets++;
      }
      await ctx.db.delete(project._id);
      deletedProjects++;
    }
    return { deletedAssets, deletedProjects };
  },
});

/** Cross-project dedupe: when an asset row exists in any project AND a
 *  duplicate exists in the "Recovered Assets" project pointing at the
 *  same s3Key, keep the one in the proper project and drop the
 *  Recovered Assets copy. This catches the case where the recovery
 *  action created a duplicate of a row that already lived elsewhere. */
export const dedupeAcrossProjects = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 1000;

    const recoveryProjects = await ctx.db
      .query("projects")
      .filter((q) => q.eq(q.field("name"), "Recovered Assets"))
      .collect();
    const recoveryProjectIds = new Set(
      recoveryProjects.map((p) => p._id as string),
    );
    if (recoveryProjectIds.size === 0) {
      return { deleted: 0, totalRecoveredRows: 0 };
    }

    const allAssets = await ctx.db.query("assets").collect();
    const byKey = new Map<string, typeof allAssets>();
    for (const a of allAssets) {
      if (!a.s3Key) continue;
      const arr = byKey.get(a.s3Key) ?? [];
      arr.push(a);
      byKey.set(a.s3Key, arr);
    }

    let deleted = 0;
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      // If at least one row is in a non-recovery project, that's the
      // canonical one — drop every Recovered Assets duplicate.
      const inRealProject = group.some(
        (a) => !recoveryProjectIds.has(a.projectId as string),
      );
      if (!inRealProject) continue;
      for (const a of group) {
        if (deleted >= limit) break;
        if (recoveryProjectIds.has(a.projectId as string)) {
          await ctx.db.delete(a._id);
          deleted++;
        }
      }
      if (deleted >= limit) break;
    }

    let totalRecoveredRows = 0;
    for (const project of recoveryProjects) {
      const remaining = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      totalRecoveredRows += remaining.length;
    }

    return { deleted, totalRecoveredRows };
  },
});

/** Remove duplicate "Recovered Assets" rows that share the same s3Key.
 *  Keeps the lowest _id per s3Key. Caps the per-call work so we don't
 *  blow the mutation transaction budget on huge dedupes. */
export const dedupeRecoveredS3Keys = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500;

    // Find the "Recovered Assets" project across all teams.
    const recoveryProjects = await ctx.db
      .query("projects")
      .filter((q) => q.eq(q.field("name"), "Recovered Assets"))
      .collect();

    let deleted = 0;
    for (const project of recoveryProjects) {
      if (deleted >= limit) break;
      const assets = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();

      const byKey = new Map<string, typeof assets>();
      for (const a of assets) {
        if (!a.s3Key) continue;
        const arr = byKey.get(a.s3Key) ?? [];
        arr.push(a);
        byKey.set(a.s3Key, arr);
      }

      for (const group of byKey.values()) {
        if (group.length < 2) continue;
        const survivor = group.reduce((min, a) =>
          a._id < min._id ? a : min,
        );
        for (const a of group) {
          if (a._id === survivor._id) continue;
          if (deleted >= limit) break;
          await ctx.db.delete(a._id);
          deleted++;
        }
        if (deleted >= limit) break;
      }
    }

    // Return so the caller knows whether to re-run.
    let totalRecovered = 0;
    for (const project of recoveryProjects) {
      const remaining = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      totalRecovered += remaining.length;
    }

    return { deleted, totalRecoveredRows: totalRecovered };
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
