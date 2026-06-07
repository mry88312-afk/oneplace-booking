import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Loader2, Send, CalendarClock, SkipForward, Check, RotateCcw, RefreshCw, Save, AlertTriangle, Copy, Sparkles,
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

// ── 排程看板 ──────────────────────────────────────────────────────────────────
function ScheduleTab({ ruleLabels }: { ruleLabels: Record<string, string> }) {
  const [statusFilter, setStatusFilter] = useState<string>("upcoming");
  const listInput = statusFilter === "upcoming" ? undefined : { status: statusFilter as any };
  const scheduleQuery = trpc.outreach.listSchedule.useQuery(listInput, { refetchOnWindowFocus: false });
  const utils = trpc.useUtils();

  const updateItem = trpc.outreach.updateScheduleItem.useMutation({
    onSuccess: () => { utils.outreach.listSchedule.invalidate(); },
    onError: (e) => toast.error(e.message),
  });
  const sendNow = trpc.outreach.sendNow.useMutation({
    onSuccess: (r: any) => {
      if (r.failed > 0 && r.errors?.length) {
        toast.error(`發送失敗：${r.errors[0].error}`);
      } else if (r.suppressed > 0) {
        toast.info("已抑制（該室友已預約續約/退租），未發送");
      } else {
        toast.success(`發送完成：sent ${r.sent}・suppressed ${r.suppressed}・failed ${r.failed}・skipped ${r.skipped}`);
      }
      utils.outreach.listSchedule.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const recompute = trpc.outreach.recomputeNow.useMutation({
    onSuccess: (r) => { toast.success(`已重算排程，新增 ${r.inserted} 筆`); utils.outreach.listSchedule.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const [rescheduleRow, setRescheduleRow] = useState<{ id: string; date: string } | null>(null);

  const rows = scheduleQuery.data || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="upcoming">未來排程</SelectItem>
            <SelectItem value="pending">待確認</SelectItem>
            <SelectItem value="confirmed">已確認</SelectItem>
            <SelectItem value="sent">已發送</SelectItem>
            <SelectItem value="skipped">已跳過</SelectItem>
            <SelectItem value="suppressed">已抑制</SelectItem>
            <SelectItem value="cancelled">已取消</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => scheduleQuery.refetch()}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" /> 重新整理
        </Button>
        <Button variant="outline" size="sm" onClick={() => recompute.mutate()} disabled={recompute.isPending}>
          {recompute.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1" />}
          重算排程
        </Button>
        <span className="text-sm text-muted-foreground ml-auto">{rows.length} 筆</span>
      </div>

      {scheduleQuery.isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> 載入中...
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">沒有符合條件的排程</div>
      ) : (
        <div className="space-y-2">
          {rows.map((r: any) => {
            const st = STATUS_MAP[r.status] || { label: r.status, color: "bg-muted text-muted-foreground" };
            const canSend = r.status === "pending" || r.status === "confirmed";
            return (
              <Card key={r.id}>
                <CardContent className="py-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-sm font-semibold">{r.scheduled_date}</span>
                        <Badge variant="outline">{ruleLabels[r.rule_key] || r.rule_key}</Badge>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${st.color}`}>{st.label}</span>
                        {r.manually_edited && <span className="text-[10px] text-muted-foreground">（已手動調整）</span>}
                      </div>
                      <div className="text-sm text-muted-foreground truncate">
                        {r.tenant_name || "（無姓名）"}
                        {r.room ? `・${r.room}` : ""}
                        {r.contract_no ? `・${r.contract_no}` : ""}
                        {r.contract_end_date ? `・到期 ${r.contract_end_date}` : ""}
                      </div>
                      {r.suppressed_reason && (
                        <div className="text-xs text-purple-700 mt-1">{r.suppressed_reason}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {r.status === "pending" && (
                        <Button size="sm" variant="outline" onClick={() => updateItem.mutate({ id: r.id, action: "confirm" })}>
                          <Check className="h-3.5 w-3.5 mr-1" /> 確認
                        </Button>
                      )}
                      {r.status === "confirmed" && (
                        <Button size="sm" variant="outline" onClick={() => updateItem.mutate({ id: r.id, action: "unconfirm" })}>
                          取消確認
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => setRescheduleRow({ id: r.id, date: r.scheduled_date })}>
                        <CalendarClock className="h-3.5 w-3.5 mr-1" /> 改期
                      </Button>
                      {(r.status === "pending" || r.status === "confirmed") && (
                        <Button size="sm" variant="ghost" onClick={() => updateItem.mutate({ id: r.id, action: "skip" })}>
                          <SkipForward className="h-3.5 w-3.5 mr-1" /> 跳過
                        </Button>
                      )}
                      {canSend && (
                        <Button size="sm" onClick={() => sendNow.mutate({ id: r.id })} disabled={sendNow.isPending}>
                          {sendNow.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                          立即送
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 改期 Dialog */}
      <Dialog open={!!rescheduleRow} onOpenChange={(v) => { if (!v) setRescheduleRow(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>改期</DialogTitle>
            <DialogDescription>調整這筆排程的發送日期（會標記為手動調整，重算不會覆蓋）。</DialogDescription>
          </DialogHeader>
          <Input
            type="date"
            value={rescheduleRow?.date || ""}
            onChange={(e) => setRescheduleRow((p) => (p ? { ...p, date: e.target.value } : p))}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRescheduleRow(null)}>取消</Button>
            <Button
              onClick={() => {
                if (!rescheduleRow?.date) { toast.error("請選擇日期"); return; }
                updateItem.mutate(
                  { id: rescheduleRow.id, action: "reschedule", scheduledDate: rescheduleRow.date },
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
  const [templateText, setTemplateText] = useState(JSON.stringify(rule.card_template, null, 2));

  useEffect(() => {
    setLabel(rule.label ?? "");
    setOffsetDays(rule.offset_days ?? 0);
    setEnabled(!!rule.enabled);
    setTemplateText(JSON.stringify(rule.card_template, null, 2));
  }, [rule]);

  const updateRule = trpc.outreach.updateRule.useMutation({
    onSuccess: () => { toast.success(`已儲存規則：${rule.key}`); onSaved(); },
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
    updateRule.mutate({ key: rule.key, label, offsetDays, enabled, cardTemplate: parsed });
  };

  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <code className="text-xs bg-muted px-2 py-0.5 rounded">{rule.key}</code>
            <Badge variant="outline">
              {rule.trigger_basis === "contract_start" ? "合約開始日" : "合約到期日"}
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

// ── 卡片產生 Prompt ────────────────────────────────────────────────────────────
function PromptCard() {
  const copy = () => {
    navigator.clipboard.writeText(CARD_PROMPT).then(
      () => toast.success("Prompt 已複製，貼到 ChatGPT / Claude 並描述你要的卡片即可"),
      () => toast.error("複製失敗，請手動選取全部"),
    );
  };
  return (
    <Card className="bg-muted/40 border-dashed">
      <CardContent className="py-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold flex items-center gap-1.5">
            <Sparkles className="h-4 w-4 text-primary" /> 卡片產生 Prompt（給 AI 用）
          </div>
          <Button size="sm" variant="outline" onClick={copy}><Copy className="h-3.5 w-3.5 mr-1" /> 複製 Prompt</Button>
        </div>
        <p className="text-xs text-muted-foreground">
          複製這段 → 貼到 ChatGPT / Claude → 描述你要的卡片 → 把它產出的 Flex JSON 貼進下方規則的「卡片 JSON」（或「測試發送」預覽）即可。
        </p>
        <Textarea readOnly value={CARD_PROMPT} className="font-mono text-[11px] min-h-[140px]" onFocus={(e) => e.currentTarget.select()} />
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
      <PromptCard />
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

  useEffect(() => {
    const d: any = settingsQuery.data;
    if (!d) return;
    setInclude((d.include_ownership_regions || []).join(", "));
    setExclude((d.exclude_hq_categories || []).join(", "));
    setRunUrl(d.run_endpoint_url || "");
    setSecretSet(!!d.run_secret_set);
  }, [settingsQuery.data]);

  const update = trpc.outreach.updateSettings.useMutation({
    onSuccess: () => { toast.success("設定已儲存"); setRunSecret(""); settingsQuery.refetch(); },
    onError: (e) => toast.error(e.message),
  });

  const parseList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

  return (
    <div className="space-y-4 max-w-xl">
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

// ── 主元件 ─────────────────────────────────────────────────────────────────────
export function OutreachBoard() {
  const health = trpc.outreach.health.useQuery(undefined, { refetchOnWindowFocus: false });
  const rulesQuery = trpc.outreach.listRules.useQuery(undefined, { refetchOnWindowFocus: false });
  const ruleLabels: Record<string, string> = {};
  for (const r of (rulesQuery.data || []) as any[]) ruleLabels[r.key] = r.label;

  return (
    <div className="space-y-4">
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
          <TabsTrigger value="settings">篩選 / 設定</TabsTrigger>
          <TabsTrigger value="test">測試發送</TabsTrigger>
        </TabsList>
        <TabsContent value="schedule" className="mt-4">
          <ScheduleTab ruleLabels={ruleLabels} />
        </TabsContent>
        <TabsContent value="rules" className="mt-4">
          <RulesTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="test" className="mt-4">
          <TestSendTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
