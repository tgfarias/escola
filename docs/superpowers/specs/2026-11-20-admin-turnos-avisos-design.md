# Admin reorganizado, turnos e avisos sem n8n (fase F5C)

Data: 2026-11-20. Complementa `2026-11-16-app-lanche-design.md` e `2026-11-19-balcao-carteira-design.md`; a spec principal continua valendo em tudo que este documento não muda. A F6 (conciliação, alertas, retenção LGPD, rate limit, piloto) continua depois desta fase.

A fase tem três partes, entregues nesta ordem e com um plano cada: **A** (admin), **B** (turnos) e **C** (acesso e avisos). Cada parte termina com o app funcionando.

## Decisões do usuário (2026-11-20)

- O produto precisa rodar sozinho para muitas escolas: nada do dia a dia depende de alguém da escola enviar mensagem.
- **Acesso dos pais:** o aparelho fica lembrado por 30 dias sem uso. Código (OTP) só em aparelho novo. **Sem login por CPF + data de nascimento.**
- **Lembrete diário por Web Push**, com **reserva por WhatsApp** para quem não tem notificação ativa.
- **Cartão impresso com QR** para o primeiro acesso de cada família.
- **Sem n8n:** a API envia direto ao WhatsApp Cloud API; os horários ficam no Cloud Scheduler.
- **Turnos:** escolas com turno da manhã (matutino) e da tarde (vespertino). Cada turma pertence a um turno.
- **Pedido pago não retirado:** sem reembolso automático. Fica "não retirado" e a secretaria decide, pedido a pedido, se devolve como crédito.
- **Admin:** menus agrupados ("Lanche" separado de "Alunos"), importação CSV dentro da lista de alunos, e página inicial com indicadores, valores ocultos por padrão.

## Parte A — Admin

### A.1 Menu lateral

Grupos com título (`.app-sidebar__heading` do tema):

| Grupo | Itens | Papéis |
| --- | --- | --- |
| — | Início | todos |
| Escola | Alunos e responsáveis · Documentos | admin, secretaria |
| Lanche | Dias de serviço · Cardápio · Tablets da cozinha · Contas · (Parte B) Não retirados | admin, secretaria; a cozinha vê só Contas |

- Cardápio, Dias de serviço e Tablets da cozinha deixam de ser seções da página inicial. Cada um vira uma página: `/admin/lanche/dias`, `/admin/lanche/cardapio`, `/admin/lanche/tablets`.
- Os links antigos com âncora (`/admin#cardapio`, `#dias`, `#tablets`) redirecionam para as páginas novas.

### A.2 Alunos e responsáveis

- A lista atual ganha, no topo, o botão **"Adicionar / importar"**.
- Ao tocar, abre um painel com os campos do CSV (arquivo ou texto colado) e o resultado da importação, como hoje na página inicial. Depois de importar, a lista recarrega.
- Não há formulário de um aluno por vez: um CSV de uma linha adiciona um aluno.

### A.3 Página inicial: indicadores

- Filtro de período: **Hoje**, **7 dias** e **Mês atual**, no fuso da escola. O padrão é Hoje.
- Uma rota `GET /api/admin/v1/dashboard?period=today|7d|month`:
  - devolve contagens e valores em centavos, calculados no servidor;
  - o período é resolvido pelo relógio do banco (regra 15);
  - responde só os blocos que o papel pode ver.
- **Lanches** (todos os papéis):
  - pedidos pagos, entregues e não retirados (Parte B);
  - lançamentos no balcão;
  - os 5 itens mais pedidos.
- **Documentos** (admin, secretaria):
  - documentos publicados no período;
  - percentual já aberto pelos responsáveis;
  - lotes em geração ou com falha.
- **Valores** (admin, secretaria):
  - recebido por Pix (pedidos e recargas);
  - consumo no balcão;
  - créditos em carteira;
  - débito em aberto e número de responsáveis em débito.
- **Valores ocultos por padrão.** Os números em reais aparecem como "R$ ••••" e um botão de olho ("Mostrar valores" / "Ocultar valores") revela.
  - A escolha não é guardada: cada vez que a página abre, volta oculta.
  - Contagens e percentuais nunca são ocultados.
