import { useLayoutEffect } from "react";

const THEMED_CLASS = "app-themed";
let mounted = 0;

/**
 * Liga o tema do admin e do KDS (todo seletor de theme.scss fica sob html.app-themed, ver build/themeScope.ts)
 * enquanto a área está montada. Ao voltar para a Home sem recarregar, a classe sai e o tema deixa de valer.
 */
export function useThemedDocument(): void {
  useLayoutEffect(() => {
    mounted += 1;
    document.documentElement.classList.add(THEMED_CLASS);
    return () => {
      mounted -= 1;
      if (mounted === 0) document.documentElement.classList.remove(THEMED_CLASS);
    };
  }, []);
}
