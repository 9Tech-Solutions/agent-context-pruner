export interface HttpRequest {
  readonly url: string;
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly text: string;
}

/**
 * Sends one HTTP request. The host supplies it: global `fetch` under Node or
 * Bun, `$.http.fetch` inside a Claude Code hook (which has no Node and no
 * global network). May reject on network failure; adapters turn that into an
 * error value.
 */
export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** An `HttpTransport` over the global `fetch`, or an injected one. */
export function fetchTransport(fetchFn: typeof fetch = fetch): HttpTransport {
  return async (request) => {
    const response = await fetchFn(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  };
}
