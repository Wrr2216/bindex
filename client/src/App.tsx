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
import { TagsPage } from "./features/tag-commissioning/TagsPage";
import { NfcTapLayer } from "./features/tag-commissioning/NfcTapLayer";

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
          <Route path="tags" element={<TagsPage />} />
        </Route>
      </Routes>
      <NfcTapLayer />
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
