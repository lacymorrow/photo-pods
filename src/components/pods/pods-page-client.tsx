"use client";

import { Compass, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CreatePodSheet } from "./create-pod-sheet";
import { PodGrid } from "./pod-grid";

interface PodsPageClientProps {
  pods: React.ComponentProps<typeof PodGrid>["pods"];
}

export const PodsPageClient = ({ pods }: PodsPageClientProps) => {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-4 sm:mb-8">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold sm:text-3xl">My Pods</h1>
          <p className="mt-1 text-sm text-muted-foreground sm:text-base">
            Your shared photo collections
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" asChild>
            <Link href="/pods/discover">
              <Compass className="mr-1 h-4 w-4" />
              <span className="hidden sm:inline">Discover</span>
            </Link>
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            <span className="hidden sm:inline">New Pod</span>
            <span className="sm:hidden">New</span>
          </Button>
        </div>
      </div>
      <PodGrid pods={pods} onCreate={() => setCreateOpen(true)} />
      <CreatePodSheet open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
};
