import { and, eq, gte, inArray, lt, type SQL } from "drizzle-orm";
import { bookingRecords, bookingTemplates } from "../../../drizzle/schema";
import { errorCode } from "../../../shared/bookingErrors";
import { projectIdsForBookingActions } from "../../config/bookingActions";
import { getDb } from "../../db";
import { resolveResidences, sbQuery } from "../../db/supabaseClient";

export const CHECKOUT_GROUP_RULE_KEY = "checkout_group_d3";

export function checkoutGroupHubOutcome(result: { ok?: boolean; deliveryStatus?: unknown; error?: string } | null) {
  const status = result?.deliveryStatus;
  if (result?.ok === true) {
    if (status === "sent" || status === "duplicate") return { status: "sent" } as const;
    if (status === "property_not_found" || status === "ambiguous_property" || status === "no_group") {
      return { status: "skipped", reason: status } as const;
    }
    if (status === "outbound_disabled") return { status: "failed", error: status } as const;
  }
  return { status: "failed", error: result?.error || "群組通知回應未確認" } as const;
}

export const CHECKOUT_GROUP_DEFAULT_TEXT = `❗️倒數三天重要提醒

室友們
{{room}}房{{tenant_name}}預計於{{checkout_month}}月{{checkout_day}}日退租，退租前請大家一起確認以下事項：

1. 能源費／公共費用
    水、電、瓦斯或其他共同費用，請先和室友們確認結清方式，結清後再退出室友群組。

2. 公區個人物品
    放在客廳、廚房、冰箱、浴室等公共區域的個人物品（包含垃圾、回收物及不再使用的皆需確認帶走）

3. 退租垃圾
    退租室友需自行清理所有個人垃圾。若退租垃圾超出垃圾代收的單次收取上限，將另外收取 2,000 元清潔處理費。`;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const checkoutProjectIds = projectIdsForBookingActions(["退租"]);

export function isCheckoutReminderProject(projectId: string) {
  return checkoutProjectIds.includes(projectId);
}

function taipeiIso(ms: unknown) {
  if (typeof ms !== "number") return "";
  const shifted = new Date(ms + 8 * HOUR_MS);
  return Number.isFinite(shifted.getTime()) ? shifted.toISOString() : "";
}

export function taipeiYmd(ms: unknown) {
  return taipeiIso(ms).slice(0, 10);
}

export function taipeiHm(ms: unknown) {
  return taipeiIso(ms).slice(11, 16);
}

export function checkoutGroupScanWindow(now: number) {
  const midnight = Date.parse(`${taipeiYmd(now)}T00:00:00+08:00`);
  return {
    from: midnight + 3 * DAY_MS,
    until: midnight + 4 * DAY_MS,
    sendAt: midnight + 18 * HOUR_MS,
  };
}

