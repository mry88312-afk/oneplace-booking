# ONE-772 預約換庫與重送防護

工單：https://oneplace-tw.atlassian.net/browse/ONE-772
PR：https://github.com/mry88312-afk/oneplace-booking/pull/8

## 症狀與原因

2026-10-28 正式部署 `3343275dc7d4a0269a824d91aeb134c85773d0ee` 的 runtime log 與唯讀連線均確認舊 Manus TiDB 回覆 `ER_ACCESS_DENIED_ERROR / 1045`。公開 HTML/health 200，但預約管理 API 500。

舊順序為 Ragic 建單 → 附件 → 本地紀錄。最後寫資料庫失敗時，Ragic 任務已存在，租客重送會再建一筆；SQL 例外還把表單帳戶與照片 base64 帶回前端。附件或 Ragic 失敗也可能被略過後仍顯示成功。

10/31、228-2A 的任務 1013–1019 各有不同 Ragic key 與 Calendar event。調查時六筆已由既有流程取消，1013 的 18:00–19:30 事件仍存在；本工作未改刪這些資料。「更早成功但未顯示日曆」的發生時點缺原始證據，不能以目前事件存在推論當時正常。

## 使用者批准與資料界線

2026-10-28 使用者選本機、批准建立工單與開始修正，並明確決定「恢復新的，歷史不用補，因為也會直接寫入 Ragic」。之後明確批准「開始執行 Supabase 換庫與部署」。

- 只恢復新預約；不搬歷史 booking_records，不補跑 Ragic、日曆或通知。
- 新庫保留 checkout 退租、contract 一般續約設定。renewal 線上續約原本即 404，缺設定來源，暫不臆造啟用。
- 舊卡片以數字 ID 操作，不能對應新庫。新卡帶固定 dataset；缺少或不符的舊卡在讀取紀錄及外部寫入之前拒絕，由小幫手依 Ragic 協助。
- 不新增日曆建立者，延續 Ragic 既有日曆連動。
- 主機仍是 Zeabur；換庫不等於網站已搬離 Zeabur。平台終止服務公告與主機後續遷移另案處理：https://zeabur.com/zh-TW/blogs/zeabur-is-shutting-down

## 最終程式行為

1. 瀏覽器保存 request ID，作用範圍含 dataset、專案、租客、房號；錯誤、重開頁面與未確認時換時段沿用原 ID。相同 ID 改內容會被拒絕。
2. PostgreSQL 先以唯一 request_key 取得持久預約權，才呼叫 Ragic。DB 不可用時不做外部寫入。
3. Ragic 回應不明、附件失敗或 COMMIT 回應中斷皆保留待核對。沒有自動逾時刪除或重建任務。
4. 完成紀錄及完成回執同一 transaction；重播回原編號，不重送通知。取消、刪除、改期後不重播過時成功。
5. 待核對不顯示成功；附件須有成功回執；前端錯誤移除 SQL、參數、stack。照片 data URL 不存入本地預約紀錄。
6. 專用 PostgreSQL 連線先 SELECT 1，TLS 檢查 CA 與主機名稱，不回退舊 DATABASE_URL。CA 支援 PEM 換行或環境變數的字面 \\n。
7. BOOKING_WRITES_ENABLED=false 時確認、取消、改期均停止外部寫入。

防重送保證以同一 request ID 為界；不同裝置、清空瀏覽器儲存或新 ID 的業務重複仍需另行核對。Ragic 與本地 DB 不可能跨服務原子提交，待核對狀態因此必須保留。

## 已套用的正式資料庫變更

- Supabase「一方生活」project `dwoahbduwzfzqmwpvadj`，Tokyo / PostgreSQL 17。
- migration `20261028105027_one772_booking_postgres` 已由 Supabase apply_migration 成功執行，且已回讀 migration history；先於程式合併。
- 新增私有 schema `booking` 下五表：booking_templates、booking_form_fields、calendar_routing_rules、booking_records、booking_submission_attempts。
- 專用角色 `oneplace_booking`，非 superuser、非 createdb/createrole、無 bypassrls。五表開啟 RLS，僅服務角色有表操作及 sequence USAGE/SELECT。
- anon / authenticated 沒有 booking schema USAGE；服務角色沒有 finance schema USAGE。沒有修改其他系統的表或權限。
- 只從 server/config/lockedTemplates.ts 初始化 2 個模版、17 個欄位、3 條路由；所有資料庫欄位逐欄回讀一致。保留既有設定 ID / LIFF / 時段 / 日曆及 Ragic 欄位。
- 安全 advisor 新增 booking schema 的 findings 為 0；其他系統既有 findings 未處理。
- 已刪除未套用的 MySQL 候選 `drizzle/20261028174000_one772_booking_submission_attempts.sql`，**勿復原或套用**。既有歷史 migration 不變。

