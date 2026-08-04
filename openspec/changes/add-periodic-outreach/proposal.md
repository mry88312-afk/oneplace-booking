## Why

一方需要在固定時間點主動關懷與提醒室友（入住第 15 天問候、合約到期前 60/30/15 天續約提醒），目前沒有自動化，也看不到「何時、要發哪張卡、給哪位室友」。手動追蹤容易漏發；到期催約若沒排除「已續約或已退租」的人會誤發打擾。

## What Changes

- 新增「週期詢問」功能：依時間規則自動發 LINE Flex 卡片給符合條件的室友。
- 時間規則（相對合約日期）：入住（合約開始日）+15 天 問候卡；合約到期日 −60 天、−30 天、−15 天 續約提醒卡。
- 篩選：以兩個 property 欄位過濾（對應使用者 Ragic 的兩個篩選欄位，AND 結合）——案件歸屬 ownership_region ∈ {總公司}、總公司內分類 hq_internal_category ∉ {靠行}（只排除靠行，其餘類別全保留）——且合約 status = active；兩個集合做成可調參數。
- 已處理排除（不分管道）：鏡像中已有續約子約（renewal_parent_id 指向本約）、或 status = cancelled、或 termination_reason 有值者一律不發；另在 Zeabur 發送前再查本地 booking_records，補抓「剛在 Zeabur 預約、鏡像尚未同步」的空窗。
- 架構：Supabase pg_cron 每日計算 outreach_schedule 排程表（冪等），pg_net 觸發 Zeabur 的 outreach 執行端點；Zeabur 發送前再做一次 gate，建立 Flex 卡片、推 LINE、回寫排程狀態。
- 後台「週期詢問」看板（Zeabur）：視覺化未來排程（日期 / 室友 / 卡別 / 狀態），可編輯日期、跳過、立即送（提早）、且需手動確認才實際發送。
- v1 範圍：排程計算 + 視覺看板 + 手動確認發送。互動按鈕（住得舒服 / 我想討論）、回寫感受到合約、每月 pulse 關懷屬 v2/v3，不在本次。
- 非破壞性：純新增，不更動既有預約/退租/續約流程。

## Capabilities

### New Capabilities

- `periodic-outreach`: 週期詢問的時間規則、室友篩選與已處理排除、排程冪等、發送與防重複、後台視覺看板與手動確認。

### Modified Capabilities

(none)

## Impact

- Affected specs: periodic-outreach (new)
- Affected code:
  - New:
    - server/routers/property/outreachHandlers.ts
    - client/src/pages/BookingAdmin/OutreachBoard.tsx
  - Modified:
    - server/routers/property/booking.ts
    - client/src/pages/BookingAdmin.tsx
  - Removed: (none)
- External systems (Supabase 專案 dwoahbduwzfzqmwpvadj，非本 repo)：新增 outreach schema 與排程表、pg_cron 排程、pg_net 觸發、規則計算 SQL；讀取 contract.tenant_contracts、contract.tenants、contract.tenant_contract_parties、property.properties。
- 設定/環境：Zeabur 後端新增讀取 Supabase 的連線（service_role 或 DATABASE_URL）；觸發端點以共享密鑰保護。
