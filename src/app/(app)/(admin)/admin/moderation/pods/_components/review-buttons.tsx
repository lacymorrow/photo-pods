"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
	type ReportVerdict,
	reviewMediaReport,
	reviewPodReport,
} from "@/server/actions/pod-moderation";

interface ReviewButtonsProps {
	reportId: string;
	kind: "media" | "pod";
}

export const ReviewButtons = ({ reportId, kind }: ReviewButtonsProps) => {
	const [isPending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const review = (verdict: ReportVerdict) => {
		setError(null);
		startTransition(async () => {
			try {
				const action = kind === "media" ? reviewMediaReport : reviewPodReport;
				await action(reportId, verdict);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Review failed");
			}
		});
	};

	return (
		<div className="flex flex-col items-end gap-1">
			<div className="flex gap-2">
				<Button
					size="sm"
					variant="destructive"
					disabled={isPending}
					onClick={() => review("confirmed")}
				>
					Confirm violation
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={isPending}
					onClick={() => review("dismissed")}
				>
					Dismiss
				</Button>
			</div>
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
};
