"use client";

import { Camera, CloudUpload, Loader2, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { acceptUploadBatch, MAX_UPLOAD_BATCH } from "@/lib/pods/limits";
import { uploadPhoto } from "@/server/actions/pods";

interface PhotoUploadProps {
	podId: string;
}

export const PhotoUpload = ({ podId }: PhotoUploadProps) => {
	const [isDragging, setIsDragging] = useState(false);
	const [previews, setPreviews] = useState<{ file: File; preview: string }[]>([]);
	const [batchNotice, setBatchNotice] = useState<string | null>(null);
	const [isPending, startTransition] = useTransition();
	const inputRef = useRef<HTMLInputElement>(null);
	const cameraRef = useRef<HTMLInputElement>(null);

	const handleFiles = useCallback(
		(files: FileList | File[]) => {
			const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
			// Spec caps a batch at 50 items (LAC-2854); overflow is dropped, not queued.
			const { accepted, rejectedCount } = acceptUploadBatch(previews.length, images);
			setBatchNotice(
				rejectedCount > 0
					? `You can upload up to ${MAX_UPLOAD_BATCH} photos at a time — ${rejectedCount} file${rejectedCount === 1 ? " was" : "s were"} not added.`
					: null,
			);
			if (accepted.length === 0) return;
			const newPreviews = accepted.map((file) => ({
				file,
				preview: URL.createObjectURL(file),
			}));
			setPreviews((prev) => [...prev, ...newPreviews]);
		},
		[previews.length],
	);

	const removePreview = (index: number) => {
		setPreviews((prev) => {
			const removed = prev[index];
			if (removed) URL.revokeObjectURL(removed.preview);
			return prev.filter((_, i) => i !== index);
		});
	};

	const handleUpload = () => {
		if (previews.length === 0) return;

		startTransition(async () => {
			for (const { file } of previews) {
				const formData = new FormData();
				formData.set("file", file);
				await uploadPhoto(podId, formData);
			}
			for (const p of previews) URL.revokeObjectURL(p.preview);
			setPreviews([]);
			setBatchNotice(null);
		});
	};

	return (
		<div className="space-y-4">
			{/* Drop zone */}
			{/* biome-ignore lint/a11y/useSemanticElements: a real <button> can't wrap the nested Browse/Camera buttons */}
			<div
				role="button"
				tabIndex={0}
				aria-label="Add photos"
				className={`relative border-2 border-dashed rounded-xl p-6 sm:p-8 text-center transition-colors cursor-pointer ${
					isDragging
						? "border-primary bg-primary/5"
						: "border-muted-foreground/25 hover:border-muted-foreground/50 active:border-primary/50 active:bg-primary/5"
				}`}
				onDragOver={(e) => {
					e.preventDefault();
					setIsDragging(true);
				}}
				onDragLeave={() => setIsDragging(false)}
				onDrop={(e) => {
					e.preventDefault();
					setIsDragging(false);
					handleFiles(e.dataTransfer.files);
				}}
				onClick={() => inputRef.current?.click()}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						inputRef.current?.click();
					}
				}}
			>
				<CloudUpload className="h-8 w-8 sm:h-10 sm:w-10 mx-auto text-muted-foreground/60 mb-2 sm:mb-3" />
				<p className="text-sm text-muted-foreground mb-3">
					<span className="hidden sm:inline">Drag & drop photos here, or </span>
					<span className="sm:hidden">Tap to add photos</span>
				</p>
				<div className="flex items-center justify-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={(e) => {
							e.stopPropagation();
							inputRef.current?.click();
						}}
					>
						Browse Files
					</Button>
					{/* Camera capture for mobile */}
					<Button
						variant="outline"
						size="sm"
						className="sm:hidden"
						onClick={(e) => {
							e.stopPropagation();
							cameraRef.current?.click();
						}}
					>
						<Camera className="h-4 w-4 mr-1" />
						Camera
					</Button>
				</div>
				<Input
					ref={inputRef}
					type="file"
					accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
					multiple
					className="hidden"
					onChange={(e) => e.target.files && handleFiles(e.target.files)}
				/>
				<Input
					ref={cameraRef}
					type="file"
					accept="image/*"
					capture="environment"
					className="hidden"
					onChange={(e) => e.target.files && handleFiles(e.target.files)}
				/>
			</div>

			{batchNotice && (
				<p role="alert" className="text-sm text-destructive">
					{batchNotice}
				</p>
			)}

			{/* Previews */}
			{previews.length > 0 && (
				<div className="space-y-3">
					<div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
						{previews.map((p, i) => (
							<div key={p.preview} className="relative aspect-square rounded-lg overflow-hidden group">
								<Image
									src={p.preview}
									alt={`Preview ${i + 1}`}
									fill
									className="object-cover"
								/>
								<button
									type="button"
									className="absolute top-1 right-1 bg-black/60 rounded-full p-1 sm:p-0.5 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
									onClick={() => removePreview(i)}
								>
									<X className="h-3.5 w-3.5 sm:h-3 sm:w-3 text-white" />
								</button>
							</div>
						))}
					</div>
					<div className="flex justify-end gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => {
								for (const p of previews) URL.revokeObjectURL(p.preview);
								setPreviews([]);
								setBatchNotice(null);
							}}
							disabled={isPending}
						>
							Clear
						</Button>
						<Button size="sm" onClick={handleUpload} disabled={isPending}>
							{isPending ? (
								<>
									<Loader2 className="h-4 w-4 mr-1 animate-spin" />
									Uploading...
								</>
							) : (
								`Upload ${previews.length} photo${previews.length > 1 ? "s" : ""}`
							)}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
};
