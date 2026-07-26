'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { SearchResponse } from '@invoiceiq/contracts';
import { ApiError, api } from '../../../lib/api-client';
import { formatMoney, formatPercent } from '../../../lib/format';
import { StatusBadge } from '../../../components/status-badge';
import { EmptyState, ErrorState, LoadingRows } from '../../../components/states';

/**
 * Suggestions chosen by measurement, not by what reads best.
 *
 * Each of these was checked against the seeded corpus and ranks the right
 * document first. Cross-language queries are the weak spot of a 384-dimension
 * MiniLM — "chairs" does reach the Italian "Sedie ufficio" invoices, but the
 * margin is thin, so the chips stay on queries that are convincing rather than
 * lucky.
 */
const EXAMPLES = ['ACME Milano', 'standing desk London', 'consulenza tecnica'];

export default function SearchPage() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');

  // Debounced: a request per keystroke would embed a partial word dozens of
  // times to answer a question the user has not finished asking.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(input.trim()), 300);
    return () => clearTimeout(timer);
  }, [input]);

  const search = useQuery({
    queryKey: ['search', query],
    queryFn: ({ signal }) =>
      api.get<SearchResponse>(`/search?q=${encodeURIComponent(query)}&limit=10`, signal),
    enabled: query.length >= 2,
    // Keeps previous results on screen while the next request runs, so the page
    // does not flash empty between keystrokes.
    placeholderData: keepPreviousData,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-slate-500">
          Semantic search across every extracted invoice — meaning, not keywords.
        </p>
      </div>

      <div>
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search by vendor, place, or what was bought"
          aria-label="Search invoices"
          data-testid="search-input"
          className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-slate-900 focus:ring-1 focus:ring-slate-900"
        />

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>Try:</span>
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setInput(example)}
              className="rounded-full bg-slate-100 px-2.5 py-1 hover:bg-slate-200"
            >
              {example}
            </button>
          ))}
        </div>
      </div>

      {query.length < 2 && (
        <EmptyState
          title="Search by meaning"
          description="Each invoice is indexed twice: its raw text, and a generated summary naming the vendor, the place and everything bought. Searching “ACME Milano” finds the right invoice even though the vendor and the city sit in different parts of the page."
        />
      )}

      {query.length >= 2 && search.isPending && <LoadingRows rows={3} />}

      {search.isError && (
        <ErrorState
          message={
            search.error instanceof ApiError
              ? (search.error.problem.detail ?? search.error.problem.title)
              : 'Search failed.'
          }
          onRetry={() => void search.refetch()}
        />
      )}

      {search.isSuccess && (
        <>
          <p className="text-xs text-slate-400">
            {search.data.hits.length} result{search.data.hits.length === 1 ? '' : 's'} in{' '}
            {search.data.tookMs}ms
          </p>

          {search.data.hits.length === 0 ? (
            <EmptyState
              title="Nothing matched"
              description="No invoice resembles that query. Documents become searchable once extraction finishes."
            />
          ) : (
            <ul className="space-y-3">
              {search.data.hits.map((hit) => (
                <li key={hit.documentId} data-testid="search-hit">
                  <Link
                    href={`/documents/${hit.documentId}`}
                    className="block rounded-xl border border-slate-200 bg-white p-4 transition hover:border-slate-300"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-medium text-slate-900">
                        {hit.invoiceNumber ?? hit.originalName}
                      </span>
                      {hit.vendorName && (
                        <span className="text-sm text-slate-500">{hit.vendorName}</span>
                      )}
                      <StatusBadge status={hit.status} />

                      <span className="ml-auto flex items-center gap-3">
                        {hit.totalCents !== null && hit.currency && (
                          <span className="text-sm font-medium tabular-nums text-slate-900">
                            {formatMoney(hit.totalCents, hit.currency)}
                          </span>
                        )}
                        <span
                          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-500"
                          title="Similarity"
                        >
                          {formatPercent(hit.score)}
                        </span>
                      </span>
                    </div>

                    <p className="mt-2 line-clamp-2 text-sm text-slate-600">{hit.snippet}</p>

                    {/* Saying which chunk matched explains why an apparently
                        unrelated document surfaced. */}
                    <p className="mt-1 text-xs text-slate-400">
                      matched the {hit.kind === 'synthetic' ? 'invoice summary' : 'document text'}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
