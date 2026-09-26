import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { crewApi } from "./api";
import { Notice, errorText } from "./ui";

/**
 * Where a badge QR lands when scanned with a phone's own camera
 * (/crew/badge/CRW-7F3K2A): straight on to the worker's page.
 */
export function BadgeRedirect() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    crewApi
      .workerByBadge(code)
      .then((w) => navigate(`/crew/workers/${w.id}`, { replace: true }))
      .catch((err) => setError(errorText(err, "That badge could not be looked up.")));
  }, [code, navigate]);

  if (!error) return <p className="text-slate-400">Looking up badge {code}…</p>;
  return (
    <div className="space-y-3">
      <Notice tone="error">{error}</Notice>
      <Link to={`/crew?tab=workers&new=1&badge=${encodeURIComponent(code)}`} className="text-sm text-sky-400 hover:underline">
        Add a worker with this badge
      </Link>
    </div>
  );
}
