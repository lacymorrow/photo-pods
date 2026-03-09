import { Camera, ImagePlus, Link2, Lock, Share2, Users } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const metadata = {
	title: "Photo Pods — Share photos with your people",
	description:
		"Create private photo groups, invite your friends, and share moments together. Drag-and-drop uploads, role-based access, and instant invite links.",
};

const features = [
	{
		icon: Lock,
		title: "Private Groups",
		description:
			"Create invite-only pods for your family, friends, or events. You control who sees what.",
	},
	{
		icon: ImagePlus,
		title: "Drag & Drop Upload",
		description:
			"Upload photos instantly by dragging them into your pod. Supports JPEG, PNG, WebP, and HEIC.",
	},
	{
		icon: Link2,
		title: "Instant Invite Links",
		description:
			"Generate shareable invite links or QR codes. Anyone with the link can join your pod.",
	},
	{
		icon: Users,
		title: "Role-Based Access",
		description:
			"Set members as viewers or contributors. Owners have full control over their pod.",
	},
];

export default function LandingPage() {
	return (
		<div className="min-h-screen">
			{/* Hero */}
			<section className="relative overflow-hidden">
				<div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-primary/10" />
				<div className="relative container max-w-5xl mx-auto px-4 pt-20 pb-24 sm:pt-32 sm:pb-36 text-center">
					{/* Icon cluster */}
					<div className="flex items-center justify-center gap-3 mb-8">
						<div className="rounded-2xl bg-primary/10 p-3">
							<Camera className="h-8 w-8 text-primary" />
						</div>
						<div className="rounded-2xl bg-primary/10 p-3 -mt-4">
							<Share2 className="h-6 w-6 text-primary" />
						</div>
						<div className="rounded-2xl bg-primary/10 p-3">
							<Users className="h-7 w-7 text-primary" />
						</div>
					</div>

					<h1 className="text-4xl sm:text-6xl font-bold tracking-tight">
						Share photos with
						<br />
						<span className="text-primary">your people</span>
					</h1>
					<p className="mt-6 text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed">
						Create private photo pods for your family, friends, or events.
						Invite your group, upload moments, and relive them together.
					</p>

					<div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-10">
						<Button size="lg" asChild className="text-base px-8">
							<Link href="/pods">Get Started</Link>
						</Button>
						<Button size="lg" variant="outline" asChild className="text-base px-8">
							<Link href="/pods/new">Create a Pod</Link>
						</Button>
					</div>
				</div>
			</section>

			{/* Features */}
			<section className="container max-w-5xl mx-auto px-4 py-20">
				<div className="text-center mb-14">
					<h2 className="text-2xl sm:text-3xl font-bold">
						Everything you need to share moments
					</h2>
					<p className="text-muted-foreground mt-3 max-w-xl mx-auto">
						Simple, private, and beautiful. Photo Pods makes group photo sharing effortless.
					</p>
				</div>

				<div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
					{features.map((feature) => (
						<Card key={feature.title} className="border-muted/50">
							<CardContent className="p-6">
								<div className="rounded-xl bg-primary/10 p-3 w-fit mb-4">
									<feature.icon className="h-5 w-5 text-primary" />
								</div>
								<h3 className="font-semibold text-lg">{feature.title}</h3>
								<p className="text-muted-foreground text-sm mt-2 leading-relaxed">
									{feature.description}
								</p>
							</CardContent>
						</Card>
					))}
				</div>
			</section>

			{/* How it works */}
			<section className="bg-muted/30 border-t">
				<div className="container max-w-5xl mx-auto px-4 py-20">
					<h2 className="text-2xl sm:text-3xl font-bold text-center mb-14">
						How it works
					</h2>
					<div className="grid grid-cols-1 sm:grid-cols-3 gap-8 text-center">
						{[
							{
								step: "1",
								title: "Create a Pod",
								description: "Name your group and set its visibility. It takes seconds.",
							},
							{
								step: "2",
								title: "Invite People",
								description: "Share an invite link or QR code with your group.",
							},
							{
								step: "3",
								title: "Share Photos",
								description: "Everyone uploads and browses photos together in one place.",
							},
						].map((item) => (
							<div key={item.step}>
								<div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-primary text-primary-foreground font-bold text-lg mb-4">
									{item.step}
								</div>
								<h3 className="font-semibold text-lg">{item.title}</h3>
								<p className="text-muted-foreground text-sm mt-2">
									{item.description}
								</p>
							</div>
						))}
					</div>

					<div className="text-center mt-14">
						<Button size="lg" asChild className="text-base px-8">
							<Link href="/pods/new">Create Your First Pod</Link>
						</Button>
					</div>
				</div>
			</section>

			{/* Footer */}
			<footer className="border-t py-8">
				<div className="container max-w-5xl mx-auto px-4 text-center text-sm text-muted-foreground">
					<p>Photo Pods — Simple, private photo sharing for groups.</p>
				</div>
			</footer>
		</div>
	);
}
