## Context

- oneplace-booking（Zeabur；React 19 + tRPC + Express + TiDB）已具備發 LINE Flex 卡片（pushLineDirect）、寫 Ragic（ragicPut/ragicExecuteButton）、查本地 booking_records 的能力，並有 BookingAdmin 後台。
- 室友/合約資料即時鏡像在 Supabase 專案 dwoahbduwzfzqmwpvadj（一方生活, Tokyo, ap-northeast-1）。已查證可用欄位：
  - contract.tenant_contracts：start_date(date)、end_date(date)、status(active 1396 / cancelled 1810)、contract_no、renewal_parent_id(uuid)、termination_reason(text)
  - contract.tenants：line_uid
  - contract.tenant_contract_parties：tenant_contract_id（連結租客與合約）
  - property.properties：ownership_region＝案件歸屬（總公司 205 / 加盟 164 / 高雄 15 / 台中 15 / 代管 12 / 非案場 2）、hq_internal_category＝總公司內分類（總公司 219 / null 178 / 靠行 7 / 小虎個人簽 4 / 總部 3 / AIRBNB 2）、franchisee_id（全部為 null，不可用）
- 合約日期已正規化為 PG date（民國年問題已由現有同步處理）。contract.contract_lifecycle_tasks 目前為空，不採用。

## Goals / Non-Goals

**Goals:**

- 依時間規則自動發 LINE Flex：入住（合約開始日）+15 天問候；合約到期日 −60 / −30 / −15 天續約提醒。
- 只發給符合篩選（案件歸屬 ownership_region ∈ {總公司}、總公司內分類 hq_internal_category ∉ {靠行}、合約 status = active）且尚未處理（未續約、未退租）的室友。
- Zeabur 後台提供視覺化排程看板：看未來排程、編輯日期、跳過、提早送、手動確認後才實際發送。

**Non-Goals:**

- 互動按鈕（住得舒服 / 我想討論）與把回應回寫到合約（情緒追蹤）— 留 v2/v3。
- 每月 pulse 居住關懷 — 留 v3。
- 完全自動發送（不經人工確認）— v1 先手動確認，v2 再開自動。
- 在 Zeabur 跑排程 cron — 排程在 Supabase。
- 把 Ragic 欄位 1015394（詢問退租）加進鏡像 — 改用合約 status / renewal_parent_id + 本地 booking_records 取代。

## Decisions

1. 大腦在 Supabase、嘴巴在 Zeabur（B 案）。理由：鏡像最適合 bulk 掃描算排程，且不打 Ragic 熱路徑；LINE token、Flex 卡片、Ragic 寫入都已在 Zeabur。替代：全放 Supabase（須搬 LINE/卡片邏輯，重工）→ 否決。
2. 「已處理」採雙層 gate。Supabase 排程時排除：已有續約子約（另一筆 tenant_contracts.renewal_parent_id = 本約 id）、status = cancelled、或 termination_reason 有值；Zeabur 發送前再查本地 booking_records。理由：鏡像有延遲，且室友可能透過非 Zeabur 管道（專員、舊系統、Ragic 手動）續約/退租，任一單一來源都不夠。替代：只查 booking_records（漏掉非 Zeabur）或只信鏡像（剛預約者因延遲被誤發）→ 皆不行。
3. 篩選＝兩個獨立的 property 欄位過濾（對應使用者 Ragic 的兩個篩選欄位，以 AND 結合），不用 franchisee_id（全為 null）：
   - 案件歸屬（ownership_region）：須在 include set 內，預設 ["總公司"]（排除 加盟 / 台中 / 高雄 / 代管 / 非案場）。
   - 總公司內分類（hq_internal_category）：須不在 exclude set 內，預設 ["靠行"]——**只排除靠行**，其餘（總公司 / null / 總部 / 小虎個人簽 / AIRBNB）全部保留。
   兩個集合都做成可後台調整的設定。實測：ownership_region=總公司 共 205 筆，其中 hq_internal_category=靠行 有 7 筆，過濾後 198 筆。（修正：先前誤把「只留總公司」套到 hq_internal_category，會變成 219 筆且漏掉 null/總部/小虎個人簽/AIRBNB——已改為上述兩欄位模型。）
4. 排程觸發用 Supabase pg_cron + pg_net 呼叫 Zeabur 執行端點（最少元件），不採排程 Edge Function。
5. outreach.schedule 冪等：unique(tenant_uid, rule_type, contract_no)；每日重算用 ON CONFLICT DO NOTHING；status 非 pending 或 manually_edited = true 的列不被重算覆蓋。
6. 介面深度（seam）：seam = Supabase outreach.schedule 表（大腦與嘴巴的契約）＋ Zeabur 執行端點。Zeabur 側單一 outreach 模組（讀排程 → gate → 建卡 → 發送 → 回寫狀態），不疊薄包裝。刪除此模組則週期詢問停擺，故模組成立、非純轉發。
7. 規則與卡片做成可後台編輯的設定（Supabase outreach.rule 表），不寫死。每條規則 = key + trigger_basis(contract_start/contract_end) + offset_days(int，可改如 12 天) + enabled + card_template(jsonb，LINE Flex JSON 含 {{變數}})。recompute 讀規則算 scheduled_date；sender 在發送前以該筆 entry 實際值替換變數（{{tenant_name}}、{{room}}、{{contract_end_date}}、{{days_until_expiry}}）。理由：使用者要能自行改天數、貼 JSON、加變數而不動程式。替代：純貼 JSON 無變數（無法個人化）→ 否決；寫死規則（每次改都要 deploy）→ 否決。

