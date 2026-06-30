/**
 * P18 hardcode: 退租 / 續約 預約模版（從 DB 凍結到代碼）
 *
 * 設計動機：
 * - 退租 / 續約 模版設定改動頻率極低，且 BookingAdmin 後台對我們價值不高
 * - 改設定走 git push 比走 admin UI 更安全（有 history、可 code review、自動 deploy）
 * - 之後做「線上續約」新功能時，舊 schema 可能整個重做，先把這兩個從 DB 解耦
 *
 * 規則：
 * - 任何 handler 進入時先呼叫 getLockedBundle(projectId)
 * - 命中 → 用 hardcode；沒命中 → 走原本 DB 查詢路徑（其他 templateType 不受影響）
 * - DB 上仍有對應 records（bt_id=1, bt_id=30002），但 Zeabur 不再讀
 * - 主系統 BookingAdmin 若修改 DB 那兩筆，**不會影響 Zeabur 行為**（須留意一致性）
 *
 * 改設定流程：直接編輯這個檔案 → commit → push → Zeabur 1-3 分鐘自動 deploy
 */

import type {
  BookingTemplateRecord,
  BookingFormFieldRecord,
  CalendarRoutingRuleRecord,
} from "../../drizzle/schema";

/** Drizzle schema 的 createdAt/updatedAt 是 Date 型別；hardcode 用統一固定值 */
const LOCKED_EPOCH = new Date("2026-01-01T00:00:00.000Z");

/**
 * locked 表單欄位可附帶「條件式 UI」設定（僅前端渲染器 / 送出驗證讀取，不進 DB）：
 *  - showWhen：依賴欄位答案命中才顯示（例：選「展延」才出現月數）
 *  - optionsWhen：依賴欄位答案命中時改用另一組選項（例：展延→繳費方式只剩月繳）
 *  - tone：description 欄位的色調，danger=紅色警示框
 */
type LockedFormField = BookingFormFieldRecord & {
  showWhen?: { field: string; equals: string[] };
  optionsWhen?: Array<{ field: string; equals: string; options: string[] }>;
  tone?: "warning" | "danger";
};

export interface LockedBundle {
  template: BookingTemplateRecord;
  fields: LockedFormField[];
  rules: CalendarRoutingRuleRecord[];
}

// ─── 退租預約 (projectId: checkout) ──────────────────────────────────────

