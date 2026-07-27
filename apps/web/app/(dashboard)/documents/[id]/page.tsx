'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Correction,
  DocumentDetail,
  DocumentFileResponse,
  DocumentSummary,
  ReviewResponse,
} from '@invoiceiq/contracts';
import { useToast } from '../../../../lib/toast';
import { ApiError, api } from '../../../../lib/api-client';
import { formatCost, formatDate, formatDateTime, formatMoney } from '../../../../lib/format';
import { StatusBadge, isInFlight } from '../../../../components/status-badge';
import { ConfidenceBar, ErrorState, LoadingRows } from '../../../../components/states';
import { FindingsBanner } from '../../../../components/review/findings-banner';
import { EditableField } from '../../../../components/review/editable-field';

export default function ReviewPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { notify } = useToast();

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
    onSuccess: async (_result, variables) => {
      setEdits({});
      setSubmitError(null);
      notify(
        variables.action === 'CORRECTED'
          ? 'Corrections saved and approved.'
          : 'Approved.',
        'success',
      );
      await queryClient.invalidateQueries({ queryKey: ['document', id] });
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
      await queryClient.invalidateQueries({ queryKey: ['document-stats'] });
    },
    onError: (error) => {
      // The server is the authority: if it says the corrected data still fails,
      // the edits stay on screen so the reviewer can fix them rather than
      // losing their work to a rejected save.
      setSubmitError(error instanceof ApiError ? error : null);
    },
  });

  const requeue = useMutation({
    mutationFn: () => api.post<DocumentSummary>(`/documents/${id}/requeue`),
    onSuccess: async () => {
      notify('Back in the queue.', 'success');
      await queryClient.invalidateQueries({ queryKey: ['document', id] });
      await queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
    onError: (error) => {
      notify(
        error instanceof ApiError
          ? (error.problem.detail ?? error.problem.title)
          : 'Could not requeue this document.',
        'error',
      );
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
          <Link href="/documents" className="text-sm text-ink-muted hover:underline">
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
        <div className="space-y-3">
          <ErrorState
            title="Extraction failed"
            message={document_.failureReason ?? 'No reason was recorded.'}
          />
          {/* A failure screen with no way forward is a dead end. Most failures
              here are transient — an expired key, a provider outage — and
              re-uploading is not a workaround, because the server correctly
              rejects the identical bytes as a duplicate. */}
          <button
            type="button"
            onClick={() => requeue.mutate()}
            disabled={requeue.isPending}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-surface-muted disabled:opacity-60"
          >
            {requeue.isPending ? 'Requeueing…' : 'Try this document again'}
          </button>
        </div>
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
        <ul className="space-y-1 rounded-lg border border-critical-line bg-critical-soft p-4 text-sm text-critical-ink">
          {submitError.problem.errors.map((issue, i) => (
            <li key={i}>{issue.message}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
        {/*
          PDF pane, pinned on desktop.

          Reviewing means checking a field against the document, and the fields
          column is far taller than the PDF. Without `sticky`, scrolling to the
          totals scrolls the evidence off-screen — so the reviewer is comparing
          a number against their memory of a page they can no longer see, which
          is exactly the comparison this screen exists to avoid.

          On mobile the two stack and the viewer is shorter: 70vh of PDF above
          the fields means scrolling past a full screen of document before
          reaching the first thing that can be edited.
        */}
        <div className="rounded-xl border border-line bg-surface p-1 lg:sticky lg:top-20">
          {file.data ? (
            <object
              data={file.data.url}
              type="application/pdf"
              className="h-[45vh] w-full rounded-lg lg:h-[calc(100vh-8rem)]"
              aria-label="Invoice PDF"
            >
              {/* Browsers without an inline PDF viewer must still offer the file. */}
              <div className="flex h-full items-center justify-center">
                <a
                  href={file.data.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium text-ink underline"
                >
                  Open the PDF
                </a>
              </div>
            </object>
          ) : (
            <div className="flex h-[45vh] items-center justify-center text-sm text-ink-subtle lg:h-[calc(100vh-8rem)]">
              {file.isError ? 'Could not load the PDF' : 'Loading PDF…'}
            </div>
          )}
        </div>

        {/* Fields pane */}
        <div className="space-y-4">
          {!data && (
            <div className="rounded-xl border border-line bg-surface p-6 text-sm text-ink-muted">
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
                <div className="divide-y divide-line">
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
                      <div className="flex items-baseline justify-between gap-4 pl-4 text-xs text-ink-subtle">
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
                <div className="border-t border-line pt-1">
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
                /*
                 * Pinned to the bottom of the viewport.
                 *
                 * A long invoice pushes the approve button below the fold, and
                 * the reviewer's last action before deciding is to scroll to
                 * the totals — so the control they need is furthest away
                 * exactly when they want it. Keeping it in view also keeps the
                 * pending-correction count visible while editing, which is the
                 * only running indication that an edit registered at all.
                 */
                <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface/95 p-4 shadow-lg backdrop-blur">
                  <button
                    type="button"
                    onClick={approve}
                    disabled={submit.isPending}
                    data-testid="approve-button"
                    className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent-hover disabled:opacity-60"
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
                      className="text-sm text-ink-muted transition hover:text-ink"
                    >
                      Discard changes
                    </button>
                  )}

                  {/* Shortcuts are worthless if nobody knows they exist, and a
                      reviewer processing a queue is precisely who benefits. */}
                  <span className="ml-auto hidden items-center gap-2 text-xs text-ink-subtle sm:flex">
                    <Shortcut keyLabel="A" description="approve" />
                    <Shortcut keyLabel="E" description="first flagged field" />
                  </span>
                </div>
              )}

              <div className="rounded-xl border border-line bg-surface p-4 text-xs text-ink-muted">
                <p className="mb-2 font-medium text-ink">Extraction</p>
                <dl className="grid grid-cols-2 gap-y-1">
                  <dt>Model</dt>
                  <dd className="text-right text-ink">{extraction.model}</dd>
                  <dt>Prompt</dt>
                  <dd className="text-right text-ink">{extraction.promptVersion}</dd>
                  <dt>Attempts</dt>
                  <dd className="text-right text-ink">{extraction.attempts}</dd>
                  <dt>Version</dt>
                  <dd className="text-right text-ink">v{extraction.version}</dd>
                  <dt>Cost</dt>
                  <dd className="text-right text-ink">{formatCost(extraction.costUsd)}</dd>
                  <dt>Extracted</dt>
                  <dd className="text-right text-ink">{formatDate(extraction.createdAt)}</dd>
                </dl>
              </div>
            </>
          )}

          <details className="rounded-xl border border-line bg-surface p-4">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              Timeline ({document_.events.length})
            </summary>
            <ol className="mt-3 space-y-2">
              {document_.events.map((event) => (
                <li key={event.id} className="flex gap-3 text-xs">
                  <span className="shrink-0 tabular-nums text-ink-subtle">
                    {formatDateTime(event.createdAt)}
                  </span>
                  <span className="text-ink">
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
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">{title}</h2>
      {children}
    </section>
  );
}

function Shortcut({ keyLabel, description }: { keyLabel: string; description: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <kbd className="rounded border border-line bg-surface-muted px-1.5 py-0.5 font-sans text-[0.7rem] text-ink-muted">
        {keyLabel}
      </kbd>
      {description}
    </span>
  );
}
