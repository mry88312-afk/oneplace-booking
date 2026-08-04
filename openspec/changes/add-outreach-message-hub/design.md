## Context

- 週期詢問已上線（add-periodic-outreach、enhance-outreach-management 共 21+21 任務完成）：大腦在 Supabase（outreach.schedule / rule / settings、recompute_schedule()、dispatch_due()、pg_cron + pg_net），嘴巴在 Zeabur（runOutreach、tRPC 看板 API、/api/outreach/run 密鑰端點、測試模式 test_redirect_uid、失敗追蹤三欄、互動回饋 /f/:id）。
- 現行限制：scheduled_date 只有日期；dispatch 每日一次（UTC 01:00 ≈ 台北 09:00）；排程一律來自合約規則（cross join outreach.rule）；rule.trigger_basis 受 CHECK 限制只允許 contract_start / contract_end；發送對象一律 tenant_uid。
- 退租預約資料在本系統 TiDB：booking_records（tenantUid、tenantName、roomNumber、address、bookingTime 毫秒時間戳、status confirmed/cancelled/completed/no_show、templateId）join booking_templates.contractAction='退租'。預約經 LIFF 建立，**UID 直接有**，不需電話轉換。
- 鏡像庫 contract.tenants：primary_phone（使用者確認電話唯一）、line_uid、primary_name——電話換 UID 與未綁清單都查這張。
- 預約頁 BookingPublic.tsx：RegisterView 與 registerTenantByPhone 後端已存在且可用（姓名/電話/地址 location/房號 room），但 PHONE_NOT_FOUND 目前只 toast「查無資料，請與我們聯繫」，沒有引導進註冊畫面。
- 已拍板：派送精準到小時；退租提醒走「每日傍晚掃描」+ 發送前再驗（解取消/改期）；投遞 API 由對方給整張卡 JSON；booking 與 api 兩種來源**自動確認**；電話唯一不需多筆選擇；不做綁定專用連結。

## Goals / Non-Goals

**Goals:**

- 排程支援「日期＋幾點」並每小時派送；既有規則排程行為不變（回填台北 09:00）。
- 退租預約前一天 18:00（台北）自動發提醒卡；取消/改期不誤發；卡片文案後台可編輯。
- 提供密鑰保護的投遞 API：外部系統給整卡 JSON＋發送時間＋標籤＋去重碼，統一進排程、統一控管、統一測試模式。
- 看板能依來源（rule/booking/api）與標籤篩選。
- 後台可見「未綁 UID 主客清單」（有效合約、無 line_uid）並可匯出。
- 電話查無時可自行註冊（姓名/電話/入住地址/房號）後繼續預約。

**Non-Goals:**

- 不改既有四條合約規則的計算邏輯與人工確認制（僅 booking/api 來源自動確認）。
- 不做綁定專用連結、不做電話多筆選擇（電話唯一）。
- 不做投遞 API 的模板模式（v1 只收整卡 JSON；模板＋變數留待需要再加）。
- 不做分鐘級精準（小時級即可；send_at 存完整時間戳，未來要分鐘級只需加密集 cron）。
- 不動 MANUS、不動 LINE webhook。

## Decisions

### 排程精準到小時：schedule 加 send_at、派送改每小時掃

outreach.schedule 新增 send_at timestamptz；dispatch_due() 改挑 status='confirmed' 且 send_at <= now()；pg_cron 派送 job 由每日一次改為每小時整點。既有列與 recompute 新插列回填/寫入 send_at = scheduled_date 台北 09:00（= UTC 01:00），維持現行體感。scheduled_date 保留（看板日期篩選沿用），send_at 為實際派送依據。理由：最小變更達成「指定幾點發」；替代：另建 delivery queue 表 → 兩表同步複雜 → 否決。

### 退租提醒：每日傍晚掃 TiDB、發送前再驗（解取消改期）

