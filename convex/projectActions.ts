/**
 * User-facing project mutations beyond plain CRUD.
 *
 * `nestProjectIntoProject` — drag a project onto another to merge it. The
 * source becomes a folder inside the target, with all its assets and nested
 * folders moved across (projectId rewritten on every node). The source
 * project row is deleted on success.
 *
 * Different from convex/restructureFrameio.ts: that file is a one-shot
 * batch tool the data team runs to clean up the Frame.io migration. This
 * file is for runtime team-app actions triggered from the dashboard UI.
 */

import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireFolderAccess, requireProjectAccess } from "./auth";

const MAX_FOLDER_NAME = 200;

function sanitizeFolderName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Folder name cannot be empty.");
  }
  if (trimmed.includes("/")) {
    return trimmed.replace(/\//g, "-").slice(0, MAX_FOLDER_NAME);
  }
  return trimmed.slice(0, MAX_FOLDER_NAME);
}

/**
 * Walk the subtree rooted at `rootFolderId` and rewrite every descendant
 * folder + asset's projectId to `targetProjectId`. Caller already
 * re-parented `rootFolderId` itself.
 */
async function rewriteSubtreeProjectId(
  ctx: MutationCtx,
  rootFolderId: Id<"folders">,
  targetProjectId: Id<"projects">,
) {
  const queue: Id<"folders">[] = [rootFolderId];

  while (queue.length > 0) {
    const folderId = queue.shift()!;
    const folder = await ctx.db.get(folderId);
    if (!folder) continue;

    if (folder.projectId !== targetProjectId) {
      await ctx.db.patch(folderId, { projectId: targetProjectId });
    }

    const children = await ctx.db
      .query("folders")
      .withIndex("by_parent", (q) => q.eq("parentFolderId", folderId))
      .collect();
    for (const child of children) queue.push(child._id);

    const assetsInFolder = await ctx.db
      .query("assets")
      .withIndex("by_folder", (q) => q.eq("folderId", folderId))
      .collect();
    for (const asset of assetsInFolder) {
      if (asset.projectId !== targetProjectId) {
        await ctx.db.patch(asset._id, { projectId: targetProjectId });
      }
    }
  }
}

/**
 * Nest one project inside another as a folder.
 *
 * - Source project becomes a folder named after itself, inside the target.
 * - All source assets at the project root land directly in that new folder.
 * - All source folders at the project root become children of the new folder.
 * - The source project row is deleted.
 *
 * Auth: caller must have member access on BOTH the source and target.
 * Both projects must be in the same team — cross-team nesting is rejected
 * to keep billing + access boundaries clean.
 */
export const nestProjectIntoProject = mutation({
  args: {
    sourceProjectId: v.id("projects"),
    targetProjectId: v.id("projects"),
  },
  returns: v.object({
    targetFolderId: v.id("folders"),
    movedAssets: v.number(),
    movedRootFolders: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.sourceProjectId === args.targetProjectId) {
      throw new Error("Cannot nest a project into itself.");
    }

    // Auth model:
    //   - source: requires "admin" because the source project row is deleted
    //     at the end. Member-level access shouldn't authorize destructive
    //     project deletion (matches projects.remove which is also admin-only).
    //   - target: requires "member" because we only add a folder + move
    //     assets into it; nothing destructive happens to the target.
    const { project: source, user } = await requireProjectAccess(
      ctx,
      args.sourceProjectId,
      "admin",
    );
    const { project: target } = await requireProjectAccess(
      ctx,
      args.targetProjectId,
      "member",
    );

    if (source.teamId !== target.teamId) {
      throw new Error(
        "Source and target projects must belong to the same team.",
      );
    }

    const folderName = sanitizeFolderName(source.name);

    // Refuse to overwrite an existing top-level folder with the same name in
    // the target — surface the conflict instead of silently merging assets
    // into someone else's folder.
    const existingTopLevel = await ctx.db
      .query("folders")
      .withIndex("by_project_and_parent", (q) =>
        q.eq("projectId", args.targetProjectId).eq("parentFolderId", undefined),
      )
      .filter((q) => q.eq(q.field("name"), folderName))
      .collect();
    if (existingTopLevel.length > 0) {
      throw new Error(
        `Target project already has a folder named "${folderName}". Rename it first.`,
      );
    }

    // 1. Create the destination folder at the target's root.
    const targetFolderId: Id<"folders"> = await ctx.db.insert("folders", {
      projectId: args.targetProjectId,
      parentFolderId: undefined,
      name: folderName,
      createdByClerkId: user.subject,
    });

    // 2. Move source root-level assets into the new folder.
    const rootAssets = await ctx.db
      .query("assets")
      .withIndex("by_project_and_folder", (q) =>
        q.eq("projectId", args.sourceProjectId).eq("folderId", undefined),
      )
      .collect();
    for (const asset of rootAssets) {
      await ctx.db.patch(asset._id, {
        projectId: args.targetProjectId,
        folderId: targetFolderId,
      });
    }

    // 3. Move source root-level folders under the new folder, then rewrite
    //    projectId on the entire subtree of each.
    const rootFolders = await ctx.db
      .query("folders")
      .withIndex("by_project_and_parent", (q) =>
        q.eq("projectId", args.sourceProjectId).eq("parentFolderId", undefined),
      )
      .collect();
    for (const folder of rootFolders) {
      await ctx.db.patch(folder._id, {
        projectId: args.targetProjectId,
        parentFolderId: targetFolderId,
      });
      await rewriteSubtreeProjectId(ctx, folder._id, args.targetProjectId);
    }

    // 4. Sanity-check: source must be empty before deletion.
    const stragglerAssets = await ctx.db
      .query("assets")
      .withIndex("by_project", (q) => q.eq("projectId", args.sourceProjectId))
      .collect();
    const stragglerFolders = await ctx.db
      .query("folders")
      .withIndex("by_project", (q) => q.eq("projectId", args.sourceProjectId))
      .collect();
    if (stragglerAssets.length > 0 || stragglerFolders.length > 0) {
      throw new Error(
        "Source project is not empty after move — refusing to delete.",
      );
    }

    // 5. Drop any share links pointing at the (now-empty) source project.
    const shareLinks = await ctx.db
      .query("shareLinks")
      .withIndex("by_project", (q) => q.eq("projectId", args.sourceProjectId))
      .collect();
    for (const link of shareLinks) {
      const grants = await ctx.db
        .query("shareAccessGrants")
        .withIndex("by_share_link", (q) => q.eq("shareLinkId", link._id))
        .collect();
      for (const grant of grants) await ctx.db.delete(grant._id);
      await ctx.db.delete(link._id);
    }

    // 6. Delete the source project row.
    await ctx.db.delete(args.sourceProjectId);

    return {
      targetFolderId,
      movedAssets: rootAssets.length,
      movedRootFolders: rootFolders.length,
    };
  },
});

