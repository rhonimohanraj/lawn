"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Folder,
  FileText,
  FileImage,
  FileAudio,
  FileVideo,
  File as FileIcon,
  Play,
} from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { cn, formatBytes, formatDuration, formatRelativeTime } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export type AssetTableAssetKind = "video" | "image" | "audio" | "doc" | "other";

export interface AssetTableAsset {
  _id: Id<"assets">;
  _creationTime: number;
  title: string;
  assetKind: AssetTableAssetKind;
  status: "uploading" | "processing" | "ready" | "failed";
  workflowStatus: "review" | "rework" | "done";
  fileSize?: number;
  duration?: number;
  thumbnailUrl?: string;
  uploaderName: string;
  lastModifiedAt?: number;
  commentCount?: number;
  muxPlaybackId?: string;
}

export interface AssetTableFolder {
  _id: Id<"folders">;
  _creationTime: number;
  name: string;
  sizeBytes?: number;
  lastModifiedAt?: number;
  createdByName?: string;
}

interface AssetTableProps {
  folders: AssetTableFolder[];
  assets: AssetTableAsset[];
  onOpenAsset: (assetId: Id<"assets">) => void;
  onOpenFolder: (folderId: Id<"folders">) => void;
  /** Optional rendered inline at the end of each asset row (download/share/delete menu). */
  renderAssetActions?: (asset: AssetTableAsset) => ReactNode;
  /** Optional rendered inline at the end of each folder row. */
  renderFolderActions?: (folder: AssetTableFolder) => ReactNode;
  /** localStorage key for persisting sort. Pass per-folder for per-folder memory. */
  sortStorageKey?: string;
  className?: string;
}

type SortKey = "name" | "status" | "size" | "uploadedBy" | "uploaded" | "modified";
type SortDir = "asc" | "desc";

interface SortState {
  key: SortKey;
  dir: SortDir;
}

const DEFAULT_SORT: SortState = { key: "modified", dir: "desc" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readStoredSort(key: string | undefined): SortState | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SortState;
    if (parsed.key && parsed.dir) return parsed;
  } catch {
    /* fall through */
  }
  return null;
}

function writeStoredSort(key: string | undefined, sort: SortState) {
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(sort));
  } catch {
    /* ignore quota / disabled storage */
  }
}

function assetKindIcon(kind: AssetTableAssetKind) {
  switch (kind) {
    case "video":
      return FileVideo;
    case "image":
      return FileImage;
    case "audio":
      return FileAudio;
    case "doc":
      return FileText;
    default:
      return FileIcon;
  }
}

const STATUS_LABELS: Record<AssetTableAsset["workflowStatus"], string> = {
  review: "In Review",
  rework: "Changes",
  done: "Approved",
};

const STATUS_TONES: Record<AssetTableAsset["workflowStatus"], string> = {
  review: "text-[#ca8a04] bg-[#ca8a04]/10",
  rework: "text-[#dc2626] bg-[#dc2626]/10",
  done: "text-[#2d5a2d] bg-[#7cb87c]/15",
};

// ─── Row sort accessors ──────────────────────────────────────────────────────
//
// Folders and assets share columns but have different shapes — these helpers
// produce a uniform sort key per row regardless of type. Folders compare with
// "" status so the "FOLDER" pseudo-status sorts predictably.

type Row =
  | { kind: "folder"; folder: AssetTableFolder }
  | { kind: "asset"; asset: AssetTableAsset };

function rowName(row: Row): string {
  return row.kind === "folder" ? row.folder.name : row.asset.title;
}
function rowStatus(row: Row): string {
  return row.kind === "folder" ? "" : STATUS_LABELS[row.asset.workflowStatus];
}
function rowSize(row: Row): number {
  return (row.kind === "folder" ? row.folder.sizeBytes : row.asset.fileSize) ?? 0;
}
function rowUploadedBy(row: Row): string {
  return row.kind === "folder"
    ? row.folder.createdByName ?? "Unknown"
    : row.asset.uploaderName;
}
function rowUploadedAt(row: Row): number {
  return row.kind === "folder" ? row.folder._creationTime : row.asset._creationTime;
}
function rowModifiedAt(row: Row): number {
  return row.kind === "folder"
    ? row.folder.lastModifiedAt ?? row.folder._creationTime
    : row.asset.lastModifiedAt ?? row.asset._creationTime;
}

