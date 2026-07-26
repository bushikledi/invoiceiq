import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DomainError,
  IllegalTransitionError,
  NotFoundError,
  ValidationError,
  isDomainError,
} from './errors.js';

describe('domain errors', () => {
  /**
   * The API's exception filter dispatches on `instanceof DomainError`. If the
   * prototype chain is broken — which is exactly what happens to subclassed
   * built-ins without an explicit setPrototypeOf — every domain error silently
   * becomes a 500 with a generic message, and the careful status mapping is
   * dead code. Hence these assertions.
   */
  describe('instanceof works through the whole chain', () => {
    const cases = [
      ['NotFoundError', new NotFoundError('Document', 'abc')],
      ['ConflictError', new ConflictError('duplicate')],
      ['IllegalTransitionError', new IllegalTransitionError('COMPLETED', 'QUEUED')],
      ['ValidationError', new ValidationError('bad')],
      ['AuthenticationError', new AuthenticationError()],
      ['AuthorizationError', new AuthorizationError()],
    ] as const;

    it.each(cases)('%s is a DomainError and an Error', (_name, error) => {
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toBeInstanceOf(Error);
      expect(isDomainError(error)).toBe(true);
    });

    it.each(cases)('%s reports its own constructor name', (name, error) => {
      // Without setPrototypeOf this collapses to "Error", which makes logs
      // useless for telling these apart.
      expect(error.name).toBe(name);
    });

    it.each(cases)('%s carries a usable stack', (_name, error) => {
      expect(error.stack).toContain(error.name);
    });
  });

  describe('isDomainError', () => {
    it('rejects a plain Error', () => {
      expect(isDomainError(new Error('nope'))).toBe(false);
    });

    it('rejects non-errors', () => {
      expect(isDomainError(null)).toBe(false);
      expect(isDomainError(undefined)).toBe(false);
      expect(isDomainError('boom')).toBe(false);
      expect(isDomainError({ kind: 'NOT_FOUND' })).toBe(false);
    });
  });

  describe('NotFoundError', () => {
    it('names the resource and id', () => {
      const error = new NotFoundError('Document', 'abc-123');
      expect(error.kind).toBe('NOT_FOUND');
      expect(error.message).toBe('Document abc-123 was not found');
      expect(error.context).toEqual({ resource: 'Document', id: 'abc-123' });
    });

    it('omits the id when not supplied', () => {
      expect(new NotFoundError('Document').message).toBe('Document was not found');
    });
  });

  describe('ConflictError', () => {
    it('carries a message and context', () => {
      const error = new ConflictError('Email already registered', { email: 'a@b.dev' });
      expect(error.kind).toBe('CONFLICT');
      expect(error.context).toEqual({ email: 'a@b.dev' });
    });
  });

  describe('IllegalTransitionError', () => {
    it('exposes both states for the filter and the log', () => {
      const error = new IllegalTransitionError('COMPLETED', 'QUEUED');
      expect(error.kind).toBe('ILLEGAL_TRANSITION');
      expect(error.from).toBe('COMPLETED');
      expect(error.to).toBe('QUEUED');
      expect(error.message).toBe('Document cannot move from COMPLETED to QUEUED');
    });

    it('accepts a custom entity name', () => {
      expect(new IllegalTransitionError('A', 'B', 'Extraction').message).toContain('Extraction');
    });
  });

  describe('ValidationError', () => {
    it('carries field-level issues', () => {
      const error = new ValidationError('Invalid payload', [
        { path: 'email', message: 'Must be an email' },
      ]);
      expect(error.kind).toBe('VALIDATION');
      expect(error.issues).toHaveLength(1);
      expect(error.context).toEqual({ issueCount: 1 });
    });

    it('defaults to no issues', () => {
      expect(new ValidationError('bad').issues).toEqual([]);
    });
  });

  describe('auth errors', () => {
    it('have safe default messages that leak nothing', () => {
      expect(new AuthenticationError().message).toBe('Authentication required');
      expect(new AuthorizationError().message).toBe('Not permitted');
    });

    it('accept custom messages', () => {
      expect(new AuthenticationError('Session expired').message).toBe('Session expired');
      expect(new AuthorizationError('Admins only').message).toBe('Admins only');
    });

    it('report their kind', () => {
      expect(new AuthenticationError().kind).toBe('AUTHENTICATION');
      expect(new AuthorizationError().kind).toBe('AUTHORIZATION');
    });
  });

  describe('context', () => {
    it('is frozen so a log formatter cannot mutate it', () => {
      const error = new ConflictError('x', { a: 1 });
      expect(Object.isFrozen(error.context)).toBe(true);
    });

    it('defaults to an empty object rather than undefined', () => {
      expect(new AuthenticationError().context).toEqual({});
    });
  });
});
