# Rodar o app inteiro no Docker (local)

```
pnpm app:up      # Postgres + migrações + escola de demonstração + API + PWA
pnpm app:down    # para tudo (os dados ficam no volume dbdata)
```

- PWA: http://localhost:8088 (nginx servindo o build de produção, com `/api` repassado à API).
- API direta: http://localhost:8080/healthz.
- Pagamento: provedor `fake` (nenhuma cobrança real).

## Entrar na área admin

A escola de demonstração tem o admin `admin@escola.local` (mude com `DEV_ADMIN_EMAIL=... pnpm app:up`).
Sem o n8n configurado, o código de acesso não sai por e-mail/WhatsApp: ele fica na outbox.

1. Em http://localhost:8088/admin, peça o código para `admin@escola.local`.
2. `pnpm app:otp` mostra o último código gerado.

## Entrar como responsável

O responsável entra por magic link, que em produção o n8n pede à API e manda por WhatsApp. Localmente,
`pnpm app:link` faz esse papel: procura o responsável pelo telefone no banco do compose, chama
`POST /internal/v1/schools/<school_id>/magic-links` assinado com `INTERNAL_SERVICE_TOKEN`/`INTERNAL_HMAC_SECRET`
(os valores do `docker-compose.yml`, ou os das variáveis de ambiente) e imprime o link.

```
pnpm app:link +5511900000001 documents   # link para /documentos (padrão)
pnpm app:link +5511900000001 order       # link de pedido
```

O link de pedido vale para o próximo dia de serviço aberto com corte no futuro; sem ele, o comando avisa que é
preciso abrir um dia na área admin.

O link abre a PWA em http://localhost:8088 (`APP_BASE_URL`). Se ela pedir o código de acesso, `pnpm app:otp` mostra o
último. Os responsáveis de demonstração usam telefones fictícios: Ana `+5511900000001` (Léo e Bia), Bruno
`+5511900000002` (Caio), Carla `+5511900000003` (Duda) e Diego `+5511900000004` (segundo responsável de Léo, sem ser
o financeiro).

### Simular o pagamento de um Pix

O provedor de pagamento local é o `fake`: nenhum Pix é cobrado de verdade. Depois de gerar o QR (pelo pai em
"Carteira", pela secretaria em "Contas" ou num pedido), `pnpm app:pay` envia à API o mesmo webhook que o banco
mandaria, e a confirmação passa pelo fluxo real (`confirmPayment`):

```
pnpm app:pay              # paga a cobrança pendente mais recente
pnpm app:pay <id>         # paga a cobrança de uma recarga ou checkout específico
```

O segredo do webhook local é `DEMO_WEBHOOK_SECRET` (no `docker-compose.yml`); o seed liga a escola de demonstração a ele.

### Ver um documento publicado como responsável

1. Na área admin, em Documentos, copie um exemplo, gere o lote para os alunos de demonstração, aguarde a geração e publique.
2. `pnpm app:link +5511900000001 documents` e abra o link impresso.
3. Em `/documentos`, toque no documento: o PDF abre pela URL assinada de 5 minutos.

## Balcão, contas e carteira (F5B)

- Saldos de demonstração: Ana +R$ 30,00, Bruno −R$ 15,00 (lanche de Caio lançado pela secretaria), Carla zerada.
- Admin → "Contas": débitos primeiro, extrato, "Lançar no balcão", estorno, QR de pagamento e "Enviar link de
  pagamento por WhatsApp" (o evento fica na outbox sem o n8n). O limite de débito (padrão R$ 50,00) fica no cartão
  "Limite de débito" (só administradores alteram).
- A cozinha abre "Contas" (para mostrar o QR) em outro aparelho, nunca no tablet do KDS: entrar no admin no tablet
  troca o cookie `__session` e o tablet pede um novo pareamento.
- Tablet: pareie em /kds (código gerado em "Tablets da cozinha") e use a aba "Lançar". Sem rede, o lançamento fica
  pendente e sai quando a conexão volta.
- Responsável: `pnpm app:link +5511900000002 wallet` abre a carteira de Bruno com "Pagar débito" e "Adicionar
  créditos". O provedor `fake` gera um Pix de mentira; sem o webhook configurado a recarga fica pendente.
- Nada roda jobs localmente: a expiração e a conciliação das recargas só acontecem quando
  `POST /jobs/v1/topups/reconcile` é chamado (em produção, o Cloud Scheduler a cada 5 minutos). Depois dos 60
  minutos do Pix, chame à mão:

  ```
  curl -X POST -H 'X-Job-Token: local-jobs-token-with-at-least-32-chars!!!' http://localhost:8080/jobs/v1/topups/reconcile
  ```

## Documentos (PDF)

Os PDFs ficam no volume `documents` (`STORAGE_DRIVER=local`, só aceito com `ENABLE_LOCAL_STORAGE=true`). O link
de download é servido pela própria API em `/api/v1/files?t=...`, assinado e válido por 5 minutos.
`pnpm app:down` mantém o volume; `docker compose --profile app down -v` apaga PDFs e banco.

Fora do Docker (`pnpm dev`), o driver padrão é `gcs` e a API não sobe sem bucket. Use o disco local:

```
STORAGE_DRIVER=local ENABLE_LOCAL_STORAGE=true LOCAL_STORAGE_DIR=/tmp/app-lanche-documents pnpm dev
```

Os dados pessoais da escola de demonstração só são preenchidos quando estão vazios: um valor alterado pela equipe
sobrevive a `pnpm app:up` (um valor apagado volta a ser preenchido).

## Testes com o app no ar

O Postgres do compose ocupa uma faixa de rede; nesta máquina WSL os testes de API (Testcontainers)
precisam do compose desligado: `pnpm app:down && pnpm test`.
