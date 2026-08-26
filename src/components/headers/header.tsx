"use client";

import { HamburgerMenuIcon } from "@radix-ui/react-icons";
import { useWindowScroll } from "@uidotdev/usehooks";
import { cva } from "class-variance-authority";
import { useSession } from "next-auth/react";
import type React from "react";

import { Icon } from "@/components/assets/icon";
import { LoginButton } from "@/components/buttons/sign-in-button";
import { SearchMenu } from "@/components/modules/search/search-menu";
import { UserMenu } from "@/components/modules/user/user-menu";
import { Link } from "@/components/primitives/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/ui/shipkit/theme";
import type { NavLink } from "@/config/navigation";
import { defaultNavLinks as navigationDefaultNavLinks } from "@/config/navigation";
import { PriorityNav } from "@/components/ui/priority-nav";
import { routes } from "@/config/routes";
import { siteConfig } from "@/config/site-config";
import { useSignInRedirectUrl } from "@/hooks/use-auth-redirect";
import { cn } from "@/lib/utils";
import styles from "@/styles/header.module.css";
import type { User } from "@/types/user";

interface HeaderProps {
  navLinks?: NavLink[];
  logoHref?: string;
  logoIcon?: React.ReactNode;
  logoText?: string;
  searchPlaceholder?: string;
  /**
   * Controls which search control is rendered.
   * - "menu": renders the standard command menu search (default)
   * - "none": renders no search control
   */
  searchVariant?: "menu" | "none";
  variant?: "default" | "sticky" | "floating" | "logo-only" | "minimal";
  /**
   * When set and variant is "floating", toggles opaque style after the given scroll threshold (in px).
   */
  opaqueOnScroll?: number;
  /**
   * Optional authenticated user to pass into the user menu.
   */
  user?: User | null;
  className?: string;
}

// Deprecated local defaultNavLinks; use navigationDefaultNavLinks from config instead.

const headerVariants = cva("translate-z-0 z-50 p-md", {
  variants: {
    variant: {
      default: "relative",
      floating: "sticky top-0 h-24",
      sticky:
        "sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60",
      "logo-only": "relative",
      minimal: "relative",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export const Header: React.FC<HeaderProps> = ({
  logoHref = routes.home,
  logoIcon = <Icon />,
  logoText = siteConfig.title,
  navLinks = navigationDefaultNavLinks,
  variant = "default",
  searchPlaceholder = `Search ${siteConfig.title}...`,
  searchVariant = "menu",
  opaqueOnScroll,
  user,
  className,
}) => {
  const [{ y }] = useWindowScroll();
  const signInRedirectUrl = useSignInRedirectUrl();
  const { data: session } = useSession();

  const isLogoOnly = variant === "logo-only";
  const isLoggedIn = !!session?.user || !!user;
  const scrollY = typeof y === "number" ? y : 0;
  const isOpaque =
    variant === "floating" && typeof opaqueOnScroll === "number" && scrollY > opaqueOnScroll;

  // Minimal variant: logo + a few text links + theme toggle
  if (variant === "minimal") {
    const minimalLinks: NavLink[] = [
      { href: routes.pods.index, label: "My Pods" },
      { href: routes.pods.discover, label: "Discover" },
    ];

    return (
      <header className={cn(headerVariants({ variant: "minimal" }), className)}>
        <nav className="container flex items-center justify-between gap-md">
          <div className="flex items-center gap-2 md:gap-4 shrink-0">
            <Link
              href={logoHref}
              className="flex items-center gap-2 text-lg font-semibold md:mr-6 md:text-base"
            >
              {logoIcon}
              <span className="block whitespace-nowrap">{logoText}</span>
            </Link>

            <div className="flex items-center gap-md text-sm">
              {minimalLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>

          <ThemeToggle variant="ghost" size="icon" className="rounded-full" />
        </nav>
      </header>
    );
  }

  return (
    <header
      className={cn(
        headerVariants({ variant }),
        variant === "floating" && styles.header,
        variant === "floating" && isOpaque && styles.opaque,
        variant === "floating" &&
        isOpaque &&
        "-top-[12px] [--header-background:#fafafc70] dark:[--header-background:#1c1c2270]",
        className
      )}
    >
      {variant === "floating" && <div className="h-[12px] w-full" />}
      <nav
        className={cn(
          "container",
          isLogoOnly
            ? "flex items-center justify-center gap-md"
            : "flex items-center justify-between gap-md"
        )}
      >
        <div
          className={cn(
            "flex items-center gap-2 md:gap-4",
            isLogoOnly ? "justify-center shrink-0" : "justify-start min-w-0 flex-1"
          )}
        >
          {!isLogoOnly && (
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline" size="icon" className="shrink-0 md:hidden">
                  <HamburgerMenuIcon className="h-5 w-5" />
                  <span className="sr-only">Toggle navigation menu</span>
                </Button>
              </SheetTrigger>
              <SheetContent side="left">
                <nav className="grid gap-6 font-medium">
                  <Link href={logoHref} className="flex items-center gap-2 text-lg font-semibold">
                    {logoIcon}
                    <span className="sr-only">{logoText}</span>
                  </Link>
                  {searchVariant === "menu" && (
                    <SearchMenu
                      buttonText={searchPlaceholder}
                      minimal={true}
                      buttonClassName="w-full justify-start"
                    />
                  )}
                  {navLinks.map((link) => (
                    <Link
                      key={`${link.href}-${link.label}`}
                      href={link.href}
                      className={cn(
                        "text-muted-foreground hover:text-foreground",
                        link.isCurrent ? "text-foreground" : ""
                      )}
                    >
                      {link.label}
                    </Link>
                  ))}
                  {!isLoggedIn && (
                    <Link
                      href={signInRedirectUrl}
                      className={cn(
                        buttonVariants({ variant: "default" }),
                        "w-full justify-center"
                      )}
                    >
                      Sign in
                    </Link>
                  )}
                  {isLoggedIn && (
                    <Link
                      href={routes.pods.index}
                      className={cn(
                        buttonVariants({ variant: "default" }),
                        "w-full justify-center"
                      )}
                    >
                      My Pods
                    </Link>
                  )}
                </nav>
              </SheetContent>
            </Sheet>
          )}

          <Link
            href={logoHref}
            className="flex items-center gap-2 text-lg font-semibold md:mr-6 md:text-base"
          >
            {logoIcon}
            <span className="block whitespace-nowrap">{logoText}</span>
          </Link>

          <div className="hidden md:flex min-w-0 flex-1">
            <PriorityNav navLinks={navLinks} />
          </div>
        </div>

        {!isLogoOnly && (
          <div className="flex items-center gap-2 lg:gap-4 shrink-0">
            {/* Search */}
            {searchVariant === "menu" && (
              <SearchMenu
                buttonText={searchPlaceholder}
                minimal={true}
                buttonClassName="hidden md:flex min-w-[40px]"
                collapsible
              />
            )}

            {!isLoggedIn && <ThemeToggle variant="ghost" size="icon" className="rounded-full" />}

            <UserMenu user={user} />

            {!isLoggedIn && (
              <LoginButton variant="outline" nextUrl={routes.pods.index}>
                Sign in
              </LoginButton>
            )}
          </div>
        )}
      </nav>
    </header>
  );
};
