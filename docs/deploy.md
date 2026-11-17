# Deploy

Pré-requisitos: projeto GCP com Cloud Run, Cloud SQL (PostgreSQL 16, `southamerica-east1`),
Secret Manager e Firebase Hosting habilitados; `gcloud` e `firebase` autenticados.

Variáveis usadas abaixo: `GCP_PROJECT`, `SQL_INSTANCE` (formato `projeto:regiao:instancia`).

## Segredos (Secret Manager)

`DATABASE_URL` (usuário `app_user`), `INTERNAL_SERVICE_TOKEN`, `INTERNAL_HMAC_SECRET`, `SESSION_SECRET`.

## Migrações

Rodar de uma máquina com acesso ao banco (Cloud SQL Auth Proxy):

```bash
DATABASE_ADMIN_URL=postgres://postgres:<senha>@127.0.0.1:5432/app_lanche \
APP_DB_PASSWORD=<senha do app_user> pnpm db:migrate
```

## API

```bash
gcloud builds submit --project "$GCP_PROJECT" \
  --tag "gcr.io/$GCP_PROJECT/app-lanche-api" --dockerfile apps/api/Dockerfile .
gcloud run deploy app-lanche-api --project "$GCP_PROJECT" --region southamerica-east1 \
  --image "gcr.io/$GCP_PROJECT/app-lanche-api" \
  --add-cloudsql-instances "$SQL_INSTANCE" \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,INTERNAL_SERVICE_TOKEN=INTERNAL_SERVICE_TOKEN:latest,INTERNAL_HMAC_SECRET=INTERNAL_HMAC_SECRET:latest,SESSION_SECRET=SESSION_SECRET:latest \
  --set-env-vars APP_BASE_URL=https://<dominio>,DB_POOL_MAX=5 \
  --concurrency 80 --max-instances 5 --allow-unauthenticated
```

`max-instances × DB_POOL_MAX` deve ficar abaixo do `max_connections` da instância.

Se a versão do `gcloud` não aceitar `--dockerfile` em `builds submit`, construa e envie a imagem com
`docker build -f apps/api/Dockerfile -t gcr.io/$GCP_PROJECT/app-lanche-api . && docker push gcr.io/$GCP_PROJECT/app-lanche-api`
e siga direto para `gcloud run deploy`.

## Web

```bash
pnpm --filter @app-lanche/web build
firebase deploy --only hosting --project "$GCP_PROJECT"
```
