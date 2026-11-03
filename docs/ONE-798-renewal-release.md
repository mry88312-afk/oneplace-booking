# ONE-798 線上續約恢復

工單：https://oneplace-tw.atlassian.net/browse/ONE-798

## 批准與範圍

2026-11-03 使用者批准「照找到的舊排班，謝依蒨、每次90分鐘，表單跟流程照原本的。本機開始執行，完成驗證後上線」。

正式系統為 https://oneplace-booking.zeabur.app，Supabase「一方生活」`dwoahbduwzfzqmwpvadj` 的私有 `booking` schema。不是舊 `fieldops` MySQL，也不是 EntreClass。

本次新增獨立 `renewal` 設定，沿用現有程式。沒有修改執行中的前後端流程、既有預約、checkout/contract、舊 fieldops、Ragic 或 Calendar。通知仍由 Booking 經外勤工作站代發；不新增 LINE 直發路徑。

使用者稍後提出刪除 contract；因已有4筆已成立預約，說明影響後，使用者表示先自行確認 LIFF。故本次保留 contract；沒有硬刪或停用。

## 核定設定

負責人謝依蒨；忙碌檢查日曆 `chantel.oneplace@gmail.com`；每次90分鐘；台北時間：

| 星期 | 時段 |
| --- | --- |
| 日 | 13:00–20:30 |
| 一 | 10:00–18:30 |
| 二 | 16:00–18:30 |
| 三 | 13:00–20:30 |
| 四 | 關閉 |
| 五 | 10:00–18:30 |
| 六 | 關閉 |

可約90天，最早6天後，緩衝0分鐘。`weeklyHours` 為每日硬上限；只新增一條路由，沒有混入國桐/丹尼或舊重複規則。

表單依 ONE-147 2026-08-25 最後可證實的四欄正式快照；原 SQL 見 `drizzle/20260825_one147_renewal_payment_method.sql`、`drizzle/20260825_one147_restore_renewal_questions.sql`。

| 順序 | 欄位 | 必填 | 對應 |
| --- | --- | --- | --- |
| 0 | 繳費方式：月繳／半年繳／年繳 | 是 | Ragic 1013721 |
| 1 | 入住人數 | 是 | Booking 答案及確認卡 |
| 2 | 續約備註 | 否 | Booking 答案及確認卡 |
| 3 | 隱藏對話網址 | 否 | Ragic 1022936 |

重用 `projectId === 'renewal'` 原有個資付款設定、合約到期日選擇、展延月繳與2,000元提示、續約節點卡，以及多人入住 JGB 說明。沒有把一般備註錯映射到展延費用欄1013722。開始日固定為原到期日+1天；日期上限與預設沿用原程式，不另改業務規則。

## 正式資料與入口

Migration `20261103123012_one798_restore_renewal` 已於20:30台北套用正式庫，先於本次合併。CLI先建立空migration，再依MCP實際登錄版本同步檔名。整個DO敘述原子新增，若renewal已存在則拒絕覆蓋；所有ID由資料庫生成。

實際回讀：template30003、rule330015、fields300040–300043。原template60001屬舊系統來源鍵，未冒用或搬入舊預約。

前後完整資料雜湊一致：

| 範圍 | MD5 |
| --- | --- |
| 原checkout/contract模板、欄位、規則 | `354cfa03994475fcd4f8f7bbe73f3e8a` |
| 6筆booking_records | `659b7d6193246beef2bc69a4d96cf1c0` |
| booking_submission_attempts | `80c41fc12bbca40d5b4fef4ea03b3a43` |

原先LIFF於10/30為處理renewal 404而手動改到contract，來源ONE-772留言13147。使用者本輪自行查看LIFF後，公開轉址HTML已回讀為 `https://oneplace-booking.zeabur.app/book/renewal`。本輪Codex沒有改LINE Console或發LINE訊息；沒有管理該LINE Login Channel的本機憑證，亦未輸入密碼或植入cookie。

## 驗證

- `npm run check`：0錯（包含新增驗證腳本後再次檢查）。
- `npm test`：54/54通過。
- `npm run build`：前後端成功。
- 唯讀正式整合：`npx tsx scripts/verify-renewal.ts` PASS；2026-11-10～11-16完整7天，59個可約時段（3/13/0/15/0/13/15）；全部謝依蒨、90分鐘，週四/六0，沒有超過每天上限，單日/多日一致，preset回讀謝依蒨及原日曆。
- 原四欄與選項/必填/排序/Ragic映射由正式公開API逐項assert；dataset仍 `booking-20261028-one772`、writesEnabled=true。
- 本機用production build＋合成API跑過：個資付款→合成OTP→原日期及四欄→入住人數2/半年繳/備註→成功頁。捕獲的唯一合成confirm payload為renewal／謝依蒨／90分鐘／開始2027-01-01／到期2027-12-31。展延切換曾實際顯示2,000元提示且繳費方式鎖月繳。沒有呼叫正式OTP/Ragic/Calendar/LINE寫入端點。
- 本機畫面與合成回執保存在本worktree `.cache/renewal-form-synthetic.jpg`、`.cache/renewal-synthetic-receipt.json`（不提交含個人資料的正式截圖）。
- 正式瀏覽器既有登入成功進入renewal「更新個人資料／付款設定」，停在發OTP之前；未製造真實測試單。

本次為設定發布，執行程式沿用既有部署，不需要更換環境變數或手動重啟。若GitHub合併觸發Zeabur重建，須確認服務與公開API仍正常。

## 後續與失敗處置

第一筆自然renewal預約尚待核對持久回執、Ragic線上續約/負責人/90分鐘、共用Calendar事件與LINE收件。合成成功與API回200不能代替此業務驗收；Jira留In Review/Test，指派mry88312。

遇到時段或設定不符：先停入口切換，記錄實際API/資料；不要重播migration、重送預約或回滾舊fieldops。若服務已開放且需暫停，先取得使用者對暫停範圍的批准；只停用新增renewal模板並處理LIFF入口，保留booking/attempt資料。已有自然預約後不得硬刪模板。不要自行把LIFF改回contract造成再度誤派；也不要自動回滾至當時缺資料的renewal 404狀態。

未刪除任何產品程式或業務資料。僅清理本工作Supabase CLI產生的 `supabase/.temp/cli-latest` 空間快取檔；舊worktree與使用者未追蹤檔保留。
