import { useQuery, type ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import {
  makeRouteQuerySpec,
  prewarmSpecs,
} from "@/lib/convexRouteData";

export function getVideoEssentialSpecs(params: {
  teamSlug: string;
  projectId: Id<"projects">;
  assetId: Id<"assets">;
}) {
  return [
    makeRouteQuerySpec(api.workspace.resolveContext, {
      teamSlug: params.teamSlug,
      projectId: params.projectId,
      assetId: params.assetId,
    }),
    makeRouteQuerySpec(api.assets.get, {
      assetId: params.assetId,
    }),
    makeRouteQuerySpec(api.comments.list, {
      assetId: params.assetId,
    }),
    makeRouteQuerySpec(api.comments.getThreaded, {
      assetId: params.assetId,
    }),
  ];
}

export function useVideoData(params: {
  teamSlug: string;
  projectId: Id<"projects">;
  assetId: Id<"assets">;
}) {
  const context = useQuery(api.workspace.resolveContext, {
    teamSlug: params.teamSlug,
    projectId: params.projectId,
    assetId: params.assetId,
  });
  const resolvedTeamSlug = context?.team.slug ?? params.teamSlug;
  const resolvedProjectId = context?.project?._id;
  const resolvedVideoId = context?.asset?._id;

  const video = useQuery(
    api.assets.get,
    resolvedVideoId ? { assetId: resolvedVideoId } : "skip",
  );
  const comments = useQuery(
    api.comments.list,
    resolvedVideoId ? { assetId: resolvedVideoId } : "skip",
  );
  const commentsThreaded = useQuery(
    api.comments.getThreaded,
    resolvedVideoId ? { assetId: resolvedVideoId } : "skip",
  );

  return {
    context,
    resolvedTeamSlug,
    resolvedProjectId,
    resolvedVideoId,
    video,
    comments,
    commentsThreaded,
  };
}

export async function prewarmVideo(
  convex: ConvexReactClient,
  params: {
    teamSlug: string;
    projectId: Id<"projects">;
    assetId: Id<"assets">;
  },
) {
  prewarmSpecs(convex, getVideoEssentialSpecs(params));
}
