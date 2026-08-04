## Context

一方的 LINE 訊息目前分散三處：booking 卡寫死在後端 TypeScript（buildRenewalNodeCard 等）、週期詢問卡存在 Supabase outreach schema 的 JSONB、圖文選單未納入系統。發送統一走 server/routers/property/bookingConfirmHandler.ts 的 pushLineDirect()，使用環境變數 LINE_MESSAGING_TENANT_ACCESS_TOKEN 呼叫 LINE Messaging API。卡片圖片目前以外部短網址服務託管。平台為 Zeabur（git push 自動部署、換版有短暫 502），資料大腦在 Supabase。LINE 官方後台做不到圖文選單多頁切換，必須走 Messaging API。本設計交付 Phase 0（圖片託管 + messaging schema）與 Phase 1（圖文選單管理／發布）。

## Goals / Non-Goals

**Goals:**

- 圖片改由 Supabase Storage 公開 bucket 託管，回傳穩定 public URL，跨 Zeabur 換版不消失。
- 圖文選單以 Supabase 為事實來源定義，能可重入地發布／同步到 LINE，支援多頁切換（alias + richmenuswitch）、預設選單與個別租客指派。
- 沿用既有 LINE token 與發送路徑；不更動 booking／outreach 既有發送與 MANUS。

**Non-Goals:**

- Phase 2：卡片庫（messaging.card）統一、postback／訊息回覆流程引擎（flow／flow_step）、把 booking／outreach 卡片改為引用卡片庫 — 不在本變更。
- Phase 3：唯讀視覺流程地圖 UI — 不在本變更。
- 本期圖文選單點擊區僅支援 uri 與 richmenuswitch 兩種動作（皆不需我方接 webhook）；postback／message 的接收與路由屬 Phase 2。
- 不新增 Flex 卡片視覺化編輯器；卡片仍以現有方式維護。

## Decisions

### 圖片託管採 Supabase Storage 公開 bucket，不用 Zeabur 容器

Zeabur 容器檔案系統為易失性，換版／重啟即清空，故不可存容器。選 Supabase Storage（已是現有依賴、自帶 CDN 與穩定 public URL），建立公開讀 bucket line-assets。替代方案：Zeabur Volume（可持久但需自管靜態服務、無 CDN、跨實例複雜）、維持外部短網址（即現況痛點）。

### messaging schema 與資料表設計

新增 messaging schema，本期建立：asset（圖片資產：bucket 路徑、public_url、kind、寬高、上傳者）、rich_menu（選單：key、name、chat_bar_text、尺寸、是否預設、image_asset_id、line_rich_menu_id 目前對應、status）、rich_menu_area（點擊區：bounds 與 action_type／action_payload）、rich_menu_alias（穩定 alias_id 指向哪個 rich_menu，供切換）、rich_menu_assignment（指派：default 或 tenant＋tenant_uid）。card 與 flow／flow_step 表延後到 Phase 2 一併建立，避免本期出現無行為的空表。

### 圖文選單以 DB 定義、可重入地發布同步到 LINE

發布流程：對每個要發布的 rich_menu，呼叫 LINE 建立選單（POST /v2/bot/richmenu 取得 richMenuId）→ 由 asset 的 public_url 取得圖片位元組、上傳到 api-data.line.me 的 content 端點 → 建立或更新 alias，使穩定 alias_id 指向新的 richMenuId → 視 assignment 設定預設（POST /v2/bot/user/all/richmenu/{id}）或指派個別租客（POST /v2/bot/user/{uid}/richmenu/{id}）。因 LINE 的 richMenuId 每次建立都不同，DB 保存目前 richMenuId 與 alias 對應；重發時採「先建新、再把 alias 重指、最後刪舊」達到可重入更新。替代方案：每次刪光重建（會有空窗、預設選單會瞬間消失），故不採。

### 多頁切換採 rich menu alias 加 richmenuswitch

多頁切換不需後端來回：在某頁的點擊區用 action 類型 richmenuswitch，帶 richMenuAliasId 指向另一頁的 alias；另一頁再設回切。alias 是切換的穩定把手，與「可重入發布」共用同一張 rich_menu_alias 表。

### rich menu 圖片走後端代理上傳

圖片來源存 Supabase Storage（可重用、可預覽），發布時由後端 fetch public_url 取得位元組，依 Content-Type image/png 或 image/jpeg POST 到 LINE content 端點。LINE 對圖片有限制（JPEG／PNG、尺寸需為 2500x1686 或 2500x843、檔案上限約 1MB），上傳與發布前驗證並回報明確錯誤。

### 上傳與發布端點沿用既有管理者權限

圖片上傳採 tRPC adminProcedure（收 base64，避免新增 multipart 依賴、直接重用既有 x-admin-password 驗證）；rich menu 管理同樣採 tRPC adminProcedure。兩者沿用現有 adminProcedure 機制（與 booking 後台一致），上傳／發布類寫入端點不得公開。server 端以 SUPABASE_SERVICE_ROLE_KEY 經 Storage REST API 寫入 line-assets bucket（讀取走公開 URL、不需金鑰）。

