/**
 * Live migration-status snapshot for cross-session polling.
 *
 * The lawn-migrate watchdog runs entirely outside Convex (on a local
 * Bun process), so this query can't tell you whether the migration
 * is actively running — it tells you what's currently in the DB.
 *
 * Pair this with the sentinel file at
 * `~/Empire/TEG/_shared/Tools/lawn/.lawn-migrate-done` to know when
 * the watchdog has cleanly exited.
 *
 * Run via:
 *   bunx convex run --prod migrationStatus:summary '{}'
 */
import { internalQuery } from "./_generated/server";

export const summary = internalQuery({
  args: {},
  handler: async (ctx) => {
    const assets = await ctx.db.query("assets").collect();
    const projects = await ctx.db.query("projects").collect();
    const folders = await ctx.db.query("folders").collect();

    const byKind: Record<string, number> = {};
    let migrationOwned = 0;
    for (const a of assets) {
      byKind[a.assetKind] = (byKind[a.assetKind] ?? 0) + 1;
      if (a.legacyVideoId !== undefined) migrationOwned++;
    }

    const byProject: Array<{ name: string; assetCount: number }> = [];
    const projectAssetCounts = new Map<string, number>();
    for (const a of assets) {
      projectAssetCounts.set(a.projectId, (projectAssetCounts.get(a.projectId) ?? 0) + 1);
    }
    for (const p of projects) {
      byProject.push({ name: p.name, assetCount: projectAssetCounts.get(p._id) ?? 0 });
    }
    byProject.sort((a, b) => b.assetCount - a.assetCount);

    return {
      totalAssets: assets.length,
      totalProjects: projects.length,
      totalFolders: folders.length,
      assetsByKind: byKind,
      assetsFromMigration: migrationOwned,
      assetsCreatedNatively: assets.length - migrationOwned,
      byProject,
    };
  },
});
