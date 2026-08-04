## Context

- 週期詢問（periodic-outreach，change add-periodic-outreach）已上線：大腦在 Supabase（專案 dwoahbduwzfzqmwpvadj），嘴巴在 Zeabur。
- Supabase 既有：outreach.schedule、outreach.rule、outreach.settings、函式 recompute_schedule() 與 dispatch_due()、pg_cron 每日重算與派送、pg_net 呼叫 Zeabur 執行端點。
  - outreach.schedule 既有欄位：id, tenant_uid, tenant_name, room, property_name, contract_id, contract_no, contract_end_date, rule_key, scheduled_date, status（pending/confirmed/sent/skipped/cancelled/suppressed）, manually_edited, suppressed_reason, sent_at, created_at, updated_at；unique(tenant_uid, rule_key, contract_no)。
  - outreach.rule 既有欄位：key, trigger_basis（contract_start/contract_end）, offset_days, enabled, card_template(jsonb), ...。
  - outreach.settings 既有：include_ownership_regions、exclude_hq_categories、run_endpoint_url、run_secret、test_redirect_uid（測試模式）。
- Zeabur 既有（server/routers/property/outreachHandlers.ts）：renderTemplate / computeVars / toFlexMessage / pushTestCard / hasActiveBookingSuppress / runOutreach（回傳 RunResult = {sent, suppressed, failed, skipped, errors:[{id,error}]}，已支援 test_redirect_uid 重導與發送前 booking_records suppress）。tRPC：health、sendTestCard、listSchedule（已支援 ruleKey/search/statuses 過濾與歷史排序）、scheduleSummary、updateScheduleItem、sendNow、recomputeNow、listRules、updateRule、getSettings、updateSettings。執行端點 POST /api/outreach/run（共享密鑰）在 server/index.ts。
- 前端看板 client/src/pages/BookingAdmin/OutreachBoard.tsx 已有四個分頁（排程看板 / 規則卡片 / 篩選設定 / 測試發送），ScheduleTab 已有規則過濾、日期 preset、未來/歷史模式、summary bar。
- 約束：發送只走 Zeabur 執行端點（密鑰保護）；室友身分一律以電話為準（既有同步已處理）；測試模式 test_redirect_uid 設定後所有發送重導到管理者本人、不送真人。

## Goals / Non-Goals

**Goals:**

- 把排程看板升級為營運工具：批次確認/跳過/立即送、每筆預覽（送測試 LINE）、「今天要發」+ 依案場分組、失敗清單 + 一鍵重送、排程/歷史 CSV 匯出、每規則自動確認、發送成效統計。
- 入住卡互動回饋（住得習慣 / 想反應）改 postback，Zeabur 接 LINE inbound webhook，把回饋回寫 Ragic（情緒追蹤）。

**Non-Goals:**

- 不改既有室友篩選邏輯、四條規則（onboarding_d15 / expiry_d60 / expiry_d30 / expiry_d15）的時間計算、發送前雙層 gate、與「確認後才派送」核心行為。
- 不改 Supabase 排程觸發架構（維持 pg_cron + pg_net）。
- 不做完全免人工的全域自動發送：auto_confirm 為逐規則 opt-in，且仍受測試模式與 gate 保護。
- 不新增 send_log 之類的逐次嘗試表；成效統計由既有 status / sent_at 與新增失敗欄位彙總。
- 不做多通道（Email / SMS）。
- postback（項目 8）在 LINE inbound webhook 落點未確認前，不接線、不發佈（見 Open Questions）。

## Decisions

### 失敗追蹤用 schedule 三欄、不另建 send_log 表

outreach.schedule 新增三欄：last_error(text)、last_attempt_at(timestamptz)、attempt_count(int default 0)。Zeabur runOutreach 每筆發送嘗試後回寫：失敗時 last_error = 錯誤訊息、last_attempt_at = now、attempt_count 累加，status 維持原值（confirmed 可下次重試）；成功時 status = sent、sent_at = now、last_error 清空。理由：每天量級僅數十筆，最小變更即可支援「失敗清單 + 重送 + 成效統計」；重送沿用既有 sendNow 路徑。替代：另建 outreach.send_log（每次嘗試一列）→ 查詢與維護複雜、對此量級過度設計 → 否決。

### 批次操作以新增 batch tRPC procedures 實作

