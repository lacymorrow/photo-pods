import { Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PodGrid } from "@/components/pods/pod-grid";
import { getUserPods } from "@/server/actions/pods";

export const dynamic = "force-dynamic";

export const metadata = {
	title: "My Pods",
	description: "Your shared photo collections",
};

export default async function PodsPage() {
	let pods: Awaited<ReturnType<typeof getUserPods>> = [];
	try {
		pods = await getUserPods();
	} catch {
		// Not authenticated — will show empty state
	}

	return (
		<div className="container max-w-6xl py-8">
			<div className="flex items-center justify-between mb-8">
				<div>
					<h1 className="text-3xl font-bold">My Pods</h1>
					<p className="text-muted-foreground mt-1">
						Your shared photo collections
					</p>
				</div>
				<Button asChild>
					<Link href="/pods/new">
						<Plus className="h-4 w-4 mr-1" />
						New Pod
					</Link>
				</Button>
			</div>
			<PodGrid pods={pods} />
		</div>
	);
}
