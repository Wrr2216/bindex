import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ApiKey } from "../types";

const scopeLabel = { read: "Read-only", read_write: "Read & write" } as const;

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiKey["scope"]>("read");
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = () => api.listApiKeys().then(setKeys).catch(() => setKeys([]));
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setMsg(null);
    try {
      const created = await api.createApiKey(name.trim(), scope);
      setRevealed({ name: created.name, key: created.key });
      setCopied(false);
      setName("");
      setScope("read");
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    if (
      !window.confirm(
        `Revoke "${key.name}"? Anything using this key will immediately lose access.`,
      )
    ) {
      return;
    }
    try {
      await api.revokeApiKey(key.id);
      load();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Failed to revoke key");
    }
  };

  const copy = async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      setCopied(true);
    } catch {
      setMsg("Could not copy. Select the key and copy it by hand.");
    }
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
      <h2 className="font-semibold text-slate-100">API keys</h2>
      <p className="mt-1 text-sm text-slate-400">
        Grant scripts and other systems access to the API by sending a key in the{" "}
        <code className="text-slate-300">x-api-key</code> header. Read-only keys can only make GET
        requests; read &amp; write keys can also create and update inventory. Settings and backups
        always require a browser session.
      </p>

      {revealed && (
        <div className="mt-4 rounded-lg border border-amber-700 bg-amber-950/50 p-4">
          <p className="text-sm font-medium text-amber-300">
            Key for “{revealed.name}”. Copy it now; it is not shown again.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <code className="break-all rounded bg-slate-950 px-2 py-1 text-sm text-slate-200">
              {revealed.key}
            </code>
            <button
              onClick={copy}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              onClick={() => setRevealed(null)}
              className="text-sm text-slate-400 hover:text-slate-200"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {keys.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Scope</th>
                <th className="py-2 pr-4 font-medium">Key</th>
                <th className="py-2 pr-4 font-medium">Created</th>
                <th className="py-2 pr-4 font-medium">Last used</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-slate-800/50">
                  <td className="py-2 pr-4 text-slate-200">{k.name}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs ${
                        k.scope === "read_write"
                          ? "bg-emerald-950 text-emerald-400"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {scopeLabel[k.scope]}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <code className="text-slate-400">bdx_…{k.keyLast4}</code>
                  </td>
                  <td className="py-2 pr-4 text-slate-400">
                    {new Date(k.createdAt).toLocaleDateString()}
                  </td>
                  <td className="py-2 pr-4 text-slate-400">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "Never"}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => revoke(k)}
                      className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-red-400 hover:bg-slate-800"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-slate-400">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. n8n automation"
            maxLength={100}
            className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600"
          />
        </label>
        <fieldset className="flex items-center gap-4 pb-2 text-sm text-slate-300">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="api-key-scope"
              checked={scope === "read"}
              onChange={() => setScope("read")}
            />
            Read-only
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="api-key-scope"
              checked={scope === "read_write"}
              onChange={() => setScope("read_write")}
            />
            Read &amp; write
          </label>
        </fieldset>
        <button
          onClick={create}
          disabled={creating || !name.trim()}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create key"}
        </button>
        {msg && <span className="pb-2 text-sm text-red-400">{msg}</span>}
      </div>
    </section>
  );
}
