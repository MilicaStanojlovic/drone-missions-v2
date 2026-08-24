/**
 * Paging: the request half (Spring's `Pageable`, as resolved from `?page`/`?size`
 * query parameters) and the response half (Spring Data's `PagedModel` JSON
 * envelope) that every paginated endpoint in this app speaks.
 *
 * The Spring backend gets both halves for free from framework plumbing that has
 * no Next.js counterpart:
 *
 * - `PageableHandlerMethodArgumentResolver` turns `?page=2&size=50` into a
 *   `Pageable` before a controller method ever runs, applying the
 *   `@PageableDefault(size = 20, sort = "createdAt", direction = DESC)` on the
 *   parameter when the request omits them.
 * - `new PagedModel<>(page)` wraps a `Page<T>` into the
 *   `{content, page: {size, number, totalElements, totalPages}}` JSON the
 *   Angular client's `PagedModel<T>` interface is typed against.
 *
 * Route handlers here do that explicitly: `parsePageRequest(searchParams)` on
 * the way in, `toPagedModel(page)` on the way out, with `mapPage` standing in
 * for `Page.map(mapper::toResponse)` in between. Shared rather than
 * per-feature because the users, missions-moderation and audit-log listings
 * must all produce byte-identical envelopes — the frontend parses them with one
 * type.
 *
 * Deliberately NOT `import "server-only"` (same reasoning as
 * `src/lib/api/client.ts`): these are pure value transformations with no
 * database or secret access, and the browser half of the app needs the
 * `PagedModel<T>` type — and `totalPages` arithmetic — for its paged tables.
 *
 * SOURCE:
 * - org.springframework.data.web.PagedModel (the response envelope) as consumed by
 *   drone-missions-frontend/.../src/app/models/page.model.ts
 * - org.springframework.data.web.PageableHandlerMethodArgumentResolver (the request parsing)
 * - drone-missions-backend/.../web/controller/user/UserController.java (`@PageableDefault(size = 20, …)`)
 */

/** The page size used when the request does not ask for one — `@PageableDefault(size = 20)`. */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * The largest page a request may ask for. Mirrors
 * `PageableHandlerMethodArgumentResolver`'s `maxPageSize` default of 2000,
 * which the backend never overrides: it exists so a single request cannot ask
 * the database for an unbounded result set.
 */
export const MAX_PAGE_SIZE = 2000;

/**
 * One page's worth of "which slice do you want" — the ported subset of
 * `Pageable`.
 *
 * `page` is 0-based, exactly as in Spring (the resolver's
 * `oneIndexedParameters` is left at its `false` default) and as the Angular
 * client documents its `page.number`.
 *
 * KNOWN DIVERGENCE — no `sort`. Spring's resolver also accepts `?sort=field,dir`
 * and the controllers declare a default sort, but every ported listing has a
 * fixed order (`createdAt` DESC, the `@PageableDefault` all three admin
 * endpoints declare) and no client ever sends `sort` — the Angular services
 * (`user.service.ts`, `mission.service.ts`, `audit-log.service.ts`) send only
 * `page` and their own filters. The order therefore lives in the query modules
 * rather than travelling in this object, and an arbitrary client-supplied sort
 * is not accepted at all — which is also the safer default, since a sort field
 * arriving from a query string is otherwise a column name arriving from a query
 * string.
 */
export interface PageRequest {
  /** 0-based page index. */
  page: number;
  /** Rows per page. */
  size: number;
}

/**
 * One loaded page: the rows, the request that produced them, and the total row
 * count the same filters match. The ported subset of Spring Data's `Page<T>` —
 * query modules return this, and `toPagedModel` turns it into the wire shape.
 *
 * `totalElements` is the count *ignoring* the slice (Spring runs a separate
 * `count` query for exactly this), which is what makes `totalPages` meaningful.
 */
export interface Page<T> {
  content: T[];
  request: PageRequest;
  totalElements: number;
}

