import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * LAC-5696: `getPendingMediaReports` now runs its rows through
 * `applyMediaUrlPolicy`, so a private or group pod's report carries the
 * membership-checked route instead of the permanent public storage URL.
 *
 * This asserts the half that service test cannot: the reviewer still gets a
 * rendered image. The page reads `thumbnailUrl ?? url`, and the policy sets
 * `thumbnailUrl` to null for non-public pods, so a change to either side
 * could leave an admin staring at a placeholder with no way to action the
 * report.
 */
const MEDIA_ID = "7b9d6f2a-5c31-4e18-9a04-2f6b8c1d3e55";
const BLOB_URL = "https://store123.public.blob.vercel-storage.com/pods/p-1/a.jpg";

const mocks = vi.hoisted(() => ({
  getPendingMediaReports: vi.fn(),
  getPendingPodReports: vi.fn(async () => []),
}));

vi.mock("@/server/services/pod-moderation", () => ({
  getPendingMediaReports: mocks.getPendingMediaReports,
  getPendingPodReports: mocks.getPendingPodReports,
}));

vi.mock("@/app/(app)/(admin)/admin/moderation/pods/_components/review-buttons", () => ({
  ReviewButtons: () => <div data-testid="review-buttons" />,
}));

import PodModerationPage from "@/app/(app)/(admin)/admin/moderation/pods/page";

const report = (over: Record<string, unknown> = {}) => ({
  id: "r-1",
  reason: "nudity_sexual",
  details: "Reported for review",
  createdAt: new Date(),
  reporterName: "Reporter",
  media: {
    id: MEDIA_ID,
    type: "photo",
    url: `/api/pods/media/${MEDIA_ID}`,
    thumbnailUrl: null,
    caption: "Reported photo",
    hiddenAt: null,
    reportCount: 1,
    ...((over.media as Record<string, unknown>) ?? {}),
  },
  pod: { id: "p-1", name: "Private Pod", visibility: "private" },
});

const renderPage = async () => render(await PodModerationPage());

describe("admin moderation queue — the reviewer still sees the image (LAC-5696)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPendingPodReports.mockResolvedValue([]);
  });

  it("renders the membership-checked route as the preview for a private pod", async () => {
    mocks.getPendingMediaReports.mockResolvedValue([report()]);

    await renderPage();

    const img = screen.getByAltText("Reported photo");
    expect(img).toHaveAttribute("src", `/api/pods/media/${MEDIA_ID}`);
  });

  it("renders no storage URL anywhere on the page", async () => {
    mocks.getPendingMediaReports.mockResolvedValue([report()]);

    const { container } = await renderPage();

    expect(container.innerHTML).not.toContain("blob.vercel-storage.com");
  });

  it("still previews auto-hidden media, which is most of this queue", async () => {
    mocks.getPendingMediaReports.mockResolvedValue([
      report({ media: { hiddenAt: new Date(), caption: "Hidden photo" } }),
    ]);

    await renderPage();

    expect(screen.getByAltText("Hidden photo")).toBeInTheDocument();
    expect(screen.getByText("Auto-hidden")).toBeInTheDocument();
  });

  it("keeps serving a public pod's direct URL", async () => {
    mocks.getPendingMediaReports.mockResolvedValue([
      {
        ...report({ media: { url: BLOB_URL } }),
        pod: { id: "p-2", name: "Public Pod", visibility: "public" },
      },
    ]);

    await renderPage();

    expect(screen.getByAltText("Reported photo")).toHaveAttribute("src", BLOB_URL);
  });

  it("falls back to a placeholder when there is no URL at all", async () => {
    mocks.getPendingMediaReports.mockResolvedValue([report({ media: { url: null } })]);

    await renderPage();

    expect(screen.queryByAltText("Reported photo")).toBeNull();
    expect(screen.getByText("photo")).toBeInTheDocument();
  });
});
