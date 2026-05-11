import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Item } from "../types";
import { DomainRow } from "../components/DomainRow";

export function Domains() {
  const [domains, setDomains] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listDomains()
      .then(setDomains)
      .catch(() => setDomains([]))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-100">Domains</h1>
      </div>

      {loading ? (
        <p className="py-10 text-center text-slate-500">Loading…</p>
      ) : domains.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 p-8 text-center">
          <p className="text-slate-500">No domains yet.</p>
          <p className="mt-1 text-sm text-slate-500">
            Configure a registrar in Settings to sync domains, or create a domain item manually.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {domains.map((domain) => (
            <DomainRow key={domain.id} domain={domain} />
          ))}
        </div>
      )}
    </div>
  );
}
