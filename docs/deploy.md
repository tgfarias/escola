# Deploy

Pré-requisitos: projeto GCP com Cloud Run, Cloud SQL (PostgreSQL 16, `southamerica-east1`),
Secret Manager e Firebase Hosting habilitados; `gcloud` e `firebase` autenticados.

Variáveis usadas abaixo: `GCP_PROJECT`, `SQL_INSTANCE` (formato `projeto:regiao:instancia`) e
`DOCUMENTS_BUCKET` (bucket privado dos PDFs, criado em "Documentos (Cloud Storage)"):

```bash
DOCUMENTS_BUCKET=<projeto>-app-lanche-documentos
```

A API recusa iniciar com `STORAGE_DRIVER=gcs` (o padrão) e `DOCUMENTS_BUCKET` vazio.

`APP_BASE_URL` é a origem pública da PWA: monta os magic links e é a única origem aceita em
gravações com sessão (proteção contra CSRF). Em produção, `https://<dominio>`; em
desenvolvimento local, `http://localhost:5173` (a porta do Vite), senão toda gravação feita
pela PWA responde 403 `origin_rejected`.

## Segredos (Secret Manager)

`DATABASE_URL` (usuário `app_user`), `INTERNAL_SERVICE_TOKEN`, `INTERNAL_HMAC_SECRET`, `SESSION_SECRET`,
`JOBS_TOKEN`, `N8N_EVENTS_URL`, `N8N_HMAC_SECRET` (os três últimos descritos em "Jobs e n8n").

`INTERNAL_SERVICE_TOKEN`, `INTERNAL_HMAC_SECRET`, `SESSION_SECRET` e `JOBS_TOKEN` devem ter no mínimo 32 caracteres
(por exemplo `openssl rand -hex 32`); a API recusa iniciar com valores mais curtos ou ausentes.
`N8N_HMAC_SECRET` segue a mesma regra de tamanho quando presente.

## Migrações

Rodar de uma máquina com acesso ao banco (Cloud SQL Auth Proxy):

```bash
DATABASE_ADMIN_URL=postgres://postgres:<senha>@127.0.0.1:5432/app_lanche \
APP_DB_PASSWORD=<senha do app_user> pnpm db:migrate
```

## API

### Imagem (Artifact Registry)

Criar o repositório uma única vez:

```bash
gcloud artifacts repositories create app-lanche --repository-format=docker \
  --location=southamerica-east1 --project "$GCP_PROJECT"
```

Construir, enviar e publicar:

```bash
IMAGE="southamerica-east1-docker.pkg.dev/$GCP_PROJECT/app-lanche/api"
gcloud builds submit --project "$GCP_PROJECT" --tag "$IMAGE" --dockerfile apps/api/Dockerfile .
gcloud run deploy app-lanche-api --project "$GCP_PROJECT" --region southamerica-east1 \
  --image "$IMAGE" \
  --add-cloudsql-instances "$SQL_INSTANCE" \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,INTERNAL_SERVICE_TOKEN=INTERNAL_SERVICE_TOKEN:latest,INTERNAL_HMAC_SECRET=INTERNAL_HMAC_SECRET:latest,SESSION_SECRET=SESSION_SECRET:latest,JOBS_TOKEN=JOBS_TOKEN:latest,N8N_EVENTS_URL=N8N_EVENTS_URL:latest,N8N_HMAC_SECRET=N8N_HMAC_SECRET:latest \
  --set-env-vars APP_BASE_URL=https://<dominio>,DB_POOL_MAX=5,STORAGE_DRIVER=gcs,DOCUMENTS_BUCKET=$DOCUMENTS_BUCKET \
  --concurrency 80 --max-instances 5 --allow-unauthenticated
```

`max-instances × DB_POOL_MAX` deve ficar abaixo do `max_connections` da instância.

Se a versão do `gcloud` não aceitar `--dockerfile` em `builds submit`, construa e envie a imagem com
`docker build -f apps/api/Dockerfile -t "$IMAGE" . && docker push "$IMAGE"`
(após `gcloud auth configure-docker southamerica-east1-docker.pkg.dev`) e siga direto para `gcloud run deploy`.

### DATABASE_URL no Cloud Run (socket do Cloud SQL)

No Cloud Run a conexão com o Cloud SQL usa o socket Unix montado por `--add-cloudsql-instances`:

```
postgres://app_user:<senha>@/app_lanche?host=/cloudsql/<SQL_INSTANCE>
```

Guarde esse valor no segredo `DATABASE_URL`. `<SQL_INSTANCE>` tem o formato `projeto:regiao:instancia`.