新增 updateScheduleItemsBatch({ ids, action }) 與 sendNowBatch({ ids })，內部分別重用既有 updateScheduleItem / sendNow 的單筆核心邏輯逐筆執行，回傳逐筆結果 results:[{ id, ok, error }]；個別失敗不中斷其餘。action 限定 confirm / skip 列舉，不開放任意 patch。前端 ScheduleTab 列表加勾選框與動作列。理由：重用既有邏輯、行為可預期、誤改面積小。替代：單一萬用 batch endpoint 帶任意欄位 patch → 風險高 → 否決。

### 每筆預覽一律送測試對象 test_redirect_uid、永不送真人

新增 previewScheduleItem({ id })：讀該筆排程 → computeVars → renderTemplate(rule.card_template) → toFlexMessage → pushTestCard 到 outreach.settings.test_redirect_uid；不改 status、不經派送流程、不查 gate。若 test_redirect_uid 未設定則回明確錯誤要求先設定測試對象。理由：沿用既有測試模式基礎設施，結構上不可能誤觸真人（這是先前誤發事故後定的安全準則）。替代：前端只渲染 JSON 預覽 → 看不到真實 LINE 呈現 → 不足。

### 今天要發與依案場分組以前端 + 既有查詢實作

「今天要發」= scheduled_date 等於今日的日期 preset（沿用 ScheduleTab 既有 computeRange 機制）。「依案場分組」= 前端就地把已載入列依 property_name 分組並計數顯示，不新增後端 endpoint（資料已隨 listSchedule 載入）。理由：所需資料皆已在列表，前端彙總最省。替代：新增 per-property 計數 endpoint → 多餘。

### CSV 匯出於前端產生（UTF-8 BOM）

於前端用目前載入的列（排程模式或歷史模式各自）產生並下載 CSV，檔頭加 UTF-8 BOM 以利 Excel 正確顯示中文。欄位：scheduled_date、tenant_name、room、property_name、rule_key、status、sent_at、attempt_count、last_error。理由：資料已在前端、無需後端；BOM 解決中文亂碼。替代：後端 CSV endpoint → 多餘。

### 每規則自動確認 auto_confirm 欄位、recompute 決定初始 status

outreach.rule 新增 auto_confirm(boolean default false)。recompute_schedule() 在「新插入」排程列時，若該 rule.auto_confirm = true 則初始 status = confirmed，否則 pending；僅影響新插入列，既有列（與 manually_edited、非 pending 列）一律不被覆蓋，維持冪等。安全互鎖：auto_confirm 仍受測試模式重導與發送前 booking_records suppress 保護；預設 false。前端規則卡片加開關與明確警語（開啟代表該規則新排程免人工確認、將自動派送）。理由：以逐規則 opt-in 兼顧省力與安全。替代：全域自動確認開關 → 太粗、風險高 → 否決。

### 發送成效統計由既有欄位彙總（getOutreachStats）

新增 getOutreachStats({ months })：以 sent_at（無則 last_attempt_at）落月分桶，依 status 計數（sent / suppressed / failed / pending / confirmed / skipped）；failed 定義 = status 非 sent 且 attempt_count > 0 且 last_error 有值；failed 比例 = failed /(sent + failed)，超過門檻（預設 20%）回 warn = true。前端成效分頁顯示每月長條與示警。理由：用既有欄位即可，不另建表。替代：新統計表 → 與「不建 send_log」決策一致地否決。

### 入住卡互動回饋：用開啟連結進本系統（不經 MANUS）＋ 問卷 ＋ 寫 Ragic ＋ LINE 通知

期望行為：卡片兩顆按鈕改為「開啟連結」(LINE uri action)，連結指向本系統（Zeabur）的回饋頁、帶該筆 schedule id 當作不可猜 token。室友點按鈕 → 手機開啟本系統頁面（**uri action 不產生 LINE webhook 事件，完全不經 MANUS**）。
- 按鈕①「住得很舒服 😊」：開啟 → 依 schedule id 查出該房客資料 → 寫一筆 Ragic「回饋單」（回饋類型＝住得舒服）→ 顯示「謝謝你的回覆 😊」。
- 按鈕②「有點小狀況，請小幫手協助 🛠️」：開啟 → 顯示**後台可編輯的小問卷**（不滿意項目可複選 ＋ 留言選填）→ 送出 → 寫 Ragic（回饋類型＝需要協助 ＋ 項目 ＋ 留言）＋ 對後台設定的每個 LINE UID 推播通知 → 顯示「已通知小幫手，會盡快聯繫 🙏」。
寫 Ragic：以既有 ragicPut 寫入「回饋單」表，只寫合約編號並帶 **doLinkLoad=true**（讓 Ragic 連結載入自動帶出租客手機/姓名/房號），另寫卡片類型/發送日期/回覆時間/回饋類型/不滿意項目/留言；不寫 JGBID、回饋單號（Ragic 自動）。身分一律靠 schedule id → 合約編號／電話，不靠姓名。
落點：本系統新增公開回饋頁路由（server/index.ts 掛載，邏輯放 server/routers/property/outreachFeedbackHandlers.ts）＋ 卡片 card_template 兩鈕改 uri。後台設定（outreach.settings）新增 feedback_survey（問卷內容）與 notify_uids（逗號分隔）。
替代否決：① LINE postback＋webhook → 會落到 MANUS、需改 MANUS 或轉發 → 否決；② 靠連結載入但不帶 doLinkLoad → API 寫入不會自動帶出 → 改用 doLinkLoad=true。

