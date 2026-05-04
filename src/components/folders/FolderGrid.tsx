"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { Folder } from "lucide-react";
import { cn } from "@/lib/utils";

interface FolderGridProps {
  projectId: Id<"projects">;
  parentFolderId?: Id<"folders">;
  onOpen: (folderId: Id<"folders">) => void;
  /** "grid" = card tiles. "list" = single-column rows (matches asset list). */
  viewMode?: "grid" | "list";
  /** Sort key — kept aligned with the parent's asset grid so folders +
   *  assets read in the same order. Falls back to alphabetical. */
  sortKey?: "name" | "size" | "modified" | "uploaded" | "comments";
  className?: string;
}

/**
 * Subfolders under the current folder (or project root). Renders nothing
 * when there are no children — caller can keep its asset grid below it
 * without extra spacing.
 */
export function FolderGrid({
  projectId,
  parentFolderId,
  onOpen,
  viewMode = "grid",
  sortKey = "name",
  className,
}: FolderGridProps) {
  const foldersRaw = useQuery(api.folders.list, {
    projectId,
    parentFolderId,
  });

  if (foldersRaw === undefined || foldersRaw.length === 0) return null;

  // Sort to match whatever order the parent's asset grid is using.
  // Folders don't carry uploader / comment-count, so those keys fall
  // back to recently-modified and alphabetical respectively.
  const folders = [...foldersRaw].sort((a, b) => {
    switch (sortKey) {
      case "size":
        return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
      case "modified":
      case "comments":
        return (
          (b.lastModifiedAt ?? b._creationTime) - (a.lastModifiedAt ?? a._creationTime)
        );
      case "uploaded":
        return b._creationTime - a._creationTime;
      case "name":
      default:
        return a.name.localeCompare(b.name, undefined, {
          sensitivity: "base",
          numeric: true,
        });
    }
  });

  if (viewMode === "list") {
    return (
      <div className={cn("border border-[#1a1a1a] rounded-md divide-y divide-[#1a1a1a]/10 bg-[#e8e8e0] overflow-hidden", className)}>
        {folders.map((folder) => (
          <button
            key={folder._id}
            onClick={() => onOpen(folder._id)}
            className="w-full flex items-center gap-3 px-5 py-3 hover:bg-[#d8d8d0] transition-colors text-left"
          >
            <Folder className="h-5 w-5 shrink-0 text-[#2d5a2d]" />
            <span className="font-medium truncate text-[#1a1a1a]">{folder.name}</span>
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3", className)}>
      {folders.map((folder) => (
        <button
          key={folder._id}
          onClick={() => onOpen(folder._id)}
          className="flex items-center gap-3 p-4 border border-[#1a1a1a] rounded-md bg-[#e8e8e0] hover:bg-[#d8d8d0] transition-colors text-left text-[#1a1a1a]"
        >
          <span className="inline-flex items-center justify-center h-9 w-9 rounded bg-[#f0f0e8] text-[#2d5a2d] shrink-0">
            <Folder className="h-4 w-4" />
          </span>
          <span className="font-medium truncate">{folder.name}</span>
        </button>
      ))}
    </div>
  );
}
