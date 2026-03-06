"use client";

import { ImageIcon, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface PodCardProps {
	pod: {
		id: string;
		name: string;
		description?: string | null;
		coverPhotoUrl?: string | null;
		visibility: string;
		memberCount: number;
		role: string;
		latestPhoto?: { url: string; thumbnailUrl?: string | null } | null;
	};
}

export const PodCard = ({ pod }: PodCardProps) => {
	const coverUrl = pod.coverPhotoUrl ?? pod.latestPhoto?.thumbnailUrl ?? pod.latestPhoto?.url;

	return (
		<Link href={`/pods/${pod.id}`}>
			<Card className="group overflow-hidden transition-all hover:shadow-lg hover:-translate-y-0.5">
				<div className="relative aspect-[4/3] bg-muted">
					{coverUrl ? (
						<Image
							src={coverUrl}
							alt={pod.name}
							fill
							className="object-cover transition-transform group-hover:scale-105"
							sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
						/>
					) : (
						<div className="flex h-full items-center justify-center">
							<ImageIcon className="h-12 w-12 text-muted-foreground/40" />
						</div>
					)}
					<div className="absolute top-2 right-2">
						<Badge variant="secondary" className="text-xs capitalize">
							{pod.role}
						</Badge>
					</div>
				</div>
				<CardContent className="p-4">
					<h3 className="font-semibold text-lg truncate">{pod.name}</h3>
					{pod.description && (
						<p className="text-sm text-muted-foreground line-clamp-2 mt-1">
							{pod.description}
						</p>
					)}
					<div className="flex items-center gap-3 mt-3 text-sm text-muted-foreground">
						<span className="flex items-center gap-1">
							<Users className="h-3.5 w-3.5" />
							{pod.memberCount}
						</span>
						<Badge variant="outline" className="text-xs capitalize">
							{pod.visibility}
						</Badge>
					</div>
				</CardContent>
			</Card>
		</Link>
	);
};
