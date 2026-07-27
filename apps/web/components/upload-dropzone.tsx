'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState, type DragEvent } from 'react';
import {
  MAX_UPLOAD_BYTES,
  PDF_CONTENT_TYPE,
  type CreateUploadResponse,
  type DocumentSummary,
} from '@invoiceiq/contracts';
import { ApiError, api } from '../lib/api-client';
import { formatBytes } from '../lib/format';

interface UploadState {
  filename: string;
  progress: number;
  error?: string;
}

/**
 * Direct-to-storage upload.
 *
 *   POST /uploads  → presigned PUT
 *   PUT  to S3     → the bytes never touch the API process
 *   POST /complete → the server verifies and queues
 *
 * Client-side validation here is a courtesy, not a control: it saves a pointless
 * round trip for an obviously wrong file. The server re-checks size and reads
 * the actual magic bytes, because everything below is attacker-controlled.
 */
export function UploadDropzone() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});

  const update = useCallback((id: string, patch: Partial<UploadState>) => {
    setUploads((current) => {
      const existing = current[id];
      return existing ? { ...current, [id]: { ...existing, ...patch } } : current;
    });
  }, []);

  const upload = useCallback(
    async (file: File) => {
      const id = `${file.name}-${Date.now()}`;
      setUploads((c) => ({ ...c, [id]: { filename: file.name, progress: 0 } }));

      try {
        if (file.type !== PDF_CONTENT_TYPE && !file.name.toLowerCase().endsWith('.pdf')) {
          throw new Error('Only PDF files are accepted');
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error(`File is ${formatBytes(file.size)}; the limit is 10 MB`);
        }

        const presigned = await api.post<CreateUploadResponse>('/documents/uploads', {
          filename: file.name,
          sizeBytes: file.size,
          contentType: PDF_CONTENT_TYPE,
        });

        update(id, { progress: 10 });

        // XHR rather than fetch purely for upload progress — fetch still has no
        // request-body progress event.
        await putWithProgress(presigned.uploadUrl, file, (pct) =>
          update(id, { progress: 10 + Math.round(pct * 0.8) }),
        );

        update(id, { progress: 95 });
        await api.post<DocumentSummary>(`/documents/${presigned.documentId}/complete`);

        update(id, { progress: 100 });
        await queryClient.invalidateQueries({ queryKey: ['documents'] });

        // Leave the finished row visible briefly so the upload is seen to have
        // succeeded rather than simply vanishing.
        setTimeout(() => {
          setUploads((c) => {
            const { [id]: _done, ...rest } = c;
            return rest;
          });
        }, 1_500);
      } catch (error) {
        update(id, {
          error:
            error instanceof ApiError
              ? (error.problem.detail ?? error.problem.title)
              : error instanceof Error
                ? error.message
                : 'Upload failed',
        });
      }
    },
    [queryClient, update],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      for (const file of Array.from(files)) void upload(file);
    },
    [upload],
  );

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    handleFiles(event.dataTransfer.files);
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        aria-label="Upload invoice PDFs"
        data-testid="dropzone"
        className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragging
            ? 'border-focus bg-info-soft'
            : 'border-line-strong bg-surface hover:border-focus'
        }`}
      >
        <p className="text-sm font-medium text-ink">Drop invoice PDFs here, or click to choose</p>
        <p className="mt-1 text-xs text-ink-muted">PDF only · up to 10 MB</p>

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          multiple
          data-testid="file-input"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            // Reset so re-selecting the same file fires change again.
            e.target.value = '';
          }}
        />
      </div>

      {Object.entries(uploads).map(([id, state]) => (
        <div
          key={id}
          className="rounded-xl border border-line bg-surface px-4 py-3"
          data-testid="upload-progress"
        >
          <div className="flex items-center justify-between gap-4">
            <span className="truncate text-sm text-ink">{state.filename}</span>
            <span className="shrink-0 text-xs tabular-nums text-ink-muted">
              {state.error ? 'Failed' : `${state.progress}%`}
            </span>
          </div>

          {state.error ? (
            <p className="mt-1 text-xs text-critical-ink">{state.error}</p>
          ) : (
            <div
              className="mt-2 h-1 overflow-hidden rounded-full bg-surface-muted"
              role="progressbar"
              aria-label={`Uploading ${state.filename}`}
              aria-valuenow={state.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${state.progress}%` }}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function putWithProgress(url: string, file: File, onProgress: (pct: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', PDF_CONTENT_TYPE);

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress((event.loaded / event.total) * 100);
    });

    xhr.addEventListener('load', () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Storage rejected the upload (${xhr.status})`)),
    );
    xhr.addEventListener('error', () => reject(new Error('Network error during upload')));

    xhr.send(file);
  });
}