const CHECKOUT: LockedBundle = {
  template: {
    id: 1,
    projectId: "checkout",
    name: "退租預約",
    templateType: "退租",
    liffId: "2006833424-haBzHbwp",
    ragicSearchPath: "for-system-use/2",
    ragicUidField: "1007383",
    ragicTaskPath: "go-back/1",
    slotDurationMinutes: 60,
    bookableDaysAhead: 90,
    dailyStartTime: "13:00",
    dailyEndTime: "20:30",
    bufferMinutes: 30,
    bufferDirection: "after",
    weeklyHours: {
      "0": null,                                    // 週日：不開
      "1": null,                                    // 週一：不開
      "2": { start: "17:00", end: "20:30" },        // 週二
      "3": { start: "13:00", end: "20:30" },        // 週三
      "4": null,                                    // 週四：不開
      "5": null,                                    // 週五：不開
      "6": { start: "13:00", end: "20:30" },        // 週六
    },
    instructionEnabled: true,
    instructionText:
      "請攜帶鑰匙，房間各個角落請務必清潔乾淨，返回原始屋況唷！\n" +
      "以下為特別注意檢查事項\n\n" +
      "1️⃣有黏貼物：掛鉤、鏡子、等物品\n\n" +
      "2️⃣地板、窗溝、床底下、櫃子灰塵毛髮等請做掃除擦拭。\n\n" +
      "3️⃣不屬於原始屋內家具\n\n" +
      "4️⃣公共區域(冰箱、廚房、餐桌、後陽台、廁所、鞋櫃)物品\n\n" +
      "5️⃣📸📸清理完後請拍床墊照片並回傳小幫手🎞\n\n" +
      "6️⃣公共費用：後續流在群組待帳單出來後跟小班長結清，如有特殊狀況另外說明\n\n" +
      "7️⃣如垃圾量過多，請自行找垃圾車丟棄，垃圾代收廠商是無法收取太多垃圾的，衍生的費用會向超量丟棄的室友索取喔!\n\n" +
      "8️⃣費用計算基準日以退租當日為主，並請準備存摺照片，退租當下需上傳\n\n" +
      "9️⃣若環境沒有恢復原況，會從押金扣掉2000元清潔打掃費用，請特別注意～\n" +
      "床墊若有難以清除的髒污，會另外收取2500元喔！\n\n" +
      "如果還在找房，可以參考一方的空房喔\n" +
      "https://maps.oneplace.com.tw/oneplace\n",
    minLeadDays: 2,
    isActive: true,
    createdByUserId: 180800,
    createdAt: LOCKED_EPOCH,
    updatedAt: LOCKED_EPOCH,
  },
  fields: [
    {
      id: 270025,
      templateId: 1,
      fieldType: "checkbox",
      label: "合約到期退租最多退還7天租金",
      isRequired: true,
      options: ["同意"],
      ragicFieldId: null,
      descriptionText: null,
      allowOther: false,
      selectionMode: "radio",
      sortOrder: 0,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 270026,
      templateId: 1,
      fieldType: "text",
      label: "退租原因",
      isRequired: true,
      options: null,
      ragicFieldId: "1012558",
      descriptionText: null,
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 1,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 270027,
      templateId: 1,
      fieldType: "checkbox",
      label: "如果以你的角度，以下方案哪些會是你續約的誘因呢",
      isRequired: true,
      options: [
        "品牌內換房方條件放寬",
        "提前提供其他空房訊息",
        "強化案場管理機制(如篩選室友、生活習慣)",
        "增加房子更多設備",
        "提供續約優惠方案(如冷氣清潔、洗衣機清潔、續約獎勵金)",
        "不定期舉辦活動，增加室友連結",
      ],
      ragicFieldId: "1022999",
      descriptionText: null,
      allowOther: true,
      selectionMode: "checkbox",
      sortOrder: 2,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 270028,
      templateId: 1,
      fieldType: "description",
      label: "小班長勞報單",
      isRequired: false,
      options: null,
      ragicFieldId: null,
      descriptionText:
        "如為小班長，可提前填寫勞報單，不確定的內容，退租當天可再修改\nhttps://pse.is/8y3wqp",
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 3,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 270029,
      templateId: 1,
      fieldType: "inbox_url",
      label: "對話網址",
      isRequired: false,
      options: null,
      ragicFieldId: "1022936",
      descriptionText: null,
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 4,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 270030,
      templateId: 1,
      fieldType: "file",
      label: "可先上傳存摺喔，退租匯款需要",
      isRequired: false,
      options: null,
      ragicFieldId: "1013889",
      descriptionText: null,
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 5,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 270031,
      templateId: 1,
      fieldType: "text",
      label: "匯款通知email",
      isRequired: true,
      options: null,
      ragicFieldId: "1023169",
      descriptionText: "退租押金／帳單的匯款通知會寄到這個 email，請正確填寫",
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 6,
      createdAt: LOCKED_EPOCH,
    },
  ],
  rules: [
    {
      id: 300017,
      templateId: 1,
      days: [2, 3, 4, 5, 6],
      calendarId:
        "3ba1f394a1086c1ee687503325193d6d01ab1b0b0d773b4c8f9b043a58bde88e@group.calendar.google.com",
      calendarLabel: "退租",
      ownerName: "王可信",
      weeklyStartTime: null,
      weeklyEndTime: null,
      sortOrder: 0,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 300018,
      templateId: 1,
      days: [2, 3, 4, 5, 6],
      calendarId: "mry88312@gmail.com",
      calendarLabel: "自己",
      ownerName: "王可信",
      weeklyStartTime: null,
      weeklyEndTime: null,
      sortOrder: 1,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 300019,
      templateId: 1,
      days: [2, 3, 4, 5, 6],
      calendarId:
        "c7235d7c05656408d8c49f0cb14d781f36ea6c6a66b2f048c686de4e20311252@group.calendar.google.com",
      calendarLabel: "會議",
      ownerName: "王可信",
      weeklyStartTime: null,
      weeklyEndTime: null,
      sortOrder: 2,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 300020,
      templateId: 1,
      days: [2, 3, 4, 5, 6],
      calendarId:
        "92b45c73a99f09591c8ef87afda56b86286e2395f5a9ce44f8256562d5f4bbab@group.calendar.google.com",
      calendarLabel: "已預約",
      ownerName: "王可信",
      weeklyStartTime: null,
      weeklyEndTime: null,
      sortOrder: 3,
      createdAt: LOCKED_EPOCH,
    },
  ],
};