新增 pg_cron 每日 UTC 09:00（台北 17:00）以 pg_net 呼叫 Zeabur 掃描端點（POST /api/outreach/scan-checkout，驗 OUTREACH_RUN_SECRET）。Zeabur 查 TiDB：booking_records join booking_templates 取 contractAction='退租'、status='confirmed'、bookingTime 落在「台北明天 00:00–24:00」者，逐筆寫入 outreach.schedule：source='booking'、rule_key='checkout_d1'、tenant_uid＝預約的 tenantUid、send_at＝台北今天 18:00、status='confirmed'（自動確認）、vars jsonb 帶 booking_date/booking_time/tenant_name/room、dedupe_key＝'checkout_d1:'+預約id+':'+預約日期（唯一索引擋重複；改期後日期變→新 dedupe_key→會重排，舊排程由發送前再驗跳過）。發送前再驗：runOutreach 對 source='booking' 列，依 vars 內預約 id 回查 TiDB——預約仍存在、仍 confirmed、bookingTime 仍是「send_at 的隔天（台北）」才發；否則 status='skipped' 並記原因（已取消/已改期）。卡片：在 outreach.rule 插入 key='checkout_d1' 列（label 退租前一日提醒、trigger_basis='booking_checkout'、預設卡片），CHECK 約束擴充允許 'booking_checkout'；recompute_schedule() 加條件僅處理 trigger_basis in ('contract_start','contract_end')，避免合約引擎誤用此規則。理由：掃描＋發送前再驗是現有「雙層 gate」同型樣式，已驗證可靠；替代：預約當下事件式排入 → 取消/改期要同步維護排程、漏接風險高 → 否決（使用者亦選乙案）。

### 投遞 API：POST /api/outreach/enqueue 收整卡 JSON＋去重碼

server/index.ts 新增 POST /api/outreach/enqueue，驗 x-outreach-secret（同 OUTREACH_RUN_SECRET，timingSafeEqual）。Body：{ dedupeKey 必填, card 必填（LINE message 或 bare bubble，沿用 toFlexMessage 包裝）, altText 選填, to: { uid 或 phone 擇一必填 }, sendAt 必填（ISO 時間，已過去則下個整點送）, tag 必填 }。寫入 outreach.schedule：source='api'、tag、card_override=card、alt_text、tenant_uid=uid 或 recipient_phone=phone、send_at、status='confirmed'（自動確認）、dedupe_key；on conflict (dedupe_key) do nothing。回應：200 { ok:true, id, deduped:boolean }；401 密鑰錯；400 缺欄位（訊息指明缺哪欄）。runOutreach 取卡改為 coalesce(card_override, rule.card_template)（rule 改 LEFT JOIN），altText 取 alt_text 或 RULE_ALT_TEXT。理由：對方給整卡最彈性（使用者拍板）；去重碼讓對方可安全重試。

### 發送時電話換 UID（primary_phone 唯一）

runOutreach 發送前：列無 tenant_uid 而有 recipient_phone 者，查鏡像 contract.tenants where primary_phone = 正規化電話（去空白/-/()）取 line_uid；命中→回寫該列 tenant_uid 後照常發；查無人或無 line_uid→markSendFailure 記「查無 LINE UID（電話）」、status 不變可重試（綁定後可重送），不誤發。理由：與失敗追蹤/重試機制天然銜接；替代：enqueue 當下就換 → 當下沒綁之後綁了會永遠失敗 → 否決（發送時換給「之後補綁」留活路）。

### 看板來源標籤分類與未綁 UID 清單

listSchedule/scheduleSummary 與 SCHEDULE_COLS 回傳 source、tag、send_at；listSchedule 新增 source/tag 過濾參數。看板：來源篩選鈕（全部/規則/退租提醒/外部API）、標籤下拉（distinct tag）、列上顯示來源 badge＋標籤＋send_at 時刻（HH:mm）。新增 tRPC listUnboundTenants：查鏡像「有效合約（status='active'，經 tenant_contract_parties 連 tenants）且 line_uid 為空」的主客，回姓名/電話/案場/房號；OutreachBoard 新增「未綁UID」分頁：清單＋筆數＋CSV 匯出（沿用既有 exportCsv 樣式）。理由：未綁清單與「電話換 UID 失敗可重試」閉環——補綁後重送即可。

### 電話查無開放自行註冊（接通既有 RegisterView）

