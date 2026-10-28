# ONE-772 預約重送與資料庫切換

工單：https://oneplace-tw.atlassian.net/browse/ONE-772

## 已確認的症狀與原因（2026-10-28）

- 正式程式來源：`mry88312-afk/oneplace-booking`，部署基準 `3343275dc7d4a0269a824d91aeb134c85773d0ee`。
- 正式站：`https://oneplace-booking.zeabur.app`。公開 HTML/health 200，但管理預約 API 500；兩者不是同一項健康證據。
- 正式部署 log 與原本本機設定的唯讀連線都得到 TiDB `ER_ACCESS_DENIED_ERROR / 1045`。
- 舊順序為 Ragic 建單 → 附件 → 本地 booking_records。最後一步失敗時，外部任務已存在，租客看到失敗而重送，就再建一筆。
- 本地儲存包含照片 base64；資料庫例外把 SQL/參數傳回前端，符合第一張截圖。附件上傳及 Ragic 建單失敗也曾被忽略，仍可能顯示成功。
- 本次核對的 10/31、228-2A 任務 1013–1019 各有不同 Ragic key 與 Calendar event，不是同一個事件被日曆顯示七次。核對時其中六筆已被既有流程取消，1013 的 18:00–19:30 事件仍存在；本工作沒有改刪這些資料。
- 「之前成功卻沒有出現在日曆」的最初發生時點沒有完整證據；不能因目前事件存在就宣稱當時沒有異常。
- README 明示這套服務原先共用 Manus 的 TiDB。TiDB/Manus 管理端均尚未登入，無法確認誰目前管理該資料庫。

## 本分支已實作的防護（尚未上線）

1. 瀏覽器保存 request ID，錯誤、重開頁面與未確認時換時段沿用原 ID。同一 ID 的不同內容被拒絕，不自動再建單。
2. 先在資料庫以唯一 request key 取得持久預約權，再呼叫 Ragic。資料庫故障或缺 migration 時停止外部寫入。
3. Ragic 已寫入、回應不明、附件失敗、資料庫 COMMIT 結果不明皆保留待核對。無逾時自動重設、重送或清除機制。
4. 本地預約與完成回執同一 transaction；成功重播回原編號，不再送成功通知。取消、刪除或改期後不重播過時確認。
5. 只有新完成的操作會執行既有後續通知；pending 不顯示成功。附件需要成功回執。錯誤回應移除 SQL/參數/stack，儲存前移除照片 data URL。
6. 連線池實際執行 SELECT 1 才標記成功，並關閉失敗的候選 pool。

防護是每個 request ID 的 at-most-once。不同裝置、清除瀏覽器儲存或刻意使用新 ID，不等於同一操作；不宣稱已處理任意跨裝置的業務重複預約。

### 目前 migration 的界線

`drizzle/20261028174000_one772_booking_submission_attempts.sql` 是 **MySQL/TiDB 候選**，尚未套用任何庫。
**不得把它套到 Supabase，也不得在資料庫驗證前合併部署此候選。**
若採下述 PostgreSQL 方案，應先改寫 schema、store、connection 與 migration，再更新同一 PR；舊 MySQL 候選不應被當成 PostgreSQL 完成品。

## 已取得的工程證據

- 在獨立 worktree 跑 `npm run check`：0 錯。
- `npm test`：51 pass、0 fail、0 skip（既有 27 + 新增 24）。
- `npm run build`：前後端建置成功。
- 實際 production build 前端 + 本機合成 tRPC 後端，沒有載入正式 .env 或排程，也沒有呼叫 Ragic/Calendar/LINE：
  - 附件失敗顯示「這筆預約仍待確認」，留在表單。
  - 連按與另一頁籤重開後，3 次請求只有 1 筆假任務、0 筆完成紀錄、2 次重播。
  - 原始 SQL/帳號/照片字串測試只顯示一般錯誤訊息。
  - 模擬 DB 1045 停在表單，未增加外部假任務。
  - 成功情境顯示日期、姓名、房號與「預約成功」。
- 當前 SQL store 尚無可用 MySQL 整合測試環境；Docker daemon 未啟動。單元測試、合成頁面不等於正式庫 transaction 或正式 Ragic/Calendar E2E 通過。
- 沒有正式 migration、合併、部署或真實租客成功預約驗收。

本機工作區：`C:\Users\mry88\.codex\worktrees\one-772-booking-reliability\oneplace-booking-zeabur`

