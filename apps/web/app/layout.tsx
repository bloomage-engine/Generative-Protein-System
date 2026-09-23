import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "./theme-provider";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "Science Studio",
  description: "Research-agent platform for computational life-science R&D.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // next-themes stamps its theme class (and `color-scheme`) on <html> from a
    // blocking script that runs BEFORE hydration, so React's own render is
    // intentionally allowed to disagree with the server HTML on this element.
    <html lang="en" suppressHydrationWarning className={cn("font-sans", geist.variable)}>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
