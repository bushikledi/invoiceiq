import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { QueryProvider } from '../lib/query-provider';
import { SessionProvider } from '../lib/session';
import { ThemeProvider, themeScript } from '../lib/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'InvoiceIQ',
  description: 'AI invoice extraction with human review',
};

export const viewport: Viewport = {
  // Announced so the browser renders native controls (scrollbars, form widgets,
  // the address bar) to match, rather than pairing a dark page with a light
  // scrollbar. The value updates from `data-theme` at runtime.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#161a20' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint so a dark-mode user never sees a white
            flash. suppressHydrationWarning above is required because this
            script deliberately mutates <html> before React attaches. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-canvas text-ink">
        {/* First focusable element on the page. A reviewer working by keyboard
            would otherwise tab through the whole header on every navigation to
            reach the content they came for. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg"
        >
          Skip to content
        </a>

        <ThemeProvider>
          <QueryProvider>
            <SessionProvider>{children}</SessionProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
