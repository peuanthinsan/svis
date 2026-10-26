import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { InteractionManager } from 'react-native';
import { API_BASE, setAuthToken, setOnUnauthorized } from './api';
import {
  AUTH_TOKEN_KEY,
  AUTH_USER_KEY,
  clearAuthStorage,
  readAuthToken,
  readAuthUser,
} from './auth-storage';

export type UserRole = 'driver' | 'supervisor' | 'admin' | 'vehicle_owner';

export type AuthUser = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  fleetId: string;
  companyId: string;
  companySlug: string;
  companyName: string;
  primaryColor: string;
  accentColor: string;
};

type AuthContextType = {
  user: AuthUser | null;
  token: string | null;
  isLoaded: boolean;
  isSignedIn: boolean;
  signIn: (username: string, password: string, companySlug?: string) => Promise<void>;
  signOut: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateProfile: (firstName: string, lastName: string) => Promise<void>;
};

const AuthCtx = createContext<AuthContextType | null>(null);

const TOKEN_REFRESH_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionGenerationRef = useRef(0);
  const authStorageQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueueAuthStorage = useCallback((operation: () => Promise<void>) => {
    const result = authStorageQueueRef.current.then(operation, operation);
    authStorageQueueRef.current = result.catch(() => {});
    return result;
  }, []);

  const signOut = useCallback(async () => {
    sessionGenerationRef.current += 1;
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    setAuthToken(null);
    setToken(null);
    setUser(null);
    await enqueueAuthStorage(clearAuthStorage);
  }, [enqueueAuthStorage]);

  // Register 401 handler so apiFetch can trigger sign-out
  useEffect(() => {
    setOnUnauthorized(() => signOut());
  }, [signOut]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    const sessionGeneration = sessionGenerationRef.current;
    const task = InteractionManager.runAfterInteractions(() => {
      fetch(`${API_BASE}/api/companies`)
        .then((res) => {
          if (!res.ok) throw new Error('Unable to load company branding');
          return res.json();
        })
        .then(async (data) => {
          if (cancelled) return;
          const company = (data.companies ?? []).find(
            (candidate: { slug: string }) => candidate.slug === user.companySlug,
          );
          if (
            !company
            || (
              company.primaryColor === user.primaryColor
              && company.accentColor === user.accentColor
            )
          ) {
            return;
          }

          const nextUser = {
            ...user,
            primaryColor: company.primaryColor,
            accentColor: company.accentColor,
          };
          await enqueueAuthStorage(async () => {
            if (
              cancelled
              || sessionGeneration !== sessionGenerationRef.current
            ) return;
            await SecureStore.setItemAsync(AUTH_USER_KEY, JSON.stringify(nextUser));
          });
          if (
            cancelled
            || sessionGeneration !== sessionGenerationRef.current
          ) return;
          setUser(nextUser);
        })
        .catch(() => {
          // Offline sessions keep their last authenticated company palette.
        });
    });

    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [enqueueAuthStorage, user?.id, user?.companySlug]);

  const refreshToken = useCallback(async (currentToken: string, sessionGeneration: number) => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentToken}`,
        },
      });
      if (res.ok) {
        const data = await res.json();
        if (sessionGeneration !== sessionGenerationRef.current) return null;
        await enqueueAuthStorage(async () => {
          if (sessionGeneration !== sessionGenerationRef.current) return;
          await SecureStore.setItemAsync(AUTH_TOKEN_KEY, data.token);
        });
        if (sessionGeneration !== sessionGenerationRef.current) return null;
        setAuthToken(data.token);
        setToken(data.token);
        return data.token;
      }
      // Token expired beyond refresh window — sign out
      if (res.status === 401) {
        if (sessionGeneration !== sessionGenerationRef.current) return null;
        await signOut();
      }
    } catch {
      // Network error — skip refresh, try again later
    }
    return null;
  }, [enqueueAuthStorage, signOut]);

  const startRefreshTimer = useCallback((currentToken: string) => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = setInterval(async () => {
      const sessionGeneration = sessionGenerationRef.current;
      const savedToken = await readAuthToken();
      if (
        savedToken
        && sessionGeneration === sessionGenerationRef.current
      ) {
        refreshToken(savedToken, sessionGeneration);
      }
    }, TOKEN_REFRESH_INTERVAL);
  }, [refreshToken]);

  // Load saved token on mount
  useEffect(() => {
    (async () => {
      try {
        const [savedToken, savedUser] = await Promise.all([
          readAuthToken(),
          readAuthUser(),
        ]);
        if (savedToken && savedUser) {
          const parsedUser = JSON.parse(savedUser) as AuthUser;
          if (parsedUser.companyId) {
            sessionGenerationRef.current += 1;
            setAuthToken(savedToken);
            setToken(savedToken);
            setUser(parsedUser);
            startRefreshTimer(savedToken);
          } else {
            setAuthToken(null);
          }
        } else {
          setAuthToken(null);
        }
      } catch (e) {
        setAuthToken(null);
        console.warn('[Auth] Failed to load saved session');
      } finally {
        setIsLoaded(true);
      }
    })();
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, []);

  const signIn = useCallback(async (username: string, password: string, companySlug = 'dhl') => {
    const sessionGeneration = ++sessionGenerationRef.current;
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, companySlug }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Login failed');
    }

    const data = await res.json();
    if (sessionGeneration !== sessionGenerationRef.current) {
      throw new Error('Login cancelled');
    }
    await enqueueAuthStorage(async () => {
      if (sessionGeneration !== sessionGenerationRef.current) return;
      await Promise.all([
        SecureStore.setItemAsync(AUTH_TOKEN_KEY, data.token),
        SecureStore.setItemAsync(AUTH_USER_KEY, JSON.stringify(data.user)),
      ]);
    });
    if (sessionGeneration !== sessionGenerationRef.current) {
      throw new Error('Login cancelled');
    }
    setAuthToken(data.token);
    setToken(data.token);
    setUser(data.user);
    startRefreshTimer(data.token);
  }, [enqueueAuthStorage, startRefreshTimer]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await fetch(`${API_BASE}/api/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Password change failed');
    }
  }, [token]);

  const updateProfile = useCallback(async (firstName: string, lastName: string) => {
    const sessionGeneration = sessionGenerationRef.current;
    const res = await fetch(`${API_BASE}/api/auth/profile`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ firstName, lastName }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Update failed');
    }

    const updated = await res.json();
    const newUser = { ...user!, firstName: updated.firstName, lastName: updated.lastName };
    await enqueueAuthStorage(async () => {
      if (sessionGeneration !== sessionGenerationRef.current) return;
      await SecureStore.setItemAsync(AUTH_USER_KEY, JSON.stringify(newUser));
    });
    if (sessionGeneration !== sessionGenerationRef.current) return;
    setUser(newUser);
  }, [enqueueAuthStorage, token, user]);

  return (
    <AuthCtx.Provider value={{
      user,
      token,
      isLoaded,
      isSignedIn: !!token && !!user,
      signIn,
      signOut,
      changePassword,
      updateProfile,
    }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
