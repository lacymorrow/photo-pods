"use client";

import { Aperture, Camera, CloudUpload, Timer, Trash2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { isPodMediaRouteUrl, podMediaLoader } from "@/lib/pods/media-url";
import { REACTIONS, type ReactionCounts } from "@/lib/pods/reactions";
import { deletePhoto, reactToMedia } from "@/server/actions/pods";
import { ReactionsTray } from "./reactions-tray";

interface ExifData {
  make?: string;
  model?: string;
  lens?: string;
  aperture?: number;
  shutterSpeed?: number;
  iso?: number;
  focalLength?: number;
  dateTaken?: string;
}

interface Photo {
  id: string;
  url: string | null;
  thumbnailUrl?: string | null;
  caption?: string | null;
  exifData?: ExifData | null;
  uploadedBy?: { name?: string | null; image?: string | null } | null;
  createdAt: Date;
  reactionCounts?: ReactionCounts;
  viewerReaction?: string | null;
  myReaction?: string | null;
}

interface PhotoGridProps {
  photos: Photo[];
  canDelete?: boolean;
  currentUserId?: string;
}

const formatShutterSpeed = (speed: number): string => {
  if (speed >= 1) return `${speed}s`;
  return `1/${Math.round(1 / speed)}`;
};

export const PhotoGrid = ({ photos, canDelete, currentUserId }: PhotoGridProps) => {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedPhoto = selectedIndex !== null ? photos[selectedIndex] : null;
  const exif = selectedPhoto?.exifData;

  const handleDelete = (photoId: string) => {
    startTransition(async () => {
      await deletePhoto(photoId);
      setSelectedIndex(null);
    });
  };

  const goPrev = useCallback(() => {
    setSelectedIndex((i) => (i !== null && i > 0 ? i - 1 : i));
  }, []);

  const goNext = useCallback(() => {
    setSelectedIndex((i) => (i !== null && i < photos.length - 1 ? i + 1 : i));
  }, [photos.length]);

  // Keyboard navigation
  useEffect(() => {
    if (selectedIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedIndex, goPrev, goNext]);

  if (photos.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="mb-4 rounded-full bg-muted p-6">
          <CloudUpload className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <h3 className="text-lg font-semibold">No photos yet</h3>
        <p className="mt-1 max-w-xs text-muted-foreground">
          Be the first to upload! Drag & drop photos into the upload area above.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="columns-2 gap-3 space-y-3 sm:columns-3 lg:columns-4">
        {photos.map((photo, index) => {
          const src = photo.thumbnailUrl ?? photo.url;
          if (!src) return null;
          const topReactions = photo.reactionCounts
            ? Object.entries(photo.reactionCounts)
                .filter(([, n]) => n > 0)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 2)
            : [];
          const totalReactions = topReactions.reduce((a, [, n]) => a + n, 0);
          return (
            <button
              key={photo.id}
              type="button"
              className="relative block w-full cursor-pointer break-inside-avoid overflow-hidden rounded-lg"
              onClick={() => setSelectedIndex(index)}
            >
              <Image
                src={src}
                alt={photo.caption ?? "Photo"}
                width={400}
                height={300}
                className="h-auto w-full object-cover transition-transform hover:scale-105"
                sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                // Media behind the pod ACL has to be fetched by the browser,
                // which carries the session cookie; the image optimizer does
                // not. The route resizes it instead. See podMediaLoader.
                loader={isPodMediaRouteUrl(src) ? podMediaLoader : undefined}
              />
              {totalReactions > 0 && (
                <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/45 px-2 py-0.5 text-[11px] text-white backdrop-blur-sm">
                  {topReactions.map(([slug]) => {
                    const r = REACTIONS.find((x) => x.slug === slug);
                    return (
                      <span key={slug} aria-hidden>
                        {r?.emoji ?? "•"}
                      </span>
                    );
                  })}
                  <span className="ml-0.5 tabular-nums">{totalReactions}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Lightbox */}
      <Dialog open={selectedIndex !== null} onOpenChange={() => setSelectedIndex(null)}>
        <DialogContent className="max-w-5xl overflow-hidden border-none bg-black/95 p-0">
          <DialogTitle className="sr-only">{selectedPhoto?.caption ?? "Photo viewer"}</DialogTitle>
          {selectedPhoto && (
            <div
              className="relative"
              onTouchStart={(e) => {
                const startX = e.touches[0]?.clientX ?? 0;
                const el = e.currentTarget;
                const handleEnd = (ev: TouchEvent) => {
                  const endX = ev.changedTouches[0]?.clientX ?? 0;
                  const diff = endX - startX;
                  if (Math.abs(diff) > 60) {
                    if (diff > 0) goPrev();
                    else goNext();
                  }
                  el.removeEventListener("touchend", handleEnd);
                };
                el.addEventListener("touchend", handleEnd);
              }}
            >
              <Image
                src={selectedPhoto.url ?? selectedPhoto.thumbnailUrl ?? ""}
                alt={selectedPhoto.caption ?? "Photo"}
                width={1200}
                height={800}
                className="h-auto max-h-[80vh] w-full object-contain"
                // The dialog is `max-w-5xl` (1024px), so without this the
                // loader is asked for a 1200/2048 pair picked off `width`
                // rather than the box it actually renders in.
                sizes="(max-width: 1024px) 100vw, 1024px"
                priority
                loader={
                  isPodMediaRouteUrl(selectedPhoto.url ?? selectedPhoto.thumbnailUrl)
                    ? podMediaLoader
                    : undefined
                }
              />
              <div className="absolute right-0 bottom-0 left-0 space-y-3 bg-gradient-to-t from-black/85 to-transparent p-4">
                <ReactionsTray
                  mediaId={selectedPhoto.id}
                  counts={selectedPhoto.reactionCounts ?? {}}
                  mine={selectedPhoto.viewerReaction ?? selectedPhoto.myReaction ?? null}
                  onReact={async (id, next) => {
                    await reactToMedia(id, next);
                  }}
                />
                <div className="flex items-end justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    {selectedPhoto.caption && (
                      <p className="text-sm text-white">{selectedPhoto.caption}</p>
                    )}
                    {selectedPhoto.uploadedBy?.name && (
                      <p className="mt-1 text-xs text-white/60">
                        by {selectedPhoto.uploadedBy.name}
                      </p>
                    )}

                    {/* EXIF info */}
                    {exif && (exif.model || exif.aperture || exif.shutterSpeed || exif.iso) && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {(exif.make || exif.model) && (
                          <Badge
                            variant="secondary"
                            className="gap-1 border-none bg-white/10 text-[10px] text-white/80"
                          >
                            <Camera className="h-3 w-3" />
                            {[exif.make, exif.model].filter(Boolean).join(" ")}
                          </Badge>
                        )}
                        {exif.aperture && (
                          <Badge
                            variant="secondary"
                            className="gap-1 border-none bg-white/10 text-[10px] text-white/80"
                          >
                            <Aperture className="h-3 w-3" />
                            f/{exif.aperture}
                          </Badge>
                        )}
                        {exif.shutterSpeed && (
                          <Badge
                            variant="secondary"
                            className="gap-1 border-none bg-white/10 text-[10px] text-white/80"
                          >
                            <Timer className="h-3 w-3" />
                            {formatShutterSpeed(exif.shutterSpeed)}
                          </Badge>
                        )}
                        {exif.iso && (
                          <Badge
                            variant="secondary"
                            className="border-none bg-white/10 text-[10px] text-white/80"
                          >
                            ISO {exif.iso}
                          </Badge>
                        )}
                        {exif.focalLength && (
                          <Badge
                            variant="secondary"
                            className="border-none bg-white/10 text-[10px] text-white/80"
                          >
                            {exif.focalLength}mm
                          </Badge>
                        )}
                        {exif.dateTaken && (
                          <Badge
                            variant="secondary"
                            className="border-none bg-white/10 text-[10px] text-white/60"
                          >
                            {new Date(exif.dateTaken).toLocaleDateString()}
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  {canDelete && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDelete(selectedPhoto.id)}
                      disabled={isPending}
                      className="shrink-0"
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      Delete
                    </Button>
                  )}
                </div>
              </div>

              {/* Prev/Next */}
              {selectedIndex !== null && selectedIndex > 0 && (
                <button
                  type="button"
                  className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/80 hover:text-white sm:p-3"
                  onClick={goPrev}
                >
                  &#8592;
                </button>
              )}
              {selectedIndex !== null && selectedIndex < photos.length - 1 && (
                <button
                  type="button"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white/80 hover:text-white sm:p-3"
                  onClick={goNext}
                >
                  &#8594;
                </button>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
