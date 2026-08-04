## Why

週期詢問（periodic-outreach）已上線並能「排程 → 手動確認 → 發送 LINE 卡片」，但實際營運每天可能有數十筆要處理，現有看板只能逐筆操作、看不到「今天／本週要發哪些、哪個案場幾筆」，發送失敗只留在伺服器 log、無法在介面追蹤與重送，也沒有成效統計。需要把看板從「能用」升級成「好營運」：可批次、可預覽、可追蹤並重送失敗、可匯出對帳、可依規則自動確認、可看成效；並把入住卡的互動回饋（住得習慣／想反應）改成 postback 回寫 Ragic，做情緒追蹤。

## What Changes

- **批次操作**：排程看板列表加勾選，對多筆一次「確認 / 跳過 / 立即送」，手動確認制下大幅省力。
- **每筆卡片預覽**：每筆旁邊「預覽」，用該筆實際變數渲染卡片並送到管理者的測試 LINE（沿用既有測試模式 test_redirect_uid，永不誤觸真人）。
- **「今天要發」快捷檢視 + 依案場分組**：一鍵看今天要發的清單；列表可依 property_name 分組並顯示每案場筆數。
- **失敗追蹤與重送**：outreach.schedule 新增 last_error / last_attempt_at / attempt_count 三欄；發送失敗時由 Zeabur 執行端點回寫；看板提供「失敗清單」檢視與一鍵重送。
- **匯出 CSV**：排程與歷史紀錄可匯出 CSV，方便對帳與回報。
- **每條規則「自動確認」開關**：outreach.rule 新增 auto_confirm 欄位（預設 false）；開啟後該規則的新排程由 recompute 直接建立為 confirmed（仍受測試模式重導與發送前雙層 gate 保護）。
- **發送成效統計**：依 status / sent_at / 失敗欄位彙總每月 sent / suppressed / failed 筆數與比例，並對低送達率（高 failed 比例）示警。
- **v2/v3 互動回饋（postback 回寫 Ragic）**：入住卡的「住得習慣 / 想反應」由純顯示改為 postback 動作，Zeabur 接 LINE inbound webhook 收 postback、把室友回饋回寫 Ragic（情緒追蹤）。**此項實作為 gated：需先確認 LINE 官方帳號 inbound webhook 目前指向哪個服務（決策見 design.md 的 Open Question），確認前不接線、不發佈。**
- **非破壞**：純擴充既有週期詢問。不改動既有的室友篩選邏輯、四條規則的時間計算、發送前雙層 gate、以及確認後才自動派送的核心行為。

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `periodic-outreach`: 在既有週期詢問能力上新增——看板批次操作、每筆預覽（送測試 LINE）、今天／案場分組檢視、發送失敗追蹤與重送、排程與歷史 CSV 匯出、每條規則自動確認、發送成效統計，以及入住卡 postback 互動回饋回寫 Ragic。

## Impact

- Affected specs: periodic-outreach (modified)
- Affected code:
  - Modified:
    - server/routers/property/outreachHandlers.ts
    - server/index.ts
    - client/src/pages/BookingAdmin/OutreachBoard.tsx
  - New:
    - server/routers/property/outreachFeedbackHandlers.ts （postback 接收與 Ragic 回寫；gated，待 webhook 落點確認後實作）
  - Removed: (none)
- External systems（Supabase 專案 dwoahbduwzfzqmwpvadj，非本 repo）：
  - outreach.schedule 新增 last_error(text) / last_attempt_at(timestamptz) / attempt_count(int) 三欄。
  - outreach.rule 新增 auto_confirm(boolean default false) 欄位。
  - outreach.recompute_schedule() 依規則 auto_confirm 決定新建排程列的初始 status（confirmed 或 pending）。
  - Zeabur 執行端點（run）發送失敗時回寫 last_error / last_attempt_at / attempt_count。
- 外部系統（Ragic）：postback 互動回饋回寫 Ragic 的情緒／回饋欄位（gated，落點待 design.md Open Question 確認）。
- 設定／環境：沿用既有 test_redirect_uid 與 OUTREACH_RUN_SECRET；postback 需設定 LINE inbound webhook（gated）。
