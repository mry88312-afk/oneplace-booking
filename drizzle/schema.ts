/**
 * 預約服務的 Drizzle ORM schema（精簡版）
 *
 * 只包含 4 個 booking 相關的表，跟主系統共用同一個 TiDB Cloud 資料庫。
 * 表結構必須與主系統 oneplace-service 的 drizzle/schema.ts 1804-1944 行完全一致。
 */
import {
  mysqlTable,
  int,
  varchar,
  boolean,
  text,
  json,
  timestamp,
  mysqlEnum,
  bigint,
  index,
} from "drizzle-orm/mysql-core";

/** 預約模版（管理端在主系統的 BookingAdmin 建立，此服務只讀） */
export const bookingTemplates = mysqlTable("booking_templates", {
  id: int("bt_id").autoincrement().primaryKey(),
  projectId: varchar("bt_projectId", { length: 128 }).notNull().unique(),
  name: varchar("bt_name", { length: 255 }).notNull(),
  templateType: varchar("bt_templateType", { length: 64 }).notNull(),
  liffId: varchar("bt_liffId", { length: 255 }),
  ragicSearchPath: varchar("bt_ragicSearchPath", { length: 255 }).notNull(),
  ragicUidField: varchar("bt_ragicUidField", { length: 128 }).notNull(),
  ragicTaskPath: varchar("bt_ragicTaskPath", { length: 255 }).notNull(),
  slotDurationMinutes: int("bt_slotDurationMinutes").notNull().default(60),
  bookableDaysAhead: int("bt_bookableDaysAhead").notNull().default(14),
  dailyStartTime: varchar("bt_dailyStartTime", { length: 5 }).notNull().default("09:00"),
  dailyEndTime: varchar("bt_dailyEndTime", { length: 5 }).notNull().default("18:00"),
  bufferMinutes: int("bt_bufferMinutes").notNull().default(0),
  bufferDirection: varchar("bt_bufferDirection", { length: 16 }).notNull().default("after"),
  weeklyHours: json("bt_weeklyHours"),
  instructionEnabled: boolean("bt_instructionEnabled").notNull().default(false),
  instructionText: text("bt_instructionText"),
  minLeadDays: int("bt_minLeadDays").notNull().default(0),
  contractAction: varchar("bt_contractAction", { length: 32 }),
  isActive: boolean("bt_isActive").notNull().default(true),
  createdByUserId: int("bt_createdByUserId"),
  createdAt: timestamp("bt_createdAt").defaultNow().notNull(),
  updatedAt: timestamp("bt_updatedAt").defaultNow().onUpdateNow().notNull(),
});
export type BookingTemplateRecord = typeof bookingTemplates.$inferSelect;
export type InsertBookingTemplate = typeof bookingTemplates.$inferInsert;

/** 日曆分流規則 */
export const calendarRoutingRules = mysqlTable("calendar_routing_rules", {
  id: int("crr_id").autoincrement().primaryKey(),
  templateId: int("crr_templateId").notNull(),
  days: json("crr_days").notNull(),
  calendarId: varchar("crr_calendarId", { length: 512 }).notNull(),
  calendarLabel: varchar("crr_calendarLabel", { length: 256 }),
  ownerName: varchar("crr_ownerName", { length: 128 }).notNull(),
  weeklyStartTime: varchar("crr_weeklyStartTime", { length: 5 }),
  weeklyEndTime: varchar("crr_weeklyEndTime", { length: 5 }),
  sortOrder: int("crr_sortOrder").notNull().default(0),
  createdAt: timestamp("crr_createdAt").defaultNow().notNull(),
});
export type CalendarRoutingRuleRecord = typeof calendarRoutingRules.$inferSelect;
export type InsertCalendarRoutingRule = typeof calendarRoutingRules.$inferInsert;

/** 動態表單欄位 */
export const bookingFormFields = mysqlTable("booking_form_fields", {
  id: int("bff_id").autoincrement().primaryKey(),
  templateId: int("bff_templateId").notNull(),
  fieldType: mysqlEnum("bff_fieldType", [
    "text",
    "select",
    "file",
    "description",
    "checkbox",
    "line_uid",
    "inbox_url",
  ]).notNull(),
  label: varchar("bff_label", { length: 255 }).notNull().default(""),
  isRequired: boolean("bff_isRequired").notNull().default(false),
  options: json("bff_options"),
  ragicFieldId: varchar("bff_ragicFieldId", { length: 64 }),
  descriptionText: text("bff_descriptionText"),
  allowOther: boolean("bff_allowOther").notNull().default(false),
  selectionMode: mysqlEnum("bff_selectionMode", ["radio", "checkbox"]).default("checkbox"),
  sortOrder: int("bff_sortOrder").notNull().default(0),
  createdAt: timestamp("bff_createdAt").defaultNow().notNull(),
});
export type BookingFormFieldRecord = typeof bookingFormFields.$inferSelect;
export type InsertBookingFormField = typeof bookingFormFields.$inferInsert;

/** 預約記錄 */
export const bookingRecords = mysqlTable(
  "booking_records",
  {
    id: int("br_id").autoincrement().primaryKey(),
    templateId: int("br_templateId").notNull(),
    tenantUid: varchar("br_tenantUid", { length: 255 }).notNull(),
    tenantUserId: int("br_tenantUserId"),
    tenantName: varchar("br_tenantName", { length: 128 }),
    roomNumber: varchar("br_roomNumber", { length: 64 }),
    address: varchar("br_address", { length: 512 }),
    bookingTime: bigint("br_bookingTime", { mode: "number" }).notNull(),
    durationMinutes: int("br_durationMinutes").notNull(),
    assigneeName: varchar("br_assigneeName", { length: 128 }),
    googleEventId: varchar("br_googleEventId", { length: 512 }),
    googleCalendarId: varchar("br_googleCalendarId", { length: 512 }),
    ragicRecordId: varchar("br_ragicRecordId", { length: 64 }),
    formAnswers: json("br_formAnswers"),
    status: mysqlEnum("br_status", ["confirmed", "cancelled", "completed", "no_show"])
      .notNull()
      .default("confirmed"),
    cancelReason: text("br_cancelReason"),
    createdAt: timestamp("br_createdAt").defaultNow().notNull(),
    updatedAt: timestamp("br_updatedAt").defaultNow().onUpdateNow().notNull(),
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
