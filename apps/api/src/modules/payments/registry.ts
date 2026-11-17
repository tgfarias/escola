import { config } from "../../platform/config";
import { DomainError } from "../../platform/errors";
import { fakeProvider } from "./fakeProvider";
import type { PaymentProvider } from "./provider";

export function getProvider(name: string): PaymentProvider {
  if (name === "fake" && config().fakePaymentsEnabled) return fakeProvider;
  throw new DomainError("not_found");
}

export function defaultProviderName(): string {
  return config().paymentProvider;
}
