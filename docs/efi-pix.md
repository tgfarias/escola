# Efí Pix: referência da API e itens não confirmados

Pesquisa de 2026-11-17 usada pelo adaptador `apps/api/src/modules/payments/efi/`. O texto abaixo está em inglês (cópia da pesquisa).

## Itens não confirmados (validar em homologação)

- Regex do `txid` na Efí (usamos UUID sem hífens, 32 caracteres, que atende a regra do BCB).
- Comportamento de um segundo `PUT /v2/cob/:txid` idêntico (200, 201 ou 409); o adaptador trata 409 consultando a cobrança.
- Status `REMOVIDA_PELO_PSP` nas páginas da Efí.
- Corpo da notificação de teste do webhook e o tratamento de `?token=...&ignorar=` (a Efí acrescenta `/pix` ao final).
- Caminho do endpoint de reenvio de webhook; outros IPs de origem além de 34.193.116.226.
- Formato exato do corpo do split (percentual `"10.00"`, `favorecido` com CNPJ, opções de `divisaoTarifa`) e status do vínculo (201 ou 204).
- Corpo, escopo e status da devolução; senha do `.p12`; tamanho máximo de `solicitacaoPagador`.

Sources: dev.efipay.com.br/docs/api-pix/{credenciais,cobrancas-imediatas,webhooks,payload-locations,split-de-pagamento-pix};
SDK `efipay/sdk-node-apis-efi` -> `src/constants/endpoints.ts` (section `APIS.PIX`).
Items marked UNCONFIRMED could not be verified from official pages (page extraction was via summarizer; re-check before relying on it).

## 1. Base URLs (SDK endpoints.ts + docs "credenciais")
- Production: `https://pix.api.efipay.com.br`
- Homologação: `https://pix-h.api.efipay.com.br`
- mTLS is required on ALL calls to these hosts, including OAuth.

## 2. Authentication
- `POST {base}/oauth/token` (SDK: `authorize`, route `/oauth/token`, post).
- Header `Authorization: Basic base64(client_id:client_secret)`, `Content-Type: application/json`, body:
  `{"grant_type": "client_credentials"}`
- Response:
  ```json
  {"access_token":"<jwt>","token_type":"Bearer","expires_in":3600,"scope":"cob.read cob.write pix.read pix.write"}
  ```
  Lifetime 3600 s (docs). Cache per school and refresh a bit early (e.g. at 3300 s).
- Certificate: P12 (.p12/.pfx) or PEM, issued per Efí account/application (production and homologação certs differ). Bidirectional mTLS.
- Node: `https.request({ hostname, path, method, pfx: fs.readFileSync(p12), passphrase: '' , headers })`
  or `cert`/`key` PEM buffers. With fetch (undici) you need an `Agent`/`dispatcher` with `connect: {pfx}` — not
  available without importing `undici` (not in node:), so use `node:https` for mTLS calls. Certs are per tenant:
  create one `https.Agent({pfx, passphrase})` per school and reuse it (keepAlive).
  (SDK README: `certificate`, `passphrase`, `validateMtls` options; `validateMtls:false` only for webhook config w/o mTLS.)
- Passphrase for Efí-issued p12: UNCONFIRMED (commonly empty; verify with a real cert).

## 3. Create immediate charge with own txid: `PUT /v2/cob/:txid`
- Scope `cob.write`. SDK name `pixCreateCharge`. (`POST /v2/cob` = Efí-generated txid, `pixCreateImmediateCharge`.)
- txid format: docs page does not state it (only "criado pelo usuário recebedor"). BCB Pix spec regex
  `^[a-zA-Z0-9]{26,35}$` (26-35 alphanumeric, no dashes) — UNCONFIRMED on Efí pages but Efí follows BCB. A UUID v7 without dashes = 32 chars is OK.
