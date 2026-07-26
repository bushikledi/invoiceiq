'use client';

import { EmptyState } from '../../../components/states';

/** Placeholder until M9 wires the pgvector search endpoint. */
export default function SearchPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-slate-500">
          Semantic search across every extracted invoice.
        </p>
      </div>
      <EmptyState
        title="Coming next"
        description="Semantic search lands with the embedding pipeline in the next milestone."
      />
    </div>
  );
}
