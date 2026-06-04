import React, { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  CalendarDays, Users, ChevronRight, ChevronDown, ExternalLink,
  FileText, User, Home, MapPin, XCircle, Loader2, History,
} from "lucide-react";

const BOOKING_STATUS_MAP: Record<string, { label: string; color: string }> = {
  confirmed: { label: "已確認", color: "bg-green-100 text-green-800" },
  cancelled: { label: "已取消", color: "bg-red-100 text-red-800" },
  completed: { label: "已完成", color: "bg-blue-100 text-blue-800" },
  no_show: { label: "未到", color: "bg-yellow-100 text-yellow-800" },
};

export function BookingRecordsPanel({ templateId }: { templateId: number }) {
  const recordsQuery = trpc.booking.listBookings.useQuery(
    { templateId, limit: 50 },
    { refetchOnWindowFocus: false }
  );
  const cancelMutation = trpc.booking.cancelBooking.useMutation({
    onSuccess: () => { toast.success("已取消預約"); recordsQuery.refetch(); },
    onError: (err) => toast.error(err.message),
  });
  const [cancelConfirmId, setCancelConfirmId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const records = recordsQuery.data || [];

  if (recordsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">載入中...</span>
      </div>
    );
  }

  if (records.length === 0) {
    return <div className="text-center py-8 text-sm text-muted-foreground">尚無預約記錄</div>;
  }

  return (
    <div className="mt-4 border-t pt-4">
      <h4 className="text-sm font-semibold mb-3 flex items-center gap-1">
        <History className="h-4 w-4" /> 預約記錄（{records.length} 筆）
      </h4>
      <div className="space-y-2 max-h-[500px] overflow-y-auto">
        {records.map((r) => {
          const status = BOOKING_STATUS_MAP[r.status] || { label: r.status, color: "bg-muted text-muted-foreground" };
          const bookingDate = r.bookingTime ? new Date(Number(r.bookingTime)).toLocaleString("zh-TW", {
            year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
          }) : "—";
          const answers = r.formAnswers as Record<string, any> | null;
          const hasAnswers = answers && Object.keys(answers).length > 0;
          const isExpanded = expandedId === r.id;
          return (
            <div key={r.id} className="rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
              <div className="flex items-center justify-between p-3 cursor-pointer" onClick={() => setExpandedId(isExpanded ? null : r.id)}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium">{r.tenantName || "未知"}</span>
                    <Home className="h-3.5 w-3.5 text-muted-foreground ml-2" />
                    <span className="text-sm text-muted-foreground">{r.roomNumber || "—"}</span>
                    {r.address && (
                      <>
                        <MapPin className="h-3.5 w-3.5 text-muted-foreground ml-2" />
                        <span className="text-sm text-muted-foreground truncate max-w-[200px]" title={r.address}>{r.address}</span>
                      </>
                    )}
                    <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${status.color}`}>{status.label}</span>
                    {hasAnswers && (
                      <Badge variant="outline" className="ml-1 text-xs">
                        <FileText className="h-3 w-3 mr-1" /> {Object.keys(answers!).length} 項填寫
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><CalendarDays className="h-3 w-3" /> {bookingDate}</span>
                    {r.assigneeName && <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {r.assigneeName}</span>}
                    {(r as any).userName && <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {(r as any).userName}</span>}
                    {r.tenantUid && <span className="truncate max-w-[120px]" title={r.tenantUid}>UID: {r.tenantUid.slice(0, 10)}...</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {r.status === "confirmed" && (
                    <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive"
                      onClick={(e) => { e.stopPropagation(); setCancelConfirmId(r.id); }}>
                      <XCircle className="h-3.5 w-3.5 mr-1" /> 取消
                    </Button>
                  )}
                  {hasAnswers && (isExpanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />)}
                </div>
              </div>
              {isExpanded && hasAnswers && (
                <div className="px-3 pb-3 border-t border-border/50 pt-2">
                  <div className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                    <FileText className="h-3 w-3" /> 填寫內容
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {Object.entries(answers!).map(([label, value]) => (
                      <div key={label} className="bg-background rounded-md p-2 border border-border/30">
                        <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
                        <div className="text-sm font-medium break-words">
                          {typeof value === "string" && value.startsWith("http") ? (
                            <a href={value} target="_blank" rel="noopener noreferrer" className="text-primary underline flex items-center gap-1">
                              查看檔案 <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : String(value || "—")}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Dialog open={cancelConfirmId !== null} onOpenChange={() => setCancelConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>確認取消預約</DialogTitle>
            <DialogDescription>取消後該預約將標記為已取消，且無法復原。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelConfirmId(null)}>取消</Button>
            <Button variant="destructive" onClick={() => cancelConfirmId && cancelMutation.mutate({ id: cancelConfirmId })} disabled={cancelMutation.isPending}>
              {cancelMutation.isPending ? "取消中..." : "確認取消"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
