# Deploy

Pré-requisitos: projeto GCP com Cloud Run, Cloud SQL (PostgreSQL 16, `southamerica-east1`),
Secret Manager e Firebase Hosting habilitados; `gcloud` e `firebase` autenticados.

Variáveis usadas abaixo: `GCP_PROJECT`, `SQL_INSTANCE` (formato `projeto:regiao:instancia`).

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

## Web

```bash
pnpm --filter @app-lanche/web build
firebase deploy --only hosting --project "$GCP_PROJECT"
```
