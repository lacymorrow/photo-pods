"use client";

import { Aperture, Camera, CloudUpload, Timer, Trash2 } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import { deletePhoto } from "@/server/actions/pods";

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
	url: string;
	thumbnailUrl?: string | null;
	caption?: string | null;
	exifData?: ExifData | null;
	uploadedBy?: { name?: string | null; image?: string | null } | null;
	createdAt: Date;
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
	const exif = selectedPhoto?.exifData as ExifData | null | undefined;

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
				<div className="rounded-full bg-muted p-6 mb-4">
					<CloudUpload className="h-8 w-8 text-muted-foreground/50" />
				</div>
				<h3 className="font-semibold text-lg">No photos yet</h3>
				<p className="text-muted-foreground mt-1 max-w-xs">
					Be the first to upload! Drag & drop photos into the upload area above.
				</p>
			</div>
		);
	}

	return (
		<>
			<div className="columns-2 sm:columns-3 lg:columns-4 gap-3 space-y-3">
				{photos.map((photo, index) => (
					<button
						key={photo.id}
						type="button"
						className="block w-full overflow-hidden rounded-lg cursor-pointer break-inside-avoid"
						onClick={() => setSelectedIndex(index)}
					>
						<Image
							src={photo.thumbnailUrl ?? photo.url}
							alt={photo.caption ?? "Photo"}
							width={400}
							height={300}
							className="w-full h-auto object-cover transition-transform hover:scale-105"
							sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
						/>
					</button>
				))}
			</div>

			{/* Lightbox */}
			<Dialog open={selectedIndex !== null} onOpenChange={() => setSelectedIndex(null)}>
				<DialogContent className="max-w-5xl p-0 overflow-hidden bg-black/95 border-none">
					<DialogTitle className="sr-only">
						{selectedPhoto?.caption ?? "Photo viewer"}
					</DialogTitle>
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
								src={selectedPhoto.url}
								alt={selectedPhoto.caption ?? "Photo"}
								width={1200}
								height={800}
								className="w-full h-auto max-h-[80vh] object-contain"
								priority
							/>
							<div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
								<div className="flex items-end justify-between gap-4">
									<div className="min-w-0 flex-1">
										{selectedPhoto.caption && (
											<p className="text-white text-sm">{selectedPhoto.caption}</p>
										)}
										{selectedPhoto.uploadedBy?.name && (
											<p className="text-white/60 text-xs mt-1">
												by {selectedPhoto.uploadedBy.name}
											</p>
										)}

										{/* EXIF info */}
										{exif && (exif.model || exif.aperture || exif.shutterSpeed || exif.iso) && (
											<div className="flex flex-wrap items-center gap-1.5 mt-2">
												{(exif.make || exif.model) && (
													<Badge variant="secondary" className="text-[10px] bg-white/10 text-white/80 border-none gap-1">
														<Camera className="h-3 w-3" />
														{[exif.make, exif.model].filter(Boolean).join(" ")}
													</Badge>
												)}
												{exif.aperture && (
													<Badge variant="secondary" className="text-[10px] bg-white/10 text-white/80 border-none gap-1">
														<Aperture className="h-3 w-3" />
														f/{exif.aperture}
													</Badge>
												)}
												{exif.shutterSpeed && (
													<Badge variant="secondary" className="text-[10px] bg-white/10 text-white/80 border-none gap-1">
														<Timer className="h-3 w-3" />
														{formatShutterSpeed(exif.shutterSpeed)}
													</Badge>
												)}
												{exif.iso && (
													<Badge variant="secondary" className="text-[10px] bg-white/10 text-white/80 border-none">
														ISO {exif.iso}
													</Badge>
												)}
												{exif.focalLength && (
													<Badge variant="secondary" className="text-[10px] bg-white/10 text-white/80 border-none">
														{exif.focalLength}mm
													</Badge>
												)}
												{exif.dateTaken && (
													<Badge variant="secondary" className="text-[10px] bg-white/10 text-white/60 border-none">
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
											<Trash2 className="h-4 w-4 mr-1" />
											Delete
										</Button>
									)}
								</div>
							</div>

							{/* Prev/Next */}
							{selectedIndex !== null && selectedIndex > 0 && (
								<button
									type="button"
									className="absolute left-2 top-1/2 -translate-y-1/2 text-white/80 hover:text-white bg-black/40 rounded-full p-2 sm:p-3"
									onClick={goPrev}
								>
									&#8592;
								</button>
							)}
							{selectedIndex !== null && selectedIndex < photos.length - 1 && (
								<button
									type="button"
									className="absolute right-2 top-1/2 -translate-y-1/2 text-white/80 hover:text-white bg-black/40 rounded-full p-2 sm:p-3"
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
