import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import { ArrowLeftIcon } from "../../components/icons";
import { useConfig, useTerms } from "../../config/useConfig";
import { useScan } from "../../scan/ScanProvider";
import type { Item } from "../../types";
import { SignDialog } from "../media-ai-core/SignDialog";
import { valuationApi } from "./api";
import {
  BTN,
  BTN_PRIMARY,
  CARD,
  EstimateNote,
  FIELD,
  Pill,
  SOURCE_LABEL,
  centsToInput,
  errorText,
  parseMoneyInput,
  useMoneyExact,
} from "./format";
import type { Declaration, DeclarationLine, ValuationSource } from "./types";

const VERIFY_REASON: Record<string, string> = {
  ok: "Matches what was signed.",
  content_changed: "The declaration no longer matches what was signed: something was changed after signing.",
  image_missing: "The signature image is missing.",
  image_altered: "The signature image was altered after signing.",
};

function LineRow({ line, draft, onSave, onRemove }: {
  line: DeclarationLine;
  draft: boolean;
  onSave: (cents: number) => Promise<void>;
  onRemove: () => void;
}) {
  const money = useMoneyExact();
  const [value, setValue] = useState(centsToInput(line.declaredCents));
  useEffect(() => setValue(centsToInput(line.declaredCents)), [line.declaredCents]);
  const commit = () => {
    const cents = parseMoneyInput(value);
    if (cents === null || cents === line.declaredCents) {
      setValue(centsToInput(line.declaredCents));
      return;
    }
    void onSave(cents);
  };
  const facts = [
    [line.brand, line.model].filter(Boolean).join(" · "),
    [line.serial && `S/N ${line.serial}`, line.assetCode].filter(Boolean).join(" · "),
    [line.condition && `Condition: ${line.condition}`, line.materials].filter(Boolean).join(" · "),
  ].filter(Boolean);
  return (
    <li className="flex flex-wrap items-start gap-3 rounded-lg bg-slate-800/50 px-3 py-2">
      <span className="w-6 text-sm text-slate-500">{line.position}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-100">
          {line.itemId ? (
            <Link to={`/items/${line.itemId}${line.unitId ? `?unit=${line.unitId}` : ""}`} className="hover:underline">
              {line.name}
            </Link>
          ) : (
            line.name
          )}
        </p>
        {facts.map((f) => (
          <p key={f} className="text-xs text-slate-400">
            {f}
          </p>
        ))}
        {line.description && <p className="text-xs text-slate-500">{line.description}</p>}
      </div>
      <div className="flex items-center gap-2">
        {line.valueSource && (
          <Pill tone={line.valueSource === "ai" ? "warn" : "muted"}>{SOURCE_LABEL[line.valueSource as ValuationSource] ?? line.valueSource}</Pill>
        )}
        {draft ? (
          <input
            aria-label={`Declared value of ${line.name}`}
            className={`${FIELD} w-32 text-right`}
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="w-32 text-right text-sm font-semibold text-slate-100">{money(line.declaredCents)}</span>
        )}
        {draft && (
          <button type="button" onClick={onRemove} className="text-xs text-slate-500 hover:text-red-400" aria-label={`Remove ${line.name}`}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * One high-value declaration: add items by scanning or searching, check each
 * declared value, sign, and print. Once signed it is read-only, and the page
 * says whether it still matches what was signed.
 */
export function DeclarationPage() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const terms = useTerms();
  const { config } = useConfig();
  const money = useMoneyExact();
  const { armBulkCapture } = useScan();
  const [decl, setDecl] = useState<Declaration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [notes, setNotes] = useState("");
  const [lastScan, setLastScan] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await valuationApi.declaration(id);
      setDecl(d);
      setNotes(d.notes ?? "");
    } catch (err) {
      setError(errorText(err, "Could not load the declaration."));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // Stop listening for scans when leaving the page.
  useEffect(() => () => armBulkCapture(null), [armBulkCapture]);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api.listItems({ q: query.trim(), kind: "physical" }).then((r) => setResults(r.slice(0, 8))).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const act = async (fn: () => Promise<Declaration | void>) => {
    setError(null);
    try {
      const d = await fn();
      if (d) {
        setDecl(d);
        setNotes(d.notes ?? "");
      }
    } catch (err) {
      setError(errorText(err, "That did not work."));
    }
  };

  const add = (itemId: string, unitId?: string | null) => act(() => valuationApi.addLines(id, [{ itemId, unitId }]));

  const toggleScan = () => {
    if (scanning) {
      armBulkCapture(null);
      setScanning(false);
      return;
    }
    setScanning(true);
    armBulkCapture((code) => {
      void api
        .scan(code)
        .then(async (r) => {
          if (!r.found || !r.item) {
            setLastScan(`${code}: not found`);
            return;
          }
          setLastScan(`${code}: ${r.item.name}`);
          await add(r.item.id, r.item.matchedUnitId ?? null);
        })
        .catch((err) => setError(errorText(err, "That scan could not be looked up.")));
    });
  };

  if (!decl) return <p className="py-10 text-center text-slate-500">{error ?? "Loading…"}</p>;
  const draft = decl.status === "draft";
  const hasAi = decl.lines.some((l) => l.valueSource === "ai");
  const scopeWord = decl.scope === "company" ? terms.group.singular : decl.scope === "location" ? terms.location.singular : "Job";

  return (
    <div className="space-y-5">
      <Link to="/valuation?tab=declarations" className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:underline">
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        Declarations
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-mono text-sm text-slate-400">{decl.code}</p>
          <h1 className="text-xl font-semibold text-slate-100">{decl.title}</h1>
          <p className="text-sm text-slate-400">
            {scopeWord}: {decl.scopeLabel ?? "Not set"} · {decl.lines.length} item{decl.lines.length === 1 ? "" : "s"} ·{" "}
            <span className="font-semibold text-slate-200">{money(decl.totalCents)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={draft ? "muted" : "ok"}>{draft ? "Draft" : "Signed"}</Pill>
          <a href={valuationApi.declarationPdfUrl(decl.id)} target="_blank" rel="noreferrer" className={BTN}>
            PDF
          </a>
          {draft && (
            <button type="button" className={BTN_PRIMARY} disabled={!decl.lines.length} onClick={() => setSigning(true)}>
              Review and sign
            </button>
          )}
          {draft && (
            <button
              type="button"
              className="text-sm text-slate-500 hover:text-red-400"
              onClick={() => {
                if (!confirm(`Delete draft ${decl.code}?`)) return;
                void valuationApi.deleteDeclaration(decl.id).then(() => navigate("/valuation?tab=declarations")).catch((err) => setError(errorText(err)));
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {!draft && decl.signature && (
        <div className={`${CARD} flex flex-wrap items-center gap-4`}>
          {decl.signature.imageUrl && <img src={decl.signature.imageUrl} alt="Signature" className="h-16 rounded bg-white p-1" />}
          <div className="text-sm">
            <p className="text-slate-100">
              {decl.signature.signerName}
              {decl.signature.signerRole ? `, ${decl.signature.signerRole}` : ""}
            </p>
            <p className="text-slate-400">Signed {new Date(decl.signature.signedAt).toLocaleString(config.locale)}</p>
            {decl.auditEntryId && <p className="text-xs text-slate-500">Audit log entry #{decl.auditEntryId}</p>}
          </div>
          {decl.verification && (
            <Pill tone={decl.verification.valid ? "ok" : "bad"}>{VERIFY_REASON[decl.verification.reason] ?? decl.verification.reason}</Pill>
          )}
        </div>
      )}

      {draft && (
        <div className={`${CARD} space-y-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={scanning ? BTN_PRIMARY : BTN} onClick={toggleScan}>
              {scanning ? "Stop scanning" : `Scan ${terms.item.plural.toLowerCase()} to add`}
            </button>
            {lastScan && <span className="text-sm text-slate-400">{lastScan}</span>}
          </div>
          <input
            className={FIELD}
            placeholder={`Or search ${terms.item.plural.toLowerCase()} by name, brand or model`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {results.length > 0 && (
            <ul className="space-y-1">
              {results.map((r) => (
                <li key={r.id} className="flex items-center justify-between rounded-lg bg-slate-800/50 px-3 py-1.5 text-sm">
                  <span className="text-slate-200">
                    {r.name} <span className="text-slate-500">{[r.brand, r.model].filter(Boolean).join(" ")}</span>
                  </span>
                  <button
                    type="button"
                    className={BTN}
                    onClick={() => {
                      void add(r.id);
                      setQuery("");
                    }}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {decl.lines.length === 0 ? (
        <p className="text-sm text-slate-500">No items yet. Scan or search to add them.</p>
      ) : (
        <ul className="space-y-1.5">
          {decl.lines.map((l) => (
            <LineRow
              key={l.id}
              line={l}
              draft={draft}
              onSave={(cents) => act(() => valuationApi.updateLine(decl.id, l.id, { declaredCents: cents }))}
              onRemove={() => void act(() => valuationApi.removeLine(decl.id, l.id))}
            />
          ))}
          <li className="flex justify-end px-3 pt-1 text-sm">
            <span className="text-slate-400">Total declared</span>
            <span className="ml-3 w-32 text-right font-semibold text-slate-100">{money(decl.totalCents)}</span>
          </li>
        </ul>
      )}

      {draft ? (
        <textarea
          className={FIELD}
          rows={2}
          placeholder="Notes printed on the declaration"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (decl.notes ?? "") && void act(() => valuationApi.updateDeclaration(decl.id, { notes: notes.trim() || null }))}
        />
      ) : (
        decl.notes && <p className="text-sm text-slate-300">{decl.notes}</p>
      )}

      {hasAi && <EstimateNote />}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {signing && (
        <SignDialog
          ownerType="hv_declaration"
          ownerId={decl.id}
          title={`Sign ${decl.code}`}
          statement={decl.statement}
          content={decl.signingContent}
          onClose={() => setSigning(false)}
          onSigned={(signature) => {
            setSigning(false);
            void act(() => valuationApi.markSigned(decl.id, signature.id));
          }}
        />
      )}
    </div>
  );
}
