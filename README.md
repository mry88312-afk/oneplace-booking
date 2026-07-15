# oneplace-booking

一方生活 — 公開預約服務（從主系統 oneplace-service 拆分出來，獨立部署到 Zeabur）。

## 拆分原因

- 主系統部署在 MANUS 上不穩，公開預約頁面 (`/book/:projectId`) 對租客的可用性受影響
- 把租客直接面對的入口拆出，獨立部署在 Zeabur，減少對主系統穩定性的依賴
- 主系統繼續負責：LINE bot、客服 CRM、模板管理（BookingAdmin）、預約清單後台

## 架構

```
┌──────────────────────┐         ┌──────────────────────┐
│  主系統 (MANUS)       │  ◀──────│  Zeabur (本 repo)    │
│                      │ webhook │                      │
│  - LINE bot           │ ←──────│  - /book/:projectId   │
│  - 客服 CRM           │ 發卡片  │  - 8 個 tRPC public   │
│  - 模板管理 (admin)   │         │    procedures        │
│  - 預約清單後台        │         │                      │
└──────────┬───────────┘         └──────────┬───────────┘
           │                                │
           └─────────────┬──────────────────┘
                         ▼
                ┌──────────────────┐
                │  TiDB Cloud      │ ← 同一個 DB
                │  Ragic API       │
                │  Google Calendar │
                └──────────────────┘
```

## 8 個 tRPC public procedures

| Procedure | 用途 |
|---|---|
| `booking.getPublicTemplate` | 取得預約模版公開資訊 |
| `booking.verifyTenantUid` | 用 LINE UID 驗證租客 |
| `booking.verifyByPhone` | 用電話驗證租客 |
| `booking.registerTenantByPhone` | 新租客註冊 |
| `booking.getAvailableSlots` | 查詢單日可用時段 |
| `booking.getAvailableSlotsMultiDay` | 批量查詢多天時段 |
| `booking.resolvePresetSlot` | 解析 `?t=YYYYMMDDHHMM` 參數 |
| `booking.confirmBooking` | 確認預約 + 觸發主系統發 LINE 卡片 |

## 主系統需提供的 webhook 端點

主系統在 `oneplace-service/server/_core/index.ts` 新增了：

```
POST /api/booking/notify-line
Headers: X-Webhook-Secret: <BOOKING_WEBHOOK_SECRET>
Body: { tenantUid, bookingId, flexMessage }
```

主系統收到後會用既有的 `pushMessage("tenant", uid, [flex])` 發出 LINE 卡片，
並用 `recordSystemMessage` 記錄到聊天歷史。

## 本機開發

```bash
# 1. 複製 .env.example 為 .env，填入憑證
cp .env.example .env

# 2. 安裝依賴
npm install

# 3. 開發模式（同時跑前端 vite + 後端 tsx）
npm run dev
```

預設後端 port 3000，前端 vite dev server port 5173，會 proxy `/api` 到後端。

## 部署到 Zeabur

### 1. 設定環境變數

在 Zeabur 服務的 Variables 頁面新增：

| Key | Value |
|---|---|
| `DATABASE_URL` | TiDB Cloud 連線字串（記得帶 `?ssl=...`）|
| `RAGIC_API_KEY` | 從主系統複製 |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Service Account 的 JSON 字串 |
| `MAIN_SYSTEM_WEBHOOK_URL` | `https://fieldops.zeabur.app/api/booking/notify-line` |
| `BOOKING_WEBHOOK_SECRET` | 隨機字串（兩邊都要一樣）|
| `PORT` | `3000`（Zeabur 預設）|
| `NODE_ENV` | `production` |
| `TZ` | `UTC` |

### 2. 連 GitHub repo

Zeabur Console → New Service → Deploy from GitHub →
選擇 `oneplacetw/oneplace-booking`（你需要先 push 到 GitHub）。

### 3. 改 LINE LIFF endpoint

到 LINE Developer Console → LIFF →
編輯該 LIFF App 的 Endpoint URL，
從 `https://fieldopsdash-jmqd8ox8.manus.space/book/...` 改成
`https://your-app.zeabur.app/book/...`

**LIFF ID 不變**，所以資料庫的 `bookingTemplates.liffId` 不需要動。

## 安全提醒

- `BOOKING_WEBHOOK_SECRET` 主系統跟本服務都要設成同樣的隨機字串（建議 32+ 字元）
- 不要把 `.env` 提交到 git（已經在 `.gitignore` 排除）
- TiDB 連線字串包含密碼，部署完成後請考慮輪換
