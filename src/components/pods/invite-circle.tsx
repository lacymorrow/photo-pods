"use client";

import { motion } from "framer-motion";
import { Check, Copy, Link2, Radio, RefreshCw, ScanLine } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CircleMember {
	userId: string;
	name: string | null;
	image: string | null;
	joinedAt: Date | string;
}

interface InviteCircleProps {
	podName: string;
	/** Fully-qualified invite URL (includes token). */
	inviteUrl: string;
	/** 6-character short code, e.g. "K3F-92X". */
	shortCode: string;
	/** Members currently in the pod, newest last. */
	members: CircleMember[];
	/** Called when the owner asks for a fresh invite token/code. */
	onRegenerate?: () => Promise<void> | void;
}

const RING_RADIUS = 128;

export const InviteCircle = ({
	podName,
	inviteUrl,
	shortCode,
	members,
	onRegenerate,
}: InviteCircleProps) => {
	const [copiedLink, setCopiedLink] = useState(false);
	const [copiedCode, setCopiedCode] = useState(false);
	const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
	const [pending, startTransition] = useTransition();
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		let cancelled = false;
		QRCode.toDataURL(inviteUrl, {
			margin: 1,
			width: 220,
			errorCorrectionLevel: "M",
		})
			.then((url) => {
				if (!cancelled) setQrDataUrl(url);
			})
			.catch(() => {
				if (!cancelled) setQrDataUrl(null);
			});
		return () => {
			cancelled = true;
		};
	}, [inviteUrl]);

	useEffect(
		() => () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		},
		[],
	);

	const flashCopied = (setter: (value: boolean) => void) => {
		setter(true);
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setter(false), 1600);
	};

	const copyLink = async () => {
		await navigator.clipboard.writeText(inviteUrl);
		flashCopied(setCopiedLink);
	};

	const copyCode = async () => {
		await navigator.clipboard.writeText(shortCode);
		flashCopied(setCopiedCode);
	};

	const positioned = useMemo(() => {
		const recent = members.slice(-8);
		return recent.map((member, index) => {
			const angle = (index / Math.max(recent.length, 1)) * Math.PI * 2;
			return {
				member,
				x: Math.cos(angle) * RING_RADIUS,
				y: Math.sin(angle) * RING_RADIUS,
			};
		});
	}, [members]);

	const handleRegenerate = () => {
		if (!onRegenerate) return;
		startTransition(async () => {
			await onRegenerate();
		});
	};

	return (
		<div className="flex flex-col items-center gap-6 py-4">
			<div className="text-center">
				<h2 className="font-semibold text-lg flex items-center gap-2 justify-center">
					<Radio className="h-4 w-4 text-primary animate-pulse" />
					Invite people to {podName}
				</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Nearby friends can scan the code — or share the link.
				</p>
			</div>

			<div className="relative flex items-center justify-center h-[340px] w-[340px]">
				<motion.div
					aria-hidden
					initial={{ scale: 0.6, opacity: 0 }}
					animate={{ scale: [0.6, 1.15, 1.4], opacity: [0.35, 0.15, 0] }}
					transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut" }}
					className="absolute h-64 w-64 rounded-full border border-primary/40"
				/>
				<motion.div
					aria-hidden
					initial={{ scale: 0.6, opacity: 0 }}
					animate={{ scale: [0.6, 1.15, 1.4], opacity: [0.35, 0.15, 0] }}
					transition={{
						duration: 2.4,
						repeat: Infinity,
						ease: "easeOut",
						delay: 1.2,
					}}
					className="absolute h-64 w-64 rounded-full border border-primary/40"
				/>

				<div className="relative z-10 flex h-32 w-32 flex-col items-center justify-center rounded-2xl border bg-background/95 shadow-lg overflow-hidden">
					{qrDataUrl ? (
						<img
							src={qrDataUrl}
							alt="Invite QR code"
							className="h-full w-full object-contain"
						/>
					) : (
						<ScanLine className="h-8 w-8 text-muted-foreground" />
					)}
				</div>

				{positioned.map(({ member, x, y }) => (
					<motion.div
						key={member.userId}
						initial={{ scale: 0, opacity: 0 }}
						animate={{ scale: 1, opacity: 1 }}
						transition={{ duration: 0.4 }}
						style={{ transform: `translate(${x}px, ${y}px)` }}
						className="absolute"
					>
						<Avatar className="h-10 w-10 ring-2 ring-background shadow">
							<AvatarImage src={member.image ?? undefined} />
							<AvatarFallback className="text-xs">
								{member.name?.[0]?.toUpperCase() ?? "?"}
							</AvatarFallback>
						</Avatar>
					</motion.div>
				))}
			</div>

			<div className="flex w-full max-w-sm flex-col gap-3">
				<Button
					type="button"
					variant="secondary"
					className="justify-between font-mono text-lg tracking-widest h-14"
					onClick={copyCode}
				>
					<span className="text-xs text-muted-foreground uppercase tracking-normal">
						Short code
					</span>
					<span className="flex items-center gap-2">
						{shortCode}
						{copiedCode ? (
							<Check className="h-4 w-4 text-emerald-500" />
						) : (
							<Copy className="h-4 w-4 opacity-60" />
						)}
					</span>
				</Button>

				<Button
					type="button"
					variant="outline"
					className="justify-start gap-2"
					onClick={copyLink}
				>
					<Link2 className="h-4 w-4" />
					<span className={cn("truncate flex-1 text-left")}>{inviteUrl}</span>
					{copiedLink ? (
						<Check className="h-4 w-4 text-emerald-500" />
					) : (
						<Copy className="h-4 w-4 opacity-60" />
					)}
				</Button>

				{onRegenerate && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="text-muted-foreground"
						onClick={handleRegenerate}
						disabled={pending}
					>
						<RefreshCw
							className={cn("h-3.5 w-3.5 mr-1", pending && "animate-spin")}
						/>
						Regenerate link
					</Button>
				)}
			</div>
		</div>
	);
};
