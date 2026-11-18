# n8n

O n8n roda em VPS externa e fala com a API por REST + HMAC (spec 6). Há dois fluxos, gerados a partir de `n8n/code/*.js`.

## Importar os fluxos

1. Em Workflows → Import from File, importe `n8n/workflows/schedule.json` e `n8n/workflows/events.json`; ative ambos.
2. Não edite o código no editor do n8n. Edite `n8n/code/*.js`, rode `pnpm n8n:build` e reimporte. O teste `apps/api/test/n8n.test.ts` falha se o JSON estiver desatualizado.

## Variáveis de ambiente do contêiner do n8n

| Variável | Valor |
| --- | --- |
| `NODE_FUNCTION_ALLOW_BUILTIN` | `crypto` |
| `N8N_BLOCK_ENV_ACCESS_IN_NODE` | `false` |
| `APP_LANCHE_API_URL` | URL do Cloud Run, sem barra final |
| `APP_LANCHE_SERVICE_TOKEN` | igual a `INTERNAL_SERVICE_TOKEN` da API |
| `APP_LANCHE_HMAC_SECRET` | igual a `INTERNAL_HMAC_SECRET` da API |
| `APP_LANCHE_EVENTS_SECRET` | igual a `N8N_HMAC_SECRET` da API |
| `APP_LANCHE_EVENTS_PATH` | caminho **mais a query string** de `N8N_EVENTS_URL` (exatamente o que a API assina), ex. `/webhook/app-lanche-events` ou `/webhook/app-lanche-events?x=1` |
| `WHATSAPP_TOKEN` | token da WhatsApp Cloud API |
| `WHATSAPP_PHONE_NUMBER_ID` | id do número remetente |
| `WHATSAPP_API_VERSION` | opcional, padrão `v21.0` |
| `WA_TEMPLATE_REMINDER`, `WA_TEMPLATE_KITCHEN`, `WA_TEMPLATE_OTP`, `WA_TEMPLATE_PAYMENT_CONFIRMED`, `WA_TEMPLATE_LATE_CREDIT` | nomes dos modelos aprovados |
| `APP_LANCHE_EMAIL_FROM` | remetente do e-mail de código |

Configure também a credencial SMTP no nó "Send e-mail".

## Comportamento dos fluxos

- Agenda (a cada 5 min): envia lembretes e fecha o dia vencido. O fechamento não manda mensagem.
- Eventos: o resumo da cozinha sai do evento `service_day.closed`, qualquer que seja o fechamento (fluxo do n8n, fechamento de segurança ou equipe). O fluxo lê o romaneio em `GET /internal/v1/service-days/{school_id}/{date}/manifest`; falha na leitura ou no envio responde 500 e a outbox tenta de novo.
- Tempo limite: 20 s por chamada à API e 15 s por envio ao WhatsApp. Um envio de lembrete que falha no transporte (tempo esgotado, conexão recusada) é registrado como `failed` com `error: "send_failed"`, e a página segue com os demais responsáveis.

## Modelos do WhatsApp (idioma `pt_BR`)

Parâmetros na ordem; nenhum contém quebra de linha.

- Lembrete (utility): `{{1}}` primeiro nome, `{{2}}` filhos, `{{3}}` horário de corte, `{{4}}` saldo, `{{5}}` link.
  Texto: "Olá, {{1}}! O lanche de {{2}} pode ser pedido até as {{3}}. Seu saldo é {{4}}. Acesse: {{5}}"
- Resumo da cozinha (utility): `{{1}}` data, `{{2}}` total de pedidos, `{{3}}` itens.
  Texto: "Lanches de {{1}}: {{2}} pedidos. Itens: {{3}}."
- Código de acesso: categoria "authentication" com botão de copiar código (o texto dos modelos de autenticação é fixo da Meta).
- Pedido confirmado (utility): `{{1}}` nome, `{{2}}` filhos, `{{3}}` data, `{{4}}` total.
  Texto: "Olá, {{1}}! Pagamento confirmado: lanche de {{2}} em {{3}}, total {{4}}."
- Crédito atrasado (utility): `{{1}}` nome, `{{2}}` valor, `{{3}}` saldo.
  Texto: "Olá, {{1}}! O pagamento chegou depois do horário de corte. Creditamos {{2}} na sua carteira. Saldo: {{3}}."

## Dados pessoais no n8n

O fluxo de eventos não guarda histórico de execuções, de propósito: o corpo do webhook e a saída do Code node trazem código OTP, telefone e nomes, que a API apaga depois da entrega (regra 28 do CLAUDE.md). Por isso `events.json` vem com `saveDataSuccessExecution` e `saveDataErrorExecution` em `none`, `saveManualExecutions` e `saveExecutionProgress` desligados. Nunca ligue o histórico nesse fluxo para depurar; use um evento de teste sem dados reais. Recomenda-se também `EXECUTIONS_DATA_PRUNE=true` com `EXECUTIONS_DATA_MAX_AGE` curto (poucas horas) no contêiner.

Limitações conhecidas:
- A deduplicação por static data pode falhar sob execuções concorrentes do mesmo id de evento. O arrendamento do dispatcher torna isso raro; o pior caso é uma mensagem duplicada.

## Na API

`N8N_EVENTS_URL=https://<n8n>/webhook/app-lanche-events` e `N8N_HMAC_SECRET` (mínimo 32 caracteres). Sem `N8N_EVENTS_URL` o dispatcher não envia nada.

## Itens a confirmar na homologação

Não foi possível verificar sem um n8n real (o teste usa um harness que executa os Code nodes contra a API, com WhatsApp simulado):

- `this.helpers.httpRequest` com `json: false` envia o corpo exatamente como a string assinada.
- O Webhook v2 com `rawBody` entrega o corpo em `binary.data`, legível por `getBinaryDataBuffer(0, "data")`.
- Com `responseMode: "lastNode"`, um erro no Code node responde 500 e o ramo falso do IF responde 200.
- O caminho recebido atrás do proxy da VPS bate com `APP_LANCHE_EVENTS_PATH`.
- Os Code nodes podem rodar em task runners (padrão nas versões recentes do n8n): `NODE_FUNCTION_ALLOW_BUILTIN` e o acesso a variáveis de ambiente precisam estar configurados também no runner.
- As configurações de execução do fluxo de eventos realmente impedem o salvamento depois da importação.
- Os modelos aprovados aceitam o link como parâmetro de texto.
