import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { suppliesApi } from "./api";
import { Badge, CARD, H2, Notice, PageHeader, SMALL_BUTTON, errText, fmtWhen } from "./shared";
import type { KitDetail, KitLine } from "./types";

function LineRow({ l }: { l: KitLine }) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0">
        <Link to={`/items/${l.itemId}${l.unitId ? `?unit=${l.unitId}` : ""}`} className="truncate text-slate-100 hover:underline">
          {l.name}
          {l.unitLabel && <span className="ml-2 text-slate-400">{l.unitLabel}</span>}
        </Link>
        <p className="text-xs text-slate-500">{l.assetCode}</p>
      </div>
      {l.status === "returned" ? (
        <span className="text-xs text-slate-400">Back {fmtWhen(l.checkedInAt)}</span>
      ) : l.status === "out" ? (
        <Badge tone="late">Still out</Badge>
      ) : (
        <Badge tone="muted">Record removed</Badge>
      )}
    </li>
  );
}

export function KitPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [kit, setKit] = useState<KitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    suppliesApi.kit(id).then(setKit).catch((e) => setErr(errText(e)));
  }, [id]);

  if (err) {
    return (
      <div className="space-y-4">
        <PageHeader title="Kit" back="/supplies" />
        <Notice tone="error">{err}</Notice>
      </div>
    );
  }
  if (!kit) return <p className="py-10 text-center text-slate-500">Loading…</p>;

  const back = kit.lines.filter((l) => l.status !== "out");

  return (
    <div className="space-y-4">
      <PageHeader title={`Kit for ${kit.holderName}`} back="/supplies">
        {kit.holderId && kit.outCount > 0 && (
          <Link to={`/supplies/holders/${kit.holderId}`} className={SMALL_BUTTON}>
            Check pieces back in
          </Link>
        )}
      </PageHeader>
      <p className="text-sm text-slate-400">
        Out {fmtWhen(kit.createdAt)}
        {kit.expectedReturnAt && ` · due back ${fmtWhen(kit.expectedReturnAt)}`}
        {kit.jobRef && ` · ${kit.jobRef}`}
        {kit.note && ` · ${kit.note}`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Badge tone={kit.outCount ? "low" : "ok"}>
          {kit.returnedCount} of {kit.total} back
        </Badge>
        {kit.overdue && <Badge tone="late">Overdue</Badge>}
        {kit.closedAt && <Badge tone="ok">Closed {fmtWhen(kit.closedAt)}</Badge>}
      </div>

      {kit.missing.length > 0 && (
        <section className={CARD}>
          <h2 className={H2}>Still out ({kit.missing.length})</h2>
          <ul className="mt-2 divide-y divide-slate-800">
            {kit.missing.map((l) => (
              <LineRow key={l.id} l={l} />
            ))}
          </ul>
        </section>
      )}
      <section className={CARD}>
        <h2 className={H2}>Back ({back.length})</h2>
        {back.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">Nothing has come back yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-800">
            {back.map((l) => (
              <LineRow key={l.id} l={l} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
