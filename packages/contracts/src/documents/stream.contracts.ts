import { z } from 'zod';
import { DocumentStatusSchema } from './document.contracts.js';

/**
 * The live status channel.
 *
 * One Redis channel carries every document event; the payload names its owner
 * and the API filters before writing to a client. Per-user channels would push
 * the filtering into Redis, but they would also mean one subscription per
 * connected user on a connection that is already in subscriber mode — worth it
 * at ten thousand concurrent reviewers, needless complexity at ten. The seam is
 * the channel name, and it is one constant.
 *
 * `uploaderId` is authorisation data, so it never reaches the browser: the API
 * uses it to decide whether to forward the event and strips it from what it
 * sends. A subscriber must not be able to learn that *someone else's* document
 * changed, and an event is a fact about a document even when it carries no
 * fields from it.
 */
export const DOCUMENT_EVENTS_CHANNEL = 'document-events' as const;

/** What the worker publishes. Internal — see the note about `uploaderId`. */
export const DocumentEventMessageSchema = z.object({
  documentId: z.string(),
  uploaderId: z.string(),
  status: DocumentStatusSchema,
  /** ISO 8601. Lets a client ignore an event older than what it already shows. */
  at: z.string(),
  failureReason: z.string().nullable().optional(),
});

export type DocumentEventMessage = z.infer<typeof DocumentEventMessageSchema>;

/** What the browser receives. Note the absence of `uploaderId`. */
export const DocumentStreamEventSchema = DocumentEventMessageSchema.omit({ uploaderId: true });

export type DocumentStreamEvent = z.infer<typeof DocumentStreamEventSchema>;
