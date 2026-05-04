"use client";

import { useState } from "react";
import { ChevronRight, Folder, Play, FileImage, FileAudio, FileText, File as FileIcon } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { cn, formatBytes, formatDuration, formatRelativeTime } from "@/lib/utils";
import { ViewModeToggle, type ViewMode } from "@/components/ViewModeToggle";
import { AssetTable, type AssetTableAsset, type AssetTableFolder } from "@/components/AssetTable";

// ─── Types ───────────────────────────────────────────────────────────────────

type ShareFolderRow = {
  _id: Id<"folders">;
  _creationTime: number;
  name: string;
  sizeBytes?: number;
  lastModifiedAt?: number;
};

type ShareAssetRow = {
  _id: Id<"assets">;
  _creationTime: number;
  title: string;
  assetKind: "video" | "image" | "audio" | "doc" | "other";
  status: "uploading" | "processing" | "ready" | "failed";
  workflowStatus: "review" | "rework" | "done";
  fileSize?: number;
  duration?: number;
  thumbnailUrl?: string;
  uploaderName: string;
  lastModifiedAt?: number;
};

interface BrowseData {
  parentFolderId: Id<"folders"> | null;
  crumb: { _id: Id<"folders">; name: string }[];
  folders: ShareFolderRow[];
  assets: ShareAssetRow[];
}

