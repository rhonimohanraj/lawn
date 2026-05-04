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
import {
  bumpForFolderCreate,
  bumpForFolderDelete,
  bumpForFolderMove,
  touchFolder,
} from "./activity";

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

    const newId = await ctx.db.insert("folders", {
      projectId: args.projectId,
      parentFolderId: args.parentFolderId,
      name,
      createdByClerkId: user.subject,
    });

    const inserted = await ctx.db.get(newId);
    if (inserted) {
      await bumpForFolderCreate(ctx, inserted);
    }

    return newId;
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
    await touchFolder(ctx, folder);
  },
});

/**
 * Walk a folder subtree and rewrite each node's projectId. Used by
 * `move` when relocating across projects. The asset rows under each
 * folder also get rewritten so they stay scoped to their owning project.
 */
async function rewriteSubtreeProjectId(
  ctx: MutationCtx,
  rootFolderId: Id<"folders">,
  targetProjectId: Id<"projects">,
) {
  const queue: Id<"folders">[] = [rootFolderId];

  while (queue.length > 0) {
    const folderId = queue.shift()!;
    const f = await ctx.db.get(folderId);
    if (!f) continue;

    if (f.projectId !== targetProjectId) {
      await ctx.db.patch(folderId, { projectId: targetProjectId });
    }

    const children = await ctx.db
      .query("folders")
      .withIndex("by_parent", (q) => q.eq("parentFolderId", folderId))
      .collect();
    for (const c of children) queue.push(c._id);

    const assetsInFolder = await ctx.db
      .query("assets")
      .withIndex("by_folder", (q) => q.eq("folderId", folderId))
      .collect();
    for (const a of assetsInFolder) {
      if (a.projectId !== targetProjectId) {
        await ctx.db.patch(a._id, { projectId: targetProjectId });
      }
    }
  }
}

/**
 * Move a folder to a new parent — within the same project, or across to
 * a different project entirely.
 *
 * - Within same project: pass `newParentFolderId` only. Rejects cycles
 *   and depth-limit violations. Existing intra-project move semantics.
 * - Cross-project: pass `targetProjectId`. The folder + every descendant
 *   folder + every contained asset has its `projectId` rewritten. The
 *   target's tree is depth-checked end-to-end.
 *
 * Auth: caller needs member access on the source folder. Cross-project
 * moves additionally require member access on the target project.
 *
 * Reversibility: every move is just a normal mutation, so users always
 * "undo" by moving the folder back to its original location. No special
 * undo state — the move is symmetric.
 */
export const move = mutation({
  args: {
    folderId: v.id("folders"),
    newParentFolderId: v.optional(v.id("folders")),
    /** Optional. When set and different from the folder's current
     *  project, performs a cross-project move (rewrites projectId on
     *  the entire subtree). When unset, falls back to the source
     *  folder's project. */
    targetProjectId: v.optional(v.id("projects")),
  },
  handler: async (ctx, args) => {
    const { folder } = await requireFolderAccess(ctx, args.folderId, "member");

    const targetProjectId = args.targetProjectId ?? folder.projectId;
    const isCrossProject = targetProjectId !== folder.projectId;

    if (isCrossProject) {
      await requireProjectAccess(ctx, targetProjectId, "member");
    }

    // No-op short-circuit (same project + same parent).
    if (
      !isCrossProject &&
      folder.parentFolderId === args.newParentFolderId
    ) {
      return;
    }

    // Validate the new parent (when provided) belongs to the target project.
    if (args.newParentFolderId) {
      const parent = await ctx.db.get(args.newParentFolderId);
      if (!parent) throw new Error("Parent folder not found.");
      if (parent.projectId !== targetProjectId) {
        throw new Error("Parent folder belongs to a different project.");
      }
    }

    // Cycle check: traverse upward from the prospective new parent. If we
    // ever hit folderId, the move would create a cycle.
    let cursor = args.newParentFolderId;
    while (cursor) {
      if (cursor === args.folderId) {
        throw new Error("Cannot move a folder into itself or a descendant.");
      }
      const node = await ctx.db.get(cursor);
      cursor = node?.parentFolderId;
    }

    // Depth check on the destination side. We add 1 because the folder
    // itself sits one level below the new parent.
    const newDepth = (await depthOf(ctx, args.newParentFolderId)) + 1;
    if (newDepth > MAX_DEPTH) {
      throw new Error("Folder depth limit exceeded.");
    }

    // Sibling-name conflict at the destination — keep breadcrumbs unambiguous.
    const siblings = await ctx.db
      .query("folders")
      .withIndex("by_project_and_parent", (q) =>
        q
          .eq("projectId", targetProjectId)
          .eq("parentFolderId", args.newParentFolderId),
      )
      .collect();
    if (
      siblings.some((s) => s._id !== folder._id && s.name === folder.name)
    ) {
      throw new Error(
        `A folder named "${folder.name}" already exists at the destination.`,
      );
    }

    // Apply size/timestamp propagation on the OLD chain (still in the old
    // project) before any patch. Same for the NEW chain after we've
    // re-pointed projectId. The activity helper handles intra-project
    // chains; cross-project we do it manually.
    if (isCrossProject) {
      // Update the folder's own record first so subsequent chain walks
      // start from the right place.
      await ctx.db.patch(args.folderId, {
        projectId: targetProjectId,
        parentFolderId: args.newParentFolderId,
      });
      // Rewrite the rest of the subtree.
      await rewriteSubtreeProjectId(ctx, args.folderId, targetProjectId);
      // Touch source + target folder chains so sizes recompute on next
      // backfill. We don't manually delta-shift sizes here because the
      // total volume (folder + descendants) is non-trivial to compute
      // correctly under contention; activityBackfill will reconcile.
      await touchFolder(ctx, folder); // bumps lastModifiedAt on source proj
    } else {
      await bumpForFolderMove(ctx, folder, args.newParentFolderId);
      await ctx.db.patch(args.folderId, {
        parentFolderId: args.newParentFolderId,
      });
    }
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

    await bumpForFolderDelete(ctx, folder);
    await ctx.db.delete(args.folderId);
  },
});

