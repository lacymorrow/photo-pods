"use client";

import { useOptimistic, useTransition } from "react";
import { cn } from "@/lib/utils";
import { REACTIONS, type ReactionCounts } from "@/lib/pods/reactions";

interface ReactionsTrayProps {
  mediaId: string;
  counts: ReactionCounts;
  /** Slug of the current user's reaction, or null if none. */
  mine: string | null;
  /**
   * Fires when the user taps a reaction. Toggles when the slug matches
   * their current reaction; switches otherwise. Backend endpoint contract
   * is defined in the coordination note on LAC-2857.
   */
  onReact?: (mediaId: string, next: string | null) => Promise<void>;
  className?: string;
}

interface OptimisticState {
  mine: string | null;
  counts: ReactionCounts;
}

export const ReactionsTray = ({
  mediaId,
  counts,
  mine,
  onReact,
  className,
}: ReactionsTrayProps) => {
  const [, startTransition] = useTransition();
  const [state, applyOptimistic] = useOptimistic<OptimisticState, string>(
    { mine, counts },
    (prev, slug) => {
      const next: OptimisticState = {
        mine: prev.mine === slug ? null : slug,
        counts: { ...prev.counts },
      };
      if (prev.mine && prev.mine !== slug) {
        next.counts[prev.mine] = Math.max(0, (next.counts[prev.mine] ?? 0) - 1);
      }
      if (prev.mine === slug) {
        next.counts[slug] = Math.max(0, (next.counts[slug] ?? 0) - 1);
      } else {
        next.counts[slug] = (next.counts[slug] ?? 0) + 1;
      }
      return next;
    }
  );

  const handleTap = (slug: string) => {
    startTransition(async () => {
      applyOptimistic(slug);
      const next = state.mine === slug ? null : slug;
      try {
        await onReact?.(mediaId, next);
      } catch {
        // optimistic rollback happens automatically at transition end
      }
    });
  };

  return (
    <div
      className={cn("flex scrollbar-none items-center gap-1 overflow-x-auto py-1", className)}
      // Not `toolbar`: that is an ARIA composite widget, and the APG contract
      // for it is one tab stop plus roving tabindex and arrow-key navigation,
      // which these natively-tabbable buttons do not implement. `group` is a
      // plain container role and promises none of that; it exists here only to
      // hang `aria-label` on. Not <fieldset> either (biome's suggestion) —
      // these are command buttons rather than form controls, and fieldset's
      // `min-width: min-content` would break the horizontal scroll row.
      // biome-ignore lint/a11y/useSemanticElements: see above
      role="group"
      aria-label="React"
    >
      {REACTIONS.map((r) => {
        const count = state.counts[r.slug] ?? 0;
        const active = state.mine === r.slug;
        return (
          <button
            key={r.slug}
            type="button"
            onClick={() => handleTap(r.slug)}
            title={r.label}
            className={cn(
              "flex min-w-[44px] flex-col items-center justify-center rounded-lg px-2.5 py-1 transition-all",
              active ? "scale-105 bg-white/15 ring-2 ring-white/70" : "hover:bg-white/10"
            )}
          >
            <span
              className={cn("text-lg leading-none transition-transform", active && "scale-110")}
              aria-hidden
            >
              {r.emoji}
            </span>
            <span
              className={cn(
                "mt-0.5 text-[10px] tabular-nums transition-colors",
                active ? "text-white" : "text-white/50"
              )}
            >
              {count > 0 ? count : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
};
