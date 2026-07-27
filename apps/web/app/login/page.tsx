'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api-client';
import { useSession } from '../../lib/session';

/**
 * Login.
 *
 * Demo credentials are pre-filled from public env vars so the 90-second demo
 * does not open with someone typing a password. This is only acceptable because
 * the demo account is seeded, disposable and has no real data behind it — the
 * values are compiled into the bundle, which for any other account would be a
 * straightforward credential leak.
 */
export default function LoginPage() {
  const router = useRouter();
  const { login, user, isLoading } = useSession();

  const [email, setEmail] = useState(process.env['NEXT_PUBLIC_DEMO_EMAIL'] ?? '');
  const [password, setPassword] = useState(process.env['NEXT_PUBLIC_DEMO_PASSWORD'] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Someone arriving here with a live session should not have to log in again.
  useEffect(() => {
    if (!isLoading && user) router.replace('/documents');
  }, [isLoading, user, router]);

  // Wrapped rather than passed directly: an async handler returns a promise
  // that React never awaits, so a rejection would become an unhandled rejection
  // instead of the error state below.
  const onSubmit = (event: FormEvent) => {
    void handleSubmit(event);
  };

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      await login(email, password);
      router.replace('/documents');
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? // The API returns one message for both wrong-password and
            // unknown-account, so there is nothing to disambiguate here.
            (caught.problem.detail ?? 'Sign in failed')
          : 'Could not reach the server. Is the API running?',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">InvoiceIQ</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Extraction, validation and review for PDF invoices
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-ink">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong px-3 py-2 text-sm"
            />
          </div>

          {error && (
            <p role="alert" className="rounded-md bg-critical-soft px-3 py-2 text-sm text-critical-ink">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-ink transition hover:bg-accent-hover disabled:opacity-60"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {process.env['NEXT_PUBLIC_DEMO_EMAIL'] && (
          <p className="mt-4 text-center text-xs text-ink-subtle">
            Demo credentials are pre-filled.
          </p>
        )}
      </div>
    </main>
  );
}
