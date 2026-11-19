# Interface ArchitectUI (admin e tablet da cozinha) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A área admin ganha o layout do ArchitectUI (cabeçalho verde com logo, menu lateral, títulos de página, cartões, tabelas, selos e toasts), o tablet da cozinha ganha uma tela cheia com cartões grandes de toque, selo de sincronização, filtros em pílulas e telas de pareamento no mesmo estilo, e a área dos responsáveis passa a carregar só o CSS base do Bootstrap — sem mudar comportamento, rotas de tela, chamadas à API, chaves de idempotência nem textos de negócio.

**Architecture:** Um subconjunto do SCSS do ArchitectUI React Theme Free v4.9.3 (MIT) é copiado para `apps/web/src/theme/scss/` com recortes mínimos; as cores e a marca ficam só em `apps/web/src/theme/_brand.scss` e `apps/web/src/theme/brand.ts` (paleta e logo da escola piloto). Os componentes de layout do tema são reescritos em TypeScript em `apps/web/src/theme/layout/` (o estado que o tema guardava no Redux `ThemeOptions` vira um contexto React com `localStorage` protegido por try/catch). A área admin inteira vira um único chunk `lazy` (`AdminArea`) que importa o tema; o KDS (já `lazy`) também; a entrada principal importa só `theme/base.scss`. Um plugin de build confere que o CSS carregado por `index.html` não contém o layout do tema. As fontes de ícone e o CSS entram no precache do service worker para o tablet funcionar offline. Para o botão "Sair", a API ganha `POST /api/admin/v1/auth/logout`, que apaga o cookie `__session`.

**Tech Stack:** React 19, react-router 8, Vite 8 + vite-plugin-pwa 2, **bootstrap 5.3** (novo), **reactstrap 9.2** (novo), **pe7-icon 1.0** (novo), **react-toastify 11** (novo), **sass 1.108** (novo, dev), Vitest + jsdom + Testing Library, Playwright (e2e do KDS), Fastify 5 (rota de logout).

**Spec:** `docs/superpowers/specs/2026-11-19-ui-architectui-design.md` (autoritativa para aparência e estrutura de telas); `docs/superpowers/specs/2026-11-16-app-lanche-design.md` continua autoritativa para regras de negócio (seções 7.4 e 10 tocadas de leve).

## Global Constraints

- CLAUDE.md inteiro vale. Em especial as regras 32–36 do KDS: componentes de `areas/kds` leem e escrevem só no IndexedDB (`db.ts`, `useLive`), só o módulo `sync` chama a API; marcar entrega continua sendo `markOrder` (uma transação Dexie); nada de Background Sync.
- Dependências novas, exatamente estas e só em `apps/web`: `bootstrap@^5.3.9`, `reactstrap@^9.2.3`, `pe7-icon@^1.0.4`, `react-toastify@^11.2.0` (dependencies) e `sass@^1.108.2` (devDependency). Nenhuma outra (sem Redux, classnames, perfect-scrollbar, font-awesome, hamburger-react, gráficos). reactstrap 9.2.3 foi conferido com React 19.3 e TypeScript 6.0.3 (`tsc` sem erro com `skipLibCheck`, igual ao `tsconfig.base.json`): não há shim de tipos.
- reactstrap: use só `Alert`, `Button`, `Card`, `CardBody`, `CardHeader`, `Col`, `Form`, `FormGroup`, `Input`, `Label`, `Nav`, `NavItem`, `NavLink`, `Row`, `Table`. Nada de `Modal`, `Dropdown`, `Tooltip`, `Popover`, `Collapse`, `Offcanvas`, `Toast` nem `Badge` (transições sem `nodeRef` usam `findDOMNode`, removido no React 19; e `Badge` gera `bg-*` com texto branco, que falha contraste nas cores claras). `Alert` sempre com `fade={false}`. Selo = `StatusBadge` (Task 2).
- `role="alert"` só para erro (reactstrap `Alert color="danger"` ou o aviso de tablet desconectado). Aviso informativo é `<div className="alert alert-…">` sem `role`. Sucesso = `announce(msg)` (toast visível) + `<StatusNotice message={msg} />` (região `role="status"` só para leitores de tela).
- Contraste WCAG AA em todo par texto/fundo (lista em `_brand.scss`, Task 1). Proibido: texto branco sobre `#94e4b4`, `#acd5bf`, `#dc9d3f` ou `#6eaa89`; `#047c37` como texto sobre `#acd5bf` (3,3:1 — use `#035d29`); `.text-success`, `.text-info`, `.text-warning`, `.btn-outline-success`, `.btn-outline-info`, `.btn-outline-warning`; `.text-muted` e `opacity` em texto.
- Cores só em `apps/web/src/theme/_brand.scss`; nome do produto e logo só em `apps/web/src/theme/brand.ts`. Exceção documentada: `theme_color` literal (`#047c37`) em `apps/web/vite.config.ts` e `apps/web/index.html`, que o Node/HTML não conseguem ler do SCSS.
- A área dos responsáveis (`areas/guardian`, `Home` em `App.tsx`) não muda de estrutura nem de comportamento e nunca importa `theme/styles.ts`, `theme/theme.scss` nem nada de `theme/layout`. Só `src/main.tsx` importa `theme/base.scss`.
- Comportamento, rotas de tela, chamadas à API, corpos, chaves de idempotência e textos de negócio não mudam. Testes existentes continuam provando o mesmo: só se ajusta seletor quando o DOM muda, nunca se afrouxa uma asserção (acrescentar asserção pode).
- Texto de interface em português do Brasil exatamente como o plano dá; código, nomes e commits em inglês.
- Origem do tema (dado de terceiro, MIT; leia e copie, não rode scripts dele nem `npm install` lá): `THEME=/tmp/claude-1000/-home-tgfarias-caminhodosaber-app-lanche/713e9489-0a0d-4e15-bcf5-72857cfa2c39/scratchpad/ext/architectui-react-theme-free`. Se o diretório não existir: `git clone --depth 1 --branch v4.9.3 https://github.com/DashboardPack/architectui-react-theme-free "$THEME"` e confira `git -C "$THEME" rev-parse HEAD` = `4f0892d3b4cbbd97c860da3826de74e93d5aef56`.
- Todo arquivo copiado do tema leva o cabeçalho de origem (comando na Task 1); todo componente adaptado de `src/Layout/*` leva um comentário `Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/<pasta> (MIT, © 2023 DashboardPack); ver apps/web/src/theme/LICENSE-ArchitectUI.txt.`
- O arquivo não rastreado `prompt.txt` na raiz é do usuário: nunca o commite (use caminhos explícitos no `git add`). Nada de `dist/`, `dev-dist/`, `test-results/` nem scripts temporários.
- Mensagens de commit terminam com:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip
  ```
- Comandos focados: web `pnpm --filter @app-lanche/web exec vitest run <caminho relativo a apps/web>`; API `pnpm --filter @app-lanche/api exec vitest run <caminho relativo a apps/api>` (Testcontainers).
- Nesta máquina WSL os testes de API (Testcontainers) só passam com o compose desligado: `pnpm app:down; docker compose down` antes de `pnpm test` ou de um teste de API. O e2e roda com `pnpm db:up && pnpm test:e2e` e depois `docker compose down`.
- Antes de cada commit: `pnpm typecheck && pnpm lint` e os testes do pacote tocado.

## Decisões da fase (o executor não reabre)

1. **Paleta (usuário, 2026-11-19):** `$primary #047c37`, `$warning #dc9d3f` (destaque), `$success #6eaa89`, `$info #94e4b4`, `$brand-tint #acd5bf` (fundo do item ativo e do hover do menu, cartão entregue no KDS), `$danger #dc3545` (padrão do Bootstrap). Cabeçalho verde `#047c37` com texto branco (5,3:1); menu branco. Texto sobre `#acd5bf` usa `$brand-on-tint #035d29` (5,0:1), porque `#047c37` dá só 3,3:1; o ícone do item ativo fica `#047c37` (elemento não textual, mínimo 3:1). `$color-contrast-dark: #212529` e `$min-contrast-ratio: 4.5` fazem o Bootstrap pôr texto escuro em `.btn-success/-warning/-info` e `.text-bg-*` claros (conferido compilando o SCSS).
2. **Logo:** a marca da escola piloto (selo "Centro Educacional Caminho do Saber", CECS) vai embutida no app em `apps/web/src/theme/brand/logo.jpg` (cópia de `/home/tgfarias/caminhodosaber/WhatsApp Image 2025-05-12 at 16.49.40.jpeg`, 1080×1080; o `file.jpg` de menor qualidade não entra). Aparece no cabeçalho do admin (pequeno, num círculo branco), no cartão de login do admin e na tela de pareamento do KDS. Logo por escola é trabalho futuro.
3. **Menu lateral sem rotas novas de tela:** Cardápio, Dias de serviço e Tablets da cozinha continuam seções da página inicial (`AdminHome`), como hoje, e os testes que provam isso seguem iguais. O menu aponta para elas por âncora (`/admin#cardapio`, `/admin#dias`, `/admin#tablets`); o item ativo é calculado por `pathname` + `hash`, e a `AdminHome` rola até a seção pedida. Itens além de "Início" só para `admin` e `secretaria` (mesma regra de hoje na `AdminHome`).
4. **Logout:** não existe rota de saída e o cookie é `HttpOnly`, então a web não consegue sair sozinha. Cria-se `POST /api/admin/v1/auth/logout` (`auth: "public"`, sem `Idempotency-Key` por ser naturalmente idempotente, resposta 204 sem corpo, sem schema em `contracts`) que regrava `__session` vazio com `Max-Age=0` e os mesmos atributos. A sessão é um token assinado sem estado: apagar o cookie encerra o acesso no navegador; o token em si vence em `STAFF_SESSION_TTL`. Falha de rede ao sair: a página fica e mostra o erro.
5. **Admin num chunk só:** `App.tsx` monta `/admin/*` com `lazy(() => import("../areas/admin/AdminArea"))`; `AdminArea` tem as rotas internas (mesmos caminhos de hoje) e importa `theme/styles.ts`. `/admin/<desconhecido>` vai para `/admin` (antes caía na `Home` dos responsáveis).
6. **Avisos:** sucesso vira toast (`react-toastify`, contêiner dentro de `aria-hidden` e sem botão de fechar, para não anunciar duas vezes) e o mesmo texto vai para `StatusNotice` (`role="status"`, classe `visually-hidden`). Erros continuam na página em `Alert` com `role="alert"`. O react-toastify 11 injeta o próprio CSS em tempo de execução: o SCSS de toastify do tema não é copiado.
7. **Ícones:** `pe7-icon/dist/dist/pe-icon-7-stroke.css` (o Vite emite as fontes `woff`, `ttf`, `svg`, `eot`); o pacote não tem `woff2`. O precache passa a incluir `woff`, `woff2`, `ttf`, `svg`, `png` e `jpg`.
8. **Sass:** Bootstrap 5.3 exige `@import`; os avisos de depreciação (`import`, `global-builtin`, `color-functions`, `if-function`) são silenciados numa constante única `SASS_SILENCED` (`apps/web/build/sass.ts`), usada pelo `vite.config.ts` e pelo teste do tema.
9. **Guarda do pacote dos responsáveis:** plugin de build `guardianCssGuard` (em `apps/web/build/guardianCss.ts`) lê `dist/index.html` depois do build e falha se alguma folha que ele carrega contém `.app-sidebar`, `.app-header`, `.metismenu`, `.kds-` ou `pe-7s-`, ou se nenhum CSS do build contém `.app-sidebar`. Roda em todo `vite build` (local, Docker e e2e).
10. **Ícones da PWA:** gerados uma vez do logo com o Chromium do Playwright (devDependency da raiz, sem dependência nova) e commitados em `apps/web/public/icons/icon-192.png` e `icon-512.png`; `theme_color` passa a `#047c37`.
11. **`docs/local.md` não muda:** as capturas de tela da verificação final são feitas por um script temporário no scratchpad; não há instrução nova útil para o dia a dia.

---

## Subconjunto do SCSS do tema

Origem `"$THEME/src/assets/<origem>"` → destino `apps/web/src/theme/scss/<destino>`. Tudo o mais do tema fica de fora (demo-ui, widgets, applications, pages, components/*, utils/*, header/footer extras, search-box, animações, imagens, fontes linearicons, temas de cor alternativos).

| Origem (`src/assets/…`) | Destino (`scss/…`) | Recorte |
|---|---|---|
| `themes/default/_variables.scss` | `_theme-variables.scss` | cores `$brand…$alt` saem (vêm de `_brand.scss`); `$dropdown-link-hover-bg: $brand-tint` |
| `layout/_layout.scss` | `layout/_layout.scss` | sem `generic/animations`, `footer/footer-base`, `elements/search-box/search-box` |
| `layout/_layout-variables.scss` | `layout/_layout-variables.scss` | nenhum |
| `layout/generic/_generic-base.scss` | `layout/generic/_generic-base.scss` | sai `outline: none !important` de `a, button, .btn` (foco visível) |
| `layout/header/_header-base.scss` | `layout/header/_header-base.scss` | sai `.logo-src` (imagem do tema); só importa `modifiers/fixed-header` |
| `layout/header/modifiers/_fixed-header.scss` | `layout/header/modifiers/_fixed-header.scss` | nenhum |
| `layout/sidebar/_sidebar-base.scss` | `layout/sidebar/_sidebar-base.scss` | sem `themes/sidebar-light`, `themes/sidebar-dark` |
| `layout/sidebar/modifiers/_navmenu-vertical.scss` | `layout/sidebar/modifiers/_navmenu-vertical.scss` | nenhum |
| `layout/sidebar/modifiers/_fixed-sidebar.scss` | `layout/sidebar/modifiers/_fixed-sidebar.scss` | nenhum |
| `layout/sidebar/modifiers/_closed-sidebar.scss` | `layout/sidebar/modifiers/_closed-sidebar.scss` | nenhum |
| `layout/main/_main-base.scss` | `layout/main/_main-base.scss` | só importa `themes/main-white` |
| `layout/main/themes/_main-white.scss` | `layout/main/themes/_main-white.scss` | fundos vêm de `_brand.scss` |
| `layout/elements/page-title/_page-title-base.scss` | `layout/elements/page-title/_page-title-base.scss` | nenhum |
| `layout/responsive/_responsive-base.scss` | `layout/responsive/_responsive-base.scss` | nenhum |
| `elements/_buttons.scss` | `elements/_buttons.scss` | gradientes usam `$primary…$alt` em vez da paleta do tema |
| `elements/_badges.scss` | `elements/_badges.scss` | nenhum |
| `elements/_cards.scss` | `elements/_cards.scss` | nenhum |
| `elements/_navs.scss` | `elements/_navs.scss` | nenhum |
| `elements/_forms.scss` | `elements/_forms.scss` | nenhum |

Os componentes React do tema (`src/Layout/{AppHeader,AppSidebar,AppNav,AppMain,AppLogo,AppMobileMenu}`) não são copiados: são reescritos em TypeScript (Tasks 2 e 7). O que sai na conversão: `react-redux`/`ThemeOptions` (vira `LayoutContext`), `classnames`, `TransitionGroup`/`CSSTransition`, `react-perfect-scrollbar`, `hamburger-react` (vira botão com `pe-7s-menu`), `@fortawesome/*` (o menu "⋮" do celular sai; o cabeçalho fica visível em linha), `SearchBox`, `UserBox` com dropdown (vira caixa simples com e-mail, papel e "Sair"), `PageTitle` com ações sorteadas de demonstração, imagem de fundo do menu.

## Mapa de arquivos

```
apps/web/package.json, pnpm-lock.yaml, (pnpm-workspace.yaml só se o pnpm pedir)            (Task 1)
apps/web/build/sass.ts, apps/web/vite.config.ts (css), apps/web/tsconfig.json (include)   (Task 1)
apps/web/src/theme/{_brand.scss,brand.ts,brand/logo.jpg,theme.scss,base.scss,_shell.scss,_kds.scss,styles.ts,LICENSE-ArchitectUI.txt,theme.test.ts}  (Task 1)
apps/web/src/theme/scss/** (19 arquivos copiados)                                           (Task 1)
docs/superpowers/specs/2026-11-19-ui-architectui-design.md ("Cores")                        (Task 1)
apps/web/src/theme/{notify.tsx,StatusBadge.tsx}                                              (Task 2)
apps/web/src/theme/layout/{LayoutContext.tsx,AppHeader.tsx,AppSidebar.tsx,AppShell.tsx,PageTitle.tsx,layout.test.tsx}  (Task 2)
apps/api/src/platform/session.ts, apps/api/src/modules/auth/{routes.ts,staffAuth.test.ts}  (Task 3)
apps/web/src/areas/admin/{AdminArea.tsx,AdminLayout.tsx,adminNav.ts,adminLayout.test.tsx,AdminLogin.tsx,admin.test.tsx}  (Task 3)
apps/web/src/app/{App.tsx,App.test.tsx}, spec UI ("Cabeçalho", "Menu lateral")              (Task 3)
apps/web/src/areas/admin/{AdminHome.tsx,MenuAdmin.tsx,ServiceDaysAdmin.tsx,KitchenDevicesAdmin.tsx} (+ catalogAdmin/admin/kitchenDevices tests)  (Task 4)
apps/web/src/areas/admin/{StudentsAdmin.tsx,DocumentsAdmin.tsx,TemplateEditor.tsx,documentLabels.ts} (+ studentsAdmin/documentsAdmin tests)  (Task 5)
apps/web/src/areas/admin/{GenerateBatch.tsx,BatchPage.tsx} (+ batches test)                 (Task 6)
apps/web/src/theme/layout/KdsShell.tsx, apps/web/src/areas/kds/{SyncBadge.tsx,SyncBadge.test.tsx,filters.ts,filters.test.ts,KdsBoard.tsx,KdsApp.tsx}  (Task 7)
apps/web/src/areas/kds/{KdsPair.tsx,KdsPair.test.tsx,KdsApp.tsx}                              (Task 8)
apps/web/build/{guardianCss.ts,guardianCss.test.ts}, apps/web/{vite.config.ts,index.html,src/main.tsx,public/icons/*}, spec UI ("Offline")  (Task 9)
(verificação, sem arquivo novo)                                                               (Task 10)
```

---

### Task 1: Dependências, marca e SCSS base do tema

**Files:**
- Modify: `apps/web/package.json`, `pnpm-lock.yaml` (e `pnpm-workspace.yaml` só no Step 2, se o pnpm pedir)
- Create: `apps/web/build/sass.ts`
- Modify: `apps/web/vite.config.ts`, `apps/web/tsconfig.json`
- Create: `apps/web/src/theme/_brand.scss`, `apps/web/src/theme/brand.ts`, `apps/web/src/theme/brand/logo.jpg`
- Create: `apps/web/src/theme/theme.scss`, `apps/web/src/theme/base.scss`, `apps/web/src/theme/_shell.scss`, `apps/web/src/theme/_kds.scss`, `apps/web/src/theme/styles.ts`
- Create: `apps/web/src/theme/LICENSE-ArchitectUI.txt`, `apps/web/src/theme/scss/**` (tabela acima)
- Test: `apps/web/src/theme/theme.test.ts`
- Modify: `docs/superpowers/specs/2026-11-19-ui-architectui-design.md` (bullet "Cores")

**Interfaces:**
- Produces: `SASS_SILENCED: DeprecationOrId[]` (`apps/web/build/sass.ts`); `PRODUCT_NAME = "App Lanche"`, `LOGO_URL: string`, `LOGO_ALT = "Logo do Centro Educacional Caminho do Saber"` (`theme/brand.ts`); `theme/styles.ts` (import de efeito: CSS do tema + ícones pe7); `theme/base.scss` (CSS base dos responsáveis); variáveis SCSS `$primary`, `$secondary`, `$success`, `$info`, `$warning`, `$danger`, `$brand-tint`, `$brand-on-tint`, `$brand-header-bg`, `$brand-header-text`, `$brand-sidebar-bg`, `$brand-body-bg`; classes CSS `app-logo`, `app-logo__badge`, `app-header__icon-btn`, `app-header__school`, `app-user-box`, `app-user-box__role`, `app-login`, `app-login__logo`, `skip-link`, `kds-shell`, `kds-topbar`, `kds-topbar__actions`, `kds-sync-badge`, `kds-content`, `kds-filters`, `kds-class-title`, `kds-grid`, `kds-card`, `is-delivered`, `kds-card__name`, `kds-card__class`, `kds-card__state`, `kds-pair`, `kds-pair__logo`, `kds-pair__code`.

- [ ] **Step 1: Instalar as dependências**

Da raiz:

```bash
pnpm --filter @app-lanche/web add bootstrap@^5.3.9 reactstrap@^9.2.3 pe7-icon@^1.0.4 react-toastify@^11.2.0
pnpm --filter @app-lanche/web add -D sass@^1.108.2
```

Aviso de peer do `react-popper` (dependência do reactstrap, declara React ≤ 18) é esperado e não quebra nada: os componentes permitidos não usam popper.

- [ ] **Step 2: Scripts de instalação bloqueados (só se o pnpm reclamar)**

Se o `pnpm add` falhar ou avisar que o script de build de `@parcel/watcher` (dependência opcional do `sass`) não foi aprovado, acrescente-o como não aprovado em `pnpm-workspace.yaml` (o Vite não usa o watcher do Sass, e o pacote traz binário pronto):

```yaml
allowBuilds:
  esbuild: true
  cpu-features: false
  protobufjs: false
  ssh2: false
  "@parcel/watcher": false
```

Rode `pnpm install` de novo. Não aprove nenhum outro script sem perguntar.

- [ ] **Step 3: Teste do tema (falha)**

`apps/web/src/theme/theme.test.ts`:

```ts
// @vitest-environment node
import { fileURLToPath } from "node:url";
import { compile } from "sass";
import { describe, expect, it } from "vitest";
import { SASS_SILENCED } from "../../build/sass";

const options = {
  loadPaths: [fileURLToPath(new URL("../../node_modules", import.meta.url))],
  quietDeps: true,
  silenceDeprecations: SASS_SILENCED,
};
const build = (file: string) => compile(fileURLToPath(new URL(file, import.meta.url)), options).css;
const theme = build("./theme.scss");
const base = build("./base.scss");

/** Corpo da última regra com exatamente esse seletor (o SCSS do App Lanche vem por último). */
function rule(css: string, selector: string): string {
  const start = css.lastIndexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`${selector} not found`);
  return css.slice(start, css.indexOf("}", start));
}

