import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * Two `next dev` processes in this directory would clobber one `.next` build
   * (missing chunks, 500s), so the regression suite gives its own dev server a
   * private build dir — the tests can then run while a developer's `npm run dev`
   * is up. See `test/harness.mjs`.
   */
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? { output: "standalone", outputFileTracingRoot: join(here, "..", "..") }
    : {}),
};

export default nextConfig;
