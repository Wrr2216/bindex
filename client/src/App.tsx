import { BrowserRouter, Route, Routes, useLocation } from "react-router-dom";
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
import { SuppliesSection } from "./features/consumables";
import { TagsPage } from "./features/tag-commissioning/TagsPage";
import { NfcTapLayer } from "./features/tag-commissioning/NfcTapLayer";
import { OfflinePage } from "./features/offline-field/OfflinePage";
import { OfflineStatus } from "./features/offline-field/OfflineStatus";
import { CaptureListPage } from "./features/bulk-capture/CaptureListPage";
import { CaptureSessionPage } from "./features/bulk-capture/CaptureSessionPage";
import { ConditionPage, SweepPage } from "./features/ai-condition";
import { InspectionDetailPage, InspectionsListPage } from "./features/inspections";
import { DeclarationPage, ReceiptPage, ValuationPage } from "./features/valuation";
import { CrewBadgePage, CrewCheckInPage, CrewPage, CrewSettingsPage, CrewWorkerPage } from "./features/crew";
import { CustodyPage, NewTransferPage, SignOffPage, TransferPage } from "./features/custody";
import { GuidePage, TeardownList } from "./features/teardown";
import { GeofencesPage, GpsMapPage, ShipmentMapPage, TrackersPage, TrailPage } from "./features/gps";
import {
  DocumentFieldsPage,
  DocumentPacketsPage,
  DocumentPage,
  DocumentTemplateEditorPage,
  DocumentTemplatesPage,
  DocumentVerifyPage,
  DocumentsPage,
  JobDocumentsPage,
} from "./features/documents";
import { PortalAdminPage, PortalLinkPage } from "./features/portal";
import { InsightsPage } from "./features/ops-intel";
import { BlePage } from "./features/ble/BlePage";
import {
  PlacementHomePage,
  PlacementJobPage,
  PlacementKioskPage,
  PlacementSweepPage,
  PlacementWherePage,
} from "./features/placement";
import { ClaimDetailPage, ClaimsPage, NewClaimPage } from "./features/claims";

function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center text-slate-400">Loading…</div>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  const { loading: configLoading } = useConfig();
  const { pathname } = useLocation();

  // A portal link is for someone without an account: it never asks them to
  // sign in, and the link itself is all it authenticates with.
  if (pathname.startsWith("/p/")) return <PortalLinkPage />;

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
          {features.consumables && <Route path="supplies/*" element={<SuppliesSection />} />}
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
          <Route path="tags" element={<TagsPage />} />
          {features.offline && <Route path="offline" element={<OfflinePage />} />}
          {features.bulkCapture && <Route path="capture" element={<CaptureListPage />} />}
          {features.bulkCapture && <Route path="capture/:id" element={<CaptureSessionPage />} />}
          {features.aiCondition && <Route path="condition" element={<ConditionPage />} />}
          {features.aiCondition && <Route path="condition/sweeps/:id" element={<SweepPage />} />}
          {features.inspections && <Route path="inspections" element={<InspectionsListPage />} />}
          {features.inspections && <Route path="inspections/:id" element={<InspectionDetailPage />} />}
          {features.valuation && <Route path="valuation" element={<ValuationPage />} />}
          {features.valuation && <Route path="valuation/declarations/:id" element={<DeclarationPage />} />}
          {features.valuation && <Route path="valuation/receipts/:id" element={<ReceiptPage />} />}
          {features.crew && <Route path="crew" element={<CrewPage />} />}
          {features.crew && <Route path="crew/jobs/:jobId" element={<CrewCheckInPage />} />}
          {features.crew && <Route path="crew/workers/:id" element={<CrewWorkerPage />} />}
          {features.crew && <Route path="crew/badge/:code" element={<CrewBadgePage />} />}
          {features.crew && <Route path="settings/crew" element={<CrewSettingsPage />} />}
          {features.custody && <Route path="custody" element={<CustodyPage />} />}
          {features.custody && <Route path="custody/new" element={<NewTransferPage />} />}
          {features.custody && <Route path="custody/transfers/:id" element={<TransferPage />} />}
          {features.custody && <Route path="custody/shipments/:id/sign-off" element={<SignOffPage />} />}
          {features.teardown && <Route path="teardown" element={<TeardownList />} />}
          {features.teardown && <Route path="teardown/:id" element={<GuidePage />} />}
          {features.gps && features.tracking && <Route path="gps" element={<GpsMapPage />} />}
          {features.gps && features.tracking && <Route path="gps/trackers" element={<TrackersPage />} />}
          {features.gps && features.tracking && <Route path="gps/trackers/:id" element={<TrailPage />} />}
          {features.gps && features.tracking && <Route path="gps/items/:id" element={<TrailPage />} />}
          {features.gps && features.tracking && <Route path="gps/geofences" element={<GeofencesPage />} />}
          {features.gps && features.tracking && features.jobs && (
            <Route path="gps/shipments/:id" element={<ShipmentMapPage />} />
          )}
          {features.documents && <Route path="documents" element={<DocumentsPage />} />}
          {features.documents && <Route path="documents/verify" element={<DocumentVerifyPage />} />}
          {features.documents && <Route path="documents/jobs/:jobId" element={<JobDocumentsPage />} />}
          {features.documents && <Route path="documents/:id" element={<DocumentPage />} />}
          {features.documents && <Route path="settings/document-templates" element={<DocumentTemplatesPage />} />}
          {features.documents && <Route path="settings/document-templates/:id" element={<DocumentTemplateEditorPage />} />}
          {features.documents && <Route path="settings/document-packets" element={<DocumentPacketsPage />} />}
          {features.documents && <Route path="settings/document-fields" element={<DocumentFieldsPage />} />}
          {features.portal && <Route path="portal" element={<PortalAdminPage />} />}
          {features.opsIntel && <Route path="insights" element={<InsightsPage />} />}
          {features.ble && <Route path="ble" element={<BlePage />} />}
          {features.jobs && features.placement && <Route path="placement" element={<PlacementHomePage />} />}
          {features.jobs && features.placement && <Route path="placement/jobs/:id" element={<PlacementJobPage />} />}
          {features.jobs && features.placement && <Route path="placement/jobs/:id/where" element={<PlacementWherePage />} />}
          {features.jobs && features.placement && <Route path="placement/jobs/:id/sweep" element={<PlacementSweepPage />} />}
          {features.jobs && features.placement && <Route path="placement/jobs/:id/kiosk" element={<PlacementKioskPage />} />}
          {features.claims && <Route path="claims" element={<ClaimsPage />} />}
          {features.claims && <Route path="claims/new" element={<NewClaimPage />} />}
          {features.claims && <Route path="claims/:id" element={<ClaimDetailPage />} />}
        </Route>
      </Routes>
      <NfcTapLayer />
      <OfflineStatus />
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
