# ONE-707 JGB 應到帳租金提醒

決策日期：2026-10-20；工單：https://oneplace-tw.atlassian.net/browse/ONE-707
系統：booking / 一方生活 Supabase `dwoahbduwzfzqmwpvadj`。
工作位置：`C:\Projects\oneplace-booking-zeabur-worktrees\ONE-707-jgb-rent-reminders`。

## 問題與目標

營運每天需要確認 JGB 應到帳租金並通知承租人，目前缺少可追溯的自動提醒。
承租人應能直接看到帳單名稱、逾期天數、整張金額與費用明細；營運可在 booking 統一發訊中樞查看結果。

驗收目標：每筆通知具備完整 ID 對應、同一帳單同一天最多一次發送嘗試、
非總公司／示範／已到期合約零通知、所有發送或阻擋均可查原因。
實際入帳改善率屬上線後觀察指標，沒有預先承諾數值。

## 已批准的業務規則（單一來源）

1. 台北日期計算逾期日數，到期日 D 的 D+2 起每日 12:00 執行。
2. 預定首次執行 2026-10-21；**納入現有逾期帳單**。
   先前「只提醒啟用後到期帳單」方案已作廢，勿復原。
3. 範圍為 JGB 收入帳單、狀態「應到帳 / unreceived」、租金項目大於零。
4. 只通知 `property.properties.ownership_region='總公司'` 且
   `hq_internal_category` 不是「靠行」的租約。其他或不明歸屬不通知。
   `franchisee_id IS NULL` 不能代表總公司。
5. 收件鏈：JGB 合約 ID → 唯一未刪除合約 → 唯一 primary 承租人 → 有效 LINE UID。
   主檔 jgb_id 空白時可用同份合約原始 Ragic `legacy_snapshot['1007543']`。
   兩者衝突或多筆對應先待核對，不猜姓名／房號／電話。
6. 排除游凰儀、藍堂嘉示範（姓名去除空白）。JGB 或主檔租約已到期者排除；
   有實際退租日者不通知。取消／退租標記但租期未到的 4 張歷史帳單仍待核對。
7. 全張應到帳金額及全部非零費用明細；負折扣照原符號，明細和必須與總額一致。
   不自行推算部分入帳剩餘額；狀態、金額矛盾則待核對。
8. 帳單名稱使用 JGB 帳單描述（如 2026/08-帳單），不得以繳費期限猜月份。
   顯示原繳費期限、帳單期間、台北發送日計算的「已逾期 N 天」。
9. 每張帳單每天一張卡；同一人多張帳單各自列明。只發主承租人。
10. 已確認入帳或不再符合條件後停止。發送依據是當日重新取得的完整 JGB
    應到帳匯出，不能使用缺少歷史範圍或過期的 mirror 補送。

## 使用情境及 P0 驗收

- 承租人：在中午收到已核可的綠色 Flex 卡，可回覆付款日期與末五碼協助核對。
- 營運：在 booking → 統一發訊中樞 → 租金提醒，查看啟用狀態、每日執行結果、
  收件人、房屋、合約、帳單名稱、逾期天數、金額、時間、阻擋或失敗原因。
- 營運可暫停／恢復每日提醒。啟用不會立即發送，仍遵守生效日與中午時段。
- 原排程看板保留租金通知紀錄；租金通知不能經「立即送」繞過每日安全檢查。
- 來源匯出失敗、格式改變、總計不符、映射缺失：不發，顯示原因。
- 同日重跑、重疊請求、程序中斷後重啟：不得重送。回應不明標記待核對，
  不做當日自動重試；LINE 接受回執不代表已讀。
- 所有後台查詢／設定沿用 adminProcedure；排程端點沿用 OUTREACH_RUN_SECRET。

P1：人工補綁後的資料核對、營運統計。
P2：加盟與各品牌獨立 LINE channel；本次不跨品牌發送、不建立付款或對帳流程、
不修改合約或 JGB 帳務、不新增第二套發訊中心。

## 實作與部署

- `server/rentReminders/`：資料解析、規則、Flex、JGB 匯出及每日執行。
- `server/routers/property/outreachHandlers.ts`：整合後台查詢與設定，阻擋一般派送器重送。
- `client/src/pages/BookingAdmin/RentRemindersTab.tsx`：復用既有 Tabs/Card/Button/Input。
- `docs/migrations/20261020113000_one707_rent_reminders.sql`：
  outreach 設定及每日執行紀錄、pg_cron / pg_net。預設關閉，migration 不發送。
- 沿用 outreach.schedule 記錄及 dedupe_key；先持久化發送嘗試，再呼叫既有客服 relay。
  租金通知使用單次 relay 請求及明確 LINE message ID 驗證，不使用網路重試。
- JGB 完整應到帳匯出走既有 `jgbcontractkehsin.zeabur.app`，當日 12:00 開始抓取；
  匯出完成後數分鐘內依序發送。資料超過 15 分鐘或跨出中午執行時段則停止。
- 使用現有 SUPABASE_DB_URL、OUTREACH_RUN_SECRET、BOOKING_WEBHOOK_SECRET、
  MAIN_SYSTEM_WEBHOOK_URL；不將憑證寫入文件／資料表。
- 新資料表 RLS 開啟，瀏覽器不可直接存取。以後端既有資料庫連線存取。

## 驗證及回滾

1. 規則測試：D+1/D+2、台北跨日、歷史帳單、所有排除項、UID 衝突、
   金額／負折扣、帳單名稱、無資料或壞欄位。
2. 來源解析測試：完整 footer、重複 bill ID、欄位變更與金額不一致。
3. 每日執行測試：併發／重跑、pause、當日入帳後消失、relay 不明結果不重試。
4. 執行型別檢查、必要 node tests、build；以最新 JGB 唯讀預覽核對 HQ 名單。
5. migration 套一方生活庫後讀回；PR 審閱與部署分開記錄；未實際部署不啟用。
6. 後台畫面驗證、正式端點鑑權與設定讀回；使用者本人測試卡沿用已驗收版型。
7. 啟用後讀回 enabled/start_date/cron；明日實際發送回執屬後續營運證據。

回滾先將 `outreach.rent_reminder_settings.enabled=false`，阻止後續發送，
再回退應用版本；保留歷史與去重資料，不 DROP、不刪已發送紀錄。
若須回退至沒有租金派送防護的舊版，先確認租金 schedule 均不是 pending/confirmed。
資料不完整時不靠舊報表補送。明確區分程式完成、部署、啟用和真實通知。
