"use client";

import { Grid3X3, LayoutList } from "lucide-react";
import { cn } from "@/lib/utils";

export type ViewMode = "grid" | "list";

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  className?: string;
}

/**
 * Brutalist 2-button toggle that switches between grid + list rendering.
 * Drop into any page header that has both layouts.
 */
export function ViewModeToggle({ value, onChange, className }: ViewModeToggleProps) {
  return (
    <div className={cn("flex items-center border-2 border-[#1a1a1a] p-0.5", className)}>
      <button
        type="button"
        aria-label="Grid view"
        aria-pressed={value === "grid"}
        onClick={() => onChange("grid")}
        className={cn(
          "p-1.5 transition-colors",
          value === "grid"
            ? "bg-[#1a1a1a] text-[#f0f0e8]"
            : "text-[#888] hover:text-[#1a1a1a]",
        )}
      >
        <Grid3X3 className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="List view"
        aria-pressed={value === "list"}
        onClick={() => onChange("list")}
        className={cn(
          "p-1.5 transition-colors",
          value === "list"
            ? "bg-[#1a1a1a] text-[#f0f0e8]"
            : "text-[#888] hover:text-[#1a1a1a]",
        )}
      >
        <LayoutList className="h-4 w-4" />
      </button>
    </div>
  );
}
