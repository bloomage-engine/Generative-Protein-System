/**
 * The color themes the workbench theme menu offers — GENERATED, do not edit by
 * hand. Regenerate: node scripts/generate-shadcnblocks-themes.mjs
 *
 * `id` is the `data-theme` value and the key in app/themes.css; `name` is the
 * registry item's title; `swatches` are that theme's own tokens
 * (background / primary / accent) so a menu row previews what it applies.
 */
export type ColorThemeId =
  | "default"
  | "shadcnblocks"
  | "vercel"
  | "supabase"
  | "linear"
  | "claude"
  | "claymorphism"
  | "amber-minimal"
  | "cleanslate"
  | "citrus"
  | "falcon"
  | "modern-minimal"
  | "light-green"
  | "zen-inspired"
  | "astrovista"
  | "qrafthive"
  | "whatsapp"
  | "sage-green"
  | "vtron"
  | "autoblog"
  | "enterprise-mod-2"
  | "porfolio"
  | "deep-purple"
  | "bold-wikipedia"
  | "vescrow"
  | "japan-blues"
  | "chalk"
  | "vermillion"
  | "meridian"
  | "celestial"
  | "openprofile"
  | "stillwater"
  | "polaris"
  | "sandstone"
  | "exploremiam"
  | "vs-code"
  | "stella";

export type ColorTheme = {
  id: ColorThemeId;
  name: string;
  swatches: { light: [string, string, string]; dark: [string, string, string] };
};

/** The base stylesheet: `:root` / `.dark` in app/globals.css. */
export const DEFAULT_COLOR_THEME: ColorThemeId = "default";