/**
 * Promote a nested folder to its own top-level project on the dashboard.
 *
 * Inverse of nestProjectIntoProject. Creates a new project under the
 * source folder's team, then re-points the folder's contents (assets +
 * subfolders) to the new project. The source folder row is deleted —
 * its assets land at the new project's root, its subfolders become the
 * new project's top-level folders.
 *
 * Auth: caller needs admin on the source folder (matches projects.create
 * which requires team-member; we use "admin" here because the operation
 * is destructive against the source folder's parent project).
 *
 * Reversibility: nestProjectIntoProject takes the result back the other
 * way, so promote↔nest is symmetric.
 */
export const promoteFolderToProject = mutation({
  args: {
    folderId: v.id("folders"),
    /** Defaults to the folder's current name. */
    projectName: v.optional(v.string()),
  },
  returns: v.object({
    newProjectId: v.id("projects"),
    movedAssets: v.number(),
    movedRootFolders: v.number(),
  }),
  handler: async (ctx, args) => {
    const { folder } = await requireFolderAccess(ctx, args.folderId, "admin");

    const sourceProject = await ctx.db.get(folder.projectId);
    if (!sourceProject) {
      throw new Error("Source project not found.");
    }

    const newName = (args.projectName ?? folder.name).trim();
    if (!newName) throw new Error("Project name cannot be empty.");

    // Avoid creating a duplicate project name within the team. The team
    // can have many projects, so this is just a friendly guard — the
    // schema doesn't enforce uniqueness.
    const siblings = await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", sourceProject.teamId))
      .collect();
    if (siblings.some((p) => p.name === newName)) {
      throw new Error(
        `A project named "${newName}" already exists in this team. Pick a different name first.`,
      );
    }

    // 1. Create the new project.
    const newProjectId: Id<"projects"> = await ctx.db.insert("projects", {
      teamId: sourceProject.teamId,
      name: newName,
      description: undefined,
    });

    // 2. Re-parent the folder's direct child assets → new project root.
    const rootAssets = await ctx.db
      .query("assets")
      .withIndex("by_folder", (q) => q.eq("folderId", args.folderId))
      .collect();
    for (const asset of rootAssets) {
      await ctx.db.patch(asset._id, {
        projectId: newProjectId,
        folderId: undefined,
      });
    }

    // 3. Re-parent the folder's direct child folders → new project's top
    //    level. Then rewrite projectId on each subtree.
    const rootFolders = await ctx.db
      .query("folders")
      .withIndex("by_parent", (q) => q.eq("parentFolderId", args.folderId))
      .collect();
    for (const child of rootFolders) {
      await ctx.db.patch(child._id, {
        projectId: newProjectId,
        parentFolderId: undefined,
      });
      await rewriteSubtreeProjectId(ctx, child._id, newProjectId);
    }

    // 4. Delete the now-empty source folder.
    await ctx.db.delete(args.folderId);

    return {
      newProjectId,
      movedAssets: rootAssets.length,
      movedRootFolders: rootFolders.length,
    };
  },
});
