# Lançamento no balcão, débito e recarga por Pix (fase F5B)

Data: 2026-11-19. Complementa `2026-11-16-app-lanche-design.md`; a spec principal continua valendo em tudo que este documento não muda. A F6 fica pausada até esta fase terminar.

## Motivação e decisões do usuário (2026-11-19)

Pais pagam a semana inteira na segunda (recarga). Depois disso, a cozinha ou a secretaria lança o lanche de cada dia direto, usando o saldo da "conta" do responsável. O saldo pode ficar negativo até um limite, e o débito é pago por Pix.

- **Débito com limite.** O saldo da carteira pode ficar negativo até `schools.debt_limit_cents`. O padrão é R$ 50,00 e cada escola define o seu. Acima do limite:
  - o tablet recusa o lançamento online e mostra "Saldo insuficiente: peça à secretaria";
  - a secretaria pode lançar acima do limite no admin, com confirmação explícita.
- **Lançamento offline aceito.** O tablet grava o lançamento no IndexedDB e o envia quando a rede volta, igual às entregas (regras 32–36 valem também para ele).
  - O limite é conferido pelo tablet com o último saldo baixado.
  - No servidor o lançamento offline é sempre aplicado, mesmo que ultrapasse o limite. Recusá-lo depois que o aluno já comeu seria perder a venda.
  - Ultrapassagens ficam marcadas (`over_limit`) e aparecem para a secretaria.
- **Pix para pagar débito ou colocar créditos:**
  - o pai gera pelo app ("Pagar débito" ou "Adicionar créditos", com valor livre);
  - a secretaria ou a cozinha gera um QR na tela para pagar no balcão, ou envia o link por WhatsApp;
  - há um aviso automático por WhatsApp quando o saldo fica negativo.
- **Responsável financeiro.** Cada aluno tem um responsável financeiro. O padrão é o primeiro vinculado, e a secretaria pode trocar. Todo lançamento do aluno vai para a carteira dele; os outros responsáveis só veem.
- **Escopo:** a spec principal tirava do escopo a "fatura mensal pós-paga". Esta fase traz um pós-pago limitado: débito com limite, pago por Pix a qualquer momento. Não há fatura nem fechamento mensal.

## Modelo de dados (migração `0010_counter_wallet.sql`)

- `schools.debt_limit_cents bigint NOT NULL DEFAULT 5000 CHECK (debt_limit_cents >= 0)`.
- `guardian_students.financial boolean NOT NULL DEFAULT false`:
  - um índice único parcial garante no máximo um por aluno: `(school_id, student_id) WHERE financial`;
  - a migração marca o vínculo mais antigo de cada aluno;
  - importação CSV e novos vínculos marcam o primeiro;
  - trocar o responsável financeiro é uma rota de equipe.
- `wallet_entries.kind` ganha `counter_charge` (negativo), `counter_void` (positivo, estorno de um lançamento) e `topup_credit` (positivo).
- A carteira continua append-only (regra 8), e todo lançamento trava `wallets` `FOR UPDATE` (regra 9).
- `counter_sales`, um por lançamento:
  - `id uuid` gerado no cliente (regra 36);
  - `school_id`, `student_id`, `guardian_id` (o financeiro no momento do registro);
  - `source` (`kitchen` | `staff`) e `device_id` ou `staff_user_id`;
  - `occurred_at` (do cliente, limitado a 5 min no futuro pelo relógio do banco, como no KDS) e `received_at`;
  - `total_cents`, `over_limit boolean`, `wallet_entry_id`;
  - `voided_at`, `void_entry_id`.
  - Linhas em `counter_sale_items (school_id, sale_id, menu_item_id, qty, unit_price_cents)`.
  - **O preço é sempre calculado no servidor (regra 7):** o tablet envia itens e quantidades, e o servidor usa o `price_cents` atual de `menu_items`.
- `topups`, recargas por Pix:
  - colunas: `id`, `school_id`, `guardian_id`, `amount_cents > 0`, `status` (`pending_payment` | `paid` | `expired` | `cancelled`), `requested_by` (`guardian` | `staff`), `created_at`, `paid_at`;
  - a cobrança vai para `payments`, com uma coluna nova `topup_id` e um CHECK de exclusividade com `checkout_id`;
  - a confirmação passa por `confirmPayment` (regra 10), que ganha o ramo de recarga e grava `topup_credit`.
