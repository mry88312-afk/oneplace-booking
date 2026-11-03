# ONE-798 停止 contract 新預約，保留既有操作

使用者批准：本機開始執行，驗證後上線；停用contract舊網址的新預約，保留既有4筆及改期/取消。延續 https://oneplace-tw.atlassian.net/browse/ONE-798 ，不刪模板、預約、回執或Ragic資料，不對正式預約執行測試改期/取消。

## 實作

- `shared/bookingEntry.ts`：contract永久停止新預約；共用LIFF直接/編碼參數解析及登入返回網址，保留動作編號與dataset。
- `server/booking/ownedBooking.ts`：從原改期handler移出既有的dataset/本人/預約/模板查核，供原操作與時段權限共同使用，沒有複製另一套身份邏輯。
- `server/booking/projectAccess.ts`：contract模板及時段只允許持有該筆預約的本人讀取；不可跨專案借用身份。新confirm一律拒絕，即使舊前端快取或偽造bookingContext也不能重新建單。
- template、單/多日時段、preset、身份驗證、電話註冊與confirm程序都封閉contract新入口。取消及改期沿用原handler，只更新既有紀錄。
- `BookingPublic.tsx`：普通contract網址顯示停用頁及正式續約連結；有效原確認卡仍可操作。LIFF即使進到renewal，也從本人預約取得真正projectId，回到原contract的60分鐘/排班，避免誤套謝依蒨90分鐘。
- 沿用`BookingErrorScreen`，只新增可選標題/連結參數；其他錯誤畫面保持原樣。

## 本機與正式證據

主線worktree：`C:/Projects/oneplace-booking-zeabur-worktrees/ONE-798-retire-contract-entry`；branch `codex/ONE-798-retire-contract-entry`，從最新origin/main ec36b95建立。正式部署前版本為c24eb0e／PR8。

沒有migration或DB設定更新。本次開始的正式基線：bookings MD5 `659b7d6193246beef2bc69a4d96cf1c0`；attempts `80c41fc12bbca40d5b4fef4ea03b3a43`；全設定 `180942ea6981d7f1b95887a95042865e`。contract現有ID5–8全為confirmed、60分鐘。renewal謝依蒨90分鐘照常。

- tsc0錯、56/56測試通過、前後端build成功。
- 新測試走真實router/handler與Drizzle，DB/Calendar/Ragic/LINE只接合成stub。8種新contract呼叫在開DB前被拒絕；4筆本人皆能讀模板與單/多日時段；錯UID/缺dataset/舊dataset/不存在的預約/跨專案全部拒絕且無外部寫入。實際改期及取消handler通過；不新增或刪本地預約。
- 實際production build前端＋合成DB、實際handler：普通contract顯示停止新預約；renewal?reschedule=5成功改為16:00–17:00／曾國桐／60分鐘；編碼liff.state中的contract取消卡成功到取消頁及已取消頁。沒有真實外部請求。
- 本機證據 `.cache/contract-ui-evidence.json`、`.cache/contract-reschedule-synthetic.jpg`。所有fake預約皆為合成姓名/UID，與正式資料隔離。

## 發布及回復

主線照最新main開PR整合。正式服務仍是PR8，比main少一個其他工作的outreachHandlers改動；本次發布組合維持正式版outreachHandlers，僅加入已驗證的入口修正。發布branch從最新main建立後套此修正，並將該檔保持c24eb0e內容；此差異只供發布，不合回main、不回滾正式已啟用功能。

發布後驗證：普通contract畫面無預約操作；新template/slots/preset/confirm契約被拒；4筆既有預約本人可唯讀取回與查改期時段；renewal整週時段照常、正式既有預約/回執/設定MD5不變。正式不執行取消或改期測試，功能動作用合成handler/畫面證據驗證。實際部署commit、deployment ID與畫面證據補於ONE-798留言。

若新版本故障，只回復前一個已知可用應用部署，不修改booking資料或重送Ragic/LINE，不刪模板或重播renewal migration。回復會重新開放contract新入口，必須告知使用者並記錄；不得靜默回滾。此修改不涉及資料遷移，沒有歷史資料回復步驟。

未刪檔；原loadOwnedBooking函式移至共用檔，原行為保留。人工實機驗收及自然改期/取消案例與工程驗證分開，Jira交付時保留In Review/Test並指派mry88312。
