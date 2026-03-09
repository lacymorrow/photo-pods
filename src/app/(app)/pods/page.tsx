import { Camera, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PodGrid } from "@/components/pods/pod-grid";
import { getUserPods } from "@/server/actions/pods";
import { auth } from "@/server/auth";

export const dynamic = "force-dynamic";

export const metadata = {
	title: "My Pods",
	description: "Your shared photo collections",
};

export default async function PodsPage() {
	const session = await auth();
	const isAuthenticated = !!session?.user?.id;

	let pods: Awaited<ReturnType<typeof getUserPods>> = [];
	if (isAuthenticated) {
		try {
			pods = await getUserPods();
		} catch {
			// Error fetching pods — will show empty state
		}
	}

	// Not authenticated — show sign-in CTA
	if (!isAuthenticated) {
		return (
			<div className="container max-w-6xl py-8">
				<div className="flex flex-col items-center justify-center py-24 text-center">
					<div className="relative mb-6">
						<div className="rounded-full bg-primary/10 p-8">
							<Camera className="h-12 w-12 text-primary" />
						</div>
						<div className="absolute -bottom-1 -right-1 rounded-full bg-background border-2 border-primary/20 p-2">
							<Plus className="h-4 w-4 text-primary" />
						</div>
					</div>
					<h1 className="text-3xl font-bold">Welcome to Photo Pods</h1>
					<p className="text-muted-foreground mt-3 max-w-md leading-relaxed">
						Create private photo groups, invite your friends, and share
						moments together. Sign in to get started.
					</p>
					<div className="flex gap-3 mt-8">
						<Button size="lg" asChild>
							<Link href="/auth/sign-in">Sign In</Link>
						</Button>
						<Button size="lg" variant="outline" asChild>
							<Link href="/">Learn More</Link>
						</Button>
					</div>
				</div>
			</div>
		);
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
