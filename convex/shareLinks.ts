import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { mutation, query, MutationCtx } from "./_generated/server";
import {
  identityName,
  requireAssetAccess,
  requireFolderAccess,
  requireProjectAccess,
} from "./auth";
import { generateUniqueToken, hashPassword, verifyPassword } from "./security";
import {
  findShareLinkByToken,
  issueShareAccessGrant,
  resolveActiveShareGrant,
} from "./shareAccess";
import { folderIsInShareScope, shareLinkScope } from "./shareScope";

const shareLinkStatusValidator = v.union(
  v.literal("missing"),
  v.literal("expired"),
  v.literal("requiresPassword"),
  v.literal("ok"),
);

const shareScopeKindValidator = v.union(
  v.literal("asset"),
  v.literal("folder"),
  v.literal("project"),
);

const MAX_SHARE_PASSWORD_LENGTH = 256;
const PASSWORD_MAX_FAILED_ATTEMPTS = 5;
const PASSWORD_LOCKOUT_MS = 10 * MINUTE;

const shareLinkRateLimiter = new RateLimiter(components.rateLimiter, {
  grantGlobal: {
    kind: "fixed window",
    rate: 600,
    period: MINUTE,
    shards: 8,
  },
  grantByToken: {
    kind: "fixed window",
    rate: 120,
    period: MINUTE,
  },
  passwordFailuresByToken: {
    kind: "fixed window",
    rate: 10,
    period: MINUTE,
  },
});

function hasPasswordProtection(
  link: Pick<Doc<"shareLinks">, "password" | "passwordHash">,
) {
  return Boolean(link.passwordHash || link.password);
}

function normalizeProvidedPassword(password: string | null | undefined) {
  if (password === undefined || password === null || password.length === 0) {
    return undefined;
  }

  if (password.length > MAX_SHARE_PASSWORD_LENGTH) {
    throw new Error("Password is too long");
  }

  return password;
}

async function generateShareToken(ctx: MutationCtx) {
  return await generateUniqueToken(
    32,
    async (candidate) =>
      (await ctx.db
        .query("shareLinks")
        .withIndex("by_token", (q) => q.eq("token", candidate))
        .unique()) !== null,
    5,
  );
}

async function deleteShareAccessGrantsForLink(
  ctx: MutationCtx,
  shareLinkId: Id<"shareLinks">,
) {
  const grants = await ctx.db
    .query("shareAccessGrants")
    .withIndex("by_share_link", (q) => q.eq("shareLinkId", shareLinkId))
    .collect();

  for (const grant of grants) {
    await ctx.db.delete(grant._id);
  }
}