// ─── 續約預約 (projectId: contract) ──────────────────────────────────────

const CONTRACT: LockedBundle = {
  template: {
    id: 30002,
    projectId: "contract",
    name: "續約預約",
    templateType: "續約",
    liffId: "2006833424-znZYKjip",
    ragicSearchPath: "for-system-use/2",
    ragicUidField: "ragicTenantUid",
    ragicTaskPath: "go-back/1",
    slotDurationMinutes: 60,
    bookableDaysAhead: 90,
    dailyStartTime: "09:00",
    dailyEndTime: "18:00",
    bufferMinutes: 30,
    bufferDirection: "both",
    weeklyHours: {
      "0": { start: "13:00", end: "20:00" },        // 週日
      "1": null,                                    // 週一：不開
      "2": { start: "16:00", end: "20:00" },        // 週二
      "3": { start: "13:00", end: "20:00" },        // 週三
      "4": { start: "13:00", end: "20:00" },        // 週四
      "5": { start: "13:00", end: "20:00" },        // 週五
      "6": { start: "13:00", end: "20:00" },        // 週六
    },
    instructionEnabled: false,
    instructionText: null,
    minLeadDays: 6,
    isActive: true,
    createdByUserId: null,
    createdAt: LOCKED_EPOCH,
    updatedAt: LOCKED_EPOCH,
  },
  fields: [
    // ① 租期：1年 / 展延（選「展延」才會出現警示與月數）
    {
      id: 300013,
      templateId: 30002,
      fieldType: "select",
      label: "租期",
      isRequired: true,
      options: ["1年", "展延"],
      ragicFieldId: null,                            // TODO: 要寫回 Ragic 再補欄位ID
      descriptionText: null,
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 0,
      createdAt: LOCKED_EPOCH,
    },
    // ② 展延費用提醒（紅色警示框；僅選「展延」時顯示）
    {
      id: 300014,
      templateId: 30002,
      fieldType: "description",
      label: "展延費用提醒",
      isRequired: false,
      options: null,
      ragicFieldId: null,
      descriptionText: "⚠️ 展延需收取一次性 2,000 元，並且無租金優惠",
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 1,
      createdAt: LOCKED_EPOCH,
      showWhen: { field: "租期", equals: ["展延"] },
      tone: "danger",
    },
    // ③ 展延月數：1–11 個月（僅選「展延」時顯示）
    {
      id: 300015,
      templateId: 30002,
      fieldType: "select",
      label: "展延月數",
      isRequired: true,
      options: Array.from({ length: 11 }, (_, i) => `${i + 1}個月`),
      ragicFieldId: null,                            // TODO: 要寫回 Ragic 再補欄位ID
      descriptionText: null,
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 2,
      createdAt: LOCKED_EPOCH,
      showWhen: { field: "租期", equals: ["展延"] },
    },
    // ④ 繳費方式：1年→月繳/半年繳/年繳；展延→只剩月繳
    {
      id: 300009,
      templateId: 30002,
      fieldType: "select",
      label: "繳費方式",
      isRequired: true,
      options: ["月繳", "半年繳", "年繳"],
      ragicFieldId: "1013721",
      descriptionText: null,
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 3,
      createdAt: LOCKED_EPOCH,
      optionsWhen: [{ field: "租期", equals: "展延", options: ["月繳"] }],
    },
    {
      id: 300010,
      templateId: 30002,
      fieldType: "description",
      label: "更新個人資料",
      isRequired: false,
      options: null,
      ragicFieldId: null,
      descriptionText:
        "請先更新個人資料，並取得中信專屬固定式匯款帳號\nhttps://liff.line.me/2006833424-jX3tixwY",
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 4,
      createdAt: LOCKED_EPOCH,
    },
    // 註：原「您的本名」(1013030) 已移除 — 不再收本名（姓名仍在任務名）。
    // 「線上續約」標記（1013030="線上續約"）由 bookingConfirmHandler 只對 projectId="renewal"（線上）寫入；
    // 本 contract(線下續約)模版不寫。
    {
      id: 300012,
      templateId: 30002,
      fieldType: "inbox_url",
      label: "對話",
      isRequired: false,
      options: null,
      ragicFieldId: "1022936",
      descriptionText: null,
      allowOther: false,
      selectionMode: "checkbox",
      sortOrder: 6,
      createdAt: LOCKED_EPOCH,
    },
  ],
  rules: [
    {
      id: 330005,
      templateId: 30002,
      days: [2, 5, 6],                              // 週二、週五、週六 → 曾國桐
      calendarId: "bryan30740@gmail.com",
      calendarLabel: "國桐",
      ownerName: "曾國桐",
      weeklyStartTime: null,
      weeklyEndTime: null,
      sortOrder: 0,
      createdAt: LOCKED_EPOCH,
    },
    {
      id: 330006,
      templateId: 30002,
      days: [0, 3, 4],                              // 週日、週三、週四 → 張劭淩
      calendarId: "danny.oneplace@gmail.com",
      calendarLabel: "張劭淩",
      ownerName: "張劭淩",
      weeklyStartTime: null,
      weeklyEndTime: null,
      sortOrder: 1,
      createdAt: LOCKED_EPOCH,
    },
  ],
};