## 工程與資料庫證據

- npm run check：0 錯，包含新增 scripts。
- npm test：54 pass、0 fail、0 skip。
- npm run build：前後端成功。
- 專用角色經嚴格 TLS 實際連線成功。
- scripts/verify-booking-db.ts：真實新庫 20 個並發相同請求只執行一次假建單；內容衝突阻擋、完成重播、取消/改期後阻擋、transaction rollback、COMMIT 回應遺失後重播、外部 timeout 待核對及權限檢查均通過。
- 該整合驗證使用本工作隨機測試 UID 與回執 key；0 次真實外部寫入。finally 僅清除此 UID/key，回讀確認 0 殘留。
- 實際 build 前端搭配無正式憑證的合成後端：待核對留在表單、不顯示成功；重送不再建假任務；SQL/帳戶/照片錯誤僅顯示一般錯誤。舊卡顯示聯絡小幫手訊息。
- 正式部署 SHA、設定啟用、正式畫面與自然新預約驗收，以 ONE-772 最後驗證留言為準。上述工程證據不等於真實 Ragic/Calendar/LINE E2E 驗收。

本機 worktree：`C:\Users\mry88\.codex\worktrees\one-772-booking-reliability\oneplace-booking-zeabur`
branch：`codex/ONE-772-booking-reliability`

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\mry88\.codex\scripts\Invoke-CodexHeavyTask.ps1" -WorkingDirectory "C:\Users\mry88\.codex\worktrees\one-772-booking-reliability\oneplace-booking-zeabur" -Label "ONE-772 checks" -Command 'npm run check; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm test; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run build; exit $LASTEXITCODE'
```

`seedBooking(db)` 只適用初始化：空設定表時寫入，非空時僅比對；不覆蓋已修改的設定。設定 ID 是 lockedTemplates 的既有常數，不是猜測新產生的 ID。`verifyBookingDatabase()` 必須明確提供專用 BOOKING_DATABASE_URL / CA / DATASET_ID，不能拿其他系統的連線代入。

## Zeabur 設定與部署順序

平台 / 專案 / 環境 / 服務：Zeabur / ONEPLACE (`68ef04ed4687e810da4d5744`) / `68ef04edb2a6ab999f05f6b3` / oneplace-booking (`68ef04f8a21c40597899e7dd`)。

| 名稱 | 用途與安全來源 | 生效與影響 |
|---|---|---|
| BOOKING_DATABASE_URL | 專用角色的新庫連線；安全隨機產生角色密碼，不存 Git、PR 或文件 | 重啟；只用於新預約資料 |
| BOOKING_DATABASE_CA | Supabase 官方公開 CA，保持 rejectUnauthorized=true | 重啟；驗證資料庫 TLS |
| BOOKING_DATASET_ID | 固定 booking-20261028-one772；新卡及取消/改期共用 | 重啟；不得隨部署改動 |
| BOOKING_WRITES_ENABLED | 初始 false；新版新庫與正式 smoke 驗證後才改 true | 重啟；false 暫停確認/取消/改期 |

這四項已經由管理台存入指定服務，部署前維持 false；舊 DATABASE_URL 未換塞 PostgreSQL。原 SUPABASE_DB_URL 保留給既有週期詢問等模組。

1. 套正式 migration 並驗證新庫、設定、角色權限及測試清理。
2. 合併批准的 PR，確認實際部署 SHA 及 build/runtime 狀態。
3. 寫入關閉時驗證後台清單、公開設定、舊卡拒絕及錯誤遮罩。
4. 啟用 BOOKING_WRITES_ENABLED=true，重啟並回讀正式 API 與實際頁面。
5. 第一筆自然新預約另核對本地完成回執、Ragic 任務 ID、Calendar event、LINE 通知；本次不製造真實外部測試任務。

## 失敗回滾

- 任一切換驗證失敗：設 BOOKING_WRITES_ENABLED=false 並重啟。保留新庫與回執，交小幫手依 Ragic 核對，禁止重送歷史任務。
- 已有新預約後不得重建空庫、換 dataset 或重新產生 request ID。只可回退至相容新 schema / 防重送設計的版本。
- 舊 TiDB 已知 1045；指回舊連線不是可用回滾。不得回退到「先建 Ragic、最後才記本地」的舊程式來恢復流量。
- 不 DROP schema、不大量 UPDATE、不更動其他系統資料。若需要主機遷移，另行對齊範圍。
