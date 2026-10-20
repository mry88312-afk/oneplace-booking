import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const time = (v: unknown) => v ? new Date(String(v)).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—";
const money = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? `NT$ ${v.toLocaleString("en-US")}` : "—";

export function RentRemindersTab() {
  const [search, setSearch] = useState("");
  const history = trpc.outreach.rentHistory.useQuery(undefined, { refetchOnWindowFocus: false, refetchInterval: 60000 });
  const preview = trpc.outreach.previewRentReminders.useMutation({ onError: e => toast.error(e.message) });
  const toggle = trpc.outreach.setRentEnabled.useMutation({
    onSuccess: () => { void history.refetch(); toast.success("已更新每日租金提醒設定"); },
    onError: e => toast.error(e.message),
  });
  if (history.isLoading) return <p className="text-sm text-muted-foreground">載入租金提醒紀錄…</p>;
  if (history.error) return <p role="alert" className="text-sm text-red-700">無法讀取租金提醒：{history.error.message}</p>;
  const data = history.data;
  const settings = data?.settings;
  const matches = (r: { tenant_name?: string; room?: string; contract_no?: string; vars?: Record<string, unknown> }) =>
    [r.tenant_name, r.room, r.contract_no, r.vars?.bill_name, r.vars?.bill_id].join(" ").includes(search.trim());
  const messages = (data?.messages ?? []).filter(matches);
  const latest = data?.runs?.[0];
  const decisions = preview.data?.decisions ?? (Array.isArray(latest?.decisions) ? latest.decisions : []);
  const eligible = decisions.filter(d => d.eligible);
  return <div className="space-y-4">
    <Card><CardContent className="p-5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">總公司租金提醒</h2>
          <p className="text-sm text-muted-foreground">每天中午 12:00 開始核對 JGB，完成後依序發送。</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={settings?.enabled ? "default" : "secondary"}>{settings?.enabled ? "每日提醒已開啟" : "每日提醒已暫停"}</Badge>
          <Button variant="outline" disabled={!settings || toggle.isPending}
            onClick={() => toggle.mutate({ enabled: !settings?.enabled })}>
            {settings?.enabled ? "暫停提醒" : "開啟每日提醒"}
          </Button>
        </div>
      </div>
      <p className="text-sm">生效日：{settings?.start_date ?? "尚未設定"}・逾期第 2 天起・包含歷史應到帳帳單</p>
      <p className="text-xs text-muted-foreground">僅總公司管理租約的主承租人；排除靠行、示範資料、已到期合約。已入帳、歸屬或收件人不明時不發送。</p>
      {settings?.test_mode && <p role="alert" className="text-sm text-amber-700">發訊中樞目前為測試模式，租金自動提醒暫不執行。</p>}
      <p className="text-xs text-muted-foreground">開啟設定不會立即發送。同一帳單每天最多嘗試一次；回應不明不自動重送。</p>
    </CardContent></Card>
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" onClick={() => void history.refetch()} disabled={history.isFetching}>
        <RefreshCw className="h-4 w-4 mr-1" />更新紀錄
      </Button>
      <Button variant="outline" onClick={() => preview.mutate()} disabled={preview.isPending}>
        {preview.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
        {preview.isPending ? "正在取得 JGB 清單…" : "預覽目前名單（不發送）"}
      </Button>
    </div>
    <Card><CardContent className="p-5 space-y-3">
      <h3 className="font-semibold">每日執行結果</h3>
      {!data?.runs?.length && <p className="text-sm text-muted-foreground">尚無每日執行紀錄。首次排程執行後會顯示來源時間與通知結果。</p>}
      {data?.runs?.map(run => <div key={run.id} className="border-b pb-3 text-sm space-y-1">
        <p className="font-medium">{run.run_date}・{run.status === "complete" ? "核對完成" : run.status === "failed" ? "執行停止" : "執行中／若長時間未完成請核對"}</p>
        <p>來源 {run.source_count} 張／符合提醒 {run.eligible_count} 張／LINE 已接受 {run.sent_count} 則</p>
        <p className="text-xs text-muted-foreground">JGB 來源時間：{time(run.source_at)}・完成時間：{time(run.finished_at)}</p>
        {run.error && <p className="text-amber-700">{run.error}</p>}
      </div>)}
    </CardContent></Card>
    <Card><CardContent className="p-5 space-y-3">
      <h3 className="font-semibold">發送紀錄</h3>
      <Input aria-label="搜尋租金提醒紀錄" placeholder="搜尋承租人、房屋、合約或帳單" value={search} onChange={e => setSearch(e.target.value)} />
      <p className="text-xs text-muted-foreground">最近 500 筆。LINE 已接受代表訊息 API 接受，未表示租客已讀。</p>
      <div className="overflow-x-auto"><table className="w-full text-sm min-w-[850px]">
        <thead><tr className="text-left border-b">{["日期／承租人", "房屋／合約", "帳單／逾期", "應到帳", "結果／發送時間"].map(x => <th key={x} className="py-2 pr-4">{x}</th>)}</tr></thead>
        <tbody>{messages.map(r => <tr key={r.id} className="border-b align-top">
          <td className="py-3 pr-4">{r.scheduled_date}<br />{r.tenant_name}</td>
          <td className="py-3 pr-4">{r.room}<br /><span className="text-muted-foreground">{r.contract_no}</span></td>
          <td className="py-3 pr-4">{String(r.vars?.bill_name ?? "—")}<br />#{String(r.vars?.bill_id ?? "")}・逾期 {String(r.vars?.overdue_days ?? "")} 天</td>
          <td className="py-3 pr-4 whitespace-nowrap">{money(r.vars?.total)}</td>
          <td className="py-3 pr-4">{r.status === "sent" ? "LINE 已接受" : r.last_error ? "待核對" : r.suppressed_reason ?? "未發送"}
            <p className="text-xs text-muted-foreground">{time(r.sent_at ?? r.last_attempt_at)}</p>
            {r.last_error && <p className="text-xs text-amber-700">{r.last_error}</p>}
          </td>
        </tr>)}</tbody>
      </table></div>
      {!messages.length && <p className="text-sm text-muted-foreground">沒有符合的發送紀錄。</p>}
    </CardContent></Card>
    <Card><CardContent className="p-5 space-y-3">
      <h3 className="font-semibold">{preview.data ? "目前名單預覽" : "最近一次核對名單"}</h3>
      <p className="text-xs text-muted-foreground">資料時間：{time(preview.data?.sourceAt ?? latest?.source_at)}；符合提醒 {eligible.length} 張。實際發送仍以當日重新核對結果為準。</p>
      <div className="max-h-[420px] overflow-auto"><table className="w-full text-sm min-w-[650px]">
        <thead><tr className="border-b text-left">{["承租人／房屋", "帳單", "金額", "核對結果"].map(x => <th className="py-2 pr-3" key={x}>{x}</th>)}</tr></thead>
        <tbody>{[...decisions].sort((a, b) => Number(b.eligible) - Number(a.eligible)).map(d => <tr key={d.billId} className="border-b">
          <td className="py-2 pr-3">{d.tenantName || "尚未對應"}<br /><span className="text-xs text-muted-foreground">{d.room}</span></td>
          <td className="py-2 pr-3">{d.billName}<br /><span className="text-xs text-muted-foreground">#{d.billId}</span></td>
          <td className="py-2 pr-3 whitespace-nowrap">{money(d.total)}</td>
          <td className={`py-2 pr-3 ${d.eligible ? "text-green-700" : "text-muted-foreground"}`}>{d.reason}</td>
        </tr>)}</tbody>
      </table></div>
    </CardContent></Card>
  </div>;
}
