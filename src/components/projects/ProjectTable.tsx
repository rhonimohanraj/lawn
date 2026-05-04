"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronUp, ChevronDown, ChevronsUpDown, Folder } from "lucide-react";
import type { Id } from "@convex/_generated/dataModel";
import { cn, formatBytes, formatRelativeTime } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectTableRow {
  _id: Id<"projects">;
  _creationTime: number;
  name: string;
  assetCount: number;
  sizeBytes?: number;
  lastModifiedAt?: number;
}

interface ProjectTableProps {
  projects: ProjectTableRow[];
  onOpen: (projectId: Id<"projects">) => void;
  /** Per-project intent-prewarm hover/focus handlers (e.g. for prefetch). */
  prewarmHandlers?: (
    projectId: Id<"projects">,
  ) => Record<string, (e: React.SyntheticEvent) => void> | undefined;
  /** Hover-revealed actions slot (kebab menu). */
  renderActions?: (project: ProjectTableRow) => ReactNode;
  /** HTML5 drag/drop handlers per row, for drag-to-nest into another row.
   *  When provided, every row is draggable; the parent decides which row is
   *  currently a hover-target via `dragOver`. */
  rowDragHandlers?: (project: ProjectTableRow) => {
    dragOver?: boolean;
  } & Omit<React.HTMLAttributes<HTMLElement>, "draggable">;
  sortStorageKey?: string;
  className?: string;
}

type SortKey = "name" | "assetCount" | "size" | "created" | "modified";
type SortDir = "asc" | "desc";
interface SortState {
  key: SortKey;
  dir: SortDir;
}

const DEFAULT_SORT: SortState = { key: "modified", dir: "desc" };

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
    /* ignore */
  }
}

function compareRows(a: ProjectTableRow, b: ProjectTableRow, sort: SortState): number {
  const dir = sort.dir === "asc" ? 1 : -1;
  switch (sort.key) {
    case "name":
      return a.name.localeCompare(b.name) * dir;
    case "assetCount":
      return (a.assetCount - b.assetCount) * dir;
    case "size":
      return ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * dir;
    case "created":
      return (a._creationTime - b._creationTime) * dir;
    case "modified":
      return (
        (a.lastModifiedAt ?? a._creationTime) -
        (b.lastModifiedAt ?? b._creationTime)
      ) * dir;
  }
}

// ─── Header cell ─────────────────────────────────────────────────────────────

function HeaderCell({
  label,
  sortKey,
  active,
  onSort,
  className,
  align = "left",
}: {
  label: string;
  sortKey: SortKey;
  active: SortState;
  onSort: (key: SortKey) => void;
  className?: string;
  align?: "left" | "right";
}) {
  const isActive = active.key === sortKey;
  const Icon = !isActive ? ChevronsUpDown : active.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <th
      scope="col"
      className={cn(
        "px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-[#888] select-none",
        align === "right" ? "text-right" : "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1.5 transition-colors",
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
 * Team-page project table — mirrors AssetTable's visual language but with
 * project-level columns. Same sort + persistence behavior.
 */
export function ProjectTable({
  projects,
  onOpen,
  prewarmHandlers,
  renderActions,
  rowDragHandlers,
  sortStorageKey,
  className,
}: ProjectTableProps) {
  const [sort, setSort] = useState<SortState>(
    () => readStoredSort(sortStorageKey) ?? DEFAULT_SORT,
  );

  const handleSort = (key: SortKey) => {
    setSort((prev) => {
      const next: SortState =
        prev.key === key
          ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { key, dir: key === "name" ? "asc" : "desc" };
      writeStoredSort(sortStorageKey, next);
      return next;
    });
  };

  const rows = useMemo(() => {
    const sorted = [...projects];
    sorted.sort((a, b) => compareRows(a, b, sort));
    return sorted;
  }, [projects, sort]);

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
                label="Assets"
                sortKey="assetCount"
                active={sort}
                onSort={handleSort}
              />
              <HeaderCell label="Size" sortKey="size" active={sort} onSort={handleSort} />
              <HeaderCell
                label="Created"
                sortKey="created"
                active={sort}
                onSort={handleSort}
                className="hidden md:table-cell"
              />
              <HeaderCell
                label="Modified"
                sortKey="modified"
                active={sort}
                onSort={handleSort}
              />
              <th aria-label="Actions" className="w-10" />
            </tr>
          </thead>
          <tbody>
            {rows.map((project) => {
              const handlers = prewarmHandlers?.(project._id);
              const drag = rowDragHandlers?.(project);
              const { dragOver, ...dragDomHandlers } = drag ?? {};
              return (
                <tr
                  key={project._id}
                  onClick={() => onOpen(project._id)}
                  draggable={drag !== undefined}
                  className={cn(
                    "group border-t border-[#1a1a1a]/10 hover:bg-[#e8e8e0] cursor-pointer transition-colors",
                    dragOver && "bg-[#7cb87c]/15 outline outline-2 outline-[#2d5a2d]",
                  )}
                  {...handlers}
                  {...dragDomHandlers}
                >
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="inline-flex items-center justify-center h-7 w-7 rounded bg-[#e8e8e0] text-[#2d5a2d] shrink-0">
                        <Folder className="h-3.5 w-3.5" />
                      </span>
                      <span className="font-medium text-[#1a1a1a] truncate">
                        {project.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-[#888] whitespace-nowrap">
                    {project.assetCount}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-[#888] whitespace-nowrap">
                    {project.sizeBytes !== undefined
                      ? formatBytes(project.sizeBytes)
                      : "—"}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-[#888] hidden md:table-cell whitespace-nowrap">
                    {formatRelativeTime(project._creationTime)}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-[#888] whitespace-nowrap">
                    {formatRelativeTime(project.lastModifiedAt ?? project._creationTime)}
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <div
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {renderActions?.(project)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
