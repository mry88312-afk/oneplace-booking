/**
 * 後台模版 CRUD handler（從主系統 oneplace-service 複製）。
 * P19a: 搬到 Zeabur 自建後台用。不依賴 user / emitDataChange。
 */
import { TRPCError } from "@trpc/server";
import { getDb } from "../../db";
import * as schema from "../../../drizzle/schema";
import { eq } from "drizzle-orm";

interface TemplateCreateInput {
  name: string;
  templateType?: string;
  liffId?: string | null;
  ragicSearchPath: string;
  ragicUidField: string;
  ragicTaskPath?: string;
  slotDurationMinutes?: number;
  bookableDaysAhead?: number;
  dailyStartTime?: string;
  dailyEndTime?: string;
  bufferMinutes?: number;
  bufferDirection?: "before" | "after" | "both";
  weeklyHours?: Record<string, { start: string; end: string } | null>;
  instructionEnabled?: boolean;
  instructionText?: string | null;
  minLeadDays?: number;
  rules?: Array<{
    days: number[];
    calendarId: string;
    calendarLabel?: string | null;
    ownerName: string;
    weeklyStartTime?: string | null;
    weeklyEndTime?: string | null;
  }>;
  fields?: Array<{
    fieldType: "text" | "select" | "file" | "description" | "checkbox" | "line_uid" | "inbox_url";
    label: string;
    isRequired: boolean;
    options?: string[] | null;
    ragicFieldId?: string | null;
    descriptionText?: string | null;
    allowOther?: boolean;
    selectionMode?: "radio" | "checkbox";
  }>;
}

export async function handleCreateTemplate(input: TemplateCreateInput & { projectId: string }, createdByUserId?: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  // Check projectId uniqueness
  const [existing] = await db
    .select()
    .from(schema.bookingTemplates)
    .where(eq(schema.bookingTemplates.projectId, input.projectId));
  if (existing) {
    throw new TRPCError({ code: "CONFLICT", message: "專案 ID 已存在" });
  }

  const [result] = await db.insert(schema.bookingTemplates).values({
    projectId: input.projectId,
    name: input.name,
    templateType: input.templateType || "viewing",
    liffId: input.liffId || null,
    ragicSearchPath: input.ragicSearchPath,
    ragicUidField: input.ragicUidField,
    ragicTaskPath: input.ragicTaskPath || "",
    slotDurationMinutes: input.slotDurationMinutes ?? 30,
    bookableDaysAhead: input.bookableDaysAhead ?? 14,
    dailyStartTime: input.dailyStartTime ?? "09:00",
    dailyEndTime: input.dailyEndTime ?? "18:00",
    bufferMinutes: input.bufferMinutes ?? 0,
    bufferDirection: input.bufferDirection ?? "after",
    weeklyHours: input.weeklyHours || null,
    instructionEnabled: input.instructionEnabled ?? false,
    instructionText: input.instructionText || null,
    minLeadDays: input.minLeadDays ?? 0,
    createdByUserId,
  });
  const templateId = result.insertId;

  if (input.rules && input.rules.length > 0) {
    for (let i = 0; i < input.rules.length; i++) {
      const rule = input.rules[i];
      await db.insert(schema.calendarRoutingRules).values({
        templateId,
        days: rule.days,
        calendarId: rule.calendarId,
        calendarLabel: rule.calendarLabel || null,
        ownerName: rule.ownerName,
        weeklyStartTime: rule.weeklyStartTime || null,
        weeklyEndTime: rule.weeklyEndTime || null,
        sortOrder: i,
      });
    }
  }

  if (input.fields && input.fields.length > 0) {
    for (let i = 0; i < input.fields.length; i++) {
      const field = input.fields[i];
      await db.insert(schema.bookingFormFields).values({
        templateId,
        fieldType: field.fieldType,
        label: field.label || "",
        isRequired: field.isRequired,
        options: field.options || null,
        ragicFieldId: field.ragicFieldId || null,
        descriptionText: field.descriptionText || null,
        allowOther: field.allowOther ?? false,
        selectionMode: field.selectionMode ?? "checkbox",
        sortOrder: i,
      });
    }
  }

  return { id: templateId };
}

