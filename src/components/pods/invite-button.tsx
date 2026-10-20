"use client";

import { UserPlus } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CircleInvite } from "./circle-invite";

interface InviteButtonProps {
  pod: {
    id: string;
    name: string;
    visibility: string;
  };
  contacts?: React.ComponentProps<typeof CircleInvite>["contacts"];
}

export const InviteButton = ({ pod, contacts }: InviteButtonProps) => {
  const params = useSearchParams();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // `?invite=1` deep-links straight into the invite dialog, and the dialog
    // stays user-closable afterwards, so the URL cannot simply be the source
    // of truth for `open`. Costs one extra render on mount when the parameter
    // is present. Reworking this into derived state is tracked separately.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (params?.get("invite") === "1") setOpen(true);
  }, [params]);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="mr-1.5 h-4 w-4" />
        Invite
      </Button>
      <CircleInvite open={open} onOpenChange={setOpen} pod={pod} contacts={contacts} />
    </>
  );
};