describe("theme stylesheets", () => {
  it("builds the admin and kitchen theme with the ArchitectUI layout", () => {
    for (const selector of [".app-sidebar", ".app-header", ".metismenu-link", ".app-page-title", ".kds-card", ".skip-link"]) {
      expect(theme).toContain(selector);
    }
  });

  it("keeps the theme layout out of the guardian base", () => {
    for (const marker of [".app-sidebar", ".app-header", ".metismenu", ".kds-", "pe-7s-"]) expect(base).not.toContain(marker);
    expect(base).toContain(".btn-primary");
    expect(base).toContain(".form-control");
  });

  it("uses the school palette with AA text colors", () => {
    expect(rule(theme, ".btn-primary")).toContain("--bs-btn-bg: #047c37");
    expect(rule(theme, ".btn-primary")).toContain("--bs-btn-color: #fff");
    for (const selector of [".btn-success", ".btn-warning", ".btn-info"]) expect(rule(theme, selector)).toContain("--bs-btn-color: #212529");
    expect(rule(theme, ".text-bg-success")).toContain("color: #212529");
    expect(rule(theme, ".app-header")).toContain("background: #047c37");
    expect(theme).toMatch(/\.metismenu-link\.active \{\s*color: #035d29;/);
    expect(rule(base, ".btn-primary")).toContain("--bs-btn-bg: #047c37");
  });
});
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/theme/theme.test.ts`
Expected: FAIL (`../../build/sass` e `theme.scss` não existem).

- [ ] **Step 5: Constante do Sass, Vite e tsconfig**

`apps/web/build/sass.ts`:

```ts
import type { DeprecationOrId } from "sass";

/** Bootstrap 5.3 e o ArchitectUI usam @import e funções globais do Sass 1.x: avisos silenciados (ainda aceitos). */
export const SASS_SILENCED: DeprecationOrId[] = ["import", "global-builtin", "color-functions", "if-function"];
```

`apps/web/vite.config.ts` — acrescente o import e a chave `css` (o resto fica igual nesta task):

```ts
/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { SASS_SILENCED } from "./build/sass";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "App Lanche",
        short_name: "Lanche",
        lang: "pt-BR",
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#0f766e",
      },
      workbox: { navigateFallbackDenylist: [/^\/api\//] },
    }),
  ],
  css: { preprocessorOptions: { scss: { quietDeps: true, silenceDeprecations: SASS_SILENCED } } },
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: { environment: "jsdom" },
});
```

`apps/web/tsconfig.json` — `"include": ["src", "build", "vite.config.ts"]`.

- [ ] **Step 6: Marca e logo**

```bash
mkdir -p apps/web/src/theme/brand
cp "/home/tgfarias/caminhodosaber/WhatsApp Image 2025-05-12 at 16.49.40.jpeg" apps/web/src/theme/brand/logo.jpg
```

`apps/web/src/theme/brand.ts`:

```ts
import logoUrl from "./brand/logo.jpg";

/**
 * Marca do App Lanche: com `_brand.scss`, o único lugar de nome e logo. O logo é o da escola piloto (Centro Educacional
 * Caminho do Saber), embutido no app; logo por escola fica para depois.
 */
export const PRODUCT_NAME = "App Lanche";
export const LOGO_URL: string = logoUrl;
export const LOGO_ALT = "Logo do Centro Educacional Caminho do Saber";
```

`apps/web/src/theme/_brand.scss`:

```scss
// Marca do App Lanche: o único lugar com cores. Paleta do logo da escola piloto (Centro Educacional Caminho do Saber).
// Contraste WCAG AA (texto normal >= 4,5:1) conferido para cada par usado:
//   branco sobre $primary 5,3:1 · $brand-on-tint sobre $brand-tint 5,0:1 · #212529 sobre $success 5,7:1,
//   sobre $warning 6,6:1, sobre $info 10,3:1 e sobre $brand-tint 9,6:1 · branco sobre $danger 4,5:1.
// Pares proibidos (falham AA): branco sobre $info (1,5:1), $brand-tint (1,6:1), $warning (2,4:1) ou $success (2,7:1);
//   $primary sobre $brand-tint (3,3:1; use $brand-on-tint); $success, $info ou $warning como cor de texto sobre
//   branco (não use .text-success, .text-info, .text-warning nem .btn-outline-success/info/warning).

$brand-orange: #dc9d3f;
$brand-mint: #94e4b4;
$brand-green-dark: #047c37;
$brand-green-mid: #6eaa89;
$brand-green-pale: #acd5bf;

$primary: $brand-green-dark;
$secondary: #6c757d;
$success: $brand-green-mid;
$info: $brand-mint;
$warning: $brand-orange;
$danger: #dc3545;
$light: #eeeeee;
$dark: #343a40;
$focus: $brand-green-dark;
$alt: $brand-orange;

// Bootstrap escolhe o texto de .btn-* e .text-bg-* com color-contrast(): escuro sobre as cores claras.
$color-contrast-dark: #212529;
$color-contrast-light: #fff;
$min-contrast-ratio: 4.5;

$brand-tint: $brand-green-pale;
$brand-on-tint: #035d29;
$brand-header-bg: $brand-green-dark;
$brand-header-text: #fff;
$brand-sidebar-bg: #fff;
$brand-body-bg: #f1f4f6;
```

- [ ] **Step 7: Copiar o subconjunto do tema com o cabeçalho de origem e a licença**

Da raiz (com `THEME` das Global Constraints):

```bash
DEST=apps/web/src/theme/scss
copy() { # copy <origem relativa a src/assets> <destino relativo a scss/>
  mkdir -p "$(dirname "$DEST/$2")"
  { printf '// Origem: ArchitectUI React Theme Free v4.9.3 (MIT, (c) 2023 DashboardPack), src/assets/%s.\n// Recortado para o App Lanche; ver apps/web/src/theme/LICENSE-ArchitectUI.txt.\n\n' "$1"
    cat "$THEME/src/assets/$1"; } > "$DEST/$2"
}
copy themes/default/_variables.scss _theme-variables.scss
for f in _layout.scss _layout-variables.scss generic/_generic-base.scss header/_header-base.scss \
  header/modifiers/_fixed-header.scss sidebar/_sidebar-base.scss sidebar/modifiers/_navmenu-vertical.scss \
  sidebar/modifiers/_fixed-sidebar.scss sidebar/modifiers/_closed-sidebar.scss main/_main-base.scss \
  main/themes/_main-white.scss elements/page-title/_page-title-base.scss responsive/_responsive-base.scss; do
  copy "layout/$f" "layout/$f"
done
for f in _buttons.scss _badges.scss _cards.scss _navs.scss _forms.scss; do copy "elements/$f" "elements/$f"; done
cp "$THEME/LICENSE" apps/web/src/theme/LICENSE-ArchitectUI.txt
find "$DEST" -name '*.scss' | wc -l   # 19
```

- [ ] **Step 8: Recortes nos arquivos copiados**

Cada item é uma substituição exata (Edit) no arquivo indicado, a partir de `apps/web/src/theme/scss/`.

1. `_theme-variables.scss` — troque o bloco inteiro abaixo por uma linha:

```scss
//--#{$color}
$brand: #545cd8;
$blue: #86c6fb;
$indigo: #444054;
$purple: #83588a;
$pink: #f65ca2;
$red: #d92550;
$orange: #fd7e14;
$yellow: #f7b924;
$green: #3ac47d;
$teal: #16e0bd;
$cyan: #30b1ff;
$blue-light: #eeeeee;

$primary: $brand;
$secondary: $gray-600;
$success: $green;
$info: $cyan;
$warning: $yellow;
$danger: $red;
$light: $blue-light;
$dark: $gray-800;
$focus: $indigo;
$alt: $purple;
```

por

```scss
// App Lanche: as cores ($primary ... $alt) vêm de ../_brand.scss, importado antes deste arquivo.
```

2. `_theme-variables.scss` — `$dropdown-link-hover-bg: #e0f3ff;` → `$dropdown-link-hover-bg: $brand-tint;`
3. `layout/_layout.scss` — apague as linhas `@import 'generic/animations';`, `@import 'footer/footer-base';` e `@import 'elements/search-box/search-box';`.
4. `layout/generic/_generic-base.scss` — apague a regra (e a linha em branco depois dela):

```scss
a,
button,
.btn {
  outline: none !important;
}
```

5. `layout/header/_header-base.scss` — apague o bloco (e a linha em branco depois dele):

```scss
  .logo-src {
    height: $logo-height;
    width: $logo-width;
    background: url('../../../assets/utils/images/logo-inverse.png');
  }
```

6. `layout/header/_header-base.scss` — troque

```scss
@import 'modifiers/fixed-header';
@import 'modifiers/header-dots';
@import 'modifiers/header-megamenu';
@import 'modifiers/header-buttons';
//@import "modifiers/header-horizontal";

// Header Themes

@import 'themes/header-light';
@import 'themes/header-dark';
//@import "themes/header-inverted";
```

por `@import 'modifiers/fixed-header';`

7. `layout/sidebar/_sidebar-base.scss` — troque

```scss
// Sidebar Modifiers

@import 'themes/sidebar-light';
@import 'themes/sidebar-dark';
//@import "themes/sidebar-inverted";

```

por

```scss
// Sidebar Modifiers

```

8. `layout/main/_main-base.scss` — apague as linhas `@import 'themes/main-gray';`, `//@import "themes/main-inverted-blue";` e `//@import "themes/main-inverted-black";`.
9. `layout/main/themes/_main-white.scss` — troque

```scss
$app-container-bg: #f1f4f6;
$app-sidebar-bg: #ffffff;
$app-header-bg: #fafbfc;
```

por

```scss
$app-container-bg: $brand-body-bg;
$app-sidebar-bg: $brand-sidebar-bg;
$app-header-bg: $brand-header-bg;
```

10. `elements/_buttons.scss` — troque

```scss
$gradient-primary: $brand;
$gradient-secondary: $gray-600;
$gradient-success: $green;
$gradient-info: $cyan;
$gradient-warning: $yellow;
$gradient-danger: $red;
$gradient-light: $blue-light;
$gradient-dark: $gray-800;
$gradient-focus: $indigo;
$gradient-alt: $purple;
```

por

```scss
$gradient-primary: $primary;
$gradient-secondary: $secondary;
$gradient-success: $success;
$gradient-info: $info;
$gradient-warning: $warning;
$gradient-danger: $danger;
$gradient-light: $light;
$gradient-dark: $dark;
$gradient-focus: $focus;
$gradient-alt: $alt;
```

- [ ] **Step 9: Folhas do App Lanche**

`apps/web/src/theme/theme.scss`:

```scss
// Tema do admin e do KDS: Bootstrap 5 + o subconjunto do ArchitectUI em ./scss (MIT, ver LICENSE-ArchitectUI.txt).
// Mesma ordem do src/assets/base.scss do tema, só com o que o admin e o KDS usam.
@import 'bootstrap/scss/functions';
@import 'brand';
@import 'scss/theme-variables';
@import 'bootstrap/scss/variables';
@import 'bootstrap/scss/variables-dark';
@import 'bootstrap/scss/maps';
@import 'bootstrap/scss/mixins';
@import 'bootstrap/scss/utilities';
@import 'bootstrap/scss/root';
@import 'bootstrap/scss/reboot';
@import 'bootstrap/scss/type';
@import 'bootstrap/scss/images';
@import 'bootstrap/scss/containers';
@import 'bootstrap/scss/grid';
@import 'bootstrap/scss/tables';
@import 'bootstrap/scss/forms';
@import 'bootstrap/scss/buttons';
@import 'bootstrap/scss/transitions';
@import 'bootstrap/scss/nav';
@import 'bootstrap/scss/card';
@import 'bootstrap/scss/badge';
@import 'bootstrap/scss/alert';
@import 'bootstrap/scss/close';
@import 'bootstrap/scss/spinners';
@import 'bootstrap/scss/helpers';
@import 'bootstrap/scss/utilities/api';
@import 'scss/layout/layout';
@import 'scss/elements/buttons';
@import 'scss/elements/navs';
@import 'scss/elements/badges';
@import 'scss/elements/cards';
@import 'scss/elements/forms';
@import 'scss/layout/responsive/responsive-base';
@import 'shell';
@import 'kds';
```

`apps/web/src/theme/base.scss`:

```scss
// Responsáveis: só o CSS base do Bootstrap com as cores da marca. Nada do layout do tema entra aqui.
@import 'bootstrap/scss/functions';
@import 'brand';
@import 'bootstrap/scss/variables';
@import 'bootstrap/scss/variables-dark';
@import 'bootstrap/scss/maps';
@import 'bootstrap/scss/mixins';
@import 'bootstrap/scss/utilities';
@import 'bootstrap/scss/root';
@import 'bootstrap/scss/reboot';
@import 'bootstrap/scss/type';
@import 'bootstrap/scss/forms';
@import 'bootstrap/scss/buttons';
@import 'bootstrap/scss/helpers';
@import 'bootstrap/scss/utilities/api';
```

`apps/web/src/theme/_shell.scss`:

```scss
// App Lanche sobre o layout do ArchitectUI: cores da marca no cabeçalho e no menu, logo, usuário, login.

body {
  background: $brand-body-bg;
}

.app-header {
  background: $brand-header-bg;
  color: $brand-header-text;

  :focus-visible {
    outline-color: $brand-header-text;
  }
}

.app-theme-white.fixed-header .app-header__logo,
.app-header__logo {
  background: transparent;
}

.app-logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: $brand-header-text;
  font-weight: 600;
  white-space: nowrap;
}

.app-logo__badge {
  display: inline-flex;
  flex: 0 0 40px;
  width: 40px;
  height: 40px;
  padding: 2px;
  border-radius: 50%;
  background: $white;

  img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: contain;
  }
}

.closed-sidebar .app-header__logo .app-logo {
  display: none;
}

.app-header__icon-btn {
  padding: 0.25rem;
  border: 0;
  background: transparent;
  color: $brand-header-text;
  font-size: 1.75rem;
  line-height: 1;
}

.app-header__school {
  font-size: $font-size-lg;
  font-weight: 600;
}

.app-user-box {
  margin-right: 1rem;
  line-height: 1.25;
  text-align: right;

  .app-user-box__role {
    font-size: $font-size-xs;
  }
}

.app-page-title .page-title-subheading {
  color: $gray-700;
  opacity: 1;
}

.vertical-nav-menu .metismenu-container .metismenu-link {
  &:hover,
  &.active {
    color: $brand-on-tint;
  }

  &.active i.metismenu-icon {
    color: $primary;
    opacity: 1;
  }
}

@include media-breakpoint-down(md) {
  .app-header .app-header__content {
    visibility: visible;
    opacity: 1;
    position: static;
    width: auto;
    padding: 0 $layout-spacer-x 0 0;
    overflow: visible;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .app-user-box {
    display: none;
  }
}

.app-login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1rem;
  background: $brand-body-bg;

  .card {
    width: 100%;
    max-width: 420px;
  }
}

.app-login__logo {
  display: block;
  width: 120px;
  height: 120px;
  margin: 0 auto 1rem;
  border-radius: 50%;
}

// Copiado de src/assets/base.scss do ArchitectUI (MIT): link "pular para o conteúdo" e foco visível.
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  z-index: 2000;
  padding: 0.5rem 1rem;
  background: $primary;
  color: $white;
  text-decoration: none;
  border-radius: 0 0 0.25rem 0;
  font-weight: 600;
  transition: top 0.15s ease;

  &:focus,
  &:focus-visible {
    top: 0;
    outline: 2px solid $white;
    outline-offset: -4px;
  }
}

:focus-visible {
  outline: 2px solid $primary;
  outline-offset: 2px;
}
```

`apps/web/src/theme/_kds.scss`:

```scss
// Tablet da cozinha: tela cheia, cartões grandes para toque, retrato e paisagem (768–1280 px).

.kds-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: $brand-body-bg;
}

.kds-topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1rem;
  padding: 0.75rem 1.25rem;
  background: $brand-header-bg;
  color: $brand-header-text;

  h1 {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
  }

  :focus-visible {
    outline-color: $brand-header-text;
  }
}

.kds-topbar__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-left: auto;
}

.kds-sync-badge {
  font-size: 0.95rem;
  text-transform: none;
  padding: 0.5rem 0.85rem;
}

.kds-content {
  flex: 1;
  padding: 1rem 1.25rem 2rem;
}

.kds-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.5rem;
  margin-bottom: 1rem;

  .nav-link {
    min-height: 48px;
    padding: 0.6rem 1.1rem;
    font-size: 1.05rem;
  }
}

.kds-class-title {
  margin: 1.25rem 0 0.75rem;
  font-size: 1.15rem;
  font-weight: 600;
}

.kds-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.kds-card {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  width: 100%;
  min-height: 140px;
  padding: 1rem;
  border: 2px solid $gray-300;
  border-radius: $border-radius-lg;
  background: $white;
  color: $gray-900;
  font-size: 1.05rem;
  text-align: left;
  box-shadow: $box-shadow-default;

  &.is-delivered {
    border-color: $primary;
    background: $brand-tint;
  }

  &:disabled {
    opacity: 0.65;
  }
}

.kds-card__name {
  font-size: 1.25rem;
  font-weight: 700;
}

.kds-card__class {
  color: $gray-700;
  font-size: 0.9rem;
}

.kds-card .badge {
  font-size: 0.95rem;
  text-align: left;
  text-transform: none;
  white-space: normal;
}

.kds-card__state {
  margin-top: auto;
  font-weight: 700;
}

.kds-pair {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1rem;
  background: $brand-body-bg;

  .card {
    width: 100%;
    max-width: 460px;
  }
}

.kds-pair__logo {
  display: block;
  width: 140px;
  height: 140px;
  margin: 0 auto 1rem;
  border-radius: 50%;
}

.kds-pair__code {
  font-size: 1.5rem;
  letter-spacing: 0.2em;
  text-align: center;
  text-transform: uppercase;
}
```

