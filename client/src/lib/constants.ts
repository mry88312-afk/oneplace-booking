export const TASK_STATUS_LABELS: Record<string, string> = {
  NEW: "新指派",
  ACCEPTED: "已接受",
  SCHEDULED: "已排程",
  IN_PROGRESS: "進行中",
  WAITING: "等待中",
  DONE: "已完成",
  FOLLOW_UP: "需後續",
  CLOSED: "已結案",
};

export const TASK_STATUS_COLORS: Record<string, string> = {
  NEW: "bg-emerald-50 text-emerald-700 border-emerald-200",
  ACCEPTED: "bg-teal-50 text-teal-700 border-teal-200",
  SCHEDULED: "bg-cyan-50 text-cyan-700 border-cyan-200",
  IN_PROGRESS: "bg-amber-50 text-amber-700 border-amber-200",
  WAITING: "bg-orange-50 text-orange-700 border-orange-200",
  DONE: "bg-green-50 text-green-700 border-green-200",
  FOLLOW_UP: "bg-sky-50 text-sky-700 border-sky-200",
  CLOSED: "bg-stone-100 text-stone-600 border-stone-200",
};

export const TASK_TYPE_LABELS: Record<string, string> = {
  REPAIR: "維修",
  HANDOVER: "交屋",
  MEASURE: "丈量",
  DELIVERY: "送件",
  INSPECTION: "驗屋",
  SUPPORT: "支援請求",
  MEETING_ACTION: "會議決議",
  VIEWING: "帶看",
  SIGNING: "簽約",
  OTHER: "其他",
};

export const TASK_TYPE_ICONS: Record<string, string> = {
  REPAIR: "🔧",
  HANDOVER: "🏠",
  MEASURE: "📐",
  DELIVERY: "📦",
  INSPECTION: "🔍",
  SUPPORT: "🆘",
  MEETING_ACTION: "📝",
  VIEWING: "👁️",
  SIGNING: "✍️",
  OTHER: "📋",
};

export const SUPPORT_CATEGORY_LABELS: Record<string, string> = {
  TENANT: "租客問題",
  MATERIAL: "材料補給",
  COLLABORATOR: "人力支援",
  ACCESS: "進場協助",
  SCOPE: "超出範圍",
  OTHER: "其他",
};

export const PRIORITY_LABELS: Record<string, string> = {
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高",
  URGENT: "緊急",
};

export const PRIORITY_COLORS: Record<string, string> = {
  LOW: "bg-stone-100 text-stone-600 border-stone-200",
  MEDIUM: "bg-teal-50 text-teal-700 border-teal-200",
  HIGH: "bg-orange-50 text-orange-700 border-orange-200",
  URGENT: "bg-red-50 text-red-700 border-red-200",
};

export const WAITING_REASON_LABELS: Record<string, string> = {
  WAITING_TENANT: "等待租客",
  WAITING_COLLABORATOR: "等待協作者",
  WAITING_MATERIAL: "等待材料",
  WAITING_APPROVAL: "等待核准",
  WAITING_ACCESS: "等待進場",
};

export const EXPENSE_CATEGORY_LABELS: Record<string, string> = {
  MATERIAL: "材料",
  PART: "零件",
  TRANSPORT: "交通",
  CONSUMABLE: "耗材",
  OTHER: "其他",
};

export const EXPENSE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  SUBMITTED: "已提交",
  NEED_MORE_INFO: "需補件",
  APPROVED: "已核准",
  REIMBURSED: "已核銷",
  REJECTED: "已退件",
};

export const EXPENSE_STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-stone-100 text-stone-600 border-stone-200",
  SUBMITTED: "bg-teal-50 text-teal-700 border-teal-200",
  NEED_MORE_INFO: "bg-orange-50 text-orange-700 border-orange-200",
  APPROVED: "bg-green-50 text-green-700 border-green-200",
  REIMBURSED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  REJECTED: "bg-red-50 text-red-700 border-red-200",
};

export const REVIEW_ISSUE_STATUS_LABELS: Record<string, string> = {
  PENDING: "待處理",
  ASSIGNED: "已分配",
  IN_PROGRESS: "處理中",
  RESOLVED: "已解決",
  CLOSED: "已結案",
};

export const REVIEW_ISSUE_STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  ASSIGNED: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  IN_PROGRESS: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  RESOLVED: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  CLOSED: "bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400",
};

export const ROLE_LABELS: Record<string, string> = {
  admin: "管理員",
  dispatcher: "內勤專員",
  field_worker: "外勤人員",
  finance: "財務",
};
