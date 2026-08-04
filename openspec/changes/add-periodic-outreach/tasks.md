## 1. Supabase 排程大腦

- [x] 1.1 建立 outreach schema 與 outreach.schedule 表（含 status / manually_edited / sent_at 等欄位與 unique(tenant_uid, rule_type, contract_no)）。完成標準：在 Supabase 以 information_schema 查得到該表與 unique 約束。
- [x] 1.2 撰寫 outreach.recompute_schedule() 函式：由 contract.tenants 經 tenant_contract_parties 連到 status=active 的 tenant_contracts，再經 unit 連到 property.properties 以兩個欄位過濾——案件歸屬 ownership_region ∈ include set（預設 ["總公司"]）且 總公司內分類 hq_internal_category ∉ exclude set（預設 ["靠行"]，只排除靠行、其餘保留），兩集合皆做成可調設定，計算 onboarding_d15 與 expiry_d60/d30/d15 的 scheduled_date，排除有 renewal 子約 / status=cancelled / termination_reason 有值者，寫入時 ON CONFLICT DO NOTHING 且不覆蓋 status 非 pending 或 manually_edited=true 的列。完成標準：對一筆 end_date 2026-12-31 的 active + ownership_region=總公司 + hq_internal_category≠靠行 測試合約執行後出現 expiry_d60 2026-11-01 等四列；對已有 renewal 子約者不出現；重跑不產生重複列。
- [x] 1.3 建立 outreach.dispatch_due() 函式（挑 scheduled_date 不晚於今日且 status=confirmed 的列，用 pg_net POST 到 Zeabur run 端點並帶共享密鑰），並以 pg_cron 設定每日執行 recompute 與 dispatch。完成標準：手動執行 dispatch_due 對一筆 confirmed 列時，Zeabur 端 log 收到含該 schedule_id 的請求。
- [x] 1.4 建立 outreach.rule 設定表（key、trigger_basis 限 contract_start / contract_end、offset_days int、enabled bool、card_template jsonb（含 {{變數}} 佔位）、sort_order）並 seed 預設 4 條（onboarding contract_start +15；expiry contract_end −60 / −30 / −15）；recompute 改為讀此表 enabled 規則的 trigger_basis 與 offset_days 計算 scheduled_date 與 rule_type。完成標準：把某規則 offset_days 改 12 後 recompute 以 12 天計；enabled=false 的規則不產生任何列。

## 2. Zeabur 發送端

- [x] 2.1 在 server/routers/property/outreachHandlers.ts 建立讀寫 Supabase 的連線（以環境變數 SUPABASE_URL + service_role 或 DATABASE_URL，僅後端使用）。完成標準：一個內部查詢函式能取回 outreach.schedule 指定列。
- [x] 2.2 實作 outreach run 端點（POST /api/outreach/run，於 server 掛載）：先驗證環境變數 OUTREACH_RUN_SECRET；對每筆排程先查本地 booking_records（tenantUid 等於 line_uid 且有 confirmed 的續約或退租）命中則回寫 status=suppressed 不發，否則建立對應 rule_type 的 LINE Flex、pushLineDirect、回寫 status=sent 與 sent_at；發送失敗保留狀態以利重試。完成標準：缺密鑰回 401 且不發；已預約者回 suppressed 不發；正常者收到卡且該列 status=sent。
- [x] 2.3 為四條預設規則撰寫預設 card_template（LINE Flex JSON，含 {{變數}}），seed 進 outreach.rule，沿用既有 Flex 風格。完成標準：四條規則的 card_template 皆為合法 Flex JSON 且含至少一個變數佔位（手動檢視通過）。
- [x] 2.4 在 sender 實作 card_template 變數替換：支援 {{tenant_name}} / {{room}} / {{contract_end_date}} / {{days_until_expiry}}，以該筆 entry 的實際值取代後再 pushLineDirect。完成標準：含 {{tenant_name}} 的範本送出後卡片顯示實際姓名（例：王小明）。

