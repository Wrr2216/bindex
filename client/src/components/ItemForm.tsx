import { useEffect, useState, type FormEvent } from "react";
import { api, type CreateItemPayload } from "../api/client";
import { useConfig } from "../config/useConfig";
import { makeLocationLabel } from "../lib/locationLabel";
import type { Company, Enrichment, Entity, IdentifierType, ItemDetail, Location } from "../types";
import { CreatableSelect } from "./CreatableSelect";
import { ChevronDownIcon } from "./icons";
import { useLabelCapture } from "../features/media-ai-core";

const FIELD =
  "w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-slate-100 placeholder-slate-500 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500";
const LABEL = "block text-xs font-medium uppercase tracking-wide text-slate-400";

const ID_TYPES: IdentifierType[] = ["upc", "serial", "asset_tag", "mac", "sku", "other", "rfid", "nfc", "legacy"];

function guessType(code: string): IdentifierType {
  if (/^\d{8}$|^\d{12,14}$/.test(code)) return "upc";
  if (/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/.test(code)) return "mac";
  return "serial";
}

/** A typed amount as whole cents, or null when it is empty or not a number. */
function parseValueCents(input: string): number | null {
  const n = parseFloat(input.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function ItemForm({
  code,
  enrichment,
  item,
  locations,
  onSaved,
  onCancel,
}: {
  code?: string;
  enrichment?: Enrichment;
  item?: ItemDetail;
  locations: Location[];
  onSaved: (item: ItemDetail) => void;
  onCancel?: () => void;
}) {
  const { config } = useConfig();
  const { terms, features } = config;
  const editing = Boolean(item);
  const [name, setName] = useState(item?.name ?? enrichment?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? enrichment?.description ?? "");
  const [brand, setBrand] = useState(item?.brand ?? enrichment?.brand ?? "");
  const [model, setModel] = useState(item?.model ?? enrichment?.model ?? "");
  const [category, setCategory] = useState(item?.category ?? enrichment?.category ?? "");
  const [locationId, setLocationId] = useState(item?.locationId ?? "");
  const [entityId, setEntityId] = useState(item?.utilizedByEntityId ?? "");
  const [entities, setEntities] = useState<Entity[]>([]);
  const [companyId, setCompanyId] = useState(item?.companyId ?? "");
  const [companies, setCompanies] = useState<Company[]>([]);
  const [quantity, setQuantity] = useState(item?.quantity ?? 1);
  const [value, setValue] = useState(
    item?.valueCents != null ? (item.valueCents / 100).toFixed(2) : "",
  );

  useEffect(() => {
    api.listEntities().then(setEntities).catch(() => undefined);
    api.listCompanies().then(setCompanies).catch(() => undefined);
  }, []);

  /**
   * Picking a location suggests its group, but only when none was chosen. Where
   * something sits is a good guess at who owns it, not a rule.
   */
  const chooseLocation = (next: string) => {
    setLocationId(next);
    if (!companyId && next) {
      const loc = locations.find((l) => l.id === next);
      if (loc?.companyId) setCompanyId(loc.companyId);
    }
  };
  const [imageUrl, setImageUrl] = useState(item?.primaryImageUrl ?? enrichment?.imageUrl ?? "");
  const [idType, setIdType] = useState<IdentifierType>(code ? guessType(code) : "upc");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Read from label": brand and model go straight into the fields above;
  // identifiers and the photo wait for the save.
  const label = useLabelCapture({
    item,
    onFill: (f) => {
      if (f.brand) setBrand(f.brand);
      if (f.model) setModel(f.model);
    },
  });

  // Vehicle and equipment details live in item.metadata, so a truck or a
  // generator can carry its title, registration and insurance on its own page.
  const metaStr = (key: string) =>
    typeof item?.metadata[key] === "string" ? (item.metadata[key] as string) : "";
  const [vin, setVin] = useState(metaStr("vin"));
  const [licensePlate, setLicensePlate] = useState(metaStr("licensePlate"));
  const [titleLocation, setTitleLocation] = useState(metaStr("titleLocation"));
  const [registrationExpires, setRegistrationExpires] = useState(metaStr("registrationExpires"));
  const [insuranceProvider, setInsuranceProvider] = useState(metaStr("insuranceProvider"));
  const [insurancePolicy, setInsurancePolicy] = useState(metaStr("insurancePolicy"));
  const [insuranceExpires, setInsuranceExpires] = useState(metaStr("insuranceExpires"));
  const [fleetUrl, setFleetUrl] = useState(metaStr("fleetUrl"));
  const [showVehicle, setShowVehicle] = useState(
    Boolean(
      vin || licensePlate || titleLocation || registrationExpires ||
        insuranceProvider || insurancePolicy || insuranceExpires || fleetUrl,
    ),
  );

  const vehicleMetadata = (): Record<string, unknown> => {
    const m: Record<string, unknown> = { ...(item?.metadata ?? {}) };
    const put = (key: string, value: string) => {
      if (value.trim()) m[key] = value.trim();
      else delete m[key];
    };
    put("vin", vin);
    put("licensePlate", licensePlate);
    put("titleLocation", titleLocation);
    put("registrationExpires", registrationExpires);
    put("insuranceProvider", insuranceProvider);
    put("insurancePolicy", insurancePolicy);
    put("insuranceExpires", insuranceExpires);
    put("fleetUrl", fleetUrl);
    return m;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const base: Partial<CreateItemPayload> = {
        name: name.trim(),
        description: description.trim() || null,
        brand: brand.trim() || null,
        model: model.trim() || null,
        category: category.trim() || null,
        locationId: locationId || null,
        utilizedByEntityId: entityId || null,
        companyId: companyId || null,
        valueCents: parseValueCents(value),
        quantity,
        primaryImageUrl: imageUrl.trim() || null,
        metadata: vehicleMetadata(),
      };
      let saved: ItemDetail;
      if (editing && item) {
        saved = await api.updateItem(item.id, base);
      } else {
        saved = await api.createItem({
          ...(base as CreateItemPayload),
          enrichmentSource: enrichment?.found ? enrichment.source : "manual",
          identifiers: label.withIdentifiers(code ? [{ type: idType, value: code }] : []),
          images: imageUrl.trim() ? [imageUrl.trim()] : [],
        });
      }
      saved = await label.commit(saved, { created: !editing });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {code && !editing && (
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className={LABEL} htmlFor="id-value">
              Scanned identifier
            </label>
            <input id="id-value" className={`${FIELD} font-mono`} value={code} readOnly />
          </div>
          <div>
            <label className={LABEL} htmlFor="id-type">
              Type
            </label>
            <select
              id="id-type"
              className={FIELD}
              value={idType}
              onChange={(e) => setIdType(e.target.value as IdentifierType)}
            >
              {ID_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div>
        <label className={LABEL} htmlFor="name">
          Name *
        </label>
        <input
          id="name"
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus={!name}
          placeholder="e.g. UniFi U6 Pro Access Point"
        />
      </div>

      <div>
        <label className={LABEL} htmlFor="description">
          Description
        </label>
        <textarea
          id="description"
          className={FIELD}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {label.control}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={LABEL} htmlFor="brand">
            Brand
          </label>
          <input id="brand" className={FIELD} value={brand} onChange={(e) => setBrand(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="model">
            Model
          </label>
          <input id="model" className={FIELD} value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <div>
          <label className={LABEL} htmlFor="category">
            Category
          </label>
          <input
            id="category"
            className={FIELD}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="quantity">
            Quantity
          </label>
          <input
            id="quantity"
            type="number"
            min={1}
            className={FIELD}
            value={quantity}
            onChange={(e) => setQuantity(Math.max(1, Number(e.target.value)))}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="value">
            Value ($)
          </label>
          <input
            id="value"
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            className={FIELD}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0.00"
          />
        </div>
      </div>

      <CreatableSelect
        label={terms.location.singular}
        placeholder="Unassigned"
        createLabel={`+ New ${terms.location.singular.toLowerCase()}…`}
        value={locationId}
        onChange={chooseLocation}
        options={(() => {
          const label = makeLocationLabel(locations);
          return locations.map((l) => ({ id: l.id, name: label(l) }));
        })()}
        onCreate={(name) => api.createLocation({ name }).then((l) => ({ id: l.id, name: l.name }))}
      />

      <CreatableSelect
        label={`Used by (${terms.holder.singular.toLowerCase()})`}
        placeholder="Not assigned"
        createLabel={`+ New ${terms.holder.singular.toLowerCase()}…`}
        value={entityId}
        onChange={setEntityId}
        options={entities.map((e) => ({ id: e.id, name: e.kind ? `${e.name} (${e.kind})` : e.name }))}
        onCreate={(name) =>
          api.createEntity({ name }).then((e) => {
            setEntities((x) => [...x, e]);
            return { id: e.id, name: e.name };
          })
        }
      />

      {features.groups && (
        <CreatableSelect
          label={terms.group.singular}
          placeholder={`No ${terms.group.singular.toLowerCase()}`}
          createLabel={`+ New ${terms.group.singular.toLowerCase()}…`}
          value={companyId}
          onChange={setCompanyId}
          options={companies.map((c) => ({ id: c.id, name: c.name }))}
          onCreate={(name) =>
            api.createCompany({ name }).then((c) => {
              setCompanies((x) => [...x, c]);
              return { id: c.id, name: c.name };
            })
          }
        />
      )}

      <div className={`rounded-xl border border-slate-800 ${features.vehicleFields ? "" : "hidden"}`}>
        <button
          type="button"
          onClick={() => setShowVehicle((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
        >
          <span>Vehicle &amp; equipment details</span>
          <ChevronDownIcon
            className={`h-4 w-4 text-slate-500 transition ${showVehicle ? "rotate-180" : ""}`}
          />
        </button>
        {showVehicle && (
          <div className="space-y-3 border-t border-slate-800 p-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL} htmlFor="vin">
                  VIN / serial
                </label>
                <input id="vin" className={FIELD} value={vin} onChange={(e) => setVin(e.target.value)} />
              </div>
              <div>
                <label className={LABEL} htmlFor="plate">
                  License plate
                </label>
                <input
                  id="plate"
                  className={FIELD}
                  value={licensePlate}
                  onChange={(e) => setLicensePlate(e.target.value)}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="title-location">
                  Title kept at
                </label>
                <input
                  id="title-location"
                  className={FIELD}
                  value={titleLocation}
                  onChange={(e) => setTitleLocation(e.target.value)}
                  placeholder="e.g. Office safe, glovebox"
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="registration-expires">
                  Registration expires
                </label>
                <input
                  id="registration-expires"
                  type="date"
                  className={FIELD}
                  value={registrationExpires}
                  onChange={(e) => setRegistrationExpires(e.target.value)}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="insurance-provider">
                  Insurance provider
                </label>
                <input
                  id="insurance-provider"
                  className={FIELD}
                  value={insuranceProvider}
                  onChange={(e) => setInsuranceProvider(e.target.value)}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="insurance-policy">
                  Policy #
                </label>
                <input
                  id="insurance-policy"
                  className={FIELD}
                  value={insurancePolicy}
                  onChange={(e) => setInsurancePolicy(e.target.value)}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="insurance-expires">
                  Insurance expires
                </label>
                <input
                  id="insurance-expires"
                  type="date"
                  className={FIELD}
                  value={insuranceExpires}
                  onChange={(e) => setInsuranceExpires(e.target.value)}
                />
              </div>
              <div>
                <label className={LABEL} htmlFor="fleet-url">
                  Fleet page URL
                </label>
                <input
                  id="fleet-url"
                  type="url"
                  className={FIELD}
                  value={fleetUrl}
                  onChange={(e) => setFleetUrl(e.target.value)}
                  placeholder="https://… (maintenance records)"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div>
        <label className={LABEL} htmlFor="image">
          Image URL
        </label>
        <input id="image" className={FIELD} value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="flex-1 rounded-lg bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {busy ? "Saving…" : editing ? "Save changes" : "Create item"}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-700 px-4 py-2 text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
