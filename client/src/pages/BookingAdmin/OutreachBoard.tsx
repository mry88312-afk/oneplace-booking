import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { RenewalDueTab } from "./RenewalDueTab";
import { toast } from "sonner";
import {
  Loader2, Send, CalendarClock, SkipForward, Check, RotateCcw, RefreshCw, Save, AlertTriangle, Copy, Sparkles, Eye, Download,
} from "lucide-react";

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending: { label: "待確認", color: "bg-slate-100 text-slate-700" },
  confirmed: { label: "已確認", color: "bg-blue-100 text-blue-800" },
  sent: { label: "已發送", color: "bg-green-100 text-green-800" },
  skipped: { label: "已跳過", color: "bg-amber-100 text-amber-800" },
  cancelled: { label: "已取消", color: "bg-red-100 text-red-700" },
  suppressed: { label: "已抑制", color: "bg-purple-100 text-purple-800" },
};

const TEMPLATE_VARS = ["{{tenant_name}}", "{{property_name}}", "{{room}}", "{{contract_end_date}}", "{{days_until_expiry}}"];

// 投遞 API 串接說明（給 Ragic 等外部系統；放在 篩選/設定 分頁可複製）
const ENQUEUE_PROMPT = `【一方生活｜統一發訊中樞——投遞 API 串接說明】

任何系統要發訊息給室友（純文字或圖文卡片），請改打這支 API：訊息會進排程、看板可控管（可跳過/取消）、時間到自動發送。

端點：POST https://oneplace-booking.zeabur.app/api/outreach/enqueue
Header：
  Content-Type: application/json
  x-outreach-secret: <共享密鑰，向管理者索取>

Body 欄位：
  dedupeKey  必填。去重碼：同一個 dedupeKey 只會排一次（重送安全）。建議格式 來源:用途:對象:日期
  text       純文字捷徑（最簡單）。要發「一般文字訊息」就帶這個字串，例 "您好，您的 6 月帳單已產生"
  card       要發「圖文卡片」才用。整張 LINE 卡片 JSON（type:bubble，會自動包成 flex）。text 與 card 擇一必填
  altText    選填。卡片的通知列文字（純文字訊息不需要）
  to         必填。{ "uid": "Uxxxx" } 或 { "phone": "0912345678" } 擇一；只給電話時發送前會自動查 LINE UID，查無會留在失敗清單、補綁後可重送
  immediate  選填。true = 立即發送：不等排程、打進來當下就發，回應會直接帶 sent/failed 結果。帶 immediate 時 sendAt 可省略
  sendAt     immediate 未帶時必填。發送時間（ISO 8601 含時區），例 "2026-06-15T10:00:00+08:00"；系統每 5 分鐘檢查、到點即送
  tag        必填。分類標籤（看板篩選用），例 "帳務通知"

範例 A — 純文字（最常用、最簡單，只要帶 text）：
curl -X POST https://oneplace-booking.zeabur.app/api/outreach/enqueue \\
  -H "Content-Type: application/json" \\
  -H "x-outreach-secret: <密鑰>" \\
  -d '{
    "dedupeKey": "ragic:billing:0912345678:2026-06-15",
    "tag": "帳務通知",
    "to": { "phone": "0912345678" },
    "immediate": true,
    "text": "您好，您的 6 月帳單已產生，請於 6/15 前繳款，謝謝。"
  }'

範例 B — 圖文卡片（要排版/按鈕才用 card；會長成方框卡片）：
curl -X POST https://oneplace-booking.zeabur.app/api/outreach/enqueue \\
  -H "Content-Type: application/json" \\
  -H "x-outreach-secret: <密鑰>" \\
  -d '{
    "dedupeKey": "ragic:billing:0912345678:2026-06-15",
    "tag": "帳務通知",
    "sendAt": "2026-06-15T10:00:00+08:00",
    "to": { "phone": "0912345678" },
    "altText": "一方生活｜帳務通知",
    "card": { "type": "bubble", "size": "mega", "body": { "type": "box", "layout": "vertical", "paddingAll": "20px", "contents": [ { "type": "text", "text": "您好，您的 6 月帳單已產生", "wrap": true } ] } }
  }'

回應：200 {"ok":true,"id":"…","deduped":false}；同碼重打 → deduped:true（不重複排）；401 密鑰錯；400 缺欄位（訊息指明缺哪欄）。
注意：後台「測試模式」開啟時，所有發送都會改寄到測試 LINE、不會送給室友——串接驗證請先在測試模式下做。`;

const SOURCE_MAP: Record<string, { label: string; color: string }> = {
  rule: { label: "規則", color: "bg-slate-100 text-slate-600" },
  booking: { label: "退租提醒", color: "bg-teal-100 text-teal-800" },
  api: { label: "外部API", color: "bg-indigo-100 text-indigo-800" },
};

// 給 AI 用的「卡片產生 Prompt」：使用者複製 → 貼到 ChatGPT/Claude → 描述需求 → 產出可貼進規則的 Flex JSON。
const CARD_PROMPT = `你是「一方生活」週期詢問 LINE 卡片設計助手。請依我接下來的需求，產出「一個合法的 LINE Flex Message bubble JSON」（單一 bubble 物件即可，系統會自動包成 flex message 並處理 altText）。

【輸出規則】
- 只輸出一個 JSON 物件（type 為 "bubble"，可含 hero / body / footer）。不要加註解、不要 markdown 標記、不要任何多餘文字。
- 必須是合法 JSON（能被 JSON.parse 解析）。
- 需要每位室友不同的內容，請用下列「變數」以 {{變數名}} 形式寫入，系統發送時會自動替換成真實值：
  - {{tenant_name}}      室友姓名
  - {{property_name}}    入住案場簡稱
  - {{room}}             房號 / 單位
  - {{contract_end_date}} 合約到期日（YYYY/MM/DD）
  - {{days_until_expiry}} 距離到期天數（整數）
  入住問候通常用 {{tenant_name}}、{{property_name}}；到期提醒用 {{contract_end_date}}、{{days_until_expiry}}。

【品牌視覺風格（請沿用）】
- bubble size: "mega"
- 顏色：主按鈕紫 #534AB7；續約綠 #0F6E56；提醒橘 #C8843C；急迫紅 #993C1D
- 標題 weight:"bold" size:"md" color:"#222222"；副標 size:"sm" color:"#888888"
- 分隔線 separator color:"#EEEEEE"
- 重點提示框：box backgroundColor:"#FAEEDA" cornerRadius:"8px" paddingAll:"10px"，內文字 color:"#633806" size:"xs"
- 條列：baseline box ＋ emoji(flex:0) ＋ 文字(wrap:true,color:"#333333",size:"sm")
- body paddingAll:"20px" layout:"vertical" spacing:"md"
- footer 按鈕 height:"sm"；主要動作 primary(#534AB7)、次要 secondary
- 按鈕 action 可用：
  - 開連結/LIFF：{"type":"uri","label":"...","uri":"https://..."}
  - 送出訊息（點了由室友送出一句話，小幫手會在官方帳號收到）：{"type":"message","label":"...","text":"..."}

【風格範例（供參考，結構照這個走）】
{"type":"bubble","size":"mega","body":{"type":"box","layout":"vertical","spacing":"md","paddingAll":"20px","contents":[{"type":"text","text":"住得還習慣嗎？😊","weight":"bold","size":"md","color":"#222222","wrap":true},{"type":"text","text":"{{tenant_name}} 您好，您入住 {{property_name}} 已經兩週囉～","size":"sm","color":"#888888","wrap":true,"margin":"xs"},{"type":"separator","margin":"md","color":"#EEEEEE"},{"type":"box","layout":"vertical","backgroundColor":"#FAEEDA","cornerRadius":"8px","paddingAll":"10px","margin":"md","contents":[{"type":"text","text":"🔔 點下方按鈕讓我們知道你的近況。","size":"xs","color":"#633806","wrap":true}]}]},"footer":{"type":"box","layout":"vertical","spacing":"sm","paddingAll":"16px","contents":[{"type":"button","style":"primary","color":"#534AB7","height":"sm","action":{"type":"message","label":"我住得很習慣，謝謝","text":"我住得很習慣，謝謝 😊"}}]},"styles":{"footer":{"separator":false}}}

【我的需求】
（在這裡描述：卡片主題、文案重點、要哪些按鈕、按鈕連到哪…）`;

