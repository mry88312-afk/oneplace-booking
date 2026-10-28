import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { BOOKING_CHANGED, BOOKING_PENDING, BOOKING_UNAVAILABLE, errorCode } from "../../shared/bookingErrors";
import type { InsertBookingRecord } from "../../drizzle/schema";

export type CompletedSubmission = { success: true; status: "confirmed"; bookingId: number; ragicRecordId: string };
export type SubmissionResult = CompletedSubmission | { success: false; status: "pending"; message: string };
export type Reservation = { kind: "owner" } | { kind: "pending" } | { kind: "conflict" }
  | { kind: "completed"; result: CompletedSubmission };
export interface SubmissionStore {
  reserve(key: string, payloadHash: string): Promise<Reservation>;
  recordRagic(key: string, ragicId: string): Promise<void>;
  complete(key: string, record: InsertBookingRecord): Promise<CompletedSubmission>;
  markPending(key: string, stage: string): Promise<void>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields).filter(k => fields[k] !== undefined).sort()
      .map(k => `${JSON.stringify(k)}:${canonical(fields[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function submissionIdentity(uid: string, requestId: string, payload: unknown) {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  return { key: hash(canonical([uid, requestId])), payloadHash: hash(canonical(payload)) };
}

export function persistedAnswers(answers: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!answers) return null;
  const clean = (value: unknown): unknown => {
    if (typeof value === "string" && /^data:/i.test(value)) return "附件已上傳至 Ragic";
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
    return value;
  };
  return Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, clean(v)]));
}

/** One durable reservation before any external write. Pending attempts never expire/repost. */
export async function submitBookingOnce(options: {
  key: string;
  payloadHash: string;
  store: SubmissionStore;
  createTask: () => Promise<string>;
  uploadAttachments: (ragicId: string) => Promise<void>;
  record: Omit<InsertBookingRecord, "ragicRecordId">;
  onPending?: (info: { key: string; stage: string; ragicRecordId: string }) => Promise<void>;
}): Promise<SubmissionResult & { fresh?: boolean }> {
  const { key, store } = options;
  let reservation: Reservation;
  try { reservation = await store.reserve(key, options.payloadHash); }
  catch (error) {
    console.error("[BookingSubmission] reservation unavailable", { key, code: errorCode(error) });
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: BOOKING_UNAVAILABLE });
  }
  if (reservation.kind === "conflict") throw new TRPCError({ code: "CONFLICT", message: BOOKING_CHANGED });
  if (reservation.kind === "completed") return { ...reservation.result, fresh: false };
  if (reservation.kind === "pending") return { success: false, status: "pending", message: BOOKING_PENDING };

  let stage = "create_task";
  let ragicRecordId = "";
  try {
    ragicRecordId = await options.createTask();
    if (!/^\d+$/.test(ragicRecordId)) throw new Error("Missing Ragic receipt");
    stage = "save_receipt";
    await store.recordRagic(key, ragicRecordId);
    stage = "upload_attachments";
    await options.uploadAttachments(ragicRecordId);
    stage = "save_booking";
    const result = await store.complete(key, { ...options.record, ragicRecordId });
    return { ...result, fresh: true };
  } catch (error) {
    // A timeout or failed COMMIT may have succeeded remotely. Never recreate the task.
    console.error("[BookingSubmission] needs review", { key, stage, ragicRecordId, code: errorCode(error) });
    await store.markPending(key, stage).catch(() => {});
    await options.onPending?.({ key, stage, ragicRecordId }).catch(() => {});
    return { success: false, status: "pending", message: BOOKING_PENDING };
  }
}
