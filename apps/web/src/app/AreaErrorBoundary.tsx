import { Component, type ReactNode } from "react";

type Props = { children: ReactNode; onReload?: () => void };

/**
 * Admin e KDS são chunks carregados sob demanda: depois de um deploy (aba com o index antigo) ou com a rede ruim, o
 * import() falha. Sem isto a árvore inteira desmonta e a tela fica em branco. Fica fora do tema (pacote dos responsáveis).
 */
export class AreaErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const reload = this.props.onReload ?? (() => window.location.reload());
    return (
      <main>
        <p role="alert">Não foi possível carregar esta área. Verifique a conexão e recarregue a página.</p>
        <button type="button" onClick={reload}>
          Recarregar
        </button>
      </main>
    );
  }
}
