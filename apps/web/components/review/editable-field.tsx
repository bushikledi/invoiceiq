'use client';

import { useEffect, useRef, useState } from 'react';
import type { FieldScore } from '@invoiceiq/contracts';
import { formatMoney } from '../../lib/format';

/**
 * An inline-editable extracted field.
 *
 * Flagged fields get an amber outline and a tooltip explaining *why* the value
 * is doubted — "does not appear in the document" and "the model reported low
 * confidence" send a reviewer to different places, and collapsing both into a
 * generic warning wastes the entire confidence policy.
 *
 * Money is edited in major units because nobody types cents, and converted back
 * on save. The conversion rounds rather than truncates, so 12.345 becomes 1235
 * rather than silently losing half a cent.
 */
export function EditableField({
  label,
  path,
  value,
  meta,
  kind = 'text',
  currency,
  onChange,
  editable = true,
}: {
  label: string;
  path: string;
  value: string | number | null;
  meta?: FieldScore | undefined;
  kind?: 'text' | 'money' | 'date' | 'number';
  currency?: string;
  onChange: (path: string, value: string | number | null) => void;
  editable?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const flagged = meta?.flagged ?? false;

  const display =
    value === null || value === ''
      ? '—'
      : kind === 'money' && typeof value === 'number'
        ? formatMoney(value, currency ?? 'EUR')
        : String(value);

  function beginEdit() {
    if (!editable) return;
    setDraft(
      value === null
        ? ''
        : kind === 'money' && typeof value === 'number'
          ? (value / 100).toFixed(2)
          : String(value),
    );
    setEditing(true);
  }

  function commit() {
    setEditing(false);

    if (draft.trim() === '') {
      onChange(path, null);
      return;
    }

    if (kind === 'money') {
      const parsed = Number(draft.replace(',', '.'));
      if (Number.isNaN(parsed)) return;
      // Round, never truncate: 12.345 -> 1235 cents, not 1234.
      onChange(path, Math.round(parsed * 100));
      return;
    }

    if (kind === 'number') {
      const parsed = Number(draft);
      if (Number.isNaN(parsed)) return;
      onChange(path, parsed);
      return;
    }

    onChange(path, draft);
  }

  const fieldId = `field-${path}`;
  const reasonId = `reason-${path}`;

  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <label htmlFor={fieldId} className="shrink-0 text-sm text-ink-muted">
        {label}
      </label>

      {editing ? (
        <input
          ref={inputRef}
          id={fieldId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            // Escape must abandon the edit, not commit it — a reviewer who
            // starts typing and thinks better of it expects the original back.
            if (e.key === 'Escape') setEditing(false);
          }}
          data-testid={`edit-${path}`}
          // `inputMode` rather than `type="number"`: a numeric keypad on mobile
          // without the spinner arrows, the scroll-wheel-changes-the-value
          // behaviour, or the browser silently rejecting a comma decimal that
          // `commit` handles perfectly well.
          inputMode={kind === 'money' || kind === 'number' ? 'decimal' : 'text'}
          className="w-40 rounded-md border border-line-strong bg-surface px-2 py-1 text-right text-sm text-ink"
        />
      ) : (
        <button
          type="button"
          id={fieldId}
          onClick={beginEdit}
          disabled={!editable}
          data-testid={`field-${path}`}
          // The `E` shortcut jumps to the first flagged field via this attribute.
          data-flagged={flagged ? 'true' : undefined}
          // `aria-describedby` rather than `title` alone. A title tooltip is
          // invisible on touch, unreachable by keyboard, and inconsistently
          // announced — so the reason a value is doubted, which is the single
          // most useful thing on this screen, reached only mouse users.
          {...(flagged && meta?.reason ? { 'aria-describedby': reasonId } : {})}
          title={meta?.reason ?? undefined}
          className={`rounded-md px-2 py-1 text-right text-sm transition ${
            editable ? 'hover:bg-surface-muted' : 'cursor-default'
          } ${
            flagged
              ? 'bg-caution-soft font-medium text-caution-ink ring-1 ring-caution-line'
              : 'text-ink'
          }`}
        >
          {display}
          {flagged && (
            <span aria-hidden className="ml-1.5 text-xs text-caution">
              ⚑
            </span>
          )}
          {flagged && <span className="sr-only"> — needs checking</span>}
        </button>
      )}

      {flagged && meta?.reason && (
        <span id={reasonId} className="sr-only">
          {meta.reason}
        </span>
      )}
    </div>
  );
}
