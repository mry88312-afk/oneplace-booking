# ONE-899 預約驗證等待與錯誤紀錄

租客身分查詢遇到外部服務無回應時，十秒後顯示「系統忙碌，請稍後重試」，沿用原有重試按鈕。Ragic 每次 GET 最多等待八秒，暫時性錯誤最多再試一次；不重送 POST 或 PUT。前端逾時回應使用既有 SuperJSON 格式，避免錯誤提示本身解析失敗。

新紀錄只保留錯誤分類、查詢表、程序名稱、狀態與耗時，不記錄查詢條件或憑證。Caddy 移除完整 URI、請求標頭、回應標頭及客戶端 IP，另記入口路徑以定位錯誤連結。LINE gateway 記錄路由分類、狀態與耗時，Docker 紀錄上限為每檔 4 MB、三檔。

## 版本與授權

- Jira：https://oneplace-tw.atlassian.net/browse/ONE-899
- 使用者批准本機、完整修復與正式設定變更。
- 直接合併授權記於根目錄 `AGENTS.md`，不再要求使用者另行批准合併。
- 以最新 `origin/main` 建立 `ONE-899-verification-reliability`，整合已核對的正式發布線 `bd4a99070205`。此整合保留 #16、#18 的既有正式功能。
- #1、#14 與目前版本衝突，尚未合併；不把可合併授權當作通過衝突驗證的證據。

## 驗證

- 修正前新增的兩項測試皆失敗：缺少取消訊號、503 不重試。
- 第一輪 main：型別檢查通過、96 測通過、前後端建置通過。
- 整合正式線：型別檢查通過；103 項測試中 102 通過，1 項需獨立 PostgreSQL fixture 而跳過；建置通過。
- `server/booking/ragicRead.test.ts` 驗證真正的 tRPC 用戶端可讀取十秒逾時提示，以及外部不回應時兩次請求均取消。
- 執行 `scripts/verify-one899.ps1` 重現型別、TypeScript 測試及完整建置；必須透過全域 RAM 防護工具執行。
- `deploy/gcp/renewal-gateway.test.cjs` 須於既有匯訂映像、隔離網路及 `/gate` 掛載中另跑，不使用正式 LINE 憑證。

## 發布與回復

`scripts/release-one899.py stage <12碼SHA>` 建立新版 app 與 gateway、測試登入拒絕與隔離登入 fixture、驗證候選 Caddy。`activate` 會重新比對原設定雜湊，檢查候選服務後才切換；切換後驗證失敗會還原 `before.caddy` 並 reload。

前端須使用 `VITE_REMITTANCE_API_BASE=/booking-link` 完整建置。正式 app 唯一變更的環境值是 `BOOKING_REMITTANCE_BRIDGE`，指向本次 gateway 容器；其餘環境以記憶體中比對、雜湊留證，不輸出秘密。保留原 app 與 gateway，回復時還原發布目錄內的 `before.caddy`，執行 `caddy validate --config /etc/caddy/Caddyfile` 後 `systemctl reload caddy`。

gateway 的登入 session 存在程序記憶體；切換後既有頁面可能需要重新從 LINE 開啟。合併、上線、登入後真實操作及人工驗收須分開記錄；匿名 HTTP 通過不能當成人工驗收。
