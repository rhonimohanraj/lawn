"use client";

import { LayoutGrid, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ViewMode = "grid" | "table";

const MODES: Array<{ mode: ViewMode; label: string; Icon: typeof LayoutGrid }> = [
  { mode: "grid", label: "Grid view", Icon: LayoutGrid },
  { mode: "table", label: "Table view", Icon: Table2 },
];

interface ViewModeToggleProps {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
  className?: string;
}

/**
 * Two-button segmented toggle: Grid ⇄ Table.
 *
 * The original brutalist styling lived inline; we now consume theme tokens via
 * the legacy color mappings in app.css, so this component automatically picks
 * up either the team-dark or client-light palette.
 */
export function ViewModeToggle({ value, onChange, className }: ViewModeToggleProps) {
  return (
    <div
      role="group"
      aria-label="View mode"
      className={cn(
        "flex items-center border-2 border-[#1a1a1a] rounded-md overflow-hidden p-0.5",
        className,
      )}
    >
      {MODES.map(({ mode, label, Icon }) => {
        const active = value === mode;
        return (
          <button
            key={mode}
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => onChange(mode)}
            className={cn(
              "p-1.5 rounded transition-colors",
              active
                ? "bg-[#1a1a1a] text-[#f0f0e8]"
                : "text-[#888] hover:text-[#1a1a1a]",
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
