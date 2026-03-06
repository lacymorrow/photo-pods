"use client";

import { CloudUpload, Loader2, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { uploadPhoto } from "@/server/actions/pods";

interface PhotoUploadProps {
	podId: string;
}

export const PhotoUpload = ({ podId }: PhotoUploadProps) => {
	const [isDragging, setIsDragging] = useState(false);
	const [previews, setPreviews] = useState<{ file: File; preview: string }[]>([]);
	const [isPending, startTransition] = useTransition();
	const inputRef = useRef<HTMLInputElement>(null);

	const handleFiles = useCallback((files: FileList | File[]) => {
		const newPreviews = Array.from(files)
			.filter((f) => f.type.startsWith("image/"))
			.map((file) => ({
				file,
				preview: URL.createObjectURL(file),
			}));
		setPreviews((prev) => [...prev, ...newPreviews]);
	}, []);

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
			// Cleanup
			for (const p of previews) URL.revokeObjectURL(p.preview);
			setPreviews([]);
		});
	};

	return (
		<div className="space-y-4">
			{/* Drop zone */}
			<div
				className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
					isDragging
						? "border-primary bg-primary/5"
						: "border-muted-foreground/25 hover:border-muted-foreground/50"
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
			>
				<CloudUpload className="h-10 w-10 mx-auto text-muted-foreground/60 mb-3" />
				<p className="text-sm text-muted-foreground mb-2">
					Drag & drop photos here, or
				</p>
				<Button
					variant="outline"
					size="sm"
					onClick={() => inputRef.current?.click()}
				>
					Browse Files
				</Button>
				<Input
					ref={inputRef}
					type="file"
					accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
					multiple
					className="hidden"
					onChange={(e) => e.target.files && handleFiles(e.target.files)}
				/>
			</div>

			{/* Previews */}
			{previews.length > 0 && (
				<div className="space-y-3">
					<div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
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
									className="absolute top-1 right-1 bg-black/60 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
									onClick={() => removePreview(i)}
								>
									<X className="h-3 w-3 text-white" />
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
