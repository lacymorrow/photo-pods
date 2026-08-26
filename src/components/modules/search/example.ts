import { routes } from "@/config/routes";
import type { MainNavItem, SidebarNavItem } from "@/types/nav";

export interface DocsConfig {
  mainNav: MainNavItem[];
  sidebarNav: SidebarNavItem[];
  featuresNav: SidebarNavItem[];
}

export const docsConfig: DocsConfig = {
  mainNav: [
    {
      title: "My Pods",
      href: routes.pods.index,
    },
    {
      title: "Discover",
      href: routes.pods.discover,
    },
    {
      title: "New Pod",
      href: routes.pods.new,
    },
    // Only include blog link when blog is enabled
    ...(process.env.NEXT_PUBLIC_HAS_BLOG === "true" ? [{ title: "Blog", href: routes.blog }] : []),
    {
      title: "Contact",
      href: routes.contact,
    },
  ],
  sidebarNav: [
    {
      title: "Pods",
      items: [
        {
          title: "My Pods",
          href: routes.pods.index,
          items: [],
        },
        {
          title: "Discover Public Pods",
          href: routes.pods.discover,
          items: [],
        },
        {
          title: "Create a Pod",
          href: routes.pods.new,
          items: [],
        },
      ],
    },
    {
      title: "Account",
      items: [
        {
          title: "Settings",
          href: routes.settings.index,
          items: [],
        },
        {
          title: "Sign in",
          href: routes.auth.signIn,
          items: [],
        },
      ],
    },
  ],
  featuresNav: [],
};
