## 1. Supabase schema 與 recompute 調整（大腦）

- [x] 1.1 對 outreach.schedule 增加 last_error(text) / last_attempt_at(timestamptz) / attempt_count(int default 0) 三欄，既有列 attempt_count 補 0。行為：schedule 具備記錄發送失敗的欄位。驗證：查 information_schema.columns 三欄皆存在且 attempt_count 預設 0。（依 design 決策：失敗追蹤用 schedule 三欄、不另建 send_log 表；spec: Send Failure Tracking And Retry）
- [x] 1.2 對 outreach.rule 增加 auto_confirm(boolean default false)，既有四條規則皆為 false。行為：規則可標記是否自動確認。驗證：查欄位存在、現有規則 auto_confirm 全為 false。（依 design 決策：每規則自動確認 auto_confirm 欄位、recompute 決定初始 status；spec: Per-Rule Auto-Confirmation）
- [x] 1.3 以 CREATE OR REPLACE 更新 outreach.recompute_schedule()，使新插入列 status 依該規則 auto_confirm（true→confirmed，false→pending），且不覆蓋既有列與 manually_edited=true 列。行為：自動確認規則的新排程直接為 confirmed、其餘維持 pending。驗證：將一規則 auto_confirm 設 true 後重算，該規則新列為 confirmed、其餘 pending、既有列不變、重跑冪等。（依 design 決策：每規則自動確認 auto_confirm 欄位、recompute 決定初始 status；spec: Per-Rule Auto-Confirmation）

## 2. Zeabur 後端：執行端點與 tRPC procedures（嘴巴）

- [x] 2.1 runOutreach 每筆發送嘗試後回寫失敗欄位（server/routers/property/outreachHandlers.ts）：失敗時 set last_error、last_attempt_at=now、attempt_count+1 且 status 不變；成功時 set status=sent、sent_at、清空 last_error。行為：發送失敗可被追蹤且保留可重試狀態。驗證：以壞 card_template 觸發 /api/outreach/run，該筆 last_error 有值、attempt_count=1、status 維持 confirmed。（依 design 決策：失敗追蹤用 schedule 三欄、不另建 send_log 表；spec: Send Failure Tracking And Retry）
- [x] 2.2 新增 tRPC updateScheduleItemsBatch({ids, action:'confirm'|'skip'})，逐筆重用 updateScheduleItem 核心、個別失敗不中斷其餘、回傳 results:[{id,ok,error}]。行為：一次對多筆確認或跳過。驗證：選 3 筆（含 1 筆已 sent）做 confirm → 2 筆轉 confirmed、已 sent 筆回 ok=false 並附原因、其餘不受影響。（依 design 決策：批次操作以新增 batch tRPC procedures 實作；spec: Batch Schedule Operations）
- [x] 2.3 新增 tRPC sendNowBatch({ids})，逐筆重用 sendNow（含發送前 booking_records suppression 與 test_redirect_uid 測試重導）、序列化並小幅節流、回傳 results。行為：一次對多筆立即送且不誤觸真人。驗證：多筆 confirmed 立即送，命中 booking_records 的筆回 suppressed、其餘 sent；測試模式開啟時全部重導測試對象。（依 design 決策：批次操作以新增 batch tRPC procedures 實作；spec: Batch Schedule Operations）
- [x] 2.4 新增 tRPC previewScheduleItem({id})：computeVars→renderTemplate(rule.card_template)→toFlexMessage→pushTestCard 至 test_redirect_uid；不改 status、不經派送；未設 test_redirect_uid 回明確錯誤。行為：預覽只送測試對象、永不送真人。驗證：對任一筆預覽 → 測試 LINE 收到該筆內容、真人收不到、status 不變；清空測試對象再預覽 → 回錯誤訊息。（依 design 決策：每筆預覽一律送測試對象 test_redirect_uid、永不送真人；spec: Per-Entry Card Preview To Test Recipient）
- [x] 2.5 新增 tRPC getOutreachStats({months})：以 sent_at（無則 last_attempt_at）落月、依 status 計數、failed 定義為 status≠sent 且 attempt_count>0 且 last_error 有值、ratio=failed/(sent+failed)、warn 門檻預設 20%。行為：提供每月發送成效彙總與低送達率示警旗標。驗證：回傳每月 buckets 含 sent/suppressed/failed/ratio/warn；造一個 failed 比例>20% 的月 → 該月 warn=true。（依 design 決策：發送成效統計由既有欄位彙總（getOutreachStats）；spec: Send Outcome Statistics）
- [x] 2.6 擴充 listRules/updateRule 讀寫 auto_confirm，並讓 listSchedule 支援 onlyFailed 過濾（status≠sent 且 attempt_count>0 且 last_error 有值）。行為：前端可讀寫規則自動確認、可篩出失敗清單。驗證：updateRule 設 auto_confirm 後 listRules 回傳更新值；listSchedule onlyFailed=true 只回失敗筆。（依 design 決策：每規則自動確認 auto_confirm 欄位、recompute 決定初始 status；spec: Per-Rule Auto-Confirmation；spec: Send Failure Tracking And Retry）