(O `opacity` de `.kds-card:disabled` vale só para botão desabilitado, que o WCAG isenta de contraste.)

`apps/web/src/theme/styles.ts`:

```ts
// Folhas do tema do admin e do KDS. Só módulos carregados sob demanda (AdminArea, KdsApp) importam este arquivo:
// a área dos responsáveis carrega apenas base.scss (spec 2026-11-19, "Carregamento").
import "pe7-icon/dist/dist/pe-icon-7-stroke.css";
import "./theme.scss";
```

- [ ] **Step 10: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/theme/theme.test.ts`
Expected: PASS (3 testes). Se o Sass acusar variável indefinida, o recorte do Step 8 ficou diferente do texto dado: confira o arquivo apontado.

- [ ] **Step 11: Spec — cores e logo recebidos**

Em `docs/superpowers/specs/2026-11-19-ui-architectui-design.md`, troque o bullet que começa com `- Cores: o usuário vai mandar a paleta e o logo.` (linha inteira) por:

```markdown
- Cores e logo (recebidos em 2026-11-19): paleta do logo do Centro Educacional Caminho do Saber — laranja `#dc9d3f`, menta `#94e4b4`, verde-escuro `#047c37`, verde-médio `#6eaa89`, verde-claro `#acd5bf`. Em `apps/web/src/theme/_brand.scss`: primária `#047c37`, alerta/destaque `#dc9d3f`, sucesso `#6eaa89`, informação `#94e4b4` (texto escuro), `#acd5bf` para fundos claros (item ativo e hover do menu, com texto `#035d29`, porque `#047c37` sobre ele dá só 3,3:1); perigo continua o padrão do Bootstrap. Cabeçalho verde-escuro com texto branco; menu claro. Todo par texto/fundo atende WCAG AA, e o arquivo lista os pares proibidos (por exemplo, branco sobre `#94e4b4` ou `#acd5bf`). Logo em `apps/web/src/theme/brand/logo.jpg` e nome do produto em `apps/web/src/theme/brand.ts`, mostrado no cabeçalho do admin (num círculo branco), no login do admin e no pareamento do KDS. É a marca da escola piloto embutida no app; logo por escola fica para depois.
```

- [ ] **Step 12: Verificar e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test`
Expected: tudo passa (nenhum componente usa o tema ainda). Os tipos de `node:url`/`node:fs` chegam pelo `/// <reference types="node" />` dos tipos do Vite, como já acontece com `vite.config.ts`; não acrescente `"node"` a `types` no `tsconfig.json` da web.

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/build/sass.ts apps/web/vite.config.ts apps/web/tsconfig.json \
  apps/web/src/theme docs/superpowers/specs/2026-11-19-ui-architectui-design.md
git add pnpm-workspace.yaml   # só se o Step 2 mudou o arquivo
git commit -m "feat(web): add the ArchitectUI theme subset and the school brand

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 2: Layout do tema em TypeScript (shell, cabeçalho, menu, título, avisos, selo)

**Files:**
- Create: `apps/web/src/theme/notify.tsx`, `apps/web/src/theme/StatusBadge.tsx`
- Create: `apps/web/src/theme/layout/LayoutContext.tsx`, `apps/web/src/theme/layout/AppHeader.tsx`, `apps/web/src/theme/layout/AppSidebar.tsx`, `apps/web/src/theme/layout/AppShell.tsx`, `apps/web/src/theme/layout/PageTitle.tsx`
- Test: `apps/web/src/theme/layout/layout.test.tsx`

**Interfaces:**
- Consumes: `PRODUCT_NAME`, `LOGO_URL` (Task 1); classes CSS da Task 1.
- Produces:
  - `announce(message: string): void` e `StatusNotice({ message }: { message: string | null })` (`theme/notify.tsx`).
  - `type Tone = "primary" | "secondary" | "success" | "info" | "warning" | "danger" | "light"`; `StatusBadge({ tone, children }: { tone: Tone; children: ReactNode })` (`theme/StatusBadge.tsx`).
  - `LayoutProvider`, `useLayout(): LayoutState` com `{ collapsed, mobileOpen, toggleCollapsed(), toggleMobile(), closeMobile() }`; chave de armazenamento `"app-lanche:sidebar-collapsed"`.
  - `type NavItem = { to: string; label: string; icon: string; isActive: (location: { pathname: string; hash: string }) => boolean }`; `AppSidebar({ items })` (nav com `aria-label="Menu principal"`, `id="app-sidebar"`).
  - `type HeaderUser = { email: string; roleLabel: string }`; `AppHeader({ schoolName?, user?, onLogout })` com botões "Recolher menu"/"Expandir menu", "Abrir menu"/"Fechar menu" e "Sair".
  - `AppShell({ nav, schoolName?, user?, onLogout, children })` (contêiner `.app-container`, `<main id="conteudo">`, `ToastContainer`).
  - `PageTitle({ heading, subheading?, icon?, actions? })` (título em `<h1>`).

- [ ] **Step 1: Testes do layout (falham)**

`apps/web/src/theme/layout/layout.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { announce, StatusNotice } from "../notify";
import { AppShell } from "./AppShell";
import type { NavItem } from "./AppSidebar";
import { PageTitle } from "./PageTitle";

const NAV: NavItem[] = [
  { to: "/admin", label: "Início", icon: "pe-7s-home", isActive: (l) => l.pathname === "/admin" && l.hash === "" },
  { to: "/admin/alunos", label: "Alunos e responsáveis", icon: "pe-7s-users", isActive: (l) => l.pathname.startsWith("/admin/alunos") },
  { to: "/admin#cardapio", label: "Cardápio", icon: "pe-7s-note2", isActive: (l) => l.pathname === "/admin" && l.hash === "#cardapio" },
];

function Saver() {
  const [message, setMessage] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setMessage("Dados salvos.");
          announce("Dados salvos.");
        }}
      >
        Salvar
      </button>
      <StatusNotice message={message} />
    </>
  );
}

function renderShell(path: string, onLogout = vi.fn()) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="*"
          element={
            <AppShell nav={NAV} schoolName="Escola Sol" user={{ email: "ana@escola.test", roleLabel: "Secretaria" }} onLogout={onLogout}>
              <PageTitle heading="Página de teste" subheading="Subtítulo" />
              <Saver />
            </AppShell>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return onLogout;
}

const shell = () => document.querySelector(".app-container")!;
const link = (name: string) => screen.getByRole("link", { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("AppShell", () => {
  it("highlights the current page", () => {
    renderShell("/admin/alunos/qualquer");
    expect(link("Alunos e responsáveis").getAttribute("aria-current")).toBe("page");
    expect(link("Alunos e responsáveis").className).toContain("active");
    expect(link("Início").getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Página de teste" })).toBeTruthy();
  });

  it("highlights a home section by its anchor and follows navigation", () => {
    renderShell("/admin#cardapio");
    expect(link("Cardápio").getAttribute("aria-current")).toBe("page");
    expect(link("Início").getAttribute("aria-current")).toBeNull();
    fireEvent.click(link("Início"));
    expect(link("Início").getAttribute("aria-current")).toBe("page");
    expect(link("Cardápio").getAttribute("aria-current")).toBeNull();
  });

  it("opens the mobile menu and closes it with Escape or after navigating", () => {
    renderShell("/admin");
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    expect(shell().classList.contains("sidebar-mobile-open")).toBe(true);
    expect(screen.getByRole("button", { name: "Fechar menu" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(shell().classList.contains("sidebar-mobile-open")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    fireEvent.click(link("Alunos e responsáveis"));
    expect(shell().classList.contains("sidebar-mobile-open")).toBe(false);
    expect(screen.getByRole("button", { name: "Abrir menu" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses the sidebar and remembers it", () => {
    renderShell("/admin");
    fireEvent.click(screen.getByRole("button", { name: "Recolher menu" }));
    expect(shell().classList.contains("closed-sidebar")).toBe(true);
    expect(localStorage.getItem("app-lanche:sidebar-collapsed")).toBe("1");
    cleanup();
    renderShell("/admin");
    expect(shell().classList.contains("closed-sidebar")).toBe(true);
    expect(screen.getByRole("button", { name: "Expandir menu" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps working when the browser blocks storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    renderShell("/admin");
    expect(shell().classList.contains("closed-sidebar")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Recolher menu" }));
    expect(shell().classList.contains("closed-sidebar")).toBe(true);
  });

  it("shows the school and the user, and logs out", () => {
    const onLogout = renderShell("/admin");
    expect(screen.getByText("Escola Sol")).toBeTruthy();
    expect(screen.getByText("ana@escola.test")).toBeTruthy();
    expect(screen.getByText("Secretaria")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("shows success as a toast and announces it once, with role=status", async () => {
    renderShell("/admin");
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(document.querySelector(".Toastify")?.textContent).toContain("Dados salvos."));
    expect(screen.getByRole("status").textContent).toBe("Dados salvos.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/theme/layout/layout.test.tsx`
Expected: FAIL (módulos não existem).

- [ ] **Step 3: Avisos e selo**

`apps/web/src/theme/notify.tsx`:

```tsx
import { toast } from "react-toastify";

/** Aviso de sucesso visível (toast). O mesmo texto vai num <StatusNotice> da página, para leitores de tela. */
export function announce(message: string): void {
  toast.success(message, { toastId: message });
}

/** Região role="status" sempre presente; o texto fica só para leitores de tela (o toast é a parte visível). */
export function StatusNotice({ message }: { message: string | null }) {
  return (
    <p role="status" className="visually-hidden">
      {message ?? ""}
    </p>
  );
}
```

`apps/web/src/theme/StatusBadge.tsx`:

```tsx
import type { ReactNode } from "react";

export type Tone = "primary" | "secondary" | "success" | "info" | "warning" | "danger" | "light";

/** Selo de situação. Usa .text-bg-*: o Bootstrap escolhe texto claro ou escuro com contraste AA (ver _brand.scss). */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge rounded-pill text-bg-${tone}`}>{children}</span>;
}
```

- [ ] **Step 4: Contexto do layout**

`apps/web/src/theme/layout/LayoutContext.tsx`:

```tsx
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

const COLLAPSED_KEY = "app-lanche:sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Sem armazenamento (aba privada, bloqueio do navegador): o menu só não lembra a escolha.
  }
}

export type LayoutState = {
  collapsed: boolean;
  mobileOpen: boolean;
  toggleCollapsed: () => void;
  toggleMobile: () => void;
  closeMobile: () => void;
};

const LayoutContext = createContext<LayoutState | null>(null);

