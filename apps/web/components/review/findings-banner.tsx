import type { ValidationFinding } from '@invoiceiq/contracts';

/**
 * Findings banner.
 *
 * Rule failures are shown as sentences with the actual amounts in them, because
 * the reviewer's job is to decide whether the invoice is right — and "LINE_ITEMS_SUM
 * failed" does not help them do that, while "Line items sum to €1,240.00 but the
 * subtotal says €1,250.00" does. The message comes from the domain layer, which
 * is where the numbers are known.
 */
export function FindingsBanner({ findings }: { findings: ValidationFinding[] }) {
  const unresolved = findings.filter((f) => !f.resolvedAt);
  if (unresolved.length === 0) return null;

  const errors = unresolved.filter((f) => f.severity === 'ERROR');
  const warnings = unresolved.filter((f) => f.severity === 'WARNING');

  return (
    <div className="space-y-2" data-testid="findings-banner">
      {errors.length > 0 && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4" role="alert">
          <p className="text-sm font-medium text-rose-900">
            {errors.length === 1
              ? 'This invoice does not add up'
              : `${errors.length} problems found`}
          </p>
          <ul className="mt-2 space-y-1.5">
            {errors.map((finding) => (
              <li key={finding.id} className="text-sm text-rose-800">
                {finding.message}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-rose-600">
            Correct the highlighted fields below. The server re-checks the arithmetic before
            accepting the change.
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">Worth a look</p>
          <ul className="mt-2 space-y-1.5">
            {warnings.map((finding) => (
              <li key={finding.id} className="text-sm text-amber-800">
                {finding.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
