/**
 * Walking-skeleton landing page.
 *
 * M4 replaces this with the authenticated dashboard shell. For now it exists so
 * `next build` has a route to compile and the deploy pipeline has something to
 * serve.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">InvoiceIQ</h1>
        <p className="mt-2 text-neutral-600 dark:text-neutral-400">
          PDF invoice → LLM structured extraction → validation → human review → semantic search.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-neutral-200 bg-neutral-200 text-sm dark:border-neutral-800 dark:bg-neutral-800">
        {[
          ['Status', 'Walking skeleton (M2)'],
          ['Next milestone', 'M3 — authentication'],
        ].map(([term, value]) => (
          <div key={term} className="bg-white p-4 dark:bg-neutral-950">
            <dt className="text-neutral-500 dark:text-neutral-500">{term}</dt>
            <dd className="mt-1 font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </main>
  );
}
