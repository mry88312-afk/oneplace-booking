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