- Body (no devedor needed; `devedor` is optional):
  ```json
  {
    "calendario": { "expiracao": 3600 },
    "valor": { "original": "13.50" },
    "chave": "71cdf9ba-c695-4e3c-b010-abb521a3f1be",
    "solicitacaoPagador": "Pedido de lanche"
  }
  ```
  expiracao in seconds, must be > 0 (no default stated; always send). `valor.original` string with 2 decimals, dot separator.
  `solicitacaoPagador` max 140 chars (BCB spec; UNCONFIRMED on Efí page). Keep it free of personal data (CLAUDE.md #29).
- 201 response fields: `calendario{criacao,expiracao}`, `txid`, `revisao` (0), `loc{id,location,tipoCob}`, `location`,
  `status` ("ATIVA"), `valor{original}`, `chave`, `solicitacaoPagador`, **`pixCopiaECola`** (present in create/get-ATIVA examples).
  So a separate qrcode call is only needed for the image.
- Idempotency on repeated PUT with same txid: NOT documented. Documented only: 409
  `{"nome":"txid_duplicado", ...}` "Campo txid informado já foi utilizado em outra cobrança" (error type `DuplicatedRegisterError`).
  Whether an identical re-PUT returns 201/200 or 409: UNCONFIRMED. Safe design: on 409 (or any ambiguity) do `GET /v2/cob/:txid`
  and reuse it if body matches.

## 4. QR / copia-e-cola
- `GET /v2/loc/:id/qrcode`, scope `payloadlocation.read` (`pixGenerateQRCode`). `:id` = `loc.id` from the cob response.
  ```json
  {"qrcode":"00020101021226990014BR.GOV.BCB.PIX2577qrcodes-pix.gerencianet.com.br/...",
   "imagemQrcode":"data:image/svg+xml;base64,PHN2Zy...",
   "linkVisualizacao":"https://pix.sejaefi.com.br/cob/pagar/<id>"}
  ```
  `qrcode` = copia-e-cola string; `imagemQrcode` = data URI, **base64 SVG** (not PNG) per docs example; `linkVisualizacao` works only in production.
- Prefer `pixCopiaECola` from the cob response; render QR client-side from it, skip this call.

## 5. Read charge: `GET /v2/cob/:txid` (scope `cob.read`, `pixDetailCharge`)
- Status values seen in docs: `ATIVA`, `CONCLUIDA`, `REMOVIDA_PELO_USUARIO_RECEBEDOR`. `REMOVIDA_PELO_PSP` is in the BCB spec;
  not seen on the Efí page (UNCONFIRMED there). Full list not given by Efí.
- Paid (CONCLUIDA) example contains `pix` array:
  ```json
  "pix":[{"endToEndId":"E12345678202009091221kkkkkkkkkkk","txid":"...","valor":"110.00",
          "horario":"2020-09-09T20:15:00.000Z","infoPagador":"0123456789","devolucoes":[{"status":"EM_PROCESSAMENTO", ...}]}]
  ```
  Payment time = `pix[].horario`, amount = `pix[].valor` (string), id = `endToEndId`. CONCLUIDA response omits `pixCopiaECola`.
- Business rule: compare `horario` against cutoff using DB time/own recorded data; reconciliation should call same `confirmPayment`.

## 6. Webhook
- Register: `PUT /v2/webhook/:chave` (scope `webhook.write`; also `webhook.read` for GET/list; `pixConfigWebhook`, `pixDetailWebhook`, `pixListWebhook` `GET /v2/webhook`, `pixDeleteWebhook` DELETE).
  Body `{"webhookUrl":"https://api.example.com/hook?ignorar="}` -> 201, no body.
  Header `x-skip-mtls-checking: true|false` to disable/enable Efí's mTLS validation of YOUR server (docs, EN page). Without it, your server
  must present TLS cert chain and validate Efí's client cert (min TLS 1.2). Cloud Run cannot do mTLS -> must send `x-skip-mtls-checking: true`.
  The webhook is per chave (per school account); the registration call itself still uses mTLS with the school cert.
- "/pix" suffix: Efí appends `/pix` to the registered URL ("o caminho /pix será acrescentado ao final da URL cadastrada").
  Workaround: register with `?ignorar=` at the end (`https://host/path?ignorar=` -> Efí sends `.../path?ignorar=/pix`, the junk goes in the query).
  Combine with our secret: `https://host/webhooks/efi/<token>?ignorar=` (put the secret in the PATH before `?ignorar=`, or as extra query param before `ignorar`; exact parse of `?hmac=x&ignorar=` UNCONFIRMED -> test in sandbox).
  Without workaround route must also accept `POST <url>/pix`.
- Payload (POST):
  ```json
  {"pix":[{"endToEndId":"E1803615022211340s08793XPJ","txid":"fc9a43k6ff384ryP5f41719",
           "chave":"2c3c7441-b91e-4982-3c25-6105581e18ae","valor":"0.01",
           "horario":"2020-12-21T13:40:34.000Z","infoPagador":"pagando o pix"}]}
  ```
  Array may hold several items; may include `devolucoes` objects when a refund notification (UNCONFIRMED shape). `txid` present only for cob-linked payments.
  Treat `valor` as string; never log body (CLAUDE.md #28, infoPagador is personal).
- Test ping on registration: docs say Efí sends a test notification to the URL on registration ("enviaremos uma notificação de teste").
  Payload of the ping UNCONFIRMED (handler must return 200 for bodies without `pix` array / empty).
- Timeout 60 s per callback. Any non-2xx -> up to 9 retries: attempt 1 immediate, 5 min (attempts 2-4), then 10, 20, 40, 80, 160 min.
  After that no auto-retry; there is a resend endpoint (`/v2/gn/webhook/reenviar`, UNCONFIRMED path). Respond 200 fast; dedupe by endToEndId.
- Authentication recommendations (docs): (1) mTLS with Efí public cert chain, (2) restrict to Efí IP **34.193.116.226** (only IP documented),
  (3) add an HMAC/identifier as URL parameter and reject requests without it. "Use all together". Efí does not sign the body.
  Our approach: per-school secret token in path/query (matches CLAUDE.md #2 school_id from path with secret), plus optional IP check, plus
  verify by `GET /v2/cob/:txid` (cheap and authoritative) before confirming.

## 7. Split de pagamento Pix (docs "split-de-pagamento-pix"; SDK endpoints.ts)
- Only between Efí accounts. Max 20 recipient accounts. Only immediate settlement (`"lancamento":{"imediato":true}`).
  Cannot repass to own account (homologação needs a separate account). Both school and platform must be Efí accounts.
- Create config (id assigned by Efí): `POST /v2/gn/split/config` (`pixSplitConfig`), scope `gn.split.write`.
- Create/update with own id: `PUT /v2/gn/split/config/:id` (`pixSplitConfigId`), scope `gn.split.write`; existing id => update
  (only if config still ATIVA). `GET /v2/gn/split/config/:id` scope `gn.split.read` (docs say temporarily disabled for maintenance).
- Body (shape from docs summary; exact example JSON UNCONFIRMED):
  ```json
  {
    "descricao": "Split lanche",
    "lancamento": { "imediato": true },
    "split": {
      "divisaoTarifa": "assumir_total",
      "minhaParte": { "tipo": "porcentagem", "valor": "90.00" },
      "repasses": [
        { "tipo": "porcentagem", "valor": "10.00", "favorecido": { "cpf": "<doc>", "conta": "<efi account number>" } }
      ]
    }
  }
  ```
  `tipo`: `"porcentagem"` or `"fixo"`. `favorecido` identified by `cpf` (or cnpj, UNCONFIRMED) + Efí `conta` number; doc must match account.
  `divisaoTarifa` values seen: `assumir_total` (others UNCONFIRMED: `proporcional`...). `minhaParte` = the cob owner's (school) share, so
  the platform fee is a `repasse` to the platform's Efí account. Percentages must total exactly 100 incl. minhaParte; cannot mix % reaching 100 with fixed values;
  each repasse > 0. Static variant carries top-level `txid`. Percentage format (e.g. "10.00") and fixed in reais string: UNCONFIRMED exact format.
  Direction caveat: split is configured by the account that owns the cob (school), listing the platform as favorecido; the school account's
  credentials/cert are used. Fee in cents per order is dynamic -> either `fixo` config per order or % config reused (one config, % -> reusable).
- Link config to cob: `PUT /v2/gn/split/cob/:txid/vinculo/:splitConfigId` (`pixSplitLinkCharge`), scope `gn.split.write`, empty body; success status
  204 in body text, 201 in heading (docs inconsistent) -> accept any 2xx. Fails if cob or config not ATIVA; with fixed values the sum must equal cob value.
  Must be linked BEFORE payment (unlink fails once CONCLUIDA). Unlink: `DELETE /v2/gn/split/cob/:txid/vinculo`. Read: `GET /v2/gn/split/cob/:txid` (`gn.split.read`).
  Due-charge equivalents under `/v2/gn/split/cobv/...`.
- Split refund: `PUT /v2/gn/split/pix/:e2eid/devolucao/:id`, scope `gn.pix.write`, body `{"valor":"0.01"}`; debits only the school (integrator) account,
  recipient accounts not debited. Use this (not plain devolucao) for split charges.

## 8. Refund: `PUT /v2/pix/:e2eId/devolucao/:id` (`pixDevolution`, route confirmed in SDK; `GET` same path = `pixDetailDevolution`)
- Scope `pix.write` (read: `pix.read`) — scope UNCONFIRMED from Efí page; BCB-standard.
- Body (BCB-standard; Efí page not retrievable): `{"valor":"7.89"}`. Response 201 `{"id":"...","rtrId":"...","valor":"7.89","horario":{"solicitacao":"..."},"status":"EM_PROCESSAMENTO"}`;
  status `EM_PROCESSAMENTO | DEVOLVIDO | NAO_REALIZADO`. `:id` is our own id (alphanumeric, max 35). All UNCONFIRMED on Efí docs. Idempotent by `:id`.

## 9. Scopes summary
| Use | Scope |
|---|---|
| create/patch cob | `cob.write` |
| read cob | `cob.read` |
| loc qrcode | `payloadlocation.read` (`payloadlocation.write` to create loc) |
| webhook register/delete | `webhook.write` (`webhook.read` to read) |
| read received pix | `pix.read` |
| refund | `pix.write` (UNCONFIRMED); split refund `gn.pix.write` |
| split config/link | `gn.split.write` (read: `gn.split.read`) |
The token's granted scopes are those enabled on the application in the Efí panel (API > Aplicações); the token response lists them.
Each school must enable all of these on its application.

## UNCONFIRMED list (original)
txid regex on Efí; idempotent re-PUT behaviour (200/201/409); REMOVIDA_PELO_PSP on Efí; webhook test-ping payload; exact `?ignorar=` +
extra-param behaviour; resend endpoint path; other Efí IPs; split body exact examples (percent format, favorecido for CNPJ, divisaoTarifa options);
link status code 201 vs 204; devolução body/scope/statuses; p12 passphrase; solicitacaoPagador max length on Efí.
