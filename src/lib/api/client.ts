/**
 * Browser-side API plumbing: the error envelope every route answers with, the
 * `Error` subclass that carries it, and the two helpers every `*.client.ts`
 * feature module needs (`ensureOk` on the way in, `serverMessage` on the way
 * out). The client counterpart of `src/lib/api/handler.ts`, which produces the
 * very envelope this module parses.
 *
 * This is where the pieces `features/missions/mission.client.ts` introduced in
 * Phase 2 now live, unchanged: as of Phase 3 a second feature
 * (`features/bids/bid.client.ts`) makes the same calls, and a *copy* of
 * `ApiError` would be an outright bug — two classes named the same, so
 * `error instanceof ApiError` in a shared component would answer `false` for
 * whichever half it was not built from. One class, imported by both.
 * `mission.client.ts` re-exports it so its existing importers are unaffected.
 *
 * Deliberately NOT `import "server-only"`: this is the half of the API that
 * runs in the browser.
 */

/** The `{ data, status, message }` envelope every API error carries (see `withErrorHandling`). */
export interface ApiErrorBody {
  /** A field -> message map for a 400 from a Zod schema; null otherwise. */
  data: unknown;
  status: string;
  message: string;
}

/**
 * A non-2xx API response, thrown by every client helper.
 *
 * This is the stand-in for the `HttpErrorResponse` Angular's HttpClient
 * throws: `fetch` resolves for a 4xx/5xx instead of rejecting, so the parsed
 * error envelope has to be carried on an Error of our own for callers to read
 * the server's field messages out of (the mission form and the bids panel both
 * do exactly that).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody | null,
  ) {
    super(body?.message ?? `Request failed with status ${status}`);
    this.name = "ApiError";
  }
}

/** Rejects a non-2xx response as an `ApiError` carrying the parsed envelope. */
export async function ensureOk(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // A response with no JSON body (or a truncated one) still has to surface
    // as the same error type — the status alone is what the caller falls back
    // to, mirroring HttpClient's behaviour for an unparseable error body.
  }
  throw new ApiError(response.status, body);
}

/**
 * The message to show the user for a failed call: the server's own if it sent
 * one, otherwise the caller's fallback.
 *
 * Ports `MissionDetailComponent.serverMessage` — "Pull a message out of the
 * backend's `{ data, status, message }` error body" — verbatim, including its
 * `length > 0` guard, which is why a blank `message` falls back rather than
 * showing an empty toast. It sits here rather than in the component because
 * the same private helper is copy-pasted into several Angular components
 * (mission-detail, my-bids, …) and one of them lands in this phase.
 *
 * A rejection that is not an `ApiError` at all (a network failure, an aborted
 * request) has no envelope to read, so it takes the fallback too — the same
 * outcome the source reaches via `err.error?.message` being `undefined`.
 */
export function serverMessage(error: unknown, fallback: string): string {
  const body = error instanceof ApiError ? error.body : null;
  return body && typeof body.message === "string" && body.message.length > 0
    ? body.message
    : fallback;
}
