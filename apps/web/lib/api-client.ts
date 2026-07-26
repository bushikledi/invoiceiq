import type { ProblemDetails } from '@invoiceiq/contracts';

/**
 * The API client.
 *
 * Two decisions shape this file:
 *
 * 1. The access token lives in a module variable, never localStorage. Anything
 *    in localStorage is readable by any script that manages to run on the page,
 *    so an XSS becomes a stolen session that outlives the tab. In memory, the
 *    worst case is the lifetime of the compromised page. The refresh token is
 *    an httpOnly cookie the JavaScript cannot read at all.
 *
 * 2. A 401 triggers exactly one refresh-and-retry, and concurrent 401s share a
 *    single refresh. Without that sharing, a screen that fires four queries on
 *    mount would send four refreshes — and since refresh tokens rotate, three
 *    of them would present an already-used token and trip the reuse detector,
 *    logging the user out for doing nothing wrong.
 */

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';
const BASE = `${API_URL}/api/v1`;

let accessToken: string | null = null;
/** Shared across concurrent 401s so only one refresh is ever in flight. */
let refreshInFlight: Promise<boolean> | null = null;
let onUnauthorized: (() => void) | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};

export const getAccessToken = (): string | null => accessToken;

/** Lets the auth provider redirect to login when refreshing is hopeless. */
export const setUnauthorizedHandler = (handler: (() => void) | null): void => {
  onUnauthorized = handler;
};

export class ApiError extends Error {
  constructor(
    readonly problem: ProblemDetails,
    readonly status: number,
  ) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /** Field-level messages, keyed by path, for inline form errors. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.problem.errors ?? []).map((e) => [e.path, e.message]));
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Set for auth calls, which must not recurse into the refresh path. */
  skipAuthRetry?: boolean;
  signal?: AbortSignal;
}

async function raw(path: string, options: RequestOptions = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    // Required for the refresh cookie. The API allows this exact origin — a
    // wildcard CORS policy is incompatible with credentialed requests.
    credentials: 'include',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function refreshSession(): Promise<boolean> {
  // Collapse concurrent refreshes: rotation means the second one would present
  // a token the first already burnt, and reuse detection would revoke the
  // entire family.
  refreshInFlight ??= (async () => {
    try {
      const response = await raw('/auth/refresh', { method: 'POST', skipAuthRetry: true });
      if (!response.ok) return false;

      const data = (await response.json()) as { accessToken: string };
      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see the
      // same result before a new refresh can start.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await raw(path, options);

  if (response.status === 401 && !options.skipAuthRetry) {
    const refreshed = await refreshSession();

    if (refreshed) {
      response = await raw(path, options);
    } else {
      accessToken = null;
      onUnauthorized?.();
    }
  }

  if (!response.ok) {
    throw new ApiError(await toProblem(response), response.status);
  }

  // 204 and friends have no body to parse.
  if (response.status === 204) return undefined as T;

  return (await response.json()) as T;
}

async function toProblem(response: Response): Promise<ProblemDetails> {
  try {
    return (await response.json()) as ProblemDetails;
  } catch {
    // A proxy timeout or a crashed process returns HTML, not our envelope.
    return {
      type: 'internal_error',
      title: 'Request failed',
      status: response.status,
      detail: `The server returned ${response.status} ${response.statusText}.`,
      traceId: response.headers.get('x-trace-id') ?? 'unknown',
    };
  }
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  /** Auth calls bypass the retry path — refreshing a failed login makes no sense. */
  auth: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: 'POST', body, skipAuthRetry: true }),
};
