import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Link, Route, Routes, useNavigate } from "react-router";
import { LinkLanding } from "../areas/guardian/LinkLanding";
import { CheckoutPage } from "../areas/guardian/CheckoutPage";
import { DocumentsPage } from "../areas/guardian/DocumentsPage";
import { OrderHome } from "../areas/guardian/OrderHome";
import { WalletPage } from "../areas/guardian/WalletPage";
import { AreaErrorBoundary } from "./AreaErrorBoundary";

const AdminArea = lazy(() => import("../areas/admin/AdminArea"));
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

function LazyArea({ children }: { children: ReactNode }) {
  return (
    <AreaErrorBoundary>
      <Suspense fallback={null}>{children}</Suspense>
    </AreaErrorBoundary>
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
      <Route path="/documentos" element={<DocumentsPage />} />
      <Route path="/admin/*" element={<LazyArea><AdminArea /></LazyArea>} />
      <Route path="/kds" element={<LazyArea><KdsApp /></LazyArea>} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
