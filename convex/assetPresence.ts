import { Presence } from "@convex-dev/presence";
import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query, MutationCtx } from "./_generated/server";
import {
  identityAvatarUrl,
  identityName,
  requireProjectAccess,
  requireAssetAccess,
} from "./auth";
import { findShareLinkByToken } from "./shareAccess";

const presence = new Presence(components.presence);
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

const watcherDataValidator = v.object({
  kind: v.union(v.literal("member"), v.literal("guest")),
  displayName: v.string(),
  avatarUrl: v.optional(v.string()),
});

function roomIdForVideo(assetId: string) {
  return `asset:${assetId}`;
}

function guestDisplayName(clientId: string) {
  const suffix = clientId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
  return `Guest ${suffix || "USER"}`;
}

async function hasShareTokenAccess(
  ctx: MutationCtx,
  shareToken: string | undefined,
  assetId: string,
) {
  if (!shareToken) return false;

  const shareLink = await findShareLinkByToken(ctx, shareToken);
  if (!shareLink) return false;
  if (shareLink.expiresAt && shareLink.expiresAt <= Date.now()) return false;

  return shareLink.assetId === assetId;
}

export const heartbeat = mutation({
  args: {
    assetId: v.id("assets"),
    sessionId: v.string(),
    clientId: v.string(),
    interval: v.optional(v.number()),
    shareToken: v.optional(v.string()),
  },
  returns: v.object({
    roomToken: v.string(),
    sessionToken: v.string(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();

    let hasAssetAccess = false;
    if (identity) {
      try {
        await requireAssetAccess(ctx, args.assetId, "viewer");
        hasAssetAccess = true;
      } catch {
        hasAssetAccess = false;
      }
    }

    const hasTokenAccess = await hasShareTokenAccess(
      ctx,
      args.shareToken,
      args.assetId,
    );

    if (!hasAssetAccess && !hasTokenAccess) {
      throw new ConvexError({
        code: "UNAUTHORIZED",
        message: "You do not have access to this asset.",
      });
    }

    const roomId = roomIdForVideo(args.assetId);
    let userId: string;
    let data: {
      kind: "member" | "guest";
      displayName: string;
      avatarUrl?: string;
    };

    if (identity) {
      userId = `clerk:${identity.subject}`;
      data = {
        kind: "member",
        displayName: identityName(identity),
        avatarUrl: identityAvatarUrl(identity),
      };
    } else {
      const clientId = args.clientId.trim();
      if (!clientId) {
        throw new ConvexError({
          code: "BAD_REQUEST",
          message: "Missing client identifier.",
        });
      }

      userId = `guest:${clientId}`;
      data = {
        kind: "guest",
        displayName: guestDisplayName(clientId),
      };
    }

    const result = await presence.heartbeat(
      ctx,
      roomId,
      userId,
      args.sessionId,
      args.interval ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    );
    await presence.updateRoomUser(ctx, roomId, userId, data);
    return result;
  },
});

export const list = query({
  args: {
    roomToken: v.string(),
  },
  returns: v.array(
    v.object({
      userId: v.string(),
      online: v.boolean(),
      lastDisconnected: v.number(),
      data: v.optional(watcherDataValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const state = await presence.list(ctx, args.roomToken);

    return state.map((entry) => {
      const raw = entry.data;
      const parsed =
        raw &&
        typeof raw === "object" &&
        ("kind" in raw || "displayName" in raw) &&
        (raw as { kind?: string }).kind &&
        (raw as { displayName?: string }).displayName
          ? (raw as {
              kind: "member" | "guest";
              displayName: string;
              avatarUrl?: string;
            })
          : undefined;

      if (parsed) {
        return {
          userId: entry.userId,
          online: entry.online,
          lastDisconnected: entry.lastDisconnected,
          data: parsed,
        };
      }

      if (entry.userId.startsWith("guest:")) {
        const clientId = entry.userId.slice("guest:".length);
        return {
          userId: entry.userId,
          online: entry.online,
          lastDisconnected: entry.lastDisconnected,
          data: {
            kind: "guest" as const,
            displayName: guestDisplayName(clientId),
          },
        };
      }

      return {
        userId: entry.userId,
        online: entry.online,
        lastDisconnected: entry.lastDisconnected,
        data: {
          kind: "member" as const,
          displayName: "Member",
        },
      };
    });
  },
});

export const disconnect = mutation({
  args: {
    sessionToken: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await presence.disconnect(ctx, args.sessionToken);
    return null;
  },
});

/**
 * Originally this query iterated every asset in the project and called
 * `presence.listRoom` for each — fine for small projects, but blew up on
 * the 1,800-asset 00 Three Point Studios project with a Convex compute-time
 * timeout (10s limit, ~1800 component queries × N ms each). The timeout is
 * killed at the system level, so JS try/catch can't recover; the React
 * error boundary then replaces the entire dashboard with a generic error.
 *
 * Fix: scope the presence count to the assets actually visible on the page
 * — the current folder only — by accepting an optional folderId. The
 * frontend already only uses counts for the current folder's videos, so
 * scoping the query to match is the right shape.
 *
 * The legacy unscoped call (no folderId arg) returns empty counts — the
 * "N watching" badge is cosmetic and never worth blowing up the page over.
 */
export const listProjectOnlineCounts = query({
  args: {
    projectId: v.id("projects"),
    /** Restricts the count to assets directly in this folder (or the
     *  project root if undefined). When omitted entirely, returns
     *  empty counts to avoid timing out on large projects. */
    folderId: v.optional(v.id("folders")),
    scope: v.optional(v.union(v.literal("folder"), v.literal("project"))),
  },
  returns: v.object({
    counts: v.record(v.string(), v.number()),
  }),
  handler: async (ctx, args) => {
    try {
      try {
        await requireProjectAccess(ctx, args.projectId, "viewer");
      } catch {
        return { counts: {} };
      }

      const scope = args.scope ?? "folder";
      // No folder scope provided + project-wide scope = legacy call shape.
      // Skip the work — see comment above the query.
      if (scope === "project" && args.folderId === undefined) {
        return { counts: {} };
      }

      const assets = await ctx.db
        .query("assets")
        .withIndex("by_project_and_folder", (q) =>
          q.eq("projectId", args.projectId).eq("folderId", args.folderId),
        )
        .collect();

      // Cap the parallelism at a sensible bound. Even on a folder, we
      // shouldn't run unbounded `presence.listRoom` calls.
      const MAX = 100;
      const slice = assets.slice(0, MAX);

      const counts: Record<string, number> = {};
      await Promise.all(
        slice.map(async (asset) => {
          try {
            const onlineUsers = await presence.listRoom(
              ctx,
              roomIdForVideo(asset._id),
              true,
            );
            counts[asset._id] = onlineUsers.length;
          } catch {
            counts[asset._id] = 0;
          }
        }),
      );

      return { counts };
    } catch {
      return { counts: {} };
    }
  },
});
