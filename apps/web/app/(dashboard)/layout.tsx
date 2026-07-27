'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useSession } from '../../lib/session';
import { useDocumentStream } from '../../lib/document-stream';
import { ToastProvider } from '../../lib/toast';
import { ThemeToggle } from '../../components/theme-toggle';
import { LiveIndicator } from '../../components/live-indicator';

const NAV = [
  { href: '/documents', label: 'Documents' },
  { href: '/search', label: 'Search' },
];

function NavLinks({ pathname }: { pathname: string }) {
  return (
    <>
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm transition ${
              active
                ? 'bg-surface-muted font-medium text-ink'
                : 'text-ink-muted hover:bg-surface-muted hover:text-ink'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}

/**
 * The authenticated shell.
 *
 * The guard waits for `isLoading` to settle before redirecting. Without that,
 * every page load would bounce to /login for the few hundred milliseconds the
 * refresh call takes, and a logged-in user would watch their own dashboard
 * flash past on the way to a login form they do not need.
 *
 * The document stream is opened *here* rather than per screen, for two reasons.
 * One connection serves every page, so navigating between Documents and Search
 * does not tear down and re-establish it. And because it lives above the
 * router, a status change that arrives while the user is on Search still
 * refreshes the cache — so returning to Documents shows current data instead of
 * whatever was true when they left.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, isLoading, logout } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  const stream = useDocumentStream(Boolean(user));

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [isLoading, user, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-ink-subtle">Loading…</p>
      </div>
    );
  }

  // The redirect is in flight; rendering the shell would flash content the
  // user is not entitled to see.
  if (!user) return null;

  return (
    <ToastProvider>
      <div className="min-h-screen">
        {/*
          Two rows on mobile, one on desktop.

          Brand + two nav labels + theme control + sign-out do not fit in 375px,
          and cramming them into one row pushed sign-out off the right edge —
          taking the whole page with it, since an overflowing header makes the
          body scroll sideways. Wrapping the nav onto its own line at the
          smallest widths costs 36px of vertical space and keeps every control
          reachable.
        */}
        <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
          <div className="mx-auto max-w-7xl px-4">
            <div className="flex h-14 items-center gap-3 sm:gap-6">
              <Link href="/documents" className="shrink-0 font-semibold tracking-tight text-ink">
                InvoiceIQ
              </Link>

              <nav aria-label="Main" className="hidden items-center gap-1 sm:flex">
                <NavLinks pathname={pathname} />
              </nav>

              <div className="ml-auto flex items-center gap-2 sm:gap-3">
                <LiveIndicator connected={stream.connected} />
                <ThemeToggle />

                {/* Hidden below `lg`, not `sm`: at tablet widths the email is
                    what pushes the sign-out button off the edge. */}
                <span className="hidden max-w-[16ch] truncate text-sm text-ink-muted lg:inline">
                  {user.email}
                </span>

                <button
                  type="button"
                  onClick={() => void logout()}
                  className="shrink-0 rounded-md px-2 py-1.5 text-sm text-ink-muted transition hover:bg-surface-muted hover:text-ink sm:px-3"
                >
                  Sign out
                </button>
              </div>
            </div>

            {/* `aria-hidden` is deliberately NOT used here: only one of the two
                navs is in the layout at any width, so there is never a
                duplicate for a screen reader to stumble over. */}
            <nav aria-label="Main" className="flex items-center gap-1 pb-2 sm:hidden">
              <NavLinks pathname={pathname} />
            </nav>
          </div>
        </header>

        <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:py-8">
          {children}
        </main>
      </div>
    </ToastProvider>
  );
}
