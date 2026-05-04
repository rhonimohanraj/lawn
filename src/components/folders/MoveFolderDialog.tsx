"use client";

import { useEffect, useMemo, useState } from "react";
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
import {
  ChevronRight,
  Folder,
  FolderInput,
  Search,
  Check,
} from "lucide-react";
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

interface DestinationNode {
  kind: "project-root" | "folder";
  /** Unique row id used for selection + expansion state. For project
   *  rows: `project:<id>`. For folder rows: `folder:<id>`. */
  id: string;
  projectId: Id<"projects">;
  /** null = the project's root level. */
  folderId: Id<"folders"> | null;
  name: string;
  /** Search-friendly full path, e.g. "00 TPS / 2026 / Lower Thirds". */
  label: string;
  depth: number;
  /** This row's children (subfolders). Project rows include their
   *  top-level folders; folder rows include their nested folders. */
  children: DestinationNode[];
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
  const [selected, setSelected] = useState<DestinationNode | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the dialog reopens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(null);
      setExpanded(new Set());
      setError(null);
    }
  }, [open]);

  // Build a tree: project-root nodes at depth 0, with their direct child
  // folders nested underneath, recursively.
  const tree: DestinationNode[] = useMemo(() => {
    if (!data) return [];

    // Group folders by parentFolderId for O(1) child lookup. Top-level
    // folders (no parent) keyed under their projectId.
    const childrenByParent = new Map<string, typeof data.folders>();
    const topByProject = new Map<string, typeof data.folders>();
    for (const f of data.folders) {
      if (f.parentFolderId) {
        const arr = childrenByParent.get(f.parentFolderId as string) ?? [];
        arr.push(f);
        childrenByParent.set(f.parentFolderId as string, arr);
      } else {
        const arr = topByProject.get(f.projectId as string) ?? [];
        arr.push(f);
        topByProject.set(f.projectId as string, arr);
      }
    }

    const sortByName = <T extends { name: string }>(arr: T[]): T[] =>
      [...arr].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
      );

    const buildFolderNode = (
      folder: (typeof data.folders)[number],
      depth: number,
      pathPrefix: string,
    ): DestinationNode => {
      const label = `${pathPrefix} / ${folder.name}`;
      const kids = childrenByParent.get(folder._id as string) ?? [];
      return {
        kind: "folder",
        id: `folder:${folder._id}`,
        projectId: folder.projectId,
        folderId: folder._id,
        name: folder.name,
        label,
        depth,
        isCurrent:
          folder.projectId === currentProjectId &&
          folder._id === currentParentFolderId,
        children: sortByName(kids).map((k) =>
          buildFolderNode(k, depth + 1, label),
        ),
      };
    };

    return sortByName(data.projects).map((p): DestinationNode => {
      const tops = topByProject.get(p._id as string) ?? [];
      return {
        kind: "project-root",
        id: `project:${p._id}`,
        projectId: p._id,
        folderId: null,
        name: p.name,
        label: p.name,
        depth: 0,
        isCurrent:
          p._id === currentProjectId && currentParentFolderId === null,
        children: sortByName(tops).map((f) =>
          buildFolderNode(f, 1, p.name),
        ),
      };
    });
  }, [data, currentProjectId, currentParentFolderId]);

  // Auto-expand any nodes whose label or any descendant's label matches
  // the active search. Without this, search matches that are deep in the
  // tree would be hidden behind collapsed parents.
  const searchExpandedIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return new Set<string>();
    const result = new Set<string>();

    const walk = (node: DestinationNode): boolean => {
      const selfMatches = node.label.toLowerCase().includes(q);
      let childMatches = false;
      for (const child of node.children) {
        if (walk(child)) childMatches = true;
      }
      if (selfMatches || childMatches) result.add(node.id);
      return selfMatches || childMatches;
    };
    for (const root of tree) walk(root);
    return result;
  }, [tree, query]);

  const isExpanded = (nodeId: string) =>
    query.trim() ? searchExpandedIds.has(nodeId) : expanded.has(nodeId);

  const toggleExpanded = (nodeId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  // Filter helper: a node is shown when it matches OR any descendant
  // matches. With no query, every node is shown.
  const shouldShow = (node: DestinationNode): boolean => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    if (node.label.toLowerCase().includes(q)) return true;
    return node.children.some((c) => shouldShow(c));
  };

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

        <div className="max-h-80 overflow-y-auto rounded-md border border-[#1a1a1a]/15">
          {data === undefined ? (
            <div className="px-4 py-6 text-sm text-[#888] text-center">Loading destinations…</div>
          ) : tree.length === 0 ? (
            <div className="px-4 py-6 text-sm text-[#888] text-center">
              No destinations available.
            </div>
          ) : (
            <TreeNodes
              nodes={tree}
              selected={selected}
              onSelect={setSelected}
              isExpanded={isExpanded}
              toggleExpanded={toggleExpanded}
              shouldShow={shouldShow}
              query={query}
            />
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
            {isMoving ? "Moving…" : selected ? `Move to ${selected.name}` : "Pick a destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Tree rendering ─────────────────────────────────────────────────────────

/**
 * Recursive tree renderer. Each node is a single row with:
 *   - a chevron toggle (only when the node has children)
 *   - a folder icon
 *   - the node's name
 *   - the "current" indicator (when it's the source's existing location)
 *   - a check when selected
 *
 * Selection works on click anywhere except the chevron. Expansion is
 * driven by the parent's `isExpanded`/`toggleExpanded` callbacks so the
 * dialog can short-circuit during search (auto-expand matching paths).
 */
function TreeNodes({
  nodes,
  selected,
  onSelect,
  isExpanded,
  toggleExpanded,
  shouldShow,
  query,
}: {
  nodes: DestinationNode[];
  selected: DestinationNode | null;
  onSelect: (n: DestinationNode) => void;
  isExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  shouldShow: (n: DestinationNode) => boolean;
  query: string;
}) {
  return (
    <div className="divide-y divide-[#1a1a1a]/10">
      {nodes.filter(shouldShow).map((node) => (
        <TreeNode
          key={node.id}
          node={node}
          selected={selected}
          onSelect={onSelect}
          isExpanded={isExpanded}
          toggleExpanded={toggleExpanded}
          shouldShow={shouldShow}
          query={query}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  selected,
  onSelect,
  isExpanded,
  toggleExpanded,
  shouldShow,
  query,
}: {
  node: DestinationNode;
  selected: DestinationNode | null;
  onSelect: (n: DestinationNode) => void;
  isExpanded: (id: string) => boolean;
  toggleExpanded: (id: string) => void;
  shouldShow: (n: DestinationNode) => boolean;
  query: string;
}) {
  const isSelected = selected?.id === node.id;
  const hasChildren = node.children.length > 0;
  const expanded = isExpanded(node.id);
  const indent = 12 + node.depth * 18;

  // Highlight the matching substring when searching.
  const renderName = () => {
    const q = query.trim();
    if (!q) return node.name;
    const idx = node.name.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return node.name;
    return (
      <>
        {node.name.slice(0, idx)}
        <mark className="bg-[#7cb87c]/30 text-[#1a1a1a] rounded px-0.5">
          {node.name.slice(idx, idx + q.length)}
        </mark>
        {node.name.slice(idx + q.length)}
      </>
    );
  };

  return (
    <>
      <div
        role="button"
        tabIndex={node.isCurrent ? -1 : 0}
        onClick={() => !node.isCurrent && onSelect(node)}
        onKeyDown={(e) => {
          if (node.isCurrent) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(node);
          }
        }}
        className={cn(
          "group flex items-center gap-2 py-2 pr-3 transition-colors",
          node.isCurrent ? "opacity-50 cursor-not-allowed" : "hover:bg-[#e8e8e0] cursor-pointer",
          isSelected && "bg-[#7cb87c]/15",
        )}
        style={{ paddingLeft: `${indent}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(node.id);
            }}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-[#888] hover:text-[#1a1a1a] hover:bg-[#1a1a1a]/5 shrink-0"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 transition-transform",
                expanded && "rotate-90",
              )}
            />
          </button>
        ) : (
          // Spacer so leaf rows align with their siblings
          <span className="inline-block h-5 w-5 shrink-0" />
        )}

        <span className="inline-flex items-center justify-center h-6 w-6 rounded bg-[#e8e8e0] text-[#2d5a2d] shrink-0">
          <Folder className="h-3 w-3" />
        </span>

        <span
          className={cn(
            "flex-1 min-w-0 text-sm text-[#1a1a1a] truncate",
            node.kind === "project-root" && "font-semibold",
          )}
        >
          {renderName()}
        </span>

        {node.isCurrent && (
          <span className="text-[10px] font-mono uppercase tracking-wider text-[#888]">
            Current
          </span>
        )}
        {isSelected && <Check className="h-4 w-4 text-[#2d5a2d] shrink-0" />}
      </div>

      {expanded && hasChildren && (
        <TreeNodes
          nodes={node.children}
          selected={selected}
          onSelect={onSelect}
          isExpanded={isExpanded}
          toggleExpanded={toggleExpanded}
          shouldShow={shouldShow}
          query={query}
        />
      )}
    </>
  );
}