function compareRows(a: Row, b: Row, sort: SortState): number {
  const dir = sort.dir === "asc" ? 1 : -1;
  switch (sort.key) {
    case "name":
      return rowName(a).localeCompare(rowName(b)) * dir;
    case "status":
      return rowStatus(a).localeCompare(rowStatus(b)) * dir;
    case "size":
      return (rowSize(a) - rowSize(b)) * dir;
    case "uploadedBy":
      return rowUploadedBy(a).localeCompare(rowUploadedBy(b)) * dir;
    case "uploaded":
      return (rowUploadedAt(a) - rowUploadedAt(b)) * dir;
    case "modified":
      return (rowModifiedAt(a) - rowModifiedAt(b)) * dir;
  }
}

// ─── Header cell ─────────────────────────────────────────────────────────────

interface HeaderCellProps {
  label: string;
  sortKey: SortKey;
  active: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
  align?: "left" | "right";
}

function HeaderCell({ label, sortKey, active, onSort, className, align = "left" }: HeaderCellProps) {
  const isActive = active.key === sortKey;
  const Icon = !isActive ? ChevronsUpDown : active.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-[#888] select-none",
        align === "right" && "text-right",
        align === "left" && "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1.5 transition-colors",
          align === "right" ? "ml-auto" : "",
          isActive ? "text-[#1a1a1a]" : "hover:text-[#1a1a1a]",
        )}
      >
        <span>{label}</span>
        <Icon className={cn("h-3 w-3", isActive ? "text-[#2d5a2d]" : "opacity-50")} />
      </button>
    </th>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Power-user table view: folders + assets in one sortable list.
 *
 * Sort state persists per-folder in localStorage when sortStorageKey is
 * provided. Below 768px the secondary columns (status, uploaded by, uploaded)
 * collapse — name + size + modified always visible.
 */