/**
 * The wire envelope: Spring Data's `PagedModel<T>` JSON, field-for-field. The
 * Angular client's `PagedModel<T>` (`src/app/models/page.model.ts`) is typed
 * against precisely this, so the field names and nesting are load-bearing.
 */
export interface PagedModel<T> {
  content: T[];
  page: {
    size: number;
    /** 0-based index of this page. */
    number: number;
    totalElements: number;
    totalPages: number;
  };
}

/** The SQL `OFFSET` a page request implies. */
export function offsetOf(request: PageRequest): number {
  return request.page * request.size;
}

/**
 * Reads `?page` and `?size` out of a request's query string, applying the
 * `@PageableDefault` fallbacks.
 *
 * Mirrors `PageableHandlerMethodArgumentResolver`'s boundary handling: an
 * absent, blank or unparseable value falls back to the default; a negative page
 * index is clamped to 0; a size below 1 falls back to the default and a size
 * above `MAX_PAGE_SIZE` is capped there. Fractional and trailing-garbage input
 * (`"1.5"`, `"2x"`) is rejected rather than truncated, matching
 * `Integer.parseInt`, which throws on both.
 *
 * KNOWN DIVERGENCE (unverifiable edge case): Spring's private
 * `parseAndApplyBoundaries` appears to answer the *upper bound* rather than the
 * default when `size` fails to parse, which would make `?size=abc` mean "2000
 * rows". The Spring source was not available to confirm that against, no client
 * sends a non-numeric size, and quietly turning a typo into the largest
 * possible query is the wrong failure mode — so unparseable input falls back to
 * the default here, exactly as an omitted parameter does.
 *
 * @param params the request's `searchParams`
 * @param defaultSize the size to use when none is requested; the
 * `@PageableDefault(size = …)` of the endpoint being ported
 */
export function parsePageRequest(
  params: URLSearchParams,
  defaultSize: number = DEFAULT_PAGE_SIZE,
): PageRequest {
  const page = parseNonNegativeInt(params.get("page")) ?? 0;
  const requested = parseNonNegativeInt(params.get("size"));
  const size = requested === undefined || requested < 1 ? defaultSize : requested;
  return { page, size: Math.min(size, MAX_PAGE_SIZE) };
}

/**
 * `Integer.parseInt` with Spring's lower clamp: `undefined` for absent, blank
 * or unparseable input, and a negative number clamped to 0.
 */
function parseNonNegativeInt(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  // `Number()` would accept "1.5" and "" where `Integer.parseInt` throws, and
  // `parseInt()` would accept "2x"; this accepts exactly what Java does.
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    return undefined;
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed)) {
    return undefined;
  }
  return Math.max(parsed, 0);
}

/**
 * Applies a mapper to a page's rows, keeping the request and total intact.
 * The port of `Page.map(mapper::toResponse)` — the step every paginated
 * controller performs between its service call and `new PagedModel<>(…)`.
 */
export function mapPage<T, R>(page: Page<T>, map: (item: T) => R): Page<R> {
  return {
    content: page.content.map(map),
    request: page.request,
    totalElements: page.totalElements,
  };
}

/**
 * Wraps a loaded page into the response envelope. The port of
 * `new PagedModel<>(page)`.
 *
 * `totalPages` reproduces `Page.getTotalPages()` exactly, including its
 * degenerate case: a size of 0 answers 1 page rather than dividing by zero.
 * (`parsePageRequest` never produces a 0 size, but a hand-built `PageRequest`
 * could, and diverging here would be a silent `Infinity` in the JSON.)
 */
export function toPagedModel<T>(page: Page<T>): PagedModel<T> {
  const { size, page: number } = page.request;
  return {
    content: page.content,
    page: {
      size,
      number,
      totalElements: page.totalElements,
      totalPages: size === 0 ? 1 : Math.ceil(page.totalElements / size),
    },
  };
}
