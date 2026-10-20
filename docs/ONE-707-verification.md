# ONE-707 驗證與發布紀錄

## 2026-10-20 本機與資料庫驗證

- Branch：`codex/ONE-707-jgb-rent-reminders`，基準 `origin/main`：
  `8d02705235593a63849f331281e300884e833865`。
- Worktree：`C:\Projects\oneplace-booking-zeabur-worktrees\ONE-707-jgb-rent-reminders`。
- `npm run check`：exit 0。
- Node tests：26/26 通過（租金提醒 11 組、既有 relay／合約／虛擬帳號回歸 15 組）。
- `npm run build`：exit 0；`git diff --check`：無錯誤。
- JGB 真實 XLSX：正確讀取「帳務報表」，不混入「發票報表」；108 張逐筆／總計核對通過。
- 19:27 台北即時來源與 DB 精確 ID 對應：15 張符合總公司規則、14 位主承租人。
  詳細金融資料與圖片只留在本機忽略目錄，未加入 Git。
- 19:35 台北，使用者親自登入 `http://localhost:3097/admin` 後，
  實際操作「週期詢問 → 租金提醒 → 預覽目前名單」，顯示 15 張可提醒。
  設定、空歷史狀態及名單表格可見；瀏覽器 error log 為空。
- 真實後端 API：無 secret 的排程要求 401；無管理憑證的紀錄要求 401；
  已授權紀錄查詢 200；關閉狀態的排程要求回 skipped，run/message 均 0。

## 正式 migration

- 目標：一方生活 Supabase `dwoahbduwzfzqmwpvadj`。
- 檔案：`docs/migrations/20261020113000_one707_rent_reminders.sql`。
- Supabase 登錄版本：`20261020112839` / `one707_rent_reminders`
  （MCP 依套用時間編號；與檔案預定時間不同）。
- 新增 `outreach.rent_reminder_settings`、`outreach.rent_reminder_runs`；
  兩表 RLS 開啟、anon/authenticated 無直接權限。
- 新增 cron `one707-rent-reminders-noon`：`0 4 * * *`（UTC），即台北 12:00。
- 獨立讀回：`enabled=false`、`start_date=2026-10-21`、cron active；
  未啟用時 cron function 不呼叫通知端點。未發送任何租客通知。
- 既有 JGB 財務、合約、tenant、其他發訊排程資料未改寫。

## 發布剩餘檢查

1. 使用者合併 PR（多檔改動依全域工作規則）。
2. 確認 Zeabur `oneplace-booking` 正式部署 commit／Running 狀態、
   新版公開資源及租金紀錄 API；確認 BOOKING_WEBHOOK_SECRET、OUTREACH_RUN_SECRET 已設定。
3. 正式後台登入目視驗證（本機畫面不等於正式站驗收）。
4. 再啟用 rent_reminder_settings，讀回 enabled、生效日及排程時間。
5. 2026-10-21 首次執行後核對真實 LINE 接受回執與來源／名單；
   尚未發生的通知不能預先宣稱驗收完成。

## 回滾

先暫停 `outreach.rent_reminder_settings.enabled`，保留 run、schedule 與去重紀錄。
租金 schedule 使用 suppressed 作為專用待處理／不明結果狀態，
不會由舊的一般派送器重試；新 UI 也禁止改期／確認／重送租金紀錄。
確認沒有 rent schedule 為 pending/confirmed 後才回退到不含新防護的版本。
不要刪除紀錄或以手動補送解決未知回應。
