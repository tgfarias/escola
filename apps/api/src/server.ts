import { buildApp } from "./app";
import { closeDb } from "./db/index";
import { config } from "./platform/config";

// Falha no boot (exit != 0) se o ambiente estiver mal configurado.
config();

const app = buildApp();

async function shutdown(): Promise<void> {
  try {
    await app.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());

app.listen({ port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
