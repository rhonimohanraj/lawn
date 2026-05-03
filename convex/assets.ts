import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, MutationCtx } from "./_generated/server";
import { identityName, requireProjectAccess, requireAssetAccess } from "./auth";
import { Id } from "./_generated/dataModel";
import { generateUniqueToken } from "./security";
import { resolveActiveShareGrant } from "./shareAccess";
import { assertTeamCanStoreBytes } from "./billingHelpers";
import { assetKindValidator } from "./schema";
import { classifyAssetKind } from "./assetKind";

const workflowStatusValidator = v.union(
  v.literal("review"),
  v.literal("rework"),
  v.literal("done"),
);

const visibilityValidator = v.union(v.literal("public"), v.literal("private"));

type WorkflowStatus =
  | "review"
  | "rework"
  | "done";

function normalizeWorkflowStatus(status: WorkflowStatus | undefined): WorkflowStatus {
  return status ?? "review";
}

async function generatePublicId(ctx: MutationCtx) {
  return await generateUniqueToken(
    32,
    async (candidate) =>
      (await ctx.db
        .query("assets")
        .withIndex("by_public_id", (q) => q.eq("publicId", candidate))
        .unique()) !== null,
    5,
  );
}

async function deleteShareAccessGrantsForLink(
  ctx: MutationCtx,
  linkId: Id<"shareLinks">,
) {
  const grants = await ctx.db
    .query("shareAccessGrants")
    .withIndex("by_share_link", (q) => q.eq("shareLinkId", linkId))
    .collect();

  for (const grant of grants) {
    await ctx.db.delete(grant._id);
  }
}

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    folderId: v.optional(v.id("folders")),
    title: v.string(),
    description: v.optional(v.string()),
    fileSize: v.optional(v.number()),
    contentType: v.optional(v.string()),
    assetKind: v.optional(assetKindValidator),
    filename: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, project } = await requireProjectAccess(ctx, args.projectId, "member");
    await assertTeamCanStoreBytes(ctx, project.teamId, args.fileSize ?? 0);

    if (args.folderId) {
      const folder = await ctx.db.get(args.folderId);
      if (!folder || folder.projectId !== args.projectId) {
        throw new Error("Folder does not belong to this project.");
      }
    }

    const publicId = await generatePublicId(ctx);
    const kind =
      args.assetKind ??
      classifyAssetKind({ contentType: args.contentType, filename: args.filename ?? args.title });

    const assetId = await ctx.db.insert("assets", {
      projectId: args.projectId,
      folderId: args.folderId,
      assetKind: kind,
      uploadedByClerkId: user.subject,
      uploaderName: identityName(user),
      title: args.title,
      description: args.description,
      fileSize: args.fileSize,
      contentType: args.contentType,
      status: "uploading",
      // Mux only runs for videos; non-video kinds skip the prep state entirely.
      muxAssetStatus: kind === "video" ? "preparing" : undefined,
      workflowStatus: "review",
      visibility: "public",
      publicId,
    });

    return assetId;
  },
});

/**
 * List assets in a project. When folderId is provided (or omitted to mean the
 * project root, i.e. folderId === undefined), only assets directly inside that
 * folder are returned — used by the folder tree UI for per-folder grids.
 *
 * To list every asset in a project regardless of folder, pass scope: "all".
 */
export const list = query({
  args: {
    projectId: v.id("projects"),
    folderId: v.optional(v.id("folders")),
    scope: v.optional(v.union(v.literal("folder"), v.literal("all"))),
  },
  handler: async (ctx, args) => {
    await requireProjectAccess(ctx, args.projectId);

    const scope = args.scope ?? "folder";
    const assets =
      scope === "all"
        ? await ctx.db
            .query("assets")
            .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
            .order("desc")
            .collect()
        : await ctx.db
            .query("assets")
            .withIndex("by_project_and_folder", (q) =>
              q.eq("projectId", args.projectId).eq("folderId", args.folderId),
            )
            .order("desc")
            .collect();

    return await Promise.all(
      assets.map(async (asset) => {
        const comments = await ctx.db
          .query("comments")
          .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
          .collect();

        return {
          ...asset,
          uploaderName: asset.uploaderName ?? "Unknown",
          workflowStatus: normalizeWorkflowStatus(asset.workflowStatus),
          commentCount: comments.length,
        };
      }),
    );
  },
});

export const get = query({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    const { asset, membership } = await requireAssetAccess(ctx, args.assetId);
    return {
      ...asset,
      uploaderName: asset.uploaderName ?? "Unknown",
      workflowStatus: normalizeWorkflowStatus(asset.workflowStatus),
      role: membership.role,
    };
  },
});

