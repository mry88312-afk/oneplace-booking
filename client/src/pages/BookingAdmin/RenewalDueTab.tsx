import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, Search, Send } from "lucide-react";

/** 合約到期但沒預約續約/退租 → 篩名單（可調門檻、含案場分類/內部分類）→ 一鍵發給主管。 */
export function RenewalDueTab() {
  const [days, setDays] = useState(30);
  const [supervisorUid, setSupervisorUid] = useState("");
  const scan = trpc.outreach.scanRenewalDue.useQuery({ thresholdDays: days }, { enabled: false });
  const send = trpc.outreach.sendRenewalDueReminder.useMutation();
  const data = scan.data as any;
  const list: any[] = data?.list || [];

  const doSend = async () => {
    if (!supervisorUid.trim()) { toast.error("請先填主管 LINE UID"); return; }
    try {
      const r: any = await send.mutateAsync({ supervisorUid: supervisorUid.trim(), thresholdDays: days });
      if (!r.count) toast("目前沒有符合的名單，未發送");
      else if (r.sent) toast.success(`已把 ${r.count} 位名單發給主管`);
      else toast.error("發送失敗：" + (r.error || "未知"));
    } catch (e: any) { toast.error(e?.message || "發送失敗"); }
  };

  return (
    <div className="space-y-3">
      <Card><CardContent className="pt-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          篩出「合約 N 天內到期或已過期、但還沒預約續約/退租」的租客（即時查 booking）。先掃描看名單，再把名單一鍵發給主管。
        </p>
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <Label>到期門檻（天內到期；負數＝只看已過期 N 天）</Label>
            <Input type="number" value={days} onChange={(e) => setDays(parseInt(e.target.value || "0", 10) || 0)} className="w-56" />
          </div>
          <Button onClick={() => scan.refetch()} disabled={scan.isFetching}>
            {scan.isFetching ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Search className="h-4 w-4 mr-1" />}掃描
          </Button>
        </div>
        {data && (
          <p className="text-sm">到期池 <b>{data.total}</b>　已預約續約/退租 <b>{data.bookedCount}</b>　→ <b className="text-red-600">待提醒 {list.length}</b></p>
        )}
        <div className="flex items-end gap-2 flex-wrap">
          <div className="flex-1 min-w-[260px]">
            <Label>主管 LINE UID（收提醒的人）</Label>
            <Input value={supervisorUid} onChange={(e) => setSupervisorUid(e.target.value)} placeholder="U…（之後可改成多人/常用名單）" />
          </div>
          <Button onClick={doSend} disabled={send.isPending || !list.length}>
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Send className="h-4 w-4 mr-1" />}發送提醒給主管
          </Button>
        </div>
      </CardContent></Card>

      {list.length > 0 && (
        <Card><CardContent className="pt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground border-b">
                <th className="py-1 pr-3">到期日</th><th className="pr-3">剩</th><th className="pr-3">姓名</th>
                <th className="pr-3">案場房號</th><th className="pr-3">電話</th><th className="pr-3">案場分類</th><th className="pr-3">內部分類</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i} className="border-b last:border-0">
                  <td className="py-1 pr-3 whitespace-nowrap">{r.end_date}</td>
                  <td className="pr-3">{r.days_left}</td>
                  <td className="pr-3 whitespace-nowrap">{r.primary_name || "?"}</td>
                  <td className="pr-3 whitespace-nowrap">{[r.property, r.room].filter(Boolean).join(" ") || "—"}</td>
                  <td className="pr-3 whitespace-nowrap">{r.primary_phone || "—"}{(!r.line_uid || r.line_uid === ".") ? " ⚠️無UID" : ""}</td>
                  <td className="pr-3 whitespace-nowrap"><Badge variant="outline">{r.region || "—"}</Badge></td>
                  <td className="pr-3 whitespace-nowrap">{r.internal_cat || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent></Card>
      )}
    </div>
  );
}
