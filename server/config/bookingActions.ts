/**
 * 退租／續約預約的辨識表（ONE-881）。
 *
 * 週期詢問的「已有預約就不發到期卡」與「預約前一天提醒」都要認出哪些預約算退租、哪些算續約。
 * 過去靠資料庫模板欄位 bt_contractAction 判斷；預約改存新資料庫後該欄全為空，
 * 查詢永遠查無資料卻不報錯，防重與前一天提醒因此靜默失效。
 *
 * 改用模板代號（projectId）：代號寫在程式裡、公開網址也用它，不會因資料搬遷而遺失。
 * 註：不可為了這個用途去填 bt_contractAction —— 該欄有值時，預約確認流程會回寫 Ragic 合約欄位 1015394。
 */
export type BookingAction = "退租" | "續約";

export const BOOKING_ACTION_PROJECT_IDS: Record<BookingAction, readonly string[]> = {
  退租: ["checkout"],
  // contract＝舊線下續約入口（已停收新預約，既有預約仍有效）；renewal＝線上續約
  續約: ["contract", "renewal"],
};

/** 指定動作對應的模板代號；清單為空代表設定被改壞，直接報錯而不是默默查無資料。 */
export function projectIdsForBookingActions(actions: readonly BookingAction[]): string[] {
  const ids = actions.flatMap(action => BOOKING_ACTION_PROJECT_IDS[action] ?? []);
  if (ids.length === 0) throw new Error(`No booking projectIds configured for actions: ${actions.join(",")}`);
  return [...new Set(ids)];
}
