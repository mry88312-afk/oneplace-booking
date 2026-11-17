# ONE-900 前一日提醒任務查核

2026-11-17 唯讀查證：正式站標頭 X-OnePlace-Release 為 a8a77f5717b0；經相同正式容器 BOOKING_DATABASE_URL 以 READ ONLY 交易讀取，預約 17、18 仍 confirmed，Ragic 對應 1046、1047；預約 9 已 cancelled。

同容器金鑰 GET go-back/1/1046 與 /1047（api、v=3、naming=EID）皆 HTTP 200、空物件；不存在的對照 ID 同樣回空物件；同表列表 limit=1 可讀到 _ragicId=1053，證明不是整表讀取失敗。未寫入資料或發送訊息。

## 修正

booking 來源提醒發送前，使用模板 ragicTaskPath 與預約 ragicRecordId 讀取原任務。單筆 404 略過；空物件需同表列表能讀到有效記錄才略過。正常紀錄須 _ragicId 相符。其他錯誤交回原有失敗紀錄機制，保留待查、不發送、不取消預約。查核位於正式派送鎖定前；原有預覽模式維持原行為。

## 驗證

針對性測試 9/9 通過；npm run check 結束碼 0；npm run build:server 結束碼 0。完整測試結果見 PR。

## 發布與回復

尚未部署或做自然排程驗收。GCP 發布線與 main 分歧，需在當時正式發布版本另行整合並驗證，禁止直接以 main 覆蓋正式站。回復本次程式可 revert 修正 commit，無 migration。已略過的提醒不得自動重播，需另行核對。

完整 npm test：113 項，111 通過、1 略過（缺少專用 fixture DB）、1 失敗。失敗檔 deploy/gcp/renewal-gateway.test.cjs 在載入階段找不到容器絕對路徑 /app/node_modules/express，另依賴 /gate/line-session.cjs；未修改該檔，需在專用容器驗證，不能宣稱全綠。

## 2026-11-17 GCP 發布結果

PR #23 與補正單筆回應格式的 PR #24 均已合併。正式發布以 a8a77f5717b0 為基底，加入 5249349、c1e6428 的修正；實際程式版本 d04977b2784d。

發布線第一輪 13 項相關測試通過；補正後 10 項任務查核測試全通過，型別檢查與後端打包成功。完整測試的容器路徑限制仍如上，未宣稱全套全綠。

候選正式容器使用相同金鑰與修正 helper 唯讀查詢：1046=false、1047=false、1053=true；無發送訊息或異動預約。正式容器 /app/dist/index.js SHA-256：44a225cc8e4b2d8de32d3ece570d8bd753dff1a99bb91c297b808fd9c0c29d03，與本機建置一致。

正式環境變數與掛載全部相同，登入閘道維持原 one899-line-a8a77f5717b0。Caddy 僅將四處 app 上游改為 32803 與更新版本標頭。設定驗證、切換後 /healthz、/book/checkout、/book/renewal 均 HTTP 200 並回新版標頭；登入閘道無身分 /principal 仍 403。新容器 running、restart=0。

主機證據：/srv/one900-booking/d04977b2784d/receipt.json、before.caddy、candidate.caddy、release-tests.log。回復：還原此 before.caddy 至 /etc/caddy/sites/booking.caddy，驗證後 reload Caddy；舊正式容器仍保留。

未驗收：自然排程實際執行、LINE 實際收件、登入後畫面。本次未手動重播提醒。舊補正前候選 f45b823a08b2 不採用，勿復原。
