/**
 * Scope resolution for share links.
 *
 * A share link covers one of three scopes:
 *   - asset    (link.assetId set)        — single asset; legacy/single-share
 *   - folder   (link.folderId set)       — that folder + every descendant
 *   - project  (link.projectId set)      — every folder/asset in the project
 *
 * Every read/comment path that grants access via a share token funnels
 * through `assetIsInShareScope` so adding a fourth scope later is a
 * single-helper change.
 */

import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";

type ReadCtx = QueryCtx | MutationCtx;

export type ShareScope =
  | { kind: "asset"; assetId: Id<"assets"> }
  | { kind: "folder"; folderId: Id<"folders"> }
  | { kind: "project"; projectId: Id<"projects"> }
  | { kind: "invalid" };

/** Inspect a shareLink row and return its scope. */
export function shareLinkScope(link: Doc<"shareLinks">): ShareScope {
  if (link.assetId) return { kind: "asset", assetId: link.assetId };
  if (link.folderId) return { kind: "folder", folderId: link.folderId };
  if (link.projectId) return { kind: "project", projectId: link.projectId };
  return { kind: "invalid" };
}

/**
 * Walk an asset's folder ancestors looking for the target folderId.
 * Returns true if `targetFolderId` is the asset's direct folder OR an
 * ancestor of it. Bounded by MAX_DEPTH to prevent runaway loops on
 * corrupted parent chains.
 */
async function folderIsAncestorOfAsset(
  ctx: ReadCtx,
  asset: Doc<"assets">,
  targetFolderId: Id<"folders">,
): Promise<boolean> {
  const MAX_DEPTH = 64;
  let cursor: Id<"folders"> | undefined = asset.folderId;
  let steps = 0;

  while (cursor) {
    if (steps++ > MAX_DEPTH) return false;
    if (cursor === targetFolderId) return true;
    const folder = await ctx.db.get(cursor);
    if (!folder) return false;
    cursor = folder.parentFolderId;
  }
  return false;
}

/** Resolve the project root id for a shared scope. Used to enforce that
 *  asset lookups stay within the share's project even before scope check. */
export async function shareScopeProjectId(
  ctx: ReadCtx,
  link: Doc<"shareLinks">,
): Promise<Id<"projects"> | null> {
  const scope = shareLinkScope(link);
  switch (scope.kind) {
    case "asset": {
      const asset = await ctx.db.get(scope.assetId);
      return asset?.projectId ?? null;
    }
    case "folder": {
      const folder = await ctx.db.get(scope.folderId);
      return folder?.projectId ?? null;
    }
    case "project":
      return scope.projectId;
    case "invalid":
      return null;
  }
}

/**
 * Check whether `asset` is reachable under `link`'s scope. Caller must have
 * already verified the link's expiry/lock/grant — this only checks scope
 * containment.
 */
export async function assetIsInShareScope(
  ctx: ReadCtx,
  asset: Doc<"assets">,
  link: Doc<"shareLinks">,
): Promise<boolean> {
  const scope = shareLinkScope(link);
  switch (scope.kind) {
    case "asset":
      return asset._id === scope.assetId;
    case "folder": {
      // Folder must belong to the same project, and asset must be at or
      // below that folder.
      const folder = await ctx.db.get(scope.folderId);
      if (!folder) return false;
      if (asset.projectId !== folder.projectId) return false;
      return folderIsAncestorOfAsset(ctx, asset, scope.folderId);
    }
    case "project":
      return asset.projectId === scope.projectId;
    case "invalid":
      return false;
  }
}

/**
 * For folder/project shares, the share page browses folders. This validates
 * a folder is within the share's scope (so the client can't request a
 * sibling folder by id).
 */
export async function folderIsInShareScope(
  ctx: ReadCtx,
  folder: Doc<"folders">,
  link: Doc<"shareLinks">,
): Promise<boolean> {
  const scope = shareLinkScope(link);
  switch (scope.kind) {
    case "asset":
      return false;
    case "folder": {
      if (folder._id === scope.folderId) return true;
      // Walk up: folder is in scope iff scope.folderId is an ancestor.
      let cursor: Id<"folders"> | undefined = folder.parentFolderId;
      let steps = 0;
      while (cursor) {
        if (steps++ > 64) return false;
        if (cursor === scope.folderId) return true;
        const f = await ctx.db.get(cursor);
        if (!f) return false;
        cursor = f.parentFolderId;
      }
      return false;
    }
    case "project":
      return folder.projectId === scope.projectId;
    case "invalid":
      return false;
  }
}
