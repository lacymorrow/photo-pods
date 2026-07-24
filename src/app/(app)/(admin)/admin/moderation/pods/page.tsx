import type { Metadata } from "next";

import { Badge } from "@/components/ui/badge";
import { constructMetadata } from "@/config/metadata";
import {
	getPendingMediaReports,
	getPendingPodReports,
} from "@/server/services/pod-moderation";

import { ReviewButtons } from "./_components/review-buttons";

export const dynamic = "force-dynamic";

export const metadata: Metadata = constructMetadata({
	title: "Pod Moderation Queue",
	description: "Review pending Photopods content reports.",
	noIndex: true,
});

// LAC-2854 §Quality Gates: content moderation review SLA is < 4 hours.
const SLA_MS = 4 * 60 * 60 * 1000;

const REASON_LABELS: Record<string, string> = {
	nudity_sexual: "Nudity / Sexual",
	violence: "Violence",
	harassment: "Harassment",
	spam: "Spam",
	illegal: "Illegal",
	other: "Other",
};

const formatAge = (createdAt: Date) => {
	const minutes = Math.max(
		0,
		Math.floor((Date.now() - createdAt.getTime()) / 60_000),
	);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m ago`;
	return `${Math.floor(hours / 24)}d ago`;
};

const ReportMeta = ({
	reason,
	details,
	reporterName,
	createdAt,
}: {
	reason: string;
	details: string | null;
	reporterName: string | null;
	createdAt: Date;
}) => {
	const overdue = Date.now() - createdAt.getTime() > SLA_MS;
	return (
		<div className="min-w-0 flex-1">
			<div className="flex flex-wrap items-center gap-2">
				<Badge variant="secondary">{REASON_LABELS[reason] ?? reason}</Badge>
				<span
					className={`text-xs ${overdue ? "font-semibold text-destructive" : "text-muted-foreground"}`}
					title={createdAt.toISOString()}
				>
					{formatAge(createdAt)}
					{overdue && " — SLA breached"}
				</span>
			</div>
			{details && (
				<p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
					{details}
				</p>
			)}
			<p className="mt-1 text-xs text-muted-foreground">
				Reported by {reporterName ?? "Unknown user"}
			</p>
		</div>
	);
};

export default async function PodModerationPage() {
	const [mediaQueue, podQueue] = await Promise.all([
		getPendingMediaReports(),
		getPendingPodReports(),
	]);

	return (
		<div className="space-y-10">
			<div>
				<h1 className="text-3xl font-bold">Pod Moderation Queue</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					Pending reports, oldest first. Review SLA is 4 hours (LAC-2854).
				</p>
			</div>

			<section>
				<h2 className="mb-4 text-xl font-semibold">
					Media reports ({mediaQueue.length})
				</h2>
				<div className="grid gap-4">
					{mediaQueue.map((report) => {
						const preview = report.media.thumbnailUrl ?? report.media.url;
						return (
							<div
								key={report.id}
								className="flex items-start gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
							>
								{preview ? (
									// biome-ignore lint/performance/noImgElement: previews come from arbitrary storage hosts; next/image would require allowlisting every media domain
									<img
										src={preview}
										alt={report.media.caption ?? "Reported media"}
										className="h-20 w-20 shrink-0 rounded-md object-cover"
									/>
								) : (
									<div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground">
										{report.media.type}
									</div>
								)}
								<ReportMeta
									reason={report.reason}
									details={report.details}
									reporterName={report.reporterName}
									createdAt={report.createdAt}
								/>
								<div className="flex shrink-0 flex-col items-end gap-2">
									<div className="flex flex-wrap justify-end gap-2 text-xs text-muted-foreground">
										<span>
											Pod: {report.pod.name} ({report.pod.visibility})
										</span>
										<span>{report.media.reportCount} reports</span>
										{report.media.hiddenAt && (
											<Badge variant="outline">Auto-hidden</Badge>
										)}
									</div>
									<ReviewButtons reportId={report.id} kind="media" />
								</div>
							</div>
						);
					})}
					{mediaQueue.length === 0 && (
						<p className="text-sm text-muted-foreground">
							No pending media reports.
						</p>
					)}
				</div>
			</section>

			<section>
				<h2 className="mb-4 text-xl font-semibold">
					Pod reports ({podQueue.length})
				</h2>
				<div className="grid gap-4">
					{podQueue.map((report) => (
						<div
							key={report.id}
							className="flex items-start gap-4 rounded-lg border bg-card p-4 text-card-foreground shadow-sm"
						>
							<ReportMeta
								reason={report.reason}
								details={report.details}
								reporterName={report.reporterName}
								createdAt={report.createdAt}
							/>
							<div className="flex shrink-0 flex-col items-end gap-2">
								<div className="flex gap-2 text-xs text-muted-foreground">
									<span>
										Pod: {report.pod.name} ({report.pod.visibility})
									</span>
									{report.pod.hiddenAt && <Badge variant="outline">Hidden</Badge>}
								</div>
								<ReviewButtons reportId={report.id} kind="pod" />
							</div>
						</div>
					))}
					{podQueue.length === 0 && (
						<p className="text-sm text-muted-foreground">
							No pending pod reports.
						</p>
					)}
				</div>
			</section>
		</div>
	);
}
