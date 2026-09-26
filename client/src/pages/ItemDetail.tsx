import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ninjaoneAssetUrl } from "../api/client";
import { useConfig, useMoney } from "../config/useConfig";
import type { IdentifierType, ItemDetail as Detail, Location, NinjaStatus } from "../types";
import { ItemForm } from "../components/ItemForm";
import { ProductImage } from "../components/ProductImage";
import { PricingLookup } from "../components/PricingLookup";
import { AssignmentSection } from "../components/AssignmentSection";
import { UnitsSection } from "../components/UnitsSection";
import { MoveAction } from "../components/MoveAction";
import { NfcTagUrl } from "../components/NfcTagUrl";
import { useScan } from "../scan/ScanProvider";
import { LastSeenCard } from "../features/tracking-core/LastSeenCard";
import { ItemMediaSection } from "../features/media-ai-core";
import { ItemConditionSection } from "../features/ai-condition";
import {
  AlertIcon,
  ArrowLeftIcon,
  CameraIcon,
  CloseIcon,
  DocumentIcon,
  ExternalLinkIcon,
  TagIcon,
} from "../components/icons";

const ID_TYPES: IdentifierType[] = ["upc", "serial", "asset_tag", "mac", "sku", "other", "rfid", "domain"];

const daysUntil = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