### Permissões da conta de serviço

A conta de serviço do serviço Cloud Run precisa dos papéis:

- `roles/secretmanager.secretAccessor` (ler os segredos);
- `roles/cloudsql.client` (conectar ao Cloud SQL);
- `roles/storage.objectCreator` e `roles/storage.objectViewer` no bucket de documentos;
- `roles/iam.serviceAccountTokenCreator` sobre ela mesma (assinar URLs). Veja "Documentos (Cloud Storage)".

## Documentos (Cloud Storage)

Crie o bucket antes do primeiro deploy da API (`DOCUMENTS_BUCKET` definido no início deste arquivo):

```bash
RUN_SA=<conta de serviço do Cloud Run>
gcloud storage buckets create "gs://$DOCUMENTS_BUCKET" --project "$GCP_PROJECT" \
  --location southamerica-east1 --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://$DOCUMENTS_BUCKET" \
  --member "serviceAccount:$RUN_SA" --role roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding "gs://$DOCUMENTS_BUCKET" \
  --member "serviceAccount:$RUN_SA" --role roles/storage.objectViewer
# URL assinada V4 sem chave privada: a biblioteca usa a IAM signBlob da própria conta.
gcloud services enable iamcredentials.googleapis.com --project "$GCP_PROJECT"
gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" \
  --member "serviceAccount:$RUN_SA" --role roles/iam.serviceAccountTokenCreator
```

O bucket é privado e o objeto nunca é sobrescrito (`ifGenerationMatch=0`), por isso a conta não precisa de
`objectAdmin`. O `gcloud run deploy` da seção "API" inclui `STORAGE_DRIVER=gcs,DOCUMENTS_BUCKET=$DOCUMENTS_BUCKET`
em `--set-env-vars`. `STORAGE_DRIVER=local` é recusado sem `ENABLE_LOCAL_STORAGE=true` e não deve ser usado em
produção.

Desenvolvimento fora do Docker (`pnpm dev`): sem bucket, use o disco local, por exemplo
`STORAGE_DRIVER=local ENABLE_LOCAL_STORAGE=true LOCAL_STORAGE_DIR=/tmp/app-lanche-documents pnpm dev`
(veja `docs/local.md`).

Item de homologação: gerar um lote real e abrir o PDF pela URL assinada.

## Pagamentos

- `PAYMENT_PROVIDER` aceita `fake` ou `efi`. O provedor `fake` serve apenas para desenvolvimento e homologação: a API só sobe com ele se `ENABLE_FAKE_PAYMENTS=true`. O gateway real (Efí) está descrito na seção "Efí (Pix)" abaixo.
- Cada escola tem `schools.payment_webhook_secret_ref` com o NOME de uma variável de ambiente (ex.: `PAYMENT_WEBHOOK_SECRET_ESCOLA_PILOTO`), mapeada de um segredo do Secret Manager com `--set-secrets` (mínimo 32 caracteres). Incluir escola nova exige novo deploy.
- URL de webhook a configurar no gateway: `https://<url do Cloud Run>/webhooks/payments/<provedor>/<school_id>` (direto no Cloud Run, sem passar pelo Hosting).

## Efí (Pix)

Referência da API e itens não confirmados: `docs/efi-pix.md`.

Variáveis do serviço:

- `PAYMENT_PROVIDER=efi`.
- `EFI_ENV`: `homologacao` até o piloto; `production` depois.
- `EFI_PLATFORM_ACCOUNT`: JSON com a conta Efí da plataforma, que recebe o split: `{"document_type":"cnpj","document":"<só dígitos>","account":"<número da conta Efí>"}`. Obrigatória se alguma escola tem `platform_fee_bps > 0`.

Por escola:

- Segredo JSON de credenciais, mapeado com `--set-secrets` numa variável cujo nome vai em `schools.payment_account_ref`: `client_id`, `client_secret`, `pix_key`, `certificate_p12_base64` (o certificado `.p12` em base64) e `certificate_passphrase` (se houver).
- Segredo do webhook (`openssl rand -hex 32`), numa variável cujo nome vai em `schools.payment_webhook_secret_ref`. Para a Efí ele precisa casar `[A-Za-z0-9_-]{32,}`, pois vai na URL.
- Escopos que a aplicação da escola precisa ter no painel Efí: `cob.write`, `cob.read`, `pix.read`, `webhook.write`, `webhook.read`, `gn.split.write`, `gn.split.read`.

Depois do deploy, registre o webhook e o split de cada escola (com `PAYMENT_PROVIDER=efi`, `EFI_PLATFORM_ACCOUNT` e os segredos no ambiente do comando):

