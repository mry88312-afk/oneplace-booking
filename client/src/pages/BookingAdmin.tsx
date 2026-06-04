import { useState, useEffect, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import {
  Plus, Pencil, Trash2, Copy, CalendarDays, Clock, Users,
  Link as LinkIcon, ChevronRight, ChevronDown, Settings2, FileText,
  Loader2, History, XCircle, Check, Save, Info,
} from "lucide-react";

import { RoutingRuleEditor, TimeSelect, FormFieldEditor, BookingRecordsPanel } from "./BookingAdmin/index";
import type { RoutingRule, FormFieldDef } from "./BookingAdmin/index";

// ─── 常數 ───────────────────────────────────────────────────────────────────────

const DAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

const TEMPLATE_TYPES = [
  { value: "退租", label: "退租" },
  { value: "續約", label: "續約" },
  { value: "看房", label: "看房" },
  { value: "其他", label: "其他" },
];

const SLOT_DURATION_OPTIONS = [
  { value: 30, label: "30 分鐘" },
  { value: 60, label: "60 分鐘" },
  { value: 90, label: "90 分鐘" },
  { value: 120, label: "120 分鐘" },
  { value: 150, label: "150 分鐘" },
  { value: 180, label: "180 分鐘" },
];

const BUFFER_OPTIONS = [
  { value: 0, label: "無間隔" },
  { value: 30, label: "30 分鐘" },
  { value: 60, label: "60 分鐘" },
  { value: 90, label: "90 分鐘" },
  { value: 120, label: "120 分鐘" },
];

const STEPS = [
  { label: "基本資訊", icon: FileText },
  { label: "分流規則", icon: CalendarDays },
  { label: "時段設定", icon: Clock },
  { label: "說明頁", icon: Info },
  { label: "自訂欄位", icon: Settings2 },
];

// ─── 主頁面 ──────────────────────────────────────────────────────────────────────

export default function BookingAdmin({ onLogout }: { onLogout?: () => void }) {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // 表單 state
  const [formProjectId, setFormProjectId] = useState("");
  const [formName, setFormName] = useState("");
  const [formType, setFormType] = useState("退租");
  const [formLiffId, setFormLiffId] = useState("");
  const [formRagicSearchPath, setFormRagicSearchPath] = useState("for-system-use/2");
  const [formRagicUidField, setFormRagicUidField] = useState("ragicTenantUid");
  const [formRagicTaskPath, setFormRagicTaskPath] = useState("go-back/1");
  const [formSlotDuration, setFormSlotDuration] = useState(60);
  const [formBookableDays, setFormBookableDays] = useState(14);
  const [formStartTime, setFormStartTime] = useState("09:00");
  const [formEndTime, setFormEndTime] = useState("18:00");
  const [formBufferMinutes, setFormBufferMinutes] = useState(0);
  const [formBufferDirection, setFormBufferDirection] = useState<"before" | "after" | "both">("after");
  const [formWeeklyHours, setFormWeeklyHours] = useState<Record<string, { start: string; end: string } | null>>({
    "0": null, "1": null, "2": null, "3": null, "4": null, "5": null, "6": null,
  });
  const [formRules, setFormRules] = useState<RoutingRule[]>([]);
  const [formFields, setFormFields] = useState<FormFieldDef[]>([]);
  const [formInstructionEnabled, setFormInstructionEnabled] = useState(false);
  const [formInstructionText, setFormInstructionText] = useState("");
  const [formMinLeadDays, setFormMinLeadDays] = useState(0);

  // 步驟控制
  const [step, setStep] = useState(0);
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const autoSaveTimerRef2 = useRef<ReturnType<typeof setTimeout> | null>(null);

  const templatesQuery = trpc.booking.listTemplates.useQuery();
  const createMutation = trpc.booking.createTemplate.useMutation({
    onSuccess: () => { toast.success("預約模版建立成功"); setShowCreateDialog(false); resetForm(); templatesQuery.refetch(); },
    onError: (err) => toast.error(err.message),
  });
  const updateMutation = trpc.booking.updateTemplate.useMutation({
    onSuccess: () => { toast.success("預約模版更新成功"); templatesQuery.refetch(); },
    onError: (err) => toast.error(err.message),
  });
  const autoSaveMutation = trpc.booking.updateTemplate.useMutation({
    onSuccess: () => {
      setAutoSaveStatus("saved");
      if (autoSaveTimerRef2.current) clearTimeout(autoSaveTimerRef2.current);
      autoSaveTimerRef2.current = setTimeout(() => setAutoSaveStatus("idle"), 3000);
      templatesQuery.refetch();
    },
    onError: () => {
      setAutoSaveStatus("error");
      if (autoSaveTimerRef2.current) clearTimeout(autoSaveTimerRef2.current);
      autoSaveTimerRef2.current = setTimeout(() => setAutoSaveStatus("idle"), 3000);
    },
  });
  const autoCreateMutation = trpc.booking.createTemplate.useMutation({
    onSuccess: (data) => {
      setEditingId(data.id);
      setAutoSaveStatus("saved");
      if (autoSaveTimerRef2.current) clearTimeout(autoSaveTimerRef2.current);
      autoSaveTimerRef2.current = setTimeout(() => setAutoSaveStatus("idle"), 3000);
      templatesQuery.refetch();
    },
    onError: (err) => {
      setAutoSaveStatus("error"); toast.error("自動儲存失敗：" + err.message);
      if (autoSaveTimerRef2.current) clearTimeout(autoSaveTimerRef2.current);
      autoSaveTimerRef2.current = setTimeout(() => setAutoSaveStatus("idle"), 3000);
    },
  });
  const deleteMutation = trpc.booking.deleteTemplate.useMutation({
    onSuccess: () => { toast.success("已刪除"); setDeleteConfirmId(null); templatesQuery.refetch(); },
    onError: (err) => toast.error(err.message),
  });
  const toggleActiveMutation = trpc.booking.updateTemplate.useMutation({
    onSuccess: () => { toast.success("狀態已更新"); templatesQuery.refetch(); },
    onError: (err) => toast.error(err.message),
  });

  const [expandedRecordId, setExpandedRecordId] = useState<number | null>(null);

  const resetForm = () => {
    setFormProjectId(""); setFormName(""); setFormType("退租"); setFormLiffId("");
    setFormRagicSearchPath("for-system-use/2"); setFormRagicUidField("ragicTenantUid"); setFormRagicTaskPath("go-back/1");
    setFormSlotDuration(60); setFormBookableDays(14); setFormStartTime("09:00"); setFormEndTime("18:00");
    setFormBufferMinutes(0); setFormBufferDirection("after");
    setFormWeeklyHours({ "0": null, "1": null, "2": null, "3": null, "4": null, "5": null, "6": null });
    setFormRules([]); setFormFields([]); setFormInstructionEnabled(false); setFormInstructionText(""); setFormMinLeadDays(0); setStep(0); setAutoSaveStatus("idle");
  };

  const buildPayload = useCallback(() => ({
    projectId: formProjectId.trim(), name: formName.trim(), templateType: formType,
    liffId: formLiffId.trim() || undefined,
    ragicSearchPath: formRagicSearchPath.trim(), ragicUidField: formRagicUidField.trim(), ragicTaskPath: formRagicTaskPath.trim(),
    slotDurationMinutes: formSlotDuration, bookableDaysAhead: formBookableDays,
    dailyStartTime: formStartTime, dailyEndTime: formEndTime,
    bufferMinutes: formBufferMinutes, bufferDirection: formBufferDirection,
    weeklyHours: formWeeklyHours,
    instructionEnabled: formInstructionEnabled, instructionText: formInstructionText || undefined,
    minLeadDays: formMinLeadDays,
    rules: formRules,
    fields: formFields.filter((f) => {
      if (f.fieldType === "description") return true; // always keep description fields
      if (f.fieldType === "line_uid" || f.fieldType === "inbox_url") return true; // system fields don't need a label
      return f.label.trim().length > 0;
    }).map((f) => ({
      ...f, options: f.options && f.options.length > 0 ? f.options : undefined,
      ragicFieldId: f.ragicFieldId || undefined, descriptionText: f.descriptionText || undefined,
    })),
  }), [formProjectId, formName, formType, formLiffId, formRagicSearchPath, formRagicUidField, formRagicTaskPath, formSlotDuration, formBookableDays, formStartTime, formEndTime, formBufferMinutes, formBufferDirection, formWeeklyHours, formInstructionEnabled, formInstructionText, formMinLeadDays, formRules, formFields]);

  const doAutoSave = useCallback(() => {
    const payload = buildPayload();
    if (editingId) {
      setAutoSaveStatus("saving"); autoSaveMutation.mutate({ id: editingId, ...payload });
    } else {
      if (!payload.projectId || !payload.name) { toast.error("請先填寫專案 ID 和專案名稱"); return false; }
      if (payload.rules.length === 0) {
        payload.rules = [{ days: [1, 2, 3, 4, 5], calendarId: "placeholder", ownerName: "待設定", calendarLabel: null, weeklyStartTime: null, weeklyEndTime: null }];
      }
      setAutoSaveStatus("saving"); autoCreateMutation.mutate(payload as any);
    }
    return true;
  }, [editingId, buildPayload, autoSaveMutation, autoCreateMutation]);

  const handleStepChange = useCallback((targetStep: number) => {
    if (targetStep > step) {
      if (step === 0 && (!formProjectId.trim() || !formName.trim())) { toast.error("請先填寫專案 ID 和專案名稱"); return; }
      if (step === 1 && formRules.length === 0) { toast.error("請至少設定一條分流規則"); return; }
      if (step === 1) {
        for (const rule of formRules) {
          if (rule.days.length === 0) { toast.error("每條規則至少選擇一天"); return; }
          if (!rule.calendarId.trim()) { toast.error("請填寫 Calendar ID"); return; }
          if (!rule.ownerName.trim()) { toast.error("請填寫負責人"); return; }
        }
      }
      doAutoSave();
    }
    setStep(targetStep);
  }, [step, formProjectId, formName, formRules, doAutoSave]);

  const openCreate = () => { resetForm(); setEditingId(null); setShowCreateDialog(true); };
  const openEdit = (id: number) => { setEditingId(id); setShowCreateDialog(true); setStep(0); };

  const editQuery = trpc.booking.getTemplate.useQuery(
    { id: editingId! },
    { enabled: editingId !== null && showCreateDialog }
  );

  useEffect(() => {
    const data = editQuery.data;
    if (!data || editingId === null) return;
    setFormProjectId(data.projectId); setFormName(data.name); setFormType(data.templateType);
    setFormLiffId(data.liffId || "");
    setFormRagicSearchPath(data.ragicSearchPath); setFormRagicUidField(data.ragicUidField); setFormRagicTaskPath(data.ragicTaskPath);
    setFormSlotDuration(data.slotDurationMinutes); setFormBookableDays(data.bookableDaysAhead);
    setFormStartTime(data.dailyStartTime); setFormEndTime(data.dailyEndTime);
    setFormBufferMinutes(data.bufferMinutes ?? 0); setFormBufferDirection((data as any).bufferDirection || "after");
    if ((data as any).weeklyHours) {
      setFormWeeklyHours((data as any).weeklyHours);
    } else {
      const wh: Record<string, { start: string; end: string } | null> = {};
      for (let d = 0; d <= 6; d++) wh[String(d)] = { start: data.dailyStartTime, end: data.dailyEndTime };
      setFormWeeklyHours(wh);
    }
    setFormRules(data.rules.map((r: any) => ({
      days: r.days as number[], calendarId: r.calendarId, calendarLabel: r.calendarLabel || null,
      ownerName: r.ownerName, weeklyStartTime: r.weeklyStartTime || null, weeklyEndTime: r.weeklyEndTime || null,
    })));
    setFormFields(data.fields.map((f: any, i: number) => ({
      id: f.id || `field-loaded-${i}-${Date.now()}`,
      fieldType: f.fieldType, label: f.label, isRequired: f.isRequired,
      options: f.options as string[] | undefined, ragicFieldId: f.ragicFieldId || undefined,
      descriptionText: f.descriptionText || undefined,
      allowOther: f.allowOther ?? false,
      selectionMode: (f.selectionMode as "radio" | "checkbox") ?? "checkbox",
    })));
    setFormInstructionEnabled((data as any).instructionEnabled ?? false);
    setFormInstructionText((data as any).instructionText || "");
    setFormMinLeadDays((data as any).minLeadDays ?? 0);
  }, [editQuery.data, editingId]);

  const handleSave = () => {
    if (!formProjectId.trim()) return toast.error("請填寫專案 ID");
    if (!formName.trim()) return toast.error("請填寫專案名稱");
    if (formRules.length === 0) return toast.error("請至少設定一條分流規則");
    for (const rule of formRules) {
      if (rule.days.length === 0) return toast.error("每條規則至少選擇一天");
      if (!rule.calendarId.trim()) return toast.error("請填寫 Calendar ID");
      if (!rule.ownerName.trim()) return toast.error("請填寫負責人");
    }
    const payload = buildPayload();
    if (editingId) updateMutation.mutate({ id: editingId, ...payload });
    else createMutation.mutate(payload as any);
  };

  const copyBookingUrl = (projectId: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/book/${projectId}`);
    toast.success("預約連結已複製");
  };

  // 指定時段連結 Dialog state
  const [presetDialog, setPresetDialog] = useState<{ open: boolean; projectId: string; liffId?: string } | null>(null);
  const [presetDate, setPresetDate] = useState("");
  const [presetHour, setPresetHour] = useState("10");
  const [presetMinute, setPresetMinute] = useState("00");
  const [presetGeneratedUrl, setPresetGeneratedUrl] = useState("");

  const generatePresetUrl = () => {
    if (!presetDate || !presetDialog) { toast.error("請選擇日期"); return; }
    const [, m, d] = presetDate.split("-");
    if (!m || !d) { toast.error("日期格式錯誤"); return; }
    // 使用 8 碼格式 MMDDHHMM（後端自動補年份）
    const t = `${m}${d}${presetHour.padStart(2, "0")}${presetMinute.padStart(2, "0")}`;
    const liffId = presetDialog.liffId;
    if (liffId) {
      setPresetGeneratedUrl(`https://liff.line.me/${liffId}?t=${t}`);
    } else {
      setPresetGeneratedUrl(`${window.location.origin}/book/${presetDialog.projectId}?t=${t}`);
    }
  };

  const copyPresetUrl = () => {
    if (!presetGeneratedUrl) return;
    navigator.clipboard.writeText(presetGeneratedUrl);
    toast.success("連結已複製");
  };

  const templates = templatesQuery.data || [];

  return (
      <div className="container max-w-5xl mx-auto py-6 space-y-6 px-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">預約管理</h1>
            <p className="text-sm text-muted-foreground mt-1">建立和管理租務預約模版，產生預約連結供租客使用</p>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> 新增模版</Button>
            {onLogout && (
              <Button variant="outline" size="sm" onClick={onLogout}>登出</Button>
            )}
          </div>
        </div>

        {/* 模版列表 */}
        {templates.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16">
              <CalendarDays className="h-12 w-12 text-muted-foreground/40 mb-4" />
              <p className="text-muted-foreground">尚未建立任何預約模版</p>
              <Button variant="outline" className="mt-4" onClick={openCreate}><Plus className="h-4 w-4 mr-2" /> 建立第一個模版</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {templates.map((t) => (
              <Card key={t.id} className="hover:shadow-md transition-shadow">
                <CardContent className="py-4">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold text-lg">{t.name}</h3>
                        <Badge variant={t.isActive ? "default" : "secondary"}>{t.isActive ? "啟用中" : "已停用"}</Badge>
                        <Badge variant="outline">{t.templateType}</Badge>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-muted-foreground mt-2">
                        <span className="flex items-center gap-1"><LinkIcon className="h-3 w-3" /> {t.projectId}</span>
                        <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {t.slotDurationMinutes} 分鐘/時段</span>
                        <span className="flex items-center gap-1"><CalendarDays className="h-3 w-3" /> {t.dailyStartTime} - {t.dailyEndTime}</span>
                      </div>
                      {t.liffId && <div className="text-xs text-muted-foreground mt-1">LIFF ID: {t.liffId}</div>}
                    </div>
                    <div className="flex items-center gap-2 ml-4">
                      <Switch checked={t.isActive} onCheckedChange={(checked) => toggleActiveMutation.mutate({ id: t.id, isActive: checked })} aria-label="啟用/停用" />
                      <Button variant="outline" size="sm" onClick={() => copyBookingUrl(t.projectId)}><Copy className="h-3 w-3 mr-1" /> 複製連結</Button>
                      <Button variant="outline" size="sm" onClick={() => { setPresetDialog({ open: true, projectId: t.projectId, liffId: t.liffId || undefined }); setPresetDate(""); setPresetHour("10"); setPresetMinute("00"); setPresetGeneratedUrl(""); }}>
                        <CalendarDays className="h-3 w-3 mr-1" /> 指定時段
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => openEdit(t.id)}><Pencil className="h-3 w-3 mr-1" /> 編輯</Button>
                      <Button variant="outline" size="sm" onClick={() => setExpandedRecordId(expandedRecordId === t.id ? null : t.id)}>
                        <History className="h-3 w-3 mr-1" /> 預約記錄
                        {expandedRecordId === t.id ? <ChevronDown className="h-3 w-3 ml-1" /> : <ChevronRight className="h-3 w-3 ml-1" />}
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteConfirmId(t.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                  {expandedRecordId === t.id && <BookingRecordsPanel templateId={t.id} />}
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* 建立/編輯 Dialog */}
        <Dialog open={showCreateDialog} onOpenChange={(v) => { if (!v) { setShowCreateDialog(false); setEditingId(null); resetForm(); } }}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editingId ? "編輯預約模版" : "新增預約模版"}</DialogTitle>
              <DialogDescription>設定預約規則，完成後可產生預約連結</DialogDescription>
            </DialogHeader>

            {/* Stepper */}
            <div className="flex items-center gap-2 py-2">
              {STEPS.map((s, i) => {
                const Icon = s.icon;
                return (
                  <button key={i} type="button"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${step === i ? "bg-primary text-primary-foreground" : step > i ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                    onClick={() => handleStepChange(i)}>
                    <Icon className="h-3 w-3" /> {s.label}
                    {i < STEPS.length - 1 && <ChevronRight className="h-3 w-3 ml-1 text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
            <Separator />

            {/* Step 0: 基本資訊 */}
            {step === 0 && (
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>專案 ID（URL slug）</Label>
                    <Input placeholder="例：checkout-001" value={formProjectId} onChange={(e) => setFormProjectId(e.target.value)} disabled={!!editingId} className="mt-1" />
                    <p className="text-xs text-muted-foreground mt-1">用於產生預約連結：/book/{formProjectId || "xxx"}</p>
                  </div>
                  <div>
                    <Label>專案名稱</Label>
                    <Input placeholder="例：退租預約" value={formName} onChange={(e) => setFormName(e.target.value)} className="mt-1" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>模版類型</Label>
                    <Select value={formType} onValueChange={setFormType}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TEMPLATE_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>LIFF ID（選填）</Label>
                    <Input placeholder="例：1234567890-abcdefgh" value={formLiffId} onChange={(e) => setFormLiffId(e.target.value)} className="mt-1" />
                    <p className="text-xs text-muted-foreground mt-1">LINE LIFF 連結用，可稍後設定</p>
                  </div>
                </div>
                <Separator />
                <div>
                  <h4 className="text-sm font-semibold mb-3">Ragic 設定</h4>
                  <div className="grid grid-cols-2 gap-4">
                    <div><Label className="text-xs">驗證用表路徑</Label><Input value={formRagicSearchPath} onChange={(e) => setFormRagicSearchPath(e.target.value)} className="mt-1 text-sm" /></div>
                    <div><Label className="text-xs">UID 欄位名稱</Label><Input value={formRagicUidField} onChange={(e) => setFormRagicUidField(e.target.value)} className="mt-1 text-sm" /></div>
                    <div className="col-span-2"><Label className="text-xs">任務寫入表路徑</Label><Input value={formRagicTaskPath} onChange={(e) => setFormRagicTaskPath(e.target.value)} className="mt-1 text-sm" /></div>
                  </div>
                </div>
              </div>
            )}

            {/* Step 1: 分流規則 */}
            {step === 1 && (
              <div className="py-2">
                <RoutingRuleEditor rules={formRules} onChange={setFormRules} onSave={handleSave} />
              </div>
            )}

            {/* Step 2: 時段設定 */}
            {step === 2 && (
              <div className="space-y-4 py-2">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>時段長度</Label>
                    <Select value={String(formSlotDuration)} onValueChange={(v) => setFormSlotDuration(Number(v))}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>{SLOT_DURATION_OPTIONS.map((opt) => <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>可預約天數（從今天起算）</Label>
                    <Input type="number" min={1} max={90} value={formBookableDays} onChange={(e) => setFormBookableDays(Number(e.target.value))} className="mt-1" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>最早預約天數</Label>
                    <Input type="number" min={0} max={30} value={formMinLeadDays} onChange={(e) => setFormMinLeadDays(Number(e.target.value))} className="mt-1" />
                    <p className="text-xs text-muted-foreground mt-1">填 2 表示今天起算跳過 2 天，從第 3 天才可預約（T+2）</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>行程間隔時間</Label>
                    <Select value={String(formBufferMinutes)} onValueChange={(v) => setFormBufferMinutes(Number(v))}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>{BUFFER_OPTIONS.map((opt) => <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>)}</SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">預約之間的緩衝時間</p>
                  </div>
                  <div>
                    <Label>緩衝方向</Label>
                    <Select value={formBufferDirection} onValueChange={(v) => setFormBufferDirection(v as "before" | "after" | "both")}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="after">事件後（交通時間）</SelectItem>
                        <SelectItem value="before">事件前（準備時間）</SelectItem>
                        <SelectItem value="both">雙向（前後都加）</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">緩衝時間要加在日曆事件的哪個方向</p>
                  </div>
                </div>
                {/* 每週時段設定 */}
                <div>
                  <Label className="mb-2 block">每週可預約時段</Label>
                  <p className="text-xs text-muted-foreground mb-3">設定每個星期的可預約時段，未設定的星期將不開放預約</p>
                  <div className="space-y-2">
                    {[0, 1, 2, 3, 4, 5, 6].map((day) => {
                      const config = formWeeklyHours[String(day)];
                      const isEnabled = config !== null && config !== undefined;
                      return (
                        <div key={day} className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${isEnabled ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                            {DAY_LABELS[day]}
                          </div>
                          <Switch checked={isEnabled} onCheckedChange={(checked) => {
                            setFormWeeklyHours(prev => ({ ...prev, [String(day)]: checked ? { start: formStartTime || "09:00", end: formEndTime || "18:00" } : null }));
                          }} />
                          {isEnabled ? (
                            <div className="flex items-center gap-2 flex-1">
                              <TimeSelect value={config!.start} onChange={(v) => setFormWeeklyHours(prev => ({ ...prev, [String(day)]: { ...prev[String(day)]!, start: v } }))} />
                              <span className="text-muted-foreground text-sm">-</span>
                              <TimeSelect value={config!.end} onChange={(v) => setFormWeeklyHours(prev => ({ ...prev, [String(day)]: { ...prev[String(day)]!, end: v } }))} />
                            </div>
                          ) : <span className="text-sm text-muted-foreground">不開放</span>}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">台北時間 (UTC+8)</p>
                </div>
                <Card className="bg-muted/50">
                  <CardContent className="py-3">
                    <p className="text-sm text-muted-foreground">
                      預覽：每 {formSlotDuration} 分鐘一個時段（每 15 分鐘一個預約點），
                      租客可預約未來 {formBookableDays} 天內的時段。
                      {formBufferMinutes > 0 && `行程間隔 ${formBufferMinutes} 分鐘（${formBufferDirection === "after" ? "事件後" : formBufferDirection === "before" ? "事件前" : "雙向"}）。`}
                      所有日曆都有空才可預約。
                      開放星期：{[0,1,2,3,4,5,6].filter(d => formWeeklyHours[String(d)] !== null && formWeeklyHours[String(d)] !== undefined).map(d => `週${DAY_LABELS[d]}`).join("、") || "無"}
                    </p>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Step 3: 說明頁 */}
            {step === 3 && (
              <div className="space-y-4 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm font-semibold">預約說明頁</Label>
                    <p className="text-xs text-muted-foreground mt-1">開啟後，租客預約完時段後會先看到這段說明，按「下一步」才進入自訂欄位問題</p>
                  </div>
                  <Switch checked={formInstructionEnabled} onCheckedChange={setFormInstructionEnabled} />
                </div>
                {formInstructionEnabled && (
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">說明內容</Label>
                    <textarea
                      placeholder="輸入要顯示給租客的說明文字... 例如：「請在預約時間前 10 分鐘到達現場，並攜帶身分證」"
                      value={formInstructionText}
                      onChange={(e) => setFormInstructionText(e.target.value)}
                      className="w-full text-sm border rounded-md p-3 min-h-[160px] resize-y bg-background"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Step 4: 自訂欄位 */}
            {step === 4 && (
              <div className="py-2">
                <FormFieldEditor fields={formFields} onChange={setFormFields} />
              </div>
            )}

            <DialogFooter className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                {step > 0 && <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>上一步</Button>}
                {autoSaveStatus === "saving" && <span className="flex items-center gap-1.5 text-xs text-muted-foreground animate-pulse"><Loader2 className="h-3 w-3 animate-spin" /> 儲存中...</span>}
                {autoSaveStatus === "saved" && <span className="flex items-center gap-1.5 text-xs text-green-600"><Check className="h-3 w-3" /> 已自動儲存</span>}
                {autoSaveStatus === "error" && <span className="flex items-center gap-1.5 text-xs text-red-500"><XCircle className="h-3 w-3" /> 儲存失敗</span>}
              </div>
              <div className="flex gap-2">
                {editingId && (
                  <Button type="button" variant="outline" size="sm" onClick={() => doAutoSave()} disabled={autoSaveMutation.isPending}>
                    <Save className="h-3.5 w-3.5 mr-1" /> 儲存
                  </Button>
                )}
                {step < STEPS.length - 1 ? (
                  <Button type="button" onClick={() => handleStepChange(step + 1)} disabled={autoSaveMutation.isPending || autoCreateMutation.isPending}>
                    {autoSaveMutation.isPending || autoCreateMutation.isPending ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" />儲存並繼續...</> : "下一步"}
                  </Button>
                ) : (
                  <Button type="button" onClick={handleSave} disabled={createMutation.isPending || updateMutation.isPending}>
                    {createMutation.isPending || updateMutation.isPending ? "儲存中..." : editingId ? "更新模版" : "建立模版"}
                  </Button>
                )}
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 指定時段連結 Dialog */}
        <Dialog open={!!presetDialog?.open} onOpenChange={(v) => { if (!v) setPresetDialog(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>產生指定時段連結</DialogTitle>
              <DialogDescription>管理員指定日期與時間，租客點連結後直接進入問卷頁，跳過日曆選擇步驟</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-sm font-medium">日期</Label>
                <Input type="date" value={presetDate} onChange={(e) => { setPresetDate(e.target.value); setPresetGeneratedUrl(""); }} className="mt-1" />
              </div>
              <div>
                <Label className="text-sm font-medium">開始時間（台北時間）</Label>
                <div className="flex items-center gap-2 mt-1">
                  <Select value={presetHour} onValueChange={(v) => { setPresetHour(v); setPresetGeneratedUrl(""); }}>
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => (
                        <SelectItem key={h} value={h}>{h} 時</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground">:</span>
                  <Select value={presetMinute} onValueChange={(v) => { setPresetMinute(v); setPresetGeneratedUrl(""); }}>
                    <SelectTrigger className="w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {["00", "15", "30", "45"].map((m) => (
                        <SelectItem key={m} value={m}>{m} 分</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {presetDialog?.liffId && (
                <div className="text-xs text-muted-foreground p-2 bg-muted rounded-md">
                  將使用 LIFF 連結：https://liff.line.me/{presetDialog.liffId}?t=...
                </div>
              )}
              {!presetDialog?.liffId && (
                <div className="text-xs text-amber-600 p-2 bg-amber-50 rounded-md">
                  未設定 LIFF ID，將產生網頁連結（不支援 LINE 驗證）
                </div>
              )}
              <Button className="w-full" onClick={generatePresetUrl} disabled={!presetDate}>
                產生連結
              </Button>
              {presetGeneratedUrl && (
                <div className="space-y-2">
                  <div className="p-3 bg-muted rounded-lg break-all text-sm font-mono select-all">
                    {presetGeneratedUrl}
                  </div>
                  <Button variant="outline" className="w-full" onClick={copyPresetUrl}>
                    <Copy className="h-4 w-4 mr-2" /> 複製連結
                  </Button>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* 刪除確認 Dialog */}
        <Dialog open={deleteConfirmId !== null} onOpenChange={() => setDeleteConfirmId(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>確認刪除</DialogTitle>
              <DialogDescription>刪除後將無法復原，相關的預約記錄仍會保留。</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>取消</Button>
              <Button variant="destructive" onClick={() => deleteConfirmId && deleteMutation.mutate({ id: deleteConfirmId })} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? "刪除中..." : "確認刪除"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
  );
}
