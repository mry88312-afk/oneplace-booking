/**
 * 預約服務的 Drizzle ORM schema（精簡版）
 *
 * Supabase 私有 booking schema；只保存本系統的新預約與設定。
 * 不與客服站 MySQL 表共用，不向瀏覽器開放資料庫存取。
 */
import {
  pgSchema,
  integer,
  varchar,
  boolean,
  text,
  jsonb,
  timestamp,

  bigint,
  index,
} from "drizzle-orm/pg-core";

export const bookingSchema = pgSchema("booking");

/** 預約模版（管理端在主系統的 BookingAdmin 建立，此服務只讀） */
export const bookingTemplates = bookingSchema.table("booking_templates", {
  id: integer("bt_id").generatedByDefaultAsIdentity().primaryKey(),
  projectId: varchar("bt_projectId", { length: 128 }).notNull().unique(),
  name: varchar("bt_name", { length: 255 }).notNull(),
  templateType: varchar("bt_templateType", { length: 64 }).notNull(),
  liffId: varchar("bt_liffId", { length: 255 }),
  ragicSearchPath: varchar("bt_ragicSearchPath", { length: 255 }).notNull(),
  ragicUidField: varchar("bt_ragicUidField", { length: 128 }).notNull(),
  ragicTaskPath: varchar("bt_ragicTaskPath", { length: 255 }).notNull(),
  slotDurationMinutes: integer("bt_slotDurationMinutes").notNull().default(60),
  bookableDaysAhead: integer("bt_bookableDaysAhead").notNull().default(14),
  dailyStartTime: varchar("bt_dailyStartTime", { length: 5 }).notNull().default("09:00"),
  dailyEndTime: varchar("bt_dailyEndTime", { length: 5 }).notNull().default("18:00"),
  bufferMinutes: integer("bt_bufferMinutes").notNull().default(0),
  bufferDirection: varchar("bt_bufferDirection", { length: 16 }).notNull().default("after"),
  weeklyHours: jsonb("bt_weeklyHours"),
  instructionEnabled: boolean("bt_instructionEnabled").notNull().default(false),
  instructionText: text("bt_instructionText"),
  minLeadDays: integer("bt_minLeadDays").notNull().default(0),
  contractAction: varchar("bt_contractAction", { length: 32 }),
  isActive: boolean("bt_isActive").notNull().default(true),
  createdByUserId: integer("bt_createdByUserId"),
  createdAt: timestamp("bt_createdAt", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("bt_updatedAt", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
});
export type BookingTemplateRecord = typeof bookingTemplates.$inferSelect;
export type InsertBookingTemplate = typeof bookingTemplates.$inferInsert;

/** 日曆分流規則 */
export const calendarRoutingRules = bookingSchema.table("calendar_routing_rules", {
  id: integer("crr_id").generatedByDefaultAsIdentity().primaryKey(),
  templateId: integer("crr_templateId").notNull(),
  days: jsonb("crr_days").notNull(),
  calendarId: varchar("crr_calendarId", { length: 512 }).notNull(),
  calendarLabel: varchar("crr_calendarLabel", { length: 256 }),
  ownerName: varchar("crr_ownerName", { length: 128 }).notNull(),
  weeklyStartTime: varchar("crr_weeklyStartTime", { length: 5 }),
  weeklyEndTime: varchar("crr_weeklyEndTime", { length: 5 }),
  sortOrder: integer("crr_sortOrder").notNull().default(0),
  createdAt: timestamp("crr_createdAt", { withTimezone: true }).defaultNow().notNull(),
});
export type CalendarRoutingRuleRecord = typeof calendarRoutingRules.$inferSelect;
export type InsertCalendarRoutingRule = typeof calendarRoutingRules.$inferInsert;

/** 動態表單欄位 */
export const bookingFormFields = bookingSchema.table("booking_form_fields", {
  id: integer("bff_id").generatedByDefaultAsIdentity().primaryKey(),
  templateId: integer("bff_templateId").notNull(),
  fieldType: varchar("bff_fieldType", { length: 32, enum: [
    "text",
    "select",
    "file",
    "description",
    "checkbox",
    "line_uid",
    "inbox_url",
  ] }).notNull(),
  label: varchar("bff_label", { length: 255 }).notNull().default(""),
  isRequired: boolean("bff_isRequired").notNull().default(false),
  options: jsonb("bff_options"),
  ragicFieldId: varchar("bff_ragicFieldId", { length: 64 }),
  descriptionText: text("bff_descriptionText"),
  allowOther: boolean("bff_allowOther").notNull().default(false),
  selectionMode: varchar("bff_selectionMode", { length: 16, enum: ["radio", "checkbox"] }).default("checkbox"),
  sortOrder: integer("bff_sortOrder").notNull().default(0),
  createdAt: timestamp("bff_createdAt", { withTimezone: true }).defaultNow().notNull(),
});
export type BookingFormFieldRecord = typeof bookingFormFields.$inferSelect;
export type InsertBookingFormField = typeof bookingFormFields.$inferInsert;

/** 預約記錄 */
export const bookingRecords = bookingSchema.table(
  "booking_records",
  {
    id: integer("br_id").generatedByDefaultAsIdentity().primaryKey(),
    templateId: integer("br_templateId").notNull(),
    tenantUid: varchar("br_tenantUid", { length: 255 }).notNull(),
    tenantUserId: integer("br_tenantUserId"),
    tenantName: varchar("br_tenantName", { length: 128 }),
    roomNumber: varchar("br_roomNumber", { length: 64 }),
    address: varchar("br_address", { length: 512 }),
    bookingTime: bigint("br_bookingTime", { mode: "number" }).notNull(),
    durationMinutes: integer("br_durationMinutes").notNull(),
    assigneeName: varchar("br_assigneeName", { length: 128 }),
    googleEventId: varchar("br_googleEventId", { length: 512 }),
    googleCalendarId: varchar("br_googleCalendarId", { length: 512 }),
    ragicRecordId: varchar("br_ragicRecordId", { length: 64 }),
    formAnswers: jsonb("br_formAnswers"),
    status: varchar("br_status", { length: 16, enum: ["confirmed", "cancelled", "completed", "no_show"] })
      .notNull()
      .default("confirmed"),
    cancelReason: text("br_cancelReason"),
    createdAt: timestamp("br_createdAt", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("br_updatedAt", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
  },
  (table) => [
    index("br_templateId_idx").on(table.templateId),
    index("br_tenantUid_idx").on(table.tenantUid),
    index("br_tenantUserId_idx").on(table.tenantUserId),
    index("br_bookingTime_idx").on(table.bookingTime),
  ],
);
export type BookingRecordRecord = typeof bookingRecords.$inferSelect;
export type InsertBookingRecord = typeof bookingRecords.$inferInsert;

/** Durable operation receipts, independent of booking status and external Calendar writers. */
export const bookingSubmissionAttempts = bookingSchema.table("booking_submission_attempts", {
  requestKey: varchar("request_key", { length: 64 }).primaryKey(),
  payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
  state: varchar("state", { length: 32 }).notNull(),
  ragicRecordId: varchar("ragic_record_id", { length: 64 }),
  bookingId: integer("booking_id"),
  failureStage: varchar("failure_stage", { length: 32 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().$onUpdate(() => new Date()).notNull(),
});