export const getByPublicId = query({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.publicId))
      .unique();

    if (!asset || asset.visibility !== "public" || asset.status !== "ready") {
      return null;
    }

    return {
      asset: {
        _id: asset._id,
        assetKind: asset.assetKind,
        title: asset.title,
        description: asset.description,
        duration: asset.duration,
        thumbnailUrl: asset.thumbnailUrl,
        muxAssetId: asset.muxAssetId,
        muxPlaybackId: asset.muxPlaybackId,
        contentType: asset.contentType,
        s3Key: asset.s3Key,
      },
    };
  },
});

export const getByPublicIdForDownload = query({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_public_id", (q) => q.eq("publicId", args.publicId))
      .unique();

    if (!asset || asset.visibility !== "public") {
      return null;
    }

    return {
      asset: {
        _id: asset._id,
        title: asset.title,
        contentType: asset.contentType,
        s3Key: asset.s3Key,
        status: asset.status,
      },
    };
  },
});

export const getPublicIdByAssetId = query({
  args: { assetId: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const normalizedAssetId = ctx.db.normalizeId("assets", args.assetId);
    if (!normalizedAssetId) {
      return null;
    }

    const asset = await ctx.db.get(normalizedAssetId);
    if (!asset || asset.visibility !== "public" || asset.status !== "ready" || !asset.publicId) {
      return null;
    }

    return asset.publicId;
  },
});

export const getByShareGrant = query({
  args: { grantToken: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveActiveShareGrant(ctx, args.grantToken);
    if (!resolved) {
      return null;
    }

    if (!resolved.shareLink.assetId) {
      return null;
    }
    const asset = await ctx.db.get(resolved.shareLink.assetId);
    if (!asset || asset.status !== "ready") {
      return null;
    }

    return {
      asset: {
        _id: asset._id,
        assetKind: asset.assetKind,
        title: asset.title,
        description: asset.description,
        duration: asset.duration,
        thumbnailUrl: asset.thumbnailUrl,
        muxAssetId: asset.muxAssetId,
        muxPlaybackId: asset.muxPlaybackId,
        contentType: asset.contentType,
        s3Key: asset.s3Key,
      },
      grantExpiresAt: resolved.grant.expiresAt,
    };
  },
});

export const getByShareGrantForDownload = query({
  args: { grantToken: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveActiveShareGrant(ctx, args.grantToken);
    if (!resolved) {
      return null;
    }

    if (!resolved.shareLink.assetId) {
      return null;
    }
    const asset = await ctx.db.get(resolved.shareLink.assetId);
    if (!asset) {
      return null;
    }

    return {
      allowDownload: resolved.shareLink.allowDownload,
      grantExpiresAt: resolved.grant.expiresAt,
      asset: {
        _id: asset._id,
        title: asset.title,
        contentType: asset.contentType,
        s3Key: asset.s3Key,
        status: asset.status,
      },
    };
  },
});

export const update = mutation({
  args: {
    assetId: v.id("assets"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireAssetAccess(ctx, args.assetId, "member");

    const updates: Partial<{ title: string; description: string }> = {};
    if (args.title !== undefined) updates.title = args.title;
    if (args.description !== undefined) updates.description = args.description;

    await ctx.db.patch(args.assetId, updates);
  },
});

export const setVisibility = mutation({
  args: {
    assetId: v.id("assets"),
    visibility: visibilityValidator,
  },
  handler: async (ctx, args) => {
    await requireAssetAccess(ctx, args.assetId, "member");

    await ctx.db.patch(args.assetId, {
      visibility: args.visibility,
    });
  },
});

export const updateWorkflowStatus = mutation({
  args: {
    assetId: v.id("assets"),
    workflowStatus: workflowStatusValidator,
  },
  handler: async (ctx, args) => {
    await requireAssetAccess(ctx, args.assetId, "member");

    await ctx.db.patch(args.assetId, {
      workflowStatus: args.workflowStatus,
    });
  },
});

export const remove = mutation({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    await requireAssetAccess(ctx, args.assetId, "admin");

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_asset", (q) => q.eq("assetId", args.assetId))
      .collect();
    for (const comment of comments) {
      await ctx.db.delete(comment._id);
    }

    const shareLinks = await ctx.db
      .query("shareLinks")
      .withIndex("by_asset", (q) => q.eq("assetId", args.assetId))
      .collect();
    for (const link of shareLinks) {
      await deleteShareAccessGrantsForLink(ctx, link._id);
      await ctx.db.delete(link._id);
    }

    await ctx.db.delete(args.assetId);
  },
});

export const setUploadInfo = internalMutation({
  args: {
    assetId: v.id("assets"),
    s3Key: v.string(),
    fileSize: v.number(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.assetId);
    const isVideo = existing?.assetKind === "video";
    await ctx.db.patch(args.assetId, {
      s3Key: args.s3Key,
      muxUploadId: undefined,
      muxAssetId: undefined,
      muxPlaybackId: undefined,
      muxAssetStatus: isVideo ? "preparing" : undefined,
      thumbnailUrl: undefined,
      duration: undefined,
      uploadError: undefined,
      fileSize: args.fileSize,
      contentType: args.contentType,
      status: "uploading",
    });
  },
});

