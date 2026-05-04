/**
 * Activity tracking helpers — denormalized size + lastModifiedAt propagation.
 *
 * Every asset/folder/comment mutation calls into here so that:
 *   - folders.sizeBytes = sum(own assets) + sum(descendant folder sizes)
 *   - projects.sizeBytes = sum across all project folders + root assets
 *   - lastModifiedAt bubbles up from leaf activity to root project
 *
 * Single chain walk per call: bumpChain visits each ancestor folder once,
 * patches both size delta + timestamp in one ctx.db.patch.
 *
 * Why denormalized: computing folder size on every read by walking descendants
 * is O(tree) per query. Denormalizing is O(depth) per write — and writes are
 * rare relative to reads in this product.
 */

import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const now = () => Date.now();

/**
 * Walk from `folderId` up to the project root, applying `sizeDelta` to each
 * folder's sizeBytes and bumping lastModifiedAt to now. Then update the project
 * row the same way. `folderId === undefined` means start at the project root,
 * skipping folder traversal.
 */
async function bumpChain(
  ctx: MutationCtx,
  folderId: Id<"folders"> | undefined,
  projectId: Id<"projects">,
  sizeDelta: number,
) {
  const ts = now();

  let cursor: Id<"folders"> | undefined = folderId;
  while (cursor) {
    const folder = await ctx.db.get(cursor);
    if (!folder) break;
    const updates: Partial<Doc<"folders">> = { lastModifiedAt: ts };
    if (sizeDelta !== 0) {
      updates.sizeBytes = Math.max(0, (folder.sizeBytes ?? 0) + sizeDelta);
    }
    await ctx.db.patch(folder._id, updates);
    cursor = folder.parentFolderId;
  }

  const project = await ctx.db.get(projectId);
  if (!project) return;
  const projectUpdates: Partial<Doc<"projects">> = { lastModifiedAt: ts };
  if (sizeDelta !== 0) {
    projectUpdates.sizeBytes = Math.max(0, (project.sizeBytes ?? 0) + sizeDelta);
  }
  await ctx.db.patch(projectId, projectUpdates);
}

// ─── Asset events ────────────────────────────────────────────────────────────

/** Asset row was modified (no size change). Bumps asset + ancestor chain. */
export async function touchAsset(ctx: MutationCtx, asset: Doc<"assets">) {
  await ctx.db.patch(asset._id, { lastModifiedAt: now() });
  await bumpChain(ctx, asset.folderId, asset.projectId, 0);
}

/** Lookup-then-touch helper for callers that only have the asset id. */
export async function touchAssetById(ctx: MutationCtx, assetId: Id<"assets">) {
  const asset = await ctx.db.get(assetId);
  if (!asset) return;
  await touchAsset(ctx, asset);
}

/** Asset's fileSize changed by `delta` (e.g. upload reconciled, new version). */
export async function touchAssetWithSizeDelta(
  ctx: MutationCtx,
  asset: Doc<"assets">,
  delta: number,
) {
  await ctx.db.patch(asset._id, { lastModifiedAt: now() });
  await bumpChain(ctx, asset.folderId, asset.projectId, delta);
}

/** Asset is being deleted — subtract its size from ancestors and bump them.
 *  Caller must call this BEFORE ctx.db.delete(asset._id), so we still have
 *  the row's projectId/folderId/fileSize to read. */
export async function bumpForAssetDelete(
  ctx: MutationCtx,
  asset: Doc<"assets">,
) {
  const size = asset.fileSize ?? 0;
  await bumpChain(ctx, asset.folderId, asset.projectId, -size);
}

/** Asset moved between folders. Subtracts size from the old chain and adds it
 *  to the new chain. Caller still owns the actual `folderId` patch. */
export async function bumpForAssetMove(
  ctx: MutationCtx,
  asset: Doc<"assets">,
  newFolderId: Id<"folders"> | undefined,
) {
  const size = asset.fileSize ?? 0;
  if (asset.folderId === newFolderId) {
    // No-op move — caller should have short-circuited.
    return;
  }
  // Old chain: lose size, bump timestamps.
  await bumpChain(ctx, asset.folderId, asset.projectId, -size);
  // New chain: gain size, bump timestamps.
  await bumpChain(ctx, newFolderId, asset.projectId, +size);
  // The asset itself was modified.
  await ctx.db.patch(asset._id, { lastModifiedAt: now() });
}

// ─── Folder events ───────────────────────────────────────────────────────────

/** Folder row was modified (renamed, etc — no size change). */
export async function touchFolder(ctx: MutationCtx, folder: Doc<"folders">) {
  await ctx.db.patch(folder._id, { lastModifiedAt: now() });
  await bumpChain(ctx, folder.parentFolderId, folder.projectId, 0);
}

/** A new folder was created. Bumps the parent chain (folder itself starts at
 *  size 0 / lastModifiedAt = _creationTime, no patch needed on the new row). */
export async function bumpForFolderCreate(
  ctx: MutationCtx,
  folder: Doc<"folders">,
) {
  await bumpChain(ctx, folder.parentFolderId, folder.projectId, 0);
}

/** Folder is being deleted. The schema only allows deleting empty folders, so
 *  the folder's sizeBytes should already be 0 — but we guard anyway. Bumps
 *  parent chain. Caller still owns ctx.db.delete. */
export async function bumpForFolderDelete(
  ctx: MutationCtx,
  folder: Doc<"folders">,
) {
  const size = folder.sizeBytes ?? 0;
  await bumpChain(ctx, folder.parentFolderId, folder.projectId, -size);
}

/** Folder moved to a new parent. Subtract its size from the old chain and add
 *  to the new. Folder's own sizeBytes is unchanged. */
export async function bumpForFolderMove(
  ctx: MutationCtx,
  folder: Doc<"folders">,
  newParentFolderId: Id<"folders"> | undefined,
) {
  if (folder.parentFolderId === newParentFolderId) return;
  const size = folder.sizeBytes ?? 0;
  await bumpChain(ctx, folder.parentFolderId, folder.projectId, -size);
  await bumpChain(ctx, newParentFolderId, folder.projectId, +size);
  await ctx.db.patch(folder._id, { lastModifiedAt: now() });
}
