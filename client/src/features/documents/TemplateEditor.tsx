import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { documentsApi } from "./api";
import type {
  Block,
  BlockType,
  BodyProblem,
  CustomField,
  DocumentsMeta,
  FieldDef,
  FieldType,
  RenderModel,
  TableSourceInfo,
  TemplateDetail,
  TemplateVersion,
} from "./types";
import {
  BTN,
  BTN_DANGER,
  BTN_QUIET,
  CARD,
  FIELD,
  H2,
  JobPicker,
  LABEL,
  Notice,
  SELECT,
  errorText,
  fmtDateTime,
  keyFromLabel,
  newBlockId,
  useDocumentsMeta,
  useIsAdmin,
} from "./ui";

/**
 * The template editor: an ordered list of blocks, each edited in place, and a
 * preview against the sample job or a real one. Saving writes the draft;
 * editing a published template starts the next version, and publishing makes
 * it the one new documents use.
 */

const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  checkbox: "Tick box",
  select: "List of choices",
  signature: "Signature",
  initials: "Initials",
};

const BLOCK_LABEL: Record<BlockType, string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  field: "Field",
  table: "Table",
  divider: "Divider",
};

export function TemplateEditor() {
  const { id = "" } = useParams();
  const admin = useIsAdmin();
  const navigate = useNavigate();
  const meta = useDocumentsMeta();
  const [tpl, setTpl] = useState<TemplateDetail | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);
  const [title, setTitle] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  // Blocks whose key still follows the label, so typing a label suggests one.
  const [autoKeys, setAutoKeys] = useState<Set<string>>(new Set());
  const [dirty, setDirty] = useState(false);
  const [library, setLibrary] = useState<CustomField[]>([]);
  const [message, setMessage] = useState<{ tone: "ok" | "error" | "warn" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [viewing, setViewing] = useState<TemplateVersion | null>(null);

  const apply = useCallback((t: TemplateDetail) => {
    setTpl(t);
    setName(t.name);
    setDescription(t.description ?? "");
    setActive(t.active);
    setTitle(t.editing?.title ?? t.name);
    setBlocks(t.editing?.body ?? []);
    setAutoKeys(new Set());
    setDirty(false);
  }, []);

  useEffect(() => {
    documentsApi
      .template(id)
      .then(apply)
      .catch((err) => setMessage({ tone: "error", text: errorText(err, "This template could not be loaded.") }));
    documentsApi.fields().then(setLibrary).catch(() => undefined);
  }, [id, apply]);

  const edit = (fn: (b: Block[]) => Block[]) => {
    setBlocks(fn);
    setDirty(true);
  };
  const update = (i: number, block: Block) => edit((b) => b.map((x, j) => (j === i ? block : x)));
  const move = (i: number, delta: number) =>
    edit((b) => {
      const j = i + delta;
      if (j < 0 || j >= b.length) return b;
      const next = [...b];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const remove = (i: number) => edit((b) => b.filter((_, j) => j !== i));

  const keys = useMemo(() => blocks.flatMap((b) => (b.type === "field" ? [b.field.key] : [])), [blocks]);
  const duplicateKeys = useMemo(() => new Set(keys.filter((k, i) => keys.indexOf(k) !== i)), [keys]);

  const uniqueKey = (base: string) => {
    let key = base;
    for (let n = 2; keys.includes(key); n++) key = `${base.slice(0, 36)}_${n}`;
    return key;
  };

  const add = (type: BlockType, library?: CustomField) => {
    const id = newBlockId();
    let block: Block;
    switch (type) {
      case "heading":
        block = { id, type, level: 2, text: "" };
        break;
      case "paragraph":
        block = { id, type, text: "" };
        break;
      case "divider":
        block = { id, type };
        break;
      case "table": {
        const source = meta?.tableSources[0];
        block = { id, type, source: source?.name ?? "manifest", columns: source?.defaultColumns ?? ["code"] };
        break;
      }
      case "field":
        if (library) {
          block = { id, type, field: { ...library.definition } };
          if (keys.includes(library.key)) {
            setMessage({ tone: "warn", text: `This template already has a field with the key "${library.key}". Change one of them.` });
          }
        } else {
          block = { id, type, field: { key: uniqueKey("new_field"), label: "New field", type: "text" } };
          setAutoKeys((s) => new Set(s).add(id));
        }
        break;
    }
    edit((b) => [...b, block]);
  };

  const save = async (): Promise<TemplateDetail | null> => {
    setBusy(true);
    setMessage(null);
    try {
      const t = await documentsApi.updateTemplate(id, {
        name,
        description: description.trim() || null,
        active,
        title,
        body: blocks,
      });
      apply(t);
      setMessage({
        tone: "ok",
        text: t.draft ? `Saved as version ${t.draft.version}, not published yet.` : "Saved.",
      });
      return t;
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "The template could not be saved.") });
      return null;
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const t = await documentsApi.publishTemplate(id);
      apply(t);
      setMessage({ tone: "ok", text: `Version ${t.published?.version} is published. New documents use it; existing ones keep theirs.` });
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err, "The template could not be published.") });
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    if (!window.confirm("Throw away the unpublished changes and go back to the published version?")) return;
    setBusy(true);
    try {
      apply(await documentsApi.discardDraft(id));
      setMessage({ tone: "info", text: "Unpublished changes discarded." });
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const destroy = async () => {
    if (!window.confirm(`Delete "${tpl?.name}"? Only a template no document uses can be deleted.`)) return;
    try {
      await documentsApi.deleteTemplate(id);
      navigate("/settings/document-templates");
    } catch (err) {
      setMessage({ tone: "error", text: errorText(err) });
    }
  };

  if (!admin) return <Notice tone="warn">Only an administrator can edit templates.</Notice>;
  if (!tpl) return message ? <Notice tone="error">{message.text}</Notice> : <p className="text-slate-400">Loading…</p>;

  const problemsFor = (blockId: string): BodyProblem[] => (dirty ? [] : tpl.problems.filter((p) => p.blockId === blockId));
  const state = tpl.draft
    ? `Editing version ${tpl.draft.version} (not published${tpl.published ? `; version ${tpl.published.version} is live` : ""})`
    : tpl.published
      ? `Version ${tpl.published.version} is live. Saving a change starts version ${Math.max(...tpl.versions.map((v) => v.version)) + 1}.`
      : "Not published yet.";

  return (
    <div className="space-y-4">
      <div className="text-sm text-slate-400">
        <Link to="/settings/document-templates" className="hover:text-slate-200">
          Templates
        </Link>{" "}
        / {tpl.name}
      </div>

      <section className={`${CARD} space-y-3`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className={LABEL}>Name</span>
            <input className={`${FIELD} mt-1`} value={name} maxLength={200} onChange={(e) => (setName(e.target.value), setDirty(true))} />
          </label>
          <label>
            <span className={LABEL}>Printed title (merge fields allowed)</span>
            <input className={`${FIELD} mt-1`} value={title} maxLength={300} onChange={(e) => (setTitle(e.target.value), setDirty(true))} />
          </label>
          <label className="sm:col-span-2">
            <span className={LABEL}>Description</span>
            <input className={`${FIELD} mt-1`} value={description} maxLength={2000} onChange={(e) => (setDescription(e.target.value), setDirty(true))} />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" className="accent-sky-500" checked={active} onChange={(e) => (setActive(e.target.checked), setDirty(true))} />
          In use (switched off, no new documents start from it and packets skip it)
        </label>
        <p className="text-sm text-slate-400">{state}</p>
        <div className="flex flex-wrap gap-2">
          <button className={BTN_QUIET} disabled={busy || !dirty} onClick={() => void save()}>
            Save draft
          </button>
          <button className={BTN} disabled={busy || (!dirty && !tpl.draft)} onClick={() => void publish()}>
            Publish
          </button>
          {tpl.draft && tpl.published && (
            <button className={BTN_QUIET} disabled={busy} onClick={() => void discard()}>
              Discard changes
            </button>
          )}
          <button className={BTN_DANGER} disabled={busy} onClick={() => void destroy()}>
            Delete template
          </button>
          {dirty && <span className="self-center text-xs text-amber-300">Unsaved changes</span>}
        </div>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        {!dirty && tpl.problems.length > 0 && (
          <Notice tone="warn">
            Before publishing: {tpl.problems.map((p) => p.message).join(" ")}
          </Notice>
        )}
      </section>

      <div className="flex gap-1" role="tablist">
        {(["edit", "preview"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`rounded-lg px-3 py-1.5 text-sm ${tab === t ? "bg-slate-800 text-sky-300" : "text-slate-400 hover:bg-slate-800/60"}`}
            onClick={() => setTab(t)}
          >
            {t === "edit" ? "Blocks" : "Preview"}
          </button>
        ))}
      </div>

      {tab === "edit" ? (
        <div className="space-y-3">
          {blocks.length === 0 && <Notice>Add blocks below: a heading, some text, the fields to fill in.</Notice>}
          {blocks.map((block, i) => (
            <BlockCard
              key={block.id}
              block={block}
              index={i}
              count={blocks.length}
              meta={meta}
              fieldKeys={keys}
              duplicate={block.type === "field" && duplicateKeys.has(block.field.key)}
              problems={problemsFor(block.id)}
              autoKey={autoKeys.has(block.id)}
              onKeyTouched={() =>
                setAutoKeys((s) => {
                  const next = new Set(s);
                  next.delete(block.id);
                  return next;
                })
              }
              onChange={(b) => update(i, b)}
              onMove={(d) => move(i, d)}
              onRemove={() => remove(i)}
            />
          ))}
          <AddBlockBar library={library} onAdd={add} />
        </div>
      ) : (
        <PreviewPane title={title} blocks={blocks} />
      )}

      <section className={`${CARD} space-y-2`} aria-label="Versions">
        <h2 className={H2}>Versions</h2>
        <ul className="divide-y divide-slate-800 text-sm">
          {tpl.versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="font-medium text-slate-200">Version {v.version}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs ${v.status === "published" ? "bg-emerald-950 text-emerald-300" : "bg-slate-800 text-slate-300"}`}>
                {v.status === "published" ? `published ${fmtDateTime(v.publishedAt)}` : "draft"}
              </span>
              <span className="text-xs text-slate-500">
                {v.documentCount} document{v.documentCount === 1 ? "" : "s"}
              </span>
              {v.status === "published" && (
                <button
                  className="ml-auto text-xs text-sky-400 hover:underline"
                  onClick={() => documentsApi.templateVersion(id, v.version).then(setViewing).catch(() => undefined)}
                >
                  View
                </button>
              )}
            </li>
          ))}
        </ul>
        {viewing && (
          <div className="space-y-2 rounded-lg border border-slate-800 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-300">
                Version {viewing.version}: {viewing.body.length} blocks, "{viewing.title}"
              </span>
              <button className="text-xs text-slate-400 hover:text-slate-200" onClick={() => setViewing(null)}>
                Close
              </button>
            </div>
            <PreviewPane title={viewing.title} blocks={viewing.body} />
          </div>
        )}
      </section>
    </div>
  );
}

function BlockCard({
  block,
  index,
  count,
  meta,
  fieldKeys,
  duplicate,
  problems,
  autoKey,
  onKeyTouched,
  onChange,
  onMove,
  onRemove,
}: {
  block: Block;
  index: number;
  count: number;
  meta: DocumentsMeta | null;
  fieldKeys: string[];
  duplicate: boolean;
  problems: BodyProblem[];
  autoKey: boolean;
  onKeyTouched: () => void;
  onChange: (b: Block) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const label =
    block.type === "field" ? `${BLOCK_LABEL.field}: ${FIELD_TYPE_LABEL[block.field.type]}` : BLOCK_LABEL[block.type];
  return (
    <div className={`${CARD} space-y-3 ${duplicate || problems.length ? "border-amber-700" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
        {block.type === "field" && block.field.libraryId && (
          <span className="rounded-full bg-indigo-950 px-2 py-0.5 text-xs text-indigo-300">from the library</span>
        )}
        <span className="ml-auto flex gap-1">
          <IconButton label="Move up" disabled={index === 0} onClick={() => onMove(-1)}>
            ↑
          </IconButton>
          <IconButton label="Move down" disabled={index === count - 1} onClick={() => onMove(1)}>
            ↓
          </IconButton>
          <IconButton label="Remove block" onClick={onRemove}>
            ×
          </IconButton>
        </span>
      </div>
      {block.type === "heading" && (
        <div className="flex gap-2">
          <select
            className={SELECT}
            aria-label="Heading size"
            value={block.level ?? 2}
            onChange={(e) => onChange({ ...block, level: Number(e.target.value) as 1 | 2 | 3 })}
          >
            <option value={1}>Large</option>
            <option value={2}>Medium</option>
            <option value={3}>Small</option>
          </select>
          <input className={FIELD} aria-label="Heading text" value={block.text} maxLength={500} onChange={(e) => onChange({ ...block, text: e.target.value })} />
        </div>
      )}
      {block.type === "paragraph" && (
        <div className="space-y-2">
          <textarea
            className={FIELD}
            rows={4}
            aria-label="Paragraph text"
            value={block.text}
            maxLength={20000}
            onChange={(e) => onChange({ ...block, text: e.target.value })}
          />
          <MergePicker meta={meta} fieldKeys={fieldKeys} onPick={(m) => onChange({ ...block, text: `${block.text}${block.text && !block.text.endsWith(" ") ? " " : ""}{{${m}}}` })} />
        </div>
      )}
      {block.type === "field" && (
        <FieldEditor
          field={block.field}
          duplicate={duplicate}
          autoKey={autoKey}
          onKeyTouched={onKeyTouched}
          onChange={(field) => onChange({ ...block, field })}
        />
      )}
      {block.type === "table" && <TableEditor block={block} sources={meta?.tableSources ?? []} onChange={onChange} />}
      {problems.map((p, i) => (
        <p key={i} className="text-xs text-amber-300">
          {p.message}
        </p>
      ))}
    </div>
  );
}

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="h-7 w-7 rounded-md border border-slate-700 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function MergePicker({ meta, fieldKeys, onPick }: { meta: DocumentsMeta | null; fieldKeys: string[]; onPick: (key: string) => void }) {
  return (
    <select
      className={`${SELECT} w-full text-xs sm:w-auto`}
      value=""
      aria-label="Insert a merge field"
      onChange={(e) => e.target.value && onPick(e.target.value)}
    >
      <option value="">Insert a merge field…</option>
      <optgroup label="Job and instance">
        {meta?.mergeFields
          .filter((m) => !m.key.includes("<"))
          .map((m) => (
            <option key={m.key} value={m.key}>
              {m.label} ({`{{${m.key}}}`})
            </option>
          ))}
      </optgroup>
      {fieldKeys.length > 0 && (
        <optgroup label="Fields on this document">
          {fieldKeys.map((k) => (
            <option key={k} value={`field.${k}`}>
              {`{{field.${k}}}`}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

function FieldEditor({
  field,
  duplicate,
  autoKey,
  onKeyTouched,
  onChange,
}: {
  field: FieldDef;
  duplicate: boolean;
  autoKey: boolean;
  onKeyTouched: () => void;
  onChange: (f: FieldDef) => void;
}) {
  const set = <K extends keyof FieldDef>(k: K, v: FieldDef[K]) => {
    const next = { ...field, [k]: v };
    if (v === undefined || v === "") delete next[k];
    onChange(next);
  };
  const signing = field.type === "signature" || field.type === "initials";
  const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? undefined : Number(s));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label>
        <span className={LABEL}>Label</span>
        <input
          className={`${FIELD} mt-1`}
          value={field.label}
          maxLength={200}
          onChange={(e) => {
            const label = e.target.value;
            onChange({ ...field, label, ...(autoKey && label.trim() ? { key: keyFromLabel(label) } : {}) });
          }}
        />
      </label>
      <label>
        <span className={LABEL}>Key</span>
        <input
          className={`${FIELD} mt-1 font-mono ${duplicate ? "border-amber-600" : ""}`}
          value={field.key}
          maxLength={40}
          onChange={(e) => {
            onKeyTouched();
            set("key", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
          }}
        />
        <span className="mt-1 block text-xs text-slate-500">
          {duplicate ? "Another field already uses this key." : "Fields with the same key copy between documents."}
        </span>
      </label>
      <label>
        <span className={LABEL}>Type</span>
        <select className={`${SELECT} mt-1 w-full`} value={field.type} onChange={(e) => set("type", e.target.value as FieldType)}>
          {(Object.keys(FIELD_TYPE_LABEL) as FieldType[]).map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-300">
        <input type="checkbox" className="accent-sky-500" checked={!!field.required} onChange={(e) => set("required", e.target.checked || undefined)} />
        Required{field.type === "checkbox" ? " (must be ticked)" : ""}
      </label>
      {field.type === "select" && (
        <label className="sm:col-span-2">
          <span className={LABEL}>Choices, one per line</span>
          <textarea
            className={`${FIELD} mt-1`}
            rows={3}
            value={(field.options ?? []).join("\n")}
            onChange={(e) => set("options", e.target.value.split("\n").map((o) => o.trimStart()))}
            onBlur={() => set("options", (field.options ?? []).map((o) => o.trim()).filter(Boolean))}
          />
        </label>
      )}
      {field.type === "text" && (
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" className="accent-sky-500" checked={!!field.multiline} onChange={(e) => set("multiline", e.target.checked || undefined)} />
          Several lines
        </label>
      )}
      {field.type === "number" && (
        <div className="flex gap-2">
          <label className="flex-1">
            <span className={LABEL}>Minimum</span>
            <input className={`${FIELD} mt-1`} type="number" value={field.min ?? ""} onChange={(e) => set("min", num(e.target.value))} />
          </label>
          <label className="flex-1">
            <span className={LABEL}>Maximum</span>
            <input className={`${FIELD} mt-1`} type="number" value={field.max ?? ""} onChange={(e) => set("max", num(e.target.value))} />
          </label>
        </div>
      )}
      {(field.type === "text" || field.type === "number") && (
        <label>
          <span className={LABEL}>Placeholder</span>
          <input className={`${FIELD} mt-1`} value={field.placeholder ?? ""} maxLength={200} onChange={(e) => set("placeholder", e.target.value)} />
        </label>
      )}
      {signing && (
        <label className="sm:col-span-2">
          <span className={LABEL}>What the signer agrees to</span>
          <textarea
            className={`${FIELD} mt-1`}
            rows={2}
            value={field.statement ?? ""}
            maxLength={2000}
            placeholder={field.type === "initials" ? "I have read this section." : "I confirm that the information in this document is correct."}
            onChange={(e) => set("statement", e.target.value)}
          />
        </label>
      )}
      <label className="sm:col-span-2">
        <span className={LABEL}>Help text</span>
        <input className={`${FIELD} mt-1`} value={field.help ?? ""} maxLength={500} onChange={(e) => set("help", e.target.value)} />
      </label>
    </div>
  );
}

function TableEditor({
  block,
  sources,
  onChange,
}: {
  block: Extract<Block, { type: "table" }>;
  sources: TableSourceInfo[];
  onChange: (b: Block) => void;
}) {
  const source = sources.find((s) => s.name === block.source);
  const toggle = (key: string, on: boolean) => {
    const order = source?.columns.map((c) => c.key) ?? [];
    const next = on ? [...block.columns, key] : block.columns.filter((c) => c !== key);
    onChange({ ...block, columns: next.sort((a, b) => order.indexOf(a) - order.indexOf(b)) });
  };
  const setFilter = (key: "floor" | "department" | "stage", value: string) => {
    const filter = { ...block.filter, [key]: value || undefined };
    onChange({ ...block, filter: Object.values(filter).some(Boolean) ? filter : undefined });
  };
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className={LABEL}>Rows from</span>
          <select
            className={`${SELECT} mt-1 w-full`}
            value={block.source}
            onChange={(e) => {
              const next = sources.find((s) => s.name === e.target.value);
              onChange({ ...block, source: e.target.value, columns: next?.defaultColumns ?? [], filter: undefined });
            }}
          >
            {sources.map((s) => (
              <option key={s.name} value={s.name}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={LABEL}>Title (optional)</span>
          <input className={`${FIELD} mt-1`} value={block.title ?? ""} maxLength={200} onChange={(e) => onChange({ ...block, title: e.target.value || undefined })} />
        </label>
      </div>
      <fieldset>
        <legend className={LABEL}>Columns</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {source?.columns.map((c) => (
            <label key={c.key} className="flex items-center gap-1.5 text-sm text-slate-300">
              <input type="checkbox" className="accent-sky-500" checked={block.columns.includes(c.key)} onChange={(e) => toggle(c.key, e.target.checked)} />
              {c.label}
            </label>
          ))}
        </div>
      </fieldset>
      {source && source.filters.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-3">
          {source.filters.map((f) => (
            <label key={f}>
              <span className={LABEL}>Only {f}</span>
              <input className={`${FIELD} mt-1`} value={block.filter?.[f] ?? ""} maxLength={100} onChange={(e) => setFilter(f, e.target.value)} />
            </label>
          ))}
        </div>
      )}
      <label className="block">
        <span className={LABEL}>When there are no rows, print</span>
        <input
          className={`${FIELD} mt-1`}
          value={block.emptyText ?? ""}
          placeholder="Nothing to list."
          maxLength={200}
          onChange={(e) => onChange({ ...block, emptyText: e.target.value || undefined })}
        />
      </label>
    </div>
  );
}

function AddBlockBar({ library, onAdd }: { library: CustomField[]; onAdd: (type: BlockType, library?: CustomField) => void }) {
  return (
    <div className={`${CARD} flex flex-wrap items-center gap-2`}>
      <span className="text-sm text-slate-400">Add</span>
      {(["heading", "paragraph", "field", "table", "divider"] as const).map((t) => (
        <button key={t} type="button" className={BTN_QUIET} onClick={() => onAdd(t)}>
          {BLOCK_LABEL[t]}
        </button>
      ))}
      {library.length > 0 && (
        <select
          className={SELECT}
          value=""
          aria-label="Add a field from the library"
          onChange={(e) => {
            const f = library.find((l) => l.id === e.target.value);
            if (f) onAdd("field", f);
          }}
        >
          <option value="">Field from the library…</option>
          {library.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label} ({FIELD_TYPE_LABEL[f.type]})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** The template rendered against the sample job, or a real one, as a document would show it. */
export function PreviewPane({ title, blocks }: { title: string; blocks: Block[] }) {
  const [jobId, setJobId] = useState("");
  const [model, setModel] = useState<(RenderModel & { problems: BodyProblem[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      documentsApi
        .preview({ title, body: blocks, jobId: jobId || null })
        .then((m) => {
          if (!live) return;
          setModel(m);
          setError(null);
        })
        .catch((err) => live && setError(errorText(err, "The preview could not be drawn.")));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [title, blocks, jobId]);

  const pdf = async () => {
    try {
      const blob = await documentsApi.previewPdf({ title, body: blocks, jobId: jobId || null });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setError(errorText(err, "The PDF could not be drawn."));
    }
  };

  return (
    <section className={`${CARD} space-y-3`} aria-label="Preview">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex-1">
          <JobPicker value={jobId} onChange={(id) => setJobId(id)} placeholder="The sample job" label="Preview job" />
        </div>
        <button className={BTN_QUIET} onClick={() => void pdf()}>
          Preview PDF
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {model && model.unknown.length > 0 && (
        <Notice tone="warn">These placeholders match nothing: {model.unknown.map((u) => `{{${u}}}`).join(", ")}.</Notice>
      )}
      {model && (
        <article className="space-y-3 rounded-lg bg-white p-5 text-slate-900">
          <h1 className="text-xl font-bold">{model.title}</h1>
          {model.blocks.map((b) => {
            switch (b.type) {
              case "heading":
                return (
                  <h2 key={b.id} className={`${b.level === 1 ? "text-lg" : "text-base"} font-bold`}>
                    {b.text}
                  </h2>
                );
              case "paragraph":
                return (
                  <p key={b.id} className="whitespace-pre-line text-sm">
                    {b.text}
                  </p>
                );
              case "divider":
                return <hr key={b.id} className="border-slate-300" />;
              case "field":
                return (
                  <div key={b.id} className="text-sm">
                    {b.field.type === "checkbox" ? (
                      <span>☐ {b.field.label}</span>
                    ) : (
                      <>
                        <span className="block text-xs font-semibold uppercase text-slate-500">
                          {b.field.label}
                          {b.field.required ? " *" : ""}
                        </span>
                        <span className={`block border-b border-slate-400 ${b.field.type === "signature" ? "h-14" : "h-6"}`}>{b.display}</span>
                      </>
                    )}
                  </div>
                );
              case "table":
                return (
                  <div key={b.id} className="space-y-1">
                    {b.title && <h3 className="text-sm font-bold">{b.title}</h3>}
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-100">
                        <tr>
                          {b.columns.map((c) => (
                            <th key={c.key} className="px-2 py-1">
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {b.rows.slice(0, 20).map((r, i) => (
                          <tr key={i} className="border-b border-slate-200">
                            {r.map((cell, j) => (
                              <td key={j} className="px-2 py-1">
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {b.rows.length === 0 && <p className="text-xs italic text-slate-500">{b.emptyText}</p>}
                    {b.rows.length > 20 && <p className="text-xs text-slate-500">…and {b.total - 20} more</p>}
                  </div>
                );
            }
          })}
        </article>
      )}
    </section>
  );
}
