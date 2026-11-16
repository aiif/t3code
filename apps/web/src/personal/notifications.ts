import * as Schema from "effect/Schema";

export type NotificationPermissionState = "default" | "granted" | "denied" | "unsupported";

export interface PersonalNotificationInput {
  readonly relayUrl: string;
  readonly key: string;
}

export class PersonalNotificationError extends Schema.TaggedError<PersonalNotificationError>()(
  "PersonalNotificationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const isPersonalNotificationError = Schema.is(PersonalNotificationError);

export function personalNotificationPermission(): NotificationPermissionState {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** VAPID keys are base64url; `PushManager.subscribe` wants raw bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = `${base64}${padding}`.replace(/-/gu, "+").replace(/_/gu, "/");
  const raw = atob(normalized);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

const VapidPublicKey = Schema.Struct({ publicKey: Schema.String });
const decodeVapidPublicKey = Schema.decodeUnknownSync(VapidPublicKey);

async function relayPublicKey(input: PersonalNotificationInput): Promise<string> {
  const response = await fetch(`${input.relayUrl.replace(/\/+$/u, "")}/v1/push/public-key`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new PersonalNotificationError({ detail: `The relay answered ${response.status}.` });
  }
  return decodeVapidPublicKey(await response.json()).publicKey;
}

/**
 * Subscribes this browser to Web Push and registers the subscription with the
 * relay. Requires a user gesture for the permission prompt.
 */
export async function enablePersonalNotifications(
  input: PersonalNotificationInput,
): Promise<NotificationPermissionState> {
  if (
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    typeof Notification === "undefined" ||
    typeof PushManager === "undefined"
  ) {
    return "unsupported";
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission;

  try {
    const publicKey = await relayPublicKey(input);
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription =
      existing ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));

    const response = await fetch(`${input.relayUrl.replace(/\/+$/u, "")}/v1/push/subscribe`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subscription: subscription.toJSON(),
        userAgent: navigator.userAgent,
      }),
    });
    if (!response.ok) {
      throw new PersonalNotificationError({ detail: `The relay answered ${response.status}.` });
    }
    return "granted";
  } catch (cause) {
    if (isPersonalNotificationError(cause)) throw cause;
    throw new PersonalNotificationError({
      detail: cause instanceof Error ? cause.message : "Could not subscribe to notifications.",
    });
  }
}
