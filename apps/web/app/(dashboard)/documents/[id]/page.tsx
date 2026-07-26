'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Correction,
  DocumentDetail,
  DocumentFileResponse,
  ReviewResponse,
} from '@invoiceiq/contracts';
import { ApiError, api } from '../../../../lib/api-client';
import { formatCost, formatDate, formatDateTime, formatMoney } from '../../../../lib/format';
import { StatusBadge, isInFlight } from '../../../../components/status-badge';
import { ConfidenceBar, ErrorState, LoadingRows } from '../../../../components/states';
import { FindingsBanner } from '../../../../components/review/findings-banner';
import { EditableField } from '../../../../components/review/editable-field';

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();

  /** Pending edits, keyed by path. Empty means nothing has been changed. */
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const [submitError, setSubmitError] = useState<ApiError | null>(null);

  const detail = useQuery({
    queryKey: ['document', id],
    queryFn: ({ signal }) => api.get<DocumentDetail>(`/documents/${id}/detail`, signal),
    refetchInterval: (query) =>
      query.state.data && isInFlight(query.state.data.status) ? 2_000 : false,
  });

  const file = useQuery({
    queryKey: ['document-file', id],
    queryFn: () => api.get<DocumentFileResponse>(`/documents/${id}/file`),
    // Presigned URLs are short-lived; refresh before they lapse so a reviewer
    // reading a long invoice does not watch the PDF pane break.
    refetchInterval: 4 * 60_000,
    enabled: detail.isSuccess,
  });

  const extraction = detail.data?.extraction ?? null;
  const data = extraction?.data ?? null;
  const canReview = detail.data?.status === 'NEEDS_REVIEW';

  const corrections = useMemo<Correction[]>(
    () => Object.entries(edits).map(([path, value]) => ({ path, value })),
    [edits],
  );

  const submit = useMutation({
    mutationFn: (body: { action: 'APPROVED' | 'CORRECTED'; corrections?: Correction[] }) =>
      api.post<ReviewResponse>(`/documents/${id}/review`, body),
    onSuccess: async () => {
      setEdits({});
      setSubmitError(null);
      await queryClient.invalidateQueries({ queryKey: ['document', id] });
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (error) => {
      // The server is the authority: if it says the corrected data still fails,
      // the edits stay on screen so the reviewer can fix them rather than
      // losing their work to a rejected save.
      setSubmitError(error instanceof ApiError ? error : null);
    },
  });

  const approve = useCallback(() => {
    setSubmitError(null);
    submit.mutate(
      corrections.length > 0 ? { action: 'CORRECTED', corrections } : { action: 'APPROVED' },
    );
  }, [corrections, submit]);

  const setField = useCallback((path: string, value: unknown) => {
    setEdits((current) => ({ ...current, [path]: value }));
  }, []);

  /** Keyboard shortcuts — reviewers live on keyboards. */
  useEffect(() => {
    if (!canReview) return;

    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never hijack a key the reviewer is typing into a field.
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;

      if (event.key.toLowerCase() === 'a' && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        approve();
      }
      if (event.key.toLowerCase() === 'e') {
        event.preventDefault();
        const firstFlagged = document.querySelector<HTMLElement>('[data-flagged="true"]');
        firstFlagged?.click();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canReview, approve]);

  if (detail.isPending) return <LoadingRows rows={6} />;

  if (detail.isError) {
    return (
      <ErrorState
        message={
          detail.error instanceof ApiError
            ? (detail.error.problem.detail ?? detail.error.problem.title)
            : 'Could not load this document.'
        }
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const document_ = detail.data;
  const value = (path: string, fallback: unknown) => (path in edits ? edits[path] : fallback);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link href="/documents" className="text-sm text-slate-500 hover:underline">
            ← Documents
          </Link>
          <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">
            {document_.originalName}
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <StatusBadge status={document_.status} />
          {extraction && <ConfidenceBar value={extraction.overallConfidence} />}
        </div>
      </div>

      {document_.status === 'FAILED' && (
        <ErrorState
          title="Extraction failed"
          message={document_.failureReason ?? 'No reason was recorded.'}
        />
      )}

      {extraction && <FindingsBanner findings={extraction.findings} />}

      {submitError && (
        <ErrorState
          title="The server rejected this correction"
          message={submitError.problem.detail ?? submitError.problem.title}
          traceId={submitError.problem.traceId}
        />
      )}
      {submitError?.problem.errors && submitError.problem.errors.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {submitError.problem.errors.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* PDF pane */}
        <div className="rounded-xl border border-slate-200 bg-white p-1">
          {file.data ? (
            <object
              data={file.data.url}
              type="application/pdf"
              className="h-[70vh] w-full rounded-lg"
              aria-label="Invoice PDF"
            >
              {/* Browsers without an inline PDF viewer must still offer the file. */}
              <div className="flex h-full items-center justify-center">
                <a
                  href={file.data.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-slate-900 underline"
                >
                  Open the PDF
                </a>
              </div>
            </object>
          ) : (
            <div className="flex h-[70vh] items-center justify-center text-sm text-slate-400">
              {file.isError ? 'Could not load the PDF' : 'Loading PDF…'}
            </div>
          )}
        </div>

        {/* Fields pane */}
        <div className="space-y-4">
          {!data && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
              {isInFlight(document_.status)
                ? 'Extraction is still running…'
                : 'No extraction is available for this document.'}
            </div>
          )}

          {data && extraction && (
            <>
              <Section title="Vendor">
                <EditableField
                  label="Name"
                  path="vendor.name"
                  value={value('vendor.name', data.vendor.name) as string}
                  meta={extraction.fieldMeta['vendor.name']}
                  onChange={setField}
                  editable={canReview}
                />
                <EditableField
                  label="VAT number"
                  path="vendor.vatNumber"
                  value={value('vendor.vatNumber', data.vendor.vatNumber) as string | null}
                  meta={extraction.fieldMeta['vendor.vatNumber']}
                  onChange={setField}
                  editable={canReview}
                />
                <EditableField
                  label="Address"
                  path="vendor.address"
                  value={value('vendor.address', data.vendor.address) as string | null}
                  meta={extraction.fieldMeta['vendor.address']}
                  onChange={setField}
                  editable={canReview}
                />
              </Section>

              <Section title="Invoice">
                <EditableField
                  label="Number"
                  path="invoiceNumber"
                  value={value('invoiceNumber', data.invoiceNumber) as string}
                  meta={extraction.fieldMeta['invoiceNumber']}
                  onChange={setField}
                  editable={canReview}
                />
                <EditableField
                  label="Issued"
                  path="issueDate"
                  kind="date"
                  value={value('issueDate', data.issueDate) as string}
                  meta={extraction.fieldMeta['issueDate']}
                  onChange={setField}
                  editable={canReview}
                />
                <EditableField
                  label="Due"
                  path="dueDate"
                  kind="date"
                  value={value('dueDate', data.dueDate) as string | null}
                  meta={extraction.fieldMeta['dueDate']}
                  onChange={setField}
                  editable={canReview}
                />
              </Section>

              <Section title={`Line items (${data.lineItems.length})`}>
                <div className="divide-y divide-slate-100">
                  {data.lineItems.map((item, index) => (
                    <div key={index} className="py-2">
                      <EditableField
                        label={`${index + 1}. Description`}
                        path={`lineItems[${index}].description`}
                        value={value(`lineItems[${index}].description`, item.description) as string}
                        meta={extraction.fieldMeta[`lineItems[${index}].description`]}
                        onChange={setField}
                        editable={canReview}
                      />
                      <div className="flex items-baseline justify-between gap-4 pl-4 text-xs text-slate-400">
                        <span>
                          {item.quantity} × {formatMoney(item.unitPriceCents, data.currency)}
                          {' · VAT '}
                          {item.vatRatePercent}%
                        </span>
                      </div>
                      <EditableField
                        label="Line total"
                        path={`lineItems[${index}].totalCents`}
                        kind="money"
                        currency={data.currency}
                        value={value(`lineItems[${index}].totalCents`, item.totalCents) as number}
                        meta={extraction.fieldMeta[`lineItems[${index}].totalCents`]}
                        onChange={setField}
                        editable={canReview}
                      />
                    </div>
                  ))}
                </div>
              </Section>

              <Section title="Totals">
                <EditableField
                  label="Subtotal"
                  path="subtotalCents"
                  kind="money"
                  currency={data.currency}
                  value={value('subtotalCents', data.subtotalCents) as number}
                  meta={extraction.fieldMeta['subtotalCents']}
                  onChange={setField}
                  editable={canReview}
                />
                <EditableField
                  label="VAT"
                  path="vatTotalCents"
                  kind="money"
                  currency={data.currency}
                  value={value('vatTotalCents', data.vatTotalCents) as number}
                  meta={extraction.fieldMeta['vatTotalCents']}
                  onChange={setField}
                  editable={canReview}
                />
                <div className="border-t border-slate-200 pt-1">
                  <EditableField
                    label="Total"
                    path="totalCents"
                    kind="money"
                    currency={data.currency}
                    value={value('totalCents', data.totalCents) as number}
                    meta={extraction.fieldMeta['totalCents']}
                    onChange={setField}
                    editable={canReview}
                  />
                </div>
              </Section>

              {canReview && (
                <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
                  <button
                    type="button"
                    onClick={approve}
                    disabled={submit.isPending}
                    data-testid="approve-button"
                    className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
                  >
                    {submit.isPending
                      ? 'Saving…'
                      : corrections.length > 0
                        ? `Save ${corrections.length} correction${corrections.length === 1 ? '' : 's'} & approve`
                        : 'Approve'}
                  </button>

                  {corrections.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setEdits({})}
                      className="text-sm text-slate-500 hover:text-slate-900"
                    >
                      Discard changes
                    </button>
                  )}

                  <span className="ml-auto hidden text-xs text-slate-400 sm:inline">
                    Press <kbd className="rounded border px-1">A</kbd> to approve
                  </span>
                </div>
              )}

              <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-500">
                <p className="mb-2 font-medium text-slate-700">Extraction</p>
                <dl className="grid grid-cols-2 gap-y-1">
                  <dt>Model</dt>
                  <dd className="text-right text-slate-700">{extraction.model}</dd>
                  <dt>Prompt</dt>
                  <dd className="text-right text-slate-700">{extraction.promptVersion}</dd>
                  <dt>Attempts</dt>
                  <dd className="text-right text-slate-700">{extraction.attempts}</dd>
                  <dt>Version</dt>
                  <dd className="text-right text-slate-700">v{extraction.version}</dd>
                  <dt>Cost</dt>
                  <dd className="text-right text-slate-700">{formatCost(extraction.costUsd)}</dd>
                  <dt>Extracted</dt>
                  <dd className="text-right text-slate-700">{formatDate(extraction.createdAt)}</dd>
                </dl>
              </div>
            </>
          )}

          <details className="rounded-xl border border-slate-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-medium text-slate-700">
              Timeline ({document_.events.length})
            </summary>
            <ol className="mt-3 space-y-2">
              {document_.events.map((event) => (
                <li key={event.id} className="flex gap-3 text-xs">
                  <span className="shrink-0 tabular-nums text-slate-400">
                    {formatDateTime(event.createdAt)}
                  </span>
                  <span className="text-slate-700">
                    {event.type}
                    {typeof event.payload['to'] === 'string' && ` → ${event.payload['to']}`}
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{title}</h2>
      {children}
    </section>
  );
}
