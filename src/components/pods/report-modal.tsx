"use client";

import { Flag } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { REPORT_REASONS, type ReportReasonId } from "./pod-constants";

export interface ReportPayload {
	reason: ReportReasonId;
	detail: string;
}

interface ReportModalProps {
	target: "media" | "pod";
	onSubmit: (payload: ReportPayload) => Promise<void> | void;
	trigger?: React.ReactNode;
}

export const ReportModal = ({ target, onSubmit, trigger }: ReportModalProps) => {
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState<ReportReasonId | null>(null);
	const [detail, setDetail] = useState("");
	const [submitted, setSubmitted] = useState(false);
	const [pending, startTransition] = useTransition();

	const reset = () => {
		setReason(null);
		setDetail("");
		setSubmitted(false);
	};

	const handleSubmit = () => {
		if (!reason) return;
		startTransition(async () => {
			await onSubmit({ reason, detail: detail.trim() });
			setSubmitted(true);
		});
	};

	const label = target === "media" ? "photo or video" : "pod";

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) reset();
			}}
		>
			<DialogTrigger asChild>
				{trigger ?? (
					<Button variant="ghost" size="sm" className="text-muted-foreground">
						<Flag className="h-4 w-4 mr-1" />
						Report
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Report this {label}</DialogTitle>
					<DialogDescription>
						Reports are reviewed by our moderation team. False reports may
						result in restrictions on your account.
					</DialogDescription>
				</DialogHeader>

				{submitted ? (
					<div className="py-6 text-center text-sm">
						Thanks — we&apos;ve received your report and will review it shortly.
					</div>
				) : (
					<>
						<RadioGroup
							value={reason ?? ""}
							onValueChange={(value) => setReason(value as ReportReasonId)}
							className="space-y-1"
						>
							{REPORT_REASONS.map((r) => (
								<div
									key={r.id}
									className="flex items-center space-x-2 rounded-md px-2 py-1.5 hover:bg-muted"
								>
									<RadioGroupItem value={r.id} id={`reason-${r.id}`} />
									<Label
										htmlFor={`reason-${r.id}`}
										className="font-normal cursor-pointer flex-1"
									>
										{r.label}
									</Label>
								</div>
							))}
						</RadioGroup>

						<div className="space-y-1.5">
							<Label htmlFor="report-detail" className="text-xs text-muted-foreground">
								Additional details (optional)
							</Label>
							<Textarea
								id="report-detail"
								value={detail}
								onChange={(e) => setDetail(e.target.value)}
								maxLength={500}
								rows={3}
								placeholder="What's going on?"
							/>
						</div>

						<DialogFooter>
							<Button
								variant="ghost"
								onClick={() => setOpen(false)}
								disabled={pending}
							>
								Cancel
							</Button>
							<Button
								onClick={handleSubmit}
								disabled={!reason || pending}
								variant="destructive"
							>
								{pending ? "Sending…" : "Submit report"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
};
