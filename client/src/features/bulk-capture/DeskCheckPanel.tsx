import type { DeskCheck } from "./types";

/** Each surveyed desk against the standard kit: what is there, what is missing. */
export function DeskCheckPanel({ checks }: { checks: DeskCheck[] }) {
  const incomplete = checks.filter((c) => !c.complete).length;
  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Desk check{" "}
        <span className="normal-case tracking-normal text-slate-500">
          {incomplete ? `${incomplete} of ${checks.length} desks missing something` : `all ${checks.length} desks complete`}
        </span>
      </h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {checks.map((c) => (
          <li
            key={c.desk}
            className={`rounded-xl border p-3 ${c.complete ? "border-slate-800 bg-slate-900" : "border-amber-900/70 bg-amber-950/20"}`}
          >
            <p className="font-medium text-slate-100">
              {c.desk}
              <span className={`ml-2 text-xs ${c.complete ? "text-emerald-400" : "text-amber-300"}`}>
                {c.complete ? "Complete" : "Missing items"}
              </span>
            </p>
            <table className="mt-2 w-full text-sm">
              <tbody>
                {c.lines.map((l) => (
                  <tr key={l.key} className={l.missing ? "text-amber-200" : "text-slate-300"}>
                    <td className="py-0.5">{l.label}</td>
                    <td className="py-0.5 text-right tabular-nums">
                      {l.found} of {l.expected}
                      {l.missing ? ` · ${l.missing} missing` : l.extra ? ` · ${l.extra} extra` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {c.others.length > 0 && (
              <p className="mt-1 text-xs text-slate-500">Also here: {c.others.map((o) => (o.qty > 1 ? `${o.qty} × ${o.name}` : o.name)).join(", ")}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
