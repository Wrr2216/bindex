import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/useAuth";
import { SignIn } from "./auth/SignIn";
import { ConfigProvider, useConfig, useFeatures } from "./config/useConfig";
import { ScanProvider } from "./scan/ScanProvider";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { Dashboard } from "./pages/Dashboard";
import { Items } from "./pages/Items";
import { ItemDetail } from "./pages/ItemDetail";
import { Locations } from "./pages/Locations";
import { LocationDetail } from "./pages/LocationDetail";
import { Entities } from "./pages/Entities";
import { Domains } from "./pages/Domains";
import { Audit } from "./pages/Audit";
import { BuildingAudit } from "./pages/BuildingAudit";
import { Settings } from "./pages/Settings";
import { PrintLabels } from "./pages/PrintLabels";
import { AuditLogPage } from "./features/event-backbone/AuditLogPage";
import { WebhooksPage } from "./features/event-backbone/WebhooksPage";
import { LiveReads } from "./features/tracking-core/LiveReads";
import { DevicesPage } from "./features/tracking-core/DevicesPage";
import {
  JobDetailPage,
  JobTypesPage,
  JobsPage,
  ProjectDetailPage,
  ProjectsPage,
  ShipmentDetailPage,
} from "./features/jobs-core";
import { RegisterReconcile } from "./features/register-reconcile/RegisterReconcile";

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center text-slate-400">Loading…</div>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  const { loading: configLoading } = useConfig();

  // Both have to land before anything renders. The sign-in screen shows the
  // instance name, and every screen behind it reads the vocabulary and the
  // feature switches, so rendering early means rendering the wrong thing.
  if (loading || configLoading) return <Loading />;
  if (!user) return <SignIn />;

  return (
    <Routes>
      {/* The print view has no app chrome and no global scan listener. */}
      <Route path="/print" element={<PrintLabels />} />
      <Route path="/*" element={<AppShell />} />
    </Routes>
  );
}

function AppShell() {
  const features = useFeatures();

  return (
    <ScanProvider>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="items" element={<Items />} />
          <Route path="items/:id" element={<ItemDetail />} />
          {features.domains && <Route path="domains" element={<Domains />} />}
          <Route path="locations" element={<Locations />} />
          <Route path="locations/:id" element={<LocationDetail />} />
          {features.holders && <Route path="entities" element={<Entities />} />}
          {features.audit && <Route path="audit" element={<Audit />} />}
          {features.audit && <Route path="audit/building" element={<BuildingAudit />} />}
          <Route path="settings" element={<Settings />} />
          <Route path="settings/audit-log" element={<AuditLogPage />} />
          <Route path="settings/webhooks" element={<WebhooksPage />} />
          {features.tracking && <Route path="tracking" element={<LiveReads />} />}
          {features.tracking && <Route path="settings/devices" element={<DevicesPage />} />}
          {features.jobs && <Route path="jobs" element={<JobsPage />} />}
          {features.jobs && <Route path="jobs/:id" element={<JobDetailPage />} />}
          {features.jobs && <Route path="projects" element={<ProjectsPage />} />}
          {features.jobs && <Route path="projects/:id" element={<ProjectDetailPage />} />}
          {features.jobs && <Route path="shipments/:id" element={<ShipmentDetailPage />} />}
          {features.jobs && <Route path="settings/job-types" element={<JobTypesPage />} />}
          {features.registerReconcile && <Route path="audit/register/*" element={<RegisterReconcile />} />}
        </Route>
      </Routes>
    </ScanProvider>
  );
}

export default function App() {
  return (
    <ConfigProvider>
      <AuthProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </AuthProvider>
    </ConfigProvider>
  );
}