export function planCheckoutGroupReminder(bookingTime: unknown, now: number, alreadySentOnReschedule = false) {
  const date = taipeiYmd(bookingTime);
  const { from, sendAt } = checkoutGroupScanWindow(now);
  const today = taipeiYmd(now);
  const threeDaysAway = taipeiYmd(from);
  if (!date || date < today || date > threeDaysAway) return null;
  if (date === threeDaysAway && now < sendAt) return { sendAt, immediate: false };
  if (alreadySentOnReschedule) return null;
  return { sendAt: now, immediate: true };
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedRoom(value: unknown): string {
  return cleanText(value).normalize("NFKC").replace(/\s/g, "").toLowerCase();
}

type ResidenceFields = { room?: unknown; contractNo?: unknown; property?: unknown; propertyId?: unknown };

export function selectCheckoutGroupResidence(residences: unknown, roomNumber: unknown) {
  if (!Array.isArray(residences) || residences.length === 0) return { residence: null, reason: "no_residence" };
  const candidates = residences.filter((row): row is ResidenceFields =>
    row && typeof row === "object" && !Array.isArray(row) && "room" in row && Boolean(normalizedRoom(row.room)),
  );
  const room = normalizedRoom(roomNumber);
  const matches = residences.length === 1 ? candidates : candidates.filter(row => room && normalizedRoom(row.room) === room);
  if (matches.length === 1) return { residence: matches[0], reason: "" };
  return { residence: null, reason: matches.length > 1 ? "ambiguous_residence" : "room_not_matched" };
}

type CheckoutBooking = Pick<typeof bookingRecords.$inferSelect, "id" | "tenantUid" | "tenantName" | "roomNumber" | "bookingTime">;
type CheckoutContext = { siteNo: string; tenantName: string; room: string; propertyName: string };

export async function resolveCheckoutGroupContext(
  booking: Pick<CheckoutBooking, "tenantUid" | "roomNumber" | "tenantName">,
  deps = { resolveResidences, sbQuery },
): Promise<{ context: CheckoutContext | null; reason: string }> {
  const lineUid = cleanText(booking.tenantUid);
  if (!lineUid || lineUid === "unknown") return { context: null, reason: "no_tenant_uid" };
  const { residence, reason } = selectCheckoutGroupResidence(
    await deps.resolveResidences({ lineUid, includeExpiredCheckout: true }), booking.roomNumber,
  );
  if (!residence) return { context: null, reason };
  const propertyId = cleanText(residence.propertyId);
  if (!propertyId) return { context: null, reason: "property_not_found" };

  const [property] = await deps.sbQuery<{
    site_no: string | number | null;
    short_name: string | null;
    ownership_region: string | null;
    hq_internal_category: string | null;
  }>(
    `select site_no, short_name, ownership_region, hq_internal_category
       from property.properties where id=$1 and deleted_at is null`,
    [propertyId],
  );
  if (!property) return { context: null, reason: "property_not_found" };
  const siteNo = typeof property.site_no === "number" && Number.isFinite(property.site_no)
    ? String(property.site_no) : cleanText(property.site_no);
  // 沿用租金提醒的案場歸屬欄位，另外排除標為外來的案場。
  const excludedCategories = ["靠行", "加盟", "外來"];
  const exclusion = property.ownership_region !== "總公司" || excludedCategories.includes(cleanText(property.hq_internal_category));
  const contractNo = cleanText(residence.contractNo);
  const names = contractNo ? await deps.sbQuery<{ name: string }>(
    `select distinct trim(t.primary_name) as name
       from contract.tenant_contracts tc
       join contract.tenant_contract_parties pa on pa.tenant_contract_id=tc.id
       join contract.tenants t on t.id=pa.tenant_id
      where tc.contract_no=$1 and tc.property_id=$2 and tc.deleted_at is null
        and t.line_uid=$3 and t.deleted_at is null and nullif(trim(t.primary_name),'') is not null
      limit 2`,
    [contractNo, propertyId, lineUid],
  ) : [];

  return {
    context: {
      siteNo: exclusion ? "" : siteNo,
      tenantName: (names.length === 1 ? cleanText(names[0]?.name) : "") || cleanText(booking.tenantName),
      room: cleanText(residence.room),
      propertyName: cleanText(property.short_name) || cleanText(residence.property),
    },
    reason: exclusion ? "ineligible_property" : siteNo ? "" : "property_missing_site_no",
  };
}

export async function enqueueCheckoutGroupReminder(
  booking: CheckoutBooking,
  sendAtIso: string,
  deps = { resolveContext: resolveCheckoutGroupContext, query: sbQuery },
) {
  const bookingDate = taipeiYmd(booking.bookingTime);
  const scheduledDate = taipeiYmd(Date.parse(sendAtIso));
  if (!bookingDate || !scheduledDate) throw new Error("退租提醒排程日期無效");
  const { context, reason } = await deps.resolveContext(booking).catch(error => {
    console.error(`[outreach] 退租群組提醒資料解析失敗（預約 ${booking.id}）`, errorCode(error));
    return { context: null, reason: "context_lookup_failed" };
  });
  const [, month, day] = bookingDate.split("-");
  const vars = {
    booking_id: booking.id,
    booking_date: bookingDate,
    booking_time: taipeiHm(booking.bookingTime),
    tenant_name: context?.tenantName ?? cleanText(booking.tenantName),
    room: context?.room ?? cleanText(booking.roomNumber),
    site_no: context?.siteNo ?? "",
    checkout_month: String(Number(month)),
    checkout_day: String(Number(day)),
    context_error: reason,
  };
  const [row] = await deps.query<{ id: string }>(
    `insert into outreach.schedule
       (tenant_uid, tenant_name, room, property_name, rule_key, scheduled_date, status, send_at, source, vars, dedupe_key)
     values ($1,$2,$3,$4,$5,$6::date,'confirmed',$7::timestamptz,'booking',$8::jsonb,$9)
     on conflict (dedupe_key) where dedupe_key is not null do nothing returning id`,
    [booking.tenantUid, vars.tenant_name, vars.room, context?.propertyName || null,
      CHECKOUT_GROUP_RULE_KEY, scheduledDate, sendAtIso, JSON.stringify(vars),
      `${CHECKOUT_GROUP_RULE_KEY}:${booking.id}:${bookingDate}`],
  );
  return row?.id;
}

async function confirmedCheckoutBookings(...filters: SQL[]) {
  const db = await getDb();
  if (!db) throw new Error("預約資料庫無法連線");
  return db.select({
    id: bookingRecords.id,
    tenantUid: bookingRecords.tenantUid,
    tenantName: bookingRecords.tenantName,
    roomNumber: bookingRecords.roomNumber,
    bookingTime: bookingRecords.bookingTime,
  }).from(bookingRecords)
    .innerJoin(bookingTemplates, eq(bookingRecords.templateId, bookingTemplates.id))
    .where(and(inArray(bookingTemplates.projectId, checkoutProjectIds), eq(bookingRecords.status, "confirmed"), ...filters));
}

export async function scanCheckoutGroupReminders() {
  const { from, until, sendAt } = checkoutGroupScanWindow(Date.now());
  const bookings = await confirmedCheckoutBookings(gte(bookingRecords.bookingTime, from), lt(bookingRecords.bookingTime, until));
  const sendAtIso = new Date(sendAt).toISOString();
  let inserted = 0;
  let failed = 0;
  for (const booking of bookings) {
    try {
      if (await enqueueCheckoutGroupReminder(booking, sendAtIso)) inserted++;
    } catch (error) {
      failed++;
      console.error(`[outreach] 退租群組提醒建立排程失敗（預約 ${booking.id}）`, errorCode(error));
    }
  }
  return { ok: failed === 0, scanned: bookings.length, inserted, failed };
}

export async function maybeEnqueueImmediateCheckoutGroupReminder(
  bookingId: number,
  { isReschedule }: { isReschedule: boolean },
) {
  const [booking] = await confirmedCheckoutBookings(eq(bookingRecords.id, bookingId));
  if (!booking) return;
  const now = Date.now();
  const plan = planCheckoutGroupReminder(booking.bookingTime, now);
  if (!plan) return;
  if (isReschedule && plan.immediate) {
    const sent = await sbQuery<{ id: string }>(
      `select id from outreach.schedule where rule_key=$1 and vars->>'booking_id'=$2 and status='sent' limit 1`,
      [CHECKOUT_GROUP_RULE_KEY, String(bookingId)],
    );
    if (!planCheckoutGroupReminder(booking.bookingTime, now, sent.length > 0)) return;
  }
  const id = await enqueueCheckoutGroupReminder(booking, new Date(plan.sendAt).toISOString());
  if (id && plan.immediate) {
    void import("./outreachHandlers").then(async ({ runOutreach }) => {
      const { errors } = await runOutreach([id]);
      if (errors.length) console.error(`[outreach] 退租群組提醒補發失敗（排程 ${id}）`, errors[0].error);
    }).catch(error => console.error(`[outreach] 退租群組提醒補發失敗（排程 ${id}）`, errorCode(error)));
  }
}
