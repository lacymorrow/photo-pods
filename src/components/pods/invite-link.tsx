"use client";

import QRCode from "qrcode";
import { Check, Copy, Download, Link, QrCode } from "lucide-react";
import { useCallback, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
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
	const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

	const handleGenerate = () => {
		startTransition(async () => {
			const { token } = await createInviteLink(podId, role);
			const url = `${window.location.origin}/pods/invite/${token}`;
			setLink(url);
			// Pre-generate QR code
			try {
				const dataUrl = await QRCode.toDataURL(url, {
					width: 512,
					margin: 2,
					color: { dark: "#000000", light: "#ffffff" },
				});
				setQrDataUrl(dataUrl);
			} catch {
				// QR generation failed — button will be hidden
			}
		});
	};

	const handleCopy = async () => {
		if (!link) return;
		await navigator.clipboard.writeText(link);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleDownloadQr = useCallback(() => {
		if (!qrDataUrl) return;
		const a = document.createElement("a");
		a.href = qrDataUrl;
		a.download = "pod-invite-qr.png";
		a.click();
	}, [qrDataUrl]);

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
				<div className="space-y-2">
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

					{qrDataUrl && (
						<Dialog>
							<DialogTrigger asChild>
								<Button variant="outline" size="sm" className="w-full">
									<QrCode className="h-4 w-4 mr-2" />
									Show QR Code
								</Button>
							</DialogTrigger>
							<DialogContent className="sm:max-w-sm">
								<DialogHeader>
									<DialogTitle>Invite QR Code</DialogTitle>
								</DialogHeader>
								<div className="flex flex-col items-center gap-4 py-4">
									{/* eslint-disable-next-line @next/next/no-img-element */}
									<img
										src={qrDataUrl}
										alt="Invite QR Code"
										className="w-64 h-64 rounded-lg"
									/>
									<p className="text-xs text-muted-foreground text-center max-w-xs">
										Scan this code to join the pod as a {role}.
									</p>
									<Button variant="outline" size="sm" onClick={handleDownloadQr}>
										<Download className="h-4 w-4 mr-2" />
										Download PNG
									</Button>
								</div>
							</DialogContent>
						</Dialog>
					)}
				</div>
			)}
		</div>
	);
};