export const COLOR_THEMES: readonly ColorTheme[] = [
  {
    id: "default",
    name: "Default",
    swatches: {
      light: ["oklch(1 0 0)", "oklch(0.205 0 0)", "oklch(0.97 0 0)"],
      dark: ["oklch(0.145 0 0)", "oklch(0.922 0 0)", "oklch(0.269 0 0)"],
    },
  },
  {
    id: "shadcnblocks",
    name: "Shadcnblocks",
    swatches: {
      light: ["oklch(1 0 0)", "oklch(0.205 0 0)", "oklch(0.97 0 0)"],
      dark: ["oklch(0.145 0 0)", "oklch(0.922 0 0)", "oklch(0.269 0 0)"],
    },
  },
  {
    id: "vercel",
    name: "Vercel",
    swatches: {
      light: ["oklch(0.99 0 0)", "oklch(0 0 0)", "oklch(0.94 0 0)"],
      dark: ["oklch(0 0 0)", "oklch(1 0 0)", "oklch(0.32 0 0)"],
    },
  },
  {
    id: "supabase",
    name: "Supabase",
    swatches: {
      light: ["oklch(0.99 0 0)", "oklch(0.83 0.13 160.91)", "oklch(0.95 0 0)"],
      dark: ["oklch(0.18 0 0)", "oklch(0.44 0.10 156.76)", "oklch(0.31 0 0)"],
    },
  },
  {
    id: "linear",
    name: "Linear",
    swatches: {
      light: ["oklch(0.9881 0.0000 0.0000)", "oklch(0.6076 0.1404 276.7418)", "oklch(0.8963 0.0194 276.3236)"],
      dark: ["oklch(0.1735 0.0020 286.1848)", "oklch(0.9249 0.0000 0.0000)", "oklch(0.3331 0.0361 273.4393)"],
    },
  },
  {
    id: "claude",
    name: "Claude",
    swatches: {
      light: ["oklch(0.98 0.01 95.10)", "oklch(0.62 0.14 39.04)", "oklch(0.7691 0.1177 38.993)"],
      dark: ["oklch(0.27 0.00 106.64)", "oklch(0.67 0.13 38.76)", "oklch(0.21 0.01 95.42)"],
    },
  },
  {
    id: "claymorphism",
    name: "Claymorphism",
    swatches: {
      light: ["oklch(0.9067 0 0)", "oklch(0.59 0.20 277.12)", "oklch(0.648 0.2027 304.397)"],
      dark: ["oklch(0.22 0.01 67.44)", "oklch(0.68 0.16 276.93)", "oklch(0.39 0.01 59.47)"],
    },
  },
  {
    id: "amber-minimal",
    name: "Amber Minimal",
    swatches: {
      light: ["oklch(1.00 0 0)", "oklch(0.77 0.16 70.08)", "oklch(0.99 0.02 95.28)"],
      dark: ["oklch(0.20 0 0)", "oklch(0.77 0.16 70.08)", "oklch(0.47 0.12 46.20)"],
    },
  },
  {
    id: "cleanslate",
    name: "Cleanslate",
    swatches: {
      light: ["oklch(0.98 0.00 247.86)", "oklch(0.59 0.20 277.12)", "oklch(0.93 0.03 272.79)"],
      dark: ["oklch(0.21 0.04 265.75)", "oklch(0.68 0.16 276.93)", "oklch(0.37 0.03 259.73)"],
    },
  },
  {
    id: "citrus",
    name: "Citrus",
    swatches: {
      light: ["oklch(0.9851 0 0)", "oklch(0.8719 0.1829 125.59)", "oklch(0.97 0 0)"],
      dark: ["oklch(0.145 0 0)", "oklch(0.8719 0.1829 125.59)", "oklch(0.269 0 0)"],
    },
  },
  {
    id: "falcon",
    name: "Falcon",
    swatches: {
      light: ["oklch(0.9759 0.0029 264.5421)", "oklch(0.4215 0.0424 273.9807)", "oklch(0.7453 0.0407 262.8685)"],
      dark: ["oklch(0.1822 0.0000 0.0000)", "oklch(0.7534 0.0322 186.3396)", "oklch(0.4325 0.0716 262.5973)"],
    },
  },
  {
    id: "modern-minimal",
    name: "Modern Minimal",
    swatches: {
      light: ["oklch(1.0000 0 0)", "oklch(0.6231 0.1880 259.8145)", "oklch(0.9514 0.0250 236.8242)"],
      dark: ["oklch(0.2046 0 0)", "oklch(0.6231 0.1880 259.8145)", "oklch(0.3791 0.1378 265.5222)"],
    },
  },
  {
    id: "light-green",
    name: "Light Green",
    swatches: {
      light: ["oklch(0.9892 0.0054 117.9205)", "oklch(0.8871 0.2122 128.5041)", "oklch(0.9819 0.0181 155.8263)"],
      dark: ["oklch(0.1288 0.0406 264.6952)", "oklch(0.8871 0.2122 128.5041)", "oklch(0.3925 0.0896 152.5353)"],
    },
  },
  {
    id: "zen-inspired",
    name: "Zen Inspired",
    swatches: {
      light: ["oklch(0.9195 0.0169 88.0030)", "oklch(0.3012 0 0)", "oklch(0.9169 0.0175 99.6160)"],
      dark: ["oklch(0.1913 0 0)", "oklch(0.8520 0.0205 100.6306)", "oklch(0.3329 0 0)"],
    },
  },
  {
    id: "astrovista",
    name: "Astrovista",
    swatches: {
      light: ["oklch(0.9383 0.0042 236.4993)", "oklch(0.6420 0.1691 38.5815)", "oklch(0.9119 0.0222 243.8174)"],
      dark: ["oklch(0.2178 0 0)", "oklch(0.6420 0.1691 38.5815)", "oklch(0.3380 0.0589 267.5867)"],
    },
  },
  {
    id: "qrafthive",
    name: "Qrafthive",
    swatches: {
      light: ["oklch(1.0000 0 0)", "oklch(0.6716 0.1368 48.5130)", "oklch(0.9491 0 0)"],
      dark: ["oklch(0.1797 0.0043 308.1928)", "oklch(0.7214 0.1337 49.9802)", "oklch(0.3211 0 0)"],
    },
  },
  {
    id: "whatsapp",
    name: "Whatsapp",
    swatches: {
      light: ["oklch(0.9605 0.0046 258.3248)", "oklch(0.4335 0.0754 182.2315)", "oklch(0.7610 0.2015 149.7403)"],
      dark: ["oklch(0.1854 0.0182 238.2143)", "oklch(0.6509 0.1283 170.4258)", "oklch(0.7610 0.2015 149.7403)"],
    },
  },
  {
    id: "sage-green",
    name: "Sage Green",
    swatches: {
      light: ["oklch(0.9940 0 0)", "oklch(0.7830 0.0384 132.7370)", "oklch(0.4429 0.0444 134.5073)"],
      dark: ["oklch(0.1173 0.0090 73.4751)", "oklch(0.7830 0.0384 132.7370)", "oklch(0.4429 0.0444 134.5073)"],
    },
  },
  {
    id: "vtron",
    name: "Vtron",
    swatches: {
      light: ["oklch(0.9911 0 0)", "oklch(0.5729 0.2337 264.3664)", "oklch(1.0000 0 0)"],
      dark: ["oklch(0 0 0)", "oklch(0.5683 0.2366 264.2478)", "oklch(0.1880 0.0868 261.9799)"],
    },
  },
  {
    id: "autoblog",
    name: "Autoblog",
    swatches: {
      light: ["oklch(0.9940 0 0)", "oklch(0.6404 0.2153 35.9003)", "oklch(0.9656 0.0176 39.4009)"],
      dark: ["oklch(0.1448 0 0)", "oklch(0.6404 0.2153 35.9003)", "oklch(0.3734 0.1246 36.3840)"],
    },
  },
  {
    id: "enterprise-mod-2",
    name: "Enterprise Mod 2",
    swatches: {
      light: ["oklch(0.9946 0.0026 286.3519)", "oklch(0.5565 0.2430 261.9529)", "oklch(0.9634 0.0175 279.0619)"],
      dark: ["oklch(0.1457 0.0043 285.8570)", "oklch(0.6449 0.2024 288.1131)", "oklch(0.2793 0.0598 283.1864)"],
    },
  },
  {
    id: "porfolio",
    name: "Porfolio",
    swatches: {
      light: ["oklch(0.9755 0.0067 97.3510)", "oklch(0.7414 0.0738 84.5946)", "oklch(0.7414 0.0738 84.5946)"],
      dark: ["oklch(0.1904 0.0040 106.7692)", "oklch(0.8039 0.0702 84.7579)", "oklch(0.8039 0.0702 84.7579)"],
    },
  },
  {
    id: "deep-purple",
    name: "Deep Purple",
    swatches: {
      light: ["oklch(0.9838 0.0035 247.8583)", "oklch(0.4865 0.2423 291.8661)", "oklch(0.9546 0.0227 303.2883)"],
      dark: ["oklch(0.1091 0.0091 301.6956)", "oklch(0.6083 0.2172 297.1153)", "oklch(0.2255 0.0836 296.7401)"],
    },
  },
  {
    id: "bold-wikipedia",
    name: "Bold Wikipedia",
    swatches: {
      light: ["oklch(1.0000 0 0)", "oklch(0.5296 0.1863 258.1459)", "oklch(0.9633 0.0154 255.0359)"],
      dark: ["oklch(0.2376 0 0)", "oklch(0.7782 0.1158 252.5545)", "oklch(0.3148 0.1071 255.8956)"],
    },
  },
  {
    id: "vescrow",
    name: "Vescrow",
    swatches: {
      light: ["oklch(0.9924 0.0028 308.4292)", "oklch(0.2236 0.1469 265.8205)", "oklch(0.9356 0.0312 279.8620)"],
      dark: ["oklch(0.1063 0.0172 259.5380)", "oklch(0.3820 0.1967 265.2890)", "oklch(0.2553 0.0657 274.6654)"],
    },
  },
  {
    id: "japan-blues",
    name: "Japan Blues",
    swatches: {
      light: ["oklch(0.9818 0.0054 95.0986)", "oklch(0.7040 0.0400 256.7880)", "oklch(0.9245 0.0138 92.9892)"],
      dark: ["oklch(0.2679 0.0036 106.6427)", "oklch(0.9010 0.0580 230.9020)", "oklch(0.2130 0.0078 95.4245)"],
    },
  },
  {
    id: "chalk",
    name: "Chalk",
    swatches: {
      light: ["oklch(0.9745 0.0079 253.8524)", "oklch(0.2038 0.0264 260.9332)", "oklch(0.9442 0.0137 258.3455)"],
      dark: ["oklch(0.2292 0.0304 259.0329)", "oklch(0.8993 0.0119 239.9205)", "oklch(0.3438 0.0389 254.6348)"],
    },
  },
  {
    id: "vermillion",
    name: "Vermillion",
    swatches: {
      light: ["oklch(0.9787 0.0017 247.8391)", "oklch(0.5895 0.1791 31.9223)", "oklch(0.9599 0.0025 228.7845)"],
      dark: ["oklch(0.1910 0.0043 264.4658)", "oklch(0.5895 0.1791 31.9223)", "oklch(0.2682 0.0080 264.4320)"],
    },
  },
  {
    id: "meridian",
    name: "Meridian",
    swatches: {
      light: ["oklch(0.9545 0.0046 258.3249)", "oklch(0.4833 0.0873 255.0550)", "oklch(0.9088 0.0196 252.8865)"],
      dark: ["oklch(0.2037 0.0110 260.6650)", "oklch(0.6347 0.0756 254.6243)", "oklch(0.2921 0.0350 252.3026)"],
    },
  },
  {
    id: "celestial",
    name: "Celestial",
    swatches: {
      light: ["oklch(1.0000 0 0)", "oklch(0.8012 0.1089 201.1736)", "oklch(0.9392 0.0166 250.8453)"],
      dark: ["oklch(0.1822 0 0)", "oklch(0.8012 0.1089 201.1736)", "oklch(0.3152 0.0427 202.4332)"],
    },
  },
  {
    id: "openprofile",
    name: "Openprofile",
    swatches: {
      light: ["oklch(1 0 0)", "oklch(0.8223 0.1648 86.7192)", "oklch(0.9700 0 0)"],
      dark: ["oklch(0.1450 0 0)", "oklch(0.8223 0.1648 86.7192)", "oklch(0.9508 0.0657 91.1875)"],
    },
  },
  {
    id: "stillwater",
    name: "Stillwater",
    swatches: {
      light: ["oklch(0.9764 0.0013 286.3755)", "oklch(0.4721 0.0927 237.7893)", "oklch(0.9175 0.0177 234.5132)"],
      dark: ["oklch(0.1884 0.0128 248.5103)", "oklch(0.7313 0.0733 235.1459)", "oklch(0.2654 0.0220 254.2034)"],
    },
  },
  {
    id: "polaris",
    name: "Polaris",
    swatches: {
      light: ["oklch(0.9816 0.0055 211.0391)", "oklch(0.4761 0.0870 221.3232)", "oklch(0.6554 0.1151 214.5277)"],
      dark: ["oklch(0.1161 0.0127 222.2833)", "oklch(0.6554 0.1151 214.5277)", "oklch(0.3487 0.0599 220.8978)"],
    },
  },
  {
    id: "sandstone",
    name: "Sandstone",
    swatches: {
      light: ["oklch(0.9789 0.0013 106.4235)", "oklch(0.2931 0 0)", "oklch(0.8778 0.1383 86.1920)"],
      dark: ["oklch(0.2174 0.0019 106.5582)", "oklch(0.9486 0.0027 106.4500)", "oklch(0.7007 0.1304 84.6350)"],
    },
  },
  {
    id: "exploremiam",
    name: "Exploremiam",
    swatches: {
      light: ["oklch(0.9858 0.0045 78.2984)", "oklch(0.5960 0.1274 163.2254)", "oklch(0.5960 0.1274 163.2254)"],
      dark: ["oklch(0.1663 0.0262 269.3709)", "oklch(0.6959 0.1491 162.4796)", "oklch(0.6959 0.1491 162.4796)"],
    },
  },
  {
    id: "vs-code",
    name: "Vs Code",
    swatches: {
      light: ["oklch(1.0000 0 0)", "oklch(0.5296 0.1506 255.1121)", "oklch(0.9197 0.0197 260.1694)"],
      dark: ["oklch(0.2221 0 0)", "oklch(0.5296 0.1506 255.1121)", "oklch(0.2704 0.0094 248.1761)"],
    },
  },
  {
    id: "stella",
    name: "Stella",
    swatches: {
      light: ["oklch(1.0000 0 0)", "oklch(0.8512 0.1254 73.9788)", "oklch(0.9197 0.0677 76.0180)"],
      dark: ["oklch(0.1651 0.0141 76.6248)", "oklch(0.8512 0.1254 73.9788)", "oklch(0.3627 0.0619 72.5775)"],
    },
  },
];
