import { useState, type FormEvent } from "react";
import { api } from "../../api/client";
import { BUTTON, FIELD, Field, Section } from "../ui";

/** Change your own password. Hidden for accounts that sign in through SSO. */
export function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      setMessage("The two new passwords do not match.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.changeOwnPassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMessage("Password changed.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not change the password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Your password">
      <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-3">
        <Field label="Current">
          <input
            className={FIELD}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New">
          <input
            className={FIELD}
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </Field>
        <Field label="Confirm new">
          <input
            className={FIELD}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <div className="sm:col-span-3">
          <button type="submit" disabled={busy || !current || !next} className={BUTTON}>
            {busy ? "Changing…" : "Change password"}
          </button>
          {message && <span className="ml-3 text-sm text-slate-400">{message}</span>}
        </div>
      </form>
    </Section>
  );
}
