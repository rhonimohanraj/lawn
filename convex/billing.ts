import { StripeSubscriptions } from "@convex-dev/stripe";
import { v } from "convex/values";
import Stripe from "stripe";
import { api, components, internal } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import { getIdentity, requireTeamAccess } from "./auth";
import {
  getStripePriceIdForPlan,
  getTeamStorageUsedBytes,
  getTeamSubscriptionState,
  hasActiveTeamSubscriptionStatus,
  isSelfHosted,
  normalizeStoredTeamPlan,
  resolvePlanFromStripePriceId,
  TEAM_PLAN_MONTHLY_PRICE_USD,
  TEAM_PLAN_STORAGE_LIMIT_BYTES,
  type TeamPlan,
} from "./billingHelpers";

const stripeClient = new StripeSubscriptions(components.stripe, {});
const stripe = new Stripe(stripeClient.apiKey);
const TEAM_TRIAL_DAYS = 7;
const PLAN_RANK = {
  basic: 0,
  pro: 1,
} as const satisfies Record<TeamPlan, number>;

const teamPlanValidator = v.union(v.literal("basic"), v.literal("pro"));
const teamRoleValidator = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("viewer"),
);

export const createSubscriptionCheckout = action({
  args: {
    teamId: v.id("teams"),
    plan: teamPlanValidator,
    successUrl: v.string(),
    cancelUrl: v.string(),
  },
  returns: v.object({
    sessionId: v.string(),
    url: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args): Promise<{ sessionId: string; url: string | null }> => {
    const identity = await getIdentity(ctx);
    const team = await ctx.runQuery(api.teams.get, { teamId: args.teamId });

    if (!team) {
      throw new Error("Team not found");
    }

    if (team.role !== "owner") {
      throw new Error("Only team owners can manage billing.");
    }

    const existingSubscription = await ctx.runQuery(
      components.stripe.public.getSubscriptionByOrgId,
      { orgId: args.teamId },
    );

    if (existingSubscription && hasActiveTeamSubscriptionStatus(existingSubscription.status)) {
      throw new Error(
        "This team already has an active subscription. Use the billing portal to manage it.",
      );
    }

    let stripeCustomerId: string | undefined =
      team.stripeCustomerId ?? existingSubscription?.stripeCustomerId;

    if (!stripeCustomerId) {
      const userEmail =
        typeof identity.email === "string" && identity.email.length > 0
          ? identity.email
          : undefined;
      const customer = await stripeClient.createCustomer(ctx, {
        email: userEmail,
        name: team.name,
        metadata: {
          orgId: team._id,
          userId: identity.subject,
          teamSlug: team.slug,
        },
        idempotencyKey: team._id,
      });
      stripeCustomerId = customer.customerId;

      await ctx.runMutation(internal.teams.linkStripeCustomer, {
        teamId: team._id,
        stripeCustomerId,
      });
    }

    const stripePriceId = getStripePriceIdForPlan(args.plan);

    const shouldStartTrial =
      !existingSubscription && !team.stripeSubscriptionId;

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [{ price: stripePriceId, quantity: 1 }],
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      metadata: {
        orgId: team._id,
        plan: args.plan,
      },
      subscription_data: {
        metadata: {
          orgId: team._id,
          userId: identity.subject,
          plan: args.plan,
          teamSlug: team.slug,
        },
        ...(shouldStartTrial ? { trial_period_days: TEAM_TRIAL_DAYS } : {}),
      },
    };

    if (stripeCustomerId) {
      sessionParams.customer = stripeCustomerId;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return {
      sessionId: session.id,
      url: session.url,
    };
  },
});

export const createCustomerPortalSession = action({
  args: {
    teamId: v.id("teams"),
    returnUrl: v.string(),
  },
  returns: v.object({
    url: v.string(),
  }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const team = await ctx.runQuery(api.teams.get, { teamId: args.teamId });

    if (!team) {
      throw new Error("Team not found");
    }

    if (team.role !== "owner") {
      throw new Error("Only team owners can manage billing.");
    }

    const existingSubscription = await ctx.runQuery(
      components.stripe.public.getSubscriptionByOrgId,
      { orgId: args.teamId },
    );

    const stripeCustomerId =
      team.stripeCustomerId ?? existingSubscription?.stripeCustomerId;

    if (!stripeCustomerId) {
      throw new Error("No Stripe customer found for this team yet.");
    }

    return await stripeClient.createCustomerPortalSession(ctx, {
      customerId: stripeCustomerId,
      returnUrl: args.returnUrl,
    });
  },
});

export const updateTeamSubscriptionPlan = action({
  args: {
    teamId: v.id("teams"),
    plan: teamPlanValidator,
  },
  returns: v.object({
    plan: teamPlanValidator,
    subscriptionStatus: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ plan: TeamPlan; subscriptionStatus: string }> => {
    const team = await ctx.runQuery(api.teams.get, { teamId: args.teamId });

    if (!team) {
      throw new Error("Team not found");
    }

    if (team.role !== "owner") {
      throw new Error("Only team owners can manage billing.");
    }

    const existingSubscription = await ctx.runQuery(
      components.stripe.public.getSubscriptionByOrgId,
      { orgId: args.teamId },
    );

    const stripeSubscriptionId =
      existingSubscription?.stripeSubscriptionId ?? team.stripeSubscriptionId;

    if (!stripeSubscriptionId) {
      throw new Error("No active subscription found for this team.");
    }

    const stripePriceId = getStripePriceIdForPlan(args.plan);
    const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);

    if (!hasActiveTeamSubscriptionStatus(subscription.status)) {
      throw new Error("Only active subscriptions can be upgraded.");
    }

    const currentItem = subscription.items.data[0];

    if (!currentItem) {
      throw new Error("Subscription has no items.");
    }

    const currentPlan =
      resolvePlanFromStripePriceId(currentItem.price.id) ??
      resolvePlanFromStripePriceId(existingSubscription?.priceId) ??
      normalizeStoredTeamPlan(team.plan);

    if (args.plan === currentPlan) {
      throw new Error(`This team is already on ${args.plan}.`);
    }

    if (PLAN_RANK[args.plan] <= PLAN_RANK[currentPlan]) {
      throw new Error("Use the billing portal to downgrade this subscription.");
    }

    const updatedSubscription = await stripe.subscriptions.update(
      stripeSubscriptionId,
      {
        items: [
          {
            id: currentItem.id,
            price: stripePriceId,
            quantity: currentItem.quantity ?? 1,
          },
        ],
        metadata: {
          ...subscription.metadata,
          orgId: team._id,
          plan: args.plan,
          teamSlug: team.slug,
        },
        proration_behavior: "create_prorations",
      },
    );

    const updatedItem = updatedSubscription.items.data[0];
    const updatedPriceId = updatedItem?.price?.id ?? stripePriceId;

    await ctx.runMutation(components.stripe.private.handleSubscriptionUpdated, {
      stripeSubscriptionId: updatedSubscription.id,
      status: updatedSubscription.status,
      currentPeriodEnd: updatedItem?.current_period_end ?? 0,
      cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end ?? false,
      cancelAt: updatedSubscription.cancel_at ?? undefined,
      quantity: updatedItem?.quantity ?? 1,
      priceId: updatedPriceId,
      metadata: updatedSubscription.metadata ?? {},
    });

    await ctx.runMutation(internal.billing.syncTeamSubscriptionFromWebhook, {
      orgId: team._id,
      stripeCustomerId:
        typeof updatedSubscription.customer === "string"
          ? updatedSubscription.customer
          : undefined,
      stripeSubscriptionId: updatedSubscription.id,
      stripePriceId: updatedPriceId,
      status: updatedSubscription.status,
    });

    return {
      plan: args.plan,
      subscriptionStatus: updatedSubscription.status,
    };
  },
});

export const getTeamBilling = query({
  args: {
    teamId: v.id("teams"),
  },
  returns: v.object({
    plan: teamPlanValidator,
    monthlyPriceUsd: v.number(),
    storageLimitBytes: v.number(),
    storageUsedBytes: v.number(),
    hasActiveSubscription: v.boolean(),
    subscriptionStatus: v.union(v.string(), v.null()),
    stripeCustomerId: v.union(v.string(), v.null()),
    stripeSubscriptionId: v.union(v.string(), v.null()),
    stripePriceId: v.union(v.string(), v.null()),
    currentPeriodEnd: v.union(v.number(), v.null()),
    role: teamRoleValidator,
    canManageBilling: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { membership } = await requireTeamAccess(ctx, args.teamId);
    const subscriptionState = await getTeamSubscriptionState(ctx, args.teamId);
    const storageUsedBytes = await getTeamStorageUsedBytes(ctx, args.teamId);
    const subscription = subscriptionState.subscription;

    if (isSelfHosted()) {
      return {
        plan: "pro" as const,
        monthlyPriceUsd: 0,
        // 10 PiB - matches SELF_HOSTED_STORAGE_LIMIT_BYTES
        storageLimitBytes: 10 * 1024 * 1024 ** 3 * 1024,
        storageUsedBytes,
        hasActiveSubscription: true,
        subscriptionStatus: "self_hosted",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripePriceId: null,
        currentPeriodEnd: null,
        role: membership.role,
        canManageBilling: false,
      };
    }

    return {
      plan: subscriptionState.plan,
      monthlyPriceUsd: TEAM_PLAN_MONTHLY_PRICE_USD[subscriptionState.plan],
      storageLimitBytes: TEAM_PLAN_STORAGE_LIMIT_BYTES[subscriptionState.plan],
      storageUsedBytes,
      hasActiveSubscription: subscriptionState.hasActiveSubscription,
      subscriptionStatus:
        subscription?.status ?? subscriptionState.team.billingStatus ?? null,
      stripeCustomerId:
        subscriptionState.team.stripeCustomerId ??
        subscription?.stripeCustomerId ??
        null,
      stripeSubscriptionId:
        subscription?.stripeSubscriptionId ??
        subscriptionState.team.stripeSubscriptionId ??
        null,
      stripePriceId: subscription?.priceId ?? subscriptionState.team.stripePriceId ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      role: membership.role,
      canManageBilling: membership.role === "owner",
    };
  },
});

export const syncTeamSubscriptionFromWebhook = internalMutation({
  args: {
    orgId: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.string(),
    stripePriceId: v.optional(v.string()),
    status: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const normalizedOrgId = args.orgId
      ? ctx.db.normalizeId("teams", args.orgId)
      : null;

    let team = normalizedOrgId ? await ctx.db.get(normalizedOrgId) : null;

    if (!team) {
      team = await ctx.db
        .query("teams")
        .withIndex("by_stripe_subscription_id", (q) =>
          q.eq("stripeSubscriptionId", args.stripeSubscriptionId),
        )
        .unique();
    }

    if (!team && args.stripeCustomerId) {
      team = await ctx.db
        .query("teams")
        .withIndex("by_stripe_customer_id", (q) =>
          q.eq("stripeCustomerId", args.stripeCustomerId),
        )
        .unique();
    }

    if (!team) {
      return null;
    }

    const mappedPlan = resolvePlanFromStripePriceId(args.stripePriceId);
    const normalizedStoredPlan = normalizeStoredTeamPlan(team.plan);

    await ctx.db.patch(team._id, {
      plan: mappedPlan ?? normalizedStoredPlan,
      stripeCustomerId: args.stripeCustomerId ?? team.stripeCustomerId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripePriceId: args.stripePriceId ?? team.stripePriceId,
      billingStatus: args.status,
    });

    return null;
  },
});
