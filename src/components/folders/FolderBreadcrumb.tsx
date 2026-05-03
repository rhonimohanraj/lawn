"use client";

import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface FolderBreadcrumbProps {
  projectId: Id<"projects">;
  projectName: string;
  folderId?: Id<"folders">;
  onNavigate: (folderId?: Id<"folders">) => void;
  className?: string;
}

/**
 * Project root → … → current folder. Clicking any segment navigates the
 * grid to that folder. Project name is always the leftmost segment.
 */
export function FolderBreadcrumb({
  projectId,
  projectName,
  folderId,
  onNavigate,
  className,
}: FolderBreadcrumbProps) {
  const breadcrumb = useQuery(
    api.folders.breadcrumb,
    folderId ? { folderId } : "skip",
  );

  return (
    <nav
      className={cn(
        "flex items-center gap-1 text-sm font-mono overflow-x-auto",
        className,
      )}
      aria-label="Folder breadcrumb"
    >
      <button
        onClick={() => onNavigate(undefined)}
        className={cn(
          "px-2 py-1 hover:underline shrink-0",
          !folderId ? "font-black text-[#1a1a1a]" : "text-[#888]",
        )}
      >
        {projectName}
      </button>

      {folderId && breadcrumb === undefined && (
        <span className="text-[#888]">…</span>
      )}

      {breadcrumb?.chain.map((folder, i) => {
        const isLast = i === breadcrumb.chain.length - 1;
        return (
          <div key={folder._id} className="flex items-center gap-1 shrink-0">
            <ChevronRight className="h-3 w-3 text-[#888]" />
            <button
              onClick={() => onNavigate(folder._id)}
              className={cn(
                "px-2 py-1 hover:underline",
                isLast ? "font-black text-[#1a1a1a]" : "text-[#888]",
              )}
            >
              {folder.name}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
