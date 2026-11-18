import type { FastifyRequest } from "fastify";
import { config } from "./config";
import { DomainError } from "./errors";
import { safeEqual } from "./hmac";

/** Rotas do Cloud Scheduler: o agendador envia um cabeçalho fixo, não calcula HMAC. */
export function verifyJobRequest(req: FastifyRequest): void {
  const token = req.headers["x-job-token"];
  if (typeof token !== "string" || !safeEqual(token, config().jobsToken)) throw new DomainError("unauthenticated");
}