BookingPublic.tsx 的 verifyByPhone onError：PHONE_NOT_FOUND 由「只 toast」改為 toast 提示＋setView('register') 進入既有註冊畫面（欄位即 姓名 nameInput/電話 phoneInput/入住地址 locationInput/房間編號 roomInput），沿用既有 registerTenantByPhone 後端與後續流程（成功後繼續預約、有 UID 一併寫回）。純前端接線，不動後端。理由：後端與畫面都已存在，只缺入口。

## Implementation Contract

**行為（操作者/室友/外部系統觀察）：**

- 排程每筆顯示「日期＋幾點」；到該小時的整點掃描時送出，不再固定早上。
- 明天有退租預約（已確認）的室友，今天 18:00（台北）收到提醒卡；今天 17:00 掃描後才取消或改期者，18:00 不會收到（發送前再驗擋下，列標 skipped＋原因）；改期者於新日期前一天 18:00 收到。
- 外部系統帶密鑰 POST enqueue → 排程出現於看板（來源=外部API、含標籤、可跳過/取消）→ 時間到自動發；同 dedupeKey 重打回 deduped:true 且不重複排。
- 測試模式開啟時，三種來源的發送一律重導測試 LINE。
- 看板可依來源與標籤篩選；「未綁UID」分頁列出有效合約但沒綁 LINE 的主客、可下載 CSV。
- 預約頁電話查無 → 進入註冊畫面填 姓名/電話/入住地址/房號 → 完成後直接繼續原預約流程。

**資料形狀：**

- outreach.schedule 新增：send_at timestamptz、source text default 'rule'（rule/booking/api）、tag text、card_override jsonb、alt_text text、recipient_phone text、vars jsonb、dedupe_key text（partial unique index where dedupe_key is not null）。既有列回填 send_at＝scheduled_date+01:00 UTC、source='rule'。
- outreach.rule：trigger_basis CHECK 擴充 'booking_checkout'；新列 key='checkout_d1'。
- recompute_schedule()：僅處理 trigger_basis in ('contract_start','contract_end')，插列同時寫 send_at（scheduled_date+01:00 UTC）。
- dispatch_due()：挑 status='confirmed' and send_at <= now()，POST schedule_ids 至 run 端點（形狀不變）。
- pg_cron：dispatch 改 0 * * * *；新增 scan-checkout 0 9 * * *（UTC）。
- HTTP：POST /api/outreach/scan-checkout（密鑰）→ { ok, scanned, inserted }；POST /api/outreach/enqueue（密鑰）→ 200 { ok, id, deduped } / 400 / 401。
- tRPC 新增 listUnboundTenants() → [{ tenant_name, phone, property_name, room }]；listSchedule 入參加 source?/tag?。
- runOutreach：LEFT JOIN rule、卡片 coalesce(card_override, rule.card_template)、vars 併入變數、電話換 UID、booking 來源發送前再驗。

**失敗模式：**

- enqueue 缺欄/卡片非物件 → 400 指明欄位；密鑰錯 → 401；同 dedupeKey → 200 deduped:true 不重排。
- 電話換不到 UID → 該列記 last_error「查無 LINE UID」、attempt_count+1、status 不變（失敗清單可見、補綁後可重送）。
- 退租預約已取消/改期 → 該列 skipped＋suppressed_reason 記原因，不發送。
- 掃描端點 TiDB 不可用 → 回 500、本日掃描由明日補（提醒屬前一日性質，漏掃即過期，記 log）。
- sendAt 在過去 → 下個整點派送（不回溯多發）。

**驗收：**

