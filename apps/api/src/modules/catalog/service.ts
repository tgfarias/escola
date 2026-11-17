import type {
  CreateMenuItemRequest,
  DayItem,
  GuardianMenuResponse,
  GuardianServiceDayListResponse,
  MenuItem,
  MenuItemListResponse,
  ServiceDay,
  ServiceDayListResponse,
  ServiceDayStatus,
  UpdateMenuItemRequest,
  UpsertServiceDayRequest,
} from "@app-lanche/contracts";
import { withTenant, type Trx } from "../../db/index";
import { DomainError, isUniqueViolation } from "../../platform/errors";
import { idempotent, requestHash } from "../../platform/idempotency";
import type { SessionClaims } from "../../platform/session";
import * as repo from "./repo";

const NAME_CONSTRAINT = "menu_items_school_id_name_key";

export type LockedServiceDay = {
  id: string;
  serviceDate: string;
  cutoffAt: Date;
  freezeAt: Date;
  status: ServiceDayStatus;
  closedAt: Date | null;
  beforeCutoff: boolean;
};

function asLocked(row: NonNullable<Awaited<ReturnType<typeof repo.lockServiceDayById>>>): LockedServiceDay {
  return { ...row, status: row.status as ServiceDayStatus };
}

export async function lockServiceDayByDate(
  trx: Trx,
  serviceDate: string,
  mode: "share" | "update",
): Promise<LockedServiceDay | undefined> {
  const row = await repo.lockServiceDayByDate(trx, serviceDate, mode);
  return row && asLocked(row);
}

export async function lockServiceDayById(trx: Trx, id: string, mode: "share" | "update"): Promise<LockedServiceDay> {
  const row = await repo.lockServiceDayById(trx, id, mode);
  if (!row) throw new Error(`service day ${id} not found`);
  return asLocked(row);
}

export async function serviceDayPrices(
  trx: Trx,
  serviceDayId: string,
): Promise<Map<string, { name: string; priceCents: number }>> {
  const rows = await repo.serviceDayItems(trx, [serviceDayId]);
  return new Map(rows.map((r) => [r.menuItemId, { name: r.name, priceCents: r.priceCents }]));
}

export const markServiceDayClosed = repo.markServiceDayClosed;

async function itemsByDay(trx: Trx, ids: string[]): Promise<Map<string, DayItem[]>> {
  const map = new Map<string, DayItem[]>(ids.map((id) => [id, []]));
  for (const r of await repo.serviceDayItems(trx, ids)) {
    map.get(r.serviceDayId)!.push({ menuItemId: r.menuItemId, name: r.name, priceCents: r.priceCents });
  }
  return map;
}

function rethrowName(err: unknown): never {
  if (isUniqueViolation(err, NAME_CONSTRAINT)) throw new DomainError("menu_item_name_taken");
  throw err;
}

export async function listMenuItems(session: SessionClaims): Promise<MenuItemListResponse> {
  return { items: await withTenant(session.schoolId, (trx) => repo.listMenuItems(trx)) };
}

export async function createMenuItem(session: SessionClaims, key: string, body: CreateMenuItemRequest): Promise<MenuItem> {
  const hash = requestHash({ route: "POST /api/admin/v1/menu-items", actorId: session.sub, body });
  try {
    return await withTenant(session.schoolId, async (trx) => {
      const { response } = await idempotent(trx, { schoolId: session.schoolId, key, requestHash: hash }, () =>
        repo.insertMenuItem(trx, session.schoolId, body),
      );
      return response;
    });
  } catch (err) {
    rethrowName(err);
  }
}

export async function updateMenuItem(session: SessionClaims, id: string, body: UpdateMenuItemRequest): Promise<MenuItem> {
  try {
    const row = await withTenant(session.schoolId, (trx) => repo.updateMenuItem(trx, id, body));
    if (!row) throw new DomainError("not_found");
    return row;
  } catch (err) {
    rethrowName(err);
  }
}

async function serviceDayView(trx: Trx, serviceDate: string): Promise<ServiceDay> {
  const day = await repo.lockServiceDayByDate(trx, serviceDate, "share");
  if (!day) throw new DomainError("not_found");
  const items = await itemsByDay(trx, [day.id]);
  return {
    serviceDate: day.serviceDate,
    cutoffAt: day.cutoffAt.toISOString(),
    freezeAt: day.freezeAt.toISOString(),
    status: day.status as ServiceDayStatus,
    items: items.get(day.id)!,
  };
}

export async function upsertServiceDay(
  session: SessionClaims,
  serviceDate: string,
  body: UpsertServiceDayRequest,
): Promise<ServiceDay> {
  const schoolId = session.schoolId;
  return withTenant(schoolId, async (trx) => {
    const existing = await repo.lockServiceDayByDate(trx, serviceDate, "update");
    if (existing && (existing.status === "closed" || (await repo.serviceDayHasCheckouts(trx, existing.id)))) {
      throw new DomainError("service_day_locked");
    }
    const day = await repo.upsertServiceDay(trx, schoolId, serviceDate, body.cutoffTime ?? null);
    if (!day.cutoffInFuture) throw new DomainError("cutoff_passed");

    const ids = body.items.map((i) => i.menuItemId);
    const active = new Map((await repo.activeMenuItems(trx, ids)).map((m) => [m.id, m.priceCents]));
    if (active.size !== ids.length) throw new DomainError("validation_failed", "unknown or inactive menu item");
    await repo.replaceServiceDayItems(
      trx,
      schoolId,
      day.id,
      body.items.map((i) => ({ menuItemId: i.menuItemId, priceCents: i.priceCents ?? active.get(i.menuItemId)! })),
    );
    return serviceDayView(trx, serviceDate);
  });
}

export async function listServiceDays(session: SessionClaims, from: string | null): Promise<ServiceDayListResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const days = await repo.listServiceDaysFrom(trx, from);
    const items = await itemsByDay(trx, days.map((d) => d.id));
    return {
      serviceDays: days.map((d) => ({
        serviceDate: d.serviceDate,
        cutoffAt: d.cutoffAt.toISOString(),
        freezeAt: d.freezeAt.toISOString(),
        status: d.status as ServiceDayStatus,
        items: items.get(d.id)!,
      })),
    };
  });
}

export async function listOpenDaysForGuardian(session: SessionClaims): Promise<GuardianServiceDayListResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const days = await repo.listOpenServiceDays(trx);
    const items = await itemsByDay(trx, days.map((d) => d.id));
    return {
      serviceDays: days.map((d) => ({ serviceDate: d.serviceDate, cutoffAt: d.cutoffAt.toISOString(), items: items.get(d.id)! })),
    };
  });
}

export async function guardianMenu(session: SessionClaims, serviceDate: string): Promise<GuardianMenuResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const day = await repo.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    const items = await itemsByDay(trx, [day.id]);
    return {
      serviceDate: day.serviceDate,
      cutoffAt: day.cutoffAt.toISOString(),
      acceptingOrders: day.status === "open" && day.beforeCutoff,
      items: items.get(day.id)!,
    };
  });
}
