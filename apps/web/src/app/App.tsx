import { lazy, Suspense, useEffect } from "react";
import { Link, Route, Routes, useNavigate } from "react-router";
import { AdminHome } from "../areas/admin/AdminHome";
import { AdminLogin } from "../areas/admin/AdminLogin";
import { LinkLanding } from "../areas/guardian/LinkLanding";
import { CheckoutPage } from "../areas/guardian/CheckoutPage";
import { OrderHome } from "../areas/guardian/OrderHome";
import { WalletPage } from "../areas/guardian/WalletPage";

const KdsApp = lazy(() => import("../areas/kds/KdsApp"));

function Home() {
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    // The installed PWA opens at "/": a paired kitchen tablet goes straight to the KDS. The sync module is loaded
    // on demand so the guardian bundle does not carry Dexie; a browser without IndexedDB simply stays here.
    void (async () => {
      try {
        const { isPaired } = await import("../areas/kds/sync");
        if ((await isPaired()) && active) navigate("/kds", { replace: true });
      } catch {
        // No local store: not a paired tablet.
      }
    })();
    return () => {
      active = false;
    };
  }, [navigate]);
  return (
    <main>
      <h1>App Lanche</h1>
      <p>Abra o link que a escola enviou pelo WhatsApp.</p>
      <p>
        <Link to="/kds">Tablet da cozinha</Link>
      </p>
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
