"use client";

import { Plus } from "lucide-react";
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
			<div className="flex flex-col items-center justify-center py-20 text-center">
				<div className="rounded-full bg-muted p-6 mb-4">
					<Plus className="h-8 w-8 text-muted-foreground" />
				</div>
				<h3 className="text-lg font-semibold">No pods yet</h3>
				<p className="text-muted-foreground mt-1 mb-4">
					Create your first pod to start sharing photos.
				</p>
				<Button asChild>
					<Link href="/pods/new">Create Pod</Link>
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
