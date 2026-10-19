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
import { getPrivacyMeta, PRIVACY_LEVELS, type PodPrivacyKey } from "@/lib/pods/privacy";
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
  // Picked when the sheet opens rather than during render: Math.random() in
  // render makes the server and client disagree on the placeholder, and it
  // also gives a fresh suggestion each time the sheet is reopened.
  const [placeholder, setPlaceholder] = useState(NAME_PLACEHOLDERS[0]);

  useEffect(() => {
    if (open) {
      // Resets the form each time the sheet is opened. The alternative the
      // compiler wants here is remounting on a `key`, which would throw away
      // the sheet's open/close animation. Tracked separately.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setStep(0);
      setError(null);
      setPlaceholder(NAME_PLACEHOLDERS[Math.floor(Math.random() * NAME_PLACEHOLDERS.length)]);
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
        router.push(privacy === "group" ? `/pods/${pod.id}?invite=1` : `/pods/${pod.id}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create pod. Try again.");
      }
    });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="flex max-h-[92vh] flex-col rounded-t-2xl p-0">
        <div className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-muted-foreground/20" />
        <StepDots step={step} />
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <SheetHeader className="mt-2 mb-4 px-0 text-left">
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
                  <span className="text-xs text-muted-foreground">{name.length}/60</span>
                </div>
                <Input
                  id="pod-name"
                  ref={nameRef}
                  value={name}
                  onChange={(e) => setName(e.target.value.slice(0, 60))}
                  placeholder={placeholder}
                  maxLength={60}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="pod-desc">Description (optional)</Label>
                  <span className="text-xs text-muted-foreground">{description.length}/200</span>
                </div>
                <Textarea
                  id="pod-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value.slice(0, 200))}
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
                      "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-all",
                      selected
                        ? `border-2 ${p.accentBorderClass} ${p.accentBgTintClass} scale-[1.01]`
                        : "border-border bg-card hover:bg-accent/40"
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
                        selected ? `${p.badgeClass}` : "bg-muted text-muted-foreground"
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{p.label}</span>
                        <span
                          className={cn(
                            "flex h-4 w-4 items-center justify-center rounded-full border-2 transition-colors",
                            selected ? `${p.accentBorderClass}` : "border-muted-foreground/30"
                          )}
                        >
                          {selected && (
                            <span className={cn("h-2 w-2 rounded-full", p.accentClass)} />
                          )}
                        </span>
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">{p.description}</p>
                      {selected && p.key === "group" && (
                        <span
                          aria-hidden
                          className="mt-3 block h-1 w-24 animate-pulse rounded-full bg-[hsl(25_95%_55%)]/40"
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
              <div className="flex aspect-video w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/40 text-muted-foreground">
                <span className="text-3xl" aria-hidden>
                  📷
                </span>
                <span className="mt-2 text-sm">Optional in MVP — skip to create</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Cover uploads land in a follow-up. For now, we generate a color from your privacy
                accent.
              </p>
            </div>
          )}

          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border bg-background/95 p-4 backdrop-blur">
          {step > 0 ? (
            <Button variant="ghost" onClick={goBack} disabled={isPending}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back
            </Button>
          ) : (
            <span />
          )}
          {step < 2 && (
            <Button onClick={goNext} disabled={step === 0 && !canContinueName}>
              Continue
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          )}
          {step === 2 && (
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={handleCreate} disabled={isPending}>
                Skip
              </Button>
              <Button onClick={handleCreate} disabled={isPending}>
                {isPending ? (
                  <>
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
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
  <div className="mt-3 flex justify-center gap-1.5">
    {[0, 1, 2].map((i) => (
      <span
        key={i}
        className={cn(
          "h-1.5 rounded-full transition-all",
          i === step ? "w-6 bg-foreground" : "w-1.5 bg-muted-foreground/30"
        )}
      />
    ))}
  </div>
);