interface ShareBrowserProps {
  /** Header label ABOVE the breadcrumb (project name for project shares,
   *  shared-folder name for folder shares). */
  title: string;
  /** Loaded by useShareData via api.shareLinks.browseUnderShareGrant. */
  data: BrowseData | null | undefined;
  onOpenFolder: (folderId: Id<"folders">) => void;
  onOpenAsset: (assetId: Id<"assets">) => void;
  /** When the user is deep in a folder share, "go up" should take them to
   *  the share's home (parentFolderId === undefined). For project shares,
   *  home === undefined too. */
  onNavigateHome: () => void;
  className?: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Client-facing browser for folder/project share links. Shows folders +
 * assets at the current level, with a grid + table view toggle. No team-side
 * affordances (no download/share/delete actions) — those are owner-only.
 */
export function ShareBrowser({
  title,
  data,
  onOpenFolder,
  onOpenAsset,
  onNavigateHome,
  className,
}: ShareBrowserProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  if (data === undefined) {
    return (
      <div className="text-sm text-[#888] py-12 text-center">Loading…</div>
    );
  }
  if (data === null) {
    return (
      <div className="text-sm text-[#888] py-12 text-center">
        This share is no longer accessible.
      </div>
    );
  }

  const isAtHome = data.parentFolderId === null
    || (data.crumb.length === 1 && title === data.crumb[0].name);

  return (
    <div className={cn("space-y-4", className)}>
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <Breadcrumb
            title={title}
            crumb={data.crumb}
            onOpenFolder={onOpenFolder}
            onNavigateHome={onNavigateHome}
            isAtHome={isAtHome}
          />
          <div className="mt-1 text-xs font-mono text-[#888]">
            {data.folders.length} folder{data.folders.length === 1 ? "" : "s"}
            {" · "}
            {data.assets.length} asset{data.assets.length === 1 ? "" : "s"}
          </div>
        </div>
        {(data.folders.length > 0 || data.assets.length > 0) && (
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
        )}
      </header>

      {data.folders.length === 0 && data.assets.length === 0 ? (
        <div className="border-2 border-[#1a1a1a] rounded-md p-12 text-center text-sm text-[#888]">
          This folder is empty.
        </div>
      ) : viewMode === "table" ? (
        <AssetTable
          folders={data.folders as AssetTableFolder[]}
          assets={data.assets as AssetTableAsset[]}
          onOpenFolder={onOpenFolder}
          onOpenAsset={onOpenAsset}
        />
      ) : (
        <ShareGrid
          folders={data.folders}
          assets={data.assets}
          onOpenFolder={onOpenFolder}
          onOpenAsset={onOpenAsset}
        />
      )}
    </div>
  );
}

// ─── Breadcrumb ──────────────────────────────────────────────────────────────

function Breadcrumb({
  title,
  crumb,
  onOpenFolder,
  onNavigateHome,
  isAtHome,
}: {
  title: string;
  crumb: { _id: Id<"folders">; name: string }[];
  onOpenFolder: (folderId: Id<"folders">) => void;
  onNavigateHome: () => void;
  isAtHome: boolean;
}) {
  return (
    <nav aria-label="breadcrumb" className="flex items-center gap-1 text-base font-bold text-[#1a1a1a] flex-wrap">
      <button
        type="button"
        onClick={onNavigateHome}
        className={cn(
          "transition-colors",
          isAtHome ? "text-[#1a1a1a]" : "text-[#888] hover:text-[#1a1a1a]",
        )}
      >
        {title}
      </button>
      {!isAtHome &&
        crumb.map((c, i) => {
          const isLast = i === crumb.length - 1;
          return (
            <span key={c._id} className="flex items-center gap-1">
              <ChevronRight className="h-4 w-4 text-[#888]" />
              <button
                type="button"
                onClick={() => onOpenFolder(c._id)}
                className={cn(
                  "transition-colors truncate max-w-[200px]",
                  isLast ? "text-[#1a1a1a]" : "text-[#888] hover:text-[#1a1a1a]",
                )}
              >
                {c.name}
              </button>
            </span>
          );
        })}
    </nav>
  );
}

// ─── Grid view ───────────────────────────────────────────────────────────────

function ShareGrid({
  folders,
  assets,
  onOpenFolder,
  onOpenAsset,
}: {
  folders: ShareFolderRow[];
  assets: ShareAssetRow[];
  onOpenFolder: (folderId: Id<"folders">) => void;
  onOpenAsset: (assetId: Id<"assets">) => void;
}) {
  return (
    <div className="space-y-6">
      {folders.length > 0 && (
        <div>
          <div className="text-[11px] font-mono uppercase tracking-wider text-[#888] mb-2">
            Folders
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {folders.map((folder) => (
              <button
                key={folder._id}
                type="button"
                onClick={() => onOpenFolder(folder._id)}
                className="group flex items-center gap-3 p-4 border-2 border-[#1a1a1a] rounded-md bg-[#f0f0e8] hover:bg-[#e8e8e0] transition-colors text-left min-w-0"
              >
                <span className="inline-flex items-center justify-center h-9 w-9 rounded bg-[#e8e8e0] text-[#2d5a2d] shrink-0">
                  <Folder className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-bold truncate text-[#1a1a1a]">
                    {folder.name}
                  </span>
                  <span className="block text-[11px] font-mono text-[#888] mt-0.5">
                    {folder.sizeBytes !== undefined ? formatBytes(folder.sizeBytes) : "—"}
                    {folder.lastModifiedAt && (
                      <> · {formatRelativeTime(folder.lastModifiedAt)}</>
                    )}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {assets.length > 0 && (
        <div>
          <div className="text-[11px] font-mono uppercase tracking-wider text-[#888] mb-2">
            Assets
          </div>
          <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {assets.map((asset) => (
              <ShareAssetCard
                key={asset._id}
                asset={asset}
                onOpen={() => onOpenAsset(asset._id)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ShareAssetCard({
  asset,
  onOpen,
}: {
  asset: ShareAssetRow;
  onOpen: () => void;
}) {
  const KindIcon =
    asset.assetKind === "video"
      ? Play
      : asset.assetKind === "image"
        ? FileImage
        : asset.assetKind === "audio"
          ? FileAudio
          : asset.assetKind === "doc"
            ? FileText
            : FileIcon;
  const thumbnailSrc = asset.thumbnailUrl?.startsWith("http")
    ? asset.thumbnailUrl
    : undefined;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group cursor-pointer flex flex-col text-left"
    >
      <div className="relative aspect-video bg-[#e8e8e0] overflow-hidden border-2 border-[#1a1a1a] rounded-md">
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt={asset.title}
            className="object-cover w-full h-full"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[#888]">
            <KindIcon className="h-10 w-10" />
          </div>
        )}
        {asset.assetKind === "video" && asset.duration ? (
          <div className="absolute bottom-2 right-2 bg-black/70 text-white text-[11px] font-mono px-1.5 py-0.5 rounded">
            {formatDuration(asset.duration)}
          </div>
        ) : null}
      </div>
      <div className="mt-2.5 min-w-0">
        <div className="text-[15px] font-bold text-[#1a1a1a] truncate leading-tight">
          {asset.title}
        </div>
        <div className="mt-1 text-[11px] font-mono text-[#888]">
          {asset.fileSize !== undefined ? formatBytes(asset.fileSize) : "—"}
          {asset.lastModifiedAt && (
            <> · {formatRelativeTime(asset.lastModifiedAt)}</>
          )}
        </div>
      </div>
    </button>
  );
}
