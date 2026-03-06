"use client";

import { Check, Copy, Link } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { createInviteLink } from "@/server/actions/pods";

interface InviteLinkProps {
	podId: string;
}

export const InviteLink = ({ podId }: InviteLinkProps) => {
	const [role, setRole] = useState<"contributor" | "viewer">("viewer");
	const [link, setLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [isPending, startTransition] = useTransition();

	const handleGenerate = () => {
		startTransition(async () => {
			const { token } = await createInviteLink(podId, role);
			const url = `${window.location.origin}/pods/invite/${token}`;
			setLink(url);
		});
	};

	const handleCopy = async () => {
		if (!link) return;
		await navigator.clipboard.writeText(link);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="space-y-3">
			<div className="flex gap-2">
				<Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
					<SelectTrigger className="w-[140px]">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="viewer">Viewer</SelectItem>
						<SelectItem value="contributor">Contributor</SelectItem>
					</SelectContent>
				</Select>
				<Button onClick={handleGenerate} disabled={isPending} variant="outline">
					<Link className="h-4 w-4 mr-1" />
					Generate Link
				</Button>
			</div>

			{link && (
				<div className="flex items-center gap-2 p-2 bg-muted rounded-lg">
					<code className="text-xs flex-1 truncate">{link}</code>
					<Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={handleCopy}>
						{copied ? (
							<Check className="h-4 w-4 text-green-500" />
						) : (
							<Copy className="h-4 w-4" />
						)}
					</Button>
				</div>
			)}
		</div>
	);
};
