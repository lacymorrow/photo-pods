"use client";

import { MoreHorizontal, Shield, Eye, Camera, UserMinus } from "lucide-react";
import { useTransition } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { removePodMember, updateMemberRole } from "@/server/actions/pods";

interface Member {
	userId: string;
	role: string;
	user: {
		id: string;
		name?: string | null;
		email?: string | null;
		image?: string | null;
	};
}

interface MemberListProps {
	podId: string;
	members: Member[];
	isOwner: boolean;
	currentUserId: string;
}

const roleIcons = {
	owner: Shield,
	contributor: Camera,
	viewer: Eye,
};

export const MemberList = ({
	podId,
	members,
	isOwner,
	currentUserId,
}: MemberListProps) => {
	const [isPending, startTransition] = useTransition();

	const handleRoleChange = (userId: string, role: "contributor" | "viewer") => {
		startTransition(() => updateMemberRole(podId, userId, role));
	};

	const handleRemove = (userId: string) => {
		startTransition(() => removePodMember(podId, userId));
	};

	return (
		<div className="space-y-2">
			{members.map((member) => {
				const RoleIcon = roleIcons[member.role as keyof typeof roleIcons] ?? Eye;
				const initials = (member.user.name ?? member.user.email ?? "?")
					.slice(0, 2)
					.toUpperCase();

				return (
					<div
						key={member.userId}
						className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/50"
					>
						<div className="flex items-center gap-3">
							<Avatar className="h-8 w-8">
								<AvatarImage src={member.user.image ?? undefined} />
								<AvatarFallback className="text-xs">{initials}</AvatarFallback>
							</Avatar>
							<div>
								<p className="text-sm font-medium">
									{member.user.name ?? member.user.email}
									{member.userId === currentUserId && (
										<span className="text-muted-foreground ml-1">(you)</span>
									)}
								</p>
							</div>
						</div>
						<div className="flex items-center gap-2">
							<Badge variant="outline" className="text-xs capitalize gap-1">
								<RoleIcon className="h-3 w-3" />
								{member.role}
							</Badge>
							{isOwner && member.role !== "owner" && member.userId !== currentUserId && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button variant="ghost" size="icon" className="h-7 w-7">
											<MoreHorizontal className="h-4 w-4" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem
											onClick={() => handleRoleChange(member.userId, "contributor")}
											disabled={isPending || member.role === "contributor"}
										>
											<Camera className="h-4 w-4 mr-2" />
											Make Contributor
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => handleRoleChange(member.userId, "viewer")}
											disabled={isPending || member.role === "viewer"}
										>
											<Eye className="h-4 w-4 mr-2" />
											Make Viewer
										</DropdownMenuItem>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											className="text-destructive"
											onClick={() => handleRemove(member.userId)}
											disabled={isPending}
										>
											<UserMinus className="h-4 w-4 mr-2" />
											Remove
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
};
