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
  Shift,
  ShiftStatus,
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

export const markShiftClosed = repo.markShiftClosed;
export const closeDayIfNoOpenShift = repo.closeDayIfNoOpenShift;

export type LockedShift = {
  id: string;
  serviceDayId: string;
  shift: Shift;
  cutoffAt: Date;
  freezeAt: Date;
  status: ShiftStatus;
  closedAt: Date | null;
  beforeCutoff: boolean;
  frozen: boolean;
};

function asShift(row: NonNullable<Awaited<ReturnType<typeof repo.lockShift>>>): LockedShift {
  return { ...row, shift: row.shift as Shift, status: row.status as ShiftStatus };
}

export async function lockShift(
  trx: Trx,
  serviceDayId: string,
  shift: Shift,
  mode: "share" | "update",
): Promise<LockedShift | undefined> {
  const row = await repo.lockShift(trx, serviceDayId, shift, mode);
  return row && asShift(row);
}

/** Turnos do dia, sem trava, matutino primeiro. */
export async function listShifts(trx: Trx, serviceDayId: string): Promise<LockedShift[]> {
  return (await repo.listShifts(trx, [serviceDayId])).map(asShift);
}

async function shiftsByDay(trx: Trx, ids: string[]): Promise<Map<string, LockedShift[]>> {
  const map = new Map<string, LockedShift[]>(ids.map((id) => [id, []]));
  for (const r of await repo.listShifts(trx, ids)) map.get(r.serviceDayId)!.push(asShift(r));
  return map;
}

const shiftView = (s: LockedShift) => ({
  shift: s.shift,
  cutoffAt: s.cutoffAt.toISOString(),
  freezeAt: s.freezeAt.toISOString(),
  status: s.status,
});
const guardianShift = (s: LockedShift) => ({
  shift: s.shift,
  cutoffAt: s.cutoffAt.toISOString(),
  acceptingOrders: s.status === "open" && s.beforeCutoff,
});

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
  const shifts = await shiftsByDay(trx, [day.id]);
  return {
    serviceDate: day.serviceDate,
    cutoffAt: day.cutoffAt.toISOString(),
    freezeAt: day.freezeAt.toISOString(),
    status: day.status as ServiceDayStatus,
    shifts: shifts.get(day.id)!.map(shiftView),
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
    const shifts = await repo.activeShifts(trx);
    const asked = Object.keys(body.cutoffTimes) as Shift[];
    if (asked.some((s) => !shifts.includes(s))) throw new DomainError("validation_failed", "cutoff for a shift without classes");
    // Turno já fechado ou finalizado mantém o horário (o repo não o reescreve) e não conta para o corte.
    const settled = new Set(
      existing ? (await repo.listShifts(trx, [existing.id])).filter((s) => s.status !== "open").map((s) => s.shift) : [],
    );
    const cutoffs = await repo.computeCutoffs(
      trx,
      serviceDate,
      shifts.map((shift) => ({ shift, time: body.cutoffTimes[shift] ?? null })),
    );
    if (cutoffs.some((c) => !c.inFuture && !settled.has(c.shift))) throw new DomainError("cutoff_passed");
    const dayId = await repo.upsertServiceDay(trx, schoolId, serviceDate, cutoffs);

    const ids = body.items.map((i) => i.menuItemId);
    const active = new Map((await repo.activeMenuItems(trx, ids)).map((m) => [m.id, m.priceCents]));
    if (active.size !== ids.length) throw new DomainError("validation_failed", "unknown or inactive menu item");
    await repo.replaceServiceDayItems(
      trx,
      schoolId,
      dayId,
      body.items.map((i) => ({ menuItemId: i.menuItemId, priceCents: i.priceCents ?? active.get(i.menuItemId)! })),
    );
    return serviceDayView(trx, serviceDate);
  });
}

export async function listServiceDays(session: SessionClaims, from: string | null): Promise<ServiceDayListResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const days = await repo.listServiceDaysFrom(trx, from);
    const ids = days.map((d) => d.id);
    const items = await itemsByDay(trx, ids);
    const shifts = await shiftsByDay(trx, ids);
    return {
      serviceDays: days.map((d) => ({
        serviceDate: d.serviceDate,
        cutoffAt: d.cutoffAt.toISOString(),
        freezeAt: d.freezeAt.toISOString(),
        status: d.status as ServiceDayStatus,
        shifts: shifts.get(d.id)!.map(shiftView),
        items: items.get(d.id)!,
      })),
    };
  });
}

export async function listOpenDaysForGuardian(session: SessionClaims): Promise<GuardianServiceDayListResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const days = await repo.listOpenServiceDays(trx);
    const ids = days.map((d) => d.id);
    const items = await itemsByDay(trx, ids);
    const shifts = await shiftsByDay(trx, ids);
    return {
      serviceDays: days.map((d) => ({
        serviceDate: d.serviceDate,
        cutoffAt: d.cutoffAt.toISOString(),
        items: items.get(d.id)!,
        shifts: shifts.get(d.id)!.map(guardianShift),
      })),
    };
  });
}

export async function guardianMenu(session: SessionClaims, serviceDate: string): Promise<GuardianMenuResponse> {
  return withTenant(session.schoolId, async (trx) => {
    const day = await repo.lockServiceDayByDate(trx, serviceDate, "share");
    if (!day) throw new DomainError("not_found");
    const items = await itemsByDay(trx, [day.id]);
    const shifts = (await shiftsByDay(trx, [day.id])).get(day.id)!.map(guardianShift);
    return {
      serviceDate: day.serviceDate,
      cutoffAt: day.cutoffAt.toISOString(),
      acceptingOrders: day.status === "open" && shifts.some((s) => s.acceptingOrders),
      items: items.get(day.id)!,
      shifts,
    };
  });
}