## 3. Zeabur 後台看板

- [x] 3.1 新增 tRPC adminProcedure：outreach.listSchedule（列未來排程）、outreach.updateScheduleItem（改 scheduled_date / 跳過 / 確認）、outreach.sendNow（提早送，走與 run 相同的發送 gate）。完成標準：帶 admin 密鑰可列出與更新、非 admin 被拒；sendNow 對一筆會實際觸發發送 gate。
- [x] 3.2 在 client/src/pages/BookingAdmin.tsx 新增「週期詢問」分頁並建立 client/src/pages/BookingAdmin/OutreachBoard.tsx，顯示每筆排程的日期 / 室友 / 卡別 / 狀態，提供改日期、跳過、立即送、確認操作。完成標準：看板載入顯示排程清單；操作後對應 Supabase 列狀態更新並反映於畫面。
- [x] 3.3 建立規則編輯器（tRPC adminProcedure 讀寫 outreach.rule + OutreachBoard 內的編輯介面）：列出規則、編輯 offset_days、貼上/編輯 card_template JSON、啟用/停用，並顯示可用變數清單。完成標準：改天數 / 貼 JSON / 停用 後 outreach.rule 對應更新，並反映於後續排程與發送。

## 4. 設定與端到端驗收

- [x] 4.1 設定環境變數與密鑰（Zeabur：SUPABASE_URL、service_role 或 DATABASE_URL、OUTREACH_RUN_SECRET；Supabase：Zeabur run 端點 URL 與相同密鑰）。完成標準：dispatch_due 經 pg_net 打到 Zeabur 全鏈路一次成功，測試室友收到卡且 status=sent。
- [x] 4.2 對照 spec 的 Scenarios 逐項端到端驗收：排程出現、renewal 子約排除、確認後發送、booking_records suppression、看板編輯生效。完成標準：五項各跑過一次並記錄結果。

## 5. 規格需求對應 (Coverage)

- [x] 5.1 Time-Based Outreach Rules：由 1.2 計算、2.3 建卡、4.2 驗收。完成標準：四種 rule 的 scheduled_date 計算與對應卡片皆通過 4.2 驗收。
- [x] 5.2 Tenant Filtering：由 1.2 的兩欄位過濾（案件歸屬 ownership_region ∈ include set、總公司內分類 hq_internal_category ∉ exclude set）與 status=active 實作、4.2 驗收。完成標準：靠行、案件歸屬非總公司、與 cancelled 皆不入排程；而總公司案件下非靠行的其他內分類（null/總部/小虎個人簽/AIRBNB）仍入排程，通過 4.2。
- [x] 5.3 Exclude Already-Processed Tenants：由 1.2（renewal 子約 / cancelled / termination_reason）與 2.2（booking_records 即時 suppress）兩層實作、4.2 驗收。完成標準：兩層各驗一次通過。
- [x] 5.4 Idempotent Schedule：由 1.2 的 unique 與 ON CONFLICT DO NOTHING、不覆蓋手動編輯實作。完成標準：重跑不重複、手動編輯不被覆蓋。
- [x] 5.5 Sending And Status Writeback：由 2.2 與 2.3 實作、4.1 串接。完成標準：正常 sent、失敗保留、缺密鑰拒絕。
- [x] 5.6 Admin Schedule Board With Manual Confirmation：由 3.1 與 3.2 實作。完成標準：看板可看/改/跳過/立即送/確認，且 pending 不自動發。
- [x] 5.7 Scheduled Trigger On Supabase：由 1.3 的 pg_cron + pg_net 實作。完成標準：每日 recompute 與 dispatch 經 pg_net 觸發 Zeabur。
- [x] 5.8 Configurable Rules And Card Templates：由 1.4（outreach.rule 設定表 + recompute 讀取）、2.3（預設 card_template）、2.4（變數替換）、3.3（規則編輯器）實作。完成標準：天數可改、card_template JSON 可貼、變數會替換、停用規則不排程。
