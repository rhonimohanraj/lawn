import { useQuery, type ConvexReactClient } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  makeRouteQuerySpec,
  prewarmSpecs,
} from "@/lib/convexRouteData";

export function getShareEssentialSpecs(params: { token: string }) {
  return [
    makeRouteQuerySpec(api.shareLinks.getByToken, {
      token: params.token,
    }),
  ];
}

/**
 * Combined data hook for the share page.
 *
 * Three modes driven by scope:
 *   - asset    → loads videoData + comments for the link's single asset
 *   - folder   → loads grantContext (chrome) + browser query for the
 *                current parentFolderId; videoData/comments load only
 *                when the user has selected an asset to view
 *   - project  → same as folder but starting at project root
 */
export function useShareData(params: {
  token: string;
  grantToken?: string | null;
  /** When viewing an asset under a folder/project share, the chosen assetId.
   *  Ignored for asset-scoped shares. */
  selectedAssetId?: Id<"assets"> | null;
  /** Folder being browsed in folder/project share. Undefined = the share's
   *  starting folder (folderId for folder scope, project root for project). */
  parentFolderId?: Id<"folders"> | null;
}) {
  const shareInfo = useQuery(api.shareLinks.getByToken, {
    token: params.token,
  });

  // Chrome data (project/folder name, breadcrumb root, scope kind).
  const grantContext = useQuery(
    api.shareLinks.shareGrantContext,
    params.grantToken ? { grantToken: params.grantToken } : "skip",
  );

  // Browser data — folders + assets at the current level. Skipped for
  // asset-scoped shares.
  const browse = useQuery(
    api.shareLinks.browseUnderShareGrant,
    params.grantToken && shareInfo?.scope && shareInfo.scope !== "asset"
      ? {
          grantToken: params.grantToken,
          parentFolderId: params.parentFolderId ?? undefined,
        }
      : "skip",
  );

  // Viewing a specific asset:
  //   - asset scope: implicit, link's assetId
  //   - folder/project scope: only when selectedAssetId is set
  const wantsAssetView =
    Boolean(params.grantToken) &&
    (shareInfo?.scope === "asset" || Boolean(params.selectedAssetId));

  const videoData = useQuery(
    api.assets.getByShareGrant,
    wantsAssetView
      ? {
          grantToken: params.grantToken!,
          assetId: params.selectedAssetId ?? undefined,
        }
      : "skip",
  );

  const comments = useQuery(
    api.comments.getThreadedForShareGrant,
    wantsAssetView
      ? {
          grantToken: params.grantToken!,
          assetId: params.selectedAssetId ?? undefined,
        }
      : "skip",
  );

  return { shareInfo, grantContext, browse, videoData, comments };
}

export async function prewarmShare(
  convex: ConvexReactClient,
  params: { token: string },
) {
  prewarmSpecs(convex, getShareEssentialSpecs(params));
}