/** Estado do layout, no lugar do Redux ThemeOptions do ArchitectUI: menu recolhido (lembrado) e gaveta do celular. */
export function LayoutProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    writeCollapsed(next);
    setCollapsed(next);
  }, [collapsed]);
  const toggleMobile = useCallback(() => setMobileOpen((open) => !open), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const value = useMemo(
    () => ({ collapsed, mobileOpen, toggleCollapsed, toggleMobile, closeMobile }),
    [collapsed, mobileOpen, toggleCollapsed, toggleMobile, closeMobile],
  );
  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutState {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error("useLayout must be used inside LayoutProvider");
  return ctx;
}
```

- [ ] **Step 5: Menu lateral, cabeçalho e título**

`apps/web/src/theme/layout/AppSidebar.tsx`:

```tsx
// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppSidebar e src/Layout/AppNav (MIT, © 2023 DashboardPack);
// ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import { Link, useLocation } from "react-router";
import { useLayout } from "./LayoutContext";

export type NavItem = {
  to: string;
  label: string;
  /** Classe do ícone pe7, por exemplo "pe-7s-home". */
  icon: string;
  isActive: (location: { pathname: string; hash: string }) => boolean;
};

export function AppSidebar({ items }: { items: NavItem[] }) {
  const location = useLocation();
  const { closeMobile } = useLayout();
  return (
    <>
      <div className="sidebar-mobile-overlay" aria-hidden="true" onClick={closeMobile} />
      <nav className="app-sidebar sidebar-shadow" id="app-sidebar" aria-label="Menu principal">
        <div className="app-sidebar__inner">
          <div className="vertical-nav-menu">
            <ul className="metismenu-container">
              {items.map((item) => {
                const active = item.isActive(location);
                return (
                  <li key={item.to} className="metismenu-item">
                    <Link
                      to={item.to}
                      className={active ? "metismenu-link active" : "metismenu-link"}
                      aria-current={active ? "page" : undefined}
                    >
                      <i className={`metismenu-icon ${item.icon}`} aria-hidden="true" />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </nav>
    </>
  );
}
```

`apps/web/src/theme/layout/AppHeader.tsx`:

```tsx
// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppHeader, src/Layout/AppLogo e src/Layout/AppMobileMenu
// (MIT, © 2023 DashboardPack); ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import { Button } from "reactstrap";
import { LOGO_URL, PRODUCT_NAME } from "../brand";
import { useLayout } from "./LayoutContext";

export type HeaderUser = { email: string; roleLabel: string };

export function AppHeader({ schoolName, user, onLogout }: { schoolName?: string; user?: HeaderUser; onLogout: () => void }) {
  const { collapsed, mobileOpen, toggleCollapsed, toggleMobile } = useLayout();
  return (
    <header className="app-header header-shadow">
      <div className="app-header__logo">
        <span className="app-logo">
          <span className="app-logo__badge">
            <img src={LOGO_URL} alt="" />
          </span>
          {PRODUCT_NAME}
        </span>
        <div className="header__pane ms-auto">
          <button
            type="button"
            className="app-header__icon-btn"
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            aria-pressed={collapsed}
            onClick={toggleCollapsed}
          >
            <i className="pe-7s-menu" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="app-header__mobile-menu">
        <button
          type="button"
          className="app-header__icon-btn"
          aria-label={mobileOpen ? "Fechar menu" : "Abrir menu"}
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          onClick={toggleMobile}
        >
          <i className="pe-7s-menu" aria-hidden="true" />
        </button>
      </div>
      <div className="app-header__content">
        <div className="app-header-left">
          {schoolName && <span className="app-header__school text-truncate">{schoolName}</span>}
        </div>
        <div className="app-header-right">
          {user && (
            <div className="app-user-box">
              <div>{user.email}</div>
              <div className="app-user-box__role">{user.roleLabel}</div>
            </div>
          )}
          <Button color="light" size="sm" type="button" onClick={onLogout}>
            Sair
          </Button>
        </div>
      </div>
    </header>
  );
}
```

`apps/web/src/theme/layout/PageTitle.tsx`:

```tsx
// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppMain/PageTitle (MIT, © 2023 DashboardPack), sem as
// ações de demonstração; ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import type { ReactNode } from "react";

export function PageTitle({
  heading,
  subheading,
  icon,
  actions,
}: {
  heading: ReactNode;
  subheading?: ReactNode;
  icon?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="app-page-title">
      <div className="page-title-wrapper">
        <div className="page-title-heading">
          {icon && (
            <div className="page-title-icon">
              <i className={`${icon} text-primary`} aria-hidden="true" />
            </div>
          )}
          <div>
            <h1 className="h5 mb-0">{heading}</h1>
            {subheading && <div className="page-title-subheading">{subheading}</div>}
          </div>
        </div>
        {actions && <div className="page-title-actions">{actions}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Shell**

`apps/web/src/theme/layout/AppShell.tsx`:

```tsx
// Adaptado de ArchitectUI React Theme Free v4.9.3, src/Layout/AppMain e src/DemoPages/Main (MIT, © 2023 DashboardPack);
// ver apps/web/src/theme/LICENSE-ArchitectUI.txt.
import { useEffect, type ReactNode } from "react";
import { useLocation } from "react-router";
import { ToastContainer } from "react-toastify";
import { AppHeader, type HeaderUser } from "./AppHeader";
import { AppSidebar, type NavItem } from "./AppSidebar";
import { LayoutProvider, useLayout } from "./LayoutContext";

type Props = { nav: NavItem[]; schoolName?: string; user?: HeaderUser; onLogout: () => void; children: ReactNode };

function Shell({ nav, schoolName, user, onLogout, children }: Props) {
  const { collapsed, mobileOpen, closeMobile } = useLayout();
  const location = useLocation();

  // Navegar fecha a gaveta do celular.
  useEffect(() => {
    closeMobile();
  }, [location.pathname, location.hash, closeMobile]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMobile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, closeMobile]);

  const classes = ["app-container", "app-theme-white", "fixed-header", "fixed-sidebar"];
  if (collapsed) classes.push("closed-sidebar");
  if (mobileOpen) classes.push("sidebar-mobile-open");

  return (
    <div className={classes.join(" ")}>
      <a
        className="skip-link"
        href="#conteudo"
        onClick={(event) => {
          // Sem mexer no hash: o hash da URL escolhe a seção da página inicial.
          event.preventDefault();
          document.getElementById("conteudo")?.focus();
        }}
      >
        Pular para o conteúdo
      </a>
      <AppHeader schoolName={schoolName} user={user} onLogout={onLogout} />
      <div className="app-main">
        <AppSidebar items={nav} />
        <div className="app-main__outer">
          <main className="app-main__inner" id="conteudo" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
      {/* O texto do toast já é anunciado pelo StatusNotice da página: o contêiner fica fora da árvore acessível. */}
      <div aria-hidden="true">
        <ToastContainer position="top-right" autoClose={4000} hideProgressBar closeButton={false} newestOnTop />
      </div>
    </div>
  );
}

/** Moldura do admin: cabeçalho, menu lateral, área principal e toasts. */
export function AppShell(props: Props) {
  return (
    <LayoutProvider>
      <Shell {...props} />
    </LayoutProvider>
  );
}
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/theme/layout/layout.test.tsx`
Expected: PASS (7 testes).

- [ ] **Step 8: Verificar e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test`

```bash
git add apps/web/src/theme/notify.tsx apps/web/src/theme/StatusBadge.tsx apps/web/src/theme/layout
git commit -m "feat(web): port the ArchitectUI layout shell to TypeScript

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 3: Logout, área admin `lazy`, moldura do admin e login

**Files:**
- Modify: `apps/api/src/platform/session.ts`, `apps/api/src/modules/auth/routes.ts`
- Test: `apps/api/src/modules/auth/staffAuth.test.ts`
- Create: `apps/web/src/areas/admin/adminNav.ts`, `apps/web/src/areas/admin/AdminLayout.tsx`, `apps/web/src/areas/admin/AdminArea.tsx`
- Modify: `apps/web/src/areas/admin/AdminLogin.tsx`, `apps/web/src/app/App.tsx`
- Test: `apps/web/src/areas/admin/adminLayout.test.tsx`, `apps/web/src/areas/admin/admin.test.tsx`, `apps/web/src/app/App.test.tsx`
- Modify: `docs/superpowers/specs/2026-11-19-ui-architectui-design.md` (bullets "Menu lateral" e "Cabeçalho")

**Interfaces:**
- Consumes: `AppShell`, `NavItem` (Task 2); `PRODUCT_NAME`, `LOGO_URL`, `LOGO_ALT`, `theme/styles.ts` (Task 1).
- Produces:
  - API: `clearSession(reply: FastifyReply): void` (`platform/session.ts`); rota `POST /api/admin/v1/auth/logout` → 204, `__session` vazio com `Max-Age=0`.
  - Web: `ROLE_LABELS: Record<StaffRole, string>` (`admin` → "Administração", `secretaria` → "Secretaria", `cozinha` → "Cozinha") e `adminNav(role: StaffRole | undefined): NavItem[]` (`areas/admin/adminNav.ts`); `AdminLayout` (rota-moldura com `<Outlet />`); `default export AdminArea` (rotas relativas a `/admin/*`); `App.tsx` monta `/admin/*` com `lazy`.

- [ ] **Step 1: Teste da API (falha)**

Em `apps/api/src/modules/auth/staffAuth.test.ts`, dentro do `describe("staff authentication", …)`, acrescente:

```ts
  it("logs out by expiring the session cookie, with or without a session", async () => {
    for (const cookies of [{ [SESSION_COOKIE]: "stale-token" }, {}]) {
      const res = await buildApp().inject({ method: "POST", url: "/api/admin/v1/auth/logout", cookies });
      expect(res.statusCode).toBe(204);
      const cleared = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
      expect(cleared.value).toBe("");
      expect(cleared.maxAge).toBe(0);
      expect(cleared.httpOnly).toBe(true);
      expect(cleared.secure).toBe(true);
      expect(cleared.path).toBe("/");
    }
  });
```

Run (compose desligado): `pnpm --filter @app-lanche/api exec vitest run src/modules/auth/staffAuth.test.ts`
Expected: FAIL (404).

- [ ] **Step 2: Rota de logout**

`apps/api/src/platform/session.ts` — logo depois de `issueSession`:

```ts
/**
 * Apaga o cookie de sessão com os mesmos atributos de issueSession. O token é sem estado no servidor: encerrar é tirar
 * o cookie do navegador; uma cópia do token vale até vencer.
 */
export function clearSession(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
}
```

`apps/api/src/modules/auth/routes.ts` — import `import { clearSession, GUARDIAN_SESSION_TTL, issueSession, STAFF_SESSION_TTL } from "../../platform/session";` e, depois da rota `POST /api/admin/v1/auth/otp/verify`:

```ts
  // "Sair" da área da escola. Pública (vale com sessão vencida) e naturalmente idempotente: sem Idempotency-Key.
  app.post("/api/admin/v1/auth/logout", { config: { auth: "public" } }, async (_req, reply) => {
    clearSession(reply);
    return reply.code(204).send();
  });
```

Run: `pnpm --filter @app-lanche/api exec vitest run src/modules/auth/staffAuth.test.ts`
Expected: PASS.

- [ ] **Step 3: Testes da moldura do admin (falham)**

`apps/web/src/areas/admin/adminLayout.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminLayout } from "./AdminLayout";

type Reply = { status: number; body?: unknown };

/** Respostas por "MÉTODO url"; pedido sem resposta cai como falha de rede. */
function mockApi(replies: Record<string, Reply>) {
  const fn = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const reply = replies[key];
    if (!reply) throw new TypeError(`offline: ${key}`);
    return reply.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const me = (role: string): Reply => ({
  status: 200,
  body: { id: "0193a000-0000-7000-8000-000000000001", email: "ana@escola.test", role, schoolName: "Escola Sol" },
});

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/login" element={<p>tela de login</p>} />
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<p>página inicial</p>} />
          <Route path="alunos" element={<p>página de alunos</p>} />
          <Route path="documentos/*" element={<p>página de documentos</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const menu = () => within(screen.getByRole("navigation", { name: "Menu principal" }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("admin layout", () => {
  it("shows the school, the user and the whole menu to the office, highlighting the current page", async () => {
    mockApi({ "GET /api/admin/v1/me": me("secretaria") });
    renderAt("/admin/documentos/lotes/0193a000-0000-7000-8000-000000000009");
    await screen.findByText("Escola Sol");
    expect(screen.getByText("ana@escola.test")).toBeTruthy();
    expect(screen.getByText("Secretaria")).toBeTruthy();
    expect(menu().getAllByRole("link").map((a) => a.textContent)).toEqual([
      "Início",
      "Alunos e responsáveis",
      "Cardápio",
      "Dias de serviço",
      "Documentos",
      "Tablets da cozinha",
    ]);
    expect(menu().getByRole("link", { name: "Documentos" }).getAttribute("aria-current")).toBe("page");
    expect(menu().getByRole("link", { name: "Início" }).getAttribute("aria-current")).toBeNull();
    expect(menu().getByRole("link", { name: "Cardápio" }).getAttribute("href")).toBe("/admin#cardapio");
    expect(menu().getByRole("link", { name: "Dias de serviço" }).getAttribute("href")).toBe("/admin#dias");
    expect(menu().getByRole("link", { name: "Tablets da cozinha" }).getAttribute("href")).toBe("/admin#tablets");
    expect(screen.getByText("página de documentos")).toBeTruthy();
  });

  it("shows only the home page to the kitchen", async () => {
    mockApi({ "GET /api/admin/v1/me": me("cozinha") });
    renderAt("/admin");
    await screen.findByText("Cozinha");
    expect(menu().getAllByRole("link").map((a) => a.textContent)).toEqual(["Início"]);
  });

  it("sends visitors without a session to the login", async () => {
    mockApi({ "GET /api/admin/v1/me": { status: 401, body: { error: { code: "unauthenticated", message: "x" } } } });
    renderAt("/admin/alunos");
    await screen.findByText("tela de login");
  });

  it("logs out and returns to the login", async () => {
    const fn = mockApi({ "GET /api/admin/v1/me": me("admin"), "POST /api/admin/v1/auth/logout": { status: 204 } });
    renderAt("/admin");
    await screen.findByText("Administração");
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    await screen.findByText("tela de login");
    expect(fn.mock.calls.some((c) => c[0] === "/api/admin/v1/auth/logout" && c[1]?.method === "POST")).toBe(true);
  });

  it("stays and explains when the logout cannot reach the server", async () => {
    mockApi({ "GET /api/admin/v1/me": me("admin") });
    renderAt("/admin");
    await screen.findByText("Administração");
    fireEvent.click(screen.getByRole("button", { name: "Sair" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sem conexão. Verifique a internet e tente de novo.");
    expect(screen.getByText("página inicial")).toBeTruthy();
  });
});
```

Em `apps/web/src/areas/admin/admin.test.tsx`, acrescente o import `import { LOGO_ALT } from "../../theme/brand";` e, dentro do `describe("admin area", …)`:

```tsx
  it("shows the school logo on the login card", () => {
    renderAt("/admin/login");
    expect(screen.getByRole("img", { name: LOGO_ALT })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Área da escola" })).toBeTruthy();
  });
```

Em `apps/web/src/app/App.test.tsx`, depois do `describe("Home", …)`:

```tsx
describe("admin area", () => {
  afterEach(cleanup);

  it("loads the admin area on demand at the same addresses", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/login"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByLabelText("E-mail")).toBeTruthy();
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/adminLayout.test.tsx src/areas/admin/admin.test.tsx src/app/App.test.tsx`
Expected: FAIL (`AdminLayout` não existe; login sem logo).

- [ ] **Step 4: Menu do admin**

`apps/web/src/areas/admin/adminNav.ts`:

```ts
import type { StaffRole } from "@app-lanche/contracts";
import type { NavItem } from "../../theme/layout/AppSidebar";

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: "Administração",
  secretaria: "Secretaria",
  cozinha: "Cozinha",
};

type Where = { pathname: string; hash: string };
const home = (hash: string) => (l: Where) => l.pathname === "/admin" && l.hash === hash;
const under = (prefix: string) => (l: Where) => l.pathname === prefix || l.pathname.startsWith(`${prefix}/`);

/**
 * Menu lateral do admin. Cardápio, dias de serviço e tablets continuam seções da página inicial (âncoras), como antes
 * do tema. Fora "Início", só para quem administra o cadastro (mesma regra da AdminHome).
 */
export function adminNav(role: StaffRole | undefined): NavItem[] {
  const items: NavItem[] = [{ to: "/admin", label: "Início", icon: "pe-7s-home", isActive: home("") }];
  if (role !== "admin" && role !== "secretaria") return items;
  return [
    ...items,
    { to: "/admin/alunos", label: "Alunos e responsáveis", icon: "pe-7s-users", isActive: under("/admin/alunos") },
    { to: "/admin#cardapio", label: "Cardápio", icon: "pe-7s-note2", isActive: home("#cardapio") },
    { to: "/admin#dias", label: "Dias de serviço", icon: "pe-7s-date", isActive: home("#dias") },
    { to: "/admin/documentos", label: "Documentos", icon: "pe-7s-news-paper", isActive: under("/admin/documentos") },
    { to: "/admin#tablets", label: "Tablets da cozinha", icon: "pe-7s-display2", isActive: home("#tablets") },
  ];
}
```

(`StaffRole` já é exportado por `@app-lanche/contracts` em `auth.ts`.)

- [ ] **Step 5: Moldura e área admin**

`apps/web/src/areas/admin/AdminLayout.tsx`:

```tsx
import { StaffMeResponse } from "@app-lanche/contracts";
import { useEffect, useState } from "react";
import { Outlet, useNavigate } from "react-router";
import { Alert } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { AppShell } from "../../theme/layout/AppShell";
import { staffErrorMessage } from "../../ui/messages";
import { adminNav, ROLE_LABELS } from "./adminNav";

/** Moldura das páginas do admin: cabeçalho com escola e usuário, menu lateral e "Sair". */
export function AdminLayout() {
  const navigate = useNavigate();
  const [me, setMe] = useState<StaffMeResponse | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/admin/v1/me", StaffMeResponse).then(setMe, (err: unknown) => {
      // Sem sessão: mesmo destino da página inicial. Outros erros ficam com as páginas, que mostram os seus.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) navigate("/admin/login", { replace: true });
    });
  }, [navigate]);

  async function logout() {
    setLogoutError(null);
    try {
      await apiFetch("/api/admin/v1/auth/logout", z.undefined(), { method: "POST" });
      navigate("/admin/login", { replace: true });
    } catch (err) {
      setLogoutError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    }
  }

  return (
    <AppShell
      nav={adminNav(me?.role)}
      schoolName={me?.schoolName}
      user={me ? { email: me.email, roleLabel: ROLE_LABELS[me.role] } : undefined}
      onLogout={() => void logout()}
    >
      {logoutError && (
        <Alert color="danger" fade={false}>
          {logoutError}
        </Alert>
      )}
      <Outlet />
    </AppShell>
  );
}
```

`apps/web/src/areas/admin/AdminArea.tsx`:

```tsx
import { Navigate, Route, Routes } from "react-router";
import "../../theme/styles";
import { AdminHome } from "./AdminHome";
import { AdminLayout } from "./AdminLayout";
import { AdminLogin } from "./AdminLogin";
import { BatchPage } from "./BatchPage";
import { DocumentsAdmin } from "./DocumentsAdmin";
import { GenerateBatch } from "./GenerateBatch";
import { StudentsAdmin } from "./StudentsAdmin";
import { TemplateEditor } from "./TemplateEditor";

/** Área admin inteira num chunk carregado sob demanda: o tema (CSS e layout) fica fora do pacote dos responsáveis. */
export default function AdminArea() {
  return (
    <Routes>
      <Route path="login" element={<AdminLogin />} />
      <Route element={<AdminLayout />}>
        <Route index element={<AdminHome />} />
        <Route path="alunos" element={<StudentsAdmin />} />
        <Route path="documentos" element={<DocumentsAdmin />} />
        <Route path="documentos/modelos/novo" element={<TemplateEditor />} />
        <Route path="documentos/modelos/:id" element={<TemplateEditor />} />
        <Route path="documentos/gerar/:templateId" element={<GenerateBatch />} />
        <Route path="documentos/lotes/:id" element={<BatchPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
```

`apps/web/src/app/App.tsx`:

```tsx
import { lazy, Suspense, useEffect } from "react";
import { Link, Route, Routes, useNavigate } from "react-router";
import { LinkLanding } from "../areas/guardian/LinkLanding";
import { CheckoutPage } from "../areas/guardian/CheckoutPage";
import { DocumentsPage } from "../areas/guardian/DocumentsPage";
import { OrderHome } from "../areas/guardian/OrderHome";
import { WalletPage } from "../areas/guardian/WalletPage";

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

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/l" element={<LinkLanding />} />
      <Route path="/pedido" element={<OrderHome />} />
      <Route path="/pedido/checkout/:id" element={<CheckoutPage />} />
      <Route path="/carteira" element={<WalletPage />} />
      <Route path="/documentos" element={<DocumentsPage />} />
      <Route path="/admin/*" element={<Suspense fallback={null}><AdminArea /></Suspense>} />
      <Route path="/kds" element={<Suspense fallback={null}><KdsApp /></Suspense>} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
```

- [ ] **Step 6: Login no estilo do tema**

`apps/web/src/areas/admin/AdminLogin.tsx` (lógica, chamadas e textos iguais; só a marcação muda):

```tsx
import { StaffOtpRequestResponse, StaffOtpVerifyResponse } from "@app-lanche/contracts";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Alert, Button, Card, CardBody, Form, FormGroup, Input, Label } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { LOGO_ALT, LOGO_URL, PRODUCT_NAME } from "../../theme/brand";
import { staffErrorMessage } from "../../ui/messages";

export function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [otpToken, setOtpToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  function requestCode(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const res = await apiFetch("/api/admin/v1/auth/otp/request", StaffOtpRequestResponse, {
        method: "POST",
        body: { email: email.trim() },
      });
      setOtpToken(res.otpToken);
    });
  }

  function verify(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await apiFetch("/api/admin/v1/auth/otp/verify", StaffOtpVerifyResponse, {
        method: "POST",
        body: { otpToken, code: code.trim() },
      });
      navigate("/admin", { replace: true });
    });
  }

  const errorAlert = error && (
    <Alert color="danger" fade={false}>
      {error}
    </Alert>
  );

  return (
    <main className="app-login">
      <Card className="main-card">
        <CardBody className="p-4">
          <img className="app-login__logo" src={LOGO_URL} alt={LOGO_ALT} />
          <h1 className="h4 text-center mb-1">Área da escola</h1>
          <p className="text-center mb-4">{PRODUCT_NAME}</p>
          {otpToken === null ? (
            <Form onSubmit={requestCode}>
              <FormGroup>
                <Label for="email">E-mail</Label>
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </FormGroup>
              {errorAlert}
              <Button color="primary" type="submit" className="w-100" disabled={busy}>
                Enviar código
              </Button>
            </Form>
          ) : (
            <>
              <p>Se o e-mail estiver cadastrado, você receberá um código em instantes.</p>
              <Form onSubmit={verify}>
                <FormGroup>
                  <Label for="code">Código de 6 dígitos</Label>
                  <Input
                    id="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="\d{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </FormGroup>
                {errorAlert}
                <Button color="primary" type="submit" className="w-100 mb-2" disabled={busy}>
                  Entrar
                </Button>
                <Button
                  color="link"
                  type="button"
                  className="w-100"
                  onClick={() => {
                    setOtpToken(null);
                    setCode("");
                    setError(null);
                  }}
                >
                  Usar outro e-mail
                </Button>
              </Form>
            </>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin src/app src/theme`
Expected: PASS — inclusive os testes antigos de `admin.test.tsx` (as páginas são renderizadas direto, sem moldura).

- [ ] **Step 8: Spec — menu por âncora e logout**

Em `docs/superpowers/specs/2026-11-19-ui-architectui-design.md`:

- No fim do bullet `- Menu lateral: Início · Alunos e responsáveis · …`, acrescente: ` Cardápio, Dias de serviço e Tablets da cozinha continuam seções da página inicial; o menu aponta para elas por âncora (`/admin#cardapio`, `/admin#dias`, `/admin#tablets`). Fora "Início", os itens só aparecem para `admin` e `secretaria`.`
- Troque o trecho `botão "Sair" (o logout já existente, se houver; senão, só limpa a sessão do lado do servidor pela rota existente — não criar rota nova sem necessidade).` por `botão "Sair". Não havia logout e o cookie é `HttpOnly`: foi criada `POST /api/admin/v1/auth/logout` (pública, 204, sem `Idempotency-Key`), que regrava `__session` vazio com `Max-Age=0`; a sessão é um token sem estado, que vence sozinho em 8 h.`

- [ ] **Step 9: Verificar e commitar**

Run (compose desligado): `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test && pnpm --filter @app-lanche/api exec vitest run src/modules/auth`

```bash
git add apps/api/src/platform/session.ts apps/api/src/modules/auth/routes.ts apps/api/src/modules/auth/staffAuth.test.ts \
  apps/web/src/areas/admin/adminNav.ts apps/web/src/areas/admin/AdminLayout.tsx apps/web/src/areas/admin/AdminArea.tsx \
  apps/web/src/areas/admin/AdminLogin.tsx apps/web/src/areas/admin/adminLayout.test.tsx apps/web/src/areas/admin/admin.test.tsx \
  apps/web/src/app/App.tsx apps/web/src/app/App.test.tsx docs/superpowers/specs/2026-11-19-ui-architectui-design.md
git commit -m "feat(web): lazy admin area with the themed shell, login and logout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 4: Início — importação, cardápio, dias de serviço e tablets

**Files:**
- Modify: `apps/web/src/areas/admin/AdminHome.tsx`, `apps/web/src/areas/admin/MenuAdmin.tsx`, `apps/web/src/areas/admin/ServiceDaysAdmin.tsx`, `apps/web/src/areas/admin/KitchenDevicesAdmin.tsx`
- Test: `apps/web/src/areas/admin/catalogAdmin.test.tsx`, `apps/web/src/areas/admin/admin.test.tsx`, `apps/web/src/areas/admin/kitchenDevices.test.tsx`

**Interfaces:**
- Consumes: `PageTitle`, `StatusBadge`, `announce`, `StatusNotice` (Task 2).
- Produces: seções com `id="importar"`, `id="cardapio"`, `id="dias"`, `id="tablets"` (alvos das âncoras de `adminNav`); a `AdminHome` rola até `location.hash` quando a sessão carrega ou o hash muda.

- [ ] **Step 1: Testes novos (falham)**

`apps/web/src/areas/admin/catalogAdmin.test.tsx`:
- troque `function renderAdmin()` e `initialEntries={["/admin"]}` por `function renderAdmin(path = "/admin")` e `initialEntries={[path]}`;
- no teste `"closes a day after confirming and reports the order count"`, depois de `await screen.findByText("Dia fechado: 3 pedidos.");` acrescente `expect(screen.getAllByRole("status").map((s) => s.textContent)).toContain("Dia fechado: 3 pedidos.");`;
- acrescente no fim do arquivo:

```tsx
describe("home sections", () => {
  it("puts menu, days and tablets at the sidebar anchors and scrolls to the requested one", async () => {
    const scrolled: string[] = [];
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value(this: HTMLElement) {
        scrolled.push(this.id);
      },
    });
    try {
      mockApi({ ...BASE, "GET /api/admin/v1/me": me("secretaria") });
      renderAdmin("/admin#dias");
      await screen.findByText("Pão — R$ 3,50");
      expect(document.getElementById("cardapio")).not.toBeNull();
      expect(document.getElementById("tablets")).not.toBeNull();
      expect(scrolled).toEqual(["dias"]);
    } finally {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("shows each day's situation and each item's state as badges", async () => {
    mockApi({
      "GET /api/admin/v1/menu-items": MENU,
      "GET /api/admin/v1/service-days": { status: 200, body: { serviceDays: [OPEN_DAY] } },
      "GET /api/admin/v1/me": me("admin"),
    });
    renderAdmin();
    expect((await screen.findByText("Aberto")).className).toContain("badge");
    expect(screen.getByText("Inativo").className).toContain("badge");
  });
});
```

`apps/web/src/areas/admin/admin.test.tsx` — no teste `"imports a CSV and shows the totals"`, depois do `findByText(...)`, acrescente `expect(screen.getByRole("status").textContent).toBe("Importação concluída: 2 turmas, 30 alunos, 41 responsáveis.");`.

`apps/web/src/areas/admin/kitchenDevices.test.tsx` — acrescente no `describe`:

```tsx
  it("shows each tablet's situation as a badge", async () => {
    mockApi({
      "GET /api/admin/v1/kds/devices": {
        status: 200,
        body: { devices: [{ id: DEV, createdAt: "2031-11-01T10:00:00.000Z", paired: false, revokedAt: null }] },
      },
    });
    render(<KitchenDevicesAdmin />);
    expect((await screen.findByText("aguardando pareamento")).className).toContain("badge");
  });
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/catalogAdmin.test.tsx src/areas/admin/admin.test.tsx src/areas/admin/kitchenDevices.test.tsx`
Expected: FAIL nos testes novos; os antigos passam.

- [ ] **Step 2: AdminHome**

`apps/web/src/areas/admin/AdminHome.tsx`:

```tsx
import { ImportStudentsResponse, StaffMeResponse } from "@app-lanche/contracts";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Form, FormGroup, Input, Label } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { staffErrorMessage } from "../../ui/messages";
import { KitchenDevicesAdmin } from "./KitchenDevicesAdmin";
import { MenuAdmin } from "./MenuAdmin";
import { ServiceDaysAdmin } from "./ServiceDaysAdmin";

export function AdminHome() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const [me, setMe] = useState<StaffMeResponse | null>(null);
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportStudentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch("/api/admin/v1/me", StaffMeResponse).then(setMe, (err) => {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        navigate("/admin/login", { replace: true });
      } else {
        setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
      }
    });
  }, [navigate]);

  // Cardápio, dias e tablets são seções desta página: o menu lateral aponta para elas por âncora.
  useEffect(() => {
    if (me && hash) document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: "start" });
  }, [me, hash]);

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) setCsv(await file.text());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setResult(null);
    try {
      const res = await apiFetch("/api/admin/v1/import/students", ImportStudentsResponse, {
        method: "POST",
        body: { csv },
      });
      setResult(res);
      if (res.applied) {
        const message = `Importação concluída: ${res.classes} turmas, ${res.students} alunos, ${res.guardians} responsáveis.`;
        setNotice(message);
        announce(message);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate("/admin/login", { replace: true });
        return;
      }
      setError(staffErrorMessage(err instanceof ApiError ? err.code : "internal_error"));
    } finally {
      setBusy(false);
    }
  }

  if (!me) {
    return (
      <div>
        {error ? (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        ) : (
          <p>Carregando…</p>
        )}
      </div>
    );
  }

  return (
    <>
      <PageTitle heading={me.schoolName} subheading="Início" icon="pe-7s-home" />
      <Card tag="section" id="importar" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">
          Importar alunos e responsáveis
        </CardHeader>
        <CardBody>
          <p>
            Colunas: <code>codigo_aluno, primeiro_nome, turma, responsavel_nome, responsavel_telefone</code>.
            Opcionais (para documentos):{" "}
            <code>nome_completo, data_nascimento, responsavel_nome_completo, responsavel_cpf</code>.
            Um aluno com dois responsáveis ocupa duas linhas.
          </p>
          <Form onSubmit={submit}>
            <FormGroup>
              <Label for="file">Arquivo CSV</Label>
              <Input id="file" type="file" accept=".csv,text/csv" onChange={loadFile} />
            </FormGroup>
            <FormGroup>
              <Label for="csv">Conteúdo do CSV</Label>
              <Input id="csv" type="textarea" rows={8} required value={csv} onChange={(e) => setCsv(e.target.value)} />
            </FormGroup>
            <Button color="primary" type="submit" disabled={busy}>
              Importar
            </Button>
          </Form>
          {error && (
            <Alert color="danger" fade={false} className="mt-3">
              {error}
            </Alert>
          )}
          <StatusNotice message={notice} />
          {result && !result.applied && (
            <Alert color="danger" fade={false} className="mt-3">
              <p>Nada foi importado. Corrija as linhas abaixo e envie de novo.</p>
              <ul className="mb-0">
                {result.errors.map((e) => (
                  <li key={`${e.line}-${e.message}`}>Linha {e.line}: {e.message}</li>
                ))}
              </ul>
            </Alert>
          )}
        </CardBody>
      </Card>
      {(me.role === "admin" || me.role === "secretaria") && (
        <>
          <MenuAdmin />
          <ServiceDaysAdmin />
          <KitchenDevicesAdmin />
        </>
      )}
    </>
  );
}
```

(Os links "Alunos e responsáveis · Documentos" saem da página: estão no menu lateral, com a mesma regra de papel.)

- [ ] **Step 3: Cardápio**

`apps/web/src/areas/admin/MenuAdmin.tsx` — estado, efeitos, `add` e `toggle` ficam iguais; troque os imports e o `return`:

```tsx
import { MenuItem, MenuItemListResponse } from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Col, Form, FormGroup, Input, Label, Row, Table } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { StatusBadge } from "../../theme/StatusBadge";
import { staffErrorMessage } from "../../ui/messages";
import { formatCents, parsePriceToCents } from "../../ui/money";
```

```tsx
  return (
    <Card tag="section" id="cardapio" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">
        Cardápio
      </CardHeader>
      <CardBody>
        {items.length === 0 ? (
          <p>Nenhum item no cardápio.</p>
        ) : (
          <Table responsive hover striped className="mb-4">
            <thead>
              <tr>
                <th>Item</th>
                <th>Situação</th>
                <th>
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td>{`${i.name} — ${formatCents(i.priceCents)}${i.active ? "" : " (inativo)"}`}</td>
                  <td>
                    <StatusBadge tone={i.active ? "success" : "secondary"}>{i.active ? "Ativo" : "Inativo"}</StatusBadge>
                  </td>
                  <td className="text-end">
                    <Button size="sm" outline color={i.active ? "secondary" : "primary"} type="button" onClick={() => toggle(i)}>
                      {i.active ? "Desativar" : "Ativar"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Form onSubmit={add}>
          <h3 className="h6">Novo item</h3>
          <Row className="g-2 align-items-end">
            <Col md={6}>
              <FormGroup>
                <Label for="menu-name">Nome</Label>
                <Input
                  id="menu-name"
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    keyRef.current = null;
                    setName(e.target.value);
                  }}
                />
              </FormGroup>
            </Col>
            <Col md={3}>
              <FormGroup>
                <Label for="menu-price">Preço (R$)</Label>
                <Input
                  id="menu-price"
                  required
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => {
                    keyRef.current = null;
                    setPrice(e.target.value);
                  }}
                />
              </FormGroup>
            </Col>
            <Col md={3}>
              <FormGroup>
                <Button color="primary" type="submit" className="w-100" disabled={busy}>
                  Adicionar
                </Button>
              </FormGroup>
            </Col>
          </Row>
        </Form>
        {error && (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        )}
      </CardBody>
    </Card>
  );
