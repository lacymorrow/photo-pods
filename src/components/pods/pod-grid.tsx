"use client";

import { Camera, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getPrivacyMeta, PRIVACY_LEVELS, type PodPrivacyKey } from "@/lib/pods/privacy";
import { PodCard } from "./pod-card";

type FilterValue = "all" | PodPrivacyKey;

interface PodGridProps {
  pods: {
    id: string;
    name: string;
    description?: string | null;
    coverPhotoUrl?: string | null;
    visibility: string;
    memberCount: number;
    role: string;
    photoCount?: number;
    updatedAt?: Date | string | null;
    latestPhoto?: { url?: string | null; thumbnailUrl?: string | null } | null;
  }[];
  onCreate?: () => void;
}

export const PodGrid = ({ pods, onCreate }: PodGridProps) => {
  const [filter, setFilter] = useState<FilterValue>("all");

  const filteredPods = useMemo(() => {
    if (filter === "all") return pods;
    return pods.filter((p) => getPrivacyMeta(p.visibility).key === filter);
  }, [pods, filter]);

  if (pods.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <div className="mb-6 rounded-full bg-primary/10 p-8">
          <Camera className="h-10 w-10 text-primary" />
        </div>
        <h3 className="text-xl font-semibold">Create your first pod</h3>
        <p className="mt-2 mb-6 max-w-sm leading-relaxed text-muted-foreground">
          A pod is a shared photo album for a trip, event, or open topic. Invite friends or open it
          to the world.
        </p>
        <Button size="lg" onClick={onCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          Create Pod
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <FilterPills value={filter} onChange={setFilter} />
      {filteredPods.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">No {filter} pods yet.</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
          {filteredPods.map((pod) => (
            <PodCard key={pod.id} pod={pod} />
          ))}
        </div>
      )}
    </div>
  );
};

const FilterPills = ({
  value,
  onChange,
}: {
  value: FilterValue;
  onChange: (next: FilterValue) => void;
}) => {
  return (
    <div className="-mx-1 flex scrollbar-none items-center gap-2 overflow-x-auto px-1 pb-1">
      <Pill active={value === "all"} onClick={() => onChange("all")}>
        All
      </Pill>
      {PRIVACY_LEVELS.map((p) => {
        const Icon = p.icon;
        const isActive = value === p.key;
        return (
          <Pill
            key={p.key}
            active={isActive}
            activeClass={p.badgeClass}
            onClick={() => onChange(p.key)}
          >
            <Icon className="h-3.5 w-3.5" />
            {p.shortLabel}
          </Pill>
        );
      })}
    </div>
  );
};

const Pill = ({
  active,
  activeClass,
  onClick,
  children,
}: {
  active: boolean;
  activeClass?: string;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
      active
        ? (activeClass ?? "border-transparent bg-primary text-primary-foreground")
        : "border-transparent bg-muted text-muted-foreground hover:bg-muted/70"
    )}
  >
    {children}
  </button>
);
