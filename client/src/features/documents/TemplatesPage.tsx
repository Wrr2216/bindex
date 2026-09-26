import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTerms } from "../../config/useConfig";
import { documentsApi } from "./api";
import type { Block, TemplateSummary } from "./types";
import { BTN, CARD, DocumentsNav, FIELD, LABEL, Notice, SELECT, errorText, fmtDateTime, useIsAdmin } from "./ui";

/**
 * A starting point that shows every kind of block, for "Start from the example".
 * `items` is the instance's word for items, as the text is shown to people.
 */
export const exampleBody = (items: string): Block[] => [
  { id: "intro", type: "heading", level: 1, text: "Relocation sign-off" },
  {
    id: "summary",
    type: "paragraph",
    text: `{{org.name}} moved {{manifest.count}} ${items} for {{project.client}} from {{job.originPath}} to {{job.destinationPath}} under job {{job.code}}, {{job.name}}.`,
  },
  { id: "contact", type: "field", field: { key: "site_contact", label: "Site contact", type: "text", required: true } },
  { id: "moved", type: "field", field: { key: "moved_on", label: "Date of move", type: "date", required: true } },
  { id: "crates", type: "field", field: { key: "crates_used", label: "Crates used", type: "number", min: 0 } },
  {
    id: "condition",
    type: "field",
    field: { key: "condition", label: "Condition on arrival", type: "select", options: ["Good", "Minor damage", "Damaged"], required: true },
  },
  { id: "notes", type: "field", field: { key: "notes", label: "Notes", type: "text", multiline: true } },
  { id: "list", type: "table", source: "manifest", columns: ["code", "item", "origin", "destination", "stage"], title: "Items moved" },
  { id: "rule", type: "divider" },
  {
    id: "agree",
    type: "field",
    field: { key: "all_received", label: "Everything listed above was received in the condition noted", type: "checkbox", required: true },
  },
  {
    id: "customer",
    type: "field",
    field: {
      key: "customer_signature",
      label: "Customer signature",
      type: "signature",
      required: true,
      statement: "I confirm the items listed were received in the condition noted.",
    },
  },
  { id: "crew", type: "field", field: { key: "crew_initials", label: "Crew lead initials", type: "initials" } },
];

/** Administrators: every template, and a new one. */
export function TemplatesPage() {
  const admin = useIsAdmin();
  const terms = useTerms();
  const navigate = useNavigate();
  const [rows, setRows] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [start, setStart] = useState<"blank" | "example">("blank");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    documentsApi
      .templates(true)
      .then(setRows)
      .catch((err) => setError(errorText(err, "Templates could not be loaded.")));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const t = await documentsApi.createTemplate({
        name: name.trim(),
        title: start === "example" ? "Relocation sign-off: {{job.name}}" : undefined,
        body: start === "example" ? exampleBody(terms.item.plural.toLowerCase()) : [],
      });
      navigate(`/settings/document-templates/${t.id}`);
    } catch (err) {
      setError(errorText(err, "The template could not be created."));
      setBusy(false);
    }
  };

  if (!admin) return <Notice tone="warn">Only an administrator can manage templates.</Notice>;

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-slate-100">Document templates</h1>
      <DocumentsNav />
      <form onSubmit={create} className={`${CARD} flex flex-col gap-3 sm:flex-row sm:items-end`}>
        <label className="flex-1">
          <span className={LABEL}>New template</span>
          <input className={`${FIELD} mt-1`} placeholder="e.g. Relocation sign-off" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </label>
        <label>
          <span className={LABEL}>Start from</span>
          <select className={`${SELECT} mt-1 w-full`} value={start} onChange={(e) => setStart(e.target.value as "blank" | "example")}>
            <option value="blank">A blank page</option>
            <option value="example">The example sign-off</option>
          </select>
        </label>
        <button className={BTN} disabled={busy || !name.trim()}>
          Create
        </button>
      </form>
      {error && <Notice tone="error">{error}</Notice>}
      {rows && rows.length === 0 && <Notice>No templates yet.</Notice>}
      {rows && rows.length > 0 && (
        <ul className={`${CARD} divide-y divide-slate-800 p-0`}>
          {rows.map((t) => (
            <li key={t.id}>
              <Link to={`/settings/document-templates/${t.id}`} className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-slate-800/40">
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-medium ${t.active ? "text-slate-100" : "text-slate-500 line-through"}`}>{t.name}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {t.publishedVersion ? `Version ${t.publishedVersion} published` : "Not published yet"}
                    {t.hasDraft ? " · unpublished changes" : ""} · {t.documentCount} document{t.documentCount === 1 ? "" : "s"} · updated{" "}
                    {fmtDateTime(t.updatedAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
