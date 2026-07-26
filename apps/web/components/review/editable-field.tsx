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

  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <span className="shrink-0 text-sm text-slate-500">{label}</span>

      {editing ? (
        <input
          ref={inputRef}
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
          className="w-40 rounded border border-slate-900 px-2 py-1 text-right text-sm outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={beginEdit}
          disabled={!editable}
          data-testid={`field-${path}`}
          // The `E` shortcut jumps to the first flagged field via this attribute.
          data-flagged={flagged ? 'true' : undefined}
          title={meta?.reason ?? undefined}
          className={`rounded px-2 py-1 text-right text-sm transition ${
            editable ? 'hover:bg-slate-100' : 'cursor-default'
          } ${
            flagged
              ? 'bg-amber-50 font-medium text-amber-900 ring-1 ring-amber-300'
              : 'text-slate-900'
          }`}
        >
          {display}
          {flagged && (
            <span className="ml-1.5 text-xs text-amber-600" aria-label="Needs checking">
              ⚑
            </span>
          )}
        </button>
      )}
    </div>
  );
}
