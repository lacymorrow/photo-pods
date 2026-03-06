import { CheckCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { acceptInvite } from "@/server/actions/pods";
import { auth } from "@/server/auth";

interface Props {
	params: Promise<{ token: string }>;
}

export default async function InviteAcceptPage({ params }: Props) {
	const { token } = await params;
	const session = await auth();

	if (!session?.user?.id) {
		// Redirect to login with return URL
		redirect(`/login?callbackUrl=/pods/invite/${token}`);
	}

	let result: Awaited<ReturnType<typeof acceptInvite>>;
	let error: string | null = null;

	try {
		result = await acceptInvite(token);
	} catch (e) {
		error = e instanceof Error ? e.message : "Failed to accept invite";
		return (
			<div className="container max-w-md py-20">
				<Card>
					<CardHeader className="text-center">
						<XCircle className="h-12 w-12 text-destructive mx-auto mb-2" />
						<CardTitle>Invite Error</CardTitle>
					</CardHeader>
					<CardContent className="text-center space-y-4">
						<p className="text-muted-foreground">{error}</p>
						<Button asChild>
							<Link href="/pods">Go to My Pods</Link>
						</Button>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="container max-w-md py-20">
			<Card>
				<CardHeader className="text-center">
					<CheckCircle className="h-12 w-12 text-green-500 mx-auto mb-2" />
					<CardTitle>
						{result.alreadyMember ? "Already a member!" : "You're in!"}
					</CardTitle>
				</CardHeader>
				<CardContent className="text-center space-y-4">
					<p className="text-muted-foreground">
						{result.alreadyMember
							? `You're already a member of "${result.pod.name}".`
							: `You've joined "${result.pod.name}".`}
					</p>
					<Button asChild>
						<Link href={`/pods/${result.pod.id}`}>Open Pod</Link>
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}
