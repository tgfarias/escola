# App Lanche

SaaS multi-tenant para escolas infantis: pedidos de lanche com Pix, romaneio e KDS offline para a cozinha, e geração de documentos em PDF para os responsáveis.

A spec completa está em `docs/superpowers/specs/2026-11-16-app-lanche-design.md`. Leia a seção correspondente antes de mexer em um módulo. Em caso de conflito entre este arquivo e a spec, pare e pergunte.

## Stack

- Monorepo pnpm. TypeScript estrito em tudo.
- `apps/api`: Node + Fastify em Cloud Run. Kysely sobre `pg`. PostgreSQL (Cloud SQL).
- `apps/web`: PWA React + Vite + vite-plugin-pwa, no Firebase Hosting. Dexie para IndexedDB.
- `packages/contracts`: schemas zod de todas as rotas e eventos.
- `db/migrations`: SQL puro numerado.
- `n8n/workflows`: fluxos exportados. O n8n roda em VPS externa e fala com a API por REST + HMAC.
- Testes: Vitest; integração com PostgreSQL real via Testcontainers; Playwright para o KDS.

## Comandos

Os scripts abaixo são criados na fase F0; se algum não existir ainda, crie-o em vez de inventar outro nome.

```
pnpm install
pnpm dev            # api + web em modo desenvolvimento
pnpm test           # todos os testes
pnpm test:api       # só a API (sobe Postgres em container)
pnpm test:e2e       # Playwright
pnpm typecheck
pnpm lint
pnpm db:migrate     # aplica migrações
pnpm db:types       # regenera os tipos Kysely a partir do banco
```

## Estrutura

```
apps/api/src/db/          pool, withTenant, tipos
apps/api/src/platform/    auth, hmac, idempotency, outbox, errors, logger
apps/api/src/modules/<m>/ routes.ts · service.ts · repo.ts · *.test.ts
apps/web/src/areas/       guardian · kds · admin
packages/contracts/src/   um arquivo por recurso
db/migrations/            NNNN_descricao.sql
```

- `routes.ts` valida com o schema de `contracts`, chama o `service` e devolve. Sem regra de negócio.
- `service.ts` contém as regras e recebe a transação como parâmetro.
- `repo.ts` é o único lugar com SQL.
- Um módulo só usa outro pelo `service.ts` dele.

## Regras invioláveis

### Multi-tenant

1. Todo acesso ao banco acontece dentro de `withTenant(schoolId, async (trx) => …)`. Não use o pool diretamente fora de `apps/api/src/db`.
2. `school_id` vem da sessão, de uma função `resolve_*` (magic link, pareamento, e-mail de equipe) ou do caminho de uma rota autenticada por segredo (rotas internas com HMAC, webhook do gateway com o token da escola). Nunca do corpo, da query string ou de um header enviado pelo navegador.
3. Toda tabela nova tem `school_id uuid NOT NULL`, política RLS, `UNIQUE (school_id, id)` e FKs compostas `(school_id, …)`. A migração que cria a tabela cria a política.
4. Toda tabela nova ganha um caso no teste de RLS (tenant A não vê tenant B).
5. Não use nem crie papel de banco com `BYPASSRLS` para a aplicação. As únicas consultas sem tenant são as quatro funções `SECURITY DEFINER` listadas na spec (seção 4.4); não crie outras sem perguntar.

### Dinheiro

6. Valores em centavos inteiros (`bigint` no banco, `number` inteiro ou `bigint` no código, sufixo `_cents` / `Cents`). Nunca `float`, nunca `toFixed` para cálculo.
7. Preço e total são sempre calculados no servidor. O cliente envia só itens e quantidades.
8. `wallet_entries` é append-only: corrija com um novo lançamento, nunca com `UPDATE` ou `DELETE`.
9. Todo lançamento na carteira trava a linha de `wallets` com `FOR UPDATE` na mesma transação.
10. Pagamento só é confirmado por `confirmPayment`. Webhook e conciliação chamam essa mesma função; não duplique a lógica.

### Idempotência e estados

