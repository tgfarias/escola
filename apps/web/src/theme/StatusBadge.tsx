import type { ReactNode } from "react";

export type Tone = "primary" | "secondary" | "success" | "info" | "warning" | "danger" | "light";

/** Selo de situação. Usa .text-bg-*: o Bootstrap escolhe texto claro ou escuro com contraste AA (ver _brand.scss). */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge rounded-pill text-bg-${tone}`}>{children}</span>;
}
