import type { MetadataRoute } from "next";
import { routes } from "@/config/routes";
import { siteConfig } from "@/config/site-config";

// This function will be called at build time and can also be called on-demand
export async function generateSitemaps() {
  return [{ id: 0 }];
}

export default async function sitemap(_props: { id: number }): Promise<MetadataRoute.Sitemap> {
  // Core product pages (highest priority)
  const productRoutes = [
    {
      url: siteConfig.url,
      lastModified: new Date(),
      changeFrequency: "daily" as const,
      priority: 1,
    },
    {
      url: `${siteConfig.url}${routes.pods.index}`,
      lastModified: new Date(),
      changeFrequency: "daily" as const,
      priority: 0.9,
    },
    {
      url: `${siteConfig.url}${routes.pods.discover}`,
      lastModified: new Date(),
      changeFrequency: "daily" as const,
      priority: 0.8,
    },
  ];

  // Support pages (lower priority)
  const supportRoutes = [
    {
      url: `${siteConfig.url}${routes.contact}`,
      lastModified: new Date(),
      changeFrequency: "monthly" as const,
      priority: 0.5,
    },
    {
      url: `${siteConfig.url}${routes.terms}`,
      lastModified: new Date(),
      changeFrequency: "monthly" as const,
      priority: 0.4,
    },
    {
      url: `${siteConfig.url}${routes.privacy}`,
      lastModified: new Date(),
      changeFrequency: "monthly" as const,
      priority: 0.4,
    },
  ];

  return [...productRoutes, ...supportRoutes];
}
