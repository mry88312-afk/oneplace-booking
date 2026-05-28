/**
 * 公開預約 router — 只包含 publicProcedure（租客端使用）
 *
 * 從主系統 oneplace-service 的 server/routers/property/booking.ts 拆出，
 * 移除所有 protectedProcedure（模版管理、預約列表、日曆驗證等留在主系統）。
 */
import { z } from "zod";
import { router, publicProcedure } from "../../_core/trpc";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { eq, and } from "drizzle-orm";
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

export const bookingRouter = router({
  /** 取得預約模版公開資訊（租客端用） */
  getPublicTemplate: publicProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input }) => {
      let db: Awaited<ReturnType<typeof getDb>>;
      try {
        db = await getDb();
      } catch (err: any) {
        console.error("[Booking-Public] DB connection failed:", err?.message);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "SERVICE_UNAVAILABLE",
        });
      }
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "SERVICE_UNAVAILABLE",
        });

      let template: typeof schema.bookingTemplates.$inferSelect | undefined;
      let fields: (typeof schema.bookingFormFields.$inferSelect)[] = [];
      let rules: (typeof schema.calendarRoutingRules.$inferSelect)[] = [];
      try {
        const [row] = await db
          .select()
          .from(schema.bookingTemplates)
          .where(
            and(
              eq(schema.bookingTemplates.projectId, input.projectId),
              eq(schema.bookingTemplates.isActive, true),
            ),
          );
        template = row;
        if (template) {
          fields = await db
            .select()
            .from(schema.bookingFormFields)
            .where(eq(schema.bookingFormFields.templateId, template.id))
            .orderBy(schema.bookingFormFields.sortOrder);
          rules = await db
            .select()
            .from(schema.calendarRoutingRules)
            .where(eq(schema.calendarRoutingRules.templateId, template.id));
        }
      } catch (err: any) {
        console.error("[Booking-Public] DB query failed:", err?.message);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "SERVICE_UNAVAILABLE",
        });
      }
      if (!template)
        throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在或已停用" });

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
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
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

      const [template] = await db
        .select()
        .from(schema.bookingTemplates)
        .where(
          and(
            eq(schema.bookingTemplates.projectId, input.projectId),
            eq(schema.bookingTemplates.isActive, true),
          ),
        );
      if (!template) throw new TRPCError({ code: "NOT_FOUND", message: "預約專案不存在" });

      const slotDuration = template.slotDurationMinutes || 60;
      const startMs = new Date(`${date}T${startTimeStr}:00+08:00`).getTime();
      const endMs = startMs + slotDuration * 60 * 1000;
      const endDt = new Date(endMs);
      const taipeiEnd = new Date(endDt.getTime() + 8 * 60 * 60 * 1000);
      const endTimeStr = `${String(taipeiEnd.getUTCHours()).padStart(2, "0")}:${String(taipeiEnd.getUTCMinutes()).padStart(2, "0")}`;

      const { getTaipeiDayOfWeek } = await import("./bookingHelpers");
      const dayOfWeek = getTaipeiDayOfWeek(date);
      const rules = await db
        .select()
        .from(schema.calendarRoutingRules)
        .where(eq(schema.calendarRoutingRules.templateId, template.id))
        .orderBy(schema.calendarRoutingRules.sortOrder);

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
});
