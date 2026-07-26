'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import type { DocumentStatus, ListDocumentsResponse } from '@invoiceiq/contracts';
import { ApiError, api } from '../../../lib/api-client';
import { formatBytes, formatRelative } from '../../../lib/format';
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
     * Poll only while something is actually moving.
     *
     * A fixed interval would keep hammering the API for a list of finished
     * documents forever. Polling stops the moment nothing is in flight, and
     * resumes on the next upload — this is also the seam where SSE replaces
     * polling in M11 without the components changing at all.
     */
    refetchInterval: (query) =>
      query.state.data?.items.some((d) => isInFlight(d.status)) ? 2_000 : false,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-1 text-sm text-slate-500">
          Upload an invoice and watch it move through extraction and validation.
        </p>
      </div>

      <StatStrip />

      <UploadDropzone />

      <div className="flex items-center gap-1">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setFilter(option.value)}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              filter === option.value
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:bg-slate-100'
            }`}
          >
            {option.label}
          </button>
        ))}
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

      {query.isSuccess && query.data.items.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3 font-medium">Document</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Size</th>
                <th className="px-4 py-3 font-medium">Uploaded</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {query.data.items.map((document) => (
                <tr key={document.id} className="hover:bg-slate-50" data-testid="document-row">
                  <td className="max-w-xs px-4 py-3">
                    <p className="truncate font-medium text-slate-900">{document.originalName}</p>
                    {document.failureReason && (
                      <p
                        className="mt-0.5 truncate text-xs text-rose-600"
                        title={document.failureReason}
                      >
                        {document.failureReason}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={document.status} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-slate-500">
                    {formatBytes(document.sizeBytes)}
                  </td>
                  <td className="px-4 py-3 text-slate-500">{formatRelative(document.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {/* Only offer a link where there is something to look at. */}
                    {document.status !== 'FAILED' && (
                      <Link
                        href={`/documents/${document.id}`}
                        className="text-sm font-medium text-slate-900 hover:underline"
                      >
                        {document.status === 'NEEDS_REVIEW' ? 'Review' : 'View'}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