- ① 造一筆「台北明天」的退租 confirmed 預約 → 呼叫 scan-checkout → schedule 出現 source='booking'、send_at=今天 18:00 台北、status=confirmed 一筆；再呼叫一次不重複（dedupe）。
- ② 將該預約改為 cancelled → 手動對該列 sendNow → 結果 skipped、列標已取消原因、室友未收到。
- ③ enqueue 帶 uid＋sendAt=過去＋tag='測試' → 看板出現外部API列 → 手動立即送 → 測試 LINE 收到該卡；同 dedupeKey 重打 → deduped:true 且僅一列。
- ④ enqueue 只帶 phone（測試模式下）→ 發送時電話換到 UID 並送達測試 LINE；帶查無電話 → 該列 last_error 含「查無 LINE UID」且可重試。
- ⑤ 看板以來源=外部API 篩選只見 api 列；標籤下拉可選 '測試'。
- ⑥ 「未綁UID」分頁有清單且 CSV 可下載、Excel 中文正常。
- ⑦ 預約頁輸入查無電話 → 出現註冊畫面 → 填姓名/電話/入住地址/房號送出 → 回到預約流程可選時段。
- ⑧ recompute 後規則列 send_at 均為台北 09:00；checkout_d1 不被 recompute 產生排程。

**範圍邊界：**

- in scope：上述六個決策的 Supabase schema/函式/cron 調整、Zeabur 兩個新端點與 runOutreach 升級、看板來源標籤與未綁UID分頁、BookingPublic 註冊接線。
- out of scope：四條合約規則邏輯、人工確認制（rule 來源維持）、互動回饋 /f/:id、MANUS/LINE webhook、enqueue 模板模式、分鐘級派送。

## Risks / Trade-offs

- [每小時派送讓「手動確認的 rule 排程」當天 09:00 後才確認者會在下個整點送出（原為隔日早上）] → 屬合理改善；看板 send_at 顯示明確。
- [掃描在 17:00、發送在 18:00，其間取消/改期] → 發送前再驗完全攔下（驗收②）。
- [dedupe_key 帶預約日期，同一預約多次改期會多列] → 舊列均被發送前再驗跳過，僅新日期那列實際送出；看板可見歷程，可接受。
- [外部系統可排「過去時間」] → 下個整點送出一次，不回溯重複。
- [enqueue 卡片 JSON 不合法導致 LINE 400] → 失敗追蹤已有（last_error/重試）；建議外部先用測試模式驗證。
- [時區換算（台北=UTC+8、無夏令）] → 全部以「UTC 時間戳存、台北時間算邊界」處理並於驗收①⑧驗證。

## Migration Plan

- Supabase（向後相容、可重跑）：加欄位與部分唯一索引 → 回填 send_at/source → 擴充 rule CHECK → 插 checkout_d1 → CREATE OR REPLACE recompute/dispatch → 調整 pg_cron（派送每小時、新增掃描）。
- Zeabur：擴充 outreachHandlers.ts 與 server/index.ts（scan-checkout/enqueue）、OutreachBoard.tsx、BookingPublic.tsx；push 自動部署。
- Rollback：pg_cron 改回每日、dispatch_due 改回 scheduled_date 條件即回舊行為；新欄位保留無害；enqueue/scan 端點無人呼叫即閒置。

## Open Questions

（無——派送精度、掃描方案、API 形狀、自動確認、電話唯一、註冊欄位均已由使用者拍板。）

## 追加決策（提案後補充拍板）

- 未綁 UID 清單含合約到期日與「60 天內到期」篩選：listUnboundTenants 回傳 contract_end_date（該主客 active 合約最新 end_date）並支援 expiringWithinDays 參數；分頁加快速篩選、CSV 同步含到期日。理由：沒 UID 者不會進排程（recompute 過濾 line_uid 非空），到期詢問對這群人是「該發但發不到」——給同事一張可下載的人工聯繫名單。（spec: Expiring Unbound Tenant Visibility）
- 看板提供「投遞 API 串接範例」可複製卡：含端點 URL、x-outreach-secret header、body 欄位說明（dedupeKey / card / to / sendAt / tag）與一段完整 curl 範例，放「篩選 / 設定」分頁；Ragic／MANUS 串接者直接複製即可打通。（spec: Enqueue Integration Example）
- 【延後，待使用者補資料】「發送成功回寫 Ragic 到期詢問表」（使用者選項 B）：需目標 Ragic 表路徑與欄位 ID，提供後另行小幅追加（於 runOutreach 成功分支對 expiry 規則回寫）；本變更先以看板歷史紀錄＋未綁清單覆蓋可見性。