interface TemplateUpdateInput {
  id: number;
  name?: string;
  templateType?: string;
  liffId?: string | null;
  ragicSearchPath?: string;
  ragicUidField?: string;
  ragicTaskPath?: string;
  slotDurationMinutes?: number;
  bookableDaysAhead?: number;
  dailyStartTime?: string;
  dailyEndTime?: string;
  bufferMinutes?: number;
  bufferDirection?: "before" | "after" | "both";
  weeklyHours?: Record<string, { start: string; end: string } | null>;
  isActive?: boolean;
  instructionEnabled?: boolean;
  instructionText?: string | null;
  minLeadDays?: number;
  rules?: Array<{
    days: number[];
    calendarId: string;
    calendarLabel?: string | null;
    ownerName: string;
    weeklyStartTime?: string | null;
    weeklyEndTime?: string | null;
  }>;
  fields?: Array<{
    fieldType: "text" | "select" | "file" | "description" | "checkbox" | "line_uid" | "inbox_url";
    label: string;
    isRequired: boolean;
    options?: string[] | null;
    ragicFieldId?: string | null;
    descriptionText?: string | null;
    allowOther?: boolean;
    selectionMode?: "radio" | "checkbox";
  }>;
}

export async function handleUpdateTemplate(input: TemplateUpdateInput) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });

  const updateData: any = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.templateType !== undefined) updateData.templateType = input.templateType;
  if (input.liffId !== undefined) updateData.liffId = input.liffId;
  if (input.ragicSearchPath !== undefined) updateData.ragicSearchPath = input.ragicSearchPath;
  if (input.ragicUidField !== undefined) updateData.ragicUidField = input.ragicUidField;
  if (input.ragicTaskPath !== undefined) updateData.ragicTaskPath = input.ragicTaskPath;
  if (input.slotDurationMinutes !== undefined) updateData.slotDurationMinutes = input.slotDurationMinutes;
  if (input.bookableDaysAhead !== undefined) updateData.bookableDaysAhead = input.bookableDaysAhead;
  if (input.dailyStartTime !== undefined) updateData.dailyStartTime = input.dailyStartTime;
  if (input.dailyEndTime !== undefined) updateData.dailyEndTime = input.dailyEndTime;
  if (input.bufferMinutes !== undefined) updateData.bufferMinutes = input.bufferMinutes;
  if (input.bufferDirection !== undefined) updateData.bufferDirection = input.bufferDirection;
  if (input.weeklyHours !== undefined) updateData.weeklyHours = input.weeklyHours;
  if (input.instructionEnabled !== undefined) updateData.instructionEnabled = input.instructionEnabled;
  if (input.instructionText !== undefined) updateData.instructionText = input.instructionText;
  if (input.minLeadDays !== undefined) updateData.minLeadDays = input.minLeadDays;
  if (input.isActive !== undefined) updateData.isActive = input.isActive;

  if (Object.keys(updateData).length > 0) {
    await db
      .update(schema.bookingTemplates)
      .set(updateData)
      .where(eq(schema.bookingTemplates.id, input.id));
  }

  // Update routing rules (delete old, recreate)
  if (input.rules !== undefined) {
    await db
      .delete(schema.calendarRoutingRules)
      .where(eq(schema.calendarRoutingRules.templateId, input.id));
    for (let i = 0; i < input.rules.length; i++) {
      const rule = input.rules[i];
      await db.insert(schema.calendarRoutingRules).values({
        templateId: input.id,
        days: rule.days,
        calendarId: rule.calendarId,
        calendarLabel: rule.calendarLabel || null,
        ownerName: rule.ownerName,
        weeklyStartTime: rule.weeklyStartTime || null,
        weeklyEndTime: rule.weeklyEndTime || null,
        sortOrder: i,
      });
    }
  }

  // Update form fields (delete old, recreate)
  // Safety: skip if fields is an empty array to prevent accidental deletion of all fields
  if (input.fields !== undefined && input.fields.length > 0) {
    await db
      .delete(schema.bookingFormFields)
      .where(eq(schema.bookingFormFields.templateId, input.id));
    for (let i = 0; i < input.fields.length; i++) {
      const field = input.fields[i];
      await db.insert(schema.bookingFormFields).values({
        templateId: input.id,
        fieldType: field.fieldType,
        label: field.label || "",
        isRequired: field.isRequired,
        options: field.options || null,
        ragicFieldId: field.ragicFieldId || null,
        descriptionText: field.descriptionText || null,
        allowOther: field.allowOther ?? false,
        selectionMode: field.selectionMode ?? "checkbox",
        sortOrder: i,
      });
    }
  }

  return { success: true };
}