export function ItemDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { config } = useConfig();
  const money = useMoney();
  const [ninja, setNinja] = useState<NinjaStatus | null>(null);
  const [searchParams] = useSearchParams();
  const highlightUnitId = searchParams.get("unit");
  const [item, setItem] = useState<Detail | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [editing, setEditing] = useState(false);
  const [newType, setNewType] = useState<IdentifierType>("serial");
  const [newValue, setNewValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rfidWaiting, setRfidWaiting] = useState(false);
  const { armCapture } = useScan();

  const load = useCallback(() => {
    if (!id) return;
    api.getItem(id).then(setItem).catch(() => setItem(null));
  }, [id]);

  useEffect(() => {
    load();
    api.listLocations().then(setLocations).catch(() => undefined);
  }, [load]);

  // The NinjaOne deep link depends on which region this instance talks to,
  // which only the server knows.
  useEffect(() => {
    if (!config.integrations.ninjaone) return;
    api.ninjaStatus().then(setNinja).catch(() => setNinja(null));
  }, [config.integrations.ninjaone]);

  if (!item) return <p className="py-10 text-center text-slate-500">Loading…</p>;

  const isDomain = item.category === "Domain";

  const addIdentifier = async (e: FormEvent) => {
    e.preventDefault();
    if (!newValue.trim()) return;
    setError(null);
    try {
      await api.addIdentifier(item.id, newType, newValue.trim());
      setNewValue("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add identifier");
    }
  };

  const removeIdentifier = async (idId: string) => {
    await api.removeIdentifier(idId);
    load();
  };

  const tagRfid = () => {
    setError(null);
    setRfidWaiting(true);
    armCapture(async (uid) => {
      try {
        await api.addIdentifier(item.id, "rfid", uid.trim());
        load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to tag");
      } finally {
        setRfidWaiting(false);
      }
    });
  };

  const cancelTag = () => {
    armCapture(null);
    setRfidWaiting(false);
  };

  const remove = async () => {
    if (!confirm(`Delete “${item.name}”? This cannot be undone.`)) return;
    await api.deleteItem(item.id);
    navigate("/items");
  };

  const print = () => window.open(`/print?id=${item.id}`, "_blank", "noopener");
  const printCompact = () =>
    window.open(`/print?id=${item.id}&style=compact`, "_blank", "noopener");
  const printContainerLabel = () =>
    window.open(`/print?container=${item.id}`, "_blank", "noopener");
  const printContents = () => window.open(api.manifestPdfUrl(item.id), "_blank", "noopener");

  // Vehicle & equipment details live in item.metadata (set via the edit form).
  const meta = item.metadata;
  const metaStr = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : "");
  const vehicleFields = [
    "vin",
    "licensePlate",
    "titleLocation",
    "registrationExpires",
    "insuranceProvider",
    "insurancePolicy",
    "insuranceExpires",
    "fleetUrl",
  ];
  const hasVehicleInfo = vehicleFields.some((k) => metaStr(k));

  const takePhoto = async (file: File) => {
    setError(null);
    try {
      setItem(await api.uploadPhoto(item.id, file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Photo upload failed");
    }
  };

  return (
    <div className="space-y-6">
      <Link
        to="/items"
        className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:underline"
      >
        <ArrowLeftIcon className="h-3.5 w-3.5" />
        Back to {config.terms.item.plural.toLowerCase()}
      </Link>

      {editing ? (
        <ItemForm
          item={item}
          locations={locations}
          onSaved={(updated) => {
            setItem(updated);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="flex flex-col gap-4 sm:flex-row">
            <ProductImage
              src={item.primaryImageUrl}
              alt={item.name}
              className="h-40 w-40 shrink-0 rounded-xl object-contain"
            />
            <div className="flex-1">
              <h1 className="text-xl font-semibold text-slate-100">{item.name}</h1>
              <p className="text-slate-400">{[item.brand, item.model].filter(Boolean).join(" · ") || "Not set"}</p>
              {item.category && <p className="mt-1 text-sm text-slate-500">{item.category}</p>}
              <p className="mt-2 text-sm text-sky-300">
                Qty {item.quantity} · {item.locationName ?? "Unassigned"}
                {item.companyName ? ` · ${item.companyName}` : ""}
              </p>
              {item.utilizedByEntityName && (
                <p className="mt-1 text-sm text-slate-300">
                  {config.terms.holder.singular}{" "}
                  <span className="text-slate-100">{item.utilizedByEntityName}</span>
                </p>
              )}
              {item.valueCents != null && (
                <p className="mt-1 text-sm text-slate-300">
                  Value <span className="text-slate-100">{money(item.valueCents)}</span>
                </p>
              )}
              {item.expiresAt && (
                <p
                  className={`mt-1 text-sm ${
                    daysUntil(item.expiresAt) <= 30 && item.metadata.autoRenew !== true
                      ? "text-red-300"
                      : "text-slate-300"
                  }`}
                >
                  Expires{" "}
                  <span className="text-slate-100">
                    {new Date(item.expiresAt).toLocaleDateString()}
                  </span>{" "}
                  ({daysUntil(item.expiresAt) < 0 ? "expired" : `in ${daysUntil(item.expiresAt)}d`})
                  {typeof item.metadata.autoRenew === "boolean" && (
                    <span className="ml-2 text-xs text-slate-500">
                      auto-renew {item.metadata.autoRenew ? "on" : "off"}
                    </span>
                  )}
                </p>
              )}
              {typeof item.metadata.registrar === "string" && (
                <p className="mt-1 text-xs text-slate-500">
                  Registrar: {item.metadata.registrar}
                  {typeof item.metadata.dnsProvider === "string" &&
                    ` · DNS: ${item.metadata.dnsProvider}`}
                </p>
              )}
              <p className="mt-1 font-mono text-sm text-slate-400">{item.assetCode}</p>
              {item.flaggedMissing && (
                <p className="mt-1 inline-flex items-center gap-1.5 rounded bg-red-950 px-2 py-0.5 text-sm font-medium text-red-300">
                  <AlertIcon className="h-3.5 w-3.5" />
                  Possibly missing: failed a spot check
                </p>
              )}
              {item.lastSpotCheckedAt && (
                <p className="mt-1 text-xs text-slate-500">
                  Spot-checked by {item.lastSpotCheckedBy ?? "Not set"} on{" "}
                  {new Date(item.lastSpotCheckedAt).toLocaleDateString()}
                </p>
              )}
              {item.ninjaoneAssetId && ninja?.baseUrl && (
                <a
                  href={ninjaoneAssetUrl(ninja!.baseUrl, item.ninjaoneAssetId)}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-sm text-emerald-400 hover:underline"
                >
                  View in NinjaOne
                  <ExternalLinkIcon className="h-3 w-3" />
                  {item.ninjaoneOrg && <span className="text-slate-500">· {item.ninjaoneOrg}</span>}
                </a>
              )}
              {item.enrichmentSource && (
                <p className="mt-1 text-xs text-slate-500">Data source: {item.enrichmentSource}</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => setEditing(true)}
                  className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
                >
                  Edit
                </button>
                {!isDomain && (
                  <>
                    <button
                      onClick={print}
                      className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
                    >
                      Print label
                    </button>
                    <button
                      onClick={printCompact}
                      title="Just the QR code with the code beneath it"
                      className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
                    >
                      Print compact
                    </button>
                    <a
                      href={api.labelPreviewUrl(item.id)}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Preview
                    </a>
                    <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 px-4 py-1.5 text-sm text-slate-200 hover:bg-slate-800">
                      <CameraIcon className="h-4 w-4" />
                      Photo
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void takePhoto(f);
                        }}
                      />
                    </label>
                  </>
                )}
                <button
                  onClick={remove}
                  className="rounded-lg border border-red-900 px-4 py-1.5 text-sm text-red-300 hover:bg-red-950"
                >
                  Delete
                </button>
              </div>

              {!isDomain && (
                <div className="mt-2">
                  <MoveAction item={item} onChange={setItem} />
                </div>
              )}
            </div>
          </div>

          {item.description && <p className="text-slate-300">{item.description}</p>}

          {/* Only offered when the lookups behind it are actually configured. */}
          {!isDomain && config.integrations.webSearch && config.integrations.languageModel && (
            <PricingLookup item={item} onUpdated={setItem} />
          )}

          {!isDomain && <ItemMediaSection item={item} onChange={setItem} />}

          <ItemConditionSection item={item} onChange={setItem} />

          {hasVehicleInfo && (
            <section className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Vehicle &amp; equipment
                </h2>
                {metaStr("fleetUrl") && (
                  <a
                    href={metaStr("fleetUrl")}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-600"
                  >
                    Maintenance records
                    <ExternalLinkIcon className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                {metaStr("vin") && (
                  <div>
                    <dt className="text-xs uppercase text-slate-500">VIN</dt>
                    <dd className="font-mono text-slate-200">{metaStr("vin")}</dd>
                  </div>
                )}
                {metaStr("licensePlate") && (
                  <div>
                    <dt className="text-xs uppercase text-slate-500">License plate</dt>
                    <dd className="font-mono text-slate-200">{metaStr("licensePlate")}</dd>
                  </div>
                )}
                {metaStr("titleLocation") && (
                  <div>
                    <dt className="text-xs uppercase text-slate-500">Title kept at</dt>
                    <dd className="text-slate-200">{metaStr("titleLocation")}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-xs uppercase text-slate-500">
                    {config.terms.holder.singular}
                  </dt>
                  <dd className="text-slate-200">{item.utilizedByEntityName ?? "Not set"}</dd>
                </div>
                {metaStr("registrationExpires") && (
                  <div>
                    <dt className="text-xs uppercase text-slate-500">Registration expires</dt>
                    <dd
                      className={
                        daysUntil(metaStr("registrationExpires")) <= 30
                          ? "text-red-300"
                          : "text-slate-200"
                      }
                    >
                      {new Date(metaStr("registrationExpires")).toLocaleDateString()}{" "}
                      {daysUntil(metaStr("registrationExpires")) < 0
                        ? "(expired)"
                        : `(in ${daysUntil(metaStr("registrationExpires"))}d)`}
                    </dd>
                  </div>
                )}
                {(metaStr("insuranceProvider") || metaStr("insurancePolicy")) && (
                  <div>
                    <dt className="text-xs uppercase text-slate-500">Insurance</dt>
                    <dd className="text-slate-200">
                      {[metaStr("insuranceProvider"), metaStr("insurancePolicy")]
                        .filter(Boolean)
                        .join(" · ")}
                    </dd>
                  </div>
                )}
                {metaStr("insuranceExpires") && (
                  <div>
                    <dt className="text-xs uppercase text-slate-500">Insurance expires</dt>
                    <dd
                      className={
                        daysUntil(metaStr("insuranceExpires")) <= 30
                          ? "text-red-300"
                          : "text-slate-200"
                      }
                    >
                      {new Date(metaStr("insuranceExpires")).toLocaleDateString()}{" "}
                      {daysUntil(metaStr("insuranceExpires")) < 0
                        ? "(expired)"
                        : `(in ${daysUntil(metaStr("insuranceExpires"))}d)`}
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {config.features.tracking && !isDomain && <LastSeenCard itemId={item.id} />}

          <AssignmentSection item={item} onChange={setItem} />

          <UnitsSection item={item} onChange={setItem} highlightUnitId={highlightUnitId} />

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
              Identifiers
            </h2>
            <ul className="space-y-1.5">
              {item.identifiers.map((idf) => (
                <li
                  key={idf.id}
                  className="flex items-center justify-between rounded-lg bg-slate-800/60 px-3 py-2"
                >
                  <span className="font-mono text-sm text-slate-200">
                    <span className="mr-2 text-xs uppercase text-slate-500">{idf.type}</span>
                    {idf.value}
                  </span>
                  <button
                    onClick={() => removeIdentifier(idf.id)}
                    aria-label="Remove identifier"
                    className="text-slate-500 hover:text-red-400"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                </li>
              ))}
              {item.identifiers.length === 0 && (
                <li className="text-sm text-slate-500">No identifiers yet.</li>
              )}
            </ul>
            <form onSubmit={addIdentifier} className="mt-2 flex gap-2">
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value as IdentifierType)}
                aria-label="Identifier type"
                className="rounded-lg border border-slate-700 bg-slate-800 px-2 py-2 text-sm text-slate-100"
              >
                {ID_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                placeholder="Add identifier (UPC, serial, asset tag…)"
                aria-label="Identifier value"
                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100"
              />
              <button className="rounded-lg bg-slate-700 px-4 text-sm text-slate-100 hover:bg-slate-600">
                Add
              </button>
            </form>
            {!isDomain && (
              <div className="mt-2 flex items-center gap-2">
                {rfidWaiting ? (
                  <>
                    <span className="animate-pulse text-sm text-sky-300">Read a tag now…</span>
                    <button
                      onClick={cancelTag}
                      className="rounded-lg border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={tagRfid}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
                  >
                    <TagIcon className="h-4 w-4" />
                    Bind an RFID tag
                  </button>
                )}
              </div>
            )}
            {error && <p className="mt-1 text-sm text-red-400">{error}</p>}
          </section>

          {!isDomain && <NfcTagUrl path={`/items/${item.id}`} kind="item" />}

          {item.children.length > 0 && (
            <section>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Contents ({item.children.length})
                </h2>
                {!isDomain && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={printContainerLabel}
                      className="rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      Container label
                    </button>
                    <button
                      onClick={printContents}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      <DocumentIcon className="h-3.5 w-3.5" />
                      Contents sheet
                    </button>
                  </div>
                )}
              </div>
              <ul className="space-y-1">
                {item.children.map((c) => (
                  <li key={c.id} className={c.flaggedMissing ? "rounded bg-red-950/40 px-2" : ""}>
                    <Link
                      to={`/items/${c.id}`}
                      className={c.flaggedMissing ? "text-red-300 hover:underline" : "text-sky-400 hover:underline"}
                    >
                      {c.name}
                    </Link>{" "}
                    <span className="text-sm text-slate-500">×{c.quantity}</span>
                    {c.flaggedMissing && <span className="ml-1 text-xs text-red-400">possibly missing</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
              History
            </h2>
            <ul className="space-y-1 text-sm text-slate-400">
              {item.events.map((ev) => (
                <li key={ev.id}>
                  <span className="text-slate-300">{ev.action}</span> ·{" "}
                  {new Date(ev.createdAt).toLocaleString()}
                </li>
              ))}
              {item.events.length === 0 && <li className="text-slate-500">No history.</li>}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
