/**
 * Restructure: collapse split projects back into Frame.io's exact shape.
 *
 * The 2026-05-02 Frame.io → Lawn migration mapped each Frame.io project's
 * top-level folder into a separate Lawn project. e.g.
 *   Frame.io: "01 Wedding Films" / "2025" / "Lara & Logan" / "Toasts.mp4"
 *   Lawn:     project="01 Wedding Films / 2025", folder="Lara & Logan",
 *             title="Toasts.mp4"
 *
 * This script collapses every "X / Y" Lawn project into a canonical "X"
 * project with `Y` re-instated as a top-level folder. The asset folder
 * tree under Y is preserved verbatim. Once all assets are moved, the
 * source split-project is dropped along with any folders that became
 * empty.
 *
 * Idempotent: re-running is safe. Run via:
 *   bunx convex run --prod restructureFrameio:inventorySplitProjects '{}'
 *   bunx convex run --prod restructureFrameio:restructureBatch '{}'
 *   bunx convex run --prod restructureFrameio:deleteEmptyMigrationFolders '{}'
 *   bunx convex run --prod restructureFrameio:deleteEmptySplitProjects '{}'
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

const SPLIT = " / ";

function isSplitName(name: string): boolean {
  return name.includes(SPLIT);
}

function parseSplitName(name: string): { canonical: string; firstFolder: string } | null {
  const idx = name.indexOf(SPLIT);
  if (idx <= 0) return null;
  return {
    canonical: name.slice(0, idx),
    firstFolder: name.slice(idx + SPLIT.length),
  };
}

async function pathFromFolderId(
  ctx: MutationCtx,
  folderId: Id<"folders"> | undefined,
): Promise<string[]> {
  const segments: string[] = [];
  let cursor = folderId;
  while (cursor) {
    const folder = await ctx.db.get(cursor);
    if (!folder) break;
    segments.unshift(folder.name);
    cursor = folder.parentFolderId;
  }
  return segments;
}

export const inventorySplitProjects = internalQuery({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    const assets = await ctx.db.query("assets").collect();
    const assetCounts = new Map<string, number>();
    for (const a of assets) {
      assetCounts.set(a.projectId, (assetCounts.get(a.projectId) ?? 0) + 1);
    }

    const splitProjects = projects
      .filter((p) => isSplitName(p.name))
      .map((p) => ({
        _id: p._id,
        name: p.name,
        teamId: p.teamId,
        assetCount: assetCounts.get(p._id) ?? 0,
        canonical: parseSplitName(p.name)?.canonical,
        firstFolder: parseSplitName(p.name)?.firstFolder,
      }));

    const canonicalProjects = projects
      .filter((p) => !isSplitName(p.name))
      .map((p) => ({
        _id: p._id,
        name: p.name,
        teamId: p.teamId,
        assetCount: assetCounts.get(p._id) ?? 0,
      }));

    return {
      totalProjects: projects.length,
      splitCount: splitProjects.length,
      splitProjects,
      canonicalCount: canonicalProjects.length,
      canonicalProjects,
    };
  },
});

/**
 * Process one split project per call. Moves all of its assets into the
 * canonical project (creating it if missing) under a folder hierarchy
 * that prefixes the original first-level folder name. Returns whether
 * more split projects remain.
 */
export const restructureBatch = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 1;

    const allProjects = await ctx.db.query("projects").collect();

    // Build a "has assets" set so we skip already-emptied split projects.
    const splitProjects = allProjects.filter((p) => isSplitName(p.name));
    const projectsWithAssets: typeof splitProjects = [];
    for (const sp of splitProjects) {
      const sample = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", sp._id))
        .take(1);
      if (sample.length > 0) projectsWithAssets.push(sp);
    }

    if (projectsWithAssets.length === 0) {
      return { processed: 0, assetsMoved: 0, projectsHandled: [], remaining: 0, done: true };
    }

    let processed = 0;
    let assetsMoved = 0;
    const projectsHandled: string[] = [];

    for (const splitProj of projectsWithAssets) {
      if (processed >= limit) break;
      const parsed = parseSplitName(splitProj.name);
      if (!parsed) continue;

      // Find or create canonical project under the same team.
      let canonical = allProjects.find(
        (p) => !isSplitName(p.name) && p.teamId === splitProj.teamId && p.name === parsed.canonical,
      );
      if (!canonical) {
        const newId = await ctx.db.insert("projects", {
          teamId: splitProj.teamId,
          name: parsed.canonical,
        });
        canonical = (await ctx.db.get(newId))!;
      }

      // Move all assets from splitProj → canonical, prefixing folder path
      // with the split project's "first folder" segment.
      const assets = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", splitProj._id))
        .collect();

      for (const asset of assets) {
        const subpath = await pathFromFolderId(ctx, asset.folderId);
        const newPathSegments = [parsed.firstFolder, ...subpath];
        const ensured = await ctx.runMutation(internal.folders.ensurePath, {
          projectId: canonical._id,
          path: newPathSegments.join("/"),
          actorClerkId: "migration:frameio",
        });
        const newFolderId: Id<"folders"> | undefined = ensured ?? undefined;

        await ctx.db.patch(asset._id, {
          projectId: canonical._id,
          folderId: newFolderId ?? undefined,
        });
        assetsMoved++;
      }

      processed++;
      projectsHandled.push(splitProj.name);
    }

    const remainingSplit = projectsWithAssets.length - processed;
    return {
      processed,
      assetsMoved,
      projectsHandled,
      remaining: remainingSplit,
      done: remainingSplit === 0,
    };
  },
});

