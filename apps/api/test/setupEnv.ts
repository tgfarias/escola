import { inject } from "vitest";

process.env.DATABASE_ADMIN_URL = inject("adminUrl");
process.env.DATABASE_URL = inject("appUrl");
