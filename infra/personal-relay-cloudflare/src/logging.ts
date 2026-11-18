/**
 * Structured operation log. Never pass request bodies, authorization headers,
 * host keys, host tokens, tunnel tokens, or the Cloudflare API token here.
 */
export function logRelayEvent(event: string, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...detail }));
}

export function describeError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const trimmed = message.trim();
  return trimmed.length === 0 ? "Unknown error" : trimmed.slice(0, 500);
}
