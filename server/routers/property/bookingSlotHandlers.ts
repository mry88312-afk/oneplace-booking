/**
 * Handler functions for booking slot availability queries.
 * Extracted from booking.ts for maintainability.
 *
 * 2026-04-17: 改用 Events API 取代 FreeBusy API
 * 原因：FreeBusy API 預設將「尚未接受邀請 (needsAction)」視為「有空」，
 * 導致來不及按接受就被其他人預約了同一時段。
 * 新邏輯：只有 responseStatus === 'declined' 才釋放時段，
 * needsAction / accepted / tentative / owner 都視為「沒空」。
 */
import { TRPCError } from "@trpc/server";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { eq, and } from "drizzle-orm";
import {
  getTaipeiDayOfWeek,
  getCalendarClient,
  resolveTemplateBundle,
} from "./bookingHelpers";

// ─── 共用：從 Events API 取得忙碌時段 ──────────────────────────────────────

interface BusySlot {
  start: string;
  end: string;
}

/**
 * 使用 Google Calendar Events API 查詢指定日曆在時間範圍內的忙碌時段。
 * 與 FreeBusy API 不同，Events API 回傳每個事件的 attendees 和 responseStatus，
 * 讓我們可以自訂判斷邏輯：只有 declined 才釋放時段。
 */
async function getEventsBasedBusySlots(
  calendar: ReturnType<typeof getCalendarClient>,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<BusySlot[]> {
  const busySlots: BusySlot[] = [];

  try {
    const resp = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      // 只需要基本欄位：時間、attendees、status
      fields: "items(start,end,status,attendees,organizer,summary,transparency)",
    });

    const events = resp.data.items || [];

    for (const event of events) {
      // 跳過已取消的事件
      if (event.status === "cancelled") continue;

      // 跳過透明事件（顯示為「有空」的事件）
      if (event.transparency === "transparent") continue;

      // 取得事件的開始和結束時間
      const eventStart = event.start?.dateTime || event.start?.date;
      const eventEnd = event.end?.dateTime || event.end?.date;
      if (!eventStart || !eventEnd) continue;

      // 判斷「自己」在此事件中的出席狀態
      // Service Account 存取共用日曆時，可能不在 attendees 中
      // 如果沒有 attendees（自己建立的事件），預設視為忙碌
      let isDeclined = false;

      if (event.attendees && event.attendees.length > 0) {
        // 找到「自己」的出席狀態（self: true 或 日曆擁有者）
        const myAttendee = event.attendees.find(
          (a) => a.self === true
        );

        if (myAttendee) {
          // 核心判定：只有 'declined' 才視為有空，其他都視為沒空
          // responseStatus: 'needsAction' | 'declined' | 'tentative' | 'accepted'
          if (myAttendee.responseStatus === "declined") {
            isDeclined = true;
          }
        }
        // 如果找不到 self=true 的 attendee（Service Account 情境），
        // 預設視為忙碌（保守策略）
      }

      if (!isDeclined) {
        busySlots.push({
          start: eventStart,
          end: eventEnd,
        });
      }
    }
  } catch (err: any) {
    console.error(`[Events API] Error fetching events for ${calendarId}:`, err.message);
    // 如果 Events API 失敗，fallback 到 FreeBusy API
    console.log(`[Events API] Falling back to FreeBusy API for ${calendarId}`);
    try {
      const freeBusyResp = await calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          timeZone: "Asia/Taipei",
          items: [{ id: calendarId }],
        },
      });
      const fbBusy = freeBusyResp.data.calendars?.[calendarId]?.busy || [];
      for (const slot of fbBusy) {
        if (slot.start && slot.end) {
          busySlots.push({ start: slot.start, end: slot.end });
        }
      }
    } catch (fbErr: any) {
      console.error(`[FreeBusy Fallback] Also failed for ${calendarId}:`, fbErr.message);
    }
  }

  return busySlots;
}

// ─── 共用：計算單一規則在某天的「生效時段」 ────────────────────────────────
/**
 * 優先序（與各 handler 檔頭一致）：
 *   weeklyHours[day] 為「當日總表硬上限」 > rule 自訂時段（僅能在上限內縮小）> template.dailyStart/End
 *
 * 重點：規則的 weeklyStartTime/EndTime 只能把時段「縮小」，
 * 不能放寬到超出 weeklyHours 當日設定 —— 避免規則時段填太寬而開出總表以外的時段。
 * 回傳零補位 "HH:MM"，可直接字典序比較。
 */
