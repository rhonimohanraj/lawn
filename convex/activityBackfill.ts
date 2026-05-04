/**
 * One-shot backfill for the denormalized fields added by activity.ts:
 *   - assets.lastModifiedAt   = _creationTime  (when missing)
 *   - folders.lastModifiedAt  = _creationTime  (when missing)
 *   - folders.sizeBytes       = sum of descendant asset.fileSize
 *   - projects.lastModifiedAt = _creationTime  (when missing)
 *   - projects.sizeBytes      = sum of all asset.fileSize in the project
 *
 * Run after deploying the schema change. Safe to re-run — idempotent.
 *
 * Usage from the project root:
 *   bunx convex run activityBackfill:backfillProject '{"projectId":"<id>"}'
 *   bunx convex run activityBackfill:backfillAll
 *   bunx convex run activityBackfill:status
 */

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

export const backfillProject = internalMutation({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) return { ok: false, reason: "missing" } as const;

    const folders = await ctx.db
      .query("folders")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    const assets = await ctx.db
      .query("assets")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    // Backfill each asset's lastModifiedAt to _creationTime when absent.
    for (const asset of assets) {
      if (asset.lastModifiedAt === undefined) {
        await ctx.db.patch(asset._id, { lastModifiedAt: asset._creationTime });
      }
    }

    // Bucket assets by direct folderId (or "__root__" for project root).
    const ROOT = "__root__" as const;
    const directAssetBytes = new Map<string, number>();
    for (const a of assets) {
      const key = (a.folderId as string | undefined) ?? ROOT;
      directAssetBytes.set(key, (directAssetBytes.get(key) ?? 0) + (a.fileSize ?? 0));
    }

    // Build parent → children index.
    const childrenByParent = new Map<string, Doc<"folders">[]>();
    for (const f of folders) {
      const key = (f.parentFolderId as string | undefined) ?? ROOT;
      const arr = childrenByParent.get(key) ?? [];
      arr.push(f);
      childrenByParent.set(key, arr);
    }

    // Post-order DFS — child sizes resolved before parents.
    const folderSizes = new Map<string, number>();
    const computeFolderSize = (folderId: string): number => {
      const ownBytes = directAssetBytes.get(folderId) ?? 0;
      const children = childrenByParent.get(folderId) ?? [];
      let childBytes = 0;
      for (const c of children) {
        childBytes += computeFolderSize(c._id as string);
      }
      const total = ownBytes + childBytes;
      folderSizes.set(folderId, total);
      return total;
    };
    for (const root of childrenByParent.get(ROOT) ?? []) {
      computeFolderSize(root._id as string);
    }

    // Patch every folder with computed size + lastModifiedAt fallback.
    let foldersUpdated = 0;
    for (const f of folders) {
      const computed = folderSizes.get(f._id as string) ?? 0;
      const updates: Partial<Doc<"folders">> = {};
      if ((f.sizeBytes ?? -1) !== computed) {
        updates.sizeBytes = computed;
      }
      if (f.lastModifiedAt === undefined) {
        updates.lastModifiedAt = f._creationTime;
      }
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(f._id, updates);
        foldersUpdated++;
      }
    }

    // Project totals = sum of every asset's fileSize, regardless of folder.
    const projectBytes = assets.reduce(
      (sum, a) => sum + (a.fileSize ?? 0),
      0,
    );
    const projectUpdates: Partial<Doc<"projects">> = {};
    if ((project.sizeBytes ?? -1) !== projectBytes) {
      projectUpdates.sizeBytes = projectBytes;
    }
    if (project.lastModifiedAt === undefined) {
      projectUpdates.lastModifiedAt = project._creationTime;
    }
    if (Object.keys(projectUpdates).length > 0) {
      await ctx.db.patch(args.projectId, projectUpdates);
    }

    return {
      ok: true as const,
      projectId: args.projectId,
      assetsScanned: assets.length,
      foldersScanned: folders.length,
      foldersUpdated,
      projectSizeBytes: projectBytes,
    };
  },
});

export const backfillAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    const results: Array<{
      projectId: Id<"projects">;
      assetsScanned: number;
      foldersScanned: number;
      projectSizeBytes: number;
    }> = [];

    for (const project of projects) {
      const folders = await ctx.db
        .query("folders")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      const assets = await ctx.db
        .query("assets")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();

      for (const asset of assets) {
        if (asset.lastModifiedAt === undefined) {
          await ctx.db.patch(asset._id, { lastModifiedAt: asset._creationTime });
        }
      }

      const ROOT = "__root__" as const;
      const directAssetBytes = new Map<string, number>();
      for (const a of assets) {
        const key = (a.folderId as string | undefined) ?? ROOT;
        directAssetBytes.set(key, (directAssetBytes.get(key) ?? 0) + (a.fileSize ?? 0));
      }

      const childrenByParent = new Map<string, Doc<"folders">[]>();
      for (const f of folders) {
        const key = (f.parentFolderId as string | undefined) ?? ROOT;
        const arr = childrenByParent.get(key) ?? [];
        arr.push(f);
        childrenByParent.set(key, arr);
      }

      const folderSizes = new Map<string, number>();
      const computeFolderSize = (folderId: string): number => {
        const ownBytes = directAssetBytes.get(folderId) ?? 0;
        const children = childrenByParent.get(folderId) ?? [];
        let childBytes = 0;
        for (const c of children) {
          childBytes += computeFolderSize(c._id as string);
        }
        const total = ownBytes + childBytes;
        folderSizes.set(folderId, total);
        return total;
      };
      for (const root of childrenByParent.get(ROOT) ?? []) {
        computeFolderSize(root._id as string);
      }

      for (const f of folders) {
        const computed = folderSizes.get(f._id as string) ?? 0;
        const updates: Partial<Doc<"folders">> = {};
        if ((f.sizeBytes ?? -1) !== computed) {
          updates.sizeBytes = computed;
        }
        if (f.lastModifiedAt === undefined) {
          updates.lastModifiedAt = f._creationTime;
        }
        if (Object.keys(updates).length > 0) {
          await ctx.db.patch(f._id, updates);
        }
      }

      const projectBytes = assets.reduce(
        (sum, a) => sum + (a.fileSize ?? 0),
        0,
      );
      const projectUpdates: Partial<Doc<"projects">> = {};
      if ((project.sizeBytes ?? -1) !== projectBytes) {
        projectUpdates.sizeBytes = projectBytes;
      }
      if (project.lastModifiedAt === undefined) {
        projectUpdates.lastModifiedAt = project._creationTime;
      }
      if (Object.keys(projectUpdates).length > 0) {
        await ctx.db.patch(project._id, projectUpdates);
      }

      results.push({
        projectId: project._id,
        assetsScanned: assets.length,
        foldersScanned: folders.length,
        projectSizeBytes: projectBytes,
      });
    }

    return { ok: true as const, projects: results };
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").collect();
    const folders = await ctx.db.query("folders").collect();
    const assets = await ctx.db.query("assets").collect();

    return {
      totals: {
        projects: projects.length,
        folders: folders.length,
        assets: assets.length,
      },
      missing: {
        projectsMissingSize: projects.filter((p) => p.sizeBytes === undefined).length,
        projectsMissingModified: projects.filter((p) => p.lastModifiedAt === undefined).length,
        foldersMissingSize: folders.filter((f) => f.sizeBytes === undefined).length,
        foldersMissingModified: folders.filter((f) => f.lastModifiedAt === undefined).length,
        assetsMissingModified: assets.filter((a) => a.lastModifiedAt === undefined).length,
      },
    };
  },
});
