import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/useAuth";
import type { Account } from "../../types";
import { BUTTON, BUTTON_QUIET, FIELD, Field, Section } from "../ui";

/** Accounts on this instance. Administrators only; the server enforces that too. */
export function AccountsSection() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => api.listAccounts().then(setAccounts).catch(() => setAccounts(null));
  useEffect(() => {
    void load();
  }, []);

  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await run();
      await load();
      setMessage(done);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    act(async () => {
      await api.createAccount({
        email,
        name,
        role,
        password: password || undefined,
      });
      setEmail("");
      setName("");
      setPassword("");
      setRole("member");
      setAdding(false);
    }, "Account created.");

  const resetPassword = (account: Account) => {
    const next = window.prompt(`New password for ${account.email}`);
    if (!next) return;
    void act(() => api.updateAccount(account.oid, { password: next }), "Password set.");
  };

  const remove = (account: Account) => {
    if (!window.confirm(`Delete the account for ${account.email}? Their history is kept.`)) return;
    void act(() => api.deleteAccount(account.oid), "Account deleted.");
  };

  if (!accounts) return null;

  return (
    <Section
      title="Accounts"
      description="Who can sign in. Administrators can change settings, manage accounts and restore backups."
      aside={
        <button onClick={() => setAdding((v) => !v)} className={BUTTON_QUIET}>
          {adding ? "Cancel" : "Add account"}
        </button>
      }
    >
      {adding && (
        <div className="mt-4 grid gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-4 sm:grid-cols-2">
          <Field label="Email">
            <input
              className={FIELD}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="Name">
            <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Password"
            hint="Leave blank for an account that only ever signs in through your identity provider."
          >
            <input
              className={FIELD}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <select
              className={FIELD}
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "member")}
            >
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </select>
          </Field>
          <div className="sm:col-span-2">
            <button onClick={add} disabled={busy || !email} className={BUTTON}>
              {busy ? "Creating…" : "Create account"}
            </button>
          </div>
        </div>
      )}

      <ul className="mt-4 divide-y divide-slate-800">
        {accounts.map((account) => {
          const isMe = account.oid === user?.oid;
          return (
            <li key={account.oid} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-200">
                  {account.name}
                  {isMe && <span className="ml-2 text-xs text-slate-500">you</span>}
                  {account.disabled && <span className="ml-2 text-xs text-red-400">disabled</span>}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {account.email} · {account.hasPassword ? "password" : "single sign-on"}
                </p>
              </div>
              <select
                aria-label={`Role for ${account.email}`}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100 disabled:opacity-50"
                value={account.role}
                disabled={busy || isMe}
                onChange={(e) =>
                  act(
                    () =>
                      api.updateAccount(account.oid, {
                        role: e.target.value as "admin" | "member",
                      }),
                    "Role updated.",
                  )
                }
              >
                <option value="member">Member</option>
                <option value="admin">Administrator</option>
              </select>
              {account.hasPassword && (
                <button onClick={() => resetPassword(account)} className={BUTTON_QUIET}>
                  Set password
                </button>
              )}
              {!isMe && (
                <button
                  onClick={() => remove(account)}
                  disabled={busy}
                  className="rounded-lg border border-red-900 px-3 py-2 text-sm text-red-300 hover:bg-red-950 disabled:opacity-50"
                >
                  Delete
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {message && <p className="mt-3 text-sm text-slate-400">{message}</p>}
    </Section>
  );
}
