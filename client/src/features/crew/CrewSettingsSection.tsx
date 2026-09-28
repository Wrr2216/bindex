import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BUTTON, BUTTON_QUIET, Pill, Section } from "../../components/ui";
import { crewApi } from "./api";

/** The Settings entry point for crew check-in, for administrators. */
export function CrewSettingsSection() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    crewApi
      .credentialTypes()
      .then((t) => setCount(t.length))
      .catch(() => setCount(null));
  }, []);

  return (
    <Section
      title="Crew check-in"
      description="The credentials workers can hold, what each job type requires of its crew, and whether a missing or expired one blocks the check-in or only warns."
      aside={<Pill tone={count ? "on" : "off"}>{count === null ? "Not loaded" : `${count} credential types`}</Pill>}
    >
      <div className="mt-4 flex flex-wrap gap-3">
        <Link to="/settings/crew" className={BUTTON}>
          Credential types and rules
        </Link>
        <Link to="/crew?tab=workers" className={BUTTON_QUIET}>
          Workers
        </Link>
      </div>
    </Section>
  );
}