- Toda tabela nova recebe RLS, FKs compostas e um caso no teste de RLS (regras 3 e 4).

## Fluxos

### Tablet (KDS)

- Nova aba "Lançar" ao lado do quadro de entregas.
- O tablet baixa em `GET /api/kds/v1/roster` (só leitura, por escola):
  - alunos ativos (primeiro nome, turma, restrição já consentida);
  - o primeiro nome do responsável financeiro e o saldo dele;
  - o limite da escola;
  - os itens ativos do cardápio com preço.
  - Fica no Dexie (store `roster`), atualizado a cada sincronização. Ao perder a sessão ele é apagado, como o romaneio.
- Fluxo: buscar o aluno pelo nome ou pela turma, escolher itens e quantidades, e ver o total, o saldo atual e o saldo depois do lançamento.
  - Se o saldo depois for menor que `-limite`, o botão fica desligado com "Saldo insuficiente: peça à secretaria".
  - Se não, "Lançar" grava `counter_sale` em `outbox` e ajusta o saldo local numa transação IndexedDB.
- Sincronização: `POST /api/kds/v1/counter-sales` com até 100 lançamentos.
  - O servidor insere com `ON CONFLICT (id) DO NOTHING`, aplica o débito, marca `over_limit` quando passar do limite e devolve `accepted` e `rejected`.
  - Recusado = aluno inexistente ou inativo, ou item inexistente ou inativo. O cliente remove os dois da `outbox` (regra 34).
- Desfazer: o tablet pode estornar um lançamento do próprio dia (evento `counter_void` na outbox). O servidor grava `counter_void` positivo, também idempotente.

### Secretaria (admin)

- Nova página "Contas":
  - lista de responsáveis com saldo (débitos primeiro), busca e filtro "só com débito";
  - extrato por responsável;
  - lançar no balcão (mesmo fluxo do tablet, online, com confirmação para passar do limite);
  - estornar um lançamento;
  - gerar QR de pagamento (valor padrão = débito, editável) mostrado na tela;
  - "Enviar link de pagamento por WhatsApp".
- Configuração da escola: o limite de débito.
- "Alunos e responsáveis": trocar o responsável financeiro do aluno.
- Ultrapassagens offline (`over_limit`) aparecem marcadas no extrato e num aviso da página "Contas".

### Responsável (PWA)

- A página "Carteira" mostra saldo (débito em destaque), extrato (lanches do balcão por aluno e dia, recargas e créditos) e os botões "Pagar débito" (valor do débito) e "Adicionar créditos" (valor livre, mínimo R$ 10,00, máximo R$ 1.000,00).
- O pagamento abre o Pix (QR e copia-e-cola) e acompanha a confirmação, como no checkout.
- Outros responsáveis do aluno veem os lançamentos só como informação, sem a carteira do responsável financeiro.

### Avisos (outbox → n8n)

- `wallet.debt_notice`:
  - disparado quando um lançamento leva o saldo de `>= 0` para `< 0`;
  - depois, no máximo um a cada 3 dias enquanto o saldo seguir negativo, verificado pela rota interna da agenda do n8n;
  - leva o primeiro nome, o valor devido e o link de pagamento.
- `wallet.payment_requested`: o link enviado a pedido da secretaria.
- `wallet.topup_confirmed`: a confirmação da recarga, com o novo saldo.
- Os links usam um magic link novo de escopo `wallet`, válido por 7 dias pelo relógio do banco, que dá acesso só à carteira e ao pagamento.
- Os modelos de WhatsApp ficam documentados em `docs/n8n.md`.

## Regras que continuam valendo

- Lançamento de balcão não passa pelo horário de corte nem pelo romaneio (regras 15–18): é venda direta, já entregue.
- Gateway fora de transação, com chave de idempotência do provedor (regra 20). Webhook direto na API (regra 21). Todo POST que cria estado aceita `Idempotency-Key` (regra 11). A exceção é a sincronização do tablet, idempotente pelo `id` do cliente.
- LGPD: nada de telefone, nome ou valor por aluno em log. Os eventos levam só primeiros nomes (regras 28 e 29).

## Fora do escopo

- Fatura ou fechamento mensal, juros, multa e bloqueio automático do pedido por Pix por causa de débito.
- Relatórios financeiros além do extrato e da lista de saldos.