// 給未來 AI 的「新增規則」說明：使用者複製 → 貼給 AI → AI 依此規格新增規則 + 可編輯卡片。
const RULE_ADD_PROMPT = `你是「一方生活」週期詢問系統的工程助手。我要新增一條週期詢問規則（例如到期前 40 天、入住後 30 天…）。請依下列規格做：

【規則存在哪】
Supabase 專案 dwoahbduwzfzqmwpvadj 的 outreach.rule 表，每條規則欄位：
- key：代號，唯一。請用「基準+天數」自動命名 —— 到期日基準 → expiry_d{天數}（到期前 N 天）；開始日基準 → onboarding_d{天數}（入住後 N 天）。例：到期前 40 天 = expiry_d40；入住後 30 天 = onboarding_d30。不可與現有重複。
- label：給人看的名稱（例「續約提醒 −40」）。
- trigger_basis：contract_start（合約開始日）或 contract_end（合約到期日）。
- offset_days：整數。開始日基準用正數（入住 +N）；到期日基準用負數（到期 −N，例 −40）。
- enabled：true。
- auto_confirm：預設 false（要免人工確認自動發才設 true）。
- card_template：jsonb，一個 LINE Flex bubble（用本頁「卡片產生 Prompt」產生）。
- sort_order：整數排序。

【排程引擎】
outreach.recompute_schedule() 會自動掃過所有 enabled 規則產生排程，新增規則「不必改引擎」。新增後到後台「排程看板」按「重算排程」即生效（既有排程不會被覆蓋）。outreach.schedule.rule_key 無限制，可用任意新 key。

【互動回饋按鈕（選用）】
若卡片要「住得很舒服 / 請小幫手協助」回饋按鈕，footer 放兩顆 uri 按鈕：
- 住得很舒服：uri 為 https://oneplace-booking.zeabur.app/f/{{schedule_id}}?r=ok
- 請小幫手協助：uri 為 https://oneplace-booking.zeabur.app/f/{{schedule_id}}?r=help
{{schedule_id}} 系統發送時會自動代入；回饋會寫進 Ragic「回饋單」並依設定通知，且同一張卡只認第一次點擊。

【篩選（重要）】
目前篩選是「全域」：outreach.settings 的 include_ownership_regions（案件歸屬）與 exclude_hq_categories（總公司內分類），套用到所有規則。
※「每條規則各自不同篩選」尚未實作。若要這個，需把篩選搬到 outreach.rule（每條一份、留空沿用全域）並改 recompute_schedule() —— 屬要另外做的功能，請先跟我確認再動。

【新增/刪除規則的後台按鈕】
目前後台只能「編輯」既有規則，沒有新增/刪除按鈕（之後要做）。在做出來之前，新增規則請直接在 outreach.rule 插一列。

【我的需求】
（在這裡描述：到期前幾天 / 入住後幾天、規則名稱、卡片文案重點、要不要回饋按鈕、要不要自動確認、篩選有沒有要跟別人不一樣…）`;

// ── 排程看板 ──────────────────────────────────────────────────────────────────
function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function computeRange(preset: string, cFrom: string, cTo: string): { from?: string; to?: string } {
  const today = new Date();
  const t = ymd(today);
  if (preset === "today") { return { from: t, to: t }; }
  if (preset === "overdue") { const y = new Date(today); y.setDate(today.getDate() - 1); return { to: ymd(y) }; }
  if (preset === "week") { const s = new Date(today); s.setDate(today.getDate() + ((7 - today.getDay()) % 7)); return { from: t, to: ymd(s) }; }
  if (preset === "month") { return { from: t, to: ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0)) }; }
  if (preset === "next30") { const s = new Date(today); s.setDate(today.getDate() + 30); return { from: t, to: ymd(s) }; }
  if (preset === "future") { return { from: t }; }
  if (preset === "custom") { return { from: cFrom || undefined, to: cTo || undefined }; }
  return {};
}

/** 把目前清單匯出成 CSV（UTF-8 BOM，Excel 開啟中文正常）。 */
function exportCsv(rows: any[], filename: string) {
  const cols = ["scheduled_date", "tenant_name", "room", "property_name", "rule_key", "status", "sent_at", "attempt_count", "last_error"];
  const header = ["排定日", "姓名", "房號", "案場", "卡別", "狀態", "發送時間", "嘗試次數", "最後錯誤"];
  const esc = (v: any) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + header.join(",") + "\r\n" + body], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 批次操作結果摘要：成功 N、失敗 M（附第一筆錯誤）。 */
function summarizeBatch(results: { ok: boolean; error?: string }[], label: string) {
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  if (fail === 0) toast.success(`${label}：成功 ${ok} 筆`);
  else toast.warning(`${label}：成功 ${ok}、失敗 ${fail}（例：${results.find((r) => !r.ok)?.error || ""}）`);
}

