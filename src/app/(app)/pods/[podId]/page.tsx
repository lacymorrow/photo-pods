import { Settings, Users } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { DownloadAllButton } from "@/components/pods/download-all-button";
import { InviteLink } from "@/components/pods/invite-link";
import { MemberList } from "@/components/pods/member-list";
import { PhotoGrid } from "@/components/pods/photo-grid";
import { PhotoUpload } from "@/components/pods/photo-upload";
import { getPod, getPodPhotos } from "@/server/actions/pods";
import { auth } from "@/server/auth";

interface Props {
	params: Promise<{ podId: string }>;
}

export default async function PodDetailPage({ params }: Props) {
	const { podId } = await params;
	const session = await auth();
	if (!session?.user?.id) notFound();

	let pod: Awaited<ReturnType<typeof getPod>>;
	try {
		pod = await getPod(podId);
	} catch {
		notFound();
	}

	const { photos } = await getPodPhotos(podId);
	const currentMember = pod.members.find((m) => m.userId === session.user.id);
	const isOwner = currentMember?.role === "owner";
	const canUpload = isOwner || currentMember?.role === "contributor";

	return (
		<div className="container max-w-6xl px-4 sm:px-6 py-6 sm:py-8">
			{/* Header */}
			<div className="flex flex-col gap-4 mb-6">
				<div className="min-w-0">
					<div className="flex items-center gap-2 sm:gap-3 flex-wrap">
						<h1 className="text-2xl sm:text-3xl font-bold truncate">{pod.name}</h1>
						<Badge variant="outline" className="capitalize shrink-0">
							{pod.visibility}
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
				<div className="flex items-center gap-2">
					<DownloadAllButton
						podName={pod.name}
						photos={photos.map((p) => ({ url: p.url, caption: p.caption }))}
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
				currentUserId={session.user.id}
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
						currentUserId={session.user.id}
					/>
				</div>
				{(isOwner || currentMember?.role === "contributor") && (
					<div>
						<h2 className="text-lg font-semibold mb-3">Invite People</h2>
						<InviteLink podId={podId} />
					</div>
				)}
			</div>
		</div>
	);
}
