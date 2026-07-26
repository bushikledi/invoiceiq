import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { QueryProvider } from '../lib/query-provider';
import { SessionProvider } from '../lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'InvoiceIQ',
  description: 'AI invoice extraction with human review',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        <QueryProvider>
          <SessionProvider>{children}</SessionProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
