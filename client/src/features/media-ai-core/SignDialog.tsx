import { useState, type FormEvent } from "react";
import { createSignature } from "./api";
import { errorMessage } from "./format";
import { Modal } from "./Modal";
import { SignaturePad } from "./SignaturePad";
import type { Signature } from "./types";

const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";
const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";

export type SignDialogProps = {
  ownerType: string;
  ownerId: string;
  /** The exact words the signer agrees to. Stored verbatim with the signature. */
  statement: string;
  /**
   * What is being signed, as plain JSON. Its hash is stored; to verify later,
   * rebuild the same JSON from the record and call verifySignature.
   */
  content: unknown;
  onSigned: (signature: Signature) => void;
  onClose: () => void;
  title?: string;
  defaultName?: string;
  defaultRole?: string;
  defaultEmail?: string;
  /** Ask for an email address and require one. */
  requireEmail?: boolean;
};

/**
 * Capture a signature: the signer's name, role and email, the statement they
 * agree to, and their drawn signature. Saves through /api/signatures and hands
 * back the stored signature.
 */
export function SignDialog({
  ownerType,
  ownerId,
  statement,
  content,
  onSigned,
  onClose,
  title = "Sign",
  defaultName = "",
  defaultRole = "",
  defaultEmail = "",
  requireEmail = false,
}: SignDialogProps) {
  const [name, setName] = useState(defaultName);
  const [role, setRole] = useState(defaultRole);
  const [email, setEmail] = useState(defaultEmail);
  const [png, setPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim() && png && (!requireEmail || email.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const signature = await createSignature({
        ownerType,
        ownerId,
        signerName: name.trim(),
        signerRole: role.trim() || null,
        signerEmail: email.trim() || null,
        statement,
        content,
        image: png,
      });
      onSigned(signature);
    } catch (err) {
      setError(errorMessage(err, "The signature could not be saved. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="whitespace-pre-line rounded-lg bg-slate-800/60 p-3 text-sm text-slate-200">{statement}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className={LABEL} htmlFor="sign-name">
              Name *
            </label>
            <input
              id="sign-name"
              className={FIELD}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
              maxLength={200}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="sign-role">
              Role
            </label>
            <input
              id="sign-role"
              className={FIELD}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              placeholder="e.g. Facility contact"
              autoComplete="organization-title"
              maxLength={120}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="sign-email">
              Email{requireEmail ? " *" : ""}
            </label>
            <input
              id="sign-email"
              type="email"
              className={FIELD}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required={requireEmail}
              maxLength={320}
            />
          </div>
        </div>
        <SignaturePad onSigned={setPng} />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={busy || !ready}
            className="flex-1 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Agree and sign"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-700 px-4 py-2 text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
