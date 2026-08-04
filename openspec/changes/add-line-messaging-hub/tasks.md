## 1. 地基：messaging schema 與圖片託管（Phase 0）

- [x] 1.1 套用 messaging schema migration（建立 asset、rich_menu、rich_menu_area、rich_menu_alias、rich_menu_assignment 五張表），實作設計「messaging schema 與資料表設計」。驗證：於 Supabase 對 messaging schema 查詢，五張表存在且欄位與 design.md 一致。
- [x] 1.2 建立 Supabase Storage 公開讀 bucket line-assets，實作設計「圖片託管採 Supabase Storage 公開 bucket，不用 Zeabur 容器」。驗證：上傳一個測試物件後，其 public URL 於瀏覽器可直接開啟。
- [x] 1.3 實作圖片上傳端點（server/routers/property/assetHandlers.ts，Express multipart）達成需求 "Image upload to managed public storage"：存入 bucket、寫入 asset 記錄、回傳 { assetId, publicUrl }。驗證：以 curl 上傳一張 PNG → 取得 URL，該 URL 放進 Flex image 能正常顯示，且重新部署後仍可存取。
- [x] 1.4 上傳端點套用管理者權限達成需求 "Upload endpoint requires administrator authorization"（沿用 x-admin-password，對應設計「上傳與發布端點沿用既有管理者權限」）。驗證：未帶有效憑證的請求得到授權錯誤，且 bucket 與 asset 表皆無新增。
- [x] 1.5 提供資產列表 API 達成需求 "Uploaded assets are listable for reuse"。驗證：呼叫列表回傳先前上傳資產的 public URL 與 kind，供後台重用挑圖。

## 2. LINE rich menu 後端（Phase 1）

- [x] 2.1 實作 LINE rich menu API client 模組（server/routers/property/richMenuHandlers.ts：建立選單、上傳圖、alias 建立／更新、設預設、link／unlink user、list／delete），共用 LINE_MESSAGING_TENANT_ACCESS_TOKEN，實作設計「沿用既有 LINE token 與發送路徑，不動 MANUS」。驗證：以測試帳號呼叫 list 成功、建立並刪除一個臨時選單成功，且未新增任何 webhook。
- [x] 2.2 實作 rich_menu 與 area 的 DB CRUD（adminProcedure）達成需求 "Define rich menus and tappable areas as data"（area 動作僅允許 uri 與 richmenuswitch），並提供 preview 達成需求 "Preview the menu payload before publishing"（回傳將送往 LINE 的選單 JSON 而不建立任何東西）。驗證：建立含兩種合法 action 的選單成功、含其他 action type 被拒並回報型別；preview 回傳 size／areas／actions JSON 且 LINE 上未新增選單。
- [x] 2.3 發布時以後端代理把圖片位元組推給 LINE，實作設計「rich menu 圖片走後端代理上傳」：由 asset public_url fetch 位元組、依 image/png 或 image/jpeg POST 到 api-data content 端點，並於上傳前驗證 LINE 尺寸／格式／大小。驗證：用 2500x1686 圖發布成功；不合規圖被擋並明確回報違反項目。
- [x] 2.4 實作可重入發布 publish(menuKey) 達成需求 "Publish a rich menu to LINE idempotently"，實作設計「圖文選單以 DB 定義、可重入地發布同步到 LINE」：建立新選單→上傳圖→重指 alias→刪舊選單，並記錄目前 richMenuId。驗證：首發後 DB 記錄 richMenuId；重發後 alias 指向新選單、舊選單已刪、reconcile 無孤兒。
- [x] 2.5 實作多頁切換達成需求 "Multi-page switching via alias and richmenuswitch"，實作設計「多頁切換採 rich menu alias 加 richmenuswitch」：發布雙頁選單並以 richmenuswitch 互切。驗證：真實測試帳號點切換區由 A 翻到 B、再翻回 A，無伺服器來回。
- [x] 2.6 實作預設與個別租客指派達成需求 "Default menu and per-tenant assignment"：set default（POST user/all/richmenu）與 assign／unassign tenant by UID。驗證：設預設後無指派的使用者看到該選單；指派某 UID 後該租客看到被指派選單而非預設。
- [x] 2.7 實作 reconcile 達成需求 "Reconcile removes orphan rich menus"，並對所有 rich menu 寫入／發布／指派／reconcile 套用管理者權限達成需求 "Management and publish operations require administrator authorization"（對應設計「上傳與發布端點沿用既有管理者權限」）。驗證：reconcile 刪除 LINE 上未被任何 DB 記錄追蹤的選單並回報清單；未帶憑證的 publish／modify 被拒且 LINE 與 DB 皆無變更。

## 3. 後台介面與路由掛載（Phase 1 前端）

- [x] 3.1 在 server/index.ts 掛載圖片上傳與 rich menu 發布路由並套用權限 — 行為：新端點於線上可用且受保護。驗證：部署後以 curl 帶／不帶憑證打端點，行為符合 1.4 與 2.7。
- [x] 3.2 在 server/routers/property/booking.ts 新增 rich menu 與 asset 的管理 procedures（list／upsert／delete／publish／setDefault／assign／preview／reconcile）— 行為：前端可透過 tRPC 呼叫各操作。驗證：前端逐一呼叫各 procedure 取得預期結果。
- [x] 3.3 新增後台頁 client/src/pages/BookingAdmin/RichMenuManager.tsx 並於 client/src/pages/BookingAdmin.tsx 加入「圖文選單」分頁入口 — 行為：管理者能上傳圖、設定點擊區與動作、預覽、發布、設定切換關係與指派。驗證：在後台完成「上傳圖→定義雙頁→預覽→發布」全流程，真實測試帳號看到選單並可切換。
