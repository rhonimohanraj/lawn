import { v } from "convex/values";
import { mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  identityAvatarUrl,
  identityName,
  requireAssetAccess,
  requireUser,
} from "./auth";
import { resolveActiveShareGrant } from "./shareAccess";
import { touchAsset, touchAssetById } from "./activity";
import { assetIsInShareScope } from "./shareScope";

function toThreadedComments<T extends { _id: string; parentId?: string; timestampSeconds: number; _creationTime: number }>(
  comments: T[],
) {
  const topLevel = comments
    .filter((c) => !c.parentId)
    .sort((a, b) => a.timestampSeconds - b.timestampSeconds);

  return topLevel.map((comment) => ({
    ...comment,
    replies: comments
      .filter((c) => c.parentId === comment._id)
      .sort((a, b) => a._creationTime - b._creationTime),
  }));
}

function toPublicCommentPayload(comment: {
  _id: string;
  _creationTime: number;
  text: string;
  timestampSeconds: number;
  parentId?: string;
  resolved: boolean;
  userName: string;
  userAvatarUrl?: string;
}) {
  return {
    _id: comment._id,
    _creationTime: comment._creationTime,
    text: comment.text,
    timestampSeconds: comment.timestampSeconds,
    parentId: comment.parentId,
    resolved: comment.resolved,
    userName: comment.userName,
    userAvatarUrl: comment.userAvatarUrl,
  };
}

async function getPublicAssetByPublicId(
  ctx: QueryCtx | MutationCtx,
  publicId: string,
) {
  const asset = await ctx.db
    .query("assets")
    .withIndex("by_public_id", (q) => q.eq("publicId", publicId))
    .unique();

  if (!asset || asset.visibility !== "public" || asset.status !== "ready") {
    return null;
  }

  return asset;
}

export const list = query({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    await requireAssetAccess(ctx, args.assetId);

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_asset", (q) => q.eq("assetId", args.assetId))
      .collect();

    return comments.sort((a, b) => a.timestampSeconds - b.timestampSeconds);
  },
});

export const create = mutation({
  args: {
    assetId: v.id("assets"),
    text: v.string(),
    timestampSeconds: v.number(),
    parentId: v.optional(v.id("comments")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireAssetAccess(ctx, args.assetId, "viewer");

    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (!parent) throw new Error("Parent comment not found.");
      if (!parent.assetId) {
        throw new Error(
          "Cannot reply to an unmigrated comment — please reload after the data migration completes.",
        );
      }
      if (parent.assetId !== args.assetId) {
        throw new Error("Parent comment belongs to a different asset.");
      }
    }

    const commentId = await ctx.db.insert("comments", {
      assetId: args.assetId,
      userClerkId: user.subject,
      userName: identityName(user),
      userAvatarUrl: identityAvatarUrl(user),
      text: args.text,
      timestampSeconds: args.timestampSeconds,
      parentId: args.parentId,
      resolved: false,
    });

    await touchAssetById(ctx, args.assetId);
    return commentId;
  },
});

function sanitizeGuestName(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/\s+/g, " ").slice(0, 80);
  return trimmed.length >= 1 ? trimmed : null;
}

export const createForPublic = mutation({
  args: {
    publicId: v.string(),
    text: v.string(),
    timestampSeconds: v.number(),
    parentId: v.optional(v.id("comments")),
    guestName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const guestName = sanitizeGuestName(args.guestName);

    if (!identity && !guestName) {
      throw new Error("Name is required to comment as a guest");
    }

    const asset = await getPublicAssetByPublicId(ctx, args.publicId);

    if (!asset) {
      throw new Error("Asset not found");
    }

    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (!parent || parent.assetId !== asset._id) {
        throw new Error("Invalid parent comment");
      }
    }

    const commentId = await ctx.db.insert("comments", {
      assetId: asset._id,
      userClerkId: identity?.subject,
      userName: identity ? identityName(identity) : (guestName as string),
      userAvatarUrl: identity ? identityAvatarUrl(identity) : undefined,
      text: args.text,
      timestampSeconds: args.timestampSeconds,
      parentId: args.parentId,
      resolved: false,
    });

    await touchAsset(ctx, asset);
    return commentId;
  },
});

/**
 * Comment on an asset reachable via a share grant.
 *
 * For asset-scoped shares, `assetId` is implied by the link and the param
 * is optional (asserted to match if passed). For folder/project shares, the
 * client MUST pass the assetId they're commenting on, and we scope-validate
 * it against the share's reach.
 */
