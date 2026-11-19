import { z } from "zod";
import { IsoDate, IsoDateTime, Uuid } from "./common";
import { CounterSaleItems } from "./counter";
import { ManifestContent } from "./manifest";

export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PairingCode = z.string().regex(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

/** POST /api/admin/v1/kds/pairing-codes */
export const PairingCodeResponse = z.object({ deviceId: Uuid, code: PairingCode, expiresAt: IsoDateTime });
export type PairingCodeResponse = z.infer<typeof PairingCodeResponse>;

/** GET /api/admin/v1/kds/devices */
export const KitchenDevice = z.object({
  id: Uuid,
  createdAt: IsoDateTime,
  paired: z.boolean(),
  revokedAt: IsoDateTime.nullable(),
});
export const KitchenDeviceListResponse = z.object({ devices: z.array(KitchenDevice) });
export type KitchenDeviceListResponse = z.infer<typeof KitchenDeviceListResponse>;

/** POST /api/kds/v1/pair */
export const KdsPairRequest = z.object({ code: z.string().transform((s) => s.trim().toUpperCase()).pipe(PairingCode) }).strict();
export const KdsPairResponse = z.object({ deviceId: Uuid });
export type KdsPairResponse = z.infer<typeof KdsPairResponse>;

/** GET /api/kds/v1/manifest/:date — romaneio congelado ou prévia parcial. */
export const KdsManifestResponse = z.object({
  serviceDate: IsoDate,
  status: z.enum(["open", "closed"]),
  manifestVersion: z.number().int().positive().nullable(),
  content: ManifestContent,
});
export type KdsManifestResponse = z.infer<typeof KdsManifestResponse>;

export const DeliveryEventType = z.enum(["delivered", "undelivered"]);
export type DeliveryEventType = z.infer<typeof DeliveryEventType>;

export const KdsEvent = z.object({
  eventId: Uuid,
  orderId: Uuid,
  type: DeliveryEventType,
  occurredAt: IsoDateTime,
});
export type KdsEvent = z.infer<typeof KdsEvent>;

/** POST /api/kds/v1/events */
export const KdsEventsRequest = z.object({ events: z.array(KdsEvent).min(1).max(100) }).strict();
export type KdsEventsRequest = z.infer<typeof KdsEventsRequest>;
export const KdsEventsResponse = z.object({ accepted: z.array(Uuid), rejected: z.array(Uuid) });
export type KdsEventsResponse = z.infer<typeof KdsEventsResponse>;

/** GET /api/kds/v1/changes?date=&since= */
export const KdsChangeEvent = KdsEvent.extend({ deviceId: Uuid });
export type KdsChangeEvent = z.infer<typeof KdsChangeEvent>;
export const KdsChangesResponse = z.object({ events: z.array(KdsChangeEvent), cursor: z.string().nullable() });
export type KdsChangesResponse = z.infer<typeof KdsChangesResponse>;

/** POST /api/kds/v1/counter-sales — `id` gerado no tablet (regra 36). Resposta: KdsEventsResponse com ids de lançamento. */
export const KdsCounterSale = z.object({ id: Uuid, studentId: Uuid, items: CounterSaleItems, occurredAt: IsoDateTime });
export type KdsCounterSale = z.infer<typeof KdsCounterSale>;
export const KdsCounterSalesRequest = z.object({ sales: z.array(KdsCounterSale).min(1).max(100) }).strict();
export type KdsCounterSalesRequest = z.infer<typeof KdsCounterSalesRequest>;

/** POST /api/kds/v1/counter-voids — idempotente pelo id do lançamento. Resposta: KdsEventsResponse com ids de lançamento. */
export const KdsCounterVoid = z.object({ saleId: Uuid, occurredAt: IsoDateTime });
export type KdsCounterVoid = z.infer<typeof KdsCounterVoid>;
export const KdsCounterVoidsRequest = z.object({ voids: z.array(KdsCounterVoid).min(1).max(100) }).strict();
export type KdsCounterVoidsRequest = z.infer<typeof KdsCounterVoidsRequest>;
