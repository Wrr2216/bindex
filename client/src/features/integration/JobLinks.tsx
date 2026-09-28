import { Link } from "react-router-dom";
import { useFeatures } from "../../config/useConfig";

/**
 * Where a job's work continues in other features. Those features were built
 * alongside jobs rather than inside them, so the job page links out to each
 * one that is switched on instead of every feature editing the page.
 */
export function JobLinks({ jobId }: { jobId: string }) {
  const f = useFeatures();
  const id = encodeURIComponent(jobId);
  const links: { to: string; label: string }[] = [
    ...(f.placement ? [{ to: `/placement/jobs/${id}`, label: "Placement" }] : []),
    ...(f.crew ? [{ to: `/crew/jobs/${id}`, label: "Crew check-in" }] : []),
    ...(f.inspections
      ? [
          { to: `/inspections?new=1&jobId=${id}&kind=pre`, label: "Pre-move inspection" },
          { to: `/inspections?new=1&jobId=${id}&kind=post`, label: "Post-move inspection" },
        ]
      : []),
    ...(f.documents ? [{ to: `/documents/jobs/${id}`, label: "Documents" }] : []),
    ...(f.custody ? [{ to: "/custody", label: "Custody and sign-off" }] : []),
    ...(f.opsIntel ? [{ to: "/insights", label: "Insights" }] : []),
  ];
  if (!links.length) return null;
  return (
    <nav aria-label="Related" className="flex flex-wrap gap-2">
      {links.map((l) => (
        <Link
          key={l.to}
          to={l.to}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
        >
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
