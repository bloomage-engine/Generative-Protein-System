"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useColorTheme } from "@/lib/color-theme";
import { COLOR_THEMES, type ColorThemeId } from "@/lib/theme-catalog";

const APPEARANCES = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
] as const;

/**
 * The top bar's theme menu: the light/dark appearance (next-themes) and the
 * shadcnblocks color theme (`lib/color-theme.tsx` → `data-theme` → the generated
 * `app/themes.css`) in ONE dropdown.
 *
 * The trigger's icon is chosen in CSS (`dark:block` / `dark:hidden`) rather than
 * from `resolvedTheme`, so it is already correct on the server-rendered HTML —
 * no mount guard, no flash.
 */
export function ThemeMenu() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { theme: colorTheme, setTheme: setColorTheme } = useColorTheme();
  const dark = resolvedTheme === "dark";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Theme">
          <Sun className="hidden h-4 w-4 dark:block" />
          <Moon className="h-4 w-4 dark:hidden" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          {APPEARANCES.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon className="size-4" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Color theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={colorTheme}
          onValueChange={(value) => setColorTheme(value as ColorThemeId)}
        >
          {COLOR_THEMES.map((option) => (
            <DropdownMenuRadioItem key={option.id} value={option.id}>
              {/* The theme's own tokens, so a row previews what it applies. The
                  active mode's set is shown: a light swatch on a dark popover
                  would preview the wrong theme. */}
              <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
                {(dark ? option.swatches.dark : option.swatches.light).map((color, index) => (
                  <span
                    key={index}
                    className="size-2.5 rounded-full ring-1 ring-foreground/15"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </span>
              <span className="truncate">{option.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
