'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { DocumentStatus, DocumentSummary, ListDocumentsResponse } from '@invoiceiq/contracts';
import { ApiError, api } from '../../../lib/api-client';
import { formatBytes, formatRelative } from '../../../lib/format';
import { useToast } from '../../../lib/toast';
import { StatusBadge, isInFlight } from '../../../components/status-badge';
import { EmptyState, ErrorState, LoadingRows } from '../../../components/states';
import { UploadDropzone } from '../../../components/upload-dropzone';
import { StatStrip } from '../../../components/stat-strip';

const FILTERS: { label: string; value: DocumentStatus | 'ALL' }[] = [
  { label: 'All', value: 'ALL' },
  { label: 'Needs review', value: 'NEEDS_REVIEW' },
  { label: 'Completed', value: 'COMPLETED' },
  { label: 'Failed', value: 'FAILED' },
];

export default function DocumentsPage() {
  const [filter, setFilter] = useState<DocumentStatus | 'ALL'>('ALL');

  const query = useQuery({
    queryKey: ['documents', filter],
    queryFn: ({ signal }) =>
      api.get<ListDocumentsResponse>(
        `/documents?limit=50${filter === 'ALL' ? '' : `&status=${filter}`}`,
        signal,
      ),
    /**
     * Polling is now the *fallback*, not the mechanism.
     *
     * The SSE stream in the layout invalidates this query the moment a status
     * changes, so the common path needs no polling at all. This interval covers
     * only the case where the stream is down — Redis restarting, a proxy
     * dropping the connection — and it stays slow on purpose: it exists so the
     * UI eventually catches up, not so it feels fast, and pub/sub having no
     * delivery guarantee means "eventually" has to come from somewhere.
     */
    refetchInterval: (query) =>
      query.state.data?.items.some((d) => isInFlight(d.status)) ? 5_000 : false,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Documents</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Upload an invoice and watch it move through extraction and validation.
        </p>
      </div>

      <StatStrip />

      <UploadDropzone />

      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              aria-pressed={active}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                active
                  ? 'bg-accent font-medium text-accent-ink'
                  : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {query.isPending && <LoadingRows rows={4} />}

      {query.isError && (
        <ErrorState
          message={
            query.error instanceof ApiError
              ? (query.error.problem.detail ?? query.error.problem.title)
              : 'Could not load documents.'
          }
          {...(query.error instanceof ApiError ? { traceId: query.error.problem.traceId } : {})}
          onRetry={() => void query.refetch()}
        />
      )}

      {query.isSuccess && query.data.items.length === 0 && (
        <EmptyState
          title={filter === 'ALL' ? 'No documents yet' : 'Nothing here'}
          description={
            filter === 'ALL'
              ? 'Drop a PDF above to run it through the pipeline.'
              : 'No documents currently have this status.'
          }
        />
      )}

      {query.isSuccess && query.data.items.length > 0 && <DocumentList items={query.data.items} />}
    </div>
  );
}

/**
 * One dataset, two presentations.
 *
 * Below `md` the table becomes a stack of cards. A four-column table on a
 * 375px screen either overflows horizontally — so the status column, the one
 * thing being scanned for, sits off-screen — or crushes the filename to three
 * characters. Neither is a table anyone can read, so at that width it stops
 * being a table.
 *
 * The card list is `role="list"` rather than a real `<ul>` of `<li>` only
 * because the same rows also render inside `<tbody>` at wider widths; keeping
 * one component and switching the wrapper is what stops the two from drifting.
 */
function DocumentList({ items }: { items: DocumentSummary[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-line bg-surface md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">Uploaded documents with their processing status</caption>
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
              <th scope="col" className="px-4 py-3 font-medium">
                Document
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Size
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                Uploaded
              </th>
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {items.map((document) => (
              <tr
                key={document.id}
                className="transition hover:bg-surface-muted"
                data-testid="document-row"
              >
                <td className="max-w-xs px-4 py-3">
                  <p className="truncate font-medium text-ink">{document.originalName}</p>
                  {document.failureReason && (
                    <p
                      className="mt-0.5 truncate text-xs text-critical-ink"
                      title={document.failureReason}
                    >
                      {document.failureReason}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={document.status} />
                </td>
                <td className="px-4 py-3 tabular-nums text-ink-muted">
                  {formatBytes(document.sizeBytes)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-ink-muted">
                  {formatRelative(document.createdAt)}
                </td>
                <td className="px-4 py-3 text-right">
                  <RowActions document={document} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="space-y-2 md:hidden">
        {items.map((document) => (
          <li
            key={document.id}
            className="rounded-xl border border-line bg-surface p-4"
            data-testid="document-row"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 flex-1 truncate font-medium text-ink">
                {document.originalName}
              </p>
              <StatusBadge status={document.status} />
            </div>

            {document.failureReason && (
              <p className="mt-1 text-xs text-critical-ink">{document.failureReason}</p>
            )}

            <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-muted">
              <span className="tabular-nums">
                {formatBytes(document.sizeBytes)} · {formatRelative(document.createdAt)}
              </span>
              <RowActions document={document} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * What can be done with this row, given its status.
 *
 * A FAILED document gets a requeue button rather than a dead end. Before this,
 * the only recovery from a transient failure — an expired key, a provider
 * outage — was to re-upload the file, and the server would then reject the
 * bytes as a duplicate. The operator was left with a permanently broken row and
 * no legitimate way to retry it.
 */
function RowActions({ document }: { document: DocumentSummary }) {
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const requeue = useMutation({
    mutationFn: () => api.post<DocumentSummary>(`/documents/${document.id}/requeue`),
    onSuccess: async () => {
      notify(`${document.originalName} is back in the queue.`, 'success');
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      await queryClient.invalidateQueries({ queryKey: ['document-stats'] });
    },
    onError: (error) => {
      // The server's refusal is the useful message — it distinguishes "never"
      // from "not yet, it has been running four minutes". Replacing it with a
      // generic failure would throw away the only actionable part.
      notify(
        error instanceof ApiError
          ? (error.problem.detail ?? error.problem.title)
          : 'Could not requeue this document.',
        'error',
      );
    },
  });

  if (document.status === 'FAILED') {
    return (
      <button
        type="button"
        onClick={() => requeue.mutate()}
        disabled={requeue.isPending}
        className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink transition hover:bg-surface-muted disabled:opacity-60"
      >
        {requeue.isPending ? 'Requeueing…' : 'Requeue'}
      </button>
    );
  }

  return (
    <Link
      href={`/documents/${document.id}`}
      className="text-sm font-medium text-ink hover:underline"
    >
      {document.status === 'NEEDS_REVIEW' ? 'Review' : 'View'}
      {/* The visible label repeats on every row, so it says nothing about
          *which* document out of context — which is exactly how a screen
          reader's link list presents it. */}
      <span className="sr-only"> {document.originalName}</span>
    </Link>
  );
}
