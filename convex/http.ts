import { registerRoutes } from "@convex-dev/stripe";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import type Stripe from "stripe";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { classifyAssetKind, type AssetKind } from "./assetKind";

const http = httpRouter();

function getSubscriptionPriceId(subscription: Stripe.Subscription): string | undefined {
  return subscription.items.data[0]?.price?.id;
}

function getSubscriptionOrgId(subscription: Stripe.Subscription): string | undefined {
  const orgId = subscription.metadata.orgId;
  return typeof orgId === "string" && orgId.length > 0 ? orgId : undefined;
}

registerRoutes(http, components.stripe, {
  webhookPath: "/stripe/webhook",
  events: {
    "customer.subscription.created": async (
      ctx,
      event: Stripe.Event & { type: "customer.subscription.created" },
    ) => {
      const subscription = event.data.object as Stripe.Subscription;
      await ctx.runMutation(internal.billing.syncTeamSubscriptionFromWebhook, {
        orgId: getSubscriptionOrgId(subscription),
        stripeCustomerId:
          typeof subscription.customer === "string" ? subscription.customer : undefined,
        stripeSubscriptionId: subscription.id,
        stripePriceId: getSubscriptionPriceId(subscription),
        status: subscription.status,
      });
    },
    "customer.subscription.updated": async (
      ctx,
      event: Stripe.Event & { type: "customer.subscription.updated" },
    ) => {
      const subscription = event.data.object as Stripe.Subscription;
      await ctx.runMutation(internal.billing.syncTeamSubscriptionFromWebhook, {
        orgId: getSubscriptionOrgId(subscription),
        stripeCustomerId:
          typeof subscription.customer === "string" ? subscription.customer : undefined,
        stripeSubscriptionId: subscription.id,
        stripePriceId: getSubscriptionPriceId(subscription),
        status: subscription.status,
      });
    },
    "customer.subscription.deleted": async (
      ctx,
      event: Stripe.Event & { type: "customer.subscription.deleted" },
    ) => {
      const subscription = event.data.object as Stripe.Subscription;
      await ctx.runMutation(internal.billing.syncTeamSubscriptionFromWebhook, {
        orgId: getSubscriptionOrgId(subscription),
        stripeCustomerId:
          typeof subscription.customer === "string" ? subscription.customer : undefined,
        stripeSubscriptionId: subscription.id,
        stripePriceId: getSubscriptionPriceId(subscription),
        status: subscription.status,
      });
    },
  },
});

const muxWebhookHandler = httpAction(async (ctx, request) => {
  const rawBody = await request.text();
  const signature = request.headers.get("mux-signature") ?? undefined;

  try {
    const result = await ctx.runAction(internal.muxActions.processWebhook, {
      rawBody,
      signature,
    });

    return new Response(result.message, { status: result.status });
  } catch (error) {
    console.error("Mux webhook proxy failed", error);
    return new Response("Webhook processing failed", { status: 500 });
  }
});

http.route({ path: "/webhooks/mux", method: "POST", handler: muxWebhookHandler });
http.route({ path: "/mux/webhook", method: "POST", handler: muxWebhookHandler });

// Health check endpoint
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    return new Response("OK", { status: 200 });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Migration endpoints — one-shot Frame.io → Lawn import.
// Gated by MIGRATION_TOKEN env var on Convex prod (set via `npx convex env set`).
// ─────────────────────────────────────────────────────────────────────────────

