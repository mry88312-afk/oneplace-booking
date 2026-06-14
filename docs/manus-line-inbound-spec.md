# LINE 圖文選單查詢系統 — 完整對接說明（給 MANUS）

> 一方生活 LINE 圖文選單「自助查詢」功能。租客點選單按鈕 → MANUS 轉發 → 一方生活伺服器查資料 → 用 replyToken 免費回 Flex 卡片。

---

## A. 系統全貌

```
租客 (LINE App)
  │  ① 點圖文選單按鈕（postback，data = mh:xxx）
  ▼
LINE Platform ──② webhook 事件──▶ MANUS（LINE channel 唯一的 webhook 持有者）
                                      │  ③ 偵測 data 以「mh:」開頭 → 原樣轉發（務必含 replyToken）
                                      ▼
                           一方生活伺服器  POST /api/line/inbound
                                      │  ④ 用 source.userId(line_uid) 認租客
                                      │  ⑤ 查 Supabase / Ragic
                                      │  ⑥ 組 Flex 卡片
                                      ▼
                           LINE Reply API（用 replyToken，**免費、不耗推播額度**）
                                      │
                                      ▼
                                 租客收到卡片 ✅
```

**設計重點**
- **為什麼用 postback（不是發訊息）**：LINE 會把 message 開頭的隱形字（如 `ㅤ`）吃掉；而且 message 內容租客「自己打字」也會觸發。postback 的 `data` 打不出來、不會被裁切，只有點按鈕才送出 → 最穩、不誤觸。
- **為什麼用 reply（不是 push）**：`replyToken` 回覆**免額度**；push 會耗推播額度。
- **MANUS 仍是 webhook 唯一持有者**（LINE 一個 channel 只能設一個 webhook），所以走「轉發」而非搬移。

---

## B. MANUS 要做的事（核心，只有一條新線）

當 LINE 事件進到 MANUS 既有的 webhook 時：

1. **偵測**：`event.type === "postback"` 且 `event.postback.data` 以 `"mh:"` 開頭。
2. **轉發**：把該 event 原樣 POST 到一方生活伺服器（見下方 Endpoint）。
3. **鐵則**：這類 `mh:` 事件，**MANUS 不要自己回覆**（不要用掉 `replyToken`）→ 把 token 留給一方生活伺服器。其餘非 `mh:` 事件，MANUS **照原本邏輯**處理。
4. 對 LINE 照常回 `200 OK`（轉發是非同步的 fire-and-forget，不需等我方回應）。

### Endpoint
```
POST https://<一方生活伺服器網域>/api/line/inbound
```
> `<一方生活伺服器網域>`：到 Zeabur dashboard 看這個 booking 服務的對外 domain（例如 `https://xxxx.zeabur.app`）。

### Headers
```
Content-Type: application/json
x-inbound-secret: <OUTREACH_RUN_SECRET 的值>
```
> `x-inbound-secret` = 一方生活 `.env` 裡的 `OUTREACH_RUN_SECRET`（與既有 outbound 對接同一把）。錯誤會回 401。

### Body（保留原始 event，務必含 replyToken 與 source.userId）
```json
{
  "events": [
    {
      "type": "postback",
      "replyToken": "0f3779fba3b349968c5d07db31eab56f",
      "source": { "type": "user", "userId": "U4af4980629..." },
      "timestamp": 1700000000000,
      "postback": { "data": "mh:contract" }
    }
  ]
}
```
> 也接受單筆 `{ "event": { ... } }`；多筆請放 `events` 陣列。

### MANUS 端 pseudocode
```python
def on_line_webhook(body):
    for event in body["events"]:
        data = (event.get("postback") or {}).get("data", "")
        if event.get("type") == "postback" and data.startswith("mh:"):
            # 轉發給一方生活，MANUS 不要自己回這筆
            requests.post(
                "https://<一方生活伺服器網域>/api/line/inbound",
                headers={"Content-Type": "application/json",
                         "x-inbound-secret": OUTREACH_RUN_SECRET},
                json={"events": [event]},
                timeout=5,
            )
        else:
            handle_as_usual(event)   # MANUS 既有邏輯
    return 200
```

