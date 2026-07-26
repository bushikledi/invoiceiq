'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from './api-client';

/**
 * TanStack Query owns all server state.
 *
 * The retry policy is the part worth reading: a 4xx means the request was
 * wrong and repeating it will produce the same answer, so only network and 5xx
 * failures are retried. Retrying a 422 just delays showing the user the
 * validation message they need to act on.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status < 500) return false;
              return failureCount < 2;
            },
            refetchOnWindowFocus: false,
          },
          mutations: {
            // A mutation that failed validation must never be retried silently:
            // the user needs to see why and change something.
            retry: false,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
