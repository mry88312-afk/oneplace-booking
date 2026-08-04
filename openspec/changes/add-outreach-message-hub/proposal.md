## Why

系統準備正式上線，發訊需求已超出「合約日期算排程」一種：要在退租預約前一天晚上 6 點主動提醒、要讓其他系統也能把卡片投遞進來統一控管，而且現行派送一天只跑一次、無法指定「幾點發」。同時上線前要處理「拿不到 LINE UID 的主客」：看得到誰沒綁、查無電話的人也能自行註冊完成預約，否則預約與通知都會漏人。

## What Changes

- **發送時間精準到小時**：排程每筆新增發送時間（日期＋時刻）；派送由每日一次改為每小時掃描，時間到才送。既有入住／到期排程回填預設時段（台北 09:00），行為不變。
- **退租前一天提醒（新來源 booking）**：每日傍晚（台北 17:00）掃描本系統「明天的退租預約（已確認）」，為每筆排入「今天 18:00」的提醒卡，**自動確認**；發送那一刻再驗一次該預約仍存在、仍為已確認、仍是明天——取消或改期則跳過不發（改期者於新日期前一天自然重排）。提醒卡文案存於規則表（key：checkout_d1），沿用「規則／卡片」頁編輯與預覽。
- **投遞 API（新來源 api）**：新增密鑰保護端點，外部系統 POST {收件人（UID 或電話）、整張卡片 JSON、發送時間、標籤、去重碼} → 寫入排程（**自動確認**）→ 看板可見可跳過 → 時間到發送。相同去重碼只收一次；測試模式照樣攔截重導。
- **發送時電話換 UID**：排程只有電話的（API 來源），發送前以鏡像庫 contract.tenants.primary_phone（電話唯一）換 line_uid；換不到記失敗原因、保留可重試，不誤發。
- **看板來源／標籤分類**：排程列新增來源（rule／booking／api）與標籤；看板可依來源與標籤篩選並顯示。
- **未綁 UID 主客清單**：後台新增清單頁——有效合約但無 line_uid 的主客（姓名／電話／案場／房號），可匯出 CSV，供同事主動補綁。
- **電話查無開放自行註冊**：預約頁電話查無時，由「只跳錯誤」改為引導進入既有註冊畫面（姓名／電話／入住地址／房間編號），完成後可繼續預約；當下有 UID 一併寫回。

## Capabilities

### New Capabilities

- `tenant-self-registration`: 預約頁電話查無時的自行註冊（姓名／電話／入住地址／房號），完成後續約預約流程不中斷。

### Modified Capabilities

- `periodic-outreach`: 新增——發送時間精準到小時與每小時派送、退租前一天提醒（掃描＋發送前再驗）、外部投遞 API（去重）、發送時電話換 UID、看板來源／標籤分類、未綁 UID 主客清單。

## Impact

- Affected specs: periodic-outreach (modified)、tenant-self-registration (new)
- Affected code:
  - Modified:
    - server/routers/property/outreachHandlers.ts
    - server/index.ts
    - client/src/pages/BookingAdmin/OutreachBoard.tsx
    - client/src/pages/BookingPublic.tsx
  - New: (none)
  - Removed: (none)
- External systems（Supabase 專案 dwoahbduwzfzqmwpvadj，非本 repo）：
  - outreach.schedule 新增 send_at、source、tag、card_override、alt_text、recipient_phone、vars、dedupe_key（部分唯一索引）等欄位；既有列回填 send_at 與 source='rule'。
  - outreach.rule 的 trigger_basis 檢查約束擴充 booking_checkout；新增 checkout_d1 規則列；recompute_schedule() 僅處理合約基準規則並寫入 send_at。
  - dispatch_due() 改以 send_at 判斷到期；pg_cron 派送改每小時；新增每日傍晚掃描 job（pg_net 呼叫 Zeabur 掃描端點）。
- 資料來源：退租預約讀本系統 TiDB booking_records（含 LINE UID、預約時間、狀態）；電話換 UID 讀鏡像 contract.tenants（primary_phone 唯一）。
- 設定／環境：投遞與掃描端點沿用 OUTREACH_RUN_SECRET；無新增環境變數。
