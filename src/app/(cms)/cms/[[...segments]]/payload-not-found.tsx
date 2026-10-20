/**
 * Payload codegen output, moved out of not-found.tsx unchanged.
 *
 * not-found.tsx is now a feature-flag guard that reaches this module through a
 * dynamic import, so a build with Payload off never loads it. See
 * `(cms)/_lib/payload-route` for why. If Payload regenerates not-found.tsx, move
 * the new body back in here and restore the guard.
 */
/* THIS FILE WAS GENERATED AUTOMATICALLY BY PAYLOAD. */
/* DO NOT MODIFY IT BECAUSE IT COULD BE REWRITTEN AT ANY TIME. */

import config from "@payload-config";
import { generatePageMetadata, NotFoundPage } from "@payloadcms/next/views";
import type { Metadata } from "next";
import { importMap } from "../importMap";

interface Args {
  params: Promise<{
    segments: string[];
  }>;
  searchParams: Promise<Record<string, string | string[]>>;
}

export const generateMetadata = ({ params, searchParams }: Args): Promise<Metadata> =>
  generatePageMetadata({ config, params, searchParams });

const NotFound = ({ params, searchParams }: Args) =>
  NotFoundPage({ config, params, searchParams, importMap });

export default NotFound;
