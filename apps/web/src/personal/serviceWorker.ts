import { isHostedStaticApp } from "../hostedPairing";

/**
 * The portal is a PWA; local web and desktop builds must not register a
 * service worker, because it would serve stale assets across dev restarts.
 */
export function registerPersonalServiceWorker(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!isHostedStaticApp()) return;
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    // Push and offline shell are optional; the app still works without them.
  });
}