- A cozinha vê só o bloco Lanches, sem valores.

Exemplo de resposta (`period=7d`, papel secretaria; para a cozinha `documents` e `money` vêm `null`):

```json
{
  "period": "7d", "from": "2026-11-14", "to": "2026-11-20",
  "snacks": { "paidOrders": 42, "deliveredOrders": 40, "notCollectedOrders": 2, "counterSales": 15,
              "topItems": [{ "name": "Misto quente", "qty": 30 }] },
  "documents": { "published": 80, "viewed": 61, "batchesRendering": 0, "batchesWithFailures": 1 },
  "money": { "pixReceivedCents": 125000, "counterCents": 22500, "creditsCents": 48000, "debtCents": 3500, "debtors": 3 }
}
```

## Parte B — Turnos e "Finalizar turno"

### B.1 Modelo (migração `0012_shifts.sql`)

- `classes.shift text NOT NULL DEFAULT 'matutino' CHECK (shift IN ('matutino', 'vespertino'))`.
  - Escola de um turno só não muda nada: todas as turmas ficam no matutino.
  - O CSV de importação ganha a coluna opcional `turno`.
    - Aceita `matutino`/`manhã` e `vespertino`/`tarde` (sem diferença de maiúsculas e acentos); vazio mantém o turno da turma (turma nova: matutino); a mesma turma com turnos diferentes no arquivo é erro de linha.
    - `GET /api/admin/v1/classes` devolve `{ "classes": [{ "id": "0193a000-0000-7000-8000-000000000001", "name": "Infantil 3A", "shift": "matutino" }] }`.
    - `PUT /api/admin/v1/classes/:id/shift` recebe `{ "shift": "vespertino" }` e responde 204 (admin e secretaria; naturalmente idempotente).
- `service_day_shifts`, um por turno ativo no dia:
  - colunas: `school_id`, `service_day_id`, `shift`, `cutoff_at`, `freeze_at`, `status` (`open` | `closed` | `finished`), `closed_at`, `finished_at`, `finished_by_device_id` ou `finished_by_staff_id`;
  - `UNIQUE (school_id, service_day_id, shift)`, com RLS, FKs compostas e caso no teste de RLS.
- `shift_events`, o evento `shift_finished` recebido do tablet (B.3), append-only:
  - colunas: `event_id` (gerado no cliente, chave primária, regra 36), `school_id`, `service_day_shift_id`, `device_id`, `type`, `occurred_at`, `received_at`;
  - com RLS, FKs compostas e caso no teste de RLS.
- O dia (`service_days`) continua a unidade do cardápio e do link de pedido.
  - Corte, congelamento, fechamento e romaneio passam a ser por turno: o pedido de um aluno usa o turno da turma dele.
  - `service_days.cutoff_at` e `freeze_at` ficam iguais aos do turno mais tarde (compatibilidade). O dia fica `closed` quando todos os turnos fecharam.
- O romaneio (`manifests`) ganha `shift`. Ele continua imutável depois de gravado (regra 18).
- As regras 15 a 17 valem por turno:
  - confirmar um pedido trava o turno com `FOR SHARE`, e fechar trava com `FOR UPDATE`;
  - um pagamento depois do corte do turno vira crédito.
- O evento `service_day.closed` é gravado uma vez por turno fechado e traz o `shift`:

```json
{ "type": "service_day.closed", "data": { "service_date": "2026-11-17", "shift": "vespertino", "orders": 42, "late_credits": 1 } }
```

- `orders.status` ganha `not_collected`.
- `wallet_entries.kind` ganha `uncollected_credit` (positivo). Um índice único parcial por pedido impede devolver o mesmo pedido duas vezes.

### B.2 Admin: dias de serviço

- Ao abrir um dia, a escola informa o horário de corte de cada turno que tem turmas. O padrão vem de `schools`: novas colunas `cutoff_time_matutino` e `cutoff_time_vespertino`.
- O dia mostra a situação de cada turno: aberto, fechado (romaneio pronto) ou finalizado.

Exemplo de `GET /api/admin/v1/service-days` (um dia; `cutoffAt`/`freezeAt` do dia = turno mais tarde):