export const create = mutation({
  args: {
    assetId: v.id("assets"),
    expiresInDays: v.optional(v.number()),
    allowDownload: v.optional(v.boolean()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireAssetAccess(ctx, args.assetId, "member");

    const token = await generateShareToken(ctx);
    const expiresAt = args.expiresInDays
      ? Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000
      : undefined;
    const normalizedPassword = normalizeProvidedPassword(args.password);
    const passwordHash = normalizedPassword
      ? await hashPassword(normalizedPassword)
      : undefined;

    await ctx.db.insert("shareLinks", {
      assetId: args.assetId,
      token,
      createdByClerkId: user.subject,
      createdByName: identityName(user),
      expiresAt,
      allowDownload: args.allowDownload ?? false,
      password: undefined,
      passwordHash,
      failedAccessAttempts: 0,
      lockedUntil: undefined,
      viewCount: 0,
    });

    return { token };
  },
});

/**
 * Folder-scoped share — clients see every folder + asset under this folder.
 * Use when sharing a deliverables folder with a client; they can browse and
 * comment on each asset without you generating per-asset links.
 */
export const createForFolder = mutation({
  args: {
    folderId: v.id("folders"),
    expiresInDays: v.optional(v.number()),
    allowDownload: v.optional(v.boolean()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireFolderAccess(ctx, args.folderId, "member");

    const token = await generateShareToken(ctx);
    const expiresAt = args.expiresInDays
      ? Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000
      : undefined;
    const normalizedPassword = normalizeProvidedPassword(args.password);
    const passwordHash = normalizedPassword
      ? await hashPassword(normalizedPassword)
      : undefined;

    await ctx.db.insert("shareLinks", {
      folderId: args.folderId,
      token,
      createdByClerkId: user.subject,
      createdByName: identityName(user),
      expiresAt,
      allowDownload: args.allowDownload ?? false,
      password: undefined,
      passwordHash,
      failedAccessAttempts: 0,
      lockedUntil: undefined,
      viewCount: 0,
    });

    return { token };
  },
});

/**
 * Project-scoped share — clients see every folder + asset in the project.
 * Use sparingly; folder shares are usually the right granularity.
 */
export const createForProject = mutation({
  args: {
    projectId: v.id("projects"),
    expiresInDays: v.optional(v.number()),
    allowDownload: v.optional(v.boolean()),
    password: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireProjectAccess(ctx, args.projectId, "member");

    const token = await generateShareToken(ctx);
    const expiresAt = args.expiresInDays
      ? Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000
      : undefined;
    const normalizedPassword = normalizeProvidedPassword(args.password);
    const passwordHash = normalizedPassword
      ? await hashPassword(normalizedPassword)
      : undefined;

    await ctx.db.insert("shareLinks", {
      projectId: args.projectId,
      token,
      createdByClerkId: user.subject,
      createdByName: identityName(user),
      expiresAt,
      allowDownload: args.allowDownload ?? false,
      password: undefined,
      passwordHash,
      failedAccessAttempts: 0,
      lockedUntil: undefined,
      viewCount: 0,
    });

    return { token };
  },
});

export const list = query({
  args: { assetId: v.id("assets") },
  handler: async (ctx, args) => {
    await requireAssetAccess(ctx, args.assetId);

    const links = await ctx.db
      .query("shareLinks")
      .withIndex("by_asset", (q) => q.eq("assetId", args.assetId))
      .collect();

    const linksWithCreator = links.map((link) => ({
      _id: link._id,
      _creationTime: link._creationTime,
      assetId: link.assetId,
      token: link.token,
      createdByClerkId: link.createdByClerkId,
      createdByName: link.createdByName,
      expiresAt: link.expiresAt,
      allowDownload: link.allowDownload,
      viewCount: link.viewCount,
      hasPassword: hasPasswordProtection(link),
      creatorName: link.createdByName,
      isExpired: link.expiresAt ? link.expiresAt < Date.now() : false,
    }));

    return linksWithCreator;
  },
});

/** Auth gate that handles all three scope kinds. Returns the link doc. */
async function requireShareLinkAccess(
  ctx: MutationCtx,
  linkId: Id<"shareLinks">,
  role: "member" | "admin" = "member",
): Promise<Doc<"shareLinks">> {
  const link = await ctx.db.get(linkId);
  if (!link) throw new Error("Share link not found");

  const scope = shareLinkScope(link);
  if (scope.kind === "asset") {
    await requireAssetAccess(ctx, scope.assetId, role);
  } else if (scope.kind === "folder") {
    await requireFolderAccess(ctx, scope.folderId, role);
  } else if (scope.kind === "project") {
    await requireProjectAccess(ctx, scope.projectId, role);
  } else {
    throw new Error("Share link has no valid scope — corrupt row.");
  }
  return link;
}

export const remove = mutation({
  args: { linkId: v.id("shareLinks") },
  handler: async (ctx, args) => {
    await requireShareLinkAccess(ctx, args.linkId, "member");

    await deleteShareAccessGrantsForLink(ctx, args.linkId);
    await ctx.db.delete(args.linkId);
  },
});

export const update = mutation({
  args: {
    linkId: v.id("shareLinks"),
    expiresInDays: v.optional(v.union(v.number(), v.null())),
    allowDownload: v.optional(v.boolean()),
    password: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    await requireShareLinkAccess(ctx, args.linkId, "member");

    const updates: Partial<Doc<"shareLinks">> = {};

    if (args.expiresInDays !== undefined) {
      updates.expiresAt = args.expiresInDays
        ? Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000
        : undefined;
    }

    if (args.allowDownload !== undefined) {
      updates.allowDownload = args.allowDownload;
    }

    if (args.password !== undefined) {
      const normalizedPassword = normalizeProvidedPassword(args.password ?? undefined);
      if (normalizedPassword) {
        updates.passwordHash = await hashPassword(normalizedPassword);
        updates.password = undefined;
      } else {
        updates.passwordHash = undefined;
        updates.password = undefined;
      }
      updates.failedAccessAttempts = 0;
      updates.lockedUntil = undefined;
    }

    await ctx.db.patch(args.linkId, updates);
  },
});

export const getByToken = query({
  args: { token: v.string() },
  returns: v.object({
    status: shareLinkStatusValidator,
    scope: v.optional(shareScopeKindValidator),
  }),
  handler: async (ctx, args) => {
    const link = await findShareLinkByToken(ctx, args.token);

    if (!link) {
      return { status: "missing" as const };
    }

    if (link.expiresAt && link.expiresAt < Date.now()) {
      return { status: "expired" as const };
    }

    const scope = shareLinkScope(link);
    if (scope.kind === "invalid") {
      return { status: "missing" as const };
    }

    // Validate the scoped target still exists.
    if (scope.kind === "asset") {
      const asset = await ctx.db.get(scope.assetId);
      if (!asset || asset.status !== "ready") {
        return { status: "missing" as const };
      }
    } else if (scope.kind === "folder") {
      const folder = await ctx.db.get(scope.folderId);
      if (!folder) return { status: "missing" as const };
    } else if (scope.kind === "project") {
      const project = await ctx.db.get(scope.projectId);
      if (!project) return { status: "missing" as const };
    }

    if (hasPasswordProtection(link)) {
      return { status: "requiresPassword" as const, scope: scope.kind };
    }

    return { status: "ok" as const, scope: scope.kind };
  },
});

/**
 * Returns enough context to render the share page chrome before browsing:
 *   - scope kind
 *   - share title (project name + folder breadcrumb if folder/project scope)
 *   - the folder id the browser should "start" in (undefined for project scope
 *     means project root; folder scope returns the share's folderId)
 *
 * Doesn't read any assets — those come via browseUnderShareGrant.
 */
export const shareGrantContext = query({
  args: { grantToken: v.string() },
  handler: async (ctx, args) => {
    const resolved = await resolveActiveShareGrant(ctx, args.grantToken);
    if (!resolved) return null;

    const scope = shareLinkScope(resolved.shareLink);
    if (scope.kind === "invalid") return null;

    if (scope.kind === "asset") {
      const asset = await ctx.db.get(scope.assetId);
      if (!asset || asset.status !== "ready") return null;
      const project = await ctx.db.get(asset.projectId);
      return {
        scope: "asset" as const,
        rootAssetId: asset._id,
        title: asset.title,
        projectName: project?.name ?? null,
        startFolderId: undefined,
        crumb: [] as { _id: Id<"folders">; name: string }[],
      };
    }

    if (scope.kind === "folder") {
      const folder = await ctx.db.get(scope.folderId);
      if (!folder) return null;
      const project = await ctx.db.get(folder.projectId);

      // Build breadcrumb: project → ancestor folders (excluding the share root,
      // since that IS the share's "home" and shouldn't be a clickable parent).
      const crumb: { _id: Id<"folders">; name: string }[] = [
        { _id: folder._id, name: folder.name },
      ];
      return {
        scope: "folder" as const,
        rootAssetId: null,
        title: folder.name,
        projectName: project?.name ?? null,
        startFolderId: folder._id,
        crumb,
      };
    }

    // project scope
    const project = await ctx.db.get(scope.projectId);
    if (!project) return null;
    return {
      scope: "project" as const,
      rootAssetId: null,
      title: project.name,
      projectName: project.name,
      startFolderId: undefined,
      crumb: [] as { _id: Id<"folders">; name: string }[],
    };
  },
});

/**
 * List folders + assets at one level inside a folder/project share. The
 * client passes parentFolderId to drill in (or undefined for the share's
 * starting level). Every returned row is scope-validated.
 *
 * Asset-scoped shares: returns null. Caller should use the asset-detail
 * flow instead.
 */
export const browseUnderShareGrant = query({
  args: {
    grantToken: v.string(),
    parentFolderId: v.optional(v.id("folders")),
  },
  handler: async (ctx, args) => {
    const resolved = await resolveActiveShareGrant(ctx, args.grantToken);
    if (!resolved) return null;

    const scope = shareLinkScope(resolved.shareLink);
    if (scope.kind === "invalid" || scope.kind === "asset") {
      return null;
    }

    // Resolve which projectId to scope to + validate parentFolderId is in scope.
    let projectId: Id<"projects"> | null = null;
    let resolvedParentFolderId: Id<"folders"> | undefined = args.parentFolderId;

    if (scope.kind === "folder") {
      const root = await ctx.db.get(scope.folderId);
      if (!root) return null;
      projectId = root.projectId;
      // If client didn't pass parentFolderId, default to the share's root folder.
      if (resolvedParentFolderId === undefined) {
        resolvedParentFolderId = scope.folderId;
      } else {
        // Validate the requested folder is within the share's tree.
        const requested = await ctx.db.get(resolvedParentFolderId);
        if (!requested) return null;
        if (!(await folderIsInShareScope(ctx, requested, resolved.shareLink))) {
          return null;
        }
      }
    } else {
      // project scope
      projectId = scope.projectId;
      if (resolvedParentFolderId !== undefined) {
        const requested = await ctx.db.get(resolvedParentFolderId);
        if (!requested || requested.projectId !== projectId) return null;
      }
    }

    const folders = await ctx.db
      .query("folders")
      .withIndex("by_project_and_parent", (q) =>
        q.eq("projectId", projectId!).eq("parentFolderId", resolvedParentFolderId),
      )
      .collect();

    const assets = await ctx.db
      .query("assets")
      .withIndex("by_project_and_folder", (q) =>
        q.eq("projectId", projectId!).eq("folderId", resolvedParentFolderId),
      )
      .collect();

    // Build breadcrumb up to (and including) the parentFolderId.
    const crumb: { _id: Id<"folders">; name: string }[] = [];
    let cursor = resolvedParentFolderId;
    while (cursor) {
      const f = await ctx.db.get(cursor);
      if (!f) break;
      crumb.unshift({ _id: f._id, name: f.name });
      // For folder-scoped shares, stop at the share's root folder (don't
      // expose ancestors above it).
      if (scope.kind === "folder" && f._id === scope.folderId) break;
      cursor = f.parentFolderId;
    }

    return {
      parentFolderId: resolvedParentFolderId ?? null,
      crumb,
      folders: folders.map((f) => ({
        _id: f._id,
        _creationTime: f._creationTime,
        name: f.name,
        sizeBytes: f.sizeBytes,
        lastModifiedAt: f.lastModifiedAt,
      })),
      assets: assets
        .filter((a) => a.status === "ready")
        .map((a) => ({
          _id: a._id,
          _creationTime: a._creationTime,
          title: a.title,
          assetKind: a.assetKind,
          status: a.status,
          workflowStatus: a.workflowStatus,
          fileSize: a.fileSize,
          duration: a.duration,
          thumbnailUrl: a.thumbnailUrl,
          uploaderName: a.uploaderName,
          lastModifiedAt: a.lastModifiedAt,
        })),
    };
  },
});

export const issueAccessGrant = mutation({
  args: {
    token: v.string(),
    password: v.optional(v.string()),
  },
  returns: v.object({
    ok: v.boolean(),
    grantToken: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const globalAccessLimit = await shareLinkRateLimiter.limit(ctx, "grantGlobal");
    if (!globalAccessLimit.ok) {
      return { ok: false, grantToken: null };
    }

    const accessLimit = await shareLinkRateLimiter.limit(ctx, "grantByToken", {
      key: args.token,
    });
    if (!accessLimit.ok) {
      return { ok: false, grantToken: null };
    }

    const link = await findShareLinkByToken(ctx, args.token);

    if (!link) {
      return { ok: false, grantToken: null };
    }

    const now = Date.now();

    if (link.expiresAt && link.expiresAt <= now) {
      return { ok: false, grantToken: null };
    }

    // Validate the scope target still exists. Asset shares additionally
    // require status === "ready"; folder/project shares cover whatever is
    // currently inside, regardless of any single asset's processing state.
    const scope = shareLinkScope(link);
    if (scope.kind === "invalid") {
      return { ok: false, grantToken: null };
    }
    if (scope.kind === "asset") {
      const asset = await ctx.db.get(scope.assetId);
      if (!asset || asset.status !== "ready") {
        return { ok: false, grantToken: null };
      }
    } else if (scope.kind === "folder") {
      const folder = await ctx.db.get(scope.folderId);
      if (!folder) return { ok: false, grantToken: null };
    } else if (scope.kind === "project") {
      const project = await ctx.db.get(scope.projectId);
      if (!project) return { ok: false, grantToken: null };
    }

    if (hasPasswordProtection(link)) {
      if (link.lockedUntil && link.lockedUntil > now) {
        return { ok: false, grantToken: null };
      }

      const password = args.password ?? "";
      let passwordMatches = false;
      if (link.passwordHash) {
        passwordMatches = await verifyPassword(password, link.passwordHash);
      } else if (link.password) {
        passwordMatches = password === link.password;
      }

      if (!passwordMatches) {
        await shareLinkRateLimiter.limit(ctx, "passwordFailuresByToken", {
          key: args.token,
        });

        const failedAccessAttempts = (link.failedAccessAttempts ?? 0) + 1;
        const updates: Partial<Doc<"shareLinks">> = {
          failedAccessAttempts,
        };
        if (failedAccessAttempts >= PASSWORD_MAX_FAILED_ATTEMPTS) {
          updates.failedAccessAttempts = 0;
          updates.lockedUntil = now + PASSWORD_LOCKOUT_MS;
        }

        await ctx.db.patch(link._id, updates);
        return { ok: false, grantToken: null };
      }

      const successUpdates: Partial<Doc<"shareLinks">> = {};
      if ((link.failedAccessAttempts ?? 0) > 0) {
        successUpdates.failedAccessAttempts = 0;
      }
      if (link.lockedUntil !== undefined) {
        successUpdates.lockedUntil = undefined;
      }
      if (link.password && !link.passwordHash) {
        successUpdates.passwordHash = await hashPassword(link.password);
        successUpdates.password = undefined;
      }

      if (Object.keys(successUpdates).length > 0) {
        await ctx.db.patch(link._id, successUpdates);
      }
    }

    const grantToken = await issueShareAccessGrant(ctx, link._id);

    await ctx.db.patch(link._id, {
      viewCount: link.viewCount + 1,
    });

    return {
      ok: true,
      grantToken,
    };
  },
});