```

- [ ] **Step 4: Dias de serviço**

`apps/web/src/areas/admin/ServiceDaysAdmin.tsx` — `formatDate`, `formatTime`, estado, `reload`, `toggleItem` e `save` iguais. Imports:

```tsx
import {
  ManifestResponse,
  MenuItemListResponse,
  ServiceDay as ServiceDaySchema,
  ServiceDayListResponse,
  type MenuItem,
  type ServiceDay,
} from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Col, Form, FormGroup, Input, Label, Row, Table } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { announce, StatusNotice } from "../../theme/notify";
import { StatusBadge } from "../../theme/StatusBadge";
import { staffErrorMessage } from "../../ui/messages";
import { formatCents } from "../../ui/money";
```

Em `close`, troque `setNotice(\`Dia fechado: ${manifest.totals.orders} pedidos.\`);` por:

```tsx
      const message = `Dia fechado: ${manifest.totals.orders} pedidos.`;
      setNotice(message);
      announce(message);
```

`return`:

```tsx
  return (
    <Card tag="section" id="dias" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">
        Dias de serviço
      </CardHeader>
      <CardBody>
        {days.length === 0 ? (
          <p>Nenhum dia de serviço aberto.</p>
        ) : (
          <Table responsive hover striped className="mb-4">
            <thead>
              <tr>
                <th>Data</th>
                <th>Corte</th>
                <th>Situação</th>
                <th>Itens</th>
                <th>
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <tr key={d.serviceDate}>
                  <td>{formatDate(d.serviceDate)}</td>
                  <td>{formatTime(d.cutoffAt)}</td>
                  <td>
                    <StatusBadge tone={d.status === "open" ? "success" : "secondary"}>
                      {d.status === "open" ? "Aberto" : "Fechado"}
                    </StatusBadge>
                  </td>
                  <td>
                    <ul className="list-unstyled mb-0">
                      {d.items.map((i) => (
                        <li key={i.menuItemId}>{`${i.name} — ${formatCents(i.priceCents)}`}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="text-end">
                    {d.status === "open" && (
                      <Button size="sm" outline color="danger" type="button" disabled={busy} onClick={() => close(d)}>
                        Fechar dia
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <Form onSubmit={save}>
          <h3 className="h6">Abrir dia</h3>
          <Row className="g-2">
            <Col md={4}>
              <FormGroup>
                <Label for="day-date">Data</Label>
                <Input id="day-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
              </FormGroup>
            </Col>
            <Col md={4}>
              <FormGroup>
                <Label for="day-cutoff">Horário de corte (opcional)</Label>
                <Input id="day-cutoff" type="time" value={cutoff} onChange={(e) => setCutoff(e.target.value)} />
              </FormGroup>
            </Col>
          </Row>
          <fieldset className="mb-3">
            <legend className="fs-6">Itens</legend>
            {menu
              .filter((i) => i.active)
              .map((i) => (
                <FormGroup check inline key={i.id}>
                  <Label check>
                    <Input type="checkbox" checked={selected.has(i.id)} onChange={() => toggleItem(i.id)} /> {i.name}
                  </Label>
                </FormGroup>
              ))}
          </fieldset>
          <Button color="primary" type="submit" disabled={busy || selected.size === 0}>
            Salvar dia
          </Button>
        </Form>
        {error && (
          <Alert color="danger" fade={false} className="mt-3">
            {error}
          </Alert>
        )}
        <StatusNotice message={notice} />
      </CardBody>
    </Card>
  );
```

- [ ] **Step 5: Tablets da cozinha**

`apps/web/src/areas/admin/KitchenDevicesAdmin.tsx` — `load`, `generate` e `revoke` iguais. Imports e `return`:

```tsx
import { KitchenDeviceListResponse, PairingCodeResponse } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Card, CardBody, CardHeader, Table } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { StatusBadge } from "../../theme/StatusBadge";
import { staffErrorMessage } from "../../ui/messages";
```

```tsx
  return (
    <Card tag="section" id="tablets" className="main-card mb-3">
      <CardHeader tag="h2" className="h6 mb-0">
        Tablets da cozinha
      </CardHeader>
      <CardBody>
        <Button color="primary" type="button" onClick={() => void generate()}>
          Gerar código de pareamento
        </Button>
        {code && (
          <div className="border rounded bg-light p-3 my-3">
            <p className="mb-0">
              <strong className="fs-4 font-monospace">{code.code}</strong> — Digite este código no tablet da cozinha, em /kds. Vale até{" "}
              {new Date(code.expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.
            </p>
          </div>
        )}
        {error && (
          <Alert color="danger" fade={false} className="mt-3">
            {error}
          </Alert>
        )}
        {devices.length === 0 ? (
          <p className="mt-3 mb-0">Nenhum tablet cadastrado.</p>
        ) : (
          <Table responsive hover striped className="mt-3 mb-0">
            <thead>
              <tr>
                <th>Tablet</th>
                <th>Situação</th>
                <th>
                  <span className="visually-hidden">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>Tablet de {new Date(d.createdAt).toLocaleDateString("pt-BR")}</td>
                  <td>
                    <StatusBadge tone={d.revokedAt ? "secondary" : d.paired ? "success" : "warning"}>
                      {d.revokedAt ? "revogado" : d.paired ? "pareado" : "aguardando pareamento"}
                    </StatusBadge>
                  </td>
                  <td className="text-end">
                    {!d.revokedAt && (
                      <Button size="sm" outline color="danger" type="button" onClick={() => void revoke(d.id)}>
                        Revogar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </CardBody>
    </Card>
  );
```

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin`
Expected: PASS (antigos e novos).

- [ ] **Step 7: Verificar e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test`

```bash
git add apps/web/src/areas/admin/AdminHome.tsx apps/web/src/areas/admin/MenuAdmin.tsx apps/web/src/areas/admin/ServiceDaysAdmin.tsx \
  apps/web/src/areas/admin/KitchenDevicesAdmin.tsx apps/web/src/areas/admin/catalogAdmin.test.tsx apps/web/src/areas/admin/admin.test.tsx \
  apps/web/src/areas/admin/kitchenDevices.test.tsx
git commit -m "feat(web): theme the admin home sections

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 5: Alunos e responsáveis, Documentos e editor de modelos

**Files:**
- Modify: `apps/web/src/areas/admin/StudentsAdmin.tsx`, `apps/web/src/areas/admin/DocumentsAdmin.tsx`, `apps/web/src/areas/admin/TemplateEditor.tsx`, `apps/web/src/areas/admin/documentLabels.ts`
- Test: `apps/web/src/areas/admin/studentsAdmin.test.tsx`, `apps/web/src/areas/admin/documentsAdmin.test.tsx`

**Interfaces:**
- Consumes: `PageTitle`, `StatusBadge`, `Tone`, `announce`, `StatusNotice` (Task 2).
- Produces: `BATCH_STATUS_TONES: Record<BatchStatus, Tone>` e `DOCUMENT_STATUS_TONES: Record<DocumentStatus, Tone>` (`documentLabels.ts`, usados também na Task 6); `StudentFilters` com os mesmos props e rótulos.

- [ ] **Step 1: Testes novos (falham)**

`studentsAdmin.test.tsx` — no teste `"edits a student's full name and birth date"`, depois de `await screen.findByText("Dados salvos.");` acrescente `expect(screen.getByRole("status").textContent).toBe("Dados salvos.");` e, no teste `"lists students with the CPF masked and filters them"`, logo depois do primeiro `findByText`, acrescente `expect(screen.getByRole("heading", { level: 1, name: "Alunos e responsáveis" })).toBeTruthy();`.

`documentsAdmin.test.tsx` — no teste `"lists templates, examples and batches with how many guardians opened"`, troque `expect(screen.getByText("Publicado")).toBeTruthy();` por `expect(screen.getByText("Publicado").className).toContain("text-bg-success");` (mesma prova, mais o selo) e, no teste que espera `"Versão 1 salva."`, depois do `findByText` acrescente `expect(screen.getByRole("status").textContent).toBe("Versão 1 salva.");`.

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/studentsAdmin.test.tsx src/areas/admin/documentsAdmin.test.tsx`
Expected: FAIL nessas asserções.

- [ ] **Step 2: Tons dos selos**

`apps/web/src/areas/admin/documentLabels.ts` — acrescente:

```ts
import type { Tone } from "../../theme/StatusBadge";

export const BATCH_STATUS_TONES: Record<BatchStatus, Tone> = {
  rendering: "info",
  ready: "warning",
  published: "success",
};

export const DOCUMENT_STATUS_TONES: Record<DocumentStatus, Tone> = {
  pending: "secondary",
  rendering: "info",
  rendered: "success",
  failed: "danger",
};
```

(Junte o `import type { Tone }` aos imports do topo do arquivo.)

- [ ] **Step 3: Alunos e responsáveis**

`apps/web/src/areas/admin/StudentsAdmin.tsx` — arquivo completo:

```tsx
import { ClassListResponse, GuardianDetail, StudentListResponse, formatCpf } from "@app-lanche/contracts";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Alert, Button, Card, CardBody, Col, Form, FormGroup, Input, Label, Row, Table } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { formatIsoDate } from "../../ui/dates";
import { filterStudents, studentLabel, type ClassRow, type StudentRow } from "./studentFilter";
import { useStaffErrors } from "./useStaffErrors";

export function StudentFilters(props: { classes: ClassRow[]; classId: string; query: string; onClass: (id: string) => void; onQuery: (q: string) => void }) {
  return (
    <Row className="g-2 mb-3">
      <Col md={4}>
        <Label for="filter-class">Turma</Label>
        <Input id="filter-class" type="select" value={props.classId} onChange={(e) => props.onClass(e.target.value)}>
          <option value="">Todas</option>
          {props.classes.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Input>
      </Col>
      <Col md={8}>
        <Label for="filter-query">Buscar por nome</Label>
        <Input id="filter-query" type="search" value={props.query} onChange={(e) => props.onQuery(e.target.value)} />
      </Col>
    </Row>
  );
}

type FormProps = { onSubmit: () => void; onSaved: () => Promise<void>; onCancel: () => void; onError: (err: unknown) => void };

/** Só dígitos, no máximo 11; formatado quando completo. Colar "CPF 111.444.777-35 " não perde dígito. */
function cpfInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 11);
  return digits.length === 11 ? formatCpf(digits) : digits;
}

function StudentForm({ student, onSubmit, onSaved, onCancel, onError }: FormProps & { student: StudentRow }) {
  const [fullName, setFullName] = useState(student.fullName ?? "");
  const [birthDate, setBirthDate] = useState(student.birthDate ?? "");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
    setBusy(true);
    try {
      await apiFetch(`/api/admin/v1/students/${student.id}`, z.undefined(), {
        method: "PUT",
        body: { fullName: fullName.trim() || null, birthDate: birthDate || null },
      });
      await onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="main-card mb-3">
      <CardBody>
        <Form onSubmit={submit}>
          <h2 className="h6">{student.firstName} — {student.className}</h2>
          <Row className="g-2">
            <Col md={8}>
              <FormGroup>
                <Label for="student-full-name">Nome completo</Label>
                <Input id="student-full-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </FormGroup>
            </Col>
            <Col md={4}>
              <FormGroup>
                <Label for="student-birth-date">Data de nascimento</Label>
                <Input id="student-birth-date" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
              </FormGroup>
            </Col>
          </Row>
          <div className="d-flex gap-2">
            <Button color="primary" type="submit" disabled={busy}>Salvar</Button>
            <Button color="secondary" outline type="button" onClick={onCancel}>Cancelar</Button>
          </div>
        </Form>
      </CardBody>
    </Card>
  );
}

function GuardianForm({ guardianId, onSubmit, onSaved, onCancel, onError }: FormProps & { guardianId: string }) {
  const [detail, setDetail] = useState<GuardianDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fullName, setFullName] = useState("");
  const [cpf, setCpf] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch(`/api/admin/v1/guardians/${guardianId}`, GuardianDetail).then(
      (d) => {
        setDetail(d);
        setFullName(d.fullName ?? "");
        setCpf(d.cpf ? formatCpf(d.cpf) : "");
      },
      (err: unknown) => {
        // Sessão vencida segue para o login; o resto vira a mensagem do próprio formulário.
        if (err instanceof ApiError && err.status === 401) onError(err);
        else setLoadFailed(true);
      },
    );
  }, [guardianId, onError]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
    setBusy(true);
    try {
      await apiFetch(`/api/admin/v1/guardians/${guardianId}`, z.undefined(), {
        method: "PUT",
        body: { fullName: fullName.trim() || null, cpf: cpf.trim() || null },
      });
      await onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  if (loadFailed) {
    return (
      <Alert color="danger" fade={false}>
        Não foi possível carregar o responsável.
      </Alert>
    );
  }
  if (!detail) return <p>Carregando…</p>;
  return (
    <Card className="main-card mb-3">
      <CardBody>
        <Form onSubmit={submit}>
          <h2 className="h6">Responsável: {detail.firstName}</h2>
          <Row className="g-2">
            <Col md={8}>
              <FormGroup>
                <Label for="guardian-full-name">Nome completo do responsável</Label>
                <Input id="guardian-full-name" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} />
              </FormGroup>
            </Col>
            <Col md={4}>
              <FormGroup>
                <Label for="guardian-cpf">CPF</Label>
                <Input id="guardian-cpf" inputMode="numeric" autoComplete="off" value={cpf} onChange={(e) => setCpf(cpfInput(e.target.value))} />
              </FormGroup>
            </Col>
          </Row>
          <div className="d-flex gap-2">
            <Button color="primary" type="submit" disabled={busy}>Salvar</Button>
            <Button color="secondary" outline type="button" onClick={onCancel}>Cancelar</Button>
          </div>
        </Form>
      </CardBody>
    </Card>
  );
}

export function StudentsAdmin() {
  const { error, setError, fail } = useStaffErrors();
  const [students, setStudents] = useState<StudentRow[] | null>(null);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classId, setClassId] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ kind: "student"; student: StudentRow } | { kind: "guardian"; id: string } | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        apiFetch("/api/admin/v1/students", StudentListResponse),
        apiFetch("/api/admin/v1/classes", ClassListResponse),
      ]);
      setStudents(s.students);
      setClasses(c.classes);
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => void load(), [load]);

  function edit(next: typeof editing) {
    setStatus(null);
    setError(null);
    setEditing(next);
  }

  async function saved() {
    setEditing(null);
    setError(null);
    setStatus("Dados salvos.");
    announce("Dados salvos.");
    await load();
  }

  if (!students) {
    return (
      <div>
        {error ? (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        ) : (
          <p>Carregando…</p>
        )}
      </div>
    );
  }
  const visible = filterStudents(students, { classId, query });
  const formProps = {
    onSubmit: () => {
      setStatus(null);
      setError(null);
    },
    onSaved: saved,
    onCancel: () => {
      setEditing(null);
      setError(null);
    },
    onError: fail,
  };

  return (
    <>
      <PageTitle heading="Alunos e responsáveis" subheading="Nome completo, nascimento e CPF usados nos documentos." icon="pe-7s-users" />
      <StatusNotice message={status} />
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      {editing?.kind === "student" && <StudentForm key={editing.student.id} student={editing.student} {...formProps} />}
      {editing?.kind === "guardian" && <GuardianForm key={editing.id} guardianId={editing.id} {...formProps} />}
      <Card className="main-card mb-3">
        <CardBody>
          <StudentFilters classes={classes} classId={classId} query={query} onClass={setClassId} onQuery={setQuery} />
          <Table responsive hover striped className="mb-0">
            <thead>
              <tr><th>Aluno</th><th>Turma</th><th>Nascimento</th><th>Responsáveis</th></tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.id}>
                  <td>
                    <span>{studentLabel(s)}</span>{" "}
                    <Button size="sm" color="link" type="button" aria-label={`Editar aluno ${studentLabel(s)}`} onClick={() => edit({ kind: "student", student: s })}>
                      Editar
                    </Button>
                  </td>
                  <td>{s.className}</td>
                  <td>{s.birthDate ? formatIsoDate(s.birthDate) : "—"}</td>
                  <td>
                    {s.guardians.length === 0 ? (
                      <span>Nenhum responsável</span>
                    ) : (
                      <ul className="list-unstyled mb-0">
                        {s.guardians.map((g) => (
                          <li key={g.id}>
                            {g.fullName ?? g.firstName} — {g.cpfMasked ?? "CPF não informado"}{" "}
                            <Button size="sm" color="link" type="button" aria-label={`Editar responsável ${g.firstName}`} onClick={() => edit({ kind: "guardian", id: g.id })}>
                              Editar
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </>
  );
}
```

(O link "Voltar" sai: o menu lateral leva ao Início.)

- [ ] **Step 4: Documentos**

`apps/web/src/areas/admin/DocumentsAdmin.tsx` — `load`, `copyExample` e `archive` iguais. Imports e o restante:

```tsx
import { BatchListResponse, Template, TemplateExampleListResponse, TemplateListResponse } from "@app-lanche/contracts";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Table } from "reactstrap";
import { z } from "zod";
import { apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { StatusBadge } from "../../theme/StatusBadge";
import { formatInstantDate } from "../../ui/dates";
import { BATCH_STATUS_LABELS, BATCH_STATUS_TONES, CATEGORY_LABELS } from "./documentLabels";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";
```

```tsx
  if (!templates) {
    return (
      <div>
        {error ? (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        ) : (
          <p>Carregando…</p>
        )}
      </div>
    );
  }

  return (
    <>
      <PageTitle
        heading="Documentos"
        subheading="Modelos e lotes de declarações, comunicados e autorizações."
        icon="pe-7s-news-paper"
        actions={<Link className="btn btn-primary" to="/admin/documentos/modelos/novo">Novo modelo</Link>}
      />
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      <Card tag="section" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">Modelos</CardHeader>
        <CardBody>
          {templates.length === 0 ? (
            <p>Nenhum modelo ainda. Comece por um exemplo pronto.</p>
          ) : (
            <Table responsive hover striped>
              <thead>
                <tr><th>Nome</th><th>Categoria</th><th>Versão</th><th>Atualizado em</th><th>Ações</th></tr>
              </thead>
              <tbody>
                {templates.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{CATEGORY_LABELS[t.category]}</td>
                    <td>{t.version}</td>
                    <td>{formatInstantDate(t.updatedAt)}</td>
                    <td>
                      <div className="d-flex flex-wrap gap-1">
                        <Link className="btn btn-sm btn-outline-primary" to={`/admin/documentos/modelos/${t.id}`}>Editar</Link>
                        <Link className="btn btn-sm btn-outline-primary" to={`/admin/documentos/gerar/${t.id}`}>Gerar</Link>
                        <Button size="sm" outline color="danger" type="button" aria-label={`Arquivar ${t.name}`} onClick={() => void archive(t.id, t.name)}>
                          Arquivar
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <h3 className="h6 mt-4">Exemplos prontos</h3>
          <ul className="list-group">
            {examples.map((e) => (
              <li key={e.key} className="list-group-item d-flex align-items-center justify-content-between gap-2">
                <span>{e.name}</span>
                <Button size="sm" outline color="primary" type="button" aria-label={`Usar exemplo ${e.name}`} onClick={() => void copyExample(e.key)}>
                  Usar exemplo
                </Button>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
      <Card tag="section" className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">Lotes</CardHeader>
        <CardBody>
          {batches.length === 0 ? (
            <p className="mb-0">Nenhum lote gerado.</p>
          ) : (
            <Table responsive hover striped className="mb-0">
              <thead>
                <tr><th>Modelo</th><th>Situação</th><th>Criado em</th><th>Documentos</th><th>Abriram</th><th><span className="visually-hidden">Ações</span></th></tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.templateName} (versão {b.templateVersion})</td>
                    <td>
                      <StatusBadge tone={BATCH_STATUS_TONES[b.status]}>{BATCH_STATUS_LABELS[b.status]}</StatusBadge>
                    </td>
                    <td>{formatInstantDate(b.createdAt)}</td>
                    <td>{b.counts.total - b.counts.discarded}</td>
                    <td>{b.status === "published" ? `${b.viewers} de ${b.recipients}` : "—"}</td>
                    <td className="text-end">
                      <Link className="btn btn-sm btn-outline-primary" to={`/admin/documentos/lotes/${b.id}`}>Abrir</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
    </>
  );
```

- [ ] **Step 5: Editor de modelos**

`apps/web/src/areas/admin/TemplateEditor.tsx` — `update`, `updateField`, `insert`, `handle`, `refuseDuplicateKeys`, `showPreview` e `save` iguais. Imports:

```tsx
import {
  DocumentCategory,
  TEMPLATE_VARIABLE_LABELS,
  TEMPLATE_VARIABLES,
  Template,
  type DocumentField,
  type TemplateInput,
} from "@app-lanche/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Col, Form, FormGroup, Input, Label, Row } from "reactstrap";
import { ApiError, apiFetch, apiFetchBlob } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { staffErrorMessage } from "../../ui/messages";
import { CATEGORY_LABELS } from "./documentLabels";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";
```

Logo depois do efeito que libera a URL da prévia (antes do `if (!draft)`), acrescente:

```tsx
  const savedMessage = savedVersion !== undefined ? `Versão ${savedVersion} salva.` : null;
  useEffect(() => {
    if (savedMessage) announce(savedMessage);
  }, [savedMessage]);
```

Troque o `if (!draft) return …` por:

```tsx
  if (!draft) {
    return (
      <div>
        {error ? (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        ) : (
          <p>Carregando…</p>
        )}
      </div>
    );
  }
```

E o `return` final por:

```tsx
  return (
    <>
      <PageTitle
        heading={loaded ? `${loaded.name} — versão ${loaded.version}` : "Novo modelo"}
        icon="pe-7s-note2"
        actions={<Link className="btn btn-outline-secondary" to="/admin/documentos">Voltar aos documentos</Link>}
      />
      <StatusNotice message={savedMessage} />
      {loaded && !loaded.latest && <div className="alert alert-warning">Esta não é a versão mais recente do modelo.</div>}
      {error && (
        <Alert color="danger" fade={false}>
          <p className="mb-0">{error}</p>
          {invalid.length > 0 && <ul className="mt-2 mb-0">{invalid.map((v) => <li key={v}>{v}</li>)}</ul>}
        </Alert>
      )}
      <Card className="main-card mb-3">
        <CardBody>
          <Form onSubmit={save}>
            <Row className="g-2">
              <Col md={8}>
                <FormGroup>
                  <Label for="template-name">Nome</Label>
                  <Input id="template-name" required maxLength={120} value={draft.name} onChange={(e) => update({ name: e.target.value })} />
                </FormGroup>
              </Col>
              <Col md={4}>
                <FormGroup>
                  <Label for="template-category">Categoria</Label>
                  <Input id="template-category" type="select" value={draft.category} onChange={(e) => update({ category: DocumentCategory.parse(e.target.value) })}>
                    {DocumentCategory.options.map((c) => (
                      <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                    ))}
                  </Input>
                </FormGroup>
              </Col>
            </Row>

            <fieldset className="mb-3">
              <legend className="fs-6">Variáveis (clique para inserir no texto)</legend>
              <div className="d-flex flex-wrap gap-2">
                {TEMPLATE_VARIABLES.map((v) => (
                  <Button key={v} size="sm" outline color="primary" type="button" title={`{{${v}}}`} onClick={() => insert(v)}>
                    {TEMPLATE_VARIABLE_LABELS[v]}
                  </Button>
                ))}
                {draft.fields.filter((f) => f.key && f.label).map((f) => (
                  <Button key={f.key} size="sm" outline color="secondary" type="button" title={`{{campo.${f.key}}}`} onClick={() => insert(`campo.${f.key}`)}>
                    Campo: {f.label}
                  </Button>
                ))}
              </div>
            </fieldset>

            <FormGroup>
              <Label for="template-body">Texto do modelo</Label>
              <p className="small mb-2">Use # e ## para títulos, **negrito**, listas com - ou 1. e tabelas com |.</p>
              <Input id="template-body" type="textarea" className="font-monospace" innerRef={body} rows={16} required value={draft.bodyMd} onChange={(e) => update({ bodyMd: e.target.value })} />
            </FormGroup>

            <fieldset className="mb-3">
              <legend className="fs-6">Campos preenchidos ao gerar (até 10)</legend>
              {draft.fields.map((f, i) => (
                <Row key={i} className="g-2 align-items-end mb-2">
                  <Col md={3}>
                    <Label for={`field-key-${i}`}>Chave</Label>
                    <Input id={`field-key-${i}`} required pattern="[a-z][a-z0-9_]{0,29}" value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} />
                  </Col>
                  <Col md={4}>
                    <Label for={`field-label-${i}`}>Rótulo</Label>
                    <Input id={`field-label-${i}`} required maxLength={80} value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} />
                  </Col>
                  <Col md={3}>
                    <Label for={`field-type-${i}`}>Tipo</Label>
                    <Input id={`field-type-${i}`} type="select" value={f.type} onChange={(e) => updateField(i, { type: e.target.value === "data" ? "data" : "texto" })}>
                      <option value="texto">Texto</option>
                      <option value="data">Data</option>
                    </Input>
                  </Col>
                  <Col md={2}>
                    <Button outline color="danger" type="button" className="w-100" onClick={() => update({ fields: draft.fields.filter((_, j) => j !== i) })}>
                      Remover campo
                    </Button>
                  </Col>
                </Row>
              ))}
              {draft.fields.length < 10 && (
                <Button outline color="secondary" type="button" onClick={() => update({ fields: [...draft.fields, { key: "", label: "", type: "texto" }] })}>
                  Adicionar campo
                </Button>
              )}
            </fieldset>

            <div className="d-flex gap-2">
              <Button outline color="secondary" type="button" disabled={busy} onClick={() => void showPreview()}>Ver prévia</Button>
              <Button color="primary" type="submit" disabled={busy}>Salvar</Button>
            </div>
          </Form>
        </CardBody>
      </Card>
      {preview && (
        <Card className="main-card mb-3">
          <CardHeader tag="h2" className="h6 mb-0">Prévia</CardHeader>
          <CardBody className="p-0">
            <iframe title="Prévia do PDF" src={preview} width="100%" height="600" className="d-block border-0" />
          </CardBody>
        </Card>
      )}
    </>
  );
```

(Atenção: o teste de variáveis inválidas exige que a única `<li>` da página seja a da lista dentro do `Alert`; não transforme botões nem campos em lista.)

- [ ] **Step 6: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin`
Expected: PASS.

- [ ] **Step 7: Verificar e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test`

```bash
git add apps/web/src/areas/admin/StudentsAdmin.tsx apps/web/src/areas/admin/DocumentsAdmin.tsx apps/web/src/areas/admin/TemplateEditor.tsx \
  apps/web/src/areas/admin/documentLabels.ts apps/web/src/areas/admin/studentsAdmin.test.tsx apps/web/src/areas/admin/documentsAdmin.test.tsx
git commit -m "feat(web): theme students, documents and the template editor

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 6: Gerar lote e tela do lote

**Files:**
- Modify: `apps/web/src/areas/admin/GenerateBatch.tsx`, `apps/web/src/areas/admin/BatchPage.tsx`
- Test: `apps/web/src/areas/admin/batches.test.tsx`

**Interfaces:**
- Consumes: `PageTitle`, `StatusBadge`, `announce`, `StatusNotice` (Task 2); `BATCH_STATUS_TONES`, `DOCUMENT_STATUS_TONES` (Task 5); `StudentFilters` (Task 5).
- Produces: nada novo para outras tasks (`missingLines`, `RENDER_*` continuam exportados como hoje).

- [ ] **Step 1: Testes novos (falham)**

Em `apps/web/src/areas/admin/batches.test.tsx`:
- no teste que espera `"Lote publicado. Os responsáveis serão avisados pelo WhatsApp."`, depois do `findByText` acrescente `expect(screen.getByRole("status").textContent).toBe("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");`;
- acrescente um `describe` no fim:

```tsx
describe("batch page look", () => {
  it("shows the batch and each document's situation as badges", async () => {
    mockApi({
      [`GET /api/admin/v1/document-batches/${B1}`]: {
        status: 200,
        body: detail("ready", counts({ rendered: 1, failed: 1 }), [doc(D1, "rendered"), doc(D2, "failed")]),
      },
    });
    renderAt(`/admin/documentos/lotes/${B1}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Autorização de passeio — versão 1" })).toBeTruthy();
    expect(screen.getByText("Pronto para publicar").className).toContain("text-bg-warning");
    expect(screen.getByText("Pronto").className).toContain("text-bg-success");
    expect(screen.getByText("Falhou").className).toContain("text-bg-danger");
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin/batches.test.tsx`
Expected: FAIL nos testes novos.

- [ ] **Step 2: Gerar lote**

`apps/web/src/areas/admin/GenerateBatch.tsx` — `label`, `MissingLine`, `missingLines`, estado, efeito, `mark`, `nameOf`, `guardianOf` e `submit` iguais. Imports:

```tsx
import {
  BatchSummary,
  ClassListResponse,
  MissingDataDetails,
  StudentListResponse,
  TEMPLATE_VARIABLE_LABELS,
  Template,
  type TemplateVariable,
} from "@app-lanche/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Form, FormGroup, Input, Label } from "reactstrap";
import { ApiError, apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { staffErrorMessage } from "../../ui/messages";
import { StudentFilters } from "./StudentsAdmin";
import { filterStudents, studentLabel, type ClassRow, type StudentRow } from "./studentFilter";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";
```

`if (!template) …`:

```tsx
  if (!template) {
    return (
      <div>
        {error ? (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        ) : (
          <p>Carregando…</p>
        )}
      </div>
    );
  }
```

`return`:

```tsx
  return (
    <>
      <PageTitle
        heading={`Gerar: ${template.name}`}
        icon="pe-7s-news-paper"
        actions={<Link className="btn btn-outline-secondary" to="/admin/documentos">Voltar aos documentos</Link>}
      />
      {error && (
        <Alert color="danger" fade={false}>
          <p className="mb-0">{error}</p>
          {missing.length > 0 && (
            <ul className="mt-2 mb-0">
              {missingLines(missing).map((m) => (
                <li key={m.key}>
                  {nameOf(m.studentId)}
                  {m.guardianId ? ` (responsável ${guardianOf(m.guardianId)})` : ""}: {m.variables.map(label).join(", ")}
                </li>
              ))}
            </ul>
          )}
          {missing.length > 0 && (
            <p className="mt-2 mb-0">
              <Link className="alert-link" to="/admin/alunos">Abrir Alunos e responsáveis</Link>
            </p>
          )}
        </Alert>
      )}
      <Form onSubmit={submit}>
        <Card tag="section" className="main-card mb-3">
          <CardHeader tag="h2" className="h6 mb-0">Alunos</CardHeader>
          <CardBody>
            <StudentFilters classes={classes} classId={classId} query={query} onClass={setClassId} onQuery={setQuery} />
            <div className="d-flex flex-wrap gap-2 mb-2">
              <Button size="sm" outline color="primary" type="button" disabled={classId === ""} onClick={() => mark(students.filter((s) => s.classId === classId).map((s) => s.id), true)}>
                Marcar turma
              </Button>
              <Button size="sm" outline color="primary" type="button" onClick={() => mark(students.map((s) => s.id), true)}>
                Marcar todos
              </Button>
              <Button size="sm" outline color="secondary" type="button" onClick={() => setSelected(new Set())}>
                Desmarcar todos
              </Button>
            </div>
            <p>{selected.size} aluno(s) marcado(s)</p>
            <ul className="list-unstyled mb-0">
              {visible.map((s) => (
                <li key={s.id}>
                  <FormGroup check>
                    <Input id={`pick-${s.id}`} type="checkbox" checked={selected.has(s.id)} onChange={(e) => mark([s.id], e.target.checked)} />
                    <Label check for={`pick-${s.id}`}>{studentLabel(s)} — {s.className}</Label>
                  </FormGroup>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
        {template.fields.length > 0 && (
          <Card tag="section" className="main-card mb-3">
            <CardHeader tag="h2" className="h6 mb-0">Campos do lote</CardHeader>
            <CardBody>
              {template.fields.map((f) => (
                <FormGroup key={f.key}>
                  <Label for={`value-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`value-${f.key}`}
                    type={f.type === "data" ? "date" : "text"}
                    required
                    maxLength={200}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                </FormGroup>
              ))}
            </CardBody>
          </Card>
        )}
        <Button color="primary" size="lg" type="submit" disabled={busy || selected.size === 0}>
          Gerar documentos
        </Button>
      </Form>
    </>
  );
