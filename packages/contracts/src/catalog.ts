import { z } from "zod";
import { Cents, IsoDate, IsoDateTime, Uuid } from "./common";

export const MenuItem = z.object({ id: Uuid, name: z.string(), priceCents: Cents, active: z.boolean() });
export type MenuItem = z.infer<typeof MenuItem>;

export const MenuItemListResponse = z.object({ items: z.array(MenuItem) });
export type MenuItemListResponse = z.infer<typeof MenuItemListResponse>;

export const CreateMenuItemRequest = z.object({ name: z.string().trim().min(1).max(80), priceCents: Cents });
export type CreateMenuItemRequest = z.infer<typeof CreateMenuItemRequest>;

export const UpdateMenuItemRequest = z
  .object({ name: z.string().trim().min(1).max(80).optional(), priceCents: Cents.optional(), active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, "empty update");
export type UpdateMenuItemRequest = z.infer<typeof UpdateMenuItemRequest>;

export const ServiceDayStatus = z.enum(["open", "closed"]);
export type ServiceDayStatus = z.infer<typeof ServiceDayStatus>;

export const UpsertServiceDayRequest = z.object({
  cutoffTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  items: z
    .array(z.object({ menuItemId: Uuid, priceCents: Cents.optional() }))
    .min(1)
    .max(30)
    .refine((items) => new Set(items.map((i) => i.menuItemId)).size === items.length, "duplicate item"),
});
export type UpsertServiceDayRequest = z.infer<typeof UpsertServiceDayRequest>;

export const DayItem = z.object({ menuItemId: Uuid, name: z.string(), priceCents: Cents });
export type DayItem = z.infer<typeof DayItem>;

export const ServiceDay = z.object({
  serviceDate: IsoDate,
  cutoffAt: IsoDateTime,
  freezeAt: IsoDateTime,
  status: ServiceDayStatus,
  items: z.array(DayItem),
});
export type ServiceDay = z.infer<typeof ServiceDay>;

export const ServiceDayListResponse = z.object({ serviceDays: z.array(ServiceDay) });
export type ServiceDayListResponse = z.infer<typeof ServiceDayListResponse>;

export const GuardianServiceDay = z.object({ serviceDate: IsoDate, cutoffAt: IsoDateTime, items: z.array(DayItem) });
export type GuardianServiceDay = z.infer<typeof GuardianServiceDay>;

export const GuardianServiceDayListResponse = z.object({ serviceDays: z.array(GuardianServiceDay) });
export type GuardianServiceDayListResponse = z.infer<typeof GuardianServiceDayListResponse>;

export const GuardianMenuResponse = GuardianServiceDay.extend({ acceptingOrders: z.boolean() });
export type GuardianMenuResponse = z.infer<typeof GuardianMenuResponse>;
