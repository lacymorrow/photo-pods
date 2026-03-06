"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { deletePod, getPod, updatePod } from "@/server/actions/pods";

export default function PodSettingsPage() {
	const params = useParams<{ podId: string }>();
	const router = useRouter();
	const [isPending, startTransition] = useTransition();
	const [pod, setPod] = useState<Awaited<ReturnType<typeof getPod>> | null>(null);
	const [confirmDelete, setConfirmDelete] = useState("");

	useEffect(() => {
		getPod(params.podId).then(setPod).catch(() => router.push("/pods"));
	}, [params.podId, router]);

	if (!pod) return null;

	const handleSave = (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const fd = new FormData(e.currentTarget);
		startTransition(async () => {
			await updatePod(params.podId, {
				name: fd.get("name") as string,
				description: (fd.get("description") as string) || undefined,
				visibility: fd.get("visibility") as "public" | "private" | "invite-only",
			});
			router.push(`/pods/${params.podId}`);
		});
	};

	const handleDelete = () => {
		startTransition(async () => {
			await deletePod(params.podId);
			router.push("/pods");
		});
	};

	return (
		<div className="container max-w-2xl py-8">
			<h1 className="text-3xl font-bold mb-8">Pod Settings</h1>

			<Card className="mb-6">
				<CardHeader>
					<CardTitle>General</CardTitle>
					<CardDescription>Update your pod details</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleSave} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="name">Name</Label>
							<Input id="name" name="name" defaultValue={pod.name} required />
						</div>
						<div className="space-y-2">
							<Label htmlFor="description">Description</Label>
							<Textarea
								id="description"
								name="description"
								defaultValue={pod.description ?? ""}
								rows={3}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="visibility">Visibility</Label>
							<Select name="visibility" defaultValue={pod.visibility}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="invite-only">Invite Only</SelectItem>
									<SelectItem value="private">Private</SelectItem>
									<SelectItem value="public">Public</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<Button type="submit" disabled={isPending}>
							{isPending ? (
								<Loader2 className="h-4 w-4 mr-1 animate-spin" />
							) : null}
							Save Changes
						</Button>
					</form>
				</CardContent>
			</Card>

			<Separator className="my-6" />

			<Card className="border-destructive">
				<CardHeader>
					<CardTitle className="text-destructive">Danger Zone</CardTitle>
					<CardDescription>
						Permanently delete this pod and all its photos.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2">
						<Label>Type the pod name to confirm: <strong>{pod.name}</strong></Label>
						<Input
							value={confirmDelete}
							onChange={(e) => setConfirmDelete(e.target.value)}
							placeholder={pod.name}
						/>
					</div>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={isPending || confirmDelete !== pod.name}
					>
						<Trash2 className="h-4 w-4 mr-1" />
						Delete Pod
					</Button>
				</CardContent>
			</Card>
		</div>
	);
}