### MANUS 可先用 curl 自測（替換網域與 secret、放一個真實 userId）
```bash
curl -X POST "https://<一方生活伺服器網域>/api/line/inbound" \
  -H "Content-Type: application/json" \
  -H "x-inbound-secret: <OUTREACH_RUN_SECRET>" \
  -d '{"events":[{"type":"postback","postback":{"data":"mh:va"},
       "source":{"userId":"<某租客的 line_uid>"},"replyToken":"<真實replyToken>"}]}'
# 預期回應：{"ok":true,"stored":1,"handled":[{"data":"mh:va","replied":true}]}
```
> 註：`replyToken` 一次性、約 1 分鐘有效，自測時要用真實事件的 token，否則 `replied` 會是 false。

---

## C. mh: 指令對照表（目前 5 個）

| data | 對應按鈕 | 回覆內容 | 資料來源 |
|---|---|---|---|
| `mh:contract` | 合約查詢 | 所有合約：案場簡稱、房號、租期、月租金、合約編號 | Supabase `contract.*` |
| `mh:rent` | 繳租紀錄 | 近期入帳：日期、金額（近 8 筆） | **Ragic** 中信入帳表（即時） |
| `mh:va` | 繳租帳號 | 中國信託固定虛擬帳號 | Supabase `contract.tenants.virtual_account` |
| `mh:repair` | 報修進度 | 報修清單：項目、狀態（🔧處理中／✅已完成）、單號 | Supabase `service.maintenance_tickets` |
| `mh:faq` | 常見問題 | 靜態說明卡 | （內建） |

> 之後要新增查詢，只要在選單加一顆 postback 按鈕、data 用新的 `mh:xxx`，後端再加一個對應查詢即可。MANUS 端的轉發邏輯**不用改**（只認 `mh:` 前綴）。

---

## D. 一方生活伺服器收到後的行為（給你了解，MANUS 不需處理）

1. 驗 `x-inbound-secret`（constant-time 比對，錯 → 401）。
2. 寫一筆 log 到 `messaging.inbound_event`（可追溯租客點了什麼）。
3. 用 `source.userId` 在 `contract.tenants.line_uid` 找租客。
4. 依 `data` 查對應資料 → 組 Flex 卡片 → 用 `replyToken` reply。
5. **找不到租客** → 回友善訊息（請聯繫小幫手）。**查詢逾時/出錯** → 回友善訊息，不會崩潰。
6. HTTP 回應：`{ "ok": true, "stored": <筆數>, "handled": [{ "data": "mh:xxx", "replied": true|false }] }`。

---

## E. 時序與限制
- `replyToken`：**約 1 分鐘、僅能用一次** → MANUS 收到事件要**立刻**轉發（不要排隊／批次延遲）。
- 一方生活伺服器通常數秒內完成查詢並 reply。
- `mh:rent` 走 Ragic 即時查詢，視 Ragic 反應時間，極端情況可能較慢但仍在 token 有效期內。

---

## F. 安全
- `x-inbound-secret` 為共享密鑰，請只放在 MANUS 後端環境變數、勿外流。
- 建議日後輪換 `OUTREACH_RUN_SECRET` 與 `ADMIN_PASSWORD`（目前為初始值）。

---

## G. 上線順序（一方生活這邊）
1. **部署**：把 `/api/line/inbound` + 查詢引擎推上 Zeabur。
2. 取得本服務 Zeabur 對外網域 → 填進 MANUS 的轉發設定。
3. 後台「圖文選單管理」→ `menu_01`、`menu_02` 按「發布」（LINE 選單按鈕換成 postback）。
4. MANUS 加上 B 段的轉發那條線。
5. 用測試帳號點按鈕 → 收到 Flex 卡片即完成。

---

## H. 目前狀態（截至本文件）
- ✅ 後端查詢引擎（4 查詢 + 常見問題）— 已用真實租客資料驗證。
- ✅ 繳租帳號 VA 已回填 Supabase（900 位）。
- ✅ postback 機制（後端 + 產生器「查詢」按鈕型別）。
- ✅ `menu_01`/`menu_02` 已轉 postback（generator_config + 點擊區）。
- ✅ `/api/line/inbound` 路由 + reply — 本機 end-to-end 驗證通過。
- ⏳ 待：部署上 Zeabur、MANUS 加轉發、後台發布選單、測試帳號實測。
