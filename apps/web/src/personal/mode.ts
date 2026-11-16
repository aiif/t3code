/**
 * Personal-only builds hide T3 Connect, Cloudflare tunnels, and T3 Chat entry
 * points. The deployment sets `VITE_T3CODE_PERSONAL_ONLY=1` at build time.
 */
export function isPersonalOnly(): boolean {
  return import.meta.env.VITE_T3CODE_PERSONAL_ONLY?.trim() === "1";
}