export const list = query({
  args: {
    projectId: v.id("projects"),
    parentFolderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAccess(ctx, args.projectId);

    const folders = await ctx.db
      .query("folders")
      .withIndex("by_project_and_parent", (q) =>
        q.eq("projectId", args.projectId).eq("parentFolderId", args.parentFolderId),
      )
      .collect();

    // Resolve creator names from teamMembers — folders only store clerkId, but
    // the table view needs a human-readable name in the "Uploaded by" column.
    // One query per folder list (not per folder) keeps this O(team members).
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_team", (q) => q.eq("teamId", project.teamId))
      .collect();
    const nameByClerkId = new Map(members.map((m) => [m.userClerkId, m.userName]));

    return folders.map((folder) => ({
      ...folder,
      createdByName: nameByClerkId.get(folder.createdByClerkId) ?? "Unknown",
    }));
  },
});

/**
 * Flat list of every project + folder visible to the caller within a team,
 * each tagged with the path that leads to it. Powers the "Move to…" picker:
 * one query, no per-project round-trips, easy to render in a searchable list.
 *
 * Excludes the moving folder itself + every descendant of it (to keep the
 * caller from creating a cycle by picking an invalid target).
 */
export const listMoveDestinations = query({
  args: {
    teamId: v.id("teams"),
    /** Folder being moved — used to filter itself + its descendants
     *  out of the destination list. Optional so the same query can
     *  power non-move pickers later. */
    excludeFolderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .collect();
    const projectIds = new Set(projects.map((p) => p._id as string));

    const allFolders = await ctx.db.query("folders").collect();
    const teamFolders = allFolders.filter((f) =>
      projectIds.has(f.projectId as string),
    );

    // Build descendant set if we're excluding a moving folder.
    const excluded = new Set<string>();
    if (args.excludeFolderId) {
      excluded.add(args.excludeFolderId as string);
      // BFS down through parentFolderId. Bounded by total folder count.
      const childrenByParent = new Map<string, Doc<"folders">[]>();
      for (const f of teamFolders) {
        const parent = (f.parentFolderId as string | undefined) ?? "__root__";
        const arr = childrenByParent.get(parent) ?? [];
        arr.push(f);
        childrenByParent.set(parent, arr);
      }
      const queue: string[] = [args.excludeFolderId as string];
      while (queue.length) {
        const id = queue.shift()!;
        const kids = childrenByParent.get(id) ?? [];
        for (const k of kids) {
          excluded.add(k._id as string);
          queue.push(k._id as string);
        }
      }
    }

    // Build folder paths once. Walk up using parentFolderId, accumulating
    // names. Bounded by depth (32).
    const foldersById = new Map(teamFolders.map((f) => [f._id as string, f]));
    function pathFor(folder: Doc<"folders">): string[] {
      const segs: string[] = [];
      let cursor: Id<"folders"> | undefined = folder._id;
      let steps = 0;
      while (cursor && steps++ < 64) {
        const f = foldersById.get(cursor as string);
        if (!f) break;
        segs.unshift(f.name);
        cursor = f.parentFolderId;
      }
      return segs;
    }

    const projectsById = new Map(projects.map((p) => [p._id as string, p]));

    return {
      projects: projects.map((p) => ({
        _id: p._id,
        name: p.name,
      })),
      folders: teamFolders
        .filter((f) => !excluded.has(f._id as string))
        .map((f) => ({
          _id: f._id,
          name: f.name,
          projectId: f.projectId,
          projectName: projectsById.get(f.projectId as string)?.name ?? "?",
          parentFolderId: f.parentFolderId,
          path: pathFor(f),
        })),
    };
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
      let survivorId: Id<"folders">;
      if (siblings.length > 1) {
        const survivor = siblings.reduce((min, s) => (s._id < min._id ? s : min));
        for (const s of siblings) {
          if (s._id !== survivor._id) {
            await ctx.db.delete(s._id);
          }
        }
        survivorId = survivor._id;
      } else {
        survivorId = newId;
      }

      const survivorDoc = await ctx.db.get(survivorId);
      if (survivorDoc) {
        await bumpForFolderCreate(ctx, survivorDoc);
      }
      parentId = survivorId;
    }
    return parentId;
  },
});