export const createForShareGrant = mutation({
  args: {
    grantToken: v.string(),
    text: v.string(),
    timestampSeconds: v.number(),
    parentId: v.optional(v.id("comments")),
    guestName: v.optional(v.string()),
    assetId: v.optional(v.id("assets")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const guestName = sanitizeGuestName(args.guestName);

    if (!identity && !guestName) {
      throw new Error("Name is required to comment as a guest");
    }

    const resolved = await resolveActiveShareGrant(ctx, args.grantToken);
    if (!resolved) {
      throw new Error("Invalid share grant");
    }

    // Determine target asset based on share scope.
    let targetAssetId: Id<"assets"> | null = null;
    if (resolved.shareLink.assetId) {
      if (args.assetId && args.assetId !== resolved.shareLink.assetId) {
        throw new Error("Asset is outside this share's scope.");
      }
      targetAssetId = resolved.shareLink.assetId;
    } else {
      if (!args.assetId) {
        throw new Error("assetId is required for folder/project share grants.");
      }
      targetAssetId = args.assetId;
    }

    const asset = await ctx.db.get(targetAssetId);
    if (!asset || asset.status !== "ready") {
      throw new Error("Asset not found");
    }

    if (!(await assetIsInShareScope(ctx, asset, resolved.shareLink))) {
      throw new Error("Asset is outside this share's scope.");
    }

    if (args.parentId) {
      const parent = await ctx.db.get(args.parentId);
      if (!parent || parent.assetId !== asset._id) {
        throw new Error("Invalid parent comment");
      }
    }

    const commentId = await ctx.db.insert("comments", {
      assetId: asset._id,
      userClerkId: identity?.subject,
      userName: identity ? identityName(identity) : (guestName as string),
      userAvatarUrl: identity ? identityAvatarUrl(identity) : undefined,
      text: args.text,
      timestampSeconds: args.timestampSeconds,
      parentId: args.parentId,
      resolved: false,
    });

    await touchAsset(ctx, asset);
    return commentId;
  },
});

export const update = mutation({
  args: {
    commentId: v.id("comments"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);

    const comment = await ctx.db.get(args.commentId);
    if (!comment) throw new Error("Comment not found");

    if (comment.userClerkId !== user.subject) {
      throw new Error("You can only edit your own comments");
    }

    await ctx.db.patch(args.commentId, { text: args.text });
    if (comment.assetId) {
      await touchAssetById(ctx, comment.assetId);
    }
  },
});

export const remove = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);

    const comment = await ctx.db.get(args.commentId);
    if (!comment) throw new Error("Comment not found");

    if (comment.userClerkId !== user.subject) {
      if (!comment.assetId) {
        throw new Error("Comment missing assetId — corrupt row.");
      }
      await requireAssetAccess(ctx, comment.assetId, "admin");
    }

    const replies = await ctx.db
      .query("comments")
      .withIndex("by_parent", (q) => q.eq("parentId", args.commentId))
      .collect();

    for (const reply of replies) {
      await ctx.db.delete(reply._id);
    }

    await ctx.db.delete(args.commentId);
    if (comment.assetId) {
      await touchAssetById(ctx, comment.assetId);
    }
  },
});

export const toggleResolved = mutation({
  args: { commentId: v.id("comments") },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.commentId);
    if (!comment) throw new Error("Comment not found");

    if (!comment.assetId) {
      throw new Error("Comment missing assetId — corrupt row.");
    }
    await requireAssetAccess(ctx, comment.assetId, "member");

    await ctx.db.patch(args.commentId, { resolved: !comment.resolved });
    await touchAssetById(ctx, comment.assetId);
  },
});

export const getThreaded = query({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    await requireAssetAccess(ctx, args.assetId);

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_asset", (q) => q.eq("assetId", args.assetId))
      .collect();

    return toThreadedComments(comments);
  },
});

export const getThreadedForPublic = query({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    const asset = await getPublicAssetByPublicId(ctx, args.publicId);
    if (!asset) {
      return [];
    }

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
      .collect();

    return toThreadedComments(comments.map(toPublicCommentPayload));
  },
});

export const getThreadedForShareGrant = query({
  args: {
    grantToken: v.string(),
    assetId: v.optional(v.id("assets")),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveActiveShareGrant(ctx, args.grantToken);
    if (!resolved) {
      return [];
    }

    let targetAssetId: Id<"assets"> | null = null;
    if (resolved.shareLink.assetId) {
      if (args.assetId && args.assetId !== resolved.shareLink.assetId) {
        return [];
      }
      targetAssetId = resolved.shareLink.assetId;
    } else {
      if (!args.assetId) return [];
      targetAssetId = args.assetId;
    }

    const asset = await ctx.db.get(targetAssetId);
    if (!asset || asset.status !== "ready") {
      return [];
    }

    if (!(await assetIsInShareScope(ctx, asset, resolved.shareLink))) {
      return [];
    }

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_asset", (q) => q.eq("assetId", asset._id))
      .collect();

    return toThreadedComments(comments.map(toPublicCommentPayload));
  },
});