驗證命令（重型工作必須經既有防護工具；單引號保留 PowerShell 變數）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\mry88\.codex\scripts\Invoke-CodexHeavyTask.ps1" -WorkingDirectory "C:\Users\mry88\.codex\worktrees\one-772-booking-reliability\oneplace-booking-zeabur" -Label "ONE-772 checks" -Command 'npm run check; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run build; exit $LASTEXITCODE'
```

## 使用者已決定的資料範圍

2026-10-28：本機執行、可建 Jira、開始執行防護修正。後續選擇換庫方向：
**恢復新的預約，歷史不用補，歷史以 Ragic 查詢。**

這不代表歷史確認卡還能靠新庫運作。取消與改期原本使用本地 bookingId；新庫必須有資料批次識別，拒絕舊確認卡，防止數字 ID 重用誤操作新預約。舊預約由小幫手依 Ragic 核對處理。

## 換庫最終建議與待批准範圍

不新增 Zeabur 資料庫。2026-10-28 管理台顯示此專案共享叢集禁止新服務；官方公告 2026-12-01 起陸續停用、12-31 全面停止：
https://zeabur.com/zh-TW/blogs/zeabur-is-shutting-down

候選目標為既有 Supabase「一方生活」：

- project ref：`dwoahbduwzfzqmwpvadj`，Tokyo / PostgreSQL 17。
- MCP 顯示 ACTIVE_HEALTHY；2026-10-28 18:19 台北唯讀 SQL 可執行，`booking` schema 尚不存在。
- 原本本機 SUPABASE_DB_URL 的 project ref 與此一致。正式部署設定仍須於切換時單獨核對。
- 使用獨立 `booking` schema 與限定權限的服務角色。此方案不另開 Supabase project，仍受既有方案用量/儲存/備份條件影響，不承諾零費用。

### 要變更的程式與資料

1. `drizzle/schema.ts`：四張預約表及 submission attempts 改用 Drizzle pgSchema("booking")；保留欄位用途、唯一約束與索引。
2. `server/db/connection.ts`：改用 pg + drizzle-orm/node-postgres，讀獨立 BOOKING_DATABASE_URL；仍須 SELECT 1 驗證。
3. `server/booking/submissionStore.ts`：INSERT RETURNING、PostgreSQL unique violation 23505、transaction 與 row lock；不得破壞先保留操作再寫 Ragic 的順序。
4. `server/routers/property/bookingTemplateHandlers.ts`：把 MySQL insertId 改為 RETURNING id；檢查 booking/outreach 查詢相容性。
5. `server/routers/property/bookingConfirmHandler.ts`、`bookingRescheduleHandlers.ts`、`booking.ts`、`client/src/pages/BookingPublic.tsx`：新確認卡加入資料批次識別；取消/改期 API 在查資料及寫 Ragic 前驗證，舊連結給聯絡小幫手訊息。
6. 新 PostgreSQL migration 建立：
   - booking.booking_templates
   - booking.booking_form_fields
   - booking.calendar_routing_rules
   - booking.booking_records（初始空白，不匯入歷史）
   - booking.booking_submission_attempts（初始空白）
   - 僅服務角色可操作，不向匿名/一般登入者開放；不得修改 finance、public 或其他系統表。
7. 只以 `server/config/lockedTemplates.ts` 初始化已確認的 checkout / contract 模版、欄位與分派：
   - checkout 退租：11 欄；目前公開 API routing days 3,4,6。
   - contract 一般續約：6 欄；目前公開 API routing days 2,5,6,0,3,4。
   - 保留現有 ID、LIFF、工時、緩衝、Ragic 欄位及日曆路由；先比對完整資料再 seed，不手填猜測新規則。
   - renewal 線上續約目前公開 API 404，無 locked bundle，缺設定來源。此階段不臆造並啟用，列為明確缺口。

### 環境變數與啟用順序（目前全部尚未設定/啟用）

平台 / 專案 / 環境 / 服務：
Zeabur / ONEPLACE (`68ef04ed4687e810da4d5744`) /
`68ef04edb2a6ab999f05f6b3` / oneplace-booking (`68ef04f8a21c40597899e7dd`)。

| 名稱 | 用途與安全來源 | 重啟與影響 |
|---|---|---|
| BOOKING_DATABASE_URL | 專用 booking 角色的 Supabase PostgreSQL 連線；由該專案管理設定/安全產生的角色憑證取得，不貼在文件、PR 或日誌 | 需要服務重啟；只供新預約資料使用 |
| BOOKING_DATASET_ID | 新資料批次識別，防舊確認卡指向新庫；新產生後固定保存，不隨部署改變 | 重啟；新卡/取消/改期共用 |
| BOOKING_WRITES_ENABLED | 切換期間關閉新預約外部寫入；新庫與正式版本驗證後才啟用 | 重啟；false 時顯示暫停/稍後再試 |

安全順序：

1. 完成 PostgreSQL 改寫、舊卡隔離與回歸測試，更新本 PR 的固定 SHA。
2. 檢查並行 migrations，套新 schema 到上述已驗證的正式 Supabase project；先套 migration 再合併程式。
3. 以限定測試 UID/ID 測試真實 DB 的競爭唯一約束、rollback、失敗回執；外部 Ragic/Calendar/LINE 均以假介面替代。清理本工作建立的有限測試資料並回讀確認。
4. 在預約服務設定三個變數，初始關閉寫入。legacy DATABASE_URL 不可直接改塞 PostgreSQL 字串給舊程式。
5. 合併並部署已批准 SHA；核對正式 runtime SHA、資料庫 SELECT 1、模版/分派 seed 逐欄回讀、後台與公開頁。
6. 驗證舊確認卡被拒絕、錯誤不含 SQL/附件、新頁面有穩定 request ID；啟用新預約。
7. 不以單元測試或 HTTP 200 宣稱 Calendar 成功；第一筆正常的新預約須另核對本地紀錄、Ragic ID、Calendar event 與通知。

### 失敗處理與回滾

- 驗證不過時保持 BOOKING_WRITES_ENABLED=false，保留診斷資料與新庫紀錄，不刪 schema，不重送 Ragic。
- 已有新預約後，保留新庫與新批次識別；不可把資料庫指回空庫或重建 request ID。只能回退到仍相容新 schema/防重送機制的版本。
- 舊 TiDB 目前已知不可連線，指回舊連線不能視為可用的回滾。若必須暫停，明確顯示暫停並交由小幫手用 Ragic 核對。
- 不能回退到「Ragic 先建單、DB 最後才寫」的舊程式來恢復流量。

應用程式主機仍在 Zeabur。換資料庫不等於整個網站已搬離 Zeabur；網站主機/網址/LIFF 的後續遷移需要另外對齊範圍。

## 狀態

防護候選已具工程證據，等待程式碼審查；正式 DB 未修復。
Supabase 換庫方向已完成唯讀盤點與方案，**尚未取得整套換庫、合併及部署範圍的開始執行確認**，也尚未對 Supabase 寫入。
