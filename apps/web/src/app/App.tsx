import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import { AdminHome } from "../areas/admin/AdminHome";
import { AdminLogin } from "../areas/admin/AdminLogin";
import { LinkLanding } from "../areas/guardian/LinkLanding";
import { CheckoutPage } from "../areas/guardian/CheckoutPage";
import { OrderHome } from "../areas/guardian/OrderHome";
import { WalletPage } from "../areas/guardian/WalletPage";

const KdsApp = lazy(() => import("../areas/kds/KdsApp"));

function Home() {
  return (
    <main>
      <h1>App Lanche</h1>
      <p>Abra o link que a escola enviou pelo WhatsApp.</p>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/l" element={<LinkLanding />} />
      <Route path="/pedido" element={<OrderHome />} />
      <Route path="/pedido/checkout/:id" element={<CheckoutPage />} />
      <Route path="/carteira" element={<WalletPage />} />
      <Route path="/documentos" element={<OrderHome />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route path="/admin" element={<AdminHome />} />
      <Route path="/kds" element={<Suspense fallback={null}><KdsApp /></Suspense>} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