```bash
pnpm --filter @app-lanche/api cli:efi-setup <school_id> <URL do Cloud Run>
```

O comando registra o webhook com `x-skip-mtls-checking: true` (o Cloud Run não faz mTLS) e cria a configuração de split. Ele imprime só o resultado de cada passo, nunca a URL (que contém o token).

Checklist de homologação (itens não confirmados em `docs/efi-pix.md`):

- criar uma cobrança e pagá-la no ambiente de homologação;
- conferir que o webhook chega com `?token=…&ignorar=/pix`;
- repetir o PUT do mesmo txid (espera-se 409 ou 2xx);
- conferir o split vinculado;
- conferir a senha do `.p12`.

## Jobs e n8n

Variáveis novas (todas via `--set-secrets`, como as demais):

- `JOBS_TOKEN` (obrigatória, mínimo 32 caracteres): token das rotas `/jobs/v1/**`.
- `N8N_EVENTS_URL` e `N8N_HMAC_SECRET` (devem vir juntas): destino e segredo de assinatura da outbox. Sem elas a outbox fica pendente.

Cloud Scheduler (região `southamerica-east1`, fuso `America/Sao_Paulo`), alvo HTTP na URL do Cloud Run (não a do Hosting), método `POST`, cabeçalho `X-Job-Token: <JOBS_TOKEN>`:

- `outbox-dispatch`: `* * * * *` para `/jobs/v1/outbox/dispatch`;
- `safety-close`: `*/5 * * * *` para `/jobs/v1/service-days/safety-close`;
- `topup-reconcile`: `*/5 * * * *` para `/jobs/v1/topups/reconcile` (confirma recargas pagas e expira Pix vencidos; spec F5B).

```bash
gcloud scheduler jobs create http outbox-dispatch --schedule="* * * * *" \
  --uri="$RUN_URL/jobs/v1/outbox/dispatch" --http-method=POST \
  --headers="X-Job-Token=$JOBS_TOKEN" --location=southamerica-east1 --time-zone=America/Sao_Paulo
gcloud scheduler jobs create http safety-close --schedule="*/5 * * * *" \
  --uri="$RUN_URL/jobs/v1/service-days/safety-close" --http-method=POST \
  --headers="X-Job-Token=$JOBS_TOKEN" --location=southamerica-east1 --time-zone=America/Sao_Paulo
gcloud scheduler jobs create http topup-reconcile --schedule="*/5 * * * *" \
  --uri="$RUN_URL/jobs/v1/topups/reconcile" --http-method=POST \
  --headers="X-Job-Token=$JOBS_TOKEN" --location=southamerica-east1 --time-zone=America/Sao_Paulo
```

Disparo imediato da outbox: depois do commit, a API envia os eventos da escola sem esperar o job,
mas esse envio roda depois da resposta. Com a limitação de CPU padrão do Cloud Run, ele pode ficar
parado até a próxima requisição à instância; o job de 1 min garante a entrega. Com
`--no-cpu-throttling` no `gcloud run deploy` o envio é imediato, a um custo maior.

## Web

```bash
pnpm --filter @app-lanche/web build
firebase deploy --only hosting --project "$GCP_PROJECT"
```

## KDS (cozinha)

- Pareamento: na área admin, "Tablets da cozinha" → "Gerar código de pareamento"; abra `/kds` no tablet e
  digite o código em até 10 minutos. O código vale uma vez só.
- O tablet deve ser dedicado à cozinha: ele usa o mesmo cookie `__session` da equipe (o Firebase Hosting só
  repassa esse), então não faça login de equipe no mesmo navegador. Se alguém entrar em `/admin` no tablet, a
  sessão da cozinha é substituída: o tablet pede um novo código de pareamento e mantém as entregas pendentes,
  que são enviadas depois do novo pareamento.
- Instale o `/kds` como PWA ("Adicionar à tela inicial") e abra-o uma vez com rede: o service worker passa a
  servir a tela sem conexão e as entregas ficam no aparelho até sincronizar.
- Mantenha a página aberta: a tela pede Wake Lock para não apagar.
- Em caso de perda ou troca do tablet, revogue-o pela mesma tela ("Tablets da cozinha"); a revogação vale na
  próxima requisição.

Teste de ponta a ponta do KDS (Playwright, Postgres do compose, PWA de produção com service worker):

```bash
pnpm db:up
pnpm exec playwright install chromium   # uma vez; no Linux sem as bibliotecas do sistema: --with-deps
pnpm test:e2e
```
