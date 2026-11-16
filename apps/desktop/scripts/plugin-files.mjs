/** The child-side cordis plugins the desktop host ships next to host.mjs. */
export function childPluginNames(entries) {
  return entries.filter((name) => name.endsWith("-plugin.js")).sort();
}
