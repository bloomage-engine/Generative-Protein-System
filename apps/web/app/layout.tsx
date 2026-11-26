import type { Metadata } from "next";
import "./globals.css";
import {
  DM_Sans,
  Geist,
  IBM_Plex_Mono,
  Inter,
  JetBrains_Mono,
  Lora,
  Outfit,
  Plus_Jakarta_Sans,
} from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ColorThemeProvider, COLOR_THEME_SCRIPT } from "@/lib/color-theme";
import { ThemeProvider } from "./theme-provider";

/**
 * Geist is the app's own font (the `default` color theme). The rest are the
 * families the shadcnblocks themes ask for — `scripts/generate-shadcnblocks-themes.mjs`
 * maps a theme's stack onto these variables. Self-hosted (no external font
 * host), and `preload: false` so seven extra faces stay out of the first paint:
 * a family with no matching text is never fetched at all.
 */
const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", preload: false });
const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta-sans",
  preload: false,
});
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", preload: false });
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", preload: false });
const lora = Lora({ subsets: ["latin"], variable: "--font-lora", preload: false });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  preload: false,
});
const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-mono",
  preload: false,
});

export const metadata: Metadata = {
  title: "Science Studio",
  description: "Research-agent platform for computational life-science R&D.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // next-themes stamps its theme class (and `color-scheme`) on <html> from a
    // blocking script that runs BEFORE hydration, and the color-theme script
    // below stamps `data-theme` the same way, so React's own render is
    // intentionally allowed to disagree with the server HTML on this element.
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "font-sans",
        geist.variable,
        inter.variable,
        plusJakartaSans.variable,
        outfit.variable,
        dmSans.variable,
        lora.variable,
        jetbrainsMono.variable,
        ibmPlexMono.variable,
      )}
    >
      <body>
        {/* The color theme is applied before paint, so a saved pick never flashes
            the default palette first (docs: lib/color-theme.tsx). */}
        <script dangerouslySetInnerHTML={{ __html: COLOR_THEME_SCRIPT }} />
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <ColorThemeProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </ColorThemeProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
