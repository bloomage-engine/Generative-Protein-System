"use client";

import { StudioPage } from "@/components/studio/page";

/**
 * The SPA home — the Generative Protein System workbench (conversation + file browser).
 * Seeds its Project/Session scope in the store, then renders the 3-pane shell.
 */
export default function Home() {
  return <StudioPage />;
}
