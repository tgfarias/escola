import { useEffect, useState } from "react";
import { localDate } from "./state";

const TICK_MS = 60_000;

/**
 * Dia local do tablet (o tablet fica na escola: é o dia no fuso dela), recalculado a cada minuto e quando a tela
 * volta a ficar visível. Só para a tela; a regra de negócio usa o relógio do banco.
 */
export function useToday(): string {
  const [today, setToday] = useState(() => localDate(new Date()));
  useEffect(() => {
    const update = () => setToday(localDate(new Date()));
    const onVisible = () => {
      if (document.visibilityState === "visible") update();
    };
    const timer = window.setInterval(update, TICK_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return today;
}
