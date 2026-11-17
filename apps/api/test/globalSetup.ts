import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Network, type StartedNetwork } from "testcontainers";
import type { TestProject } from "vitest/node";
import { migrate } from "../../../db/migrate";

let network: StartedNetwork | undefined;
let container: StartedPostgreSqlContainer | undefined;

export async function setup(project: TestProject) {
  // A dedicated network (instead of Docker's default bridge) keeps published ports
  // reachable on hosts where the default bridge does not forward traffic.
  network = await new Network().start();
  container = await new PostgreSqlContainer("postgres:16-alpine").withNetwork(network).start();
  const adminUrl = container.getConnectionUri();
  await migrate({ adminUrl, appPassword: "app_user" });
  const appUrl = new URL(adminUrl);
  appUrl.username = "app_user";
  appUrl.password = "app_user";
  project.provide("adminUrl", adminUrl);
  project.provide("appUrl", appUrl.toString());
}

export async function teardown() {
  // Tolera setup parcial; a rede só pode ser removida depois do contêiner, e é tentada mesmo se ele falhar.
  try {
    await container?.stop();
  } finally {
    await network?.stop();
  }
}

declare module "vitest" {
  export interface ProvidedContext {
    adminUrl: string;
    appUrl: string;
  }
}
