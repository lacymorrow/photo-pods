"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CreatePodSheet } from "./create-pod-sheet";
import { PodGrid } from "./pod-grid";

interface PodsPageClientProps {
	pods: React.ComponentProps<typeof PodGrid>["pods"];
}

export const PodsPageClient = ({ pods }: PodsPageClientProps) => {
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<>
			<div className="flex items-center justify-between gap-4 mb-6 sm:mb-8">
				<div className="min-w-0">
					<h1 className="text-2xl sm:text-3xl font-bold">My Pods</h1>
					<p className="text-muted-foreground mt-1 text-sm sm:text-base">
						Your shared photo collections
					</p>
				</div>
				<Button className="shrink-0" onClick={() => setCreateOpen(true)}>
					<Plus className="h-4 w-4 mr-1" />
					<span className="hidden sm:inline">New Pod</span>
					<span className="sm:hidden">New</span>
				</Button>
			</div>
			<PodGrid pods={pods} onCreate={() => setCreateOpen(true)} />
			<CreatePodSheet open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
};