const MIGRATION_CLERK_ID = "migration:frameio";

/**
 * Migration-scoped folder cleanup. Loads only rows where
 * createdByClerkId === MIGRATION_CLERK_ID and deletes those that are
 * empty (no child folders, no child assets). Real user folders have a
 * Clerk subject like `user_abc123` and are never selected.
 *
 * Multi-pass so deleting a leaf can make its parent a leaf. Idempotent.
 */
export const deleteEmptyMigrationFolders = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 500;

    const folders = await ctx.db
      .query("folders")
      .filter((q) => q.eq(q.field("createdByClerkId"), MIGRATION_CLERK_ID))
      .collect();
    let deleted = 0;
    let scanned = 0;
    let preservedNonMigration = 0;

    // Multiple passes — deleting a leaf folder may make its parent a leaf.
    let changed = true;
    while (changed && deleted < limit) {
      changed = false;
      for (const folder of folders) {
        if (deleted >= limit) break;
        scanned++;
        const fresh = await ctx.db.get(folder._id);
        if (!fresh) continue;
        // Defense in depth — re-check after fresh load.
        if (fresh.createdByClerkId !== MIGRATION_CLERK_ID) {
          preservedNonMigration++;
          continue;
        }

        const children = await ctx.db
          .query("folders")
          .withIndex("by_parent", (q) => q.eq("parentFolderId", folder._id))
          .collect();
        if (children.length > 0) continue;

        const childAssets = await ctx.db
          .query("assets")
          .withIndex("by_folder", (q) => q.eq("folderId", folder._id))
          .collect();
        if (childAssets.length > 0) continue;

        await ctx.db.delete(folder._id);
        deleted++;
        changed = true;
      }
    }

    const stillThere = await ctx.db.query("folders").collect();
    return {
      deleted,
      scanned,
      preservedNonMigration,
      remainingFolders: stillThere.length,
    };
  },
});

/**
 * Delete projects that have no assets and no folders. Used to clean up
 * the now-emptied split projects after restructureBatch. Won't touch
 * canonical projects that still hold assets.
 */
export const deleteEmptySplitProjects = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    let deleted = 0;
    const removed: string[] = [];

    for (const p of projects) {
      // Only delete split-named, empty ones — never touch canonicals.
      if (!isSplitName(p.name)) continue;

      const assets = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", p._id))
        .take(1);
      if (assets.length > 0) continue;

      const folders = await ctx.db
        .query("folders")
        .withIndex("by_project", (q) => q.eq("projectId", p._id))
        .take(1);
      if (folders.length > 0) continue;

      await ctx.db.delete(p._id);
      removed.push(p.name);
      deleted++;
    }

    return { deleted, removed };
  },
});

/**
 * Delete empty projects that duplicate a non-empty sibling. The original
 * migration's race condition created multiple `Project` rows with the
 * same name when concurrent uploads called createProject simultaneously.
 * This collapses the empty duplicates while leaving legitimate empty
 * projects (new projects awaiting first upload) alone.
 */
export const deleteEmptyDuplicateProjects = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();

    // Group by (teamId, name).
    const byKey = new Map<string, typeof projects>();
    for (const p of projects) {
      const key = `${p.teamId}::${p.name}`;
      const arr = byKey.get(key) ?? [];
      arr.push(p);
      byKey.set(key, arr);
    }

    let deleted = 0;
    const removed: string[] = [];

    for (const group of byKey.values()) {
      if (group.length < 2) continue;

      // Check each one's content; collect empty ones, but only delete
      // if at least one in the group has content.
      const withContent: typeof group = [];
      const empty: typeof group = [];
      for (const p of group) {
        const assetSample = await ctx.db
          .query("assets")
          .withIndex("by_project", (q) => q.eq("projectId", p._id))
          .take(1);
        const folderSample = await ctx.db
          .query("folders")
          .withIndex("by_project", (q) => q.eq("projectId", p._id))
          .take(1);
        if (assetSample.length === 0 && folderSample.length === 0) {
          empty.push(p);
        } else {
          withContent.push(p);
        }
      }
      if (withContent.length === 0) continue; // none have content, leave alone

      for (const p of empty) {
        await ctx.db.delete(p._id);
        removed.push(p.name);
        deleted++;
      }
    }

    return { deleted, removed };
  },
});

/**
 * Final shape verification: list every canonical project with its
 * folder count + asset count + a small sample of folder names.
 */
export const verifyShape = internalQuery({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    const result: Array<{
      name: string;
      assetCount: number;
      folderCount: number;
      topFolders: string[];
    }> = [];

    for (const p of projects) {
      const assets = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", p._id))
        .collect();
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_project", (q) => q.eq("projectId", p._id))
        .collect();
      const topFolders = folders
        .filter((f) => f.parentFolderId === undefined)
        .map((f) => f.name)
        .sort();
      result.push({
        name: p.name,
        assetCount: assets.length,
        folderCount: folders.length,
        topFolders,
      });
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  },
});
