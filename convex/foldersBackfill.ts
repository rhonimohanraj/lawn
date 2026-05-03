/**
 * One-shot backfill: parse Frame.io-style slash paths from existing asset
 * titles into real folder hierarchies.
 *
 * The 2026-05-02 Frame.io → Lawn migration flattened folder paths into
 * titles (e.g. `"Lara & Logan/Lara & Logan Kilmury - Toasts.mp4"`). This
 * script walks all assets where `folderId === undefined` and the title
 * contains `/`, splits on `/`, materialises the folder hierarchy under
 * the asset's project via folders.ensurePath, and patches the asset to
 * point at the leaf folder + cleaned-up title (just the filename).
 *
 * Idempotent — re-running is safe. Run via:
 *   bunx convex run foldersBackfill:backfillBatch
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

const BATCH = 100;
const MIGRATION_CLERK_ID = "migration:frameio";

function parseTitle(title: string): { folderPath: string | null; cleanTitle: string } {
  const idx = title.lastIndexOf("/");
  if (idx <= 0) return { folderPath: null, cleanTitle: title };
  const cleanTitle = title.slice(idx + 1);
  // Trailing slash → empty leaf. Don't move the asset; leave as-is.
  if (!cleanTitle) return { folderPath: null, cleanTitle: title };
  return {
    folderPath: title.slice(0, idx),
    cleanTitle,
  };
}

export const backfillBatch = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? BATCH;

    const page = await ctx.db
      .query("assets")
      .paginate({ cursor: args.cursor ?? null, numItems: limit });

    let processed = 0;
    let foldered = 0;
    let alreadyFoldered = 0;
    let noSlash = 0;

    for (const asset of page.page) {
      processed++;

      if (asset.folderId !== undefined) {
        alreadyFoldered++;
        continue;
      }
      const { folderPath, cleanTitle } = parseTitle(asset.title);
      if (!folderPath) {
        noSlash++;
        continue;
      }

      const folderId = await ctx.runMutation(internal.folders.ensurePath, {
        projectId: asset.projectId,
        path: folderPath,
        actorClerkId: MIGRATION_CLERK_ID,
      });

      await ctx.db.patch(asset._id, {
        folderId: folderId ?? undefined,
        title: cleanTitle,
      });
      foldered++;
    }

    return {
      processed,
      foldered,
      alreadyFoldered,
      noSlash,
      cursor: page.continueCursor,
      done: page.isDone,
    };
  },
});

export const backfillStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("assets").collect();
    return {
      total: all.length,
      withFolder: all.filter((a) => a.folderId !== undefined).length,
      withSlashTitle: all.filter((a) => a.title.includes("/")).length,
      bothFolderAndSlash: all.filter(
        (a) => a.folderId !== undefined && a.title.includes("/"),
      ).length,
    };
  },
});