## 3. 前端看板擴充（client/src/pages/BookingAdmin/OutreachBoard.tsx）

- [x] 3.1 ScheduleTab 列表加勾選框與動作列，串接 updateScheduleItemsBatch / sendNowBatch 並顯示逐筆結果。行為：可框選多筆一次確認/跳過/立即送。驗證：勾選多筆按確認 → 列狀態更新、逐筆成功/失敗於 UI 呈現。（依 design 決策：批次操作以新增 batch tRPC procedures 實作；spec: Batch Schedule Operations）
- [x] 3.2 每列加「預覽」鈕呼叫 previewScheduleItem，顯示「已送至測試對象」或未設測試對象的錯誤。行為：逐筆可預覽到測試 LINE。驗證：按預覽 → 測試 LINE 收到、UI 顯示成功；未設測試對象時顯示錯誤提示。（依 design 決策：每筆預覽一律送測試對象 test_redirect_uid、永不送真人；spec: Per-Entry Card Preview To Test Recipient）
- [x] 3.3 加「今天」快捷 preset（scheduled_date=今日）與依 property_name 分組顯示＋每案場計數。行為：一鍵看今天要發、可依案場分組看量。驗證：按「今天」只剩今日 scheduled_date 的列；開分組 → 依案場分組並顯示每案場計數。（依 design 決策：今天要發與依案場分組以前端 + 既有查詢實作；spec: Today And Property-Grouped Schedule Views）
- [x] 3.4 加「失敗清單」檢視（onlyFailed），顯示 last_error / last_attempt_at / attempt_count，並提供一鍵重送（呼叫 sendNow）。行為：失敗可見且可重送。驗證：失敗筆出現於清單、按重送成功後該筆轉 sent 且 last_error 清空。（依 design 決策：失敗追蹤用 schedule 三欄、不另建 send_log 表；spec: Send Failure Tracking And Retry）
- [x] 3.5 加 CSV 匯出鈕（排程模式與歷史模式各自），輸出 UTF-8 BOM、欄位 scheduled_date,tenant_name,room,property_name,rule_key,status,sent_at,attempt_count,last_error。行為：可匯出對帳/回報用 CSV。驗證：下載 CSV 以 Excel 開啟中文正常、欄位齊全且列數等於目前清單。（依 design 決策：CSV 匯出於前端產生（UTF-8 BOM）；spec: Schedule And History CSV Export）
- [x] 3.6 新增「成效」分頁呈現 getOutreachStats 每月 sent/suppressed/failed 與比例，對高 failed 比例月份示警。行為：可看每月發送成效並收到低送達率示警。驗證：分頁顯示當月數據；warn=true 的月份顯示示警樣式。（spec: Send Outcome Statistics）
- [x] 3.7 規則卡片加 auto_confirm 開關與警語（開啟＝該規則新排程免人工確認直接派送），串接 updateRule。行為：可逐規則開關自動確認。驗證：切換開關 → DB auto_confirm 改變、UI 顯示警語、重算後該規則新列為 confirmed。（依 design 決策：每規則自動確認 auto_confirm 欄位、recompute 決定初始 status；spec: Per-Rule Auto-Confirmation）