function resolveRuleTimeWindow(
  rule: { weeklyStartTime?: string | null; weeklyEndTime?: string | null },
  dayCap: { start: string; end: string } | null,
  templateDailyStart: string,
  templateDailyEnd: string,
): { start: string; end: string } {
  const defStart = dayCap ? dayCap.start : templateDailyStart;
  const defEnd = dayCap ? dayCap.end : templateDailyEnd;
  let start = rule.weeklyStartTime || defStart;
  let end = rule.weeklyEndTime || defEnd;
  // weeklyHours 為當日上限：規則時段只能縮不能放寬（取交集）
  if (dayCap) {
    if (start < dayCap.start) start = dayCap.start;
    if (end > dayCap.end) end = dayCap.end;
  }
  return { start, end };
}

// ─── handleGetAvailableSlots（單日） ────────────────────────────────────────

export async function handleGetAvailableSlots(input: {
  projectId: string;
  date: string;
}) {
  // DB 優先 + hardcode fallback
  const bundle = await resolveTemplateBundle(input.projectId);
  if (!bundle) throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在" });
  const template = bundle.template;
  const rules = bundle.rules;

  const dayOfWeek = getTaipeiDayOfWeek(input.date);

  const matchingRules = rules.filter((rule) => {
    const days = rule.days as number[];
    return days.includes(dayOfWeek);
  });

  if (matchingRules.length === 0) {
    return { slots: [], calendarOwner: null, message: "該日期無可用時段" };
  }

  // ═══ 檢查 weeklyHours ═══
  const weeklyHours = (template as any).weeklyHours as Record<string, { start: string; end: string } | null> | null;
  if (weeklyHours) {
    const dayConfig = weeklyHours[String(dayOfWeek)];
    if (dayConfig === null || dayConfig === undefined) {
      console.log(`[Calendar Fetch] weeklyHours: day ${dayOfWeek} is Unavailable`);
      return { slots: [], calendarOwner: null, message: "該日期未開放預約" };
    }
  }

  try {
    const calendar = getCalendarClient();

    // ═══ 時段優先序：weeklyHours[day] 為當日硬上限 > rule 自訂時段（僅能在上限內縮小）> template.dailyStart/End ═══
    const dayCap = weeklyHours ? (weeklyHours[String(dayOfWeek)] || null) : null;

    let globalStartH = 23, globalStartM = 59;
    let globalEndH = 0, globalEndM = 0;
    const ruleTimeRanges: Map<number, { startH: number; startM: number; endH: number; endM: number }> = new Map();

    for (let i = 0; i < matchingRules.length; i++) {
      const rule = matchingRules[i];
      const { start: rStartTime, end: rEndTime } = resolveRuleTimeWindow(
        rule as any, dayCap, template.dailyStartTime, template.dailyEndTime,
      );
      const [sH, sM] = rStartTime.split(":").map(Number);
      const [eH, eM] = rEndTime.split(":").map(Number);
      ruleTimeRanges.set(i, { startH: sH, startM: sM, endH: eH, endM: eM });
      if (sH < globalStartH || (sH === globalStartH && sM < globalStartM)) { globalStartH = sH; globalStartM = sM; }
      if (eH > globalEndH || (eH === globalEndH && eM > globalEndM)) { globalEndH = eH; globalEndM = eM; }
    }

    const bufferMin = template.bufferMinutes || 0;
    const bufferDir = (template as any).bufferDirection || "after";

    console.log(`[Calendar Fetch] date=${input.date}, dayOfWeek=${dayOfWeek}, matchingRules=${matchingRules.length}, buffer=${bufferMin}min (${bufferDir})`);
    for (let i = 0; i < matchingRules.length; i++) {
      const rule = matchingRules[i];
      const tr = ruleTimeRanges.get(i)!;
      console.log(`[Calendar Fetch] Rule #${i}: calendarId=${rule.calendarId}, owner=${rule.ownerName}, time=${String(tr.startH).padStart(2,"0")}:${String(tr.startM).padStart(2,"0")}-${String(tr.endH).padStart(2,"0")}:${String(tr.endM).padStart(2,"0")}`);
    }

    const timeMin = new Date(`${input.date}T${String(globalStartH).padStart(2, "0")}:${String(globalStartM).padStart(2, "0")}:00+08:00`);
    const timeMax = new Date(`${input.date}T${String(globalEndH).padStart(2, "0")}:${String(globalEndM).padStart(2, "0")}:00+08:00`);

    // ═══ 改用 Events API 取得忙碌時段（含 needsAction 判斷） ═══
    const uniqueCalendarIds = [...new Set(matchingRules.map((r) => r.calendarId))];
    console.log(`[Calendar Fetch] Events API query: timeMin=${timeMin.toISOString()}, timeMax=${timeMax.toISOString()}, calendars=${uniqueCalendarIds.join(", ")}`);

    const busyByCalendar: Record<string, BusySlot[]> = {};
    await Promise.all(
      uniqueCalendarIds.map(async (calId) => {
        const busySlots = await getEventsBasedBusySlots(
          calendar,
          calId,
          timeMin.toISOString(),
          timeMax.toISOString(),
        );
        busyByCalendar[calId] = busySlots;
        const ownerNames = matchingRules.filter(r => r.calendarId === calId).map(r => r.ownerName).join("/");
        console.log(`[Calendar Fetch] Events-based busy data for ${calId} (${ownerNames}):`, JSON.stringify(busySlots));
      })
    );

    // ═══ 衝突判斷輔助函數（根據 buffer 方向） ═══
    const isSlotBusyOnCalendar = (slotStart: Date, slotEnd: Date, calId: string): boolean => {
      const expandedStart = (bufferDir === "before" || bufferDir === "both")
        ? new Date(slotStart.getTime() - bufferMin * 60000)
        : slotStart;
      const expandedEnd = (bufferDir === "after" || bufferDir === "both")
        ? new Date(slotEnd.getTime() + bufferMin * 60000)
        : slotEnd;

      const busySlots = busyByCalendar[calId] || [];
      return busySlots.some((busy) => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        const expandedBusyStart = (bufferDir === "before" || bufferDir === "both")
          ? new Date(busyStart.getTime() - bufferMin * 60000)
          : busyStart;
        const expandedBusyEnd = (bufferDir === "after" || bufferDir === "both")
          ? new Date(busyEnd.getTime() + bufferMin * 60000)
          : busyEnd;
        return expandedStart < expandedBusyEnd && expandedEnd > expandedBusyStart;
      });
    };

    // ═══ 產生時段：以 30 分鐘為步進間隔 ═══
    const slotDuration = template.slotDurationMinutes;
    const STEP_MINUTES = 30;
    const current = new Date(timeMin);

    const slots: Array<{
      startTime: string;
      endTime: string;
      available: boolean;
      calendarId?: string;
      calendarOwner?: string;
    }> = [];

    while (current.getTime() + slotDuration * 60000 <= timeMax.getTime()) {
      const slotStart = new Date(current);
      const slotEnd = new Date(current.getTime() + slotDuration * 60000);

      const applicableRules: Array<{ ruleIndex: number; rule: typeof matchingRules[0] }> = [];
      for (let i = 0; i < matchingRules.length; i++) {
        const tr = ruleTimeRanges.get(i)!;
        const ruleStart = new Date(`${input.date}T${String(tr.startH).padStart(2, "0")}:${String(tr.startM).padStart(2, "0")}:00+08:00`);
        const ruleEnd = new Date(`${input.date}T${String(tr.endH).padStart(2, "0")}:${String(tr.endM).padStart(2, "0")}:00+08:00`);
        if (slotStart.getTime() >= ruleStart.getTime() && slotEnd.getTime() <= ruleEnd.getTime()) {
          applicableRules.push({ ruleIndex: i, rule: matchingRules[i] });
        }
      }

      let slotAvailable = false;
      let assignedOwner = "";

      if (applicableRules.length > 0) {
        const allFree = applicableRules.every(({ rule }) => {
          const busy = isSlotBusyOnCalendar(slotStart, slotEnd, rule.calendarId);
          if (busy) {
            console.log(`[Conflict Check] Slot ${slotStart.toISOString()} - ${slotEnd.toISOString()} BUSY on ${rule.calendarId} (${rule.ownerName})`);
          }
          return !busy;
        });

        if (allFree) {
          slotAvailable = true;
          const primaryRule = applicableRules.reduce((best, curr) =>
            curr.rule.sortOrder < best.rule.sortOrder ? curr : best
          );
          assignedOwner = primaryRule.rule.ownerName;
        }
      }

      if (slotAvailable) {
        slots.push({
          startTime: slotStart.toISOString(),
          endTime: slotEnd.toISOString(),
          available: true,
          calendarOwner: assignedOwner || undefined,
        });
      } else {
        slots.push({
          startTime: slotStart.toISOString(),
          endTime: slotEnd.toISOString(),
          available: false,
        });
      }

      current.setTime(current.getTime() + STEP_MINUTES * 60000);
    }

    const availableCount = slots.filter(s => s.available).length;
    console.log(`[Calendar Fetch] date=${input.date}, dayOfWeek=${dayOfWeek}, Result: ${slots.length} total slots, ${availableCount} available, step=${STEP_MINUTES}min, duration=${slotDuration}min`);

    return {
      slots,
      calendarOwner: matchingRules[0].ownerName,
      calendarId: matchingRules[0].calendarId,
    };
  } catch (err: any) {
    console.error("[Calendar Fetch] Google Calendar error:", err.message, err.stack);
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "無法查詢日曆，請稍後再試",
    });
  }
}