// ─── Registry & lookup ──────────────────────────────────────────────────

const REGISTRY: Record<string, LockedBundle> = {
  checkout: CHECKOUT,
  contract: CONTRACT,
};

/**
 * 用 projectId 查詢 hardcode 的 booking template bundle。
 * 找到 → 回傳完整 bundle（template + fields + rules）；沒找到 → null（呼叫端應 fallback DB）。
 */
export function getLockedBundle(projectId: string): LockedBundle | null {
  return REGISTRY[projectId] ?? null;
}

/**
 * 用 projectId 查 active 的 hardcode template（自動過濾 isActive=false）。
 * Handler 使用範例：`const template = getLockedTemplate(projectId) ?? (await dbQuery)[0]`
 */
export function getLockedTemplate(projectId: string): BookingTemplateRecord | null {
  const b = REGISTRY[projectId];
  return b && b.template.isActive ? b.template : null;
}

/** 用 templateId 反查 hardcode 的 rules（找不到回 null，呼叫端 fallback DB） */
export function getLockedRules(templateId: number): CalendarRoutingRuleRecord[] | null {
  for (const b of Object.values(REGISTRY)) {
    if (b.template.id === templateId) return b.rules;
  }
  return null;
}

/** 用 templateId 反查 hardcode 的 form fields（找不到回 null，呼叫端 fallback DB） */
export function getLockedFields(templateId: number): BookingFormFieldRecord[] | null {
  for (const b of Object.values(REGISTRY)) {
    if (b.template.id === templateId) return b.fields;
  }
  return null;
}

/** 列出所有 locked projectIds（debug / 健康檢查用） */
export function listLockedProjectIds(): string[] {
  return Object.keys(REGISTRY);
}
