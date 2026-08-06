// Mini HTTP request router — fixture codebase for the divert eval.
// Self-contained on purpose; not production code.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RequestContext {
  method: HttpMethod;
  path: string;
  headers: Record<string, string>;
  query: URLSearchParams;
  body?: string;
}

export interface RouteResult {
  matched: boolean;
  handlerName?: string;
  params: Record<string, string>;
  allowedMethods?: HttpMethod[];
}

export type Handler = (ctx: RequestContext, params: Record<string, string>) => RouteResult;

interface CompiledRoute {
  method: HttpMethod;
  segments: Segment[];
  handlerName: string;
  handler: Handler;
}

type Segment = { kind: 'static'; value: string } | { kind: 'param'; name: string };

/**
 * Compile a path pattern like `/users/:id/posts` into ordered segments,
 * separating static literals from named parameters.
 */
function compilePattern(pattern: string): Segment[] {
  return pattern
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith(':') ? { kind: 'param' as const, name: s.slice(1) } : { kind: 'static' as const, value: s }));
}

/** Split a raw request path into non-empty segments. */
function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

/**
 * Match a single route against path segments, returning its params on a hit.
 * A hit requires equal length and per-segment agreement (static equal, param
 * captures). This is the per-candidate test run by matchRoute.
 */
function matchOne(route: CompiledRoute, segments: string[]): Record<string, string> | null {
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < route.segments.length; i++) {
    const seg = route.segments[i];
    if (seg.kind === 'static') {
      if (seg.value !== segments[i]) return null;
    } else {
      params[seg.name] = decodeURIComponent(segments[i]);
    }
  }
  return params;
}

/** Uppercase + trim a method string, defaulting to GET on empty input. */
function normalizeMethod(raw: string | undefined): HttpMethod {
  const upper = (raw ?? 'GET').trim().toUpperCase();
  return (upper || 'GET') as HttpMethod;
}

/**
 * Route table: registers (method, pattern) -> handler bindings and answers
 * lookups via matchRoute. Methods are case-insensitive on registration.
 */
export class RouteTable {
  private readonly routes: CompiledRoute[] = [];

  register(method: HttpMethod, pattern: string, handlerName: string, handler: Handler): this {
    this.routes.push({ method: normalizeMethod(method), segments: compilePattern(pattern), handlerName, handler });
    return this;
  }

  /** Return every compiled route whose path matches, regardless of method. */
  pathMatches(segments: string[]): CompiledRoute[] {
    return this.routes.filter((r) => matchOne(r, segments) !== null);
  }

  /** Find the best route: exact method match wins; otherwise gather allowed
   *  methods for a 405-style response. */
  matchRoute(method: HttpMethod, segments: string[]): RouteResult {
    const norm = normalizeMethod(method);
    const pathMatches = this.pathMatches(segments);
    const exact = pathMatches.find((r) => r.method === norm);
    if (exact) {
      const params = matchOne(exact, segments) ?? {};
      return exact.handler({ method: norm, path: '/' + segments.join('/'), headers: {}, query: new URLSearchParams() }, params);
    }
    if (pathMatches.length > 0) {
      return { matched: false, params: {}, allowedMethods: Array.from(new Set(pathMatches.map((r) => r.method))) };
    }
    return { matched: false, params: {} };
  }
}

/**
 * Entry point: route an incoming request against the table. This is the symbol
 * the divert eval asks the agent to locate (parameter list below).
 *
 * routeRequest(ctx: RequestContext, table: RouteTable): RouteResult
 */
export function routeRequest(ctx: RequestContext, table: RouteTable): RouteResult {
  return table.matchRoute(normalizeMethod(ctx.method), splitPath(ctx.path));
}

/** Build a RequestContext from raw, loosely-typed handler input. */
export function buildContext(
  method: string | undefined,
  path: string,
  headers: Record<string, string> = {},
  query: URLSearchParams = new URLSearchParams(),
  body?: string,
): RequestContext {
  return { method: normalizeMethod(method), path, headers, query, body };
}

/** Default table wired with a couple of sample routes for smoke checks. */
export function defaultTable(): RouteTable {
  const ok: Handler = (_ctx, params) => ({ matched: true, params });
  return new RouteTable()
    .register('GET', '/health', 'health', ok)
    .register('GET', '/users/:id', 'getUser', ok)
    .register('POST', '/users', 'createUser', ok)
    .register('GET', '/users/:id/posts/:postId', 'getUserPost', ok);
}