// ─── handleGetAvailableSlotsMultiDay（多日） ────────────────────────────────

export async function handleGetAvailableSlotsMultiDay(input: {
  projectId: string;
  dates: string[];
}) {
  // DB 優先 + hardcode fallback
  const bundle = await resolveTemplateBundle(input.projectId);
  if (!bundle) throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在" });
  const template = bundle.template;
  const rules = bundle.rules;

  const weeklyHours = (template as any).weeklyHours as Record<string, { start: string; end: string } | null> | null;
  const bufferMin = template.bufferMinutes || 0;
  const bufferDir = (template as any).bufferDirection || "after";
  const slotDuration = template.slotDurationMinutes;
  const STEP_MINUTES = 30;

  // 過濾有效日期
  const validDates: Array<{ date: string; dayOfWeek: number; startTime: string; endTime: string; matchingRules: typeof rules }> = [];
  for (const dateStr of input.dates) {
    const dayOfWeek = getTaipeiDayOfWeek(dateStr);
    const matchingRules = rules.filter((rule) => {
      const days = rule.days as number[];
      return days.includes(dayOfWeek);
    });
    if (matchingRules.length === 0) continue;

    if (weeklyHours) {
      const dayConfig = weeklyHours[String(dayOfWeek)];
      if (dayConfig === null || dayConfig === undefined) continue;
    }

    const dayCap = weeklyHours ? (weeklyHours[String(dayOfWeek)] || null) : null;

    let startH = 23, startM = 59, endH = 0, endM = 0;
    for (const rule of matchingRules) {
      const { start: rStart, end: rEnd } = resolveRuleTimeWindow(
        rule as any, dayCap, template.dailyStartTime, template.dailyEndTime,
      );
      const [sH, sM] = rStart.split(":").map(Number);
      const [eH, eM] = rEnd.split(":").map(Number);
      if (sH < startH || (sH === startH && sM < startM)) { startH = sH; startM = sM; }
      if (eH > endH || (eH === endH && eM > endM)) { endH = eH; endM = eM; }
    }

    validDates.push({
      date: dateStr,
      dayOfWeek,
      startTime: `${String(startH).padStart(2, "0")}:${String(startM).padStart(2, "0")}`,
      endTime: `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`,
      matchingRules,
    });
  }

  if (validDates.length === 0) {
    return { slotsByDate: {} };
  }

  // ═══ 改用 Events API 取得忙碌時段 ═══
  const firstDate = validDates[0].date;
  const lastDate = validDates[validDates.length - 1].date;
  const globalTimeMin = new Date(`${firstDate}T00:00:00+08:00`);
  const globalTimeMax = new Date(`${lastDate}T23:59:59+08:00`);

  const uniqueCalendarIds = [...new Set(rules.map((r) => r.calendarId))];

  let busyByCalendar: Record<string, BusySlot[]> = {};
  try {
    const calendar = getCalendarClient();
    await Promise.all(
      uniqueCalendarIds.map(async (calId) => {
        const busySlots = await getEventsBasedBusySlots(
          calendar,
          calId,
          globalTimeMin.toISOString(),
          globalTimeMax.toISOString(),
        );
        busyByCalendar[calId] = busySlots;
      })
    );
  } catch (err: any) {
    console.error("[MultiDay] Google Calendar error:", err.message);
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "無法查詢日曆" });
  }

  const slotsByDate: Record<string, Array<{
    startTime: string;
    endTime: string;
    available: boolean;
    calendarOwner?: string;
  }>> = {};

  const isSlotBusy = (slotStart: Date, slotEnd: Date, calId: string): boolean => {
    const expandedStart = (bufferDir === "before" || bufferDir === "both")
      ? new Date(slotStart.getTime() - bufferMin * 60000) : slotStart;
    const expandedEnd = (bufferDir === "after" || bufferDir === "both")
      ? new Date(slotEnd.getTime() + bufferMin * 60000) : slotEnd;
    const busySlots = busyByCalendar[calId] || [];
    return busySlots.some((busy) => {
      const busyStart = new Date(busy.start);
      const busyEnd = new Date(busy.end);
      const expandedBusyStart = (bufferDir === "before" || bufferDir === "both")
        ? new Date(busyStart.getTime() - bufferMin * 60000) : busyStart;
      const expandedBusyEnd = (bufferDir === "after" || bufferDir === "both")
        ? new Date(busyEnd.getTime() + bufferMin * 60000) : busyEnd;
      return expandedStart < expandedBusyEnd && expandedEnd > expandedBusyStart;
    });
  };

  for (const vd of validDates) {
    const timeMin = new Date(`${vd.date}T${vd.startTime}:00+08:00`);
    const timeMax = new Date(`${vd.date}T${vd.endTime}:00+08:00`);

    const dayCap = weeklyHours ? (weeklyHours[String(vd.dayOfWeek)] || null) : null;
    const ruleTimeRanges: Map<number, { startH: number; startM: number; endH: number; endM: number }> = new Map();
    for (let i = 0; i < vd.matchingRules.length; i++) {
      const rule = vd.matchingRules[i];
      const { start: rStart, end: rEnd } = resolveRuleTimeWindow(
        rule as any, dayCap, template.dailyStartTime, template.dailyEndTime,
      );
      const [sH, sM] = rStart.split(":").map(Number);
      const [eH, eM] = rEnd.split(":").map(Number);
      ruleTimeRanges.set(i, { startH: sH, startM: sM, endH: eH, endM: eM });
    }

    const current = new Date(timeMin);
    const dateSlots: typeof slotsByDate[string] = [];

    while (current.getTime() + slotDuration * 60000 <= timeMax.getTime()) {
      const slotStart = new Date(current);
      const slotEnd = new Date(current.getTime() + slotDuration * 60000);

      const applicableRules: Array<{ ruleIndex: number; rule: typeof vd.matchingRules[0] }> = [];
      for (let i = 0; i < vd.matchingRules.length; i++) {
        const tr = ruleTimeRanges.get(i)!;
        const ruleStart = new Date(`${vd.date}T${String(tr.startH).padStart(2, "0")}:${String(tr.startM).padStart(2, "0")}:00+08:00`);
        const ruleEnd = new Date(`${vd.date}T${String(tr.endH).padStart(2, "0")}:${String(tr.endM).padStart(2, "0")}:00+08:00`);
        if (slotStart.getTime() >= ruleStart.getTime() && slotEnd.getTime() <= ruleEnd.getTime()) {
          applicableRules.push({ ruleIndex: i, rule: vd.matchingRules[i] });
        }
      }

      let slotAvailable = false;
      let assignedOwner = "";

      if (applicableRules.length > 0) {
        const allFree = applicableRules.every(({ rule }) => !isSlotBusy(slotStart, slotEnd, rule.calendarId));
        if (allFree) {
          slotAvailable = true;
          const primaryRule = applicableRules.reduce((best, curr) =>
            curr.rule.sortOrder < best.rule.sortOrder ? curr : best
          );
          assignedOwner = primaryRule.rule.ownerName;
        }
      }

      if (slotAvailable) {
        dateSlots.push({
          startTime: slotStart.toISOString(),
          endTime: slotEnd.toISOString(),
          available: true,
          calendarOwner: assignedOwner || undefined,
        });
      }

      current.setTime(current.getTime() + STEP_MINUTES * 60000);
    }

    if (dateSlots.length > 0) {
      slotsByDate[vd.date] = dateSlots;
    }
  }

  console.log(`[MultiDay] Queried ${input.dates.length} dates, ${validDates.length} valid, ${Object.keys(slotsByDate).length} with available slots`);
  return { slotsByDate };
}
