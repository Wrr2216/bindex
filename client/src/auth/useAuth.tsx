import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import type { AuthMethods, User } from "../types";

type AuthState = {
  user: User | null;
  methods: AuthMethods | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  completeSetup: (input: { email: string; name: string; password: string }) => Promise<void>;
  /** Hand off to the identity provider, returning to the current page. */
  startSso: () => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMethods = () => api.authMethods().then(setMethods).catch(() => setMethods(null));

  const loadUser = () =>
    api
      .me()
      .then(setUser)
      .catch((err) => {
        // A 401 is the normal signed-out state, not a fault worth logging.
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
        setUser(null);
      });

  useEffect(() => {
    Promise.all([loadUser(), loadMethods()]).finally(() => setLoading(false));
  }, []);

  const signIn = async (email: string, password: string) => {
    setUser(await api.login(email, password));
  };

  const completeSetup = async (input: { email: string; name: string; password: string }) => {
    setUser(await api.setup(input));
    await loadMethods();
  };

  const startSso = () => {
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/auth/sso?returnTo=${encodeURIComponent(returnTo)}`;
  };

  const signOut = async () => {
    await fetch("/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
    window.location.href = "/";
  };

  const refresh = async () => {
    await Promise.all([loadUser(), loadMethods()]);
  };

  return (
    <AuthContext.Provider
      value={{ user, methods, loading, signIn, completeSetup, startSso, signOut, refresh }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
