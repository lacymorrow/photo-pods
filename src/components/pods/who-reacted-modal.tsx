"use client";

import { Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { POD_REACTION_EMOJIS, type PodReactionEmoji } from "./pod-constants";

export interface ReactorEntry {
	userId: string;
	name: string | null;
	image: string | null;
	emoji: PodReactionEmoji;
}

interface WhoReactedModalProps {
	/**
	 * Full list of reactors — only supplied when the viewer is authorized to
	 * see identities (members of a private/group pod). In public pods the
	 * server should send `reactors: null` and the modal will render count-only.
	 */
	reactors: ReactorEntry[] | null;
	/** Aggregated counts, always safe to render. */
	counts: Partial<Record<PodReactionEmoji, number>>;
	trigger: React.ReactNode;
}

export const WhoReactedModal = ({
	reactors,
	counts,
	trigger,
}: WhoReactedModalProps) => {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState<PodReactionEmoji | null>(null);

	const orderedEmojis = useMemo(
		() =>
			POD_REACTION_EMOJIS.filter((emoji) => (counts[emoji] ?? 0) > 0),
		[counts],
	);

	const visible = useMemo(() => {
		if (!reactors) return [];
		if (!filter) return reactors;
		return reactors.filter((r) => r.emoji === filter);
	}, [reactors, filter]);

	const total = orderedEmojis.reduce(
		(sum, emoji) => sum + (counts[emoji] ?? 0),
		0,
	);

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Users className="h-4 w-4" />
						Reactions ({total})
					</DialogTitle>
					{reactors === null && (
						<DialogDescription>
							This is a public pod. Individual reactors are hidden — only totals
							are shown.
						</DialogDescription>
					)}
				</DialogHeader>

				<div className="flex flex-wrap gap-1.5">
					{reactors !== null && (
						<button
							type="button"
							onClick={() => setFilter(null)}
							className={cn(
								"rounded-full border px-2.5 py-1 text-xs",
								filter === null && "bg-primary text-primary-foreground",
							)}
						>
							All {total}
						</button>
					)}
					{orderedEmojis.map((emoji) => (
						<button
							key={emoji}
							type="button"
							onClick={() =>
								setFilter((current) => (current === emoji ? null : emoji))
							}
							disabled={reactors === null}
							className={cn(
								"rounded-full border px-2.5 py-1 text-xs flex items-center gap-1",
								filter === emoji && "bg-primary text-primary-foreground",
								reactors === null && "cursor-default",
							)}
						>
							<span aria-hidden>{emoji}</span>
							<span className="tabular-nums">{counts[emoji] ?? 0}</span>
						</button>
					))}
				</div>

				{reactors !== null && (
					<div className="max-h-80 overflow-y-auto divide-y">
						{visible.length === 0 ? (
							<p className="py-6 text-center text-sm text-muted-foreground">
								Nobody yet.
							</p>
						) : (
							visible.map((reactor) => (
								<div
									key={`${reactor.userId}-${reactor.emoji}`}
									className="flex items-center gap-3 py-2"
								>
									<Avatar className="h-8 w-8">
										<AvatarImage src={reactor.image ?? undefined} />
										<AvatarFallback>
											{reactor.name?.[0]?.toUpperCase() ?? "?"}
										</AvatarFallback>
									</Avatar>
									<div className="min-w-0 flex-1 truncate text-sm">
										{reactor.name ?? "Anonymous"}
									</div>
									<span className="text-lg" aria-hidden>
										{reactor.emoji}
									</span>
								</div>
							))
						)}
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
};
