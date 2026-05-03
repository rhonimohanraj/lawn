import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// ────────────────────────────────────────────────────────────────────────────
// Frame schema
//
// `assets` is the canonical content table — replaces the old `videos` table.
// `assetKind` enum gates per-type behavior (only "video" runs through Mux).
// `folders` enables arbitrary nesting within a project.
//
// The data migration in convex/assetsMigration.ts must run BEFORE this
// schema deploys to prod — it copies videos → assets and rewires comments
// + shareLinks foreign keys. Run from the Convex dashboard or via
// `bunx convex run assetsMigration:migrateVideosBatch` etc., re-running
// each batch until {done: true, processed: 0}, then verify with
// `bunx convex run assetsMigration:migrationStatus` before this deploys.
// ────────────────────────────────────────────────────────────────────────────

export const ASSET_KINDS = [
  "video",
  "image",
  "audio",
  "doc",
  "other",
] as const;

export const assetKindValidator = v.union(
  v.literal("video"),
  v.literal("image"),
  v.literal("audio"),
  v.literal("doc"),
  v.literal("other"),
);

export default defineSchema({
  teams: defineTable({
    name: v.string(),
    slug: v.string(),
    ownerClerkId: v.string(),
    plan: v.union(
      v.literal("basic"),
      v.literal("pro"),
      v.literal("free"),
      v.literal("team")
    ),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    stripePriceId: v.optional(v.string()),
    billingStatus: v.optional(v.string()),
  })
    .index("by_slug", ["slug"])
    .index("by_owner", ["ownerClerkId"])
    .index("by_stripe_customer_id", ["stripeCustomerId"])
    .index("by_stripe_subscription_id", ["stripeSubscriptionId"]),

  teamMembers: defineTable({
    teamId: v.id("teams"),
    userClerkId: v.string(),
    userEmail: v.string(),
    userName: v.string(),
    userAvatarUrl: v.optional(v.string()),
    role: v.union(
      v.literal("owner"),
      v.literal("admin"),
      v.literal("member"),
      v.literal("viewer")
    ),
  })
    .index("by_team", ["teamId"])
    .index("by_user", ["userClerkId"])
    .index("by_team_and_user", ["teamId", "userClerkId"])
    .index("by_team_and_email", ["teamId", "userEmail"]),

  teamInvites: defineTable({
    teamId: v.id("teams"),
    email: v.string(),
    role: v.union(
      v.literal("admin"),
      v.literal("member"),
      v.literal("viewer")
    ),
    invitedByClerkId: v.string(),
    invitedByName: v.string(),
    token: v.string(),
    expiresAt: v.number(),
  })
    .index("by_team", ["teamId"])
    .index("by_email", ["email"])
    .index("by_token", ["token"]),

  projects: defineTable({
    teamId: v.id("teams"),
    name: v.string(),
    description: v.optional(v.string()),
  }).index("by_team", ["teamId"]),

  // Nested folders inside a project. parentFolderId === undefined means
  // the folder lives at the project root.
  folders: defineTable({
    projectId: v.id("projects"),
    parentFolderId: v.optional(v.id("folders")),
    name: v.string(),
    createdByClerkId: v.string(),
  })
    .index("by_project", ["projectId"])
    .index("by_parent", ["parentFolderId"])
    .index("by_project_and_parent", ["projectId", "parentFolderId"]),

  // NEW canonical table — replaces `videos`. Holds every file type uploaded
  // to a project (video / image / audio / doc / other). Mux fields populated
  // only when assetKind === "video".
  assets: defineTable({
    projectId: v.id("projects"),
    folderId: v.optional(v.id("folders")),
    assetKind: assetKindValidator,
    uploadedByClerkId: v.string(),
    uploaderName: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    visibility: v.union(v.literal("public"), v.literal("private")),
    publicId: v.string(),
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxAssetStatus: v.optional(
      v.union(
        v.literal("preparing"),
        v.literal("ready"),
        v.literal("errored")
      )
    ),
    s3Key: v.optional(v.string()),
    duration: v.optional(v.number()),
    thumbnailUrl: v.optional(v.string()),
    fileSize: v.optional(v.number()),
    contentType: v.optional(v.string()),
    uploadError: v.optional(v.string()),
    status: v.union(
      v.literal("uploading"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed")
    ),
    workflowStatus: v.union(
      v.literal("review"),
      v.literal("rework"),
      v.literal("done"),
    ),
    // Bookkeeping for the videos→assets data migration: when a row was
    // copied from `videos`, this stores the original videos._id so we can
    // rewrite foreign keys on comments + shareLinks deterministically.
    legacyVideoId: v.optional(v.id("videos")),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_folder", ["projectId", "folderId"])
    .index("by_folder", ["folderId"])
    .index("by_public_id", ["publicId"])
    .index("by_mux_upload_id", ["muxUploadId"])
    .index("by_mux_asset_id", ["muxAssetId"])
    .index("by_mux_playback_id", ["muxPlaybackId"])
    .index("by_legacy_video_id", ["legacyVideoId"]),

  // DEPRECATED: kept in the schema only so that prod data continues to
  // validate while the videos→assets migration runs. After migration is
  // verified in prod, delete this table definition + drop the data.
  videos: defineTable({
    projectId: v.id("projects"),
    uploadedByClerkId: v.string(),
    uploaderName: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    visibility: v.union(v.literal("public"), v.literal("private")),
    publicId: v.string(),
    muxUploadId: v.optional(v.string()),
    muxAssetId: v.optional(v.string()),
    muxPlaybackId: v.optional(v.string()),
    muxAssetStatus: v.optional(
      v.union(
        v.literal("preparing"),
        v.literal("ready"),
        v.literal("errored")
      )
    ),
    s3Key: v.optional(v.string()),
    duration: v.optional(v.number()),
    thumbnailUrl: v.optional(v.string()),
    fileSize: v.optional(v.number()),
    contentType: v.optional(v.string()),
    uploadError: v.optional(v.string()),
    status: v.union(
      v.literal("uploading"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("failed")
    ),
    workflowStatus: v.union(
      v.literal("review"),
      v.literal("rework"),
      v.literal("done"),
    ),
  })
    .index("by_project", ["projectId"])
    .index("by_public_id", ["publicId"])
    .index("by_mux_upload_id", ["muxUploadId"])
    .index("by_mux_asset_id", ["muxAssetId"])
    .index("by_mux_playback_id", ["muxPlaybackId"]),

  // comments + shareLinks reference an asset. During the migration window
  // BOTH `assetId` (new) and `videoId` (legacy) are accepted; new code
  // writes only `assetId`.
  comments: defineTable({
    assetId: v.optional(v.id("assets")),
    videoId: v.optional(v.id("videos")),
    userClerkId: v.optional(v.string()),
    userName: v.string(),
    userAvatarUrl: v.optional(v.string()),
    text: v.string(),
    timestampSeconds: v.number(),
    parentId: v.optional(v.id("comments")),
    resolved: v.boolean(),
  })
    .index("by_asset", ["assetId"])
    .index("by_video", ["videoId"])
    .index("by_asset_and_timestamp", ["assetId", "timestampSeconds"])
    .index("by_video_and_timestamp", ["videoId", "timestampSeconds"])
    .index("by_parent", ["parentId"]),

  shareLinks: defineTable({
    assetId: v.optional(v.id("assets")),
    videoId: v.optional(v.id("videos")),
    token: v.string(),
    createdByClerkId: v.string(),
    createdByName: v.string(),
    expiresAt: v.optional(v.number()),
    allowDownload: v.boolean(),
    password: v.optional(v.string()),
    passwordHash: v.optional(v.string()),
    failedAccessAttempts: v.optional(v.number()),
    lockedUntil: v.optional(v.number()),
    viewCount: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_asset", ["assetId"])
    .index("by_video", ["videoId"]),

  shareAccessGrants: defineTable({
    shareLinkId: v.id("shareLinks"),
    token: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_share_link", ["shareLinkId"]),
});
