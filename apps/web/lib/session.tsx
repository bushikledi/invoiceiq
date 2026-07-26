'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthResponse, AuthenticatedUser } from '@invoiceiq/contracts';
import { api, setAccessToken, setUnauthorizedHandler } from './api-client';

interface SessionState {
  user: AuthenticatedUser | null;
  /** True until the initial refresh settles — distinct from "logged out". */
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  /**
   * Restores the session on load.
   *
   * The access token is deliberately not persisted, so after a page refresh we
   * hold only the httpOnly cookie. One refresh call trades it for a new access
   * token. Failure here is the normal "not logged in" case, not an error worth
   * showing.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const session = await api.auth<AuthResponse>('/auth/refresh');
        if (cancelled) return;
        setAccessToken(session.accessToken);
        setUser(session.user);
      } catch {
        if (!cancelled) setAccessToken(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // When a refresh finally fails mid-session, drop the user and send them to
  // login rather than leaving the UI showing stale data it can no longer load.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      router.push('/login');
    });
    return () => setUnauthorizedHandler(null);
  }, [router]);

  const login = useCallback(async (email: string, password: string) => {
    const session = await api.auth<AuthResponse>('/auth/login', { email, password });
    setAccessToken(session.accessToken);
    setUser(session.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth('/auth/logout');
    } finally {
      // Clear locally even if the call failed — the user asked to be logged
      // out, and leaving them apparently signed in would be worse.
      setAccessToken(null);
      setUser(null);
      router.push('/login');
    }
  }, [router]);

  const value = useMemo<SessionState>(
    () => ({ user, isLoading, login, logout }),
    [user, isLoading, login, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return context;
}
