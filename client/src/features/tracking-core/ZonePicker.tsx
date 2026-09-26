import { useMemo } from "react";
import { useTerms } from "../../config/useConfig";
import { FIELD } from "../../components/ui";
import { makeLocationLabel } from "../../lib/locationLabel";
import type { Location } from "../../types";

/**
 * A location picker that shows each location's full path, sorted so nested
 * zones sit under their parents ("Warehouse / Dock A / Door 1").
 */
export function ZonePicker({
  locations,
  value,
  onChange,
  emptyLabel,
  label,
}: {
  locations: Location[];
  value: string | null;
  onChange: (id: string | null) => void;
  emptyLabel?: string;
  label: string;
}) {
  const terms = useTerms();
  const options = useMemo(() => {
    const labelOf = makeLocationLabel(locations);
    return locations
      .map((l) => ({ id: l.id, path: labelOf(l) }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [locations]);

  return (
    <select
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label={label}
      className={FIELD}
    >
      <option value="">{emptyLabel ?? `No ${terms.location.singular.toLowerCase()}`}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.path}
        </option>
      ))}
    </select>
  );
}