## Implementation Contract

**行為（操作者/室友觀察）：**

- 排程看板列可勾選多筆，一次「確認 / 跳過 / 立即送」，逐筆顯示成功或失敗原因。
- 每筆「預覽」把該筆實際內容卡片送到管理者測試 LINE（test_redirect_uid），真人收不到，status 不變；未設測試對象時回明確錯誤。
- 「今天」快捷顯示今日要發清單；列表可依案場分組並顯示每案場筆數。
- 發送失敗的列在「失敗清單」可見（含 last_error / last_attempt_at / attempt_count），可一鍵重送。
- 排程與歷史可下載 CSV，Excel 開啟中文正常。
- 規則卡片可逐條開「自動確認」；開啟後該規則新排程自動為 confirmed（仍受測試模式與 gate）。
- 成效分頁顯示每月 sent / suppressed / failed 筆數與比例，failed 比例過高時示警。
- 卡片兩鈕改「開啟連結」：①住得很舒服 → 寫 Ragic（住得舒服）＋謝謝頁；②請小幫手協助 → 問卷 → 寫 Ragic（需要協助＋項目＋留言）＋對後台名單發 LINE 通知＋謝謝頁。全程不經 MANUS。

**資料形狀：**

- Supabase outreach.schedule 新增欄位：last_error text、last_attempt_at timestamptz、attempt_count int default 0。
- Supabase outreach.rule 新增欄位：auto_confirm boolean default false。
- recompute_schedule() 新插入列的 status 依該規則 auto_confirm 決定（true → confirmed，false → pending）；既有列不覆蓋。
- RunResult 形狀不變（{sent, suppressed, failed, skipped, errors}）；runOutreach 額外回寫上述三個失敗欄位。
- 新增 tRPC（adminProcedure）：updateScheduleItemsBatch({ ids:string[], action:'confirm'|'skip' }) → { results:[{id, ok, error}] }；sendNowBatch({ ids:string[] }) → { results:[{id, ok, error}] }；previewScheduleItem({ id:string }) → { ok:boolean, redirectedTo:string|null, error?:string }；getOutreachStats({ months:number }) → { buckets:[{ month, sent, suppressed, failed, ratio, warn }] }。listSchedule 增加 onlyFailed 過濾旗標（沿用既有過濾參數風格）。
- 前端 OutreachBoard.tsx：ScheduleTab 加勾選框 + 動作列 + 預覽鈕 + 今天 preset + 案場分組 + 失敗清單檢視 + CSV 鈕；新增成效分頁；規則卡片加 auto_confirm 開關與警語。
- 回饋連結：本系統新增公開頁路由（帶 schedule id token）→ 查該筆 → ragicPut 寫「回饋單」（合約編號＋doLinkLoad=true 帶出手機/姓名/房號，另寫卡片類型/發送日期/回覆時間/回饋類型/不滿意項目/留言）→ 不滿意時對 notify_uids 逐一 pushLineDirect 通知。卡片 card_template 兩鈕改 uri action。outreach.settings 新增 feedback_survey（問卷內容）與 notify_uids（逗號分隔）。

**失敗模式：**

- 批次中個別筆失敗不中斷其餘；逐筆回 { id, ok, error }。
- 預覽未設 test_redirect_uid → 回錯誤「請先在設定填入測試 LINE 對象」，不發送。
- run 寫失敗欄位時若 DB 短暫不可用 → 該筆視為失敗、下次 pg_cron 重試。
- auto_confirm 開啟但測試模式 ON → 仍重導測試對象、不送真人。
- 回饋連結帶不可猜的 schedule id；查無對應排程 → 顯示通用謝謝頁、不寫入。通知對象未加官方帳號好友 → 該則 LINE 發送失敗（記 log、不影響寫入）。

