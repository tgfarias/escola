import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import "../../theme/styles";
import { useThemedDocument } from "../../theme/useThemedDocument";
import { KdsBoard } from "./KdsBoard";
import { KdsPair } from "./KdsPair";
import * as sync from "./sync";
import { useToday } from "./useToday";

export default function KdsApp() {
  useThemedDocument();
  const [params] = useSearchParams();
  // Sem ?date=, o quadro e o balcão seguem o dia local: um tablet ligado à noite passa para o novo dia sozinho.
  const today = useToday();
  const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date")! : today;
  const [paired, setPaired] = useState<boolean | null>(null);
  const [authLost, setAuthLost] = useState(false);
  useEffect(() => {
    void sync.isPaired().then(setPaired);
    // Tablet revogado ou sessão perdida: mostra o pareamento de novo, mantendo a outbox (sync.pair não a apaga).
    const t = window.setInterval(() => void sync.isAuthLost().then(setAuthLost), 5000);
    void sync.isAuthLost().then(setAuthLost);
    return () => window.clearInterval(t);
  }, []);
  if (paired === null) return null;
  if (!paired || authLost) {
    return (
      <KdsPair
        disconnected={paired && authLost}
        onPaired={() => {
          setAuthLost(false);
          setPaired(true);
        }}
      />
    );
  }
  return <KdsBoard serviceDate={serviceDate} onUnpaired={() => setPaired(false)} />;
}
