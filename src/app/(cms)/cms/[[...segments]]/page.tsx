/**
 * Payload's admin panel at /cms, behind the Payload feature flag.
 *
 * The generated views live in ./payload-admin-page. See
 * `(cms)/_lib/payload-route` for why they are not imported statically.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { env } from "@/env";

interface Args {
  params: Promise<{
    segments: string[];
  }>;
  searchParams: Promise<Record<string, string | string[]>>;
}

const admin = () => import("./payload-admin-page");

export const generateMetadata = async (args: Args): Promise<Metadata> => {
  if (!env.NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED) {
    return { title: "Not Found" };
  }

  return (await admin()).generateMetadata(args);
};

const Page = async (args: Args) => {
  if (!env.NEXT_PUBLIC_FEATURE_PAYLOAD_ENABLED) {
    notFound();
  }

  const { default: PayloadAdminPage } = await admin();
  return PayloadAdminPage(args);
};

export default Page;
