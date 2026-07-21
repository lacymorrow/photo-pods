"use client";

import { useOptimistic, useTransition } from "react";
import { cn } from "@/lib/utils";
import { POD_REACTION_EMOJIS, type PodReactionEmoji } from "./pod-constants";

export interface ReactionCounts {
	/** Map of emoji to total count. */
	counts: Partial<Record<PodReactionEmoji, number>>;
	/** The current viewer's active reaction, if any. */
	viewerReaction: PodReactionEmoji | null;
}

interface EmojiReactionsBarProps extends ReactionCounts {
	/**
	 * Toggle reaction. Called with the tapped emoji.
	 * - If viewer had this same emoji, remove.
	 * - If viewer had a different one, switch.
	 * - Otherwise add.
	 * Return a promise that resolves when the server confirms; the caller is
	 * responsible for persistence (server action wired in [LAC-2857]).
	 */
	onToggle: (emoji: PodReactionEmoji) => Promise<void> | void;
	/** When false, renders read-only counts (e.g. logged-out viewer on a public pod). */
	interactive?: boolean;
	/** Compact mode hides zero-count emojis until the viewer hovers/expands. */
	compact?: boolean;
	className?: string;
}

type OptimisticAction = { emoji: PodReactionEmoji };

const applyToggle = (
	state: ReactionCounts,
	action: OptimisticAction,
): ReactionCounts => {
	const next: Partial<Record<PodReactionEmoji, number>> = { ...state.counts };
	const bump = (emoji: PodReactionEmoji, delta: number) => {
		const current = next[emoji] ?? 0;
		const value = current + delta;
		if (value <= 0) {
			delete next[emoji];
		} else {
			next[emoji] = value;
		}
	};

	if (state.viewerReaction === action.emoji) {
		bump(action.emoji, -1);
		return { counts: next, viewerReaction: null };
	}
	if (state.viewerReaction) {
		bump(state.viewerReaction, -1);
	}
	bump(action.emoji, 1);
	return { counts: next, viewerReaction: action.emoji };
};

export const EmojiReactionsBar = ({
	counts,
	viewerReaction,
	onToggle,
	interactive = true,
	compact = false,
	className,
}: EmojiReactionsBarProps) => {
	const [optimistic, apply] = useOptimistic<ReactionCounts, OptimisticAction>(
		{ counts, viewerReaction },
		applyToggle,
	);
	const [pending, startTransition] = useTransition();

	const handleClick = (emoji: PodReactionEmoji) => {
		if (!interactive || pending) return;
		startTransition(() => {
			apply({ emoji });
			void onToggle(emoji);
		});
	};

	const visible = compact
		? POD_REACTION_EMOJIS.filter(
			(emoji) =>
				(optimistic.counts[emoji] ?? 0) > 0 ||
				optimistic.viewerReaction === emoji,
		)
		: POD_REACTION_EMOJIS;

	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-1.5 rounded-full border bg-background/80 backdrop-blur px-2 py-1.5",
				className,
			)}
			role="group"
			aria-label="Reactions"
		>
			{visible.map((emoji) => {
				const count = optimistic.counts[emoji] ?? 0;
				const isMine = optimistic.viewerReaction === emoji;
				return (
					<button
						key={emoji}
						type="button"
						disabled={!interactive}
						onClick={() => handleClick(emoji)}
						aria-pressed={isMine}
						aria-label={`React with ${emoji}${count ? `, ${count} so far` : ""}`}
						className={cn(
							"group relative flex items-center gap-1 rounded-full px-2 py-0.5 text-sm transition",
							"hover:scale-110 hover:bg-muted",
							isMine && "bg-primary/15 ring-1 ring-primary/40",
							!interactive && "cursor-default opacity-70 hover:scale-100",
						)}
					>
						<span aria-hidden className="text-base leading-none">
							{emoji}
						</span>
						{count > 0 && (
							<span className="text-xs tabular-nums text-muted-foreground">
								{count}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
};