```json
{ "serviceDate": "2026-11-23", "cutoffAt": "2026-11-23T16:00:00.000Z", "freezeAt": "2026-11-23T16:05:00.000Z", "status": "open",
  "shifts": [
    { "shift": "matutino", "cutoffAt": "2026-11-23T10:30:00.000Z", "freezeAt": "2026-11-23T10:35:00.000Z", "status": "closed" },
    { "shift": "vespertino", "cutoffAt": "2026-11-23T16:00:00.000Z", "freezeAt": "2026-11-23T16:05:00.000Z", "status": "open" } ],
  "items": [{ "menuItemId": "0193…", "name": "Misto quente", "priceCents": 900 }] }
```

`PUT /api/admin/v1/service-days/{date}` recebe `{ "cutoffTimes": { "vespertino": "13:30" }, "items": [...] }`; turno sem horário usa o padrão da escola. Só turnos com turmas (com aluno ativo) aceitam horário (`validation_failed` nos demais); um turno já fechado ou finalizado mantém seus horários ao salvar o dia de novo.

Para o responsável, `GET /api/v1/service-days` e `GET /api/v1/service-days/{date}/menu` trazem cada turno e se ainda aceita pedido (o menu acrescenta `acceptingOrders` do dia = algum turno aceita):

```json
{ "serviceDate": "2026-11-23", "cutoffAt": "2026-11-23T16:00:00.000Z", "acceptingOrders": true,
  "items": [{ "menuItemId": "0193…", "name": "Misto quente", "priceCents": 900 }],
  "shifts": [
    { "shift": "matutino", "cutoffAt": "2026-11-23T10:30:00.000Z", "acceptingOrders": false },
    { "shift": "vespertino", "cutoffAt": "2026-11-23T16:00:00.000Z", "acceptingOrders": true } ] }
```

Pedido do responsável: um checkout é de um turno só, derivado no servidor da turma dos alunos (`POST /api/v1/checkouts` não muda). Alunos de turnos diferentes no mesmo pedido → 422 `invalid_order`; turno sem linha no dia → 409 `shift_not_offered`. Confirmar, cancelar e pagar usam o corte do turno; o Pix expira no corte do turno. `GET /api/v1/me` traz o turno de cada aluno:

```json
{ "guardian": { "id": "0193a000-0000-7000-8000-000000000010", "firstName": "Ana" },
  "students": [
    { "id": "0193a000-0000-7000-8000-000000000011", "firstName": "Léo", "className": "Infantil 3A", "shift": "matutino" },
    { "id": "0193a000-0000-7000-8000-000000000012", "firstName": "Bia", "className": "Infantil 5C", "shift": "vespertino" } ],
  "walletBalanceCents": 0 }
```

O `CheckoutView` ganha `shift`, e `cutoffAt` passa a ser o corte do turno (`orders[].status` pode ser `not_collected`, B.3):

```json
{ "id": "0193a000-0000-7000-8000-000000000020", "serviceDate": "2026-11-23", "shift": "vespertino",
  "cutoffAt": "2026-11-23T16:00:00.000Z", "status": "pending_payment", "totalCents": 900, "walletAppliedCents": 0, "amountDueCents": 900,
  "orders": [{ "id": "0193a000-0000-7000-8000-000000000021", "studentId": "0193a000-0000-7000-8000-000000000012", "studentFirstName": "Bia",
               "status": "pending", "items": [{ "menuItemId": "0193a000-0000-7000-8000-000000000030", "name": "Misto quente", "qty": 1, "unitPriceCents": 900 }] }],
  "payment": { "status": "pending", "amountCents": 900, "pixCopyPaste": "000201…", "pixQrPngBase64": null, "expiresAt": "2026-11-23T16:00:00.000Z" } }
```

Erro de turno sem lanche: `{ "error": { "code": "shift_not_offered", "message": "…" } }` (409).

### B.3 Tablet: "Finalizar turno"

- O quadro de entregas mostra um turno por vez, com abas Manhã e Tarde quando a escola tem os dois.
- O botão **"Finalizar turno"** aparece com o turno fechado. Ele pede confirmação mostrando quantos pedidos ainda estão pendentes.
- Finalizar é uma transação IndexedDB, como a entrega (regra 33):
  - grava `shift_finished` na outbox: `{ event_id, service_date, shift, occurred_at }`;
  - marca o turno como finalizado no aparelho. Os pendentes passam a aparecer como "não retirado".
