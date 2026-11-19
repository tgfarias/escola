import type { UserConfig } from "vite";

/**
 * Raiz do tema: useThemedDocument põe a classe em <html> enquanto o admin ou o KDS está montado. A folha do tema,
 * carregada sob demanda, fica no documento depois de voltar para a Home sem recarregar; com todo seletor sob esta
 * raiz, ela deixa de valer para as telas dos responsáveis.
 */
export const THEME_SCOPE = "html.app-themed";
const THEME_FILE = /[/\\]src[/\\]theme[/\\]theme\.scss$/;

/** Põe o seletor sob THEME_SCOPE; :root e html viram a própria raiz, para as variáveis e o reboot continuarem valendo. */
export function scopeSelector(selector: string): string {
  const s = selector.trim();
  if (s === THEME_SCOPE || s.startsWith(`${THEME_SCOPE} `)) return s;
  const root = /^(:root|html)(?![\w-])/.exec(s);
  if (root) return `${THEME_SCOPE}${s.slice(root[0].length)}`;
  return `${THEME_SCOPE} ${s}`;
}

type PostcssOptions = Exclude<NonNullable<NonNullable<UserConfig["css"]>["postcss"]>, string>;
type PostcssPlugin = NonNullable<PostcssOptions["plugins"]>[number];

interface CssNode {
  type: string;
  name?: string;
  parent?: CssNode;
  selectors?: string[];
}
interface CssRoot {
  source?: { input: { file?: string } };
  walkRules(cb: (rule: CssNode & { selectors: string[] }) => void): void;
}

/** Plugin PostCSS (sem dependência: o Vite já traz o PostCSS) que aplica scopeSelector a theme.scss. */
export function themeScopePlugin(): PostcssPlugin {
  return {
    postcssPlugin: "app-lanche:theme-scope",
    Once(root: CssRoot) {
      if (!THEME_FILE.test(root.source?.input.file ?? "")) return;
      root.walkRules((rule) => {
        if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name ?? "")) return;
        rule.selectors = rule.selectors.map(scopeSelector);
      });
    },
  } as unknown as PostcssPlugin;
}

/** Seletores de nível superior das regras de estilo (também dentro de @media/@supports/@layer), sem @font-face e @keyframes. */
export function styleSelectors(css: string): string[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let i = 0;
  const skipBlock = () => {
    for (let depth = 1; depth > 0 && i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
    }
  };
  const walk = () => {
    let prelude = "";
    while (i < src.length) {
      const ch = src[i++];
      if (ch === "{") {
        const head = prelude.trim();
        prelude = "";
        if (/^@(media|supports|container|layer)\b/.test(head)) walk();
        else {
          if (!head.startsWith("@")) out.push(...splitSelectors(head));
          skipBlock();
        }
      } else if (ch === "}") return;
      else if (ch === ";") prelude = "";
      else prelude += ch;
    }
  };
  walk();
  return out;
}

/** Divide uma lista de seletores nas vírgulas de fora de parênteses (":is(a, b)" fica inteiro). */
function splitSelectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}
