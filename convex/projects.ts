import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getUser, requireTeamAccess, requireProjectAccess } from "./auth";
import { assertTeamHasActiveSubscription } from "./billingHelpers";

export const create = mutation({
  args: {
    teamId: v.id("teams"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTeamAccess(ctx, args.teamId, "member");
    await assertTeamHasActiveSubscription(ctx, args.teamId);

    return await ctx.db.insert("projects", {
      teamId: args.teamId,
      name: args.name,
      description: args.description,
    });
  },
});

export const list = query({
  args: { teamId: v.id("teams") },
  handler: async (ctx, args) => {
    await requireTeamAccess(ctx, args.teamId);

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", args.teamId))
      .collect();

    // Per-project asset count. sizeBytes + lastModifiedAt come from the row
    // itself — denormalized by convex/activity.ts on every mutation, with
    // _creationTime as the fallback when lastModifiedAt is undefined for
    // pre-backfill rows.
    return await Promise.all(
      projects.map(async (project) => {
        const assets = await ctx.db
          .query("assets")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .collect();
        return {
          ...project,
          assetCount: assets.length,
        };
      }),
    );
  },
});

export const listUploadTargets = query({
  args: {
    teamSlug: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await getUser(ctx);
    if (!user) return [];

    const memberships = await ctx.db
      .query("teamMembers")
      .withIndex("by_user", (q) => q.eq("userClerkId", user.subject))
      .collect();

    const uploadableMemberships = memberships.filter(
      (membership) => membership.role !== "viewer",
    );

    const targets = await Promise.all(
      uploadableMemberships.map(async (membership) => {
        const team = await ctx.db.get(membership.teamId);
        if (!team) return [];
        if (args.teamSlug && team.slug !== args.teamSlug) return [];

        const projects = await ctx.db
          .query("projects")
          .withIndex("by_team", (q) => q.eq("teamId", team._id))
          .collect();

        return projects.map((project) => ({
          projectId: project._id,
          projectName: project.name,
          teamId: team._id,
          teamName: team.name,
          teamSlug: team.slug,
          role: membership.role,
        }));
      }),
    );

    return targets
      .flat()
      .sort((a, b) =>
        a.teamName.localeCompare(b.teamName) ||
        a.projectName.localeCompare(b.projectName),
      );
  },
});

export const get = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const { project, membership } = await requireProjectAccess(ctx, args.projectId);
    return { ...project, role: membership.role };
  },
});

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireProjectAccess(ctx, args.projectId, "member");

    const updates: Partial<{ name: string; description: string }> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;

    await ctx.db.patch(args.projectId, updates);
  },
});

/**
 * Hard-delete a project + every asset, comment, share link, and grant
 * inside it. Required name confirmation: `confirmName` must equal the
 * project's current name. Without it, the mutation refuses to fire.
 *
 * Rationale: an accidental click on the kebab Delete used to wipe
 * 1,000+ assets in one shot. Forcing the user to type (or echo) the
 * project name makes the action proportional to its blast radius.
 *
 * The B2 / Mux media is intentionally NOT deleted here — the
 * `assetRecovery` action can reconstruct asset rows from B2 if a
 * deletion was an accident.
 */
export const remove = mutation({
  args: {
    projectId: v.id("projects"),
    /** Must equal the project's current name. */
    confirmName: v.string(),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectAccess(ctx, args.projectId, "admin");

    if (args.confirmName.trim() !== project.name) {
      throw new Error(
        `Confirmation name "${args.confirmName}" does not match "${project.name}". Refusing to delete.`,
      );
    }

    // Delete all assets in the project
    const assets = await ctx.db
      .query("assets")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();

    for (const asset of assets) {
      // Delete comments
      const comments = await ctx.db
        .query("comments")
        .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
        .collect();
      for (const comment of comments) {
        await ctx.db.delete(comment._id);
      }

      // Delete share links
      const shareLinks = await ctx.db
        .query("shareLinks")
        .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
        .collect();
      for (const link of shareLinks) {
        const grants = await ctx.db
          .query("shareAccessGrants")
          .withIndex("by_share_link", (q) => q.eq("shareLinkId", link._id))
          .collect();
        for (const grant of grants) {
          await ctx.db.delete(grant._id);
        }
        await ctx.db.delete(link._id);
      }

      await ctx.db.delete(asset._id);
    }

    await ctx.db.delete(args.projectId);
  },
});
