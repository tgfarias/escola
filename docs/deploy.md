# Deploy

Pré-requisitos: projeto GCP com Cloud Run, Cloud SQL (PostgreSQL 16, `southamerica-east1`),
Secret Manager e Firebase Hosting habilitados; `gcloud` e `firebase` autenticados.

Variáveis usadas abaixo: `GCP_PROJECT`, `SQL_INSTANCE` (formato `projeto:regiao:instancia`).

`APP_BASE_URL` é a origem pública da PWA: monta os magic links e é a única origem aceita em
gravações com sessão (proteção contra CSRF). Em produção, `https://<dominio>`; em
desenvolvimento local, `http://localhost:5173` (a porta do Vite), senão toda gravação feita
pela PWA responde 403 `origin_rejected`.

## Segredos (Secret Manager)

`DATABASE_URL` (usuário `app_user`), `INTERNAL_SERVICE_TOKEN`, `INTERNAL_HMAC_SECRET`, `SESSION_SECRET`.

`INTERNAL_SERVICE_TOKEN`, `INTERNAL_HMAC_SECRET` e `SESSION_SECRET` devem ter no mínimo 32 caracteres
(por exemplo `openssl rand -hex 32`); a API recusa iniciar com valores mais curtos ou ausentes.

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
  --set-secrets DATABASE_URL=DATABASE_URL:latest,INTERNAL_SERVICE_TOKEN=INTERNAL_SERVICE_TOKEN:latest,INTERNAL_HMAC_SECRET=INTERNAL_HMAC_SECRET:latest,SESSION_SECRET=SESSION_SECRET:latest \
  --set-env-vars APP_BASE_URL=https://<dominio>,DB_POOL_MAX=5 \
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
- `roles/cloudsql.client` (conectar ao Cloud SQL).

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

## Web

```bash
pnpm --filter @app-lanche/web build
firebase deploy --only hosting --project "$GCP_PROJECT"
```
