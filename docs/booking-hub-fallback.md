# ONE-824 預約發卡切換與回復

範圍：預約確認／改期取消、圖文選單回覆、排程卡及催租的**出站**發送。LINE Developers 的入站 webhook 另由服務中台遷移時切換。轉送目標必須是同一個租客 LINE 官方帳號，且 Zeabur 保留獨立可運作的服務；若舊網址已轉址到 GCP，就不具備獨立備援。

在 GCP 正式主機 prod-vm 執行以下指令。新中台網址須由服務中台負責人確認，且應為公司 HTTPS 網域；先確認兩站使用相同 LINE 頻道、客服紀錄與 webhook 密鑰。腳本會對新舊兩站的兩個實際端點送空物件，檢查是否通過驗證且回報缺少指定欄位，不會送卡。任一未通過不改設定。

```bash
sudo /usr/local/sbin/booking-hub-route status
sudo /usr/local/sbin/booking-hub-route gcp "$VERIFIED_FIELDOPS_ORIGIN"
sudo /usr/local/sbin/booking-hub-route zeabur
```

設定由 root 原子替換 /etc/oneplace/booking-hub/route.json；不用重啟。切回只影響下一張尚未選路的卡。GCP 模式每次先用空物件檢查目標端點；逾時、故障或回應格式不符才自動走 Zeabur。真正含卡片的請求不跟隨轉址、不重試。不論 502、逾時或回執遺失都不會在另一站重送；若故障持續，人工切回 Zeabur。固定 Zeabur 模式不會把卡送往尚未切換的 GCP。

一般排程先由共享資料庫鎖定該筆，再送出；結果不明時在發送歷史查看待核對原因，對照中台聊天與 LINE 發送紀錄。不得重設鎖定、重新排同一張或盲目補發。催租沿用當日帳單唯一鍵、發送前認領和 LINE 訊息編號回執；查不到回執時即使切回也不自動補寄。切到 GCP 當天請使用指定測試帳號核對一張普通卡與客服紀錄，勿用正式催租測試。
