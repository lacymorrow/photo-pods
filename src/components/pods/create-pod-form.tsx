"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createPod } from "@/server/actions/pods";

export const CreatePodForm = () => {
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [error, setError] = useState<string | null>(null);

	const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		setError(null);
		const formData = new FormData(e.currentTarget);

		startTransition(async () => {
			try {
				const pod = await createPod({
					name: formData.get("name") as string,
					description: (formData.get("description") as string) || undefined,
					visibility: (formData.get("visibility") as "public" | "private" | "invite-only") ?? "invite-only",
				});
				router.push(`/pods/${pod.id}`);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to create pod. Please try again.");
			}
		});
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-6 max-w-lg">
			<div className="space-y-2">
				<Label htmlFor="name">Pod Name</Label>
				<Input
					id="name"
					name="name"
					placeholder="Bonnaroo 2026"
					required
					maxLength={255}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="description">Description</Label>
				<Textarea
					id="description"
					name="description"
					placeholder="Photos from our trip..."
					rows={3}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="visibility">Visibility</Label>
				<Select name="visibility" defaultValue="invite-only">
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="invite-only">Invite Only</SelectItem>
						<SelectItem value="private">Private</SelectItem>
						<SelectItem value="public">Public</SelectItem>
					</SelectContent>
				</Select>
				<p className="text-xs text-muted-foreground">
					Invite-only: only people with an invite link can join. Private: visible to members only. Public: anyone can view.
				</p>
			</div>

			{error && (
				<p className="text-sm text-destructive">{error}</p>
			)}

			<Button type="submit" disabled={isPending}>
				{isPending ? (
					<>
						<Loader2 className="h-4 w-4 mr-1 animate-spin" />
						Creating...
					</>
				) : (
					"Create Pod"
				)}
			</Button>
		</form>
	);
};
