import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabase.js';

// Hard ceiling so RequireAuth's "Cargando sesión…" splash never traps
// the user. If we cannot resolve the session in this window, force a
// clean signOut and let RequireAuth redirect to /login.
const SESSION_RESOLVE_TIMEOUT_MS = 10_000;
// fetchOperador must not block the splash forever either.
const OPERADOR_FETCH_TIMEOUT_MS = 8_000;

const AuthContext = createContext({
  session: null,
  user: null,
  operador: null,
  loading: true,
  error: null,
  refreshOperador: async () => {},
});

function isInvalidRefreshTokenError(err) {
  if (!err) return false;
  const msg = (err.message ?? '').toString().toLowerCase();
  return (
    msg.includes('refresh token') ||
    msg.includes('invalid_grant') ||
    err.status === 400 ||
    err.code === 'refresh_token_not_found' ||
    err.code === 'invalid_refresh_token'
  );
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout (${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [operador, setOperador] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const resolvedRef = useRef(false);
  const mountedRef = useRef(true);

  const fetchOperador = async (userId) => {
    if (!userId) {
      setOperador(null);
      return;
    }
    try {
      const { data, error: err } = await withTimeout(
        supabase
          .from('operadores')
          .select('id, username, nombre_completo, role, establecimientos_asignados, activo, pin_debe_cambiar')
          .eq('id', userId)
          .maybeSingle(),
        OPERADOR_FETCH_TIMEOUT_MS,
        'fetchOperador'
      );
      if (!mountedRef.current) return;
      if (err) {
        setError(err);
        setOperador(null);
      } else {
        setError(null);
        setOperador(data ?? null);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[auth] fetchOperador failed:', err?.message ?? err);
      if (!mountedRef.current) return;
      setError(err);
      setOperador(null);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    resolvedRef.current = false;

    const finish = (nextSession) => {
      if (!mountedRef.current) return;
      resolvedRef.current = true;
      setSession(nextSession ?? null);
      setLoading(false);
    };

    const forceLogout = async (reason) => {
      // eslint-disable-next-line no-console
      console.warn('[auth] forcing logout:', reason);
      try {
        await supabase.auth.signOut();
      } catch {
        // Even if signOut fails (no network, server 5xx), supabase-js
        // clears local storage. The user must not be trapped on the
        // splash because of a corrupt token.
      }
      if (!mountedRef.current) return;
      resolvedRef.current = true;
      setSession(null);
      setOperador(null);
      setLoading(false);
    };

    const safetyTimer = setTimeout(() => {
      if (!resolvedRef.current) {
        forceLogout('session-resolve-timeout');
      }
    }, SESSION_RESOLVE_TIMEOUT_MS);

    supabase.auth
      .getSession()
      .then(async ({ data, error: err }) => {
        if (!mountedRef.current) return;
        if (err) {
          if (isInvalidRefreshTokenError(err)) {
            await forceLogout(err.message);
            return;
          }
          // eslint-disable-next-line no-console
          console.error('[auth] getSession error:', err);
          finish(null);
          return;
        }
        const sess = data?.session ?? null;
        setSession(sess);
        if (sess?.user?.id) {
          await fetchOperador(sess.user.id);
        }
        if (!resolvedRef.current && mountedRef.current) {
          resolvedRef.current = true;
          setLoading(false);
        }
      })
      .catch(async (err) => {
        if (!mountedRef.current) return;
        if (isInvalidRefreshTokenError(err)) {
          await forceLogout(err?.message ?? 'invalid-refresh-token');
        } else {
          // eslint-disable-next-line no-console
          console.error('[auth] getSession threw:', err);
          finish(null);
        }
      });

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
      if (!mountedRef.current) return;

      // Naming differs across supabase-js versions: TOKEN_REFRESH_FAILED
      // (newer) vs TOKEN_REFRESHED with session=null (older). Handle both.
      if (event === 'TOKEN_REFRESH_FAILED' || (event === 'TOKEN_REFRESHED' && !s)) {
        await forceLogout(`auth-event:${event}`);
        return;
      }

      setSession(s);
      if (s?.user?.id) {
        await fetchOperador(s.user.id);
      } else {
        setOperador(null);
      }
      if (!resolvedRef.current && mountedRef.current) {
        resolvedRef.current = true;
        setLoading(false);
      }
    });

    return () => {
      mountedRef.current = false;
      clearTimeout(safetyTimer);
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshOperador = async () => {
    if (session?.user?.id) await fetchOperador(session.user.id);
  };

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      operador,
      loading,
      error,
      refreshOperador,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, operador, loading, error]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
