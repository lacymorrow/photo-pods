"use client";

import { Camera, ImagePlus, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PodCard } from "./pod-card";

interface PodGridProps {
	pods: Array<{
		id: string;
		name: string;
		description?: string | null;
		coverPhotoUrl?: string | null;
		visibility: string;
		memberCount: number;
		role: string;
		latestPhoto?: { url: string; thumbnailUrl?: string | null } | null;
	}>;
}

export const PodGrid = ({ pods }: PodGridProps) => {
	if (pods.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-24 text-center">
				<div className="relative mb-6">
					<div className="rounded-full bg-muted p-8">
						<Camera className="h-10 w-10 text-muted-foreground/60" />
					</div>
					{/* Decorative floating icons */}
					<div className="absolute -top-2 -right-3 rounded-full bg-primary/10 p-2 animate-pulse">
						<ImagePlus className="h-4 w-4 text-primary/60" />
					</div>
					<div className="absolute -bottom-1 -left-3 rounded-full bg-primary/10 p-2 animate-pulse [animation-delay:1s]">
						<Plus className="h-3 w-3 text-primary/60" />
					</div>
				</div>
				<h3 className="text-xl font-semibold">Create your first pod</h3>
				<p className="text-muted-foreground mt-2 mb-6 max-w-sm leading-relaxed">
					A pod is a shared photo album for your group. Create one for a
					trip, event, family, or anything you want to share.
				</p>
				<Button size="lg" asChild>
					<Link href="/pods/new">
						<Plus className="h-4 w-4 mr-2" />
						Create Pod
					</Link>
				</Button>
			</div>
		);
	}

	return (
		<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
			{pods.map((pod) => (
				<PodCard key={pod.id} pod={pod} />
			))}
		</div>
	);
};
