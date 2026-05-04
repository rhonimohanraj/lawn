/**
 * Cleanup mutations for the Frame.io → Frame migration's leftover
 * cruft. The migration retried failed uploads up to 8 times for some
 * files, which left:
 *
 *   Phase 1 — Pure stubs:        status=uploading AND fileSize falsy.
 *                                 Row was created but no content was
 *                                 ever uploaded. Pure noise.
 *   Phase 2 — Stuck uploading:   status=uploading BUT s3Key + fileSize
 *                                 are present. The B2 upload completed
 *                                 but `markAssetReady` was never called.
 *                                 Patch status → "ready".
 *   Phase 3 — Ready duplicates:  multiple ready rows under the same
 *                                 (projectId, title, fileSize) group.
 *                                 Keep one canonical, delete the rest.
 *                                 Canonical preference:
 *                                   1. earliest _creationTime
 *                                   2. tiebreaker: lexicographically
 *                                      smallest _id
 *
 * All three phases respect a `limit` to keep mutations under Convex's
 * transaction budget. They return {processed, remaining} so the caller
 * can re-invoke until remaining = 0.
 *
 * Phase 1 + 2 are safe to run unattended (no irreversible decisions).
 * Phase 3 is also safe given the heuristic — the dropped row's
 * underlying B2 file is left in place, so worst case there's redundant
 * storage but no data loss.
 */

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

const DEFAULT_LIMIT = 500;

/** Phase 1: delete pure stubs (status=uploading + fileSize falsy). */
export const phase1DeleteStubs = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const all = await ctx.db.query("assets").collect();
    const stubs = all.filter(
      (a) => a.status === "uploading" && (!a.fileSize || a.fileSize === 0),
    );

    const toDelete = stubs.slice(0, limit);
    for (const a of toDelete) {
      await ctx.db.delete(a._id);
    }
    return {
      processed: toDelete.length,
      remaining: stubs.length - toDelete.length,
      totalCandidates: stubs.length,
    };
  },
});

/** Phase 2: flip stuck-uploading rows (have s3Key + fileSize) to ready. */
export const phase2PatchStuckUploading = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const all = await ctx.db.query("assets").collect();
    const stuck = all.filter(
      (a) =>
        a.status === "uploading" &&
        !!a.s3Key &&
        !!a.fileSize &&
        a.fileSize > 0,
    );

    const toPatch = stuck.slice(0, limit);
    for (const a of toPatch) {
      await ctx.db.patch(a._id, { status: "ready" });
    }
    return {
      processed: toPatch.length,
      remaining: stuck.length - toPatch.length,
      totalCandidates: stuck.length,
    };
  },
});

/** Phase 3: dedupe ready rows that share (projectId, title, fileSize).
 *
 *  Group key intentionally INCLUDES fileSize so we don't accidentally
 *  merge files that share a title but are actually different — e.g.
 *  `STRONG-Stack-rev.png` (16 KB) vs `STRONG-Stack-rev.ai` (1.2 MB)
 *  parsed as the same title due to extension stripping.
 *
 *  Canonical pick: earliest _creationTime, lexicographically smallest
 *  _id as tiebreaker. Folder placement is NOT part of the merge key —
 *  if the dup is in a different folder, that's data we'd lose. So the
 *  function refuses to dedupe across folders by default; pass
 *  `allowCrossFolder: true` to opt in. */
export const phase3DedupeReady = internalMutation({
  args: {
    limit: v.optional(v.number()),
    allowCrossFolder: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const allowCrossFolder = args.allowCrossFolder ?? false;
    const all = await ctx.db.query("assets").collect();
    const ready = all.filter((a) => a.status === "ready");

    type Group = typeof ready;
    const byKey = new Map<string, Group>();
    for (const a of ready) {
      const key = `${a.projectId}|${a.title}|${a.fileSize ?? "null"}`;
      const arr = byKey.get(key) ?? [];
      arr.push(a);
      byKey.set(key, arr);
    }

    let candidatesToDrop = 0;
    let crossFolderSkipped = 0;
    let processed = 0;

    for (const [, group] of byKey) {
      if (group.length < 2) continue;

      const folders = new Set(group.map((a) => (a.folderId as string | undefined) ?? "<root>"));
      if (folders.size > 1 && !allowCrossFolder) {
        crossFolderSkipped += group.length - 1;
        continue;
      }

      // Pick canonical: earliest _creationTime, then lex-min _id
      const canonical = group.reduce((best, a) => {
        if (a._creationTime < best._creationTime) return a;
        if (a._creationTime > best._creationTime) return best;
        return (a._id as string) < (best._id as string) ? a : best;
      });

      for (const a of group) {
        if (a._id === canonical._id) continue;
        candidatesToDrop++;
        if (processed < limit) {
          await ctx.db.delete(a._id);
          processed++;
        }
      }
      if (processed >= limit) break;
    }

    return {
      processed,
      remaining: candidatesToDrop - processed,
      totalCandidates: candidatesToDrop,
      crossFolderSkipped,
    };
  },
});

/** Phase 4: handle status=failed rows that DO have full content
 *  (s3Key + fileSize). The Mux processing failed but the original B2
 *  file is intact, so they're playable as image/audio/doc — and for
 *  videos the `<video>` original-fallback already handles this.
 *  Patch status → "ready" so they appear in the dashboard normally. */
export const phase4PatchFailedWithContent = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? DEFAULT_LIMIT;
    const all = await ctx.db.query("assets").collect();
    const failed = all.filter(
      (a) =>
        a.status === "failed" &&
        !!a.s3Key &&
        !!a.fileSize &&
        a.fileSize > 0,
    );
    const toPatch = failed.slice(0, limit);
    for (const a of toPatch) {
      await ctx.db.patch(a._id, {
        status: "ready",
        uploadError: undefined,
      });
    }
    return {
      processed: toPatch.length,
      remaining: failed.length - toPatch.length,
      totalCandidates: failed.length,
    };
  },
});

/** Delete a specific asset row by id. Used for one-off cross-folder
 *  dup decisions where the user picks which row to drop. */
export const deleteAssetById = internalMutation({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.assetId);
    if (!a) return { deleted: false, reason: "missing" } as const;
    await ctx.db.delete(args.assetId);
    return {
      deleted: true,
      title: a.title,
      s3Key: a.s3Key ?? null,
    } as const;
  },
});

/** Quick stats for the four cleanup phases. */
export const cleanupStatus = internalMutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("assets").collect();
    const stubs = all.filter(
      (a) => a.status === "uploading" && (!a.fileSize || a.fileSize === 0),
    );
    const stuck = all.filter(
      (a) =>
        a.status === "uploading" &&
        !!a.s3Key &&
        !!a.fileSize &&
        a.fileSize > 0,
    );
    const failedWithContent = all.filter(
      (a) =>
        a.status === "failed" &&
        !!a.s3Key &&
        !!a.fileSize &&
        a.fileSize > 0,
    );

    const ready = all.filter((a) => a.status === "ready");
    const byKey = new Map<string, number>();
    for (const a of ready) {
      const key = `${a.projectId}|${a.title}|${a.fileSize ?? "null"}`;
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    let dupExcess = 0;
    let dupGroups = 0;
    for (const v of byKey.values()) {
      if (v > 1) {
        dupGroups++;
        dupExcess += v - 1;
      }
    }

    return {
      total: all.length,
      ready: ready.length,
      stubs: stubs.length,
      stuckUploading: stuck.length,
      failedWithContent: failedWithContent.length,
      readyDupGroups: dupGroups,
      readyDupExcess: dupExcess,
    };
  },
});
