import type { Metadata, Viewport } from 'next';
import Script from 'next/script';
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
      <body className="min-h-screen bg-canvas text-ink">
        {/*
          Runs before first paint so a dark-mode user never sees a white flash.

          `next/script` with `beforeInteractive` rather than a bare <script> in
          <head>: React 19 warns that scripts rendered inside a component are
          not executed on client render, which is true and, here, harmless —
          but a warning on every page load is how a console becomes something
          nobody reads. This is the sanctioned mechanism and it is silent.

          suppressHydrationWarning on <html> is required regardless, because
          this script deliberately mutates the element before React attaches.
        */}
        <Script id="theme" strategy="beforeInteractive">
          {themeScript}
        </Script>

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