## 4. 部署與端到端驗收（項目 1–7，測試模式下）

- [x] 4.1 commit 並 push 觸發 Zeabur 自動部署，於測試模式（test_redirect_uid 設為管理者本人）下逐項驗收 design「Implementation Contract」的驗收 ①–⑥：批次確認混入已 sent、預覽只到測試對象、製造失敗→失敗清單→重送、規則 auto_confirm→新列 confirmed、成效分頁當月數據、排程 CSV 中文正常。行為：項目 1–7 在生產環境可用且不誤觸真人。驗證：六項驗收逐一通過並記錄結果。

## 5. 入住卡互動回饋：開啟連結 → 寫 Ragic → 通知（項目 8）

- [x] 5.1 （已解決，改方案）原規劃確認 LINE inbound webhook 落點；查出指向 MANUS 主系統。為不動 MANUS，改用「開啟連結」方案繞過 webhook（卡片按鈕改 uri、直接開到本系統頁，不產生 webhook 事件）。行為：落點問題作廢、改用連結方案、Ragic 欄位已確認。驗證：design.md Open Questions 已記錄改方案與 Ragic 欄位 ID。（依 design 決策：入住卡互動回饋：用開啟連結進本系統（不經 MANUS）＋ 問卷 ＋ 寫 Ragic ＋ LINE 通知；spec: Interactive Card Feedback via Link）
- [x] 5.2 卡片 card_template 兩顆按鈕改「開啟連結」(uri action)：①「住得很舒服 😊」②「有點小狀況，請小幫手協助 🛠️」，連結指向本系統回饋頁、帶該筆 schedule id 當 token。行為：點按鈕在手機開啟本系統頁面，不經 LINE webhook／MANUS。驗證：預覽入住卡兩鈕為連結；點擊開啟本系統回饋頁。（依 design 決策：入住卡互動回饋：用開啟連結進本系統（不經 MANUS）＋ 問卷 ＋ 寫 Ragic ＋ LINE 通知；spec: Interactive Card Feedback via Link）
- [x] 5.3 本系統新增公開回饋頁路由（server/index.ts 掛載，邏輯放 server/routers/property/outreachFeedbackHandlers.ts）：依 schedule id 查該筆 → 以 ragicPut 寫 Ragic「回饋單」表（合約編號 1023087＋doLinkLoad=true 自動帶手機/姓名/房號；另寫卡片類型 1023092、發送日期 1023093、回覆時間 1023094、回饋類型 1023095、不滿意項目 1023096、留言 1023097；不寫 JGBID/回饋單號）。①舒服＝直接記錄＋謝謝頁；②協助＝先顯示問卷再記錄。行為：點連結後 Ragic 出現一筆且欄位正確（含 doLinkLoad 帶出的手機/姓名/房號）。驗證：分別點兩顆按鈕 → Ragic 回饋單各出現一筆、回饋類型與欄位正確。（依 design 決策：入住卡互動回饋：用開啟連結進本系統（不經 MANUS）＋ 問卷 ＋ 寫 Ragic ＋ LINE 通知；spec: Interactive Card Feedback via Link）
- [x] 5.4 通知與後台可編輯：不滿意問卷送出後，對 outreach.settings.notify_uids（逗號分隔、可多人）每個 UID 以 pushLineDirect 發通知（含房客/住處/合約/項目/留言/時間）；OutreachBoard 新增兩個後台可編輯區——問卷內容（feedback_survey）與通知 UID 名單。行為：不滿意回饋會通知指定同事，且同事可在後台自行改問卷與名單。驗證：送出不滿意 → 名單內 UID 收到 LINE；後台改問卷/名單後新流程即時套用。（依 design 決策：入住卡互動回饋：用開啟連結進本系統（不經 MANUS）＋ 問卷 ＋ 寫 Ragic ＋ LINE 通知；spec: Interactive Card Feedback via Link）
