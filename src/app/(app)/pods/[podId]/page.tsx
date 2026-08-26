import { Settings, Users } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DownloadAllButton } from "@/components/pods/download-all-button";
import { InviteButton } from "@/components/pods/invite-button";
import { InviteLink } from "@/components/pods/invite-link";
import { MemberList } from "@/components/pods/member-list";
import { PhotoGrid } from "@/components/pods/photo-grid";
import { PhotoUpload } from "@/components/pods/photo-upload";
import { getPrivacyMeta } from "@/lib/pods/privacy";
import { getPod, getPodPhotos } from "@/server/actions/pods";
import { auth } from "@/server/auth";

interface Props {
	params: Promise<{ podId: string }>;
}

export default async function PodDetailPage({ params }: Props) {
	const { podId } = await params;
	// Public pods are world-viewable per the privacy matrix (pod-policy.ts):
	// anonymous guests may view. Do NOT gate the page on a session here — that
	// would make public pods unreachable from discovery for logged-out browsers
	// (LAC-3456). getPod/getPodPhotos route through policy.canView and throw
	// "Access denied" for private/group pods, which we map to notFound() below.
	const session = await auth();
	const userId = session?.user?.id ?? null;

	let pod: Awaited<ReturnType<typeof getPod>>;
	try {
		pod = await getPod(podId);
	} catch {
		notFound();
	}

	const { photos } = await getPodPhotos(podId);
	const isOwner = pod.viewer.isOwner;
	const canUpload = pod.viewer.canUpload;

	const privacy = getPrivacyMeta(pod.visibility);
	const PrivacyIcon = privacy.icon;
	const canInvite = pod.viewer.canInvite;
	const contacts = pod.members
		.filter((m) => m.userId !== userId)
		.map((m) => ({
			id: m.userId,
			name: m.user?.name ?? "Member",
			username: m.user?.name?.split(" ")[0]?.toLowerCase() ?? null,
			image: m.user?.image ?? null,
		}));

	return (
		<div className="container max-w-6xl px-4 sm:px-6 py-6 sm:py-8">
			{/* Header */}
			<div className="flex flex-col gap-4 mb-6">
				<div className="min-w-0">
					<div className="flex items-center gap-2 sm:gap-3 flex-wrap">
						<h1 className="text-2xl sm:text-3xl font-bold truncate">{pod.name}</h1>
						<Badge className={`shrink-0 gap-1 ${privacy.badgeClass}`}>
							<PrivacyIcon className="h-3 w-3" />
							{privacy.label}
						</Badge>
					</div>
					{pod.description && (
						<p className="text-muted-foreground mt-1 text-sm sm:text-base">{pod.description}</p>
					)}
					<div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
						<span>{pod.photoCount} photos</span>
						<span className="flex items-center gap-1">
							<Users className="h-3.5 w-3.5" />
							{pod.memberCount} members
						</span>
					</div>
				</div>
				<div className="flex items-center gap-2 flex-wrap">
					{canInvite && (
						<InviteButton
							pod={{ id: pod.id, name: pod.name, visibility: pod.visibility }}
							contacts={contacts}
						/>
					)}
					<DownloadAllButton
						podName={pod.name}
						photos={photos
							.filter((p): p is typeof p & { url: string } => Boolean(p.url))
							.map((p) => ({ url: p.url, caption: p.caption }))}
					/>
					{isOwner && (
						<Button variant="outline" size="sm" asChild>
							<Link href={`/pods/${podId}/settings`}>
								<Settings className="h-4 w-4 mr-1" />
								Settings
							</Link>
						</Button>
					)}
				</div>
			</div>

			{/* Upload zone */}
			{canUpload && (
				<>
					<PhotoUpload podId={podId} />
					<Separator className="my-5 sm:my-6" />
				</>
			)}

			{/* Photo grid */}
			<PhotoGrid
				photos={photos}
				canDelete={isOwner}
				currentUserId={userId ?? undefined}
			/>

			{/* Members + Invite */}
			<Separator className="my-6 sm:my-8" />
			<div className="grid grid-cols-1 md:grid-cols-2 gap-6 sm:gap-8">
				<div>
					<h2 className="text-lg font-semibold mb-3">Members</h2>
					<MemberList
						podId={podId}
						members={pod.members}
						isOwner={isOwner}
						currentUserId={userId ?? undefined}
					/>
				</div>
				{canInvite && (
					<div>
						<h2 className="text-lg font-semibold mb-3">Invite People</h2>
						<InviteLink podId={podId} />
					</div>
				)}
			</div>
		</div>
	);
}
