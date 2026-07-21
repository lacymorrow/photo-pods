"use client";

import { ArrowLeft, ArrowRight, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetDescription,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
	getPrivacyMeta,
	PRIVACY_LEVELS,
	type PodPrivacyKey,
} from "@/lib/pods/privacy";
import { createPod } from "@/server/actions/pods";

interface CreatePodSheetProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type Step = 0 | 1 | 2;

const NAME_PLACEHOLDERS = [
	"Bonnaroo 2026",
	"Family Reunion",
	"Street Photography",
	"Lake Trip",
	"Wildfire coverage",
];

export const CreatePodSheet = ({ open, onOpenChange }: CreatePodSheetProps) => {
	const router = useRouter();
	const [step, setStep] = useState<Step>(0);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [privacy, setPrivacy] = useState<PodPrivacyKey>("group");
	const [error, setError] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();
	const nameRef = useRef<HTMLInputElement>(null);
	const placeholder = useRef(
		NAME_PLACEHOLDERS[Math.floor(Math.random() * NAME_PLACEHOLDERS.length)],
	);

	useEffect(() => {
		if (open) {
			setStep(0);
			setError(null);
			setTimeout(() => nameRef.current?.focus(), 100);
		}
	}, [open]);

	const canContinueName = name.trim().length > 0 && name.length <= 60;

	const goNext = () => setStep((s) => (s < 2 ? ((s + 1) as Step) : s));
	const goBack = () => setStep((s) => (s > 0 ? ((s - 1) as Step) : s));

	const handleCreate = () => {
		setError(null);
		const dbValue = getPrivacyMeta(privacy).dbValue;
		startTransition(async () => {
			try {
				const pod = await createPod({
					name: name.trim(),
					description: description.trim() || undefined,
					visibility: dbValue,
				});
				onOpenChange(false);
				router.push(
					privacy === "group" ? `/pods/${pod.id}?invite=1` : `/pods/${pod.id}`,
				);
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "Failed to create pod. Try again.",
				);
			}
		});
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="bottom"
				className="rounded-t-2xl max-h-[92vh] flex flex-col p-0"
			>
				<div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-muted-foreground/20" />
				<StepDots step={step} />
				<div className="flex-1 overflow-y-auto px-6 pb-6">
					<SheetHeader className="text-left px-0 mt-2 mb-4">
						<SheetTitle className="text-xl">
							{step === 0 && "What's this pod about?"}
							{step === 1 && "Who can see this pod?"}
							{step === 2 && "Add a cover photo"}
						</SheetTitle>
						<SheetDescription>
							{step === 0 && "Give it a name so people know what they're joining."}
							{step === 1 && "You can change this later in pod settings."}
							{step === 2 && "You can always add or change this later."}
						</SheetDescription>
					</SheetHeader>

					{step === 0 && (
						<div className="space-y-5">
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label htmlFor="pod-name">Pod name</Label>
									<span className="text-xs text-muted-foreground">
										{name.length}/60
									</span>
								</div>
								<Input
									id="pod-name"
									ref={nameRef}
									value={name}
									onChange={(e) => setName(e.target.value.slice(0, 60))}
									placeholder={placeholder.current}
									maxLength={60}
								/>
							</div>
							<div className="space-y-2">
								<div className="flex items-center justify-between">
									<Label htmlFor="pod-desc">Description (optional)</Label>
									<span className="text-xs text-muted-foreground">
										{description.length}/200
									</span>
								</div>
								<Textarea
									id="pod-desc"
									value={description}
									onChange={(e) =>
										setDescription(e.target.value.slice(0, 200))
									}
									placeholder="What's this collection about?"
									rows={3}
								/>
							</div>
						</div>
					)}

					{step === 1 && (
						<div className="space-y-3">
							{PRIVACY_LEVELS.map((p) => {
								const Icon = p.icon;
								const selected = privacy === p.key;
								return (
									<button
										key={p.key}
										type="button"
										onClick={() => setPrivacy(p.key)}
										className={cn(
											"w-full text-left rounded-xl border p-4 flex items-start gap-3 transition-all",
											selected
												? `border-2 ${p.accentBorderClass} ${p.accentBgTintClass} scale-[1.01]`
												: "border-border bg-card hover:bg-accent/40",
										)}
									>
										<div
											className={cn(
												"shrink-0 h-10 w-10 rounded-full flex items-center justify-center transition-colors",
												selected
													? `${p.badgeClass}`
													: "bg-muted text-muted-foreground",
											)}
										>
											<Icon className="h-5 w-5" />
										</div>
										<div className="flex-1 min-w-0">
											<div className="flex items-center justify-between gap-2">
												<span className="font-semibold">{p.label}</span>
												<span
													className={cn(
														"h-4 w-4 rounded-full border-2 flex items-center justify-center transition-colors",
														selected
															? `${p.accentBorderClass}`
															: "border-muted-foreground/30",
													)}
												>
													{selected && (
														<span
															className={cn("h-2 w-2 rounded-full", p.accentClass)}
														/>
													)}
												</span>
											</div>
											<p className="text-sm text-muted-foreground mt-0.5">
												{p.description}
											</p>
											{selected && p.key === "group" && (
												<span
													aria-hidden
													className="mt-3 block h-1 w-24 rounded-full bg-[hsl(25_95%_55%)]/40 animate-pulse"
												/>
											)}
										</div>
									</button>
								);
							})}
						</div>
					)}

					{step === 2 && (
						<div className="space-y-4">
							<div className="w-full aspect-video rounded-xl border-2 border-dashed border-border flex flex-col items-center justify-center text-muted-foreground bg-muted/40">
								<span className="text-3xl" aria-hidden>📷</span>
								<span className="text-sm mt-2">Optional in MVP — skip to create</span>
							</div>
							<p className="text-xs text-muted-foreground">
								Cover uploads land in a follow-up. For now, we generate a color from your privacy accent.
							</p>
						</div>
					)}

					{error && (
						<p className="text-sm text-destructive mt-4">{error}</p>
					)}
				</div>

				<div className="flex items-center justify-between gap-2 border-t border-border p-4 bg-background/95 backdrop-blur">
					{step > 0 ? (
						<Button variant="ghost" onClick={goBack} disabled={isPending}>
							<ArrowLeft className="h-4 w-4 mr-1" />
							Back
						</Button>
					) : (
						<span />
					)}
					{step < 2 && (
						<Button
							onClick={goNext}
							disabled={step === 0 && !canContinueName}
						>
							Continue
							<ArrowRight className="h-4 w-4 ml-1" />
						</Button>
					)}
					{step === 2 && (
						<div className="flex items-center gap-2">
							<Button
								variant="ghost"
								onClick={handleCreate}
								disabled={isPending}
							>
								Skip
							</Button>
							<Button onClick={handleCreate} disabled={isPending}>
								{isPending ? (
									<>
										<Loader2 className="h-4 w-4 mr-1 animate-spin" />
										Creating…
									</>
								) : (
									"Create Pod"
								)}
							</Button>
						</div>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
};

const StepDots = ({ step }: { step: Step }) => (
	<div className="flex justify-center gap-1.5 mt-3">
		{[0, 1, 2].map((i) => (
			<span
				key={i}
				className={cn(
					"h-1.5 rounded-full transition-all",
					i === step ? "w-6 bg-foreground" : "w-1.5 bg-muted-foreground/30",
				)}
			/>
		))}
	</div>
);
