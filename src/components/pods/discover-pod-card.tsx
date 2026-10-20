import { Camera, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { getPrivacyMeta } from "@/lib/pods/privacy";

interface DiscoverPodCardProps {
  pod: {
    id: string;
    name: string;
    description?: string | null;
    coverPhotoUrl?: string | null;
    mediaCount?: number | null;
    followerCount?: number | null;
  };
}

/**
 * Card for the public discovery grid. Unlike PodCard, discovery rows carry
 * follower/media counts instead of member/role data, so this is a separate
 * server-renderable component.
 */
export const DiscoverPodCard = ({ pod }: DiscoverPodCardProps) => {
  const privacy = getPrivacyMeta("public");
  const PrivacyIcon = privacy.icon;

  return (
    <Link
      href={`/pods/${pod.id}`}
      className="block rounded-xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <Card className="group relative overflow-hidden pl-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg">
        {/* Privacy accent stripe */}
        <span aria-hidden className={`absolute top-0 bottom-0 left-0 w-1 ${privacy.accentClass}`} />
        <div className="relative aspect-[4/3] overflow-hidden rounded-t-md bg-muted">
          {pod.coverPhotoUrl ? (
            <Image
              src={pod.coverPhotoUrl}
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
              <Users className="h-3 w-3" />
              {pod.followerCount ?? 0} followers
            </span>
            <span className="flex items-center gap-1">
              <Camera className="h-3 w-3" />
              {pod.mediaCount ?? 0}
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
};
