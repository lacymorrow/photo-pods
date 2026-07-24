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
		if (params?.get("invite") === "1") setOpen(true);
	}, [params]);

	return (
		<>
			<Button variant="outline" size="sm" onClick={() => setOpen(true)}>
				<UserPlus className="h-4 w-4 mr-1.5" />
				Invite
			</Button>
			<CircleInvite
				open={open}
				onOpenChange={setOpen}
				pod={pod}
				contacts={contacts}
			/>
		</>
	);
};
