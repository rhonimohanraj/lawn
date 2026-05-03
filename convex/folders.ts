/**
 * Nested folders inside a project. Folders form an arbitrary tree —
 * `parentFolderId === undefined` means the folder lives at the project
 * root. Assets reference a folder via `assets.folderId` (also optional;
 * undefined = at project root).
 */

import { v } from "convex/values";
import { mutation, query, internalMutation, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { identityName, requireFolderAccess, requireProjectAccess } from "./auth";

const MAX_NAME_LENGTH = 200;
const MAX_DEPTH = 32;

function sanitizeFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Folder name cannot be empty.");
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`Folder name too long (max ${MAX_NAME_LENGTH} chars).`);
  }
  if (trimmed.includes("/")) {
    throw new Error("Folder names cannot contain '/'.");
  }
  return trimmed;
}

async function assertParentBelongsToProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
  parentFolderId: Id<"folders"> | undefined,
) {
  if (!parentFolderId) return;
  const parent = await ctx.db.get(parentFolderId);
  if (!parent) {
    throw new Error("Parent folder not found.");
  }
  if (parent.projectId !== projectId) {
    throw new Error("Parent folder belongs to a different project.");
  }
}

async function depthOf(
  ctx: QueryCtx | MutationCtx,
  folderId: Id<"folders"> | undefined,
): Promise<number> {
  let depth = 0;
  let cursor = folderId;
  while (cursor) {
    if (depth > MAX_DEPTH) {
      throw new Error("Folder depth limit exceeded.");
    }
    const folder = await ctx.db.get(cursor);
    if (!folder) break;
    depth++;
    cursor = folder.parentFolderId;
  }
  return depth;
}

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    parentFolderId: v.optional(v.id("folders")),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireProjectAccess(ctx, args.projectId, "member");
    const name = sanitizeFolderName(args.name);
    await assertParentBelongsToProject(ctx, args.projectId, args.parentFolderId);

    const parentDepth = await depthOf(ctx, args.parentFolderId);
    if (parentDepth >= MAX_DEPTH) {
      throw new Error("Folder depth limit exceeded.");
    }

    // Reject duplicate sibling names (case-sensitive, exact match) to keep
    // breadcrumbs unambiguous.
    const siblings = await ctx.db
      .query("folders")
      .withIndex("by_project_and_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentFolderId", args.parentFolderId),
      )
      .collect();
    if (siblings.some((s) => s.name === name)) {
      throw new Error(`A folder named "${name}" already exists here.`);
    }

    return await ctx.db.insert("folders", {
      projectId: args.projectId,
      parentFolderId: args.parentFolderId,
      name,
      createdByClerkId: user.subject,
    });
  },
});

export const rename = mutation({
  args: {
    folderId: v.id("folders"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const { folder } = await requireFolderAccess(ctx, args.folderId, "member");
    const name = sanitizeFolderName(args.name);
    if (name === folder.name) return;

    const siblings = await ctx.db
      .query("folders")
      .withIndex("by_project_and_parent", (q) =>
        q.eq("projectId", folder.projectId).eq("parentFolderId", folder.parentFolderId),
      )
      .collect();
    if (siblings.some((s) => s._id !== folder._id && s.name === name)) {
      throw new Error(`A folder named "${name}" already exists here.`);
    }

    await ctx.db.patch(args.folderId, { name });
  },
});

export const move = mutation({
  args: {
    folderId: v.id("folders"),
    newParentFolderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const { folder } = await requireFolderAccess(ctx, args.folderId, "member");
    if (folder.parentFolderId === args.newParentFolderId) return;

    await assertParentBelongsToProject(ctx, folder.projectId, args.newParentFolderId);

    // Reject moving a folder into itself or a descendant.
    let cursor = args.newParentFolderId;
    while (cursor) {
      if (cursor === args.folderId) {
        throw new Error("Cannot move a folder into itself or a descendant.");
      }
      const node = await ctx.db.get(cursor);
      cursor = node?.parentFolderId;
    }

    const newDepth = (await depthOf(ctx, args.newParentFolderId)) + 1;
    if (newDepth > MAX_DEPTH) {
      throw new Error("Folder depth limit exceeded.");
    }

    await ctx.db.patch(args.folderId, { parentFolderId: args.newParentFolderId });
  },
});

export const remove = mutation({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const { folder } = await requireFolderAccess(ctx, args.folderId, "admin");

    const childFolders = await ctx.db
      .query("folders")
      .withIndex("by_parent", (q) => q.eq("parentFolderId", args.folderId))
      .collect();
    if (childFolders.length > 0) {
      throw new Error("Folder is not empty: contains subfolders.");
    }

    const childAssets = await ctx.db
      .query("assets")
      .withIndex("by_folder", (q) => q.eq("folderId", args.folderId))
      .collect();
    if (childAssets.length > 0) {
      throw new Error("Folder is not empty: contains assets.");
    }

    await ctx.db.delete(args.folderId);
  },
});

