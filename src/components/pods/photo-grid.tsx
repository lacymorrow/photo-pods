"use client";

import { Trash2 } from "lucide-react";
import Image from "next/image";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from "@/components/ui/dialog";
import { deletePhoto } from "@/server/actions/pods";

interface Photo {
	id: string;
	url: string;
	thumbnailUrl?: string | null;
	caption?: string | null;
	uploadedBy?: { name?: string | null; image?: string | null } | null;
	createdAt: Date;
}

interface PhotoGridProps {
	photos: Photo[];
	canDelete?: boolean;
	currentUserId?: string;
}

export const PhotoGrid = ({ photos, canDelete, currentUserId }: PhotoGridProps) => {
	const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
	const [isPending, startTransition] = useTransition();

	const selectedPhoto = selectedIndex !== null ? photos[selectedIndex] : null;

	const handleDelete = (photoId: string) => {
		startTransition(async () => {
			await deletePhoto(photoId);
			setSelectedIndex(null);
		});
	};

	if (photos.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-16 text-center">
				<p className="text-muted-foreground">No photos yet. Be the first to upload!</p>
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
						<div className="relative">
							<Image
								src={selectedPhoto.url}
								alt={selectedPhoto.caption ?? "Photo"}
								width={1200}
								height={800}
								className="w-full h-auto max-h-[85vh] object-contain"
								priority
							/>
							<div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent p-4">
								<div className="flex items-end justify-between">
									<div>
										{selectedPhoto.caption && (
											<p className="text-white text-sm">{selectedPhoto.caption}</p>
										)}
										{selectedPhoto.uploadedBy?.name && (
											<p className="text-white/60 text-xs mt-1">
												by {selectedPhoto.uploadedBy.name}
											</p>
										)}
									</div>
									{canDelete && (
										<Button
											variant="destructive"
											size="sm"
											onClick={() => handleDelete(selectedPhoto.id)}
											disabled={isPending}
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
									className="absolute left-2 top-1/2 -translate-y-1/2 text-white/80 hover:text-white bg-black/40 rounded-full p-2"
									onClick={() => setSelectedIndex(selectedIndex - 1)}
								>
									&#8592;
								</button>
							)}
							{selectedIndex !== null && selectedIndex < photos.length - 1 && (
								<button
									type="button"
									className="absolute right-2 top-1/2 -translate-y-1/2 text-white/80 hover:text-white bg-black/40 rounded-full p-2"
									onClick={() => setSelectedIndex(selectedIndex + 1)}
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