**驗收：**

- ① 勾選 3 筆 pending 按「確認」→ 三筆變 confirmed；若混入一筆已 sent → 該筆回 ok=false 並說明，不影響其餘。
- ② 任一筆按「預覽」→ 管理者測試 LINE 收到該筆內容卡片，真人收不到，該筆 status 不變。
- ③ 製造一筆發送失敗（例如壞 card_template）→ run 後該筆 last_error 有值、attempt_count = 1、status 未變；於失敗清單可見並一鍵重送。
- ④ 將某規則 auto_confirm 設 true → recompute 後該規則新排程為 confirmed；既有列不受影響。
- ⑤ 成效分頁顯示當月 sent / suppressed / failed 筆數與比例。
- ⑥ 下載排程 CSV → Excel 開啟中文正常。
- ⑦ 點按鈕①→ Ragic 回饋單出現一筆（住得舒服，手機/姓名/房號經 doLinkLoad 自動帶出）；點按鈕②填問卷送出 → Ragic 出現一筆（需要協助＋項目＋留言）且後台名單收到 LINE 通知。

**範圍邊界：**

- in scope：項目 1–7 全部（已上線）；項目 8 互動回饋＝卡片兩鈕改開啟連結、回饋頁、寫 Ragic（doLinkLoad）、不滿意問卷（後台可編輯）、LINE 多人通知（後台逗號 UID）。
- out of scope：改既有篩選/四規則時間計算/雙層 gate/手動確認核心；send_log 表；多通道發送；LINE postback／webhook 與任何 MANUS 改動（本方案用開啟連結繞過）。

## Risks / Trade-offs

- [auto_confirm 誤開導致該規則免確認直接派送] → 預設 false、UI 明確警語、仍受測試模式重導與發送前 gate；建議先在測試模式驗證再關閉測試模式。
- [postback：OA 同時只能設定一個 inbound webhook，落點未知可能搶走既有流量] → gated；先確認落點，必要時於既有服務轉發到 Zeabur，確認前不接線。
- [CSV 中文在 Excel 亂碼] → 輸出加 UTF-8 BOM。
- [批次立即送一次送太多觸發 LINE rate limit] → sendNowBatch 逐筆序列化並小幅節流；逐筆回報，失敗可於失敗清單重送。
- [失敗欄位與既有冪等/manually_edited 互動] → 失敗回寫只動三個新欄位與既有 status（維持 confirmed），不動 manually_edited，不破壞 recompute 冪等。

## Migration Plan

- Supabase（皆為加欄位/函式替換，向後相容、可重跑）：對 outreach.schedule 增加 last_error / last_attempt_at / attempt_count；對 outreach.rule 增加 auto_confirm（預設 false）；以 CREATE OR REPLACE 更新 recompute_schedule()，使新插入列 status 依 auto_confirm。
- Zeabur：擴充 outreachHandlers.ts（run 回寫失敗欄位 + batch/preview/stats procedures）與 OutreachBoard.tsx（UI）；提交後 push 觸發 Zeabur 自動部署。
- postback（gated）：待 webhook 落點確認後，於 server/index.ts 新增 webhook route、新增 outreachFeedbackHandlers.ts、把入住卡 card_template 兩鈕改 postback。
- Rollback：移除新 tRPC/UI 不影響既有發送；新增欄位可保留（向後相容）；將所有規則 auto_confirm 設回 false 即回到純手動確認。

## Open Questions

- 【已解決，改方案】原以 LINE postback＋webhook 實作會落到 MANUS 主系統（fieldopsdash…manus.space）。為了「不動 MANUS」，**改用「開啟連結」方案**：卡片按鈕改 uri action 直接開到本系統回饋頁；uri action 不產生 webhook 事件，完全繞過 MANUS。原 webhook 落點問題作廢。
- 【已解決】Ragic「回饋單」表欄位 ID 已建好：合約編號 1023087、卡片類型 1023092、發送日期 1023093、回覆時間 1023094、回饋類型 1023095、不滿意項目 1023096、留言 1023097；租客手機1/姓名/房號（1023089/90/91）由 doLinkLoad=true 自動帶出；JGBID 1023088、回饋單號 1023086 不寫。
- 無其餘阻擋：按鈕②名稱定「有點小狀況，請小幫手協助 🛠️」；回饋類型值＝住得舒服／需要協助；問卷內容與通知 UID 名單做成後台可編輯。
