import { liveQuery } from "dexie";
import { useEffect, useState } from "react";

/** Assina uma consulta Dexie e re-renderiza a cada mudança (sem dexie-react-hooks). */
export function useLive<T>(query: () => Promise<T>, deps: unknown[]): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    setValue(undefined);
    const sub = liveQuery(query).subscribe({
      next: setValue,
      error: (err: unknown) => {
        console.warn("kds live query failed", err instanceof Error ? err.name : "unknown");
        setValue(undefined);
      },
    });
    return () => sub.unsubscribe();
  }, deps);
  return value;
}
