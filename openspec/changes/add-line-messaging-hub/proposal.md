## Why

一方目前「會發給租客什麼」散落在三處：續約／JGB／確認卡寫死在後端 TypeScript、週期詢問卡存在 Supabase outreach schema 的 JSONB、而 LINE 圖文選單完全沒有納入系統（只能用 LINE 官方後台，做不到多頁切換）。每改一張寫死的卡片就要重新部署（伴隨 Zeabur 換版的短暫 502），卡片圖片還得先丟外部短網址服務再貼回，且沒有任何地方能一眼看出「每個流程在做什麼」。本變更建立一個以 Supabase 為單一事實來源的 LINE 訊息中樞，第一步先交付「圖片自架託管」與「可程式化管理的圖文選單（含多頁切換）」兩塊地基。

## What Changes

- 新增**圖片託管能力**：在 Supabase Storage 建立公開 bucket，提供受管理者權限保護的上傳端點與後台介面；上傳後回傳穩定 public URL，供 Flex 卡片 image 與圖文選單來源圖使用，取代現行外部短網址流程。
- 新增**圖文選單管理能力**：以 Supabase 資料定義圖文選單（圖片、點擊區、動作，含 richmenuswitch 多頁切換與 alias），透過既有 LINE channel access token 呼叫 Messaging API 將定義發布／同步到 LINE；可設定預設選單與指派個別租客。後台提供管理／發布頁（上傳圖、設定點擊區與動作、預覽、一鍵發布、設定切換關係）。
- 新增 **messaging schema**（Supabase）：本期建立圖片資產追蹤表與 rich_menu／rich_menu_area／rich_menu_alias／rich_menu_assignment 等表，作為上述能力的事實來源。
- 沿用既有 LINE_MESSAGING_TENANT_ACCESS_TOKEN 與發送路徑；不更動 booking／outreach 既有發送、不更動 MANUS webhook。
- 分階段交付：本變更聚焦 Phase 0（地基）＋ Phase 1（圖文選單）。Phase 2（卡片庫統一＋postback 回覆流程引擎）與 Phase 3（唯讀視覺流程地圖）為後續獨立變更，全貌與排除項記於 design.md。

## Capabilities

### New Capabilities

- `line-asset-hosting`: 透過 Supabase Storage 公開 bucket 託管圖片，提供受管理者權限保護的上傳端點，回傳穩定 public URL，並在資料庫追蹤已上傳資產。
- `rich-menu-management`: 以 Supabase 為事實來源定義 LINE 圖文選單（點擊區、動作、多頁切換 alias），可預覽、可重入地發布／同步到 LINE Messaging API，並設定預設選單與個別租客的選單指派。

### Modified Capabilities

(none)

## Impact

- Affected specs: 新增 line-asset-hosting、rich-menu-management 兩個能力規格。
- Affected code:
  - New:
    - server/routers/property/assetHandlers.ts（圖片上傳到 Supabase Storage、回傳 public URL、寫入資產表）
    - server/routers/property/richMenuHandlers.ts（LINE rich menu API 封裝：建立／上傳圖／alias／設預設／指派／切換，及由 DB 定義發布同步）
    - client/src/pages/BookingAdmin/RichMenuManager.tsx（圖文選單管理／發布頁）
    - supabase/migrations/messaging_schema.sql（messaging schema：assets、rich_menu、rich_menu_area、rich_menu_alias、rich_menu_assignment）
  - Modified:
    - server/index.ts（掛載圖片上傳與 rich menu 發布路由、套用權限）
    - server/routers/property/booking.ts（新增 rich menu／asset 的管理 procedures）
    - client/src/pages/BookingAdmin.tsx（新增「圖文選單」分頁入口）
  - Removed: （無）
- Dependencies／Systems: Supabase Storage（新公開 bucket：line-assets）；LINE Messaging API rich menu 端點（沿用既有 channel access token）；Zeabur 部署（schema 與程式改動需部署；日常的選單／圖片資料變更則免部署）。
