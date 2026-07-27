import type { ValidationFinding } from '@invoiceiq/contracts';

/**
 * Findings banner.
 *
 * Rule failures are shown as sentences with the actual amounts in them, because
 * the reviewer's job is to decide whether the invoice is right — and "LINE_ITEMS_SUM
 * failed" does not help them do that, while "Line items sum to €1,240.00 but the
 * subtotal says €1,250.00" does. The message comes from the domain layer, which
 * is where the numbers are known.
 *
 * Errors carry `role="alert"`; warnings deliberately do not. An alert interrupts
 * a screen reader mid-sentence, which is right for "this invoice does not add
 * up" and wrong for "worth a look" — and a page that interrupts for everything
 * has trained the user to ignore it by the second document.
 */
export function FindingsBanner({ findings }: { findings: ValidationFinding[] }) {
  const unresolved = findings.filter((f) => !f.resolvedAt);
  if (unresolved.length === 0) return null;

  const errors = unresolved.filter((f) => f.severity === 'ERROR');
  const warnings = unresolved.filter((f) => f.severity === 'WARNING');

  return (
    <div className="space-y-2" data-testid="findings-banner">
      {errors.length > 0 && (
        <div
          className="rounded-xl border border-critical-line bg-critical-soft p-4"
          role="alert"
        >
          <p className="text-sm font-medium text-critical-ink">
            {errors.length === 1
              ? 'This invoice does not add up'
              : `${errors.length} problems found`}
          </p>
          <ul className="mt-2 space-y-1.5">
            {errors.map((finding) => (
              <li key={finding.id} className="text-sm text-critical-ink/90">
                {finding.message}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-critical-ink/75">
            Correct the highlighted fields below. The server re-checks the arithmetic before
            accepting the change.
          </p>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="rounded-xl border border-caution-line bg-caution-soft p-4">
          <p className="text-sm font-medium text-caution-ink">Worth a look</p>
          <ul className="mt-2 space-y-1.5">
            {warnings.map((finding) => (
              <li key={finding.id} className="text-sm text-caution-ink/90">
                {finding.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
