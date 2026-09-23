"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import type { CSSProperties } from "react";

/**
 * The app's toast host (shadcn's sonner wrapper). Mounted once in the root
 * layout; transient notices — e.g. "open a structure file" when an agent
 * selection cannot be applied — are raised with `toast(...)` from `sonner`,
 * which works outside React components too.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position="top-center"
      duration={6000}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
