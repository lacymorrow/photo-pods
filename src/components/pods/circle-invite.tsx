"use client";

import {
	Check,
	Copy,
	Link as LinkIcon,
	Search,
	Share2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { getPrivacyMeta } from "@/lib/pods/privacy";
import { createInviteLink } from "@/server/actions/pods";

interface CircleContact {
	id: string;
	name: string;
	username?: string | null;
	image?: string | null;
}

type ContactState = "available" | "invited" | "pending" | "declined";

interface CircleInviteProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	pod: {
		id: string;
		name: string;
		visibility: string;
	};
	/**
	 * People to render as floating avatars around the central pod circle.
	 * MVP source: co-members from other pods the current user shares. Empty
	 * list is fine — the QR/link/share paths still work.
	 */
	contacts?: CircleContact[];
	/**
	 * Called when the sheet dispatches an in-app invite for a specific contact.
	 * Wired up when the backend endpoint lands (see LAC-2857).
	 */
	onInviteContact?: (contactId: string) => Promise<void>;
}

const ORBIT_POSITIONS = [
	{ x: -140, y: -60 },
	{ x: 140, y: -60 },
	{ x: -180, y: 40 },
	{ x: 180, y: 40 },
	{ x: -90, y: 130 },
	{ x: 90, y: 130 },
	{ x: 0, y: -130 },
	{ x: 0, y: 150 },
];

export const CircleInvite = ({
	open,
	onOpenChange,
	pod,
	contacts = [],
	onInviteContact,
}: CircleInviteProps) => {
	const privacy = getPrivacyMeta(pod.visibility);
	const PodIcon = privacy.icon;
	const [link, setLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [search, setSearch] = useState("");
	const [states, setStates] = useState<Record<string, ContactState>>({});
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();

	const visibleContacts = useMemo(
		() =>
			contacts
				.filter((c) => {
					if (!search.trim()) return true;
					const q = search.trim().toLowerCase();
					return (
						c.name.toLowerCase().includes(q) ||
						(c.username?.toLowerCase().includes(q) ?? false)
					);
				})
				.slice(0, ORBIT_POSITIONS.length),
		[contacts, search],
	);

	useEffect(() => {
		if (!open) return;
		if (link) return;
		startTransition(async () => {
			try {
				const { token } = await createInviteLink(pod.id, "viewer", 72);
				setLink(`${window.location.origin}/pods/invite/${token}`);
			} catch {
				// silent — the Copy button will just be hidden
			}
		});
	}, [open, link, pod.id]);

	const handleCopy = async () => {
		if (!link) return;
		await navigator.clipboard.writeText(link);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};

	const handleShare = async () => {
		if (!link) return;
		if (typeof navigator !== "undefined" && "share" in navigator) {
			try {
				await navigator.share({
					title: `Join ${pod.name} on Photopods`,
					text: `You've been invited to ${pod.name}`,
					url: link,
				});
			} catch {
				// user cancelled
			}
		} else {
			await handleCopy();
		}
	};

	const handleTapContact = useCallback(
		async (contactId: string) => {
			const current = states[contactId] ?? "available";
			if (current !== "available") return;
			setPendingId(contactId);
			setStates((s) => ({ ...s, [contactId]: "invited" }));
			try {
				await onInviteContact?.(contactId);
			} catch {
				setStates((s) => ({ ...s, [contactId]: "declined" }));
			} finally {
				setPendingId(null);
			}
		},
		[states, onInviteContact],
	);

	const allInvited =
		visibleContacts.length > 0 &&
		visibleContacts.every((c) => states[c.id] === "invited");

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="bottom"
				className="rounded-t-2xl max-h-[92vh] flex flex-col p-0"
			>
				<div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-muted-foreground/20" />

				<SheetHeader className="text-center px-6 mt-3">
					<SheetDescription className="text-xs uppercase tracking-wide">
						Invite friends to
					</SheetDescription>
					<SheetTitle className="text-2xl font-bold truncate">
						{pod.name}
					</SheetTitle>
				</SheetHeader>

				<div className="relative flex items-center justify-center h-[360px] mx-auto">
					{/* Sonar rings */}
					<Rings pause={allInvited} accentHsl={privacy.accentHsl} />

					{/* Central pod circle */}
					<div
						className={cn(
							"relative z-10 h-[120px] w-[120px] rounded-full flex flex-col items-center justify-center border-2 shadow-lg",
							privacy.accentBorderClass,
							privacy.accentBgTintClass,
						)}
					>
						<PodIcon className={cn("h-7 w-7 mb-1", privacy.accentTextClass)} />
						<span className="text-[10px] font-medium max-w-[100px] truncate px-2 text-center">
							{pod.name}
						</span>
					</div>

					{/* Orbital contacts */}
					{visibleContacts.map((c, i) => {
						const pos = ORBIT_POSITIONS[i % ORBIT_POSITIONS.length]!;
						const state = states[c.id] ?? "available";
						return (
							<button
								key={c.id}
								type="button"
								onClick={() => handleTapContact(c.id)}
								className={cn(
									"absolute z-20 flex flex-col items-center gap-1 transition-transform",
									pendingId === c.id ? "scale-105" : "hover:scale-105",
								)}
								style={{
									transform: `translate(${pos.x}px, ${pos.y}px)`,
									animation: `pp-float ${
										3 + (i % 3)
									}s ease-in-out ${(i * 0.3).toFixed(1)}s infinite`,
								}}
							>
								<Avatar
									name={c.name}
									image={c.image}
									state={state}
								/>
								<span className="text-[10px] text-muted-foreground truncate max-w-[70px]">
									@{c.username ?? c.name.split(" ")[0]?.toLowerCase()}
								</span>
							</button>
						);
					})}

					{visibleContacts.length === 0 && (
						<span className="absolute bottom-2 left-0 right-0 text-center text-xs text-muted-foreground px-8">
							No contacts yet — use the share options below.
						</span>
					)}
				</div>

				<div className="px-6 space-y-3 pb-6 border-t border-border pt-4 bg-background">
					<div className="relative">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
						<Input
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search contacts or add by username"
							className="pl-9"
						/>
					</div>
					<div className="grid grid-cols-2 gap-2">
						<Button
							variant="outline"
							onClick={handleCopy}
							disabled={!link || isPending}
						>
							{copied ? (
								<Check className="h-4 w-4 mr-1.5" />
							) : (
								<Copy className="h-4 w-4 mr-1.5" />
							)}
							{copied ? "Copied" : "Copy link"}
						</Button>
						<Button
							variant="outline"
							onClick={handleShare}
							disabled={!link || isPending}
						>
							<Share2 className="h-4 w-4 mr-1.5" />
							Share…
						</Button>
					</div>
					{link && (
						<div className="flex items-center gap-2 px-3 py-2 bg-muted rounded-md">
							<LinkIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
							<code className="text-[11px] truncate flex-1">{link}</code>
						</div>
					)}
					<Button
						className="w-full"
						onClick={() => onOpenChange(false)}
					>
						Done
					</Button>
				</div>

				<style jsx>{`
					@keyframes pp-float {
						0%, 100% { translate: 0 0; }
						50% { translate: 0 -6px; }
					}
				`}</style>
			</SheetContent>
		</Sheet>
	);
};

