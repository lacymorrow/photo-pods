import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// LAC-3456: a public pod detail page must render for anonymous (no-session)
// visitors — the anon discovery feed (LAC-2910) links straight here. Only
// private/group pods the viewer can't see may 404. The page-level short-circuit
// `if (!session?.user?.id) notFound()` regressed this for *every* pod; these
// tests lock in the corrected behavior at the page boundary (where the bug was),
// not just in pod-policy (which was already correct).

const mocks = vi.hoisted(() => ({
	auth: vi.fn(),
	getPod: vi.fn(),
	getPodPhotos: vi.fn(),
	notFound: vi.fn(() => {
		throw new Error("NEXT_NOT_FOUND");
	}),
}));

vi.mock("@/server/auth", () => ({ auth: mocks.auth }));
vi.mock("@/server/actions/pods", () => ({
	getPod: mocks.getPod,
	getPodPhotos: mocks.getPodPhotos,
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));

// Stub the heavy client children — they pull "use server" actions into the
// bundle and are irrelevant to what this test asserts (which shell renders for
// whom). We assert on their presence/absence via testids.
vi.mock("@/components/pods/photo-grid", () => ({
	PhotoGrid: ({ photos }: { photos: unknown[] }) => (
		<div data-testid="photo-grid">{photos.length} photos</div>
	),
}));
vi.mock("@/components/pods/photo-upload", () => ({
	PhotoUpload: () => <div data-testid="photo-upload" />,
}));
vi.mock("@/components/pods/invite-button", () => ({
	InviteButton: () => <div data-testid="invite-button" />,
}));
vi.mock("@/components/pods/invite-link", () => ({
	InviteLink: () => <div data-testid="invite-link" />,
}));
vi.mock("@/components/pods/member-list", () => ({
	MemberList: () => <div data-testid="member-list" />,
}));
vi.mock("@/components/pods/download-all-button", () => ({
	DownloadAllButton: () => <div data-testid="download-all" />,
}));

import PodDetailPage from "@/app/(app)/pods/[podId]/page";

const publicPod = (overrides: Record<string, unknown> = {}) => ({
	id: "pod-1",
	name: "Sunset Society",
	description: "Golden hour shots",
	visibility: "public",
	memberCount: 3,
	photoCount: 2,
	followerCount: 0,
	members: [{ userId: "owner-1", role: "owner", user: { id: "owner-1", name: "Ana", image: null } }],
	viewer: {
		userId: null,
		isMember: false,
		isOwner: false,
		canUpload: false,
		canReact: false,
		canInvite: false,
		canModerate: false,
	},
	...overrides,
});

const renderPage = async () => {
	const ui = await PodDetailPage({ params: Promise.resolve({ podId: "pod-1" }) });
	return render(ui);
};

describe("PodDetailPage anon access (LAC-3456)", () => {
	beforeEach(() => {
		mocks.auth.mockReset();
		mocks.getPod.mockReset();
		mocks.getPodPhotos.mockReset();
		mocks.notFound.mockClear();
	});

	it("renders a public pod (200 + photo grid) for an anonymous visitor", async () => {
		mocks.auth.mockResolvedValue(null);
		mocks.getPod.mockResolvedValue(publicPod());
		mocks.getPodPhotos.mockResolvedValue({
			photos: [{ id: "m1" }, { id: "m2" }],
			nextCursor: null,
		});

		await renderPage();

		expect(mocks.notFound).not.toHaveBeenCalled();
		expect(screen.getByText("Sunset Society")).toBeTruthy();
		expect(screen.getByTestId("photo-grid").textContent).toContain("2 photos");
	});

	it("renders the read-only shell — no upload/invite controls — for a guest", async () => {
		mocks.auth.mockResolvedValue(null);
		mocks.getPod.mockResolvedValue(publicPod());
		mocks.getPodPhotos.mockResolvedValue({ photos: [], nextCursor: null });

		await renderPage();

		expect(screen.queryByTestId("photo-upload")).toBeNull();
		expect(screen.queryByTestId("invite-button")).toBeNull();
		expect(screen.queryByTestId("invite-link")).toBeNull();
	});

	it("404s an anonymous visitor on a private/group pod (getPod throws Access denied)", async () => {
		mocks.auth.mockResolvedValue(null);
		mocks.getPod.mockRejectedValue(new Error("Access denied"));

		await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
		expect(mocks.notFound).toHaveBeenCalledTimes(1);
	});
});
