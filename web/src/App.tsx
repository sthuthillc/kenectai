import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { AuthCallback } from "./pages/AuthCallback";
import { BillingCancelled, BillingSuccess } from "./pages/Billing";
import { Dashboard } from "./pages/Dashboard";
import { Pricing } from "./pages/Pricing";

export function App() {
  return (
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/billing/success" element={<BillingSuccess />} />
          <Route path="/billing/cancelled" element={<BillingCancelled />} />
          <Route path="*" element={<Navigate to="/pricing" replace />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  );
}
