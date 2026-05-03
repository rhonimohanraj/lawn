"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: Id<"projects">;
  parentFolderId?: Id<"folders">;
  /** Called with the new folder's id once created. */
  onCreated?: (folderId: Id<"folders">) => void;
}

export function NewFolderDialog({
  open,
  onOpenChange,
  projectId,
  parentFolderId,
  onCreated,
}: NewFolderDialogProps) {
  const createFolder = useMutation(api.folders.create);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    setBusy(true);
    setError(null);
    try {
      const folderId = await createFolder({
        projectId,
        parentFolderId,
        name: trimmed,
      });
      setName("");
      onOpenChange(false);
      onCreated?.(folderId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setError(null); onOpenChange(o); }}>
      <DialogContent className="border-2 border-[#1a1a1a] bg-[#f0f0e8]">
        <DialogHeader>
          <DialogTitle className="font-black tracking-tight">New folder</DialogTitle>
          <DialogDescription className="text-[#888]">
            Folders organize assets within this project. Names cannot contain &quot;/&quot;.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Folder name"
            maxLength={200}
            className="border-2 border-[#1a1a1a] bg-[#f0f0e8] px-3 py-2 font-mono text-sm"
          />
          {error && (
            <p className="text-sm text-[#dc2626] font-mono">{error}</p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create folder"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
