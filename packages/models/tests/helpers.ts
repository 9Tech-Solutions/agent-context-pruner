import type { HttpRequest, HttpTransport } from "../src/index.ts";

export {
  call,
  fileA,
  fileB,
  message,
  result,
  transcript,
  unwrap,
  unwrapErr,
} from "../../domain/tests/fixtures.ts";

/** A SystemOne server that answers every `noul` question with `answer(name)` and records requests. */
export function fakeServer(
  answer: (name: string) => number,
  seen: HttpRequest[] = [],
): HttpTransport {
  return async (request) => {
    seen.push(request);
    const body = JSON.parse(request.body) as { questions: Record<string, unknown> };
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((name) => [name, { type: "noul", noul: answer(name) }]),
    );
    return { status: 200, ok: true, text: JSON.stringify({ answers }) };
  };
}

export function respond(status: number, text: string): HttpTransport {
  return async () => ({ status, ok: status >= 200 && status < 300, text });
}