- **Ordem de envio:** o `shift_finished` só sai depois de aceitos os eventos de entrega gravados antes dele no aparelho, a mesma regra do estorno da F5B.
- No servidor, `POST /api/kds/v1/events` aceita o novo tipo, de forma idempotente pelo `event_id`:
  - o turno vai para `finished` com `UPDATE … WHERE status = 'closed'` (regra 12);
  - os pedidos `confirmed` do turno ainda sem entrega vão para `not_collected`;
  - repetir o evento ou finalizar em dois tablets não muda nada.
- Uma entrega registrada depois da finalização (tablet que estava sem rede) continua valendo: o pedido sai de `not_collected` para `delivered`. Se já houve crédito devolvido, a entrega é aceita e o pedido fica marcado para a secretaria conferir. O crédito não é desfeito automaticamente.
- **Rede de segurança:** um job finaliza às 23:00 (fuso da escola) todo turno fechado que ninguém finalizou. O job é `POST /jobs/v1/shifts/safety-finish`, no Cloud Scheduler a cada 15 min.

### B.4 Secretaria: "Não retirados"

- Uma página no grupo Lanche lista os pedidos `not_collected` por dia, turno e turma, com o primeiro nome do aluno, os itens e o valor.
- "Devolver como crédito" grava `uncollected_credit` na carteira do responsável financeiro, com trava `FOR UPDATE` e `Idempotency-Key`. Também grava um registro de auditoria com o motivo, que é opcional.
- "Manter sem devolução" só tira o pedido da lista de pendências; essa decisão fica registrada.
- O indicador "não retirados" da Parte A conta esses pedidos.

## Parte C — Acesso dos pais e avisos sem n8n

### C.1 Aparelho lembrado (30 dias)

- Ao confirmar um aparelho (primeiro acesso, ou código em aparelho novo), a API entrega ao app um **token de aparelho**:
  - assinado e com validade de 30 dias;
  - contém `school_id`, `guardian_id` e `device_id`;
  - fica no `localStorage`, ao lado do `device_secret`.
  - Assim a escola é conhecida sem consulta entre escolas e sem nova função `SECURITY DEFINER`.
- `POST /api/v1/auth/resume { deviceToken, deviceSecret }` confere a assinatura, o aparelho ativo e o hash do segredo dentro de `withTenant`. Se tudo bater, abre uma sessão de escopo `order` (2 h) e renova o token por mais 30 dias a partir dali.
- 30 dias sem abrir o app: o token vence e o pai precisa de um link novo. O link pode vir do cartão, do WhatsApp de reserva ou da secretaria.
- A secretaria pode desconectar os aparelhos de um responsável. Reembolso e mudança de cadastro continuam exigindo OTP recente (spec 4.3).
- **Sem token válido,** o app abre na tela "Entrar", que explica as saídas: usar o cartão de acesso ou pedir um link novo à escola.
  - Em "Alunos e responsáveis", a secretaria tem **"Enviar link de acesso"**, que manda pelo WhatsApp de reserva um link de escopo `order`.
  - Nada disso exige consulta entre escolas.
- **Decisão pendente para a Parte C, a ser perguntada antes do plano:** entrar digitando o telefone e recebendo um código.
  - Exigiria uma função `SECURITY DEFINER` nova (`resolve_guardian_phone`), e a regra 5 pede autorização para isso.
  - Também precisaria tratar um telefone cadastrado em mais de uma escola.

### C.2 Web Push

- Depende de: a biblioteca `web-push` (aprovada em 2026-11-20), chaves VAPID no Secret Manager e a tabela `push_subscriptions`.
  - Colunas da tabela: `school_id`, `guardian_id`, `device_id`, `endpoint` (único), `p256dh`, `auth`, `created_at`, `last_success_at`, `failed_count`. Com RLS e caso no teste de RLS.