export const reconcileUploadedObjectMetadata = internalMutation({
  args: {
    assetId: v.id("assets"),
    fileSize: v.number(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    const asset = await ctx.db.get(args.assetId);
    if (!asset) {
      throw new Error("Asset not found");
    }

    const project = await ctx.db.get(asset.projectId);
    if (!project) {
      throw new Error("Project not found");
    }

    const declaredSize =
      typeof asset.fileSize === "number" && Number.isFinite(asset.fileSize)
        ? Math.max(0, asset.fileSize)
        : 0;
    const actualSize = Number.isFinite(args.fileSize) ? Math.max(0, args.fileSize) : 0;
    const sizeDelta = actualSize - declaredSize;

    if (sizeDelta > 0) {
      await assertTeamCanStoreBytes(ctx, project.teamId, sizeDelta);
    }

    await ctx.db.patch(args.assetId, {
      fileSize: actualSize,
      contentType: args.contentType,
    });
  },
});

export const markAsProcessing = internalMutation({
  args: {
    assetId: v.id("assets"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      status: "processing",
      muxAssetStatus: "preparing",
      uploadError: undefined,
    });
  },
});

export const markAsReady = internalMutation({
  args: {
    assetId: v.id("assets"),
    muxAssetId: v.string(),
    muxPlaybackId: v.string(),
    duration: v.optional(v.number()),
    thumbnailUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      muxAssetId: args.muxAssetId,
      muxPlaybackId: args.muxPlaybackId,
      muxAssetStatus: "ready",
      duration: args.duration,
      thumbnailUrl: args.thumbnailUrl,
      uploadError: undefined,
      status: "ready",
    });
  },
});

/**
 * Non-video kinds (image / audio / doc / other) skip Mux entirely. Once the
 * S3 PUT is verified, this flips status straight to ready.
 */
export const markNonVideoReady = internalMutation({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      status: "ready",
      uploadError: undefined,
    });
  },
});

/** Move an asset to a different folder (or to project root via undefined). */
export const moveToFolder = mutation({
  args: {
    assetId: v.id("assets"),
    folderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const { asset } = await requireAssetAccess(ctx, args.assetId, "member");
    if (args.folderId) {
      const folder = await ctx.db.get(args.folderId);
      if (!folder || folder.projectId !== asset.projectId) {
        throw new Error("Target folder is in a different project.");
      }
    }
    await ctx.db.patch(args.assetId, { folderId: args.folderId });
  },
});

export const markAsFailed = internalMutation({
  args: {
    assetId: v.id("assets"),
    uploadError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      muxAssetStatus: "errored",
      uploadError: args.uploadError,
      status: "failed",
    });
  },
});

export const setMuxAssetReference = internalMutation({
  args: {
    assetId: v.id("assets"),
    muxAssetId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      muxAssetId: args.muxAssetId,
      muxAssetStatus: "preparing",
      status: "processing",
    });
  },
});

export const setMuxPlaybackId = internalMutation({
  args: {
    assetId: v.id("assets"),
    muxPlaybackId: v.string(),
    thumbnailUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.assetId, {
      muxPlaybackId: args.muxPlaybackId,
      thumbnailUrl: args.thumbnailUrl,
    });
  },
});

export const getAssetByMuxUploadId = internalQuery({
  args: {
    muxUploadId: v.string(),
  },
  returns: v.union(
    v.object({
      assetId: v.id("assets"),
    }),
    v.null()
  ),
  handler: async (ctx, args): Promise<{ assetId: Id<"assets"> } | null> => {
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_mux_upload_id", (q) => q.eq("muxUploadId", args.muxUploadId))
      .unique();

    if (!asset) return null;
    return { assetId: asset._id };
  },
});

export const getAssetByMuxAssetId = internalQuery({
  args: {
    muxAssetId: v.string(),
  },
  returns: v.union(
    v.object({
      assetId: v.id("assets"),
    }),
    v.null()
  ),
  handler: async (ctx, args): Promise<{ assetId: Id<"assets"> } | null> => {
    const asset = await ctx.db
      .query("assets")
      .withIndex("by_mux_asset_id", (q) => q.eq("muxAssetId", args.muxAssetId))
      .unique();

    if (!asset) return null;
    return { assetId: asset._id };
  },
});

export const getAssetForPlayback = query({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    const { asset } = await requireAssetAccess(ctx, args.assetId, "viewer");
    return asset;
  },
});

export const incrementViewCount = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const shareLink = await ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    if (shareLink) {
      await ctx.db.patch(shareLink._id, {
        viewCount: shareLink.viewCount + 1,
      });
    }
  },
});

export const updateDuration = mutation({
  args: {
    assetId: v.id("assets"),
    duration: v.number(),
  },
  handler: async (ctx, args) => {
    await requireAssetAccess(ctx, args.assetId, "member");
    await ctx.db.patch(args.assetId, { duration: args.duration });
  },
});
