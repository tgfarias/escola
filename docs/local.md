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

O mesmo vale para o login do responsável por OTP. Os responsáveis de demonstração usam telefones
fictícios `+55119000000xx`.

## Testes com o app no ar

O Postgres do compose ocupa uma faixa de rede; nesta máquina WSL os testes de API (Testcontainers)
precisam do compose desligado: `pnpm app:down && pnpm test`.
