"use client";

import JSZip from "jszip";
import { Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { extensionFor } from "@/lib/pods/media-extension";

interface DownloadAllButtonProps {
  podName: string;
  photos: { url: string; caption?: string | null }[];
}

export const DownloadAllButton = ({ podName, photos }: DownloadAllButtonProps) => {
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  if (photos.length === 0) return null;

  const handleDownload = async () => {
    setIsDownloading(true);
    setProgress(0);

    try {
      const zip = new JSZip();
      const folder = zip.folder(podName) ?? zip;

      for (let i = 0; i < photos.length; i++) {
        const photo = photos[i];
        if (!photo) continue;
        try {
          const response = await fetch(photo.url);
          // The media route answers 401/403 when the pod ACL rejects the
          // viewer; zipping that JSON body as a photo would be worse than
          // skipping it.
          if (response.ok) {
            const blob = await response.blob();
            const ext = extensionFor(blob.type, photo.url);
            const name = photo.caption
              ? `${photo.caption.slice(0, 50).replace(/[^a-zA-Z0-9-_ ]/g, "")}.${ext}`
              : `photo-${String(i + 1).padStart(3, "0")}.${ext}`;
            folder.file(name, blob);
          }
        } catch {
          // Skip failed downloads
        }
        setProgress(Math.round(((i + 1) / photos.length) * 100));
      }

      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${podName.replace(/[^a-zA-Z0-9-_ ]/g, "")}-photos.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Download failed
    } finally {
      setIsDownloading(false);
      setProgress(0);
    }
  };

  return (
    <Button variant="outline" size="sm" onClick={handleDownload} disabled={isDownloading}>
      {isDownloading ? (
        <>
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          {progress}%
        </>
      ) : (
        <>
          <Download className="mr-1 h-4 w-4" />
          Download All
        </>
      )}
    </Button>
  );
};
