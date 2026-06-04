import React, { useState, useRef, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Trash2, Loader2 } from "lucide-react";

// ─── 星期常數 & 時間選項 ───────────────────────────────────────────────────────
const DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function generateTimeOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const val = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      options.push({ value: val, label: val });
    }
  }
  return options;
}
export const TIME_OPTIONS = generateTimeOptions();

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface RoutingRule {
  days: number[];
  calendarId: string;
  calendarLabel?: string | null;
  ownerName: string;
  weeklyStartTime?: string | null;
  weeklyEndTime?: string | null;
}

// ─── Component ──────────────────────────────────────────────────────────────────

export function RoutingRuleEditor({
  rules,
  onChange,
  onSave,
}: {
  rules: RoutingRule[];
  onChange: (rules: RoutingRule[]) => void;
  onSave?: () => void;
}) {
  const validateCalendar = trpc.booking.validateCalendar.useMutation();
  const saEmailQuery = trpc.booking.getServiceAccountEmail.useQuery();
  const [validatingIndex, setValidatingIndex] = useState<number | null>(null);
  const [validationResults, setValidationResults] = useState<Record<number, { valid: boolean; message: string; saEmail?: string }>>({});
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevRulesRef = useRef<string>(JSON.stringify(rules));

  useEffect(() => {
    const currentStr = JSON.stringify(rules);
    if (currentStr === prevRulesRef.current) return;
    prevRulesRef.current = currentStr;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => { if (onSave) onSave(); }, 2000);
    return () => { if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current); };
  }, [rules, onSave]);

  const handleValidate = async (index: number, calendarId: string) => {
    if (!calendarId.trim()) { toast.error("請先填寫 Calendar ID"); return; }
    setValidatingIndex(index);
    try {
      const result = await validateCalendar.mutateAsync({ calendarId: calendarId.trim() });
      setValidationResults(prev => ({ ...prev, [index]: { valid: result.valid, message: result.message, saEmail: (result as any).serviceAccountEmail } }));
      result.valid ? toast.success(result.message) : toast.error(result.message);
    } catch (err: any) {
      setValidationResults(prev => ({ ...prev, [index]: { valid: false, message: err.message } }));
      toast.error(`驗證失敗: ${err.message}`);
    } finally { setValidatingIndex(null); }
  };

  const addRule = () => onChange([...rules, { days: [], calendarId: "", calendarLabel: "", ownerName: "", weeklyStartTime: null, weeklyEndTime: null }]);
  const removeRule = (index: number) => onChange(rules.filter((_, i) => i !== index));
  const updateRule = (index: number, field: keyof RoutingRule, value: any) => {
    const updated = [...rules]; updated[index] = { ...updated[index], [field]: value }; onChange(updated);
  };
  const toggleDay = (ruleIndex: number, day: number) => {
    const updated = [...rules]; const days = [...updated[ruleIndex].days];
    const idx = days.indexOf(day);
    if (idx >= 0) days.splice(idx, 1); else { days.push(day); days.sort(); }
    updated[ruleIndex] = { ...updated[ruleIndex], days }; onChange(updated);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold">日曆分流規則</Label>
        <Button type="button" variant="outline" size="sm" onClick={addRule}>
          <Plus className="h-3 w-3 mr-1" /> 新增規則
        </Button>
      </div>
      {rules.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">尚未設定分流規則，請點擊「新增規則」</p>
      )}
      {rules.map((rule, index) => (
        <Card key={index} className="border-dashed">
          <CardContent className="pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">規則 {index + 1}</span>
              <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => removeRule(index)}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            {/* 星期選擇 */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">適用星期</Label>
              <div className="flex gap-1">
                {DAY_LABELS.map((label, day) => {
                  const isSelected = rule.days.includes(day);
                  return (
                    <button key={day} type="button"
                      className={`w-9 h-9 rounded-md text-xs font-medium transition-colors ${isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-accent"}`}
                      onClick={() => toggleDay(index, day)}>{label}</button>
                  );
                })}
              </div>
            </div>
            {/* Google Calendar ID */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Google Calendar ID</Label>
              <div className="flex gap-2">
                <Input placeholder="example@group.calendar.google.com" value={rule.calendarId}
                  onChange={(e) => { updateRule(index, "calendarId", e.target.value); setValidationResults(prev => { const n = { ...prev }; delete n[index]; return n; }); }}
                  className="text-sm flex-1" />
                <Button type="button" variant="outline" size="sm" disabled={validatingIndex === index}
                  onClick={() => handleValidate(index, rule.calendarId)} className="shrink-0">
                  {validatingIndex === index ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null} 驗證
                </Button>
              </div>
              {validationResults[index] && (
                <p className={`text-xs mt-1 ${validationResults[index].valid ? 'text-green-600' : 'text-red-500'}`}>
                  {validationResults[index].valid ? '✅ ' : '❌ '}{validationResults[index].message}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">在 Google Calendar 設定 → 日曆設定 → 整合日曆→「日曆 ID」中取得。點擊「驗證」可測試日曆是否可存取。</p>
              {saEmailQuery.data?.email && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  請將日曆共用給：<span className="font-mono text-xs select-all bg-muted px-1 py-0.5 rounded">{saEmailQuery.data.email}</span>
                </p>
              )}
            </div>
            {/* 日曆說明 */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">日曆說明（選填，方便辨識）</Label>
              <Input placeholder="例：退租日曆、帶看日曆、王小明的行程" value={rule.calendarLabel || ""}
                onChange={(e) => updateRule(index, "calendarLabel", e.target.value || null)} className="text-sm" />
            </div>
            {/* 負責人 */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">負責人（日曆擁有者）</Label>
              <Input placeholder="例：王小明" value={rule.ownerName}
                onChange={(e) => updateRule(index, "ownerName", e.target.value)} className="text-sm" />
            </div>
            {/* 週循環時段設定 */}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">時段設定（可獨立設定，留空則使用模版預設）</Label>
              <div className="flex items-center gap-2">
                <Select value={rule.weeklyStartTime || "_none"} onValueChange={(v) => updateRule(index, "weeklyStartTime", v === "_none" ? null : v)}>
                  <SelectTrigger className="w-24 h-8 text-sm"><SelectValue placeholder="開始" /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    <SelectItem value="_none">不設定</SelectItem>
                    {TIME_OPTIONS.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-sm">—</span>
                <Select value={rule.weeklyEndTime || "_none"} onValueChange={(v) => updateRule(index, "weeklyEndTime", v === "_none" ? null : v)}>
                  <SelectTrigger className="w-24 h-8 text-sm"><SelectValue placeholder="結束" /></SelectTrigger>
                  <SelectContent className="max-h-60">
                    <SelectItem value="_none">不設定</SelectItem>
                    {TIME_OPTIONS.map((opt) => <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <p className="text-xs text-muted-foreground mt-1">例如週二僅開放 17:00-21:00，週三開放 13:00-21:00。留空則使用模版的預設時段。</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** 24 小時制時間選擇器 */
export function TimeSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className || "w-24 h-8 text-sm"}>
        <SelectValue placeholder="選擇時間" />
      </SelectTrigger>
      <SelectContent className="max-h-60">
        {TIME_OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
