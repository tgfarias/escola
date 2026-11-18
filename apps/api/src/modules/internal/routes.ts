import { InternalMagicLinkRequest, Uuid } from "@app-lanche/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as auth from "../auth/service";

/** Rotas chamadas pelo n8n (spec 6.2). A escola vem do caminho, autenticado pelo HMAC. */
export const INTERNAL = { config: { auth: "internal" as const } };
export const SchoolParams = z.object({ school_id: Uuid });

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post("/internal/v1/schools/:school_id/magic-links", INTERNAL, async (req) =>
    auth.issueMagicLink(SchoolParams.parse(req.params).school_id, InternalMagicLinkRequest.parse(req.body)),
  );
}
