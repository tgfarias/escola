import { buildApp } from "./app";

const app = buildApp();
app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