## Implementation Contract

- 行為（操作者/室友觀察）：每日由鏡像產生未來排程並顯示於後台看板（日期 / 室友 / 卡別 / 狀態）；管理者可改日期、跳過、立即送、按「確認」；確認後於排程日（或立即送）室友收到對應的 LINE Flex；已續約或已退租者不會收到。
- 資料形狀（Supabase）：
  - 表 outreach.schedule(id uuid pk, tenant_uid text, tenant_name text, contract_no text, rule_type text 限 onboarding_d15 / expiry_d60 / expiry_d30 / expiry_d15, scheduled_date date, status text 限 pending / confirmed / sent / skipped / cancelled / suppressed, manually_edited boolean default false, suppressed_reason text, sent_at timestamptz, created_at timestamptz, updated_at timestamptz, unique(tenant_uid, rule_type, contract_no))
  - 函式 outreach.recompute_schedule()（pg_cron 每日）：以 tenants.line_uid 經 tenant_contract_parties 連到 status = active 的 tenant_contracts，再經 unit 連到 property.properties 過濾（ownership_region ∈ include set 且 hq_internal_category ∉ exclude set）；計算各 rule 的 scheduled_date，排除已處理者，對 outreach.schedule 做 ON CONFLICT DO NOTHING。
  - 函式 outreach.dispatch_due()（pg_cron 每日）：挑 scheduled_date <= today 且 status = confirmed 的列，用 pg_net 呼叫 Zeabur 執行端點。
- 介面（Zeabur）：
  - HTTP POST 到 outreach 執行端點，需帶共享密鑰 header（環境變數 OUTREACH_RUN_SECRET）。對每筆排程：先查本地 booking_records（tenantUid = line_uid 且有 confirmed 的續約或退租預約）；命中則回寫 status = suppressed（非錯誤）、不發；否則依 rule_type 建對應 Flex、pushLineDirect、回寫 status = sent 與 sent_at。
  - tRPC adminProcedure（後台看板）：列出未來排程、更新單一排程（改日期 / 跳過 / 確認）、立即送。後端以 service_role 或 DATABASE_URL 讀寫 Supabase outreach.schedule；瀏覽器僅打 Zeabur tRPC，金鑰不外洩。
  - 每個 rule_type 對應一個建卡函式（預設文案，沿用現有 Flex 風格）。
- 失敗模式：發送失敗寫 log、status 維持 confirmed 可下次重試；Supabase 觸發失敗由下次 pg_cron 補送；命中 booking_records 視為 suppressed 而非錯誤。
- 驗收：①對一個 active + 案件歸屬=總公司 + 總公司內分類≠靠行 + 到期前 60 天的測試合約，recompute 後 outreach.schedule 出現 expiry_d60 / pending；②已有續約子約的合約不出現；③管理者確認後呼叫執行端點，該室友收到續約提醒卡且 status = sent；④對在 booking_records 已預約者，執行端點回報 suppressed 且不發送；⑤看板顯示與編輯（改日期/跳過/立即送）生效。
- 範圍邊界：in scope＝outreach.schedule 表 + recompute/dispatch 函式 + Zeabur 執行端點與雙層 gate + 後台看板 + 手動確認發送。out of scope＝自動發、互動按鈕、回寫感受、每月 pulse、Ragic 1015394 同步。

## Risks / Trade-offs

- 鏡像延遲：非 Zeabur 管道剛簽的續約/退租，可能在鏡像同步前被誤發；Zeabur 端用 booking_records 補抓 Zeabur 管道；非 Zeabur 端的短暫空窗（專員剛在 Ragic 簽）仍可能誤發一次（−60/−30/−15 非分秒關鍵，可接受），並以 reconcile 降低。
- 篩選為可調集合：ownership_region include set 預設 {總公司}、hq_internal_category exclude set 預設 {靠行}。日後若要納入 台中 / 高雄 等案件歸屬，或多排除某些內分類，改設定即可、不動程式。
- 跨系統部署：Supabase 與 Zeabur 兩邊都要動；密鑰（OUTREACH_RUN_SECRET、service_role）需妥善保管，service_role 僅存在 Zeabur 後端。
- 「現行合約」判定：一人若有多筆 active 合約，取 end_date 最新者；此規則需在實作前對少數異常資料再確認。
