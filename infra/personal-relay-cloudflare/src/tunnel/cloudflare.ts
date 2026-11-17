export class CloudflareApiError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { readonly status?: number | null; readonly retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
  }
}
