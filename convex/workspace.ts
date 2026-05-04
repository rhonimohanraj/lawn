import { v } from "convex/values";
import { query } from "./_generated/server";
import { getUser } from "./auth";
import { Doc } from "./_generated/dataModel";
import { findAssetByLegacyId } from "./legacyId";

function buildCanonicalPath(input: {
  teamSlug: string;
  projectId?: string;
  assetId?: string;
}) {
  if (input.assetId && input.projectId) {
    return `/dashboard/${input.teamSlug}/${input.projectId}/${input.assetId}`;
  }

  if (input.projectId) {
    return `/dashboard/${input.teamSlug}/${input.projectId}`;
  }

  return `/dashboard/${input.teamSlug}`;
}

export const resolveContext = query({
  args: {
    // Validators are loose (string instead of v.id) so that legacy URLs
    // pointing at deleted rows still reach the handler — Convex's v.id()
    // would 400 the request before legacyId fallback can run.
    teamSlug: v.optional(v.string()),
    projectId: v.optional(v.string()),
    assetId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getUser(ctx);
    if (!user) return null;

    let team: Doc<"teams"> | null = null;
    let project: Doc<"projects"> | null = null;
    let asset: Doc<"assets"> | null = null;

    if (args.assetId) {
      // Try the live row first; if the id is dead (deleted row, post-rename
      // mismatch, etc.) fall through to legacy s3Key lookup before giving up.
      const normalizedAssetId = ctx.db.normalizeId("assets", args.assetId);
      asset = normalizedAssetId
        ? await ctx.db.get(normalizedAssetId)
        : null;
      if (!asset) {
        asset = await findAssetByLegacyId(ctx, args.assetId);
      }
      if (!asset) return null;

      project = await ctx.db.get(asset.projectId);
      if (!project) return null;

      team = await ctx.db.get(project.teamId);
      if (!team) return null;
    } else if (args.projectId) {
      const normalizedProjectId = ctx.db.normalizeId("projects", args.projectId);
      project = normalizedProjectId
        ? await ctx.db.get(normalizedProjectId)
        : null;
      if (!project) return null;

      team = await ctx.db.get(project.teamId);
      if (!team) return null;
    } else if (args.teamSlug) {
      const teamSlug = args.teamSlug;
      team = await ctx.db
        .query("teams")
        .withIndex("by_slug", (q) => q.eq("slug", teamSlug))
        .unique();
      if (!team) return null;
    } else {
      return null;
    }

    const membership = await ctx.db
      .query("teamMembers")
      .withIndex("by_team_and_user", (q) =>
        q.eq("teamId", team._id).eq("userClerkId", user.subject),
      )
      .unique();

    if (!membership) return null;

    const canonicalProjectId = project?._id;
    const canonicalAssetId = asset?._id;
    const canonicalPath = buildCanonicalPath({
      teamSlug: team.slug,
      projectId: canonicalProjectId,
      assetId: canonicalAssetId,
    });

    const sameTeamSlug = args.teamSlug === undefined || args.teamSlug === team.slug;
    const sameProjectId =
      args.projectId === undefined || args.projectId === canonicalProjectId;
    const sameVideoId =
      args.assetId === undefined || args.assetId === canonicalAssetId;

    const sameProjectVideoChain =
      args.assetId === undefined ||
      args.projectId === undefined ||
      args.projectId === canonicalProjectId;

    return {
      team: {
        ...team,
        role: membership.role,
      },
      project: project ?? undefined,
      asset: asset ?? undefined,
      canonicalPath,
      isCanonical:
        sameTeamSlug && sameProjectId && sameVideoId && sameProjectVideoChain,
    };
  },
});