function ScheduleTab({ rules }: { rules: any[] }) {
  // 卡別選項與名稱直接跟著規則表走（改名/加規則自動反映，不再寫死）
  const ruleLabels: Record<string, string> = Object.fromEntries(rules.map((r: any) => [r.key, r.label || r.key]));
  const ruleOptions = [{ key: "all", label: "全部卡別" }, ...rules.map((r: any) => ({ key: r.key, label: r.label || r.key }))];
  const [view, setView] = useState<"upcoming" | "history" | "failed">("upcoming");
  const [preset, setPreset] = useState<string>("week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [ruleFilter, setRuleFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [historyStatus, setHistoryStatus] = useState<string>("sent");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [groupByProp, setGroupByProp] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const range = view === "upcoming" ? computeRange(preset, customFrom, customTo) : {};
  const listInput: any = {
    ruleKey: ruleFilter === "all" ? undefined : ruleFilter,
    source: sourceFilter === "all" ? undefined : sourceFilter,
    tag: tagFilter === "all" ? undefined : tagFilter,
    search: search || undefined,
    ...range,
  };
  if (view === "upcoming") listInput.statuses = ["pending", "confirmed"];
  else if (view === "history") listInput.status = historyStatus;
  else listInput.onlyFailed = true;

  const scheduleQuery = trpc.outreach.listSchedule.useQuery(listInput, { refetchOnWindowFocus: false });
  const summaryQuery = trpc.outreach.scheduleSummary.useQuery(view === "upcoming" ? range : {}, { refetchOnWindowFocus: false });
  const utils = trpc.useUtils();
  const invalidate = () => { utils.outreach.listSchedule.invalidate(); utils.outreach.scheduleSummary.invalidate(); };

  const updateItem = trpc.outreach.updateScheduleItem.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const sendNow = trpc.outreach.sendNow.useMutation({
    onSuccess: (r: any) => {
      if (r.failed > 0 && r.errors?.length) toast.error(`發送失敗：${r.errors[0].error}`);
      else if (r.suppressed > 0) toast.info("已抑制（該室友已預約續約/退租），未發送");
      else toast.success(`發送完成：sent ${r.sent}・suppressed ${r.suppressed}・failed ${r.failed}・skipped ${r.skipped}`);
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const recompute = trpc.outreach.recomputeNow.useMutation({
    onSuccess: (r) => { toast.success(`已重算排程，新增 ${r.inserted} 筆`); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const batchUpdate = trpc.outreach.updateScheduleItemsBatch.useMutation({
    onSuccess: (res: any) => { summarizeBatch(res.results, "批次處理"); setSelected(new Set()); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const batchSend = trpc.outreach.sendNowBatch.useMutation({
    onSuccess: (res: any) => { summarizeBatch(res.results, "批次立即送"); setSelected(new Set()); invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const preview = trpc.outreach.previewScheduleItem.useMutation({
    onSuccess: (r: any) => toast.success(`已送至測試對象 ${String(r.redirectedTo || "").slice(0, 10)}…（室友不會收到）`),
    onError: (e) => toast.error(e.message),
  });

  useEffect(() => { setSelected(new Set()); }, [view, preset, ruleFilter, sourceFilter, tagFilter, historyStatus, search, customFrom, customTo]);

  const [rescheduleRow, setRescheduleRow] = useState<{ id: string; date: string; time: string } | null>(null);
  const rows = scheduleQuery.data || [];

  const summary = (summaryQuery.data || []) as any[];
  const ruleCount = (rk: string) =>
    summary.filter((s) => s.rule_key === rk && (s.status === "pending" || s.status === "confirmed")).reduce((a, s) => a + s.n, 0);
  const totalCount = rules.reduce((a: number, r: any) => a + ruleCount(r.key), 0);

  const batchBusy = batchUpdate.isPending || batchSend.isPending;
  const allVisibleSelected = rows.length > 0 && rows.every((r: any) => selected.has(r.id));
  const toggleAll = () => setSelected(allVisibleSelected ? new Set() : new Set(rows.map((r: any) => r.id)));
  const toggleOne = (id: string) =>
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const rowCard = (r: any) => {
    const st = STATUS_MAP[r.status] || { label: r.status, color: "bg-muted text-muted-foreground" };
    const canSend = r.status === "pending" || r.status === "confirmed";
    return (
      <Card key={r.id}>
        <CardContent className="py-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-2 flex-1 min-w-0">
              <Checkbox className="mt-1" checked={selected.has(r.id)} onCheckedChange={() => toggleOne(r.id)} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-mono text-sm font-semibold">{r.scheduled_date}</span>
                  {r.send_at && <span className="font-mono text-xs text-muted-foreground">{String(r.send_at).slice(11)} 發</span>}
                  <Badge variant="outline">{r.rule_key ? (ruleLabels[r.rule_key] || r.rule_key) : "自訂卡片"}</Badge>
                  {r.source && r.source !== "rule" && (
                    <span className={`text-xs px-2 py-0.5 rounded-full ${(SOURCE_MAP[r.source] || SOURCE_MAP.rule).color}`}>
                      {(SOURCE_MAP[r.source] || SOURCE_MAP.rule).label}
                    </span>
                  )}
                  {r.tag && <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">#{r.tag}</span>}
                  <span className={`text-xs px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>
                  {r.status === "sent" && r.sent_at && <span className="text-[10px] text-muted-foreground">發送於 {String(r.sent_at).replace("T", " ").slice(0, 16)}</span>}
                  {r.manually_edited && <span className="text-[10px] text-muted-foreground">（已手動調整）</span>}
                </div>
                <div className="text-sm text-muted-foreground truncate">
                  {r.tenant_name || "（無姓名）"}
                  {r.room ? `・${r.room}` : ""}
                  {r.property_name ? `・${r.property_name}` : ""}
                  {r.contract_no ? `・${r.contract_no}` : ""}
                  {r.contract_end_date ? `・到期 ${r.contract_end_date}` : ""}
                </div>
                {r.suppressed_reason && <div className="text-xs text-purple-700 mt-1">{r.suppressed_reason}</div>}
                {r.last_error && (
                  <div className="text-xs text-red-600 mt-1">
                    ⚠ 第 {r.attempt_count} 次嘗試失敗：{r.last_error}{r.last_attempt_at ? `（${r.last_attempt_at}）` : ""}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap justify-end">
              <Button size="sm" variant="ghost" onClick={() => preview.mutate({ id: r.id })} disabled={preview.isPending} title="送到測試對象預覽，室友不會收到">
                <Eye className="h-3.5 w-3.5 mr-1" /> 預覽
              </Button>
              {r.status === "pending" && (
                <Button size="sm" variant="outline" onClick={() => updateItem.mutate({ id: r.id, action: "confirm" })}>
                  <Check className="h-3.5 w-3.5 mr-1" /> 確認
                </Button>
              )}
              {r.status === "confirmed" && (
                <Button size="sm" variant="outline" onClick={() => updateItem.mutate({ id: r.id, action: "unconfirm" })}>取消確認</Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setRescheduleRow({ id: r.id, date: r.scheduled_date, time: r.send_at ? String(r.send_at).slice(11, 16) : "09:00" })}>
                <CalendarClock className="h-3.5 w-3.5 mr-1" /> 改期
              </Button>
              {(r.status === "pending" || r.status === "confirmed") && (
                <Button size="sm" variant="ghost" onClick={() => updateItem.mutate({ id: r.id, action: "skip" })}>
                  <SkipForward className="h-3.5 w-3.5 mr-1" /> 跳過
                </Button>
              )}
              {(canSend || view === "failed") && (
                <Button size="sm" onClick={() => sendNow.mutate({ id: r.id })} disabled={sendNow.isPending}>
                  {sendNow.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                  {view === "failed" ? "重送" : "立即送"}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  const groups = groupByProp
    ? (() => {
        const m = new Map<string, any[]>();
        for (const r of rows as any[]) { const k = r.property_name || "（無案場）"; if (!m.has(k)) m.set(k, []); m.get(k)!.push(r); }
        return [...m.entries()].map(([name, items]) => ({ name, items })).sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
      })()
    : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex rounded-md border overflow-hidden">
          <button type="button" className={`px-3 py-1.5 text-sm ${view === "upcoming" ? "bg-primary text-primary-foreground" : "bg-background"}`} onClick={() => setView("upcoming")}>未來要發</button>
          <button type="button" className={`px-3 py-1.5 text-sm ${view === "history" ? "bg-primary text-primary-foreground" : "bg-background"}`} onClick={() => setView("history")}>歷史紀錄</button>
          <button type="button" className={`px-3 py-1.5 text-sm ${view === "failed" ? "bg-primary text-primary-foreground" : "bg-background"}`} onClick={() => setView("failed")}>失敗清單</button>
        </div>
        {view === "upcoming" && (
          <Select value={preset} onValueChange={setPreset}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="today">今天</SelectItem>
              <SelectItem value="week">本週</SelectItem>
              <SelectItem value="month">本月</SelectItem>
              <SelectItem value="next30">未來 30 天</SelectItem>
              <SelectItem value="future">全部未來</SelectItem>
              <SelectItem value="custom">自訂區間</SelectItem>
              <SelectItem value="overdue">逾期未發</SelectItem>
            </SelectContent>
          </Select>
        )}
        {view === "history" && (
          <Select value={historyStatus} onValueChange={setHistoryStatus}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sent">已發送</SelectItem>
              <SelectItem value="suppressed">已抑制</SelectItem>
              <SelectItem value="skipped">已跳過</SelectItem>
              <SelectItem value="cancelled">已取消</SelectItem>
            </SelectContent>
          </Select>
        )}
        {view === "upcoming" && preset === "custom" && (
          <>
            <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="w-36" />
            <span className="text-muted-foreground text-sm">~</span>
            <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="w-36" />
          </>
        )}
        <Select value={ruleFilter} onValueChange={setRuleFilter}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ruleOptions.map((o) => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部來源</SelectItem>
            <SelectItem value="rule">合約規則</SelectItem>
            <SelectItem value="booking">退租提醒</SelectItem>
            <SelectItem value="api">外部API</SelectItem>
          </SelectContent>
        </Select>
        {(tagFilter !== "all" || rows.some((r: any) => r.tag)) && (
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部標籤</SelectItem>
              {[...new Set([...(tagFilter !== "all" ? [tagFilter] : []), ...rows.map((r: any) => r.tag).filter(Boolean)])].map((t: any) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="flex items-center gap-1">
          <Input value={searchInput} onChange={(e) => setSearchInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") setSearch(searchInput); }} placeholder="搜尋姓名/房號/案場" className="w-44" autoComplete="off" />
          <Button variant="outline" size="sm" onClick={() => setSearch(searchInput)}>搜尋</Button>
        </div>
        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <Checkbox checked={groupByProp} onCheckedChange={(v) => setGroupByProp(!!v)} /> 依案場分組
        </label>
        <Button variant="outline" size="sm" onClick={() => { scheduleQuery.refetch(); summaryQuery.refetch(); }}><RefreshCw className="h-3.5 w-3.5 mr-1" /> 重新整理</Button>
        <Button variant="outline" size="sm" onClick={() => exportCsv(rows, `outreach_${view}_${ymd(new Date())}.csv`)} disabled={!rows.length}><Download className="h-3.5 w-3.5 mr-1" /> 匯出 CSV</Button>
        <Button variant="outline" size="sm" onClick={() => recompute.mutate()} disabled={recompute.isPending}>
          {recompute.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1" />} 重算排程
        </Button>
      </div>

      {view === "upcoming" ? (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="font-semibold">此區間待發 {totalCount} 筆：</span>
          {rules.map((r: any) => (
            <span key={r.key} className="px-2 py-0.5 rounded-full bg-muted">{r.label || r.key} {ruleCount(r.key)}</span>
          ))}
          <span className="text-muted-foreground ml-auto">顯示 {rows.length} 筆</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">顯示 {rows.length} 筆{rows.length >= 1000 ? "（已達上限，請用搜尋或日期縮小範圍）" : ""}</div>
      )}

      {rows.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap rounded-md border bg-muted/40 px-3 py-2">
          <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
            <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAll} /> 全選
          </label>
          <span className="text-sm text-muted-foreground">已選 {selected.size} 筆</span>
          <div className="flex items-center gap-1.5 ml-auto">
            <Button size="sm" variant="outline" disabled={!selected.size || batchBusy} onClick={() => batchUpdate.mutate({ ids: [...selected], action: "confirm" })}>
              <Check className="h-3.5 w-3.5 mr-1" /> 確認所選
            </Button>
            <Button size="sm" variant="ghost" disabled={!selected.size || batchBusy} onClick={() => batchUpdate.mutate({ ids: [...selected], action: "skip" })}>
              <SkipForward className="h-3.5 w-3.5 mr-1" /> 跳過所選
            </Button>
            <Button size="sm" disabled={!selected.size || batchBusy} onClick={() => batchSend.mutate({ ids: [...selected] })}>
              {batchSend.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />} 立即送所選
            </Button>
            {selected.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>清除</Button>}
          </div>
        </div>
      )}

      {scheduleQuery.isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> 載入中...
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">{view === "failed" ? "沒有發送失敗的排程 🎉" : "沒有符合條件的排程"}</div>
      ) : groups ? (
        <div className="space-y-4">
          {groups.map((g) => (
            <div key={g.name} className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span>{g.name}</span>
                <Badge variant="secondary">{g.items.length} 筆</Badge>
              </div>
              <div className="space-y-2">{g.items.map(rowCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">{rows.map(rowCard)}</div>
      )}

      {/* 改期 Dialog */}
      <Dialog open={!!rescheduleRow} onOpenChange={(v) => { if (!v) setRescheduleRow(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>改期</DialogTitle>
            <DialogDescription>調整這筆排程的發送日期與時刻（會標記為手動調整，重算不會覆蓋）。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">發送日期</Label>
              <Input type="date" className="mt-1" value={rescheduleRow?.date || ""} onChange={(e) => setRescheduleRow((p) => (p ? { ...p, date: e.target.value } : p))} />
            </div>
            <div>
              <Label className="text-xs">發送時刻</Label>
              <Input type="time" className="mt-1" value={rescheduleRow?.time || "09:00"} onChange={(e) => setRescheduleRow((p) => (p ? { ...p, time: e.target.value } : p))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRescheduleRow(null)}>取消</Button>
            <Button
              onClick={() => {
                if (!rescheduleRow?.date) { toast.error("請選擇日期"); return; }
                updateItem.mutate(
                  { id: rescheduleRow.id, action: "reschedule", scheduledDate: rescheduleRow.date, scheduledTime: rescheduleRow.time || "09:00" },
                  { onSuccess: () => { toast.success("已改期"); setRescheduleRow(null); } },
                );
              }}
            >
              儲存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── 單一規則編輯卡 ─────────────────────────────────────────────────────────────
function RuleEditorCard({ rule, onSaved }: { rule: any; onSaved: () => void }) {
  const [label, setLabel] = useState(rule.label ?? "");
  const [offsetDays, setOffsetDays] = useState<number>(rule.offset_days ?? 0);
  const [enabled, setEnabled] = useState<boolean>(!!rule.enabled);
  const [autoConfirm, setAutoConfirm] = useState<boolean>(!!rule.auto_confirm);
  const [sendTime, setSendTime] = useState<string>(rule.send_time || "09:00");
  const [templateText, setTemplateText] = useState(JSON.stringify(rule.card_template, null, 2));

  useEffect(() => {
    setLabel(rule.label ?? "");
    setOffsetDays(rule.offset_days ?? 0);
    setEnabled(!!rule.enabled);
    setAutoConfirm(!!rule.auto_confirm);
    setSendTime(rule.send_time || "09:00");
    setTemplateText(JSON.stringify(rule.card_template, null, 2));
  }, [rule]);

  const updateRule = trpc.outreach.updateRule.useMutation({
    onSuccess: (r: any) => {
      toast.success(
        r?.confirmedNow
          ? `已儲存規則：${rule.key}，並將 ${r.confirmedNow} 筆未來待確認排程轉為已確認`
          : `已儲存規則：${rule.key}`,
      );
      onSaved();
    },
    onError: (e) => toast.error(e.message),
  });

  const save = () => {
    let parsed: any;
    try {
      parsed = JSON.parse(templateText);
    } catch {
      toast.error("卡片 JSON 格式錯誤，請檢查");
      return;
    }
    updateRule.mutate({ key: rule.key, label, offsetDays, enabled, autoConfirm, sendTime, cardTemplate: parsed });
  };

  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <code className="text-xs bg-muted px-2 py-0.5 rounded">{rule.key}</code>
            <Badge variant="outline">
              {rule.trigger_basis === "contract_start" ? "合約開始日" : rule.trigger_basis === "booking_checkout" ? "退租預約" : "合約到期日"}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-xs">啟用</Label>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">名稱</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs">天數偏移（offset_days）</Label>
            <Input
              type="number"
              value={offsetDays}
              onChange={(e) => setOffsetDays(Number(e.target.value))}
              className="mt-1"
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              正數=基準日之後（入住+N）；負數=基準日之前（到期−N）
            </p>
          </div>
        </div>
        <div>
          <Label className="text-xs">發送時刻（每天幾點送）</Label>
          <Input type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} className="mt-1 w-36" />
          <p className="text-[11px] text-muted-foreground mt-1">此規則的卡片會在排定日的這個時刻發送（系統每 5 分鐘檢查一次；改了記得「重算排程」對新排程生效）。</p>
        </div>
        <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 bg-muted/30">
          <div className="min-w-0">
            <Label className="text-xs font-semibold">自動確認（auto_confirm）</Label>
            <p className="text-[11px] text-muted-foreground">開啟後，此規則新產生的排程會直接設為「已確認」、到期自動派送，<b>免人工確認</b>（仍受測試模式與發送前防重保護）。儲存時也會把此規則現有「未來待確認」的排程一併轉為已確認；<b>已逾期的不會自動補發</b>（用排程看板的「逾期未發」檢視處理）。</p>
          </div>
          <Switch checked={autoConfirm} onCheckedChange={setAutoConfirm} />
        </div>
        {autoConfirm && (
          <div className="flex items-start gap-1.5 text-[11px] text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> 此規則將免人工確認自動發送，請先確認卡片內容無誤、並在測試模式下驗證過。
          </div>
        )}
        <div>
          <Label className="text-xs">卡片 JSON（LINE Flex message 物件）</Label>
          <Textarea
            value={templateText}
            onChange={(e) => setTemplateText(e.target.value)}
            className="mt-1 font-mono text-xs min-h-[200px]"
            spellCheck={false}
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            可用變數：{TEMPLATE_VARS.join("　")}
          </p>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={updateRule.isPending}>
            {updateRule.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            儲存規則
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ── 複製用 Prompt 卡（卡片產生 / 新增規則） ─────────────────────────────────────
function PromptCard({ title, desc, text }: { title: string; desc: string; text: string }) {
  const copy = () => {
    navigator.clipboard.writeText(text).then(
      () => toast.success("Prompt 已複製，貼到 ChatGPT / Claude 即可"),
      () => toast.error("複製失敗，請手動選取全部"),
    );
  };
  return (
    <Card className="bg-muted/40 border-dashed">
      <CardContent className="py-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-primary" /> {title}
          </div>
          <Button size="sm" variant="outline" onClick={copy}><Copy className="h-3.5 w-3.5 mr-1" /> 複製 Prompt</Button>
        </div>
        <p className="text-xs text-muted-foreground">{desc}</p>
        <Textarea readOnly value={text} className="font-mono text-[11px] min-h-[140px]" onFocus={(e) => e.currentTarget.select()} />
      </CardContent>
    </Card>
  );
}

// ── 目前設定總覽（讓同事一眼看懂：每條規則的篩選 + 用哪張卡） ───────────────────
function RulesOverview({ rules }: { rules: any[] }) {
  const settingsQuery = trpc.outreach.getSettings.useQuery(undefined, { refetchOnWindowFocus: false });
  const s: any = settingsQuery.data;
  const inc = (s?.include_ownership_regions || []).join("、") || "—";
  const exc = (s?.exclude_hq_categories || []).join("、") || "—";
  const cardTitle = (r: any) => r?.card_template?.body?.contents?.[0]?.text || "（已設定卡片）";
  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        <div className="text-sm font-semibold">📋 目前設定總覽</div>
        <div className="text-xs text-muted-foreground">
          全域篩選（套用到所有規則）：案件歸屬 ∈ <b>{inc}</b>；總公司內分類 排除 <b>{exc}</b>。
          <span className="block mt-0.5">（「每條規則各自不同篩選」是之後要做的功能；目前所有規則都用這組全域篩選。）</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1 pr-3">名稱</th>
                <th className="py-1 pr-3">基準</th>
                <th className="py-1 pr-3">天數</th>
                <th className="py-1 pr-3">時刻</th>
                <th className="py-1 pr-3">卡片</th>
                <th className="py-1 pr-3">篩選</th>
                <th className="py-1 pr-3">狀態</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r: any) => (
                <tr key={r.key} className="border-b last:border-0 align-top">
                  <td className="py-1.5 pr-3 font-medium">
                    {r.label}
                    <div className="text-[10px] text-muted-foreground font-mono">{r.key}</div>
                  </td>
                  <td className="py-1.5 pr-3">{r.trigger_basis === "contract_start" ? "開始日" : r.trigger_basis === "booking_checkout" ? "退租預約" : "到期日"}</td>
                  <td className="py-1.5 pr-3">{r.offset_days > 0 ? `+${r.offset_days}` : r.offset_days}</td>
                  <td className="py-1.5 pr-3 font-mono">{r.send_time || "—"}</td>
                  <td className="py-1.5 pr-3 max-w-[180px] truncate">{cardTitle(r)}</td>
                  <td className="py-1.5 pr-3">全域</td>
                  <td className="py-1.5 pr-3">
                    {r.enabled ? "啟用" : "停用"}
                    {r.auto_confirm ? "・自動確認" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// ── 規則 Tab ───────────────────────────────────────────────────────────────────
function RulesTab() {
  const rulesQuery = trpc.outreach.listRules.useQuery(undefined, { refetchOnWindowFocus: false });
  const rules = rulesQuery.data || [];
  if (rulesQuery.isLoading) {
    return <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mr-2" /> 載入中...</div>;
  }
  return (
    <div className="space-y-3">
      <RulesOverview rules={rules} />
      <PromptCard
        title="卡片產生 Prompt（給 AI 用）"
        desc="複製這段 → 貼到 ChatGPT / Claude → 描述你要的卡片 → 把它產出的 Flex JSON 貼進下方規則的「卡片 JSON」（或「測試發送」預覽）即可。"
        text={CARD_PROMPT}
      />
      <PromptCard
        title="新增規則 Prompt（給 AI 用）"
        desc="未來想新增規則（例如到期前 40 天、入住後 30 天）時，複製這段給 AI，它就知道完整規格怎麼幫你加規則 + 卡片。"
        text={RULE_ADD_PROMPT}
      />
      <p className="text-xs text-muted-foreground">
        改了天數或卡片後，記得到「排程看板」按「重算排程」讓新設定生效（既有排程不會被覆蓋）。
      </p>
      {rules.map((r: any) => (
        <RuleEditorCard key={r.key} rule={r} onSaved={() => rulesQuery.refetch()} />
      ))}
    </div>
  );
}

// ── 設定 Tab ───────────────────────────────────────────────────────────────────
function SettingsTab() {
  const settingsQuery = trpc.outreach.getSettings.useQuery(undefined, { refetchOnWindowFocus: false });
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [runUrl, setRunUrl] = useState("");
  const [runSecret, setRunSecret] = useState("");
  const [secretSet, setSecretSet] = useState(false);
  const [testRedirect, setTestRedirect] = useState("");
  const [notifyUids, setNotifyUids] = useState("");
  const [surveyTitle, setSurveyTitle] = useState("");
  const [surveyItems, setSurveyItems] = useState("");
  const [surveyNote, setSurveyNote] = useState("");

  useEffect(() => {
    const d: any = settingsQuery.data;
    if (!d) return;
    setInclude((d.include_ownership_regions || []).join(", "));
    setExclude((d.exclude_hq_categories || []).join(", "));
    setRunUrl(d.run_endpoint_url || "");
    setSecretSet(!!d.run_secret_set);
    setTestRedirect(d.test_redirect_uid || "");
    setNotifyUids(d.notify_uids || "");
    const fs = d.feedback_survey || {};
    setSurveyTitle(fs.title || "");
    setSurveyItems((fs.items || []).join("\n"));
    setSurveyNote(fs.note_label || "");
  }, [settingsQuery.data]);

  const update = trpc.outreach.updateSettings.useMutation({
    onSuccess: () => { toast.success("設定已儲存"); setRunSecret(""); settingsQuery.refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const parseList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  const saveFeedback = () => {
    const items = surveyItems.split("\n").map((x) => x.trim()).filter(Boolean);
    update.mutate({
      notifyUids,
      feedbackSurvey: { title: surveyTitle.trim(), items, note_label: surveyNote.trim() },
    });
  };

  return (
    <div className="space-y-4 max-w-xl">
      <Card className={settingsQuery.data?.test_redirect_uid ? "border-amber-400 bg-amber-50" : "border-dashed"}>
        <CardContent className="py-4 space-y-2">
          <Label className="text-sm font-semibold">🧪 測試模式（重導發送）</Label>
          <p className="text-xs text-muted-foreground">
            填入一個 LINE uid 後，<b>所有發送（立即送＋每日自動派送）都會改寄到這個 uid、永遠不會送給真實室友</b>，
            且不改動原排程狀態（可重複測）。測試完請按「關閉」，才會開始對真實室友發送。
          </p>
          <Input value={testRedirect} onChange={(e) => setTestRedirect(e.target.value)} className="mt-1" placeholder="Uxxxxxxxx...（留空＝關閉）" autoComplete="off" />
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="outline" onClick={() => { setTestRedirect(""); update.mutate({ testRedirectUid: "" }); }} disabled={update.isPending}>
              關閉測試模式
            </Button>
            <Button size="sm" onClick={() => update.mutate({ testRedirectUid: testRedirect.trim() })} disabled={update.isPending || !testRedirect.trim()}>
              開啟 / 更新
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4 space-y-3">
          <Label className="text-sm font-semibold">💬 入住卡互動回饋</Label>
          <p className="text-xs text-muted-foreground">
            入住卡兩顆按鈕（住得很舒服 😊／有點小狀況，請小幫手協助 🛠️）會開啟連結到本系統，不經 LINE webhook。「請小幫手協助」會顯示下方問卷，送出後寫入 Ragic 回饋單並通知下列同事。
          </p>
          <div>
            <Label className="text-xs">通知對象 LINE UID（逗號分隔，可多人）</Label>
            <Input value={notifyUids} onChange={(e) => setNotifyUids(e.target.value)} className="mt-1" placeholder="Uxxxx..., Uyyyy..." autoComplete="off" />
            <p className="text-[11px] text-muted-foreground mt-1">收通知的人需先加官方帳號為好友，否則發不出去；留空＝不通知。</p>
          </div>
          <div>
            <Label className="text-xs">問卷標題</Label>
            <Input value={surveyTitle} onChange={(e) => setSurveyTitle(e.target.value)} className="mt-1" placeholder="哪個部分讓你比較不滿意？（可複選）" />
          </div>
          <div>
            <Label className="text-xs">不滿意項目（一行一個）</Label>
            <Textarea value={surveyItems} onChange={(e) => setSurveyItems(e.target.value)} className="mt-1 min-h-[140px] text-sm" spellCheck={false} placeholder={"房間設備\n清潔／環境\n維修太慢或沒處理\n噪音／鄰居\n費用／帳務\n管理或服務態度\n其他"} />
          </div>
          <div>
            <Label className="text-xs">留言提示文字</Label>
            <Input value={surveyNote} onChange={(e) => setSurveyNote(e.target.value)} className="mt-1" placeholder="想多說一點（選填）" />
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={saveFeedback} disabled={update.isPending}>
              {update.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1" />}
              儲存回饋設定
            </Button>
          </div>
        </CardContent>
      </Card>
      <PromptCard
        title="投遞 API 串接說明（給 Ragic 用）"
        desc="其他系統要發卡片給室友時，照這份說明打我們的投遞 API——訊息進排程、看板可控管、時間到自動發送。複製整段給串接的人即可。"
        text={ENQUEUE_PROMPT}
      />
      <Separator />
      <div>
        <Label className="text-sm font-semibold">案件歸屬（ownership_region）include set</Label>
        <Input value={include} onChange={(e) => setInclude(e.target.value)} className="mt-1" placeholder="總公司" />
        <p className="text-xs text-muted-foreground mt-1">逗號分隔。只有在此清單內的案件歸屬才會排程（預設：總公司）。</p>
      </div>
      <div>
        <Label className="text-sm font-semibold">總公司內分類（hq_internal_category）exclude set</Label>
        <Input value={exclude} onChange={(e) => setExclude(e.target.value)} className="mt-1" placeholder="靠行" />
        <p className="text-xs text-muted-foreground mt-1">逗號分隔。在此清單內的分類會被排除（預設：靠行）；其餘（含空白）全保留。</p>
      </div>
      <Separator />
      <div>
        <Label className="text-sm font-semibold">Zeabur run 端點 URL</Label>
        <Input value={runUrl} onChange={(e) => setRunUrl(e.target.value)} className="mt-1" placeholder="https://你的網域/api/outreach/run" autoComplete="off" />
        <p className="text-xs text-muted-foreground mt-1">Supabase pg_cron 會 POST 到此 URL 派送卡片。</p>
      </div>
      <div>
        <Label className="text-sm font-semibold">共享密鑰（run secret）</Label>
        <Input
          type="password"
          name="outreach_run_secret"
          autoComplete="new-password"
          value={runSecret}
          onChange={(e) => setRunSecret(e.target.value)}
          className="mt-1"
          placeholder={secretSet ? "已設定（留空則不變更）" : "尚未設定"}
        />
        <p className="text-xs text-muted-foreground mt-1">
          必須與 Zeabur 環境變數 OUTREACH_RUN_SECRET 完全相同。為安全，已存的密鑰不會回顯。
        </p>
      </div>
      <div className="flex justify-end">
        <Button
          onClick={() => {
            // 防呆：只送有填的欄位，空欄位一律忽略（不會覆蓋既有 URL / 密鑰 / 篩選）
            const payload: Record<string, unknown> = {};
            const inc = parseList(include);
            const exc = parseList(exclude);
            if (inc.length) payload.includeOwnershipRegions = inc;
            if (exc.length) payload.excludeHqCategories = exc;
            if (runUrl.trim()) payload.runEndpointUrl = runUrl.trim();
            if (runSecret) payload.runSecret = runSecret;
            if (Object.keys(payload).length === 0) {
              toast.info("沒有要更新的欄位（空欄位會被忽略，不會覆蓋既有設定）");
              return;
            }
            update.mutate(payload);
          }}
          disabled={update.isPending || !settingsQuery.data}
        >
          {update.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Save className="h-4 w-4 mr-1" />}
          儲存設定
        </Button>
      </div>
    </div>
  );
}

// ── 測試發送 Tab ───────────────────────────────────────────────────────────────
function TestSendTab() {
  const [uid, setUid] = useState("");
  const [altText, setAltText] = useState("");
  const [cardText, setCardText] = useState("");
  const send = trpc.outreach.sendTestCard.useMutation({
    onSuccess: () => toast.success("已送出，請到該 LINE 查看卡片"),
    onError: (e) => toast.error(e.message),
  });
  const doSend = () => {
    if (!uid.trim()) { toast.error("請填 LINE uid"); return; }
    let card: any;
    try { card = JSON.parse(cardText); } catch { toast.error("卡片 JSON 格式錯誤，請檢查"); return; }
    send.mutate({ uid: uid.trim(), card, altText: altText.trim() || undefined });
  };
  return (
    <div className="space-y-3 max-w-2xl">
      <p className="text-xs text-muted-foreground">
        貼上 LINE Flex JSON（可貼整個 message 物件，或只貼 bubble / carousel，系統會自動包裝），
        填入測試 uid，按發送即可在該 LINE 預覽卡片實際樣子。
      </p>
      <div>
        <Label className="text-xs">測試 LINE uid</Label>
        <Input value={uid} onChange={(e) => setUid(e.target.value)} className="mt-1" placeholder="Uxxxxxxxx..." autoComplete="off" />
      </div>
      <div>
        <Label className="text-xs">altText（通知列文字，選填）</Label>
        <Input value={altText} onChange={(e) => setAltText(e.target.value)} className="mt-1" placeholder="一方生活｜合約到期詢問" autoComplete="off" />
      </div>
      <div>
        <Label className="text-xs">卡片 JSON</Label>
        <Textarea
          value={cardText}
          onChange={(e) => setCardText(e.target.value)}
          className="mt-1 font-mono text-xs min-h-[260px]"
          spellCheck={false}
          placeholder='{ "type": "bubble", ... }'
        />
      </div>
      <div className="flex justify-end">
        <Button onClick={doSend} disabled={send.isPending}>
          {send.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
          發送測試卡片
        </Button>
      </div>
    </div>
  );
}

// ── 未綁 UID Tab ───────────────────────────────────────────────────────────────
function UnboundTab() {
  const [expiringOnly, setExpiringOnly] = useState(false);
  const q = trpc.outreach.listUnboundTenants.useQuery(
    expiringOnly ? { expiringWithinDays: 60 } : {},
    { refetchOnWindowFocus: false },
  );
  const rows = (q.data || []) as any[];
  const exportUnbound = () => {
    const header = ["姓名", "電話", "案場", "房號", "合約到期日"];
    const esc = (v: any) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = rows.map((r) => [r.tenant_name, r.phone, r.property_name, r.room, r.contract_end_date].map(esc).join(",")).join("\r\n");
    const blob = new Blob(["﻿" + header.join(",") + "\r\n" + body], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `unbound_uid_${ymd(new Date())}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        這些主客<b>有有效合約但還沒綁 LINE</b>——系統發不到他們（不會進排程）。到期詢問請照此名單由同事人工聯繫；綁定後（用 LINE 開過預約頁）會自動從名單消失。
      </p>
      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
          <Checkbox checked={expiringOnly} onCheckedChange={(v) => setExpiringOnly(!!v)} /> 只看 60 天內到期
        </label>
        <span className="text-xs text-muted-foreground">共 {rows.length} 人</span>
        <Button variant="outline" size="sm" onClick={() => q.refetch()}><RefreshCw className="h-3.5 w-3.5 mr-1" /> 重新整理</Button>
        <Button variant="outline" size="sm" onClick={exportUnbound} disabled={!rows.length}><Download className="h-3.5 w-3.5 mr-1" /> 匯出 CSV</Button>
      </div>
      {q.isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mr-2" /> 載入中...</div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">沒有未綁 UID 的主客 🎉</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left text-muted-foreground border-b text-xs">
                <th className="py-1.5 pr-3">姓名</th><th className="py-1.5 pr-3">電話</th>
                <th className="py-1.5 pr-3">案場</th><th className="py-1.5 pr-3">房號</th>
                <th className="py-1.5 pr-3">合約到期日</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1.5 pr-3 font-medium">{r.tenant_name || "（無姓名）"}</td>
                  <td className="py-1.5 pr-3 font-mono">{r.phone || "—"}</td>
                  <td className="py-1.5 pr-3">{r.property_name || "—"}</td>
                  <td className="py-1.5 pr-3">{r.room || "—"}</td>
                  <td className="py-1.5 pr-3 font-mono">{r.contract_end_date || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 成效統計 Tab ───────────────────────────────────────────────────────────────
function StatsTab() {
  const [months, setMonths] = useState(6);
  const statsQuery = trpc.outreach.getOutreachStats.useQuery({ months }, { refetchOnWindowFocus: false });
  const data = statsQuery.data as any;
  const buckets = (data?.buckets || []) as any[];
  const threshold = data?.threshold ?? 0.2;
  const maxBar = Math.max(1, ...buckets.map((b) => b.sent + b.failed + b.suppressed));
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Label className="text-sm">統計區間</Label>
        <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
          <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="3">近 3 個月</SelectItem>
            <SelectItem value="6">近 6 個月</SelectItem>
            <SelectItem value="12">近 12 個月</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => statsQuery.refetch()}><RefreshCw className="h-3.5 w-3.5 mr-1" /> 重新整理</Button>
      </div>
      {statsQuery.isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mr-2" /> 載入中...</div>
      ) : buckets.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">目前沒有發送紀錄</div>
      ) : (
        <div className="space-y-2">
          {buckets.map((b) => (
            <Card key={b.month} className={b.warn ? "border-red-300" : ""}>
              <CardContent className="py-3 space-y-2">
                <div className="flex items-center justify-between flex-wrap gap-1">
                  <span className="font-mono font-semibold">{b.month}</span>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-green-700">已發送 {b.sent}</span>
                    <span className="text-purple-700">已抑制 {b.suppressed}</span>
                    <span className="text-red-600">失敗 {b.failed}</span>
                    <span className={b.warn ? "text-red-600 font-semibold" : "text-muted-foreground"}>失敗率 {(b.ratio * 100).toFixed(1)}%</span>
                    {b.warn && (
                      <span className="inline-flex items-center gap-1 text-red-600 font-semibold">
                        <AlertTriangle className="h-3.5 w-3.5" /> 低送達率
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex h-2.5 w-full overflow-hidden rounded bg-muted">
                  <div className="bg-green-500" style={{ width: `${(b.sent / maxBar) * 100}%` }} />
                  <div className="bg-purple-400" style={{ width: `${(b.suppressed / maxBar) * 100}%` }} />
                  <div className="bg-red-500" style={{ width: `${(b.failed / maxBar) * 100}%` }} />
                </div>
              </CardContent>
            </Card>
          ))}
          <p className="text-[11px] text-muted-foreground">失敗率 = 失敗 ÷（已發送 ＋ 失敗）；超過 {(threshold * 100).toFixed(0)}% 標示「低送達率」。失敗定義：曾嘗試發送但未成功且留有錯誤訊息。</p>
        </div>
      )}
    </div>
  );
}

// ── 主元件 ─────────────────────────────────────────────────────────────────────
export function OutreachBoard() {
  const health = trpc.outreach.health.useQuery(undefined, { refetchOnWindowFocus: false });
  const rulesQuery = trpc.outreach.listRules.useQuery(undefined, { refetchOnWindowFocus: false });
  const settingsQuery = trpc.outreach.getSettings.useQuery(undefined, { refetchOnWindowFocus: false });
  const testUid = (settingsQuery.data as any)?.test_redirect_uid as string | null | undefined;

  return (
    <div className="space-y-4">
      {testUid && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-amber-100 text-amber-900 text-sm border border-amber-400">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>🧪 <b>測試模式開啟中</b>：所有發送（立即送＋每日自動派送）都會改寄到 <code>{testUid.slice(0, 10)}…</code>，<b>不會送給真實室友</b>。要正式對室友發送，請到「篩選 / 設定」按「關閉測試模式」。</span>
        </div>
      )}
      {health.data && !health.data.supabaseConfigured && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 text-amber-800 text-sm">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>後端尚未設定 <code>SUPABASE_DB_URL</code>，看板無法讀取排程。請於 Zeabur 環境變數設定後重新部署。</span>
        </div>
      )}
      <Tabs defaultValue="schedule">
        <TabsList>
          <TabsTrigger value="schedule">排程看板</TabsTrigger>
          <TabsTrigger value="rules">規則 / 卡片</TabsTrigger>
          <TabsTrigger value="stats">成效</TabsTrigger>
          <TabsTrigger value="unbound">未綁UID</TabsTrigger>
          <TabsTrigger value="settings">篩選 / 設定</TabsTrigger>
          <TabsTrigger value="test">測試發送</TabsTrigger>
          <TabsTrigger value="renewal">到期未約</TabsTrigger>
        </TabsList>
        <TabsContent value="schedule" className="mt-4">
          <ScheduleTab rules={(rulesQuery.data || []) as any[]} />
        </TabsContent>
        <TabsContent value="rules" className="mt-4">
          <RulesTab />
        </TabsContent>
        <TabsContent value="stats" className="mt-4">
          <StatsTab />
        </TabsContent>
        <TabsContent value="unbound" className="mt-4">
          <UnboundTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="test" className="mt-4">
          <TestSendTab />
        </TabsContent>
        <TabsContent value="renewal" className="mt-4">
          <RenewalDueTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
