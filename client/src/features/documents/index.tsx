import { lazy, Suspense, type ComponentType } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/useAuth";
import { useFeatures } from "../../config/useConfig";
import { Section } from "../../components/ui";

/**
 * Documents screens for App.tsx. Each loads on first visit, so an instance
 * with the feature switched off, or someone who never opens a document, does
 * not download them.
 */

function lazyPage<P extends object = object>(load: () => Promise<ComponentType<P>>) {
  const Page = lazy(async () => ({ default: await load() }));
  return function LazyPage(props: P) {
    return (
      <Suspense fallback={<p className="text-slate-400">Loading…</p>}>
        <Page {...props} />
      </Suspense>
    );
  };
}

export const DocumentsPage = lazyPage(() => import("./DocumentsPage").then((m) => m.DocumentsPage));
export const DocumentPage = lazyPage(() => import("./DocumentPage").then((m) => m.DocumentPage));
export const JobDocumentsPage = lazyPage(() => import("./JobDocumentsPage").then((m) => m.JobDocumentsPage));
export const DocumentVerifyPage = lazyPage(() => import("./VerifyPage").then((m) => m.VerifyPage));
export const DocumentTemplatesPage = lazyPage(() => import("./TemplatesPage").then((m) => m.TemplatesPage));
export const DocumentTemplateEditorPage = lazyPage(() => import("./TemplateEditor").then((m) => m.TemplateEditor));
export const DocumentPacketsPage = lazyPage(() => import("./PacketsPage").then((m) => m.PacketsPage));
export const DocumentFieldsPage = lazyPage(() => import("./FieldsPage").then((m) => m.FieldsPage));

/**
 * A job's packets and documents as a panel, for the job page:
 * `<JobDocumentsPanel jobId={job.id} />`. Renders nothing while the feature is off.
 */
const LazyJobPanel = lazyPage<{ jobId: string }>(() => import("./JobDocumentsPage").then((m) => m.JobDocumentsPanel));
export function JobDocumentsPanel({ jobId }: { jobId: string }) {
  return useFeatures().documents ? <LazyJobPanel jobId={jobId} /> : null;
}

/** Settings: where administrators find templates, packets and the field library. */
export function DocumentsSettingsSection() {
  const { user } = useAuth();
  const features = useFeatures();
  if (!features.documents || user?.role !== "admin") return null;
  const link = "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800";
  return (
    <Section
      title="Documents"
      description="Templates people fill in and sign, the packets that attach them to jobs, and the library of reusable fields."
    >
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to="/settings/document-templates" className={link}>
          Templates
        </Link>
        <Link to="/settings/document-packets" className={link}>
          Packets
        </Link>
        <Link to="/settings/document-fields" className={link}>
          Field library
        </Link>
      </div>
    </Section>
  );
}
