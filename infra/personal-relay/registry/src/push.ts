import webPush from "web-push";

import type { PushSubscriptionRow } from "./store.ts";
import type { VapidKeys } from "./vapid.ts";

export type PushSendResult = "sent" | "gone" | "failed";

export interface PushSender {
  send(subscription: PushSubscriptionRow, payload: unknown): Promise<PushSendResult>;
}

export interface WebPushSenderOptions {
  readonly keys: VapidKeys;
  readonly subject: string;
  readonly log?: (message: string, detail?: unknown) => void;
}

/**
 * Thin wrapper over `web-push` so the registry can test sender behavior without
 * a real push service. A subscription the service says is gone must be removed;
 * any other failure is logged and kept for a later notification.
 */
export function createWebPushSender(options: WebPushSenderOptions): PushSender {
  webPush.setVapidDetails(options.subject, options.keys.publicKey, options.keys.privateKey);
  const log = options.log ?? (() => {});
  return {
    async send(subscription, payload) {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          JSON.stringify(payload),
        );
        return "sent";
      } catch (cause) {
        const statusCode = (cause as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) return "gone";
        log("Push delivery failed.", { statusCode, endpoint: safeEndpoint(subscription.endpoint) });
        return "failed";
      }
    },
  };
}

/** Endpoints are bearer credentials; logs keep only the push service origin. */
export function safeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return "invalid-endpoint";
  }
}
