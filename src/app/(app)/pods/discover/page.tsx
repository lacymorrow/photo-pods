import { ArrowLeft, ChevronDown, Compass, Search } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DiscoverPodCard } from "@/components/pods/discover-pod-card";
import { listPublicPods, searchPublicPods } from "@/server/actions/pods";

export const metadata = {
	title: "Discover Pods",
	description: "Browse and search public photo pods",
};

interface DiscoverPageProps {
	searchParams: Promise<{ q?: string; cursor?: string }>;
}

export default async function DiscoverPodsPage({
	searchParams,
}: DiscoverPageProps) {
	const params = await searchParams;
	const query = typeof params.q === "string" ? params.q.trim() : "";
	const cursor =
		typeof params.cursor === "string" && params.cursor
			? params.cursor
			: undefined;

	let pods: Awaited<ReturnType<typeof listPublicPods>>["pods"] = [];
	let nextCursor: string | null = null;
	let loadFailed = false;
	try {
		if (query) {
			({ pods } = await searchPublicPods(query));
		} else {
			const result = await listPublicPods({ cursor });
			pods = result.pods;
			nextCursor = result.nextCursor ?? null;
		}
	} catch {
		loadFailed = true;
	}

	const emptyState = loadFailed
		? {
				title: "Something went wrong",
				body: "We couldn't load public pods right now. Please try again in a moment.",
			}
		: query
			? {
					title: `No pods match "${query}"`,
					body: "Try a different search, or browse all public pods.",
				}
			: {
					title: "No public pods yet",
					body: "When someone makes a pod public, it will show up here. Create one and be the first!",
				};

	return (
		<div className="container max-w-6xl px-4 sm:px-6 py-6 sm:py-8">
			<div className="flex items-center justify-between gap-4 mb-6">
				<div className="min-w-0">
					<h1 className="text-2xl sm:text-3xl font-bold">Discover Pods</h1>
					<p className="text-muted-foreground mt-1 text-sm sm:text-base">
						Browse public photo collections from the community
					</p>
				</div>
				<Button variant="outline" className="shrink-0" asChild>
					<Link href="/pods">
						<ArrowLeft className="h-4 w-4 mr-1" />
						<span className="hidden sm:inline">My Pods</span>
						<span className="sm:hidden">Pods</span>
					</Link>
				</Button>
			</div>

			{/* Plain GET form so search works without client JS */}
			<search>
				<form
					action="/pods/discover"
					method="get"
					className="flex gap-2 mb-6 sm:mb-8 max-w-xl"
				>
					<div className="relative flex-1">
						<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
						<Input
							type="search"
							name="q"
							defaultValue={query}
							placeholder="Search public pods…"
							aria-label="Search public pods"
							className="pl-9"
						/>
					</div>
					<Button type="submit">Search</Button>
					{query && (
						<Button variant="ghost" asChild>
							<Link href="/pods/discover">Clear</Link>
						</Button>
					)}
				</form>
			</search>

			{loadFailed || pods.length === 0 ? (
				<EmptyState title={emptyState.title} body={emptyState.body} />
			) : (
				<>
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
						{pods.map((pod) => (
							<DiscoverPodCard key={pod.id} pod={pod} />
						))}
					</div>
					{!query && (cursor || nextCursor) && (
						<div className="flex justify-center gap-3 mt-8">
							{cursor && (
								<Button variant="ghost" asChild>
									<Link href="/pods/discover">Back to newest</Link>
								</Button>
							)}
							{nextCursor && (
								<Button variant="outline" asChild>
									<Link
										href={`/pods/discover?cursor=${encodeURIComponent(nextCursor)}`}
									>
										<ChevronDown className="h-4 w-4 mr-1" />
										Show older pods
									</Link>
								</Button>
							)}
						</div>
					)}
				</>
			)}
		</div>
	);
}

const EmptyState = ({ title, body }: { title: string; body: string }) => (
	<div className="flex flex-col items-center justify-center py-20 text-center">
		<div className="rounded-full bg-primary/10 p-6 mb-5">
			<Compass className="h-10 w-10 text-primary" />
		</div>
		<h2 className="text-xl font-semibold">{title}</h2>
		<p className="text-muted-foreground mt-2 max-w-md leading-relaxed">{body}</p>
	</div>
);
