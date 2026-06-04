/**
 * 預約 router
 * - 租客端 publicProcedure（取模版、驗證、查時段、確認預約）
 * - 後台 adminProcedure（模版 CRUD、預約清單、取消、日曆驗證）— P19a 從主系統搬入
 *
 * 模版資料來源：DB 優先 + hardcode fallback（見 bookingHelpers.resolveTemplateBundle）
 */
import { z } from "zod";
import { router, publicProcedure, adminProcedure } from "../../_core/trpc";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { eq, and, desc } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  handleGetAvailableSlots,
  handleGetAvailableSlotsMultiDay,
} from "./bookingSlotHandlers";
import { handleConfirmBooking } from "./bookingConfirmHandler";
import {
  handleVerifyTenantUid,
  handleVerifyByPhone,
} from "./bookingVerifyHandlers";
import {
  resolveTemplateBundle,
  getCalendarClient,
  loadServiceAccountCredentials,
} from "./bookingHelpers";
import {
  handleCreateTemplate,
  handleUpdateTemplate,
} from "./bookingTemplateHandlers";
import {
  handleGetBookingForReschedule,
  handleCancelBookingPublic,
  handleRescheduleBooking,
} from "./bookingRescheduleHandlers";

export const bookingRouter = router({
  // ─── 後台 admin API（需 x-admin-password）— P19a 從主系統搬入 ──────────────

  /** 列出所有模版 */
  listTemplates: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select()
      .from(schema.bookingTemplates)
      .orderBy(desc(schema.bookingTemplates.createdAt));
  }),

  /** 取得單一模版（含分流規則和表單欄位） */
  getTemplate: adminProcedure
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "DB not available" });

      const [template] = await db
        .select()
        .from(schema.bookingTemplates)
        .where(eq(schema.bookingTemplates.id, input.id));
      if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "模版不存在" });

      const rules = await db
        .select()
        .from(schema.calendarRoutingRules)
        .where(eq(schema.calendarRoutingRules.templateId, input.id))
        .orderBy(schema.calendarRoutingRules.sortOrder);

      const fields = await db
        .select()
        .from(schema.bookingFormFields)
        .where(eq(schema.bookingFormFields.templateId, input.id))
        .orderBy(schema.bookingFormFields.sortOrder);

      return { ...template, rules, fields };
    }),

  /** 建立模版 */
  createTemplate: adminProcedure
    .input(
      z.object({
        projectId: z.string().min(1).max(128),
        name: z.string().min(1).max(255),
        templateType: z.string().min(1).max(64),
        liffId: z.string().optional(),
        ragicSearchPath: z.string().min(1),
        ragicUidField: z.string().min(1),
        ragicTaskPath: z.string().min(1),
        slotDurationMinutes: z.number().int().min(10).max(480).default(60),
        bookableDaysAhead: z.number().int().min(1).max(90).default(14),
        dailyStartTime: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
        dailyEndTime: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
        bufferMinutes: z.number().int().min(0).max(120).default(0),
        bufferDirection: z.enum(["before", "after", "both"]).default("after"),
        weeklyHours: z.record(z.string(), z.object({ start: z.string(), end: z.string() }).nullable()).optional(),
        instructionEnabled: z.boolean().optional().default(false),
        instructionText: z.string().optional().nullable(),
        minLeadDays: z.number().int().min(0).max(30).default(0),
        contractAction: z.string().max(32).optional().nullable(),
        rules: z.array(
          z.object({
            days: z.array(z.number().int().min(0).max(6)),
            calendarId: z.string().min(1),
            calendarLabel: z.string().optional().nullable(),
            ownerName: z.string().min(1),
            weeklyStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
            weeklyEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
          }),
        ).min(1),
        fields: z.array(
          z.object({
            fieldType: z.enum(["text", "select", "file", "description", "checkbox", "line_uid", "inbox_url"]),
            label: z.string().default(""),
            isRequired: z.boolean().default(false),
            options: z.array(z.string()).optional().nullable(),
            ragicFieldId: z.string().optional().nullable(),
            descriptionText: z.string().optional().nullable(),
            allowOther: z.boolean().optional().default(false),
            selectionMode: z.enum(["radio", "checkbox"]).optional().default("checkbox"),
          }),
        ).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return handleCreateTemplate(input);
    }),

  /** 更新模版 */
  updateTemplate: adminProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        templateType: z.string().min(1).max(64).optional(),
        liffId: z.string().optional().nullable(),
        ragicSearchPath: z.string().min(1).optional(),
        ragicUidField: z.string().min(1).optional(),
        ragicTaskPath: z.string().min(1).optional(),
        slotDurationMinutes: z.number().int().min(10).max(480).optional(),
        bookableDaysAhead: z.number().int().min(1).max(90).optional(),
        dailyStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        dailyEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        bufferMinutes: z.number().int().min(0).max(120).optional(),
        bufferDirection: z.enum(["before", "after", "both"]).optional(),
        weeklyHours: z.record(z.string(), z.object({ start: z.string(), end: z.string() }).nullable()).optional(),
        instructionEnabled: z.boolean().optional(),
        instructionText: z.string().optional().nullable(),
        minLeadDays: z.number().int().min(0).max(30).optional(),
        contractAction: z.string().max(32).optional().nullable(),
        isActive: z.boolean().optional(),
        rules: z.array(
          z.object({
            days: z.array(z.number().int().min(0).max(6)),
            calendarId: z.string().min(1),
            calendarLabel: z.string().optional().nullable(),
            ownerName: z.string().min(1),
            weeklyStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
            weeklyEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
          }),
        ).optional(),
        fields: z.array(
          z.object({
            fieldType: z.enum(["text", "select", "file", "description", "checkbox", "line_uid", "inbox_url"]),
            label: z.string().default(""),
            isRequired: z.boolean().default(false),
            options: z.array(z.string()).optional().nullable(),
            ragicFieldId: z.string().optional().nullable(),
            descriptionText: z.string().optional().nullable(),
            allowOther: z.boolean().optional().default(false),
            selectionMode: z.enum(["radio", "checkbox"]).optional().default("checkbox"),
          }),
        ).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return handleUpdateTemplate(input);
    }),

  /** 刪除模版 */
  deleteTemplate: adminProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await db.delete(schema.calendarRoutingRules).where(eq(schema.calendarRoutingRules.templateId, input.id));
      await db.delete(schema.bookingFormFields).where(eq(schema.bookingFormFields.templateId, input.id));
      await db.delete(schema.bookingTemplates).where(eq(schema.bookingTemplates.id, input.id));
      return { success: true };
    }),

  /** 預約清單（Zeabur 無 users 表，不 join，直接用 tenantName） */
  listBookings: adminProcedure
    .input(
      z.object({
        templateId: z.number().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const base = db.select().from(schema.bookingRecords);
      if (input.templateId) {
        return base
          .where(eq(schema.bookingRecords.templateId, input.templateId))
          .orderBy(desc(schema.bookingRecords.bookingTime))
          .limit(input.limit);
      }
      return base
        .orderBy(desc(schema.bookingRecords.bookingTime))
        .limit(input.limit);
    }),

  /** 取消預約（同時刪 Google Calendar 事件） */
  cancelBooking: adminProcedure
    .input(z.object({ id: z.number(), reason: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

      const [booking] = await db
        .select()
        .from(schema.bookingRecords)
        .where(eq(schema.bookingRecords.id, input.id));
      if (!booking) throw new TRPCError({ code: "NOT_FOUND" });

      if (booking.googleEventId && booking.googleCalendarId) {
        try {
          const calendar = getCalendarClient();
          await calendar.events.delete({
            calendarId: booking.googleCalendarId,
            eventId: booking.googleEventId,
          });
          console.log(`[Booking] Deleted Google Calendar event: ${booking.googleEventId}`);
        } catch (err: any) {
          console.error("[Booking] Failed to delete calendar event:", err.message);
        }
      }

      await db
        .update(schema.bookingRecords)
        .set({ status: "cancelled", cancelReason: input.reason || null })
        .where(eq(schema.bookingRecords.id, input.id));
      return { success: true };
    }),

  /** 驗證 Google Calendar 是否可存取 */
  validateCalendar: adminProcedure
    .input(z.object({ calendarId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        const credentials = loadServiceAccountCredentials();
        const serviceAccountEmail = credentials.client_email || "未知";
        const calendar = getCalendarClient();
        const now = new Date();
        const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        const freeBusyResp = await calendar.freebusy.query({
          requestBody: {
            timeMin: now.toISOString(),
            timeMax: tomorrow.toISOString(),
            timeZone: "Asia/Taipei",
            items: [{ id: input.calendarId }],
          },
        });

        const calendarData = freeBusyResp.data.calendars?.[input.calendarId];
        const errors = calendarData?.errors;
        if (errors && errors.length > 0) {
          const errorMsg = errors.map((e: any) => e.reason || e.domain).join(", ");
          return {
            valid: false,
            message: `日曆驗證失敗: ${errorMsg}。請在 Google Calendar 設定中將日曆共用給 ${serviceAccountEmail}（查看權限即可）`,
            busyCount: 0,
            serviceAccountEmail,
          };
        }
        const busyCount = calendarData?.busy?.length || 0;
        return {
          valid: true,
          message: `日曆驗證成功！未來 24 小時內有 ${busyCount} 個忙碌時段。`,
          busyCount,
          serviceAccountEmail,
        };
      } catch (err: any) {
        let saEmail = "";
        try {
          const creds = loadServiceAccountCredentials();
          saEmail = creds.client_email || "";
        } catch { /* ignore */ }
        return {
          valid: false,
          message: `日曆驗證失敗: ${err.message}${saEmail ? `。請確認日曆已共用給 ${saEmail}` : ""}`,
          busyCount: 0,
          serviceAccountEmail: saEmail,
        };
      }
    }),

  /** 取得 Service Account Email（前端顯示共用提示用） */
  getServiceAccountEmail: adminProcedure.query(async () => {
    try {
      const credentials = loadServiceAccountCredentials();
      return { email: credentials.client_email || "" };
    } catch {
      return { email: "" };
    }
  }),

  // ─── 租客端公開 API ──────────────────────────────────────────────────────

  /** 取得預約模版公開資訊（租客端用） */
  getPublicTemplate: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      // DB 優先 + hardcode fallback（退租/續約 DB 掛了仍可服務）
      const bundle = await resolveTemplateBundle(input.projectId);
      if (!bundle)
        throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在或已停用" });
      const { template, fields, rules } = bundle;

      const allRoutingDays = Array.from(
        new Set(rules.flatMap((r) => r.days as number[])),
      );
      const weeklyHours = (template as any).weeklyHours as Record<
        string,
        { start: string; end: string } | null
      > | null;
      const routingDays = weeklyHours
        ? allRoutingDays.filter(
            (d) =>
              weeklyHours[String(d)] !== null &&
              weeklyHours[String(d)] !== undefined,
          )
        : allRoutingDays;

      return {
        id: template.id,
        projectId: template.projectId,
        name: template.name,
        templateType: template.templateType,
        slotDurationMinutes: template.slotDurationMinutes,
        bookableDaysAhead: template.bookableDaysAhead,
        dailyStartTime: template.dailyStartTime,
        dailyEndTime: template.dailyEndTime,
        liffId: template.liffId || null,
        instructionEnabled: template.instructionEnabled,
        instructionText: template.instructionText || null,
        minLeadDays: template.minLeadDays ?? 0,
        fields,
        routingDays,
      };
    }),

  /** 驗證租客 UID（公開 API）— 查 Ragic 房客資料取得入住房源 */
  verifyTenantUid: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        uid: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      return handleVerifyTenantUid(input);
    }),

  /** 用電話號碼驗證租客（UID 查不到時的 fallback） */
  verifyByPhone: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        phone: z.string().min(1),
        uid: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return handleVerifyByPhone(input);
    }),

  /** 用電話號碼建立新的 Ragic 房客記錄（電話也查不到時） */
  registerTenantByPhone: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        phone: z.string().min(1),
        name: z.string().min(1),
        location: z.string().min(1),
        roomNumber: z.string().min(1),
        uid: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { ragicPost, RAGIC_API_KEY_VALUE } = await import("./bookingHelpers");
      if (!RAGIC_API_KEY_VALUE) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Ragic API 尚未設定",
        });
      }
      try {
        const ragicData: Record<string, any> = {
          房客姓名1: input.name,
          連絡電話1: input.phone,
          現居地址: input.location,
          房間編號: input.roomNumber,
        };
        if (input.uid) {
          ragicData["lineuid"] = input.uid;
        }
        const result = await ragicPost("for-system-use/2", ragicData);
        return {
          success: true,
          ragicId: String(result?.ragicId || ""),
        };
      } catch (err: any) {
        console.error("[Booking] Failed to register tenant:", err.message);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "無法建立房客資料，請稍後再試",
        });
      }
    }),

  /** 取得可用時段（公開 API） */
  getAvailableSlots: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .query(async ({ input }) => {
      return handleGetAvailableSlots(input);
    }),

  /** 確認預約（公開 API） */
  confirmBooking: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        uid: z.string().min(1),
        tenantName: z.string(),
        roomNumber: z.string(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string(),
        endTime: z.string(),
        calendarId: z.string(),
        assigneeName: z.string(),
        phone: z.string().optional(),
        address: z.string().optional(),
        formAnswers: z.record(z.string(), z.any()).optional(),
        contractRecordId: z.number().optional(),
        virtualAccount: z.string().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      return handleConfirmBooking(input, ctx);
    }),

  /** 批次查詢多天可用時段（公開 API） */
  getAvailableSlotsMultiDay: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(90),
      }),
    )
    .query(async ({ input }) => {
      return handleGetAvailableSlotsMultiDay(input);
    }),

  /** 解析指定時段預約參數（公開 API） */
  resolvePresetSlot: publicProcedure
    .input(
      z.object({
        projectId: z.string(),
        t: z.string().regex(/^(\d{8}|\d{12})$/, "t 參數格式應為 MMDDHHMM 或 YYYYMMDDHHMM"),
      }),
    )
    .query(async ({ input }) => {
      let year: number, month: number, day: number, hour: number, minute: number;
      if (input.t.length === 12) {
        year = parseInt(input.t.slice(0, 4));
        month = parseInt(input.t.slice(4, 6));
        day = parseInt(input.t.slice(6, 8));
        hour = parseInt(input.t.slice(8, 10));
        minute = parseInt(input.t.slice(10, 12));
      } else {
        month = parseInt(input.t.slice(0, 2));
        day = parseInt(input.t.slice(2, 4));
        hour = parseInt(input.t.slice(4, 6));
        minute = parseInt(input.t.slice(6, 8));
        const nowTaipei = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
        const currentYear = nowTaipei.getUTCFullYear();
        const currentMonth = nowTaipei.getUTCMonth() + 1;
        if (currentMonth === 12 && month < currentMonth) {
          year = currentYear + 1;
        } else {
          year = currentYear;
        }
      }
      if (
        isNaN(year) || isNaN(month) || isNaN(day) || isNaN(hour) || isNaN(minute) ||
        month < 1 || month > 12 || day < 1 || day > 31 ||
        hour < 0 || hour > 23 || minute < 0 || minute > 59
      ) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "時段參數格式錯誤" });
      }
      const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const startTimeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

      // DB 優先 + hardcode fallback
      const bundle = await resolveTemplateBundle(input.projectId);
      if (!bundle) throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在" });
      const template = bundle.template;
      const rules = bundle.rules;

      const slotDuration = template.slotDurationMinutes || 60;
      const startMs = new Date(`${date}T${startTimeStr}:00+08:00`).getTime();
      const endMs = startMs + slotDuration * 60 * 1000;
      const endDt = new Date(endMs);
      const taipeiEnd = new Date(endDt.getTime() + 8 * 60 * 60 * 1000);
      const endTimeStr = `${String(taipeiEnd.getUTCHours()).padStart(2, "0")}:${String(taipeiEnd.getUTCMinutes()).padStart(2, "0")}`;

      const { getTaipeiDayOfWeek } = await import("./bookingHelpers");
      const dayOfWeek = getTaipeiDayOfWeek(date);

      const matchingRule =
        rules.find((r) => {
          const days = r.days as number[];
          return days.includes(dayOfWeek);
        }) || rules[0];

      if (!matchingRule) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "此模版尚未設定分流規則",
        });
      }

      return {
        date,
        startTime: new Date(`${date}T${startTimeStr}:00+08:00`).toISOString(),
        endTime: new Date(`${date}T${endTimeStr}:00+08:00`).toISOString(),
        startTimeDisplay: startTimeStr,
        endTimeDisplay: endTimeStr,
        calendarId: matchingRule.calendarId,
        assigneeName: matchingRule.ownerName,
        slotDurationMinutes: slotDuration,
      };
    }),

  // ─── 預約卡片動作：取消 / 變更時間（P23，退租+續約共用）──────────────────

  /** 改期前取得預約基本資料（uid 比對） */
  getBookingForReschedule: publicProcedure
    .input(z.object({ bookingId: z.number().int(), uid: z.string().min(1) }))
    .query(async ({ input }) => handleGetBookingForReschedule(input)),

  /** 取消預約：硬刪除 Ragic 任務 + 標記取消（uid 比對） */
  cancelBookingPublic: publicProcedure
    .input(z.object({ bookingId: z.number().int(), uid: z.string().min(1) }))
    .mutation(async ({ input }) => handleCancelBookingPublic(input)),

  /** 變更時間：更新 Ragic 任務日期 + 本地紀錄（uid 比對） */
  rescheduleBooking: publicProcedure
    .input(
      z.object({
        bookingId: z.number().int(),
        uid: z.string().min(1),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        startTime: z.string(),
        endTime: z.string(),
        calendarId: z.string(),
        assigneeName: z.string(),
      }),
    )
    .mutation(async ({ input }) => handleRescheduleBooking(input)),
});
