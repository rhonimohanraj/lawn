"use client";

import { Folder, MoreVertical, Trash2 } from "lucide-react";
import { Id } from "@convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface ProjectRow {
  _id: Id<"projects">;
  name: string;
  assetCount: number;
}

interface ProjectListViewProps {
  projects: ProjectRow[];
  onOpen: (projectId: Id<"projects">) => void;
  onDelete?: (projectId: Id<"projects">) => void;
  canDelete?: boolean;
  className?: string;
  /** Optional intent-prewarm event handlers per project (hover/focus). */
  prewarmHandlers?: (
    projectId: Id<"projects">,
  ) => Record<string, (e: React.SyntheticEvent) => void> | undefined;
}

/**
 * Tabular project listing — single-column, sortable by name in render
 * order. Used as the alternate "list" view to the card-grid layout.
 */
export function ProjectListView({
  projects,
  onOpen,
  onDelete,
  canDelete = false,
  className,
  prewarmHandlers,
}: ProjectListViewProps) {
  return (
    <div className={cn("border-2 border-[#1a1a1a] divide-y divide-[#1a1a1a]/10 bg-[#f0f0e8]", className)}>
      {projects.length === 0 ? (
        <div className="px-5 py-6 text-center text-[#888] text-sm font-mono">
          No projects yet.
        </div>
      ) : (
        projects.map((project) => {
          const handlers = prewarmHandlers?.(project._id);
          return (
            <div
              key={project._id}
              className="group flex items-center gap-3 px-5 py-3 hover:bg-[#1a1a1a]/5 transition-colors cursor-pointer"
              onClick={() => onOpen(project._id)}
              {...handlers}
            >
              <Folder className="h-5 w-5 shrink-0 text-[#1a1a1a]" strokeWidth={2} />
              <div className="flex-1 min-w-0">
                <div className="font-bold truncate text-[#1a1a1a]">{project.name}</div>
                <div className="text-xs text-[#888] font-mono mt-0.5">
                  {project.assetCount} asset{project.assetCount !== 1 ? "s" : ""}
                </div>
              </div>
              {canDelete && onDelete && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-[#dc2626] focus:text-[#dc2626]"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(project._id);
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
