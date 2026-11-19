# Interface: tema ArchitectUI no admin e no tablet

Data: 2026-11-19. Complementa `2026-11-16-app-lanche-design.md` (a spec principal continua autoritativa para regras de negócio; este documento só trata de aparência e estrutura de telas).

## Decisões do usuário (2026-11-19)

- Fonte: ArchitectUI React Theme Free (https://github.com/DashboardPack/architectui-react-theme-free, licença MIT, v4.9.3). React 19, Vite, react-router 8, Bootstrap 5, reactstrap, SCSS — mesma base do nosso `apps/web`.
- Escopo: **área admin** (layout completo) e **KDS do tablet** (mesmo visual, tela cheia, sem menu). A **área dos responsáveis** fica simples: só o CSS base do Bootstrap (reboot, tipografia, formulários, botões), sem o layout do tema.
- Dependências autorizadas (`apps/web`): `bootstrap@^5.3.9`, `reactstrap@^9.2.3`, `pe7-icon@^1.0.4`, `react-toastify@^11.2.0`; devDependency `sass@^1.108.2`. Nenhuma outra (sem Redux, gráficos, mapas, calendário, perfect-scrollbar, font-awesome).
- Cores e logo (recebidos em 2026-11-19): paleta do logo do Centro Educacional Caminho do Saber — laranja `#dc9d3f`, menta `#94e4b4`, verde-escuro `#047c37`, verde-médio `#6eaa89`, verde-claro `#acd5bf`. Em `apps/web/src/theme/_brand.scss`: primária `#047c37`, alerta/destaque `#dc9d3f`, sucesso `#6eaa89`, informação `#94e4b4` (texto escuro), `#acd5bf` para fundos claros (item ativo e hover do menu, com texto `#035d29`, porque `#047c37` sobre ele dá só 3,3:1); perigo continua o padrão do Bootstrap. Cabeçalho verde-escuro com texto branco; menu claro. Todo par texto/fundo atende WCAG AA, e o arquivo lista os pares proibidos (por exemplo, branco sobre `#94e4b4` ou `#acd5bf`). Logo em `apps/web/src/theme/brand/logo.jpg` e nome do produto em `apps/web/src/theme/brand.ts`, mostrado no cabeçalho do admin (num círculo branco), no login do admin e no pareamento do KDS. É a marca da escola piloto embutida no app; logo por escola fica para depois.

## Como o tema entra no projeto

- **Só o esqueleto, convertido para TypeScript** em `apps/web/src/theme/`:
  - `scss/` — subconjunto do SCSS do tema necessário para layout (header, sidebar, main, page title), elementos (cards, tabelas, formulários, botões, badges, navs) e utilitários usados; o resto não é copiado.
  - `layout/` — `AppShell` (header + sidebar + área principal), `AppHeader` (logo, botão hambúrguer, caixa do usuário com papel e "Sair"), `AppSidebar` (menu vertical com ícones pe7), `PageTitle` (título, subtítulo, ícone, ações), `KdsShell` (barra superior fina para o tablet, sem menu).
  - Estado do layout (menu recolhido, menu móvel aberto) em um contexto React com `localStorage` (try/catch), substituindo o Redux `ThemeOptions` do tema.
  - `LICENSE-ArchitectUI.txt` com o texto MIT original e o aviso de copyright, e um cabeçalho de origem nos arquivos copiados.
- **Carregamento**: o SCSS do tema e o layout só são importados pelos módulos do admin e do KDS (chunks carregados sob demanda); a área dos responsáveis importa apenas o CSS base do Bootstrap. As rotas do admin passam a ser `lazy`, como a do KDS.
- **Offline do tablet**: fontes de ícone e CSS empacotados localmente pelo Vite e incluídos no precache do service worker (`globPatterns` com `woff`, `woff2`, `ttf`, `svg`); nenhum recurso de CDN.

## Admin

- Menu lateral: Início · Alunos e responsáveis · Cardápio · Dias de serviço · Documentos · Tablets da cozinha. O item da página atual fica destacado; em telas estreitas o menu vira gaveta (hambúrguer). Cardápio, Dias de serviço e Tablets da cozinha continuam seções da página inicial; o menu aponta para elas por âncora (`/admin#cardapio`, `/admin#dias`, `/admin#tablets`). Fora "Início", os itens só aparecem para `admin` e `secretaria`.
- Cabeçalho: nome da escola (de `/api/admin/v1/me`), e-mail e papel do usuário, botão "Sair". Não havia logout e o cookie é `HttpOnly`: foi criada `POST /api/admin/v1/auth/logout` (pública, 204, sem `Idempotency-Key`), que regrava `__session` vazio com `Max-Age=0`; a sessão é um token sem estado, que vence sozinho em 8 h.
- Cada página: `PageTitle` com título e ação principal; conteúdo em `Card`s; listas em `Table` responsiva (`hover`, `striped`); formulários com `Form`/`FormGroup`/`Label`/`Input`, mensagens de erro em `Alert color="danger"` com `role="alert"`, estados vazios e de carregamento visíveis.
- Avisos de sucesso ("Dados salvos.", "Lote publicado.", "Modelo salvo.") viram toasts do `react-toastify` **e** continuam anunciados para leitores de tela (`role="status"`); erros continuam dentro da página.
- Status como `Badge` (lote: gerando/pronto/publicado; documento: pendente/gerado/falhou/descartado; dia: aberto/fechado).
- Login do admin: página de login no estilo do tema (cartão central), sem o shell.
- Comportamento, rotas, textos de negócio, chaves de idempotência e chamadas à API **não mudam**; os testes existentes continuam válidos (ajustes só de seletor quando a estrutura de DOM mudar, nunca afrouxando o que o teste prova).

## KDS (tablet)

- `KdsShell`: barra superior com o nome do serviço, data, selo de sincronização ("N pendentes · última sincronização HH:MM", vermelho após 2 min) como `Badge`, e o botão de desparear.
- Quadro em grade de cartões grandes (toque fácil): por aluno, nome, turma, itens e restrição; botão de entrega grande com estado claro (entregue/pendente) e cor; filtros por turma e por estado como `Nav` em pílulas. Funciona em retrato e paisagem de tablet (768–1280 px).
- Telas de pareamento e de "peça um novo código" no estilo do tema.
- Regras 32–36 do CLAUDE.md continuam valendo: os componentes do KDS não chamam a API; só o módulo `sync`.
- O teste Playwright offline continua passando (ajustes de seletor permitidos, mesma prova).

## Responsáveis

- Só o CSS base do Bootstrap; sem mudança de estrutura nem de comportamento.

## Fora do escopo

- Tema escuro, troca de tema em tempo de execução, páginas de demonstração, gráficos e dashboards com métricas (relatórios gerenciais estão fora do escopo do produto).
