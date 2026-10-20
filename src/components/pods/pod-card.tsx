"use client";

import { Camera } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import { Card } from "@/components/ui/card";
import { getPrivacyMeta } from "@/lib/pods/privacy";

interface PodCardProps {
  pod: {
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
  };
}

export const PodCard = ({ pod }: PodCardProps) => {
  const privacy = getPrivacyMeta(pod.visibility);
  const PrivacyIcon = privacy.icon;
  const coverUrl = pod.coverPhotoUrl ?? pod.latestPhoto?.thumbnailUrl ?? pod.latestPhoto?.url;
  const photoCount = pod.photoCount ?? 0;

  const recency = pod.updatedAt
    ? formatDistanceToNowStrict(new Date(pod.updatedAt), { addSuffix: false })
    : null;

  return (
    <Link
      href={`/pods/${pod.id}`}
      className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card className="group relative overflow-hidden pl-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg">
        {/* Privacy accent stripe */}
        <span aria-hidden className={`absolute top-0 bottom-0 left-0 w-1 ${privacy.accentClass}`} />
        <div className="relative aspect-[4/3] overflow-hidden rounded-t-md bg-muted">
          {coverUrl ? (
            <Image
              src={coverUrl}
              alt={pod.name}
              fill
              className="object-cover transition-transform duration-300 group-hover:scale-105"
              sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            />
          ) : (
            <div className={`flex h-full items-center justify-center ${privacy.accentBgTintClass}`}>
              <PrivacyIcon className={`h-12 w-12 ${privacy.accentTextClass}`} />
            </div>
          )}
          {/* Privacy icon badge, top-right */}
          <div
            className={`absolute top-2 right-2 flex h-8 w-8 items-center justify-center rounded-full ${privacy.badgeClass} shadow-md`}
            title={privacy.label}
          >
            <PrivacyIcon className="h-4 w-4" />
          </div>
        </div>
        <div className="p-4">
          <h3 className="truncate text-base font-semibold">{pod.name}</h3>
          {pod.description && (
            <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground">{pod.description}</p>
          )}
          <div className="mt-2.5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <span aria-hidden>👤</span>
              {pod.memberCount}
            </span>
            <span className="flex items-center gap-1">
              <Camera className="h-3 w-3" />
              {photoCount}
            </span>
            {recency && <span>{recency} ago</span>}
          </div>
        </div>
      </Card>
    </Link>
  );
};
