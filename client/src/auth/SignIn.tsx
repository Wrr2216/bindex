import { useState, type FormEvent } from "react";
import { useAuth } from "./useAuth";
import { useConfig } from "../config/useConfig";

const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";
const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";
const PRIMARY =
  "w-full rounded-lg bg-sky-600 px-4 py-2.5 font-medium text-white hover:bg-sky-500 disabled:opacity-50";

function Shell({ title, subtitle, children }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/icon.svg" alt="" className="h-14 w-14" />
          <div>
            <h1 className="text-2xl font-semibold text-slate-100">{title}</h1>
            <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * First run: the instance has no accounts, so whoever reaches it first creates
 * the owner account. The server closes this route the moment one exists.
 */
function FirstRunSetup() {
  const { completeSetup } = useAuth();
  const { config } = useConfig();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completeSetup({ email, name, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell title={`Set up ${config.appName}`} subtitle="Create the first account. It owns this instance.">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className={LABEL} htmlFor="setup-name">Your name</label>
          <input
            id="setup-name"
            className={FIELD}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="setup-email">Email</label>
          <input
            id="setup-email"
            type="email"
            required
            className={FIELD}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="setup-password">Password</label>
          <input
            id="setup-password"
            type="password"
            required
            minLength={10}
            className={FIELD}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-slate-500">At least 10 characters.</p>
        </div>
        <div>
          <label className={LABEL} htmlFor="setup-confirm">Confirm password</label>
          <input
            id="setup-confirm"
            type="password"
            required
            className={FIELD}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={busy} className={PRIMARY}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
    </Shell>
  );
}

export function SignIn() {
  const { methods, signIn, startSso } = useAuth();
  const { config } = useConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (methods?.needsSetup) return <FirstRunSetup />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  };

  const subtitle = config.orgName || config.tagline || "Sign in to continue.";

  return (
    <Shell title={config.appName} subtitle={subtitle}>
      {methods?.password && (
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className={LABEL} htmlFor="signin-email">Email</label>
            <input
              id="signin-email"
              type="email"
              required
              autoFocus
              className={FIELD}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="signin-password">Password</label>
            <input
              id="signin-password"
              type="password"
              required
              className={FIELD}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={busy} className={PRIMARY}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}

      {methods?.password && methods?.sso && (
        <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-600">
          <span className="h-px flex-1 bg-slate-800" />
          or
          <span className="h-px flex-1 bg-slate-800" />
        </div>
      )}

      {methods?.sso && (
        <button
          onClick={startSso}
          className="w-full rounded-lg border border-slate-700 px-4 py-2.5 font-medium text-slate-200 hover:bg-slate-800"
        >
          {methods.ssoLabel}
        </button>
      )}

      {methods && !methods.password && !methods.sso && (
        <p className="text-center text-sm text-slate-400">
          No sign-in method is configured. Set AUTH_MODE and restart the server.
        </p>
      )}
    </Shell>
  );
}
