import { describe, expect, it } from "vite-plus/test";

import { CloudflareApiClient, CloudflareApiError } from "../cloudflareApi.ts";

const API_TOKEN = "cf-api-token-secret";

function success(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

describe("CloudflareApiClient", () => {
  it("sends the bearer token, query and JSON body", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenAuthorization: string | null = null;
    let seenBody: unknown;
    const client = new CloudflareApiClient({
      apiToken: API_TOKEN,
      fetch: (input, init) => {
        seenUrl = input instanceof Request ? input.url : String(input);
        seenMethod = init?.method ?? "";
        seenAuthorization = new Headers(init?.headers).get("authorization");
        seenBody = init?.body;
        return Promise.resolve(success({ id: "tunnel-1" }));
      },
    });

    const result = await client.request<{ id: string }>({
      method: "POST",
      path: "/accounts/account-test/cfd_tunnel",
      query: { name: "t3cf-abc123def456" },
      body: { name: "t3cf-abc123def456", config_src: "cloudflare" },
    });

    expect(result).toEqual({ id: "tunnel-1" });
    expect(seenUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-test/cfd_tunnel?name=t3cf-abc123def456",
    );
    expect(seenMethod).toBe("POST");
    expect(seenAuthorization).toBe(`Bearer ${API_TOKEN}`);
    expect(seenBody).toBe(JSON.stringify({ name: "t3cf-abc123def456", config_src: "cloudflare" }));
  });

  it("maps rate limits and server failures to retryable errors", async () => {
    for (const status of [429, 503]) {
      const client = new CloudflareApiClient({
        apiToken: API_TOKEN,
        fetch: () =>
          Promise.resolve(
            Response.json(
              {
                success: false,
                errors: [{ code: 10000, message: `rejected ${API_TOKEN}` }],
                messages: [],
                result: null,
              },
              { status },
            ),
          ),
      });

      const error = await client
        .request({ method: "GET", path: "/user/tokens/verify" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(CloudflareApiError);
      expect(error).toMatchObject({ status, retryable: true });
      expect((error as Error).message).not.toContain(API_TOKEN);
      expect((error as Error).message).toContain("[redacted]");
    }
  });

  it("treats a bodyless or non-JSON response as an API failure", async () => {
    const client = new CloudflareApiClient({
      apiToken: API_TOKEN,
      fetch: () => Promise.resolve(new Response("not json", { status: 502 })),
    });

    const error = await client
      .request({ method: "GET", path: "/user/tokens/verify" })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ status: 502, retryable: true });
  });
});