const Rings = ({ pause, accentHsl }: { pause: boolean; accentHsl: string }) => (
	<>
		{[0, 0.8, 1.6].map((delay) => (
			<span
				key={delay}
				aria-hidden
				className="absolute rounded-full border-2"
				style={{
					width: 120,
					height: 120,
					borderColor: `hsla(${accentHsl.replace(/ /g, ",")},0.35)`,
					animation: pause
						? undefined
						: `pp-ring 2.5s ease-out ${delay}s infinite`,
				}}
			/>
		))}
		<style jsx>{`
			@keyframes pp-ring {
				0% { transform: scale(1); opacity: 0.5; }
				100% { transform: scale(1.9); opacity: 0; }
			}
		`}</style>
	</>
);

const Avatar = ({
	name,
	image,
	state,
}: {
	name: string;
	image?: string | null;
	state: ContactState;
}) => {
	const initials = name
		.split(" ")
		.map((s) => s[0])
		.filter(Boolean)
		.slice(0, 2)
		.join("")
		.toUpperCase();
	const ringColor =
		state === "invited"
			? "ring-emerald-500"
			: state === "pending"
				? "ring-amber-500"
				: state === "declined"
					? "ring-rose-500 opacity-40"
					: "ring-transparent";
	return (
		<div className="relative">
			<div
				className={cn(
					"h-11 w-11 rounded-full ring-2 ring-offset-2 ring-offset-background overflow-hidden flex items-center justify-center bg-primary/10 text-primary font-medium text-sm transition-all",
					ringColor,
				)}
			>
				{image ? (
					// eslint-disable-next-line @next/next/no-img-element
					<img
						src={image}
						alt={name}
						className="h-full w-full object-cover"
					/>
				) : (
					<span>{initials || "?"}</span>
				)}
			</div>
			{state === "invited" && (
				<span className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-emerald-500 flex items-center justify-center text-white">
					<Check className="h-2.5 w-2.5" />
				</span>
			)}
			{state === "declined" && (
				<span className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-rose-500 flex items-center justify-center text-white">
					<X className="h-2.5 w-2.5" />
				</span>
			)}
		</div>
	);
};