11. Todo `POST` que cria ou altera estado aceita `Idempotency-Key` e usa o helper de `platform/idempotency`.
12. Transição de estado é `UPDATE … WHERE status = '<anterior>'`. Zero linhas afetadas significa "já feito": termine sem erro e sem efeito colateral.
13. Deduplicação é por constraint `UNIQUE` + `ON CONFLICT DO NOTHING`, não por `SELECT` seguido de `INSERT`.
14. Webhook de pagamento: gravar o evento bruto, processar na mesma transação, responder 200. Evento repetido responde 200 sem processar.

### Horário de corte

15. A única fonte de tempo para regra de negócio é o banco (`now()`). Não use `Date.now()` para decidir corte.
16. Qualquer código que confirma pedido ou fecha o dia trava a linha de `service_days` antes (`FOR SHARE` para confirmar, `FOR UPDATE` para fechar).
17. Pagamento com `paid_at > cutoff_at` ou com o dia já `closed` vira crédito na carteira e pedido `expired_late`. Nunca entra no romaneio depois de congelado.
18. O romaneio (`manifests`) é imutável depois de gravado.

### Integração

19. Efeito externo (WhatsApp, e-mail, notificação) é sempre um registro em `outbox_events` na mesma transação da mudança. Não faça chamada HTTP ao n8n de dentro de uma regra de negócio.
20. Chamada ao gateway de pagamento acontece fora de transação de banco, com chave de idempotência do provedor.
21. O webhook do gateway chega direto na API. Não roteie pagamento pelo n8n.
22. Rotas `/internal/v1/**` exigem o token de serviço e a assinatura HMAC com timestamp. Use o plugin de `platform/hmac`.
23. Mudou um contrato? Altere o schema em `packages/contracts`, o exemplo na spec e a fixture do teste de contrato, no mesmo commit.

### Autenticação

24. O token do magic link vai no fragmento da URL e só é guardado como SHA-256. Nenhuma rota `GET` consome token ou altera estado.
25. O cookie de sessão se chama `__session` (o Firebase Hosting descarta qualquer outro). `HttpOnly; Secure; SameSite=Lax`.
26. Toda rota declara o `kind` e o `scope` que exige. Rota sem declaração é erro de build/teste.
27. Respostas de `/api/**` levam `Cache-Control: private, no-store`.

### LGPD

28. Nunca registre em log: telefone, e-mail, nome, token, OTP, `device_secret`, corpo de webhook. Use ids internos.
29. Mensagens e eventos para WhatsApp usam só o primeiro nome do aluno e do responsável.
30. PDFs e arquivos ficam em `schools/<school_id>/…` em bucket privado; acesso só por URL assinada de 5 min após checar a sessão.
31. Não adicione campo novo com dado pessoal de aluno sem pedir confirmação.

### KDS

32. A tela do KDS lê e escreve somente no IndexedDB. Componentes de `areas/kds` não chamam a API; só o módulo `sync` chama.
33. Marcar entrega = uma transação IndexedDB que atualiza `orderState` e insere na `outbox`.
34. Um evento só sai da `outbox` depois de o servidor devolver o `event_id` como aceito.
35. Não use a Background Sync API. A sincronização roda no evento `online`, por intervalo e no retorno de foco.
36. `event_id` é gerado no cliente (UUID) e é a chave primária no servidor.

## Convenções

- Ids: UUID v7 gerado na aplicação.
- Banco em `snake_case`; código em `camelCase`; nomes de tabela no plural.
- Datas: `timestamptz` sempre; `service_date` é `date` no fuso de `schools.timezone`.
- Estados e tipos são `text` com `CHECK`, espelhados em um `z.enum` em `contracts`.
- Erros de domínio: lance `DomainError(code)` com código de `platform/errors`; a web traduz o código.
- Migração aplicada nunca é editada; crie outra.
- Texto de interface em português do Brasil. Código, nomes e commits em inglês.

## Como trabalhar

- Siga o plano da fase em `docs/superpowers/plans/`. Uma tarefa por vez, com teste antes da implementação.
- Regra de negócio nova exige teste de integração com banco real. Não use mock de banco.
- Antes de dizer que terminou: `pnpm typecheck && pnpm lint && pnpm test` passando.
- Se uma tarefa parecer exigir quebrar uma regra acima, pare e pergunte em vez de contornar.
- Não adicione dependência, serviço de nuvem ou tabela fora do que a spec prevê sem perguntar.
