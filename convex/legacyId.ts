/**
 * Legacy `_id` resolution for old bookmark/share URLs.
 *
 * History: every Convex asset row's `s3Key` looks like
 *   `assets/<convexAssetId>/<timestamp>.<ext>` — or, for rows that
 *   came over from the pre-rename `videos` table,
 *   `videos/<convexVideoId>/<timestamp>.<ext>`.
 *
 * Both the videos→assets table rename AND the project-deletion +
 * orphan-recovery cycle generated NEW Convex `_id`s for the same
 * underlying B2 file. So old URLs that hard-coded the original
 * Convex `_id` now 404 even though the file is still alive under
 * a different row.
 *
 * `findAssetByLegacyId` walks the assets table looking for any row
 * whose s3Key has the legacy id as its second path segment, and
 * returns the current canonical row. This is the bridge that lets
 * old URLs redirect to today's structure.
 *
 * Cost: O(N) over `assets` (~3.8k rows). Fine at this scale; if it
 * grows, denormalize a `legacyIds: string[]` field on the row + a
 * by_legacy_id index.
 */

import { v } from "convex/values";
import type { QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

const LEGACY_PREFIXES = ["assets/", "videos/"] as const;

/** Auth-bypassed test wrapper around findAssetByLegacyId. Used to smoke-
 *  test the redirect layer from the CLI without a real Clerk session. */
export const testLegacyLookup = internalQuery({
  args: { legacyId: v.string() },
  handler: async (ctx, args) => {
    const asset = await findAssetByLegacyId(ctx, args.legacyId);
    if (!asset) return null;
    return {
      newAssetId: asset._id,
      newProjectId: asset.projectId,
      title: asset.title,
      s3Key: asset.s3Key ?? null,
    };
  },
});

/** Returns the current asset whose s3Key references `legacyId` as
 *  its second path segment, or null if no such row exists. */
export async function findAssetByLegacyId(
  ctx: QueryCtx,
  legacyId: string,
): Promise<Doc<"assets"> | null> {
  if (!legacyId) return null;
  // Defensive: only accept Convex-id-shaped strings to avoid scanning
  // the table on garbage input.
  if (!/^[a-z0-9]{20,}$/.test(legacyId)) return null;

  const all = await ctx.db.query("assets").collect();
  for (const a of all) {
    if (!a.s3Key) continue;
    for (const prefix of LEGACY_PREFIXES) {
      if (a.s3Key.startsWith(`${prefix}${legacyId}/`)) {
        return a;
      }
    }
  }
  return null;
}