- O app pede permissão depois do primeiro acesso, nunca na primeira tela. No iPhone, só oferece com o app instalado na tela inicial e mostra como instalar.
- O service worker passa de `generateSW` para `injectManifest`, para tratar `push` e `notificationclick`. Este último abre o app, que entra pelo aparelho lembrado.
- **Notificações:**
  - lembrete diário no horário da escola: o lembrete atual, agora sem link;
  - pagamento ou recarga confirmados;
  - documento novo;
  - aviso de débito.
  - O texto leva só primeiros nomes (regra 29).
- Endereço que responde 404 ou 410 é apagado. Cinco falhas seguidas desativam a inscrição.

### C.3 WhatsApp de reserva

- O WhatsApp só sai quando o push não cobre o responsável:
  - quem não tem inscrição ativa;
  - quem não abre o app há 7 dias;
  - ou mensagens que precisam de link pessoal: código, primeiro acesso por WhatsApp e link de pagamento pedido pela secretaria.
- O lembrete de reserva leva o link pessoal de pedido, como hoje.
- Envio direto ao WhatsApp Cloud API pelo dispatcher da outbox, que já existe e é disparado pelo Cloud Scheduler (regra 19 mantida).
  - Os modelos e os parâmetros são os de `docs/n8n.md`, que vira `docs/whatsapp.md`.
- **Código da equipe por e-mail:** hoje sai pelo n8n e precisa de um envio próprio. Decisão pendente na Parte C: SMTP com uma biblioteca nova, ou código por WhatsApp para o telefone da equipe.
- **Retirada do n8n:**
  - os fluxos `n8n/` e as rotas `/internal/v1/**` usadas só por ele são removidos depois da troca, numa ordem de publicação descrita em `docs/deploy.md`;
  - o `list_due_actions` vira jobs do Cloud Scheduler: `/jobs/v1/reminders/dispatch` e `/jobs/v1/debt-notices/dispatch`;
  - a regra 22 do CLAUDE.md e a seção 6 da spec principal são atualizadas.

### C.4 Cartão de acesso impresso

- Em "Alunos e responsáveis", a secretaria gera o **cartão de acesso** de um, de vários ou de todos os responsáveis. Sai um PDF com um cartão por família:
  - logo da escola e primeiro nome do responsável;
  - QR com o link de primeiro acesso;
  - instruções curtas: abrir o QR, instalar o app e aceitar as notificações.
- **Link do cartão:** escopo novo `onboarding`, válido por 30 dias e reutilizável até registrar o primeiro aparelho.
  - Com o aparelho registrado, o link para de funcionar.
  - Gerar o cartão de novo invalida o anterior.
- **Risco aceito:** quem pegar o cartão antes da família registra o primeiro aparelho.
  - Mitigação: o responsável vê "aparelho conectado em DD/MM" no app, e a secretaria vê no cadastro se o aparelho foi registrado e pode desconectá-lo.
  - O cartão não traz sobrenome, CPF nem turma.
- Usa o mesmo gerador de PDF da F5 (pdfmake) e o mesmo armazenamento. O PDF fica disponível por URL assinada de 5 min (regra 30) e é apagado depois de 7 dias.

## Testes

- **Parte A:** a rota de indicadores contra o banco real (períodos, fuso, papéis e valores em centavos); a web com valores ocultos ao abrir e o botão revelando; menus por papel; redirecionamento das âncoras antigas; importação dentro da lista.
- **Parte B:** corte e fechamento por turno, com teste de concorrência (pagamento x fechamento do turno); finalização idempotente e vinda de dois tablets; entrega depois da finalização; crédito de não retirado devolvido uma vez só; job de segurança. No Playwright: finalizar offline e a ordem de envio com entregas na fila.
- **Parte C:** `resume` (token vencido, aparelho revogado, segredo errado, outra escola); envio de push com o servidor de push simulado; escolha entre push e WhatsApp; cartão (link de uso até o primeiro aparelho, invalidação ao gerar de novo); envio ao WhatsApp com a Graph API simulada.

## Fora do escopo

- Turnos além de matutino e vespertino (por exemplo, integral com dois lanches): o modelo comporta incluir depois.
- Reembolso automático de não retirados.
- Notificação por SMS.
- Relatórios exportáveis dos indicadores.