export const list = query({
  args: {
    projectId: v.id("projects"),
    parentFolderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    await requireProjectAccess(ctx, args.projectId);
    return await ctx.db
      .query("folders")
      .withIndex("by_project_and_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentFolderId", args.parentFolderId),
      )
      .collect();
  },
});

/**
 * Return the breadcrumb chain (root → … → folder), inclusive.
 */
export const breadcrumb = query({
  args: { folderId: v.id("folders") },
  handler: async (ctx, args) => {
    const { folder, project } = await requireFolderAccess(ctx, args.folderId);
    const chain: Doc<"folders">[] = [folder];
    let cursor = folder.parentFolderId;
    while (cursor) {
      const node = await ctx.db.get(cursor);
      if (!node) break;
      chain.unshift(node);
      cursor = node.parentFolderId;
    }
    return { project, chain };
  },
});

/**
 * Walk a slash-delimited path ("Lara & Logan/RAWs/Cam2"), creating
 * any missing folders along the way. Returns the leaf folder's _id (or
 * undefined if path is empty / "/"). Idempotent — used by lawn-migrate.
 */
export const ensurePath = internalMutation({
  args: {
    projectId: v.id("projects"),
    path: v.string(),
    actorClerkId: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"folders"> | undefined> => {
    const segments = args.path
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (segments.length === 0) return undefined;

    let parentId: Id<"folders"> | undefined = undefined;
    for (const segment of segments) {
      const sanitized = (() => {
        try {
          return sanitizeFolderName(segment);
        } catch {
          return segment.slice(0, MAX_NAME_LENGTH).replace(/\//g, "_");
        }
      })();

      // Race-safe sibling lookup: a stale snapshot might miss a folder that
      // a concurrent ensurePath just inserted. Re-check after our own
      // potential insert by doing the lookup, then on a duplicate-key-style
      // insertion conflict, re-read once more. Convex doesn't expose
      // unique-constraint enforcement, so we approximate it with read +
      // optimistic insert + post-insert reconciliation.
      const existing = await ctx.db
        .query("folders")
        .withIndex("by_project_and_parent", (q) =>
          q.eq("projectId", args.projectId).eq("parentFolderId", parentId),
        )
        .filter((q) => q.eq(q.field("name"), sanitized))
        .unique();

      if (existing) {
        parentId = existing._id;
        continue;
      }

      const newId: Id<"folders"> = await ctx.db.insert("folders", {
        projectId: args.projectId,
        parentFolderId: parentId,
        name: sanitized,
        createdByClerkId: args.actorClerkId,
      });

      // Post-insert reconciliation: if a concurrent transaction inserted
      // the same name, collect siblings, keep the lowest _id, delete ours.
      // (Lowest _id is deterministic — both racers converge on the same
      // surviving row regardless of order.)
      const siblings = await ctx.db
        .query("folders")
        .withIndex("by_project_and_parent", (q) =>
          q.eq("projectId", args.projectId).eq("parentFolderId", parentId),
        )
        .filter((q) => q.eq(q.field("name"), sanitized))
        .collect();
      if (siblings.length > 1) {
        const survivor = siblings.reduce((min, s) => (s._id < min._id ? s : min));
        for (const s of siblings) {
          if (s._id !== survivor._id) {
            await ctx.db.delete(s._id);
          }
        }
        parentId = survivor._id;
      } else {
        parentId = newId;
      }
    }
    return parentId;
  },
});