### 沿用既有 LINE token 與發送路徑，不動 MANUS

rich menu API 與既有 push 共用 LINE_MESSAGING_TENANT_ACCESS_TOKEN。本期點擊區僅 uri 與 richmenuswitch，皆不需我方接收 LINE webhook，故與 MANUS（可能持有 webhook）解耦、零更動。

## Implementation Contract

**Behavior（可觀察行為）:**

- 管理者在後台上傳一張圖 → 取得一個 Supabase 公開 URL；該 URL 能在 Flex image 正常顯示，且 Zeabur 重新部署後仍有效。
- 管理者在後台定義一個雙頁圖文選單（其中一頁含 richmenuswitch 點擊區）→ 按「發布」→ 真實測試帳號上出現該選單，點切換區會翻到第二頁、可再切回。
- 設定某選單為預設 → 使用者開啟聊天看到該選單；以 UID 指派個別租客 → 該租客看到被指派的選單。
- 編輯選單後重新發布 → 使用者看到的選單更新，且不殘留會干擾的舊預設（alias 已重指、舊選單已清除）。

**Interface／資料形狀:**

- Express 路由（multipart，管理者權限）：上傳圖片，回傳 JSON { assetId, publicUrl }。
- tRPC adminProcedures：列出／新增修改／刪除 rich_menu 與其 area；publish(menuKey)；setDefault(menuKey)；assignTenant(uid, menuKey) 與 unassign(uid)；preview(menuKey) 回傳將送往 LINE 的選單 JSON。
- LINE API client 模組：建立選單、上傳圖、alias 建立／更新、設預設、link／unlink user、list／delete。
- 資料表如「Decisions＞messaging schema」所列。

**Failure modes:**

- LINE 或 Storage 失敗時，回傳含 HTTP 狀態與訊息的錯誤（比照 pushLineDirect 風格），不靜默吞錯。
- 發布為可重入：影像上傳或 alias 重指中途失敗 → 標記該選單 status、保留舊的可用選單、可重試；提供 reconcile（比對 LINE 現有選單與 DB）清理孤兒選單。
- 圖片不符 LINE 規格 → 發布前擋下並明確告知（尺寸／格式／大小）。

**Acceptance criteria:**

- 上傳圖片 → 回傳的 public URL 在 Flex 卡片可顯示，且重新部署後仍可存取（手動驗證）。
- 雙頁可切換選單在真實測試帳號發布成功、切換正常（手動驗證）。
- 重發已編輯選單後，使用者端更新、無孤兒預設（手動驗證 + reconcile 列表為空）。
- 上傳／發布端點未帶管理者憑證時被拒（手動或測試驗證）。

**Scope boundaries:**

- In：圖片託管（bucket + 上傳端點 + 資產表）、rich_menu 與 area 的 DB CRUD、發布／同步到 LINE、alias 多頁切換、預設與個別租客指派、後台管理／發布頁、reconcile 清理。
- Out：messaging.card 卡片庫與其引用改寫、flow／flow_step 與 postback／訊息回覆引擎、視覺流程地圖、Flex 卡片視覺編輯器、接收 LINE webhook。

## Risks / Trade-offs

- [LINE richMenuId 每次建立都不同，重發易產生孤兒選單] → DB 保存對應、採「先建新後重指 alias 再刪舊」，並提供 reconcile 比對清理。
- [圖片規格嚴格（尺寸／格式／約 1MB）導致發布失敗] → 上傳與發布前驗證、明確錯誤訊息；後台顯示規格提示。
- [bucket 公開讀，圖片 URL 可被猜測存取] → 僅放非敏感的行銷／選單圖；上傳端點需權限；必要時改簽名 URL（本期不做）。
- [schema／程式改動仍需 Zeabur 部署、有 502 空窗] → 分批部署；日常選單／圖片資料變更走 DB、免部署。
- [Phase 1 不接 webhook → 點擊區僅 uri／richmenuswitch] → 明確限制動作型別；postback／message 路由待 Phase 2 與 MANUS webhook 歸屬釐清後再做。

## Migration Plan

- 套用 messaging schema migration（Supabase；本助理可用 MCP 套 SQL）。
- 建立 line-assets 公開 bucket（Supabase Storage；若 MCP 不支援建 bucket 則於 dashboard 或 storage API 建立並設公開讀）。
- 部署 server（新增上傳／發布路由與 adminProcedures），分批以降低 502。
- Rollback：移除新路由掛載即可；messaging schema 與 bucket 為新增、無破壞，可保留。

## Open Questions

- LINE webhook 目前由誰接收（是否 MANUS）？此決定 Phase 2 的 postback／訊息路由能否由我方處理或需協調。
- 圖片是否需版本化保存（覆寫 vs 保留歷史）？本期傾向覆寫、之後再議。
- 預設選單與個別租客指派的優先順序與覆蓋規則是否需更細（例如不同案場不同選單）？