```

- [ ] **Step 3: Tela do lote**

`apps/web/src/areas/admin/BatchPage.tsx` — constantes, `sleep`, estado, `load`, `renderAll`, efeitos, `download` e `discard` iguais. Imports:

```tsx
import { BatchDetail, BatchSummary, DocumentDownloadResponse, RenderProgress, type BatchCounts } from "@app-lanche/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { Alert, Button, Card, CardBody, CardHeader, Table } from "reactstrap";
import { z } from "zod";
import { ApiError, apiFetch } from "../../app/api";
import { PageTitle } from "../../theme/layout/PageTitle";
import { announce, StatusNotice } from "../../theme/notify";
import { StatusBadge } from "../../theme/StatusBadge";
import { formatInstantDate, formatIsoDate } from "../../ui/dates";
import { BATCH_STATUS_LABELS, BATCH_STATUS_TONES, DOCUMENT_STATUS_LABELS, DOCUMENT_STATUS_TONES } from "./documentLabels";
import { useRequestKey } from "./useRequestKey";
import { useStaffErrors } from "./useStaffErrors";
```

Em `publish`, troque `setStatus("Lote publicado. Os responsáveis serão avisados pelo WhatsApp.");` por:

```tsx
        const message = "Lote publicado. Os responsáveis serão avisados pelo WhatsApp.";
        setStatus(message);
        announce(message);
