"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Folder, FolderInput, Search, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface MoveFolderDialogProps {
  /** Folder being moved. */
  folderId: Id<"folders"> | null;
  folderName: string | null;
  /** Team scope — destinations are limited to projects within this team. */
  teamId: Id<"teams"> | null;
  /** Current project so we can hint "currently in" in the picker. */
  currentProjectId: Id<"projects"> | null;
  /** Current parent folder (or null = project root) so we can disable
   *  selecting the existing location. */
  currentParentFolderId: Id<"folders"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional success-side hook so the host can show a toast. */
  onMoved?: (info: {
    targetProjectId: Id<"projects">;
    targetFolderId: Id<"folders"> | null;
    targetLabel: string;
  }) => void;
}

interface DestinationRow {
  kind: "project-root" | "folder";
  id: string; // unique identity for the row
  projectId: Id<"projects">;
  folderId: Id<"folders"> | null;
  label: string; // search-friendly flat label, e.g. "00 TPS / 2026 / Lower Thirds"
  depth: number;
  isCurrent: boolean;
}

export function MoveFolderDialog({
  folderId,
  folderName,
  teamId,
  currentProjectId,
  currentParentFolderId,
  open,
  onOpenChange,
  onMoved,
}: MoveFolderDialogProps) {
  const data = useQuery(
    api.folders.listMoveDestinations,
    open && teamId && folderId
      ? { teamId, excludeFolderId: folderId }
      : "skip",
  );
  const moveFolder = useMutation(api.folders.move);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DestinationRow | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the dialog reopens.
  useMemo(() => {
    if (open) {
      setQuery("");
      setSelected(null);
      setError(null);
    }
  }, [open]);

  const rows: DestinationRow[] = useMemo(() => {
    if (!data) return [];

    // Group folders by project, then sort by full path so siblings stay
    // contiguous and the indentation reads as a tree.
    const folderRows: DestinationRow[] = data.folders
      .map((f) => ({
        kind: "folder" as const,
        id: `folder:${f._id}`,
        projectId: f.projectId,
        folderId: f._id,
        label: `${f.projectName} / ${f.path.join(" / ")}`,
        depth: f.path.length,
        isCurrent:
          f.projectId === currentProjectId &&
          f._id === currentParentFolderId,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));

    // Project-root rows. "Project root" is always a valid destination
    // (folder lives directly under the project, no parent folder).
    const projectRows: DestinationRow[] = data.projects
      .map((p) => ({
        kind: "project-root" as const,
        id: `project:${p._id}`,
        projectId: p._id,
        folderId: null,
        label: p.name,
        depth: 0,
        isCurrent:
          p._id === currentProjectId && currentParentFolderId === null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));

    // Interleave: under each project's root row, we'd like its folders to
    // follow. Easiest is to sort everything by `${projectName}\0${depth}\0${path}`
    // — project root sorts first within its project (depth 0).
    const all = [...projectRows, ...folderRows].sort((a, b) => {
      const ap = a.label.split(" / ")[0];
      const bp = b.label.split(" / ")[0];
      const cmp = ap.localeCompare(bp, undefined, { sensitivity: "base", numeric: true });
      if (cmp !== 0) return cmp;
      // Within same project: project-root row first (depth 0), then folders by path.
      if (a.kind !== b.kind) return a.kind === "project-root" ? -1 : 1;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true });
    });

    return all;
  }, [data, currentProjectId, currentParentFolderId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(q));
  }, [rows, query]);

  const handleConfirm = async () => {
    if (!folderId || !selected) return;
    setError(null);
    setIsMoving(true);
    try {
      await moveFolder({
        folderId,
        newParentFolderId: selected.folderId ?? undefined,
        targetProjectId: selected.projectId,
      });
      onMoved?.({
        targetProjectId: selected.projectId,
        targetFolderId: selected.folderId,
        targetLabel: selected.label,
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Move failed");
    } finally {
      setIsMoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Move {folderName ?? "folder"}
          </DialogTitle>
          <DialogDescription>
            Pick where this folder should live. Reversible — you can always move it back.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[#888]" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects + folders…"
            className="pl-9"
            autoFocus
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-md border border-[#1a1a1a]/15 divide-y divide-[#1a1a1a]/10">
          {data === undefined ? (
            <div className="px-4 py-6 text-sm text-[#888] text-center">Loading destinations…</div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-6 text-sm text-[#888] text-center">
              {query ? "No matches." : "No other destinations available."}
            </div>
          ) : (
            filtered.map((row) => {
              const isSelected = selected?.id === row.id;
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => !row.isCurrent && setSelected(row)}
                  disabled={row.isCurrent}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
                    row.isCurrent
                      ? "opacity-50 cursor-not-allowed"
                      : "hover:bg-[#e8e8e0] cursor-pointer",
                    isSelected && "bg-[#7cb87c]/15",
                  )}
                  style={{ paddingLeft: `${12 + row.depth * 16}px` }}
                >
                  <span className="inline-flex items-center justify-center h-6 w-6 rounded bg-[#e8e8e0] text-[#2d5a2d] shrink-0">
                    <Folder className="h-3 w-3" />
                  </span>
                  <span className="flex-1 min-w-0 text-sm text-[#1a1a1a] truncate">
                    {row.kind === "project-root" ? (
                      <span className="font-semibold">{row.label}</span>
                    ) : (
                      row.label
                    )}
                  </span>
                  {row.isCurrent && (
                    <span className="text-[10px] font-mono uppercase tracking-wider text-[#888]">
                      Current
                    </span>
                  )}
                  {isSelected && <Check className="h-4 w-4 text-[#2d5a2d] shrink-0" />}
                </button>
              );
            })
          )}
        </div>

        {error && <p className="text-sm text-[#dc2626]">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isMoving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleConfirm()}
            disabled={!selected || isMoving}
          >
            <FolderInput className="h-4 w-4" />
            {isMoving ? "Moving…" : selected ? `Move to ${selected.label.split(" / ").slice(-1)[0]}` : "Pick a destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
