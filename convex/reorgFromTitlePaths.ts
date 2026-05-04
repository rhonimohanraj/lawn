/**
 * Reorganize assets whose `title` encodes a slash-delimited folder path
 * into a real folder hierarchy.
 *
 * Background: the Frame.io migration uploaded files with their full
 * source path embedded in the asset title (e.g.
 *   `00 Strong Like a Girl/Assets/Branding/STRONG Logos/STRONG-Stack-rev.png`)
 * but never created the matching folder tree — so 641 assets sit flat
 * in `2026/` with path-strings as titles.
 *
 * This mutation:
 *   - Selects assets whose title starts with `titlePrefix`, in the
 *     given project.
 *   - For each, splits the title by "/", creates the folder chain
 *     under `destFolderId`, moves the asset into the leaf folder, and
 *     shortens the title to just the filename.
 *
 * Idempotent: re-running after a partial pass picks up where it left
 * off (assets that already have title without "/" are skipped). Folder
 * lookup is race-safe — checks for an existing sibling with the same
 * name before inserting, and reconciles concurrent inserts by keeping
 * the lowest _id.
 *
 * Returns `{processed, remaining, foldersCreated}` so the caller can
 * batch until remaining = 0.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const MAX_FOLDER_NAME = 200;
const DEFAULT_LIMIT = 80; // ~5 ops per asset worst case → ~400 ops/batch

function sanitizeName(seg: string): string {
  const trimmed = seg.trim();
  if (trimmed.length === 0) return "untitled";
  if (trimmed.length > MAX_FOLDER_NAME) {
    return trimmed.slice(0, MAX_FOLDER_NAME).replace(/\//g, "_");
  }
  return trimmed.replace(/\//g, "_");
}

async function ensureFolder(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  parentFolderId: Id<"folders"> | undefined,
  name: string,
  actorClerkId: string,
): Promise<{ id: Id<"folders">; created: boolean }> {
  const existing = await ctx.db
    .query("folders")
    .withIndex("by_project_and_parent", (q) =>
      q.eq("projectId", projectId).eq("parentFolderId", parentFolderId),
    )
    .filter((q) => q.eq(q.field("name"), name))
    .unique();
  if (existing) return { id: existing._id, created: false };

  const newId = await ctx.db.insert("folders", {
    projectId,
    parentFolderId,
    name,
    createdByClerkId: actorClerkId,
  });

  // Race reconciliation: if a concurrent insert added the same name,
  // keep the lowest _id and delete ours.
  const siblings = await ctx.db
    .query("folders")
    .withIndex("by_project_and_parent", (q) =>
      q.eq("projectId", projectId).eq("parentFolderId", parentFolderId),
    )
    .filter((q) => q.eq(q.field("name"), name))
    .collect();
  if (siblings.length > 1) {
    const survivor = siblings.reduce((min, f) =>
      f._id < min._id ? f : min,
    );
    if (survivor._id !== newId) {
      await ctx.db.delete(newId);
      return { id: survivor._id, created: false };
    }
    for (const f of siblings) {
      if (f._id !== survivor._id) await ctx.db.delete(f._id);
    }
    return { id: survivor._id, created: true };
  }
  return { id: newId, created: true };
}

export const reorgByTitlePrefix = internalMutation({
  args: {
    projectId: v.id("projects"),
    titlePrefix: v.string(),
    /** New tree's root folder. Undefined = project root. */
    destFolderId: v.optional(v.id("folders")),
    actorClerkId: v.string(),
    limit: v.optional(v.number()),
    /** Dry-run: count matches without modifying anything. */
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const dryRun = args.dryRun ?? false;

    const all = await ctx.db
      .query("assets")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const candidates = all.filter(
      (a) =>
        a.title.startsWith(args.titlePrefix) &&
        a.title.includes("/") &&
        // Already-reorged assets won't have "/" in title; this guards
        // against re-running after a partial pass.
        a.title.length > args.titlePrefix.length,
    );

    if (dryRun) {
      const sampleTree: Record<string, number> = {};
      for (const a of candidates) {
        const segs = a.title.split("/").filter((s) => s.length > 0);
        const dir = segs.slice(0, -1).join("/");
        sampleTree[dir] = (sampleTree[dir] ?? 0) + 1;
      }
      return {
        processed: 0,
        remaining: candidates.length,
        foldersCreated: 0,
        sampleTree,
      };
    }

    let processed = 0;
    let foldersCreated = 0;
    const folderCache = new Map<string, Id<"folders">>();

    for (const asset of candidates) {
      if (processed >= limit) break;

      const segments = asset.title
        .split("/")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (segments.length < 2) continue; // Need at least one folder + filename

      const filename = segments[segments.length - 1];
      const folderSegments = segments.slice(0, -1);

      // Walk/create the folder chain.
      let parentId: Id<"folders"> | undefined = args.destFolderId;
      for (let i = 0; i < folderSegments.length; i++) {
        const segName = sanitizeName(folderSegments[i]);
        const cacheKey = `${parentId ?? "<root>"}/${segName}`;
        let folderId = folderCache.get(cacheKey);
        if (!folderId) {
          const { id, created } = await ensureFolder(
            ctx,
            args.projectId,
            parentId,
            segName,
            args.actorClerkId,
          );
          folderId = id;
          folderCache.set(cacheKey, folderId);
          if (created) foldersCreated++;
        }
        parentId = folderId;
      }

      await ctx.db.patch(asset._id, {
        folderId: parentId,
        title: filename,
      });
      processed++;
    }

    const remainingAfter = Math.max(0, candidates.length - processed);
    return {
      processed,
      remaining: remainingAfter,
      foldersCreated,
      totalCandidates: candidates.length,
    };
  },
});