function genPublicId(): string {
  // 12-char base32 — collision-resistant enough for migration scope, no DB lookup.
  const chars = "abcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

http.route({
  path: "/migration/teams",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.MIGRATION_TOKEN;
    if (!expected) return new Response("MIGRATION_TOKEN not set", { status: 500 });
    if (request.headers.get("x-migration-token") !== expected) return unauthorized();

    const teams = await ctx.runQuery(internal.migration.listAllTeams, {});
    return new Response(JSON.stringify({ teams }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// v2 migration endpoints — write to the `assets` table with assetKind +
// nested folder support. Caller (lawn-migrate) sends optional `folderPath`
// like "Lara & Logan/RAWs/Cam2"; we walk/create the folder hierarchy
// idempotently before stubbing the asset. The legacy v1 endpoints
// (/migration/prepare, /migration/complete) were removed when the videos
// table was retired — see commit history if you need to revive them.
// ─────────────────────────────────────────────────────────────────────────────

http.route({
  path: "/migration/v2/prepare",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.MIGRATION_TOKEN;
    if (!expected) return new Response("MIGRATION_TOKEN not set", { status: 500 });
    if (request.headers.get("x-migration-token") !== expected) return unauthorized();

    const body = (await request.json()) as {
      teamSlug: string;
      projectName: string;
      folderPath?: string; // e.g. "Lara & Logan/RAWs/Cam2"
      title: string;
      fileSize: number;
      contentType: string;
      filename: string;
      assetKind?: AssetKind; // optional override; otherwise inferred
    };

    const team = await ctx.runQuery(internal.migration.lookupTeamBySlug, {
      slug: body.teamSlug,
    });
    if (!team) {
      return new Response(`Team not found: ${body.teamSlug}`, { status: 404 });
    }

    let project = await ctx.runQuery(internal.migration.findProjectInTeam, {
      teamId: team._id,
      name: body.projectName,
    });
    if (!project) {
      const projectId = await ctx.runMutation(internal.migration.createProject, {
        teamId: team._id,
        name: body.projectName,
      });
      project = await ctx.runQuery(internal.migration.findProjectInTeam, {
        teamId: team._id,
        name: body.projectName,
      });
      if (!project) {
        return new Response(`Failed to create project ${projectId}`, { status: 500 });
      }
    }

    const folderIdResult = body.folderPath
      ? await ctx.runMutation(internal.folders.ensurePath, {
          projectId: project._id,
          path: body.folderPath,
          actorClerkId: "migration:frameio",
        })
      : undefined;
    const folderId: Id<"folders"> | undefined = folderIdResult ?? undefined;

    const assetKind: AssetKind =
      body.assetKind ??
      classifyAssetKind({ contentType: body.contentType, filename: body.filename });

    const assetId = await ctx.runMutation(internal.migration.createAssetStub, {
      projectId: project._id,
      folderId,
      assetKind,
      title: body.title,
      fileSize: body.fileSize,
      contentType: body.contentType,
      publicId: genPublicId(),
    });

    const presigned = await ctx.runAction(
      internal.migrationActions.presignMigrationAssetUpload,
      {
        assetId,
        filename: body.filename,
        contentType: body.contentType,
      },
    );

    return new Response(
      JSON.stringify({
        assetId,
        assetKind,
        teamId: team._id,
        projectId: project._id,
        folderId,
        presignedPutUrl: presigned.url,
        s3Key: presigned.s3Key,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }),
});

http.route({
  path: "/migration/v2/complete",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expected = process.env.MIGRATION_TOKEN;
    if (!expected) return new Response("MIGRATION_TOKEN not set", { status: 500 });
    if (request.headers.get("x-migration-token") !== expected) return unauthorized();

    const body = (await request.json()) as {
      assetId: string;
      assetKind: AssetKind;
      comments?: Array<{
        userName: string;
        text: string;
        timestampSeconds?: number;
      }>;
    };

    try {
      const result = await ctx.runAction(
        internal.migrationActions.completeMigrationAssetUpload,
        {
          assetId: body.assetId as Id<"assets">,
          assetKind: body.assetKind,
        },
      );

      if (body.comments && body.comments.length > 0) {
        for (const c of body.comments) {
          await ctx.runMutation(internal.migration.addMigrationAssetComment, {
            assetId: body.assetId as Id<"assets">,
            text: c.text,
            userName: c.userName,
            timestampSeconds: c.timestampSeconds ?? 0,
          });
        }
      }

      return new Response(
        JSON.stringify({
          ok: true,
          ...result,
          commentCount: body.comments?.length ?? 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[migration/v2/complete] assetId=${body.assetId} failed: ${msg}`,
      );
      return new Response(
        JSON.stringify({ ok: false, error: msg }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  }),
});

export default http;