```

`if (!batch) …` (mesmo padrão das outras páginas):

```tsx
  if (!batch) {
    return (
      <div>
        {error ? (
          <Alert color="danger" fade={false}>
            {error}
          </Alert>
        ) : (
          <p>Carregando…</p>
        )}
      </div>
    );
  }
```

`return` (as linhas `const c = …`, `canPublish` e `nothingToPublish` ficam iguais antes dele):

```tsx
  return (
    <>
      <PageTitle
        heading={`${batch.templateName} — versão ${batch.templateVersion}`}
        icon="pe-7s-news-paper"
        subheading={
          <>
            <StatusBadge tone={BATCH_STATUS_TONES[batch.status]}>{BATCH_STATUS_LABELS[batch.status]}</StatusBadge>{" "}
            Emitido em {formatIsoDate(batch.issuedOn)} · {c.rendered} de {c.total - c.discarded} PDFs prontos
            {c.failed > 0 ? ` · ${c.failed} com falha` : ""}
          </>
        }
        actions={<Link className="btn btn-outline-secondary" to="/admin/documentos">Voltar aos documentos</Link>}
      />
      {rendering && (
        <p role="status">
          <span className="spinner-border spinner-border-sm me-2" aria-hidden="true" />
          Gerando PDFs… Mantenha esta página aberta.
        </p>
      )}
      <StatusNotice message={status} />
      {error && (
        <Alert color="danger" fade={false}>
          {error}
        </Alert>
      )}
      {batch.status !== "published" && batch.unreachable > 0 && (
        <div className="alert alert-warning">{batch.unreachable} documento(s) sem responsável vinculado não serão enviados</div>
      )}
      <Card className="main-card mb-3">
        <CardBody>
          {batch.status === "published" ? (
            <p className="mb-0">
              Publicado em {formatInstantDate(batch.publishedAt!)}. Abriram: {batch.viewers} de {batch.recipients} responsáveis.
            </p>
          ) : nothingToPublish ? (
            <p className="mb-0">Nenhum documento para publicar.</p>
          ) : (
            <Button color="primary" type="button" disabled={!canPublish} onClick={() => void publish()}>
              Publicar e avisar os responsáveis
            </Button>
          )}
        </CardBody>
      </Card>
      <Card className="main-card mb-3">
        <CardHeader tag="h2" className="h6 mb-0">Documentos</CardHeader>
        <CardBody>
          <Table responsive hover striped className="mb-0">
            <thead>
              <tr><th>Aluno</th><th>Turma</th><th>Responsável</th><th>Situação</th><th>Ações</th></tr>
            </thead>
            <tbody>
              {batch.documents.map((d) => (
                <tr key={d.id}>
                  <td>{d.studentFirstName}</td>
                  <td>{d.className}</td>
                  <td>{d.guardianFirstName ?? "Todos"}</td>
                  <td>
                    <StatusBadge tone={d.discarded ? "light" : DOCUMENT_STATUS_TONES[d.status]}>
                      {d.discarded ? "Descartado" : DOCUMENT_STATUS_LABELS[d.status]}
                    </StatusBadge>
                    {d.viewed ? " · aberto" : ""}
                  </td>
                  <td>
                    {d.status === "rendered" && (
                      <Button size="sm" outline color="primary" type="button" aria-label={`Baixar PDF de ${d.studentFirstName}`} onClick={() => void download(d.id)}>
                        Baixar PDF
                      </Button>
                    )}
                    {d.status === "failed" && !d.discarded && batch.status !== "published" && (
                      <Button size="sm" outline color="danger" type="button" aria-label={`Descartar documento de ${d.studentFirstName}`} onClick={() => void discard(d.id)}>
                        Descartar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardBody>
      </Card>
    </>
  );
```

(O `<p role="status">` de geração continua visível: é progresso, não aviso de sucesso. O `span` do spinner não tem texto, então o texto do parágrafo segue igual para o teste.)

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/admin`
Expected: PASS.

- [ ] **Step 5: Verificar e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test`

```bash
git add apps/web/src/areas/admin/GenerateBatch.tsx apps/web/src/areas/admin/BatchPage.tsx apps/web/src/areas/admin/batches.test.tsx
git commit -m "feat(web): theme batch generation and the batch page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 7: KDS — moldura, quadro de cartões, selo e filtros

**Files:**
- Create: `apps/web/src/theme/layout/KdsShell.tsx`
- Create: `apps/web/src/areas/kds/SyncBadge.tsx`, `apps/web/src/areas/kds/filters.ts`
- Modify: `apps/web/src/areas/kds/KdsBoard.tsx`, `apps/web/src/areas/kds/KdsApp.tsx`
- Test: `apps/web/src/areas/kds/SyncBadge.test.tsx`, `apps/web/src/areas/kds/filters.test.ts`

**Interfaces:**
- Consumes: `badgeText` (`areas/kds/badge.ts`, inalterado); `kdsDb`, `markOrder` (`db.ts`); `sync.start`, `sync.unpair`; classes `kds-*` (Task 1); `theme/styles.ts`.
- Produces: `KdsShell({ title, status?, actions?, children })`; `SyncBadge({ pending, lastSyncAt, now })` com `data-testid="kds-badge"`; `type StateFilter = "all" | "pending" | "delivered"`, `type BoardFilter = { className: string | null; state: StateFilter }`, `visibleGroups(groups, delivered, filter)`. `data-testid` mantidos: `kds-badge`, `kds-no-service`, `kds-waiting`, `kds-order-<id>` (com `aria-pressed` e `disabled` iguais), `kds-unpair`.

- [ ] **Step 1: Testes (falham)**

`apps/web/src/areas/kds/filters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { visibleGroups, type ClassGroup } from "./filters";

const [A, B, C] = ["0193a3b0-0000-7000-8000-000000000001", "0193a3b0-0000-7000-8000-000000000002", "0193a3b0-0000-7000-8000-000000000003"];
const GROUPS: ClassGroup[] = [
  {
    class: "Infantil 3A",
    orders: [
      { order_id: A, student: "Léo", items: ["Misto quente"], restrictions: null },
      { order_id: B, student: "Bia", items: ["Suco"], restrictions: "sem lactose" },
    ],
  },
  { class: "Infantil 4B", orders: [{ order_id: C, student: "Caio", items: ["Pão"], restrictions: null }] },
];
const delivered = new Set([A]);
const names = (groups: ClassGroup[]) => groups.map((g) => [g.class, g.orders.map((o) => o.student)]);

describe("visibleGroups", () => {
  it("shows every class and order with the default filter", () => {
    expect(names(visibleGroups(GROUPS, delivered, { className: null, state: "all" }))).toEqual([
      ["Infantil 3A", ["Léo", "Bia"]],
      ["Infantil 4B", ["Caio"]],
    ]);
  });

  it("filters by class", () => {
    expect(names(visibleGroups(GROUPS, delivered, { className: "Infantil 4B", state: "all" }))).toEqual([["Infantil 4B", ["Caio"]]]);
  });

  it("filters by delivery state and hides classes left empty", () => {
    expect(names(visibleGroups(GROUPS, delivered, { className: null, state: "pending" }))).toEqual([
      ["Infantil 3A", ["Bia"]],
      ["Infantil 4B", ["Caio"]],
    ]);
    expect(names(visibleGroups(GROUPS, delivered, { className: null, state: "delivered" }))).toEqual([["Infantil 3A", ["Léo"]]]);
  });
});
```

`apps/web/src/areas/kds/SyncBadge.test.tsx`:

```tsx
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SyncBadge } from "./SyncBadge";

const last = new Date(2031, 10, 5, 10, 7).toISOString();

afterEach(cleanup);

describe("SyncBadge", () => {
  it("is green when everything is synced", () => {
    render(<SyncBadge pending={0} lastSyncAt={last} now={new Date(2031, 10, 5, 10, 8)} />);
    const badge = screen.getByTestId("kds-badge");
    expect(badge.textContent).toBe("0 pendentes · última sincronização 10:07");
    expect(badge.className).toContain("text-bg-success");
  });

  it("is orange while deliveries wait to be sent", () => {
    render(<SyncBadge pending={3} lastSyncAt={last} now={new Date(2031, 10, 5, 10, 8)} />);
    const badge = screen.getByTestId("kds-badge");
    expect(badge.textContent).toBe("3 pendentes · última sincronização 10:07");
    expect(badge.className).toContain("text-bg-warning");
  });

  it("turns red after 2 minutes without sync", () => {
    render(<SyncBadge pending={1} lastSyncAt={last} now={new Date(2031, 10, 5, 10, 9, 1)} />);
    const badge = screen.getByTestId("kds-badge");
    expect(badge.textContent).toBe("1 pendente · última sincronização 10:07 — sem sincronizar");
    expect(badge.className).toContain("text-bg-danger");
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/kds/filters.test.ts src/areas/kds/SyncBadge.test.tsx`
Expected: FAIL (módulos não existem).

- [ ] **Step 2: Filtros e selo**

`apps/web/src/areas/kds/filters.ts`:

```ts
import type { ManifestContent } from "@app-lanche/contracts";

export type ClassGroup = ManifestContent["by_class"][number];
export type StateFilter = "all" | "pending" | "delivered";
export type BoardFilter = { className: string | null; state: StateFilter };

/** Turmas e pedidos que o filtro do quadro deixa à vista; turma sem pedido visível some. Só tela, nenhuma regra. */
export function visibleGroups(groups: ClassGroup[], delivered: ReadonlySet<string>, filter: BoardFilter): ClassGroup[] {
  return groups
    .filter((g) => filter.className === null || g.class === filter.className)
    .map((g) => ({
      ...g,
      orders: g.orders.filter((o) => filter.state === "all" || (filter.state === "delivered") === delivered.has(o.order_id)),
    }))
    .filter((g) => g.orders.length > 0);
}
```

`apps/web/src/areas/kds/SyncBadge.tsx`:

```tsx
import { badgeText } from "./badge";

/** Selo de sincronização (spec 7.4): verde sincronizado, laranja com pendentes, vermelho após 2 min sem sincronizar. */
export function SyncBadge({ pending, lastSyncAt, now }: { pending: number; lastSyncAt: string | null; now: Date }) {
  const badge = badgeText(pending, lastSyncAt, now);
  const tone = badge.stale ? "danger" : pending > 0 ? "warning" : "success";
  return (
    <span data-testid="kds-badge" className={`badge rounded-pill kds-sync-badge text-bg-${tone}`}>
      {badge.stale ? `${badge.text} — sem sincronizar` : badge.text}
    </span>
  );
}
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/kds/filters.test.ts src/areas/kds/SyncBadge.test.tsx`
Expected: PASS.

- [ ] **Step 3: Moldura do tablet**

`apps/web/src/theme/layout/KdsShell.tsx`:

```tsx
import type { ReactNode } from "react";

/** Moldura do tablet da cozinha: barra fina com título, selo e ações; sem menu (spec: tela cheia). */
export function KdsShell({ title, status, actions, children }: { title: ReactNode; status?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="kds-shell">
      <header className="kds-topbar">
        <h1>{title}</h1>
        <div className="kds-topbar__actions">
          {status}
          {actions}
        </div>
      </header>
      <main className="kds-content">{children}</main>
    </div>
  );
}
```

- [ ] **Step 4: Quadro**

`apps/web/src/areas/kds/KdsBoard.tsx` — arquivo completo (consultas Dexie, `sync.start`, relógio, wake lock, `tap` e `unpair` iguais ao atual; o componente continua sem chamar a API):

```tsx
import { useEffect, useState, type ReactNode } from "react";
import { Alert, Button, Nav, NavItem, NavLink } from "reactstrap";
import { KdsShell } from "../../theme/layout/KdsShell";
import { kdsDb, markOrder } from "./db";
import { visibleGroups, type StateFilter } from "./filters";
import { SyncBadge } from "./SyncBadge";
import * as sync from "./sync";
import { useLive } from "./useLive";

const STATE_FILTERS: { value: StateFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "pending", label: "Pendentes" },
  { value: "delivered", label: "Entregues" },
];

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <NavItem>
      <NavLink tag="button" type="button" active={active} aria-pressed={active} onClick={onClick}>
        {children}
      </NavLink>
    </NavItem>
  );
}

export function KdsBoard({ serviceDate, onUnpaired }: { serviceDate: string; onUnpaired: () => void }) {
  const manifest = useLive(() => kdsDb.manifest.get(serviceDate), [serviceDate]);
  const states = useLive(() => kdsDb.orderState.where("serviceDate").equals(serviceDate).toArray(), [serviceDate]);
  const pending = useLive(() => kdsDb.outbox.count(), []);
  const lastSyncAt = useLive(async () => (await kdsDb.meta.get("lastSyncAt"))?.value ?? null, []);
  const noService = useLive(async () => (await kdsDb.meta.get(`noService:${serviceDate}`)) !== undefined, [serviceDate]);
  const [now, setNow] = useState(() => new Date());
  const [message, setMessage] = useState<string | null>(null);
  const [tapFailed, setTapFailed] = useState(false);
  const [classFilter, setClassFilter] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");

  useEffect(() => sync.start(serviceDate), [serviceDate]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    // Spec 7.4: tela acesa enquanto o KDS está aberto. O navegador solta o lock ao ocultar a página.
    type Lock = { release: () => Promise<void>; addEventListener: (t: "release", fn: () => void) => void };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Lock> } };
    let lock: Lock | null = null;
    let cancelled = false;
    let requesting = false;
    function acquire() {
      if (!nav.wakeLock || lock || requesting || cancelled) return;
      requesting = true;
      nav.wakeLock.request("screen").then(
        (l) => {
          requesting = false;
          if (cancelled) {
            void l.release().catch(() => undefined);
            return;
          }
          lock = l;
          l.addEventListener("release", () => {
            if (lock === l) lock = null;
          });
        },
        () => {
          requesting = false;
        },
      );
    }
    function onVisible() {
      if (document.visibilityState === "visible") acquire();
    }
    document.addEventListener("visibilitychange", onVisible);
    acquire();
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void lock?.release().catch(() => undefined);
      lock = null;
    };
  }, []);
  useEffect(() => {
    if ((pending ?? 0) === 0) setMessage(null);
  }, [pending]);

  const delivered = new Set((states ?? []).filter((s) => s.state === "delivered").map((s) => s.orderId));
  const closed = manifest?.status === "closed";
  const classes = manifest?.content.by_class.map((c) => c.class) ?? [];
  const groups = manifest ? visibleGroups(manifest.content.by_class, delivered, { className: classFilter, state: stateFilter }) : [];

  async function tap(orderId: string, delivered: boolean) {
    try {
      await markOrder(orderId, serviceDate, delivered);
      setTapFailed(false);
    } catch (err) {
      console.warn("kds mark failed", err instanceof Error ? err.name : "unknown");
      setTapFailed(true);
    }
  }

  async function unpair() {
    if (!(await sync.unpair())) {
      setMessage("Há entregas ainda não sincronizadas. Conecte o tablet à internet e aguarde antes de desparear.");
      return;
    }
    onUnpaired();
  }

  return (
    <KdsShell
      title={`Cozinha — ${serviceDate.split("-").reverse().join("/")}`}
      status={<SyncBadge pending={pending ?? 0} lastSyncAt={lastSyncAt ?? null} now={now} />}
      actions={
        <Button data-testid="kds-unpair" color="light" type="button" onClick={() => void unpair()}>
          Desparear este tablet
        </Button>
      }
    >
      {message && (
        <Alert color="danger" fade={false}>
          {message}
        </Alert>
      )}
      {tapFailed && (
        <Alert color="danger" fade={false}>
          Não foi possível registrar a entrega neste tablet. Tente de novo.
        </Alert>
      )}
      {!manifest && noService && (
        <div className="alert alert-secondary" data-testid="kds-no-service">
          Não há serviço de lanche nesta data.
        </div>
      )}
      {!manifest && !noService && <div className="alert alert-secondary">Carregando o romaneio… Conecte o tablet à internet na primeira vez.</div>}
      {manifest && !closed && (
        <div className="alert alert-warning" data-testid="kds-waiting">
          Prévia parcial — aguardando fechamento. As entregas podem ser marcadas depois do fechamento.
        </div>
      )}
      {manifest && (
        <>
          <p className="fs-5 fw-semibold mb-3">
            {manifest.content.totals.orders} pedidos ·{" "}
            {manifest.content.totals.by_item.map((i) => `${i.qty}x ${i.item}`).join(" · ")}
          </p>
          <div className="kds-filters">
            <div role="group" aria-label="Filtrar por turma">
              <Nav pills>
                <FilterPill active={classFilter === null} onClick={() => setClassFilter(null)}>
                  Todas as turmas
                </FilterPill>
                {classes.map((c) => (
                  <FilterPill key={c} active={classFilter === c} onClick={() => setClassFilter(c)}>
                    {c}
                  </FilterPill>
                ))}
              </Nav>
            </div>
            <div role="group" aria-label="Filtrar por entrega">
              <Nav pills>
                {STATE_FILTERS.map((f) => (
                  <FilterPill key={f.value} active={stateFilter === f.value} onClick={() => setStateFilter(f.value)}>
                    {f.label}
                  </FilterPill>
                ))}
              </Nav>
            </div>
          </div>
          {groups.length === 0 && <p>Nenhum pedido neste filtro.</p>}
          {groups.map((c) => (
            <section key={c.class}>
              <h2 className="kds-class-title">{c.class}</h2>
              <ul className="kds-grid">
                {c.orders.map((o) => {
                  const isDelivered = delivered.has(o.order_id);
                  return (
                    <li key={o.order_id}>
                      <button
                        type="button"
                        className={isDelivered ? "kds-card is-delivered" : "kds-card"}
                        data-testid={`kds-order-${o.order_id}`}
                        aria-pressed={isDelivered}
                        disabled={!closed}
                        onClick={() => void tap(o.order_id, !isDelivered)}
                      >
                        <span className="kds-card__name">{o.student}</span>
                        <span className="kds-card__class">{c.class}</span>
                        <span>{o.items.join(", ")}</span>
                        {o.restrictions && <span className="badge text-bg-warning">Restrição: {o.restrictions}</span>}
                        <span className="kds-card__state">{isDelivered ? "✓ Entregue" : "Pendente"}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </KdsShell>
  );
}
```

`apps/web/src/areas/kds/KdsApp.tsx` — acrescente `import "../../theme/styles";` logo depois do import de `react-router` (o resto fica igual nesta task).

- [ ] **Step 5: e2e do KDS**

Run: `pnpm db:up && pnpm test:e2e; docker compose down`
Expected: os 2 testes passam (seletores por `data-testid`; o único `role="alert"` depois de "Desparear" com outbox pendente é a mensagem de entregas não sincronizadas).

- [ ] **Step 6: Verificar e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test`

```bash
git add apps/web/src/theme/layout/KdsShell.tsx apps/web/src/areas/kds/SyncBadge.tsx apps/web/src/areas/kds/SyncBadge.test.tsx \
  apps/web/src/areas/kds/filters.ts apps/web/src/areas/kds/filters.test.ts apps/web/src/areas/kds/KdsBoard.tsx apps/web/src/areas/kds/KdsApp.tsx
git commit -m "feat(kds): full-screen themed board with touch cards, sync badge and filters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 8: KDS — telas de pareamento e de tablet desconectado

**Files:**
- Modify: `apps/web/src/areas/kds/KdsPair.tsx`, `apps/web/src/areas/kds/KdsApp.tsx`
- Test: `apps/web/src/areas/kds/KdsPair.test.tsx`

**Interfaces:**
- Consumes: `sync.pair(code): Promise<string>`; `ApiError`; `LOGO_URL`, `LOGO_ALT`, `PRODUCT_NAME` (Task 1).
- Produces: `KdsPair({ onPaired, disconnected = false }: { onPaired: () => void; disconnected?: boolean })`; `data-testid` `kds-pair-code` e `kds-pair-submit` mantidos.

- [ ] **Step 1: Testes (falham)**

`apps/web/src/areas/kds/KdsPair.test.tsx`:

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../app/api";
import { LOGO_ALT } from "../../theme/brand";
import { KdsPair } from "./KdsPair";
import * as sync from "./sync";

vi.mock("./sync", () => ({ pair: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(sync.pair).mockReset();
});

const typeCode = (value: string) => fireEvent.change(screen.getByLabelText("Código de pareamento"), { target: { value } });

describe("KdsPair", () => {
  it("shows the school logo and allows pairing only with 8 characters", () => {
    render(<KdsPair onPaired={vi.fn()} />);
    expect(screen.getByRole("img", { name: LOGO_ALT })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Parear tablet da cozinha" })).toBeTruthy();
    typeCode("abcd234");
    expect((screen.getByRole("button", { name: "Parear" }) as HTMLButtonElement).disabled).toBe(true);
    typeCode("abcd2345");
    expect((screen.getByRole("button", { name: "Parear" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("pairs with the typed code", async () => {
    vi.mocked(sync.pair).mockResolvedValue("0193a3b0-0000-7000-8000-0000000000d1");
    const onPaired = vi.fn();
    render(<KdsPair onPaired={onPaired} />);
    typeCode("abcd2345");
    fireEvent.click(screen.getByRole("button", { name: "Parear" }));
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(sync.pair).toHaveBeenCalledWith("abcd2345");
  });

  it("asks for a new code when the code is wrong or expired", async () => {
    vi.mocked(sync.pair).mockRejectedValue(new ApiError(400, "invalid_pairing_code"));
    render(<KdsPair onPaired={vi.fn()} />);
    typeCode("abcd2345");
    fireEvent.click(screen.getByRole("button", { name: "Parear" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Código inválido ou vencido. Peça um novo código à secretaria.");
  });

  it("explains that pairing needs internet", async () => {
    vi.mocked(sync.pair).mockRejectedValue(new ApiError(0, "network_error"));
    render(<KdsPair onPaired={vi.fn()} />);
    typeCode("abcd2345");
    fireEvent.click(screen.getByRole("button", { name: "Parear" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sem conexão. O pareamento precisa de internet.");
  });

  it("tells a disconnected tablet to ask for a new code", () => {
    render(<KdsPair onPaired={vi.fn()} disconnected />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Este tablet foi desconectado. Peça um novo código à secretaria; as entregas ainda não enviadas serão mantidas.",
    );
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/kds/KdsPair.test.tsx`
Expected: FAIL (sem logo, sem rótulo associado por `for`, sem prop `disconnected`).

- [ ] **Step 2: Pareamento**

`apps/web/src/areas/kds/KdsPair.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, CardBody, Form, FormGroup, Input, Label } from "reactstrap";
import { ApiError } from "../../app/api";
import { LOGO_ALT, LOGO_URL, PRODUCT_NAME } from "../../theme/brand";
import * as sync from "./sync";

export function KdsPair({ onPaired, disconnected = false }: { onPaired: () => void; disconnected?: boolean }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sync.pair(code);
      onPaired();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 0
          ? "Sem conexão. O pareamento precisa de internet."
          : "Código inválido ou vencido. Peça um novo código à secretaria.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="kds-pair">
      <Card className="main-card">
        <CardBody className="p-4">
          <img className="kds-pair__logo" src={LOGO_URL} alt={LOGO_ALT} />
          <h1 className="h4 text-center mb-1">Parear tablet da cozinha</h1>
          <p className="text-center mb-4">{PRODUCT_NAME}</p>
          {disconnected && (
            <Alert color="warning" fade={false}>
              Este tablet foi desconectado. Peça um novo código à secretaria; as entregas ainda não enviadas serão mantidas.
            </Alert>
          )}
          <Form onSubmit={submit}>
            <FormGroup>
              <Label for="kds-pair-code">Código de pareamento</Label>
              <Input
                id="kds-pair-code"
                data-testid="kds-pair-code"
                className="kds-pair__code"
                bsSize="lg"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoCapitalize="characters"
                maxLength={8}
              />
            </FormGroup>
            <Button data-testid="kds-pair-submit" color="primary" size="lg" type="submit" className="w-100" disabled={busy || code.trim().length !== 8}>
              Parear
            </Button>
          </Form>
          {error && (
            <Alert color="danger" fade={false} className="mt-3 mb-0">
              {error}
            </Alert>
          )}
        </CardBody>
      </Card>
    </main>
  );
}
```

`apps/web/src/areas/kds/KdsApp.tsx` — arquivo completo:

```tsx
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
```

- [ ] **Step 3: Rodar e ver passar**

Run: `pnpm --filter @app-lanche/web exec vitest run src/areas/kds`
Expected: PASS.

Run: `pnpm db:up && pnpm test:e2e; docker compose down`
Expected: PASS (o e2e preenche `kds-pair-code` e clica `kds-pair-submit`).

- [ ] **Step 4: Verificar e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test`

```bash
git add apps/web/src/areas/kds/KdsPair.tsx apps/web/src/areas/kds/KdsPair.test.tsx apps/web/src/areas/kds/KdsApp.tsx
git commit -m "feat(kds): themed pairing and disconnected-tablet screens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 9: CSS base dos responsáveis, guarda do pacote e PWA offline

**Files:**
- Create: `apps/web/build/guardianCss.ts`, `apps/web/build/guardianCss.test.ts`
- Modify: `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/main.tsx`
- Create: `apps/web/public/icons/icon-192.png`, `apps/web/public/icons/icon-512.png`
- Modify: `docs/superpowers/specs/2026-11-19-ui-architectui-design.md` (bullet "Offline do tablet")

**Interfaces:**
- Consumes: `theme/base.scss` (Task 1); `AdminArea` e `KdsApp` já `lazy` (Tasks 3 e 7).
- Produces: `THEME_MARKERS: string[]`, `entryStylesheets(html: string): string[]`, `guardianCssProblems(html: string, cssFiles: Record<string, string>): string[]`, `guardianCssGuard(): Plugin` (`apps/web/build/guardianCss.ts`); manifesto com ícones 192/512 e `theme_color: "#047c37"`; precache com `woff`, `woff2`, `ttf`, `svg`, `png`, `jpg`.

- [ ] **Step 1: Teste da guarda (falha)**

`apps/web/build/guardianCss.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { entryStylesheets, guardianCssProblems } from "./guardianCss";

const HTML =
  '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-a.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index-a.css"></head><body></body></html>';

describe("guardian css guard", () => {
  it("finds the stylesheets index.html loads up front", () => {
    expect(entryStylesheets(HTML)).toEqual(["/assets/index-a.css"]);
  });

  it("accepts a guardian entry without the theme layout", () => {
    expect(guardianCssProblems(HTML, { "assets/index-a.css": "body{margin:0}", "assets/AdminArea-b.css": ".app-sidebar{width:280px}" })).toEqual([]);
  });

  it("flags theme layout in the guardian entry", () => {
    expect(guardianCssProblems(HTML, { "assets/index-a.css": ".app-sidebar{}.app-header{}", "assets/x.css": ".app-sidebar{}" })).toEqual([
      "/assets/index-a.css contém .app-sidebar",
      "/assets/index-a.css contém .app-header",
    ]);
  });

  it("flags a build without the theme", () => {
    expect(guardianCssProblems(HTML, { "assets/index-a.css": "body{}" })).toEqual(["o CSS do tema não foi gerado"]);
  });
});
```

Run: `pnpm --filter @app-lanche/web exec vitest run build/guardianCss.test.ts`
Expected: FAIL (módulo não existe).

- [ ] **Step 2: Guarda**

`apps/web/build/guardianCss.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/** Marcadores do layout do tema: nenhum pode estar no CSS que index.html carrega (pacote dos responsáveis). */
export const THEME_MARKERS = [".app-sidebar", ".app-header", ".metismenu", ".kds-", "pe-7s-"];

/** Hrefs das folhas que index.html carrega de cara. */
export function entryStylesheets(html: string): string[] {
  return [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]
    .map((m) => /\bhref="([^"]+)"/.exec(m[0])?.[1])
    .filter((href): href is string => href !== undefined);
}

/** Problemas: marcador do tema numa folha de entrada, ou tema ausente de todo o build. `cssFiles` usa caminhos relativos a dist. */
export function guardianCssProblems(html: string, cssFiles: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const href of entryStylesheets(html)) {
    const css = cssFiles[href.replace(/^\//, "")] ?? "";
    for (const marker of THEME_MARKERS) if (css.includes(marker)) problems.push(`${href} contém ${marker}`);
  }
  if (!Object.values(cssFiles).some((css) => css.includes(".app-sidebar"))) problems.push("o CSS do tema não foi gerado");
  return problems;
}

/** Falha o build se o tema do admin/KDS vazar para o CSS inicial (spec 2026-11-19, "Carregamento"). */
export function guardianCssGuard(): Plugin {
  let outDir = "dist";
  return {
    name: "app-lanche:guardian-css-guard",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const assets = join(outDir, "assets");
      const cssFiles = Object.fromEntries(
        readdirSync(assets)
          .filter((f) => f.endsWith(".css"))
          .map((f) => [`assets/${f}`, readFileSync(join(assets, f), "utf8")]),
      );
      const problems = guardianCssProblems(html, cssFiles);
      if (problems.length > 0) throw new Error(`CSS do tema no pacote dos responsáveis: ${problems.join("; ")}`);
    },
  };
}
```

Run: `pnpm --filter @app-lanche/web exec vitest run build/guardianCss.test.ts`
Expected: PASS.

- [ ] **Step 3: CSS base na entrada**

`apps/web/src/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./app/App";
import "./theme/base.scss";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 4: Ícones da PWA a partir do logo (uma vez)**

Script temporário na raiz (resolve `@playwright/test` da raiz), executado e apagado em seguida — não é commitado:

```bash
mkdir -p apps/web/public/icons
cat > .tmp-make-icons.mjs <<'EOF'
// One-off: gera os ícones PWA a partir do logo com o Chromium do Playwright (sem dependência nova).
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const [logo, outDir] = process.argv.slice(2);
const src = `data:image/jpeg;base64,${readFileSync(logo).toString("base64")}`;
const browser = await chromium.launch();
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<html><body style="margin:0;background:#fff"><img src="${src}" style="display:block;width:${size}px;height:${size}px"></body></html>`);
    await page.locator("img").evaluate((img) => img.decode());
    await page.screenshot({ path: `${outDir}/icon-${size}.png`, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
  }
} finally {
  await browser.close();
}
EOF
node .tmp-make-icons.mjs apps/web/src/theme/brand/logo.jpg apps/web/public/icons
rm .tmp-make-icons.mjs
file apps/web/public/icons/*.png   # PNG 192 x 192 e 512 x 512
```

Abra os dois PNGs (Read) e confira que mostram o selo inteiro, centralizado, sobre branco.

- [ ] **Step 5: Manifesto, precache e HTML**

`apps/web/vite.config.ts` — arquivo completo:

```ts
/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { guardianCssGuard } from "./build/guardianCss";
import { SASS_SILENCED } from "./build/sass";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "App Lanche",
        short_name: "Lanche",
        lang: "pt-BR",
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        // $primary de src/theme/_brand.scss (o manifesto não lê SCSS).
        theme_color: "#047c37",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        // O tablet abre offline: fontes de ícone, CSS do tema, logo e ícones entram no precache.
        globPatterns: ["**/*.{js,css,html,woff,woff2,ttf,svg,png,jpg}"],
      },
    }),
    guardianCssGuard(),
  ],
  css: { preprocessorOptions: { scss: { quietDeps: true, silenceDeprecations: SASS_SILENCED } } },
  server: { proxy: { "/api": "http://localhost:8080" } },
  test: { environment: "jsdom" },
});
```

`apps/web/index.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <!-- $primary de src/theme/_brand.scss -->
    <meta name="theme-color" content="#047c37" />
    <link rel="icon" type="image/png" href="/icons/icon-192.png" />
    <link rel="apple-touch-icon" href="/icons/icon-192.png" />
    <title>App Lanche</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 6: Build e conferências**

Run: `pnpm --filter @app-lanche/web build`
Expected: build passa (a guarda roda no fim; se falhar, a mensagem diz qual folha de entrada contém qual marcador — algum módulo não `lazy` importou o tema).

Run: `grep -o 'Pe-icon-7-stroke[^"]*\.\(woff\|ttf\|svg\)' apps/web/dist/sw.js | sort -u`
Expected: uma entrada `woff`, uma `ttf` e uma `svg`.

Run: `grep -c 'icons/icon-512.png' apps/web/dist/sw.js` e `grep -o 'logo-[^"]*\.jpg' apps/web/dist/sw.js | head -1`
Expected: o ícone e o logo estão no precache.

- [ ] **Step 7: Spec — offline e ícones**

No fim do bullet `- **Offline do tablet**: …` de `docs/superpowers/specs/2026-11-19-ui-architectui-design.md`, acrescente: ` O pacote pe7-icon não tem woff2; o precache leva também `png` e `jpg` (logo e ícones). O manifesto usa ícones 192/512 px gerados do logo e `theme_color` `#047c37`. Um plugin de build (`apps/web/build/guardianCss.ts`) falha o build se o CSS carregado por `index.html` contiver o layout do tema.`

- [ ] **Step 8: Verificar e commitar**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @app-lanche/web test`

```bash
git add apps/web/build/guardianCss.ts apps/web/build/guardianCss.test.ts apps/web/vite.config.ts apps/web/index.html \
  apps/web/src/main.tsx apps/web/public/icons/icon-192.png apps/web/public/icons/icon-512.png \
  docs/superpowers/specs/2026-11-19-ui-architectui-design.md
git commit -m "feat(web): guardian base CSS, theme leak guard and offline PWA assets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01K86CbkJPwmS7fPKomVgzip"
```

---

### Task 10: Verificação final

**Files:** nenhum arquivo do repositório (scripts temporários só no scratchpad ou apagados).

- [ ] **Step 1: Suite completa com o compose desligado**

```bash
pnpm app:down; docker compose down
pnpm typecheck && pnpm lint && pnpm test
```

Expected: tudo passa (API com Testcontainers, contratos, web).

- [ ] **Step 2: Builds**

```bash
pnpm --filter @app-lanche/api build && pnpm --filter @app-lanche/web build
```

Expected: os dois passam; o build da web termina sem erro da guarda `app-lanche:guardian-css-guard`.

- [ ] **Step 3: e2e do KDS**

```bash
pnpm db:up && pnpm test:e2e; docker compose down
```

Expected: 2 testes passam.

- [ ] **Step 4: App no Docker e capturas de tela**

```bash
pnpm app:up
```

Script temporário (fica no scratchpad; uma cópia é rodada da raiz para achar `@playwright/test` e apagada em seguida). `SHOTS` = `/tmp/claude-1000/-home-tgfarias-caminhodosaber-app-lanche/713e9489-0a0d-4e15-bcf5-72857cfa2c39/scratchpad/shots` (ou o scratchpad da sessão que executa):

```js
// .tmp-shots.mjs — capturas do admin e do KDS em http://localhost:8088 e conferência do CSS dos responsáveis.
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";

const BASE = "http://localhost:8088";
const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  // Responsáveis: nenhum CSS carregado em "/" pode conter o layout do tema.
  const guest = await browser.newPage();
  const css = [];
  guest.on("response", async (r) => {
    if (r.url().endsWith(".css")) css.push(await r.text());
  });
  await guest.goto(`${BASE}/`);
  await guest.waitForLoadState("networkidle");
  if (css.some((c) => c.includes(".app-sidebar"))) throw new Error("tema carregado na página dos responsáveis");
  await guest.screenshot({ path: `${OUT}/guardian-home.png` });

  // Admin em desktop: login com o código da outbox.
  const admin = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await admin.goto(`${BASE}/admin/login`);
  await admin.screenshot({ path: `${OUT}/admin-login.png` });
  await admin.getByLabel("E-mail").fill("admin@escola.local");
  await admin.getByRole("button", { name: "Enviar código" }).click();
  await admin.getByLabel("Código de 6 dígitos").waitFor();
  const code = execSync("pnpm -s app:otp").toString().trim();
  await admin.getByLabel("Código de 6 dígitos").fill(code);
  await admin.getByRole("button", { name: "Entrar" }).click();
  await admin.getByRole("navigation", { name: "Menu principal" }).waitFor();
  await admin.screenshot({ path: `${OUT}/admin-home.png`, fullPage: true });
  for (const [name, path] of [["cardapio", "/admin#cardapio"], ["alunos", "/admin/alunos"], ["documentos", "/admin/documentos"]]) {
    await admin.goto(`${BASE}${path}`);
    await admin.waitForLoadState("networkidle");
    await admin.screenshot({ path: `${OUT}/admin-${name}.png`, fullPage: true });
  }
  // Código de pareamento para o tablet.
  await admin.goto(`${BASE}/admin#tablets`);
  await admin.getByRole("button", { name: "Gerar código de pareamento" }).click();
  const pairing = (await admin.locator("#tablets strong").first().textContent()).trim();
  await admin.screenshot({ path: `${OUT}/admin-tablets.png`, fullPage: true });

  // Admin no celular: gaveta do menu.
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.goto(`${BASE}/admin`);
  await admin.getByRole("button", { name: "Abrir menu" }).click();
  await admin.screenshot({ path: `${OUT}/admin-mobile-menu.png` });

  // KDS em tablet, paisagem e retrato.
  const kds = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await kds.goto(`${BASE}/kds`);
  await kds.getByTestId("kds-pair-code").waitFor();
  await kds.screenshot({ path: `${OUT}/kds-pair.png` });
  await kds.getByTestId("kds-pair-code").fill(pairing);
  await kds.getByTestId("kds-pair-submit").click();
  await kds.getByTestId("kds-badge").waitFor();
  await kds.waitForTimeout(3000);
  await kds.screenshot({ path: `${OUT}/kds-board-landscape.png`, fullPage: true });
  await kds.setViewportSize({ width: 768, height: 1024 });
  await kds.screenshot({ path: `${OUT}/kds-board-portrait.png`, fullPage: true });
} finally {
  await browser.close();
}
```

Salve o script como `.tmp-shots.mjs` na raiz do repositório e rode:

```bash
node .tmp-shots.mjs "$SHOTS"; rm -f .tmp-shots.mjs
```

Abra cada PNG (Read) e confira: cabeçalho verde com o logo num círculo branco e "App Lanche"; nome da escola, e-mail, papel e "Sair"; item do menu da página atual destacado em verde-claro com texto verde-escuro; cartões, tabelas e selos legíveis; gaveta do menu no celular; pareamento do KDS com o logo; quadro do KDS com cartões grandes, selo de sincronização e pílulas, sem rolagem horizontal em 1024×768 e 768×1024. Se a escola de demonstração não tiver dia de serviço para hoje, o quadro mostra "Não há serviço de lanche nesta data." — abra um dia em "Dias de serviço" e repita se quiser ver os cartões.

```bash
pnpm app:down
```

- [ ] **Step 5: Conferências finais**

- `git status --short` mostra só `?? prompt.txt` (nada de `.tmp-*`, `dist/`, `test-results/`).
- `grep -rn "theme/styles\|theme/layout\|theme.scss" apps/web/src/areas/guardian apps/web/src/main.tsx` não encontra nada.
- `grep -rln "Origem: ArchitectUI" apps/web/src/theme/scss | wc -l` = 19 e `apps/web/src/theme/LICENSE-ArchitectUI.txt` existe.
- `grep -rn "Badge\b" apps/web/src --include=*.tsx | grep "from \"reactstrap\""` não encontra nada; `grep -rn "Modal\|Dropdown\|Tooltip\|Collapse\|Offcanvas" apps/web/src --include=*.tsx | grep reactstrap` também não.
- `pnpm --filter @app-lanche/web exec vite build` não imprime avisos de depreciação do Sass.
