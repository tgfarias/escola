import { afterAll, inject } from "vitest";
import { closeDb } from "../src/db/index";
import { closeAdminDb } from "./helpers";

process.env.DATABASE_ADMIN_URL = inject("adminUrl");
process.env.DATABASE_URL = inject("appUrl");

afterAll(async () => {
  await closeDb();
  await closeAdminDb();
});
