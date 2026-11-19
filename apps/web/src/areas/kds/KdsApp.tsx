import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import "../../theme/styles";
import { KdsBoard } from "./KdsBoard";
import { KdsPair } from "./KdsPair";
import { localDate } from "./state";
import * as sync from "./sync";

export default function KdsApp() {
  const [params] = useSearchParams();
  const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "") ? params.get("date")! : localDate(new Date());
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
