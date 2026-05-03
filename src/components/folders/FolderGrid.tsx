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
  className?: string;
}

/**
 * Flat list of subfolders under the current folder (or project root).
 * Renders nothing when there are no children — caller can keep its
 * asset grid below it without extra spacing.
 */
export function FolderGrid({
  projectId,
  parentFolderId,
  onOpen,
  className,
}: FolderGridProps) {
  const folders = useQuery(api.folders.list, {
    projectId,
    parentFolderId,
  });

  if (folders === undefined || folders.length === 0) return null;

  return (
    <div className={cn("grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3", className)}>
      {folders.map((folder) => (
        <button
          key={folder._id}
          onClick={() => onOpen(folder._id)}
          className="flex items-center gap-3 p-4 border-2 border-[#1a1a1a] bg-[#f0f0e8] hover:bg-[#1a1a1a] hover:text-[#f0f0e8] transition-colors text-left group"
        >
          <Folder className="h-6 w-6 shrink-0" />
          <span className="font-bold truncate">{folder.name}</span>
        </button>
      ))}
    </div>
  );
}
