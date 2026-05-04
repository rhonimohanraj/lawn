"use node";

/**
 * Recover Convex `assets` rows for B2 objects that lost their database row.
 *
 * Background: `projects.remove` cascade-deletes every asset row when a
 * project is deleted, but the underlying B2 (Backblaze) media is never
 * touched. After an accidental project delete, the videos still exist in
 * B2 (and Mux still has the playback rendition). This module rebuilds the
 * missing Convex rows by:
 *
 *   1. Listing every `assets/<id>/...` object in the B2 bucket.
 *   2. Comparing against currently-living Convex `assets` row ids.
 *   3. For each orphan: HEAD the B2 object to read size + content-type,
 *      classify the asset kind from the filename, and insert a fresh
 *      `assets` row pointing at the original B2 key.
 *
 * What survives recovery:
 *   - The B2 file (download still works via signed URL).
 *   - Asset metadata: title (from filename), size, content-type, kind.
 *
 * What does NOT survive:
 *   - Comments — those were cascade-deleted with the project and have no
 *     B2 trace.
 *   - Mux playback IDs — recovered rows have no muxPlaybackId, so
 *     in-browser playback is broken until the asset is re-processed
 *     through Mux. The original file is still downloadable, and a
 *     follow-up "re-process to Mux" action can rebuild playback.
 *   - Folder placement — orphans land in a single "Recovered Assets"
 *     project at the team root; the user re-organizes manually.
 *
 * Run via:
 *   bunx convex run --prod assetRecovery:countOrphans
 *   bunx convex run --prod assetRecovery:recoverOrphans \
 *     '{"teamSlug":"tf-tps-team", "limit": 50}'
 *   (re-run until {processed: 0})
 */

import { v } from "convex/values";
import {
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { BUCKET_NAME, getS3Client } from "./s3";
import type { Id } from "./_generated/dataModel";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** B2 keys look like `assets/<assetId>/<filename>`. Extract the asset id;
 *  return null for keys that don't match (legacy paths, unrelated files). */
function parseAssetIdFromKey(key: string): string | null {
  const match = key.match(/^assets\/([^/]+)\//);
  return match ? match[1] : null;
}

/** Best-effort title from a B2 key — the filename portion, decoded. */
function titleFromKey(key: string): string {
  const idx = key.lastIndexOf("/");
  const filename = idx >= 0 ? key.slice(idx + 1) : key;
  try {
    return decodeURIComponent(filename);
  } catch {
    return filename;
  }
}

// ─── Public-facing actions ──────────────────────────────────────────────────
// (Internal helpers live in convex/assetRecoveryHelpers.ts because this
// file is "use node" and Convex disallows query/mutation in Node files.)

export const countOrphans = internalAction({
  args: {},
  returns: v.object({
    bucket: v.string(),
    totalKeys: v.number(),
    parseableKeys: v.number(),
    distinctAssetIds: v.number(),
    existingAssetIds: v.number(),
    orphanAssetIds: v.number(),
  }),
  handler: async (ctx) => {
    const s3 = getS3Client();
    const seenAssetIds = new Set<string>();
    let totalKeys = 0;
    let parseableKeys = 0;
    let continuationToken: string | undefined = undefined;

    do {
      const out: any = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET_NAME,
          Prefix: "assets/",
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const obj of out.Contents ?? []) {
        const key = obj.Key;
        if (!key) continue;
        totalKeys++;
        const id = parseAssetIdFromKey(key);
        if (id) {
          parseableKeys++;
          seenAssetIds.add(id);
        }
      }
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);

    const existing: string[] = await ctx.runQuery(
      internal.assetRecoveryHelpers.getExistingAssetIds,
      {},
    );
    const existingSet = new Set(existing);

    let orphanCount = 0;
    for (const id of seenAssetIds) {
      if (!existingSet.has(id)) orphanCount++;
    }

    return {
      bucket: BUCKET_NAME,
      totalKeys,
      parseableKeys,
      distinctAssetIds: seenAssetIds.size,
      existingAssetIds: existing.length,
      orphanAssetIds: orphanCount,
    };
  },
});

export const recoverOrphans = internalAction({
  args: {
    teamSlug: v.string(),
    /** Cap the batch — re-run until processed=0. Defaults to 50. */
    limit: v.optional(v.number()),
  },
  returns: v.object({
    processed: v.number(),
    inserted: v.number(),
    skipped: v.number(),
    errors: v.number(),
    remaining: v.number(),
    sampleErrors: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;

    const team = await ctx.runQuery(
      internal.assetRecoveryHelpers.findTeamBySlug,
      { teamSlug: args.teamSlug },
    );
    if (!team) {
      throw new Error(`Team not found: ${args.teamSlug}`);
    }

    const recoveryProjectId: Id<"projects"> = await ctx.runMutation(
      internal.assetRecoveryHelpers.findOrCreateRecoveryProject,
      { teamId: team._id },
    );

    const existing: string[] = await ctx.runQuery(
      internal.assetRecoveryHelpers.getExistingAssetIds,
      {},
    );
    const existingSet = new Set(existing);

    // Walk B2 again, collect (assetId, key) pairs for orphans only —
    // first occurrence of each id wins, since one asset can have
    // multiple objects (original + thumbnails). Prefer the largest
    // file (likely the source media).
    const s3 = getS3Client();
    type Candidate = { key: string; size: number; lastModified: number };
    const orphanByAssetId = new Map<string, Candidate>();

    let continuationToken: string | undefined = undefined;
    do {
      const out: any = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET_NAME,
          Prefix: "assets/",
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );
      for (const obj of out.Contents ?? []) {
        const key = obj.Key as string | undefined;
        const size = (obj.Size as number | undefined) ?? 0;
        const lm = obj.LastModified
          ? new Date(obj.LastModified as Date).getTime()
          : 0;
        if (!key) continue;
        const id = parseAssetIdFromKey(key);
        if (!id || existingSet.has(id)) continue;
        const prev = orphanByAssetId.get(id);
        if (!prev || size > prev.size) {
          orphanByAssetId.set(id, { key, size, lastModified: lm });
        }
      }
      continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (continuationToken);

    const allOrphans = Array.from(orphanByAssetId.entries());
    const batch = allOrphans.slice(0, limit);

    let inserted = 0;
    let skipped = 0;
    let errors = 0;
    const sampleErrors: string[] = [];

    for (const [assetId, candidate] of batch) {
      try {
        const head: any = await s3.send(
          new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: candidate.key,
          }),
        );
        const contentType = (head.ContentType as string) || "application/octet-stream";
        const fileSize = (head.ContentLength as number) ?? candidate.size;
        const title = titleFromKey(candidate.key);

        const publicId: string = await ctx.runMutation(
          internal.assetRecoveryHelpers.generateRecoveryPublicId,
          {},
        );

        await ctx.runMutation(internal.assetRecoveryHelpers.insertRecoveredAsset, {
          projectId: recoveryProjectId,
          s3Key: candidate.key,
          fileSize,
          contentType,
          title,
          publicId,
          uploadedByClerkId: team.ownerClerkId,
        });
        inserted++;
      } catch (e) {
        errors++;
        const msg = e instanceof Error ? e.message : String(e);
        if (sampleErrors.length < 5) {
          sampleErrors.push(`${assetId}: ${msg}`);
        }
      }
      // assetId variable unused here but kept for clarity.
      void assetId;
    }

    skipped = batch.length - inserted - errors;

    return {
      processed: batch.length,
      inserted,
      skipped,
      errors,
      remaining: Math.max(0, allOrphans.length - batch.length),
      sampleErrors,
    };
  },
});