export function AssetTable({
  folders,
  assets,
  onOpenAsset,
  onOpenFolder,
  renderAssetActions,
  renderFolderActions,
  sortStorageKey,
  className,
}: AssetTableProps) {
  const [sort, setSort] = useState<SortState>(() => readStoredSort(sortStorageKey) ?? DEFAULT_SORT);

  const handleSort = (key: SortKey) => {
    setSort((prev) => {
      const next: SortState =
        prev.key === key
          ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { key, dir: key === "name" || key === "uploadedBy" || key === "status" ? "asc" : "desc" };
      writeStoredSort(sortStorageKey, next);
      return next;
    });
  };

  const rows = useMemo<Row[]>(() => {
    const folderRows: Row[] = folders.map((folder) => ({ kind: "folder", folder }));
    const assetRows: Row[] = assets.map((asset) => ({ kind: "asset", asset }));
    const all = [...folderRows, ...assetRows];
    all.sort((a, b) => compareRows(a, b, sort));
    return all;
  }, [folders, assets, sort]);

  if (rows.length === 0) return null;

  return (
    <div
      className={cn(
        "border-2 border-[#1a1a1a] rounded-md overflow-hidden bg-[#f0f0e8]",
        className,
      )}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b-2 border-[#1a1a1a] bg-[#e8e8e0]">
            <tr>
              <HeaderCell label="Name" sortKey="name" active={sort} onSort={handleSort} />
              <HeaderCell
                label="Status"
                sortKey="status"
                active={sort}
                onSort={handleSort}
                className="hidden lg:table-cell"
              />
              <HeaderCell label="Size" sortKey="size" active={sort} onSort={handleSort} />
              <HeaderCell
                label="Uploaded by"
                sortKey="uploadedBy"
                active={sort}
                onSort={handleSort}
                className="hidden md:table-cell"
              />
              <HeaderCell
                label="Uploaded"
                sortKey="uploaded"
                active={sort}
                onSort={handleSort}
                className="hidden md:table-cell"
              />
              <HeaderCell label="Modified" sortKey="modified" active={sort} onSort={handleSort} />
              <th aria-label="Actions" className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              row.kind === "folder" ? (
                <FolderRow
                  key={row.folder._id}
                  folder={row.folder}
                  onOpen={() => onOpenFolder(row.folder._id)}
                  renderActions={renderFolderActions}
                />
              ) : (
                <AssetRow
                  key={row.asset._id}
                  asset={row.asset}
                  onOpen={() => onOpenAsset(row.asset._id)}
                  renderActions={renderAssetActions}
                />
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Row components ──────────────────────────────────────────────────────────

function FolderRow({
  folder,
  onOpen,
  renderActions,
}: {
  folder: AssetTableFolder;
  onOpen: () => void;
  renderActions?: (folder: AssetTableFolder) => ReactNode;
}) {
  return (
    <tr
      onClick={onOpen}
      className="group border-t border-[#1a1a1a]/10 hover:bg-[#e8e8e0] cursor-pointer transition-colors"
    >
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="inline-flex items-center justify-center h-7 w-7 rounded bg-[#e8e8e0] text-[#2d5a2d] shrink-0">
            <Folder className="h-3.5 w-3.5" />
          </span>
          <span className="font-medium text-[#1a1a1a] truncate">{folder.name}</span>
        </div>
      </td>
      <td className="px-3 py-2.5 hidden lg:table-cell">
        <span className="inline-flex items-center text-[10px] font-semibold uppercase tracking-wider text-[#888] px-2 py-0.5 rounded bg-[#e8e8e0]">
          Folder
        </span>
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-[#888] whitespace-nowrap">
        {folder.sizeBytes !== undefined ? formatBytes(folder.sizeBytes) : "—"}
      </td>
      <td className="px-3 py-2.5 text-xs text-[#888] hidden md:table-cell whitespace-nowrap">
        {folder.createdByName ?? "—"}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-[#888] hidden md:table-cell whitespace-nowrap">
        {formatRelativeTime(folder._creationTime)}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-[#888] whitespace-nowrap">
        {folder.lastModifiedAt
          ? formatRelativeTime(folder.lastModifiedAt)
          : formatRelativeTime(folder._creationTime)}
      </td>
      <td className="px-2 py-2.5 text-right">
        <div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          {renderActions?.(folder)}
        </div>
      </td>
    </tr>
  );
}

function AssetRow({
  asset,
  onOpen,
  renderActions,
}: {
  asset: AssetTableAsset;
  onOpen: () => void;
  renderActions?: (asset: AssetTableAsset) => ReactNode;
}) {
  const KindIcon = assetKindIcon(asset.assetKind);
  const isProcessing = asset.status === "uploading" || asset.status === "processing";
  const isFailed = asset.status === "failed";

  return (
    <tr
      onClick={onOpen}
      className="group border-t border-[#1a1a1a]/10 hover:bg-[#e8e8e0] cursor-pointer transition-colors"
    >
      <td className="px-3 py-2.5 min-w-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative h-7 w-12 rounded bg-[#e8e8e0] overflow-hidden border border-[#1a1a1a]/15 shrink-0">
            {asset.thumbnailUrl?.startsWith("http") ? (
              <img src={asset.thumbnailUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 grid place-items-center text-[#888]">
                {asset.assetKind === "video" ? (
                  <Play className="h-3 w-3" />
                ) : (
                  <KindIcon className="h-3 w-3" />
                )}
              </div>
            )}
            {asset.assetKind === "video" && asset.duration ? (
              <div className="absolute bottom-0 right-0 bg-black/70 text-white font-mono text-[9px] px-1 leading-tight">
                {formatDuration(asset.duration)}
              </div>
            ) : null}
          </div>
          <div className="min-w-0">
            <div className="font-medium text-[#1a1a1a] truncate">{asset.title}</div>
            {(isProcessing || isFailed) && (
              <div className="text-[10px] uppercase tracking-wider text-[#888] mt-0.5">
                {asset.status}
              </div>
            )}
          </div>
        </div>
      </td>
      <td className="px-3 py-2.5 hidden lg:table-cell">
        <span
          className={cn(
            "inline-flex items-center text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded",
            STATUS_TONES[asset.workflowStatus],
          )}
        >
          {STATUS_LABELS[asset.workflowStatus]}
        </span>
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-[#888] whitespace-nowrap">
        {asset.fileSize !== undefined ? formatBytes(asset.fileSize) : "—"}
      </td>
      <td className="px-3 py-2.5 text-xs text-[#888] hidden md:table-cell whitespace-nowrap">
        {asset.uploaderName}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-[#888] hidden md:table-cell whitespace-nowrap">
        {formatRelativeTime(asset._creationTime)}
      </td>
      <td className="px-3 py-2.5 font-mono text-xs text-[#888] whitespace-nowrap">
        {formatRelativeTime(asset.lastModifiedAt ?? asset._creationTime)}
      </td>
      <td className="px-2 py-2.5 text-right">
        <div
          className="opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
          {renderActions?.(asset)}
        </div>
      </td>
    </tr>
  );
}
