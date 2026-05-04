"use client";

import { useEffect, useState } from "react";
import { ArrowDownUp, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface SortOption<TKey extends string = string> {
  key: TKey;
  label: string;
}

interface SortMenuProps<TKey extends string> {
  /** Available sort options. The first one is the default if no
   *  persisted choice exists. */
  options: ReadonlyArray<SortOption<TKey>>;
  value: TKey;
  onChange: (key: TKey) => void;
  /** Optional localStorage key. When provided, the chosen option
   *  persists across navigations. */
  storageKey?: string;
  className?: string;
}

/**
 * Standalone sort-by dropdown for grid views. Pairs visually with
 * ViewModeToggle in the same toolbar.
 *
 * For sortable table headers we use AssetTable / ProjectTable internals
 * directly — those have richer per-column UX. SortMenu is the simpler
 * cousin for surfaces that don't have headers (project tiles, folder
 * cards, share browser grid).
 */
export function SortMenu<TKey extends string>({
  options,
  value,
  onChange,
  storageKey,
  className,
}: SortMenuProps<TKey>) {
  // Hydrate from storage once on mount.
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const candidate = options.find((o) => o.key === raw);
      if (candidate && candidate.key !== value) {
        onChange(candidate.key);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on key change only
  }, [storageKey]);

  const handleSelect = (key: TKey) => {
    onChange(key);
    if (storageKey && typeof window !== "undefined") {
      try {
        window.localStorage.setItem(storageKey, key);
      } catch {
        /* ignore */
      }
    }
  };

  const active = options.find((o) => o.key === value) ?? options[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-2 h-9 px-3 rounded-md border border-[#1a1a1a] bg-[#e8e8e0] text-sm text-[#1a1a1a] hover:bg-[#d8d8d0] transition-colors",
            className,
          )}
          title="Sort by"
        >
          <ArrowDownUp className="h-3.5 w-3.5 opacity-70" />
          <span className="text-[#888]">Sort:</span>
          <span className="font-medium">{active.label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.key}
            onClick={() => handleSelect(option.key)}
            className="flex items-center justify-between"
          >
            <span>{option.label}</span>
            {option.key === value && <Check className="h-4 w-4 text-[#2d5a2d]" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
