import { Navigate, Route, Routes } from "react-router-dom";
import { SuppliesHome } from "./SuppliesHome";
import { MovePage } from "./MovePage";
import { CountPage } from "./CountPage";
import { SupplyDetail } from "./SupplyDetail";
import { AddSupply } from "./AddSupply";
import { KitCheckout } from "./KitCheckout";
import { KitPage } from "./KitPage";
import { HolderPage } from "./HolderPage";
import { ReportsPage } from "./ReportsPage";
import { LowStockPage } from "./LowStockPage";

/** Every Supplies screen, mounted under /supplies. */
export default function SuppliesRoutes() {
  return (
    <Routes>
      <Route index element={<SuppliesHome />} />
      <Route path="add" element={<AddSupply />} />
      <Route path="low" element={<LowStockPage />} />
      <Route path="count" element={<CountPage />} />
      <Route path="move/:reason" element={<MovePage />} />
      <Route path="items/:id" element={<SupplyDetail />} />
      <Route path="kits/new" element={<KitCheckout />} />
      <Route path="kits/:id" element={<KitPage />} />
      <Route path="holders/:id" element={<HolderPage />} />
      <Route path="reports" element={<ReportsPage />} />
      <Route path="*" element={<Navigate to="/supplies" replace />} />
    </Routes>
  );
}
