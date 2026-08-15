import React, { useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Clock, CheckCircle2, ChevronLeft, ChevronRight, Loader2, AlertCircle,
  MapPin, Upload, FileText, X, Globe, Phone, User, CalendarPlus,
  AlertTriangle, XCircle, Home,
} from "lucide-react";
import {
  BookingContainer, SuccessAnimation, LiffFailedAutoRedirect,
  formatTime, getWeekdayName, getDateDisplay, getDateDisplayFull,
  getTaipeiTimeStr, buildGoogleCalendarUrl,
  isFieldVisible, resolveFieldOptions, monthsBetweenYmd,
  type PageView,
} from "./utils";
import { BookingCalendar } from "./BookingCalendar";
import { linkifyText } from "@/lib/linkify";

// ─── Verify View ─────────────────────────────────────────────────────────────

interface VerifyViewProps {
  template: any;
  liffReady: boolean;
  liffError: string | null;
  uidFromUrl: string;
  lineUserId: string | null;
  isVerifying: boolean;
  verifyMutation: any;
  setView: (v: PageView) => void;
  handleVerify: () => void;
}

export function VerifyView({
  template, liffReady, liffError, uidFromUrl, lineUserId,
  isVerifying, verifyMutation, setView, handleVerify,
}: VerifyViewProps) {
  return (
    <BookingContainer>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-[#6B8E6B] rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">{template.name}</h1>
            <div className="flex items-center justify-center gap-2 text-sm text-gray-500 mt-3">
              <Clock className="h-4 w-4" /><span>{template.slotDurationMinutes} 分鐘</span>
            </div>
          </div>

          {template?.liffId && !liffReady && !liffError && (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-[#6B8E6B] mb-4" />
              <p className="text-sm text-gray-500">正在連線 LINE...</p>
            </div>
          )}

          {!uidFromUrl && !lineUserId && liffError && (
            <LiffFailedAutoRedirect error={liffError} onRedirect={() => setView("phone")} />
          )}

          {!uidFromUrl && !lineUserId && !template?.liffId && (
            <div className="flex flex-col items-center py-8">
              <Phone className="h-8 w-8 text-[#6B8E6B] mb-4" />
              <p className="text-sm text-gray-600 text-center mb-4">請輸入留存於一方的電話號碼進行驗證</p>
              <Button className="rounded-full bg-[#6B8E6B] hover:bg-[#5A7A5A]" onClick={() => setView("phone")}>輸入電話號碼</Button>
            </div>
          )}

          {(isVerifying || verifyMutation.isPending) && (
            <div className="flex flex-col items-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-[#6B8E6B] mb-4" />
              <p className="text-sm text-gray-500">正在驗證身份...</p>
            </div>
          )}

          {verifyMutation.isError && verifyMutation.error?.message !== "NEED_PHONE" && (
            <div className="flex flex-col items-center py-8">
              <AlertCircle className="h-8 w-8 text-red-400 mb-4" />
              <p className="text-sm text-red-500 mb-4">{verifyMutation.error?.message || "驗證失敗"}</p>
              <Button variant="outline" className="rounded-full" onClick={handleVerify}>重試</Button>
            </div>
          )}
        </div>
      </div>
    </BookingContainer>
  );
}

// ─── Select Room View ─────────────────────────────────────────────────────────
// P96：一人有多筆有效合約（例如同時是某房主客2＋另一房主客1）時，讓租客選這次要處理哪一間，
//   避免自動抓「最新那份」而退錯/續錯房。residences 由 verify 回傳（Supabase legacy_snapshot 反查）。

interface SelectRoomViewProps {
  templateType: string;
  residences: Array<{ contractNo: string; room: string; property: string | null; tenantCount: number }>;
  onPick: (index: number) => void;
}

export function SelectRoomView({ templateType, residences, onPick }: SelectRoomViewProps) {
  return (
    <BookingContainer>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-[#6B8E6B] rounded-full flex items-center justify-center mx-auto mb-4">
              <Home className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">選擇要{templateType}的房間</h1>
            <p className="text-sm text-gray-500 mt-2">您名下有多筆有效合約，請選擇這次要{templateType}的房間</p>
          </div>
          <div className="space-y-3">
            {residences.map((r, i) => (
              <button
                key={r.contractNo || i}
                type="button"
                className="w-full text-left px-5 py-4 rounded-lg border-2 border-[#6B8E6B]/30 hover:border-[#6B8E6B] hover:bg-[#6B8E6B]/5 transition-all"
                onClick={() => onPick(i)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-base font-bold text-gray-900">{r.room || "—"}</div>
                    <div className="text-sm text-gray-500 mt-0.5">
                      {r.property || ""}{r.contractNo ? ` · ${r.contractNo}` : ""}
                    </div>
                    {r.tenantCount > 1 && (
                      <div className="text-xs text-gray-400 mt-1">共同承租（{r.tenantCount} 人）</div>
                    )}
                  </div>
                  <ChevronRight className="h-5 w-5 text-[#6B8E6B] shrink-0" />
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </BookingContainer>
  );
}

// ─── Phone View ──────────────────────────────────────────────────────────────

interface PhoneViewProps {
  phoneInput: string;
  setPhoneInput: (v: string) => void;
  isVerifying: boolean;
  verifyByPhoneMutation: any;
  handlePhoneVerify: () => void;
}

export function PhoneView({ phoneInput, setPhoneInput, isVerifying, verifyByPhoneMutation, handlePhoneVerify }: PhoneViewProps) {
  return (
    <BookingContainer>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-[#6B8E6B] rounded-full flex items-center justify-center mx-auto mb-4">
              <Phone className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">電話驗證</h1>
            <p className="text-sm text-gray-500">請輸入留存於一方的電話號碼</p>
          </div>
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-medium text-gray-700">手機號碼</Label>
              <input type="tel" placeholder="0912345678" value={phoneInput}
                onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 10); setPhoneInput(v); }}
                className="mt-1.5 h-12 text-lg text-center tracking-wider w-full rounded-md border border-input bg-background px-3 py-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                autoFocus />
            </div>
            <Button className="w-full h-12 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base"
              onClick={handlePhoneVerify} disabled={isVerifying || verifyByPhoneMutation.isPending}>
              {isVerifying || verifyByPhoneMutation.isPending ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />查詢中...</>) : "查詢"}
            </Button>
            {verifyByPhoneMutation.isError && (
              <p className="text-sm text-red-500 text-center">
                {verifyByPhoneMutation.error?.message === "PHONE_NOT_FOUND" ? "查無資料，請與我們聯繫" : verifyByPhoneMutation.error?.message}
              </p>
            )}
          </div>
        </div>
      </div>
    </BookingContainer>
  );
}

// ─── Register View ───────────────────────────────────────────────────────────

interface RegisterViewProps {
  phoneInput: string;
  nameInput: string; setNameInput: (v: string) => void;
  locationInput: string; setLocationInput: (v: string) => void;
  roomInput: string; setRoomInput: (v: string) => void;
  isVerifying: boolean;
  registerMutation: any;
  handleRegister: () => void;
  setView: (v: PageView) => void;
}

export function RegisterView({
  phoneInput, nameInput, setNameInput, locationInput, setLocationInput,
  roomInput, setRoomInput, isVerifying, registerMutation, handleRegister, setView,
}: RegisterViewProps) {
  return (
    <BookingContainer>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-14 h-14 bg-amber-500 rounded-full flex items-center justify-center mx-auto mb-4">
              <User className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">建立預約資料</h1>
            <p className="text-sm text-gray-500">查無您的電話號碼，請填寫以下資料以繼續預約</p>
          </div>
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-medium text-gray-700">手機號碼</Label>
              <input type="tel" value={phoneInput} readOnly className="mt-1.5 h-12 text-lg text-center tracking-wider w-full rounded-md border border-input bg-muted px-3 py-2" />
            </div>
            <div>
              <Label className="text-sm font-medium text-gray-700">姓名 <span className="text-red-500">*</span></Label>
              <Input type="text" placeholder="請輸入您的姓名" value={nameInput} onChange={(e) => setNameInput(e.target.value)} className="mt-1.5 h-12" autoFocus />
            </div>
            <div>
              <Label className="text-sm font-medium text-gray-700">居住位置 <span className="text-red-500">*</span></Label>
              <Input type="text" placeholder="例：蘆洲中興130" value={locationInput} onChange={(e) => setLocationInput(e.target.value)} className="mt-1.5 h-12" />
            </div>
            <div>
              <Label className="text-sm font-medium text-gray-700">房間 <span className="text-red-500">*</span></Label>
              <Input type="text" placeholder="例：4-D" value={roomInput} onChange={(e) => setRoomInput(e.target.value)} className="mt-1.5 h-12" />
            </div>
            <Button className="w-full h-12 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base"
              onClick={handleRegister} disabled={isVerifying || registerMutation.isPending}>
              {isVerifying || registerMutation.isPending ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />建立中...</>) : "建立資料並繼續"}
            </Button>
            <button type="button" className="w-full text-sm text-gray-400 hover:text-gray-600 transition-colors py-2" onClick={() => setView("phone")}>返回重新輸入電話</button>
          </div>
        </div>
      </div>
    </BookingContainer>
  );
}

// ─── Calendar View (Select a Day) ────────────────────────────────────────────

interface CalendarViewPageProps {
  template: any;
  tenantName: string; roomNumber: string; propertyName: string; address: string;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  availableDays: number[];
  datesWithSlots: Set<string>;
  multiDayLoaded: boolean;
  multiDayLoading: boolean;
}

export function CalendarViewPage({
  template, tenantName, roomNumber, propertyName, address,
  selectedDate, onSelectDate, availableDays, datesWithSlots, multiDayLoaded, multiDayLoading,
}: CalendarViewPageProps) {
  return (
    <BookingContainer>
      <div className="border-b border-gray-100 px-6 py-5">
        <h1 className="text-lg font-bold text-gray-900">{template.name}</h1>
        <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
          <span className="flex items-center gap-1.5"><Clock className="h-4 w-4" />{template.slotDurationMinutes} 分鐘</span>
        </div>
        {tenantName && (
          <div className="mt-3 p-3 bg-blue-50 rounded-lg">
            <div className="flex items-center gap-2 text-sm"><User className="h-4 w-4 text-[#6B8E6B]" /><span className="font-medium text-gray-900">{tenantName}</span></div>
            {roomNumber && <div className="flex items-center gap-2 text-sm mt-1"><MapPin className="h-4 w-4 text-[#6B8E6B]" /><span className="text-gray-600">{propertyName ? `${propertyName} - ${roomNumber}` : roomNumber}</span></div>}
            {address && <div className="flex items-center gap-2 text-sm mt-1"><MapPin className="h-4 w-4 text-[#6B8E6B]" /><span className="text-gray-600">{address}</span></div>}
          </div>
        )}
      </div>
      <div className="border-b border-gray-100" />
      <div className="flex-1 px-6 py-6 max-w-md mx-auto w-full">
        <h2 className="text-xl font-bold text-gray-900 text-center mb-6">選擇日期</h2>
        {multiDayLoading && (
          <div className="flex items-center justify-center gap-2 mb-4 text-sm text-gray-400">
            <Loader2 className="h-4 w-4 animate-spin" /><span>載入可用時段中...</span>
          </div>
        )}
        <BookingCalendar selectedDate={selectedDate} onSelectDate={onSelectDate}
          availableDays={availableDays} bookableDaysAhead={template.bookableDaysAhead || 14}
          datesWithSlots={datesWithSlots} multiDayLoaded={multiDayLoaded}
          minLeadDays={template.minLeadDays ?? 0} />
        <div className="mt-6 pt-4 border-t border-gray-100">
          <p className="text-sm font-semibold text-gray-700 mb-1">Time zone</p>
          <div className="flex items-center gap-2 text-sm text-gray-500"><Globe className="h-4 w-4" /><span>Taipei Time ({getTaipeiTimeStr()})</span></div>
        </div>
      </div>
    </BookingContainer>
  );
}

// ─── Slots View ──────────────────────────────────────────────────────────────

interface SlotsViewProps {
  template: any;
  selectedDate: string;
  selectedSlot: any;
  slotsQuery: any;
  onSelectSlot: (slot: any) => void;
  onConfirmSlot: () => void;
  setView: (v: PageView) => void;
  setSelectedSlot: (s: any) => void;
  isBooking?: boolean;
}

export function SlotsView({
  template, selectedDate, selectedSlot, slotsQuery,
  onSelectSlot, onConfirmSlot, setView, setSelectedSlot, isBooking = false,
}: SlotsViewProps) {
  const availableSlots = (slotsQuery.data?.slots || []).filter((s: any) => s.available);

  return (
    <BookingContainer>
      <div className="px-6 py-5">
        <button type="button" className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors mb-4"
          onClick={() => { setView("calendar"); setSelectedSlot(null); }}>
          <ChevronLeft className="h-5 w-5 text-gray-600" />
        </button>
        <div className="text-center"><h2 className="text-2xl font-bold text-gray-900">{getDateDisplayFull(selectedDate)}</h2></div>
      </div>
      <div className="px-6 pb-4">
        <p className="text-sm font-semibold text-gray-700 mb-1">Time zone</p>
        <div className="flex items-center gap-2 text-sm text-gray-500"><Globe className="h-4 w-4" /><span>Taipei Time ({getTaipeiTimeStr()})</span></div>
      </div>
      <div className="border-b border-gray-100" />
      <div className="flex-1 px-6 py-6 max-w-md mx-auto w-full">
        <h3 className="text-xl font-bold text-gray-900 text-center mb-2">Select a Time</h3>
        <p className="text-sm text-gray-500 text-center mb-6">Duration: {template.slotDurationMinutes} min</p>
        {slotsQuery.isLoading ? (
          <div className="flex flex-col items-center py-12"><Loader2 className="h-7 w-7 animate-spin text-[#6B8E6B] mb-3" /><p className="text-sm text-gray-500">查詢可用時段中...</p></div>
        ) : slotsQuery.error ? (
          <div className="text-center py-12">
            <AlertCircle className="h-8 w-8 text-red-400 mx-auto mb-3" />
            <p className="text-sm text-red-500 mb-3">{slotsQuery.error.message}</p>
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => slotsQuery.refetch()}>重試</Button>
          </div>
        ) : availableSlots.length === 0 ? (
          <div className="text-center py-12">
            <Clock className="h-8 w-8 text-gray-300 mx-auto mb-3" /><p className="text-sm text-gray-500">該日期無可用時段</p>
            <Button variant="outline" size="sm" className="mt-4 rounded-full" onClick={() => { setView("calendar"); setSelectedSlot(null); }}>選擇其他日期</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {availableSlots.map((slot: any, i: number) => {
              const isSelected = selectedSlot?.startTime === slot.startTime;
              return (
                <div key={i} className="flex gap-2">
                  <button type="button"
                    className={`flex-1 py-4 rounded-lg border-2 text-base font-bold transition-all
                      ${isSelected ? "border-[#6B8E6B] bg-[#6B8E6B]/5 text-[#6B8E6B]" : "border-[#6B8E6B]/30 text-[#6B8E6B] hover:border-[#6B8E6B] hover:bg-[#6B8E6B]/5"}`}
                    onClick={() => onSelectSlot(slot)}>
                    {formatTime(slot.startTime)}
                  </button>
                  {isSelected && (
                    <button type="button" disabled={isBooking}
                      className="px-6 py-4 rounded-lg bg-[#6B8E6B] text-white font-bold text-base transition-all hover:bg-[#5A7A5A] disabled:opacity-60 disabled:cursor-not-allowed"
                      style={{ animation: "fadeInUp 0.2s ease-out" }} onClick={onConfirmSlot}>{isBooking ? "處理中…" : "Confirm"}</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <style>{`@keyframes fadeInUp { from { opacity: 0; transform: translateX(8px); } to { opacity: 1; transform: translateX(0); } }`}</style>
    </BookingContainer>
  );
}

// ─── Form View ───────────────────────────────────────────────────────────────

interface FormViewProps {
  template: any;
  selectedDate: string;
  confirmedSlot: any;
  calendarOwner: string;
  formAnswers: Record<string, string>;
  setFormAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  fileUploads: Record<string, { name: string; url: string }>;
  setFileUploads: React.Dispatch<React.SetStateAction<Record<string, { name: string; url: string }>>>;
  isUploading: string | null;
  isBooking: boolean;
  handleFileUpload: (fieldLabel: string, file: File) => void;
  handleConfirmBooking: () => void;
  setView: (v: PageView) => void;
  setConfirmedSlot: (s: any) => void;
  isPreset?: boolean;
  // 線上續約：合約到期日選擇器（renewalWindow 來自 verify；非續約為 null → 不顯示）
  renewalWindow?: any;
  renewalEndDate?: string;
  setRenewalEndDate?: (v: string) => void;
}

export function FormView({
  template, selectedDate, confirmedSlot, calendarOwner,
  formAnswers, setFormAnswers, fileUploads, setFileUploads,
  isUploading, isBooking, handleFileUpload, handleConfirmBooking,
  setView, setConfirmedSlot, isPreset = false,
  renewalWindow, renewalEndDate, setRenewalEndDate,
}: FormViewProps) {
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // ── 線上續約「合約到期日」狀態 ──
  const rw = renewalWindow && renewalWindow.ok ? renewalWindow : null;
  const rwTooLate = !!(renewalWindow && renewalWindow.tooLate);
  const chosenEnd = renewalEndDate || "";
  const isExtension = !!(rw && chosenEnd && rw.fullYearEndDate && chosenEnd < rw.fullYearEndDate);
  const endOutOfRange = !!(
    rw && chosenEnd &&
    ((rw.minDate && chosenEnd < rw.minDate) || (rw.maxDate && chosenEnd > rw.maxDate))
  );
  const renewalBlocked = rwTooLate || (!!rw && (!chosenEnd || endOutOfRange));
  const durationMonths = rw && chosenEnd && rw.startDate && chosenEnd >= rw.startDate
    ? monthsBetweenYmd(rw.startDate, chosenEnd) : 0;

  // 展延（未滿1年）→ 繳費方式強制鎖「月繳」（與後端一致；後端送出時也會再強制一次）
  useEffect(() => {
    if (isExtension && formAnswers["繳費方式"] !== "月繳") {
      setFormAnswers((prev) => ({ ...prev, 繳費方式: "月繳" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isExtension]);

  // 數字加減欄位（label 含「人數」的 text 欄位）→ 用 stepper 呈現，預設 1
  const isCounterField = (f: any) =>
    f.fieldType === "text" && typeof f.label === "string" && f.label.includes("人數");
  useEffect(() => {
    const counters = (template.fields || []).filter(isCounterField);
    if (counters.length === 0) return;
    setFormAnswers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const f of counters) if (!next[f.label]) { next[f.label] = "1"; changed = true; }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 條件式欄位：依賴答案改變時，清掉「已隱藏欄位」或「選項已失效」的殘留答案。
  // 例：租期 1年→展延後，繳費方式殘留的「年繳」要清掉；隱藏的必填欄位也不該卡住送出。
  useEffect(() => {
    setFormAnswers((prev) => {
      let next = prev;
      let changed = false;
      const ensure = () => { if (!changed) { next = { ...prev }; changed = true; } };
      for (const f of (template.fields || [])) {
        if (!f?.label) continue;
        if (!isFieldVisible(f, prev)) {
          if (prev[f.label] !== undefined) { ensure(); delete next[f.label]; }
          continue;
        }
        if (f.fieldType === "select" && prev[f.label] && !resolveFieldOptions(f, prev).includes(prev[f.label])) {
          ensure(); delete next[f.label];
        }
      }
      return changed ? next : prev;
    });
  }, [formAnswers, template.fields, setFormAnswers]);

  return (
    <BookingContainer>
      <div className="px-6 py-5 border-b border-gray-100">
        {isPreset ? (
          /* 指定時段模式：顯示確認卡片，不顯示返回按鈕 */
          <div className="p-4 bg-[#6B8E6B]/10 border border-[#6B8E6B]/30 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-6 h-6 rounded-full bg-[#6B8E6B] flex items-center justify-center shrink-0">
                <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
              </div>
              <span className="text-sm font-semibold text-[#4A6741]">已為您安排時段</span>
            </div>
            <div className="space-y-1 text-sm text-gray-700 pl-8">
              <div className="flex items-center gap-2"><Clock className="h-3.5 w-3.5 text-gray-400 shrink-0" /><span>{getWeekdayName(selectedDate)}, {getDateDisplay(selectedDate)}</span></div>
              <div className="flex items-center gap-2"><span className="w-3.5 shrink-0" /><span className="font-medium">{formatTime(confirmedSlot.startTime)} – {formatTime(confirmedSlot.endTime)}</span></div>
              {calendarOwner && <div className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5 text-gray-400 shrink-0" /><span>負責人：{calendarOwner}</span></div>}
            </div>
          </div>
        ) : (
          /* 一般模式：返回按鈕 + 時段資訊 */
          <>
            <button type="button" className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors mb-4"
              onClick={() => { setView("slots"); setConfirmedSlot(null); }}>
              <ChevronLeft className="h-5 w-5 text-gray-600" />
            </button>
            <h2 className="text-xl font-bold text-gray-900">確認預約</h2>
            <div className="mt-3 space-y-1.5 text-sm text-gray-600">
              <div className="flex items-center gap-2"><Clock className="h-4 w-4 text-gray-400" /><span>{getWeekdayName(selectedDate)}, {getDateDisplay(selectedDate)}</span></div>
              <div className="flex items-center gap-2"><span className="ml-6">{formatTime(confirmedSlot.startTime)} - {formatTime(confirmedSlot.endTime)}</span></div>
              {calendarOwner && <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-gray-400" /><span>負責人：{calendarOwner}</span></div>}
            </div>
          </>
        )}
      </div>
      <div className="flex-1 px-6 py-6 max-w-md mx-auto w-full">
        <h3 className="text-lg font-bold text-gray-900 mb-4">補充資料</h3>
        <div className="space-y-5">
          {/* 線上續約：合約到期日（開始日固定、預設滿1年、未滿1年=展延、最短1個月、上限案場到期日-15天） */}
          {renewalWindow && (
            <div>
              <Label className="text-sm font-medium text-gray-700">合約到期日<span className="text-red-500 ml-1">*</span></Label>
              {rwTooLate ? (
                <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-sm text-red-700 whitespace-pre-wrap">案場即將到期，無法線上選擇續約到期日，請聯繫專員協助 🙏</p>
                </div>
              ) : rw ? (
                <>
                  <p className="text-xs text-gray-400 mt-0.5">
                    新合約開始日 <span className="font-medium text-gray-600">{getDateDisplay(rw.startDate)}</span>（固定不可變更）；請選到期日，預設為滿一年
                  </p>
                  <input
                    type="date"
                    value={chosenEnd}
                    min={rw.minDate || undefined}
                    max={rw.maxDate || undefined}
                    onChange={(e) => setRenewalEndDate && setRenewalEndDate(e.target.value)}
                    className="mt-1.5 h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B8E6B]"
                  />
                  {chosenEnd && !endOutOfRange && (
                    <p className="text-xs text-gray-500 mt-1.5">
                      合約期間 {getDateDisplay(rw.startDate)} ～ {getDateDisplay(chosenEnd)}（共 {durationMonths} 個月）
                    </p>
                  )}
                  {endOutOfRange && (
                    <p className="text-xs text-red-600 mt-1.5">
                      請選擇 {getDateDisplay(rw.minDate)}{rw.maxDate ? ` ～ ${getDateDisplay(rw.maxDate)}` : " 之後"} 之間的日期
                    </p>
                  )}
                  {isExtension && !endOutOfRange && (
                    <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                      <p className="text-sm text-red-700 whitespace-pre-wrap">⚠️ 未滿一年屬展延，須收取一次性 2,000 元，且僅能選擇「月繳」。</p>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-xs text-gray-400 mt-1.5">（合約到期日將由專員與您後續確認）</p>
              )}
            </div>
          )}
          {(template.fields || []).filter((field: any) => field.fieldType !== "line_uid" && field.fieldType !== "inbox_url" && isFieldVisible(field, formAnswers)).map((field: any) => (
            <div key={field.id}>
              {field.fieldType !== "description" && (
                <Label className="text-sm font-medium text-gray-700">{field.label}{field.isRequired && <span className="text-red-500 ml-1">*</span>}</Label>
              )}
              {/* 小標：非說明欄位若有 descriptionText，顯示為灰色提示 */}
              {field.fieldType !== "description" && field.descriptionText && (
                <p className="text-xs text-gray-400 mt-0.5 whitespace-pre-wrap">{field.descriptionText}</p>
              )}
              {field.fieldType === "description" && (
                field.tone === "danger" ? (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg"><p className="text-sm text-red-700 whitespace-pre-wrap">{linkifyText(field.descriptionText || field.label)}</p></div>
                ) : (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg"><p className="text-sm text-amber-800 whitespace-pre-wrap">{linkifyText(field.descriptionText || field.label)}</p></div>
                )
              )}
              {field.fieldType === "checkbox" && (() => {
                const isRadio = field.selectionMode === "radio";
                const values = isRadio
                  ? [formAnswers[field.label] || ""]
                  : (formAnswers[field.label] || "").split(",").filter(Boolean);
                return (
                  <div className="mt-2">
                    {/* 可多選提示 */}
                    {!isRadio && (
                      <p className="text-xs text-gray-400 mb-2">可多選</p>
                    )}
                    {/* Google Forms 風格群組容器 */}
                    <div className="rounded-xl border border-gray-200 bg-gray-50 divide-y divide-gray-200 overflow-hidden">
                      {((field.options as string[]) || []).map((opt: string) => {
                        const checked = values.includes(opt);
                        return (
                          <label key={opt} className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-100 transition-colors">
                            {isRadio ? (
                              <input type="radio"
                                name={`radio-${field.label}`}
                                checked={checked}
                                onChange={() => setFormAnswers({ ...formAnswers, [field.label]: opt })}
                                className="h-4 w-4 accent-[#6B8E6B] shrink-0" />
                            ) : (
                              <input type="checkbox" checked={checked}
                                onChange={() => {
                                  const next = checked
                                    ? values.filter((v: string) => v !== opt)
                                    : [...values, opt];
                                  setFormAnswers({ ...formAnswers, [field.label]: next.join(",") });
                                }}
                                className="h-4 w-4 rounded accent-[#6B8E6B] shrink-0" />
                            )}
                            <span className="text-sm text-gray-700">{opt}</span>
                          </label>
                        );
                      })}
                      {/* 「其他（自填）」選項（僅多選模式顯示） */}
                      {!isRadio && field.allowOther && (() => {
                        const otherKey = `${field.label}__other`;
                        const otherText = formAnswers[otherKey] || "";
                        const otherChecked = values.includes("__other__");
                        return (
                          <div>
                            <label className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-100 transition-colors">
                              <input type="checkbox" checked={otherChecked}
                                onChange={() => {
                                  const next = otherChecked
                                    ? values.filter((v: string) => v !== "__other__")
                                    : [...values, "__other__"];
                                  setFormAnswers({ ...formAnswers, [field.label]: next.join(",") });
                                }}
                                className="h-4 w-4 rounded accent-[#6B8E6B] shrink-0" />
                              <span className="text-sm text-gray-400 italic">其他</span>
                            </label>
                            {otherChecked && (
                              <div className="px-4 pb-3">
                                <input
                                  type="text"
                                  placeholder="請說明..."
                                  value={otherText}
                                  onChange={(e) => setFormAnswers({ ...formAnswers, [otherKey]: e.target.value })}
                                  className="w-full text-sm border-b border-gray-300 bg-transparent px-0 py-1 focus:outline-none focus:border-[#6B8E6B] placeholder:text-gray-300"
                                />
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}
              {field.fieldType === "text" && (isCounterField(field) ? (
                <div className="mt-1.5 inline-flex items-center rounded-lg border border-input overflow-hidden select-none">
                  <button type="button" aria-label="減少"
                    className="h-11 w-12 text-2xl text-gray-600 hover:bg-gray-100 active:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={(parseInt(formAnswers[field.label] || "1", 10) || 1) <= 1}
                    onClick={() => { const v = Math.max(1, (parseInt(formAnswers[field.label] || "1", 10) || 1) - 1); setFormAnswers({ ...formAnswers, [field.label]: String(v) }); }}>−</button>
                  <div className="h-11 w-16 flex items-center justify-center text-lg font-semibold border-x border-input">{formAnswers[field.label] || "1"}</div>
                  <button type="button" aria-label="增加"
                    className="h-11 w-12 text-2xl text-gray-600 hover:bg-gray-100 active:bg-gray-200"
                    onClick={() => { const v = (parseInt(formAnswers[field.label] || "1", 10) || 1) + 1; setFormAnswers({ ...formAnswers, [field.label]: String(v) }); }}>+</button>
                </div>
              ) : (
                <Input value={formAnswers[field.label] || ""} onChange={(e) => setFormAnswers({ ...formAnswers, [field.label]: e.target.value })} className="mt-1.5 h-11" />
              ))}
              {field.fieldType === "select" && (() => {
                // 展延（未滿1年）時「繳費方式」鎖成月繳、禁止改
                const lockPayment = isExtension && field.label === "繳費方式";
                const opts = lockPayment ? ["月繳"] : resolveFieldOptions(field, formAnswers);
                return (
                  <Select value={lockPayment ? "月繳" : (formAnswers[field.label] || "")} disabled={lockPayment}
                    onValueChange={(v) => setFormAnswers({ ...formAnswers, [field.label]: v })}>
                    <SelectTrigger className="mt-1.5 h-11"><SelectValue placeholder="請選擇" /></SelectTrigger>
                    <SelectContent>{opts.map((opt: string) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}</SelectContent>
                  </Select>
                );
              })()}
              {field.fieldType === "file" && (
                <div className="mt-1.5">
                  <input type="file"
                    accept={template.projectId === "checkout"
                      ? "image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif"
                      : "image/*,application/pdf"}
                    ref={(el) => { fileInputRefs.current[field.label] = el; }} className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.currentTarget.value = "";
                      if (file) handleFileUpload(field.label, file);
                    }} />
                  {fileUploads[field.label] ? (
                    <div className="flex items-center gap-2 p-3 bg-green-50 rounded-lg border border-green-200">
                      <FileText className="h-4 w-4 text-green-600 shrink-0" />
                      <span className="text-sm text-green-700 truncate flex-1">{fileUploads[field.label].name}</span>
                      <button type="button" className="text-gray-400 hover:text-red-500"
                        onClick={() => { setFileUploads((prev: any) => { const next = { ...prev }; delete next[field.label]; return next; }); setFormAnswers((prev: any) => { const next = { ...prev }; delete next[field.label]; return next; }); }}>
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <Button variant="outline" className="w-full h-11" onClick={() => fileInputRefs.current[field.label]?.click()} disabled={isUploading === field.label}>
                      {isUploading === field.label ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />上傳中...</>) : (<><Upload className="h-4 w-4 mr-2" />上傳圖檔</>)}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
        <Button className="w-full h-12 mt-8 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base"
          onClick={handleConfirmBooking} disabled={isBooking || renewalBlocked}>
          {isBooking ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />預約中...</>) : "確認預約"}
        </Button>
      </div>
    </BookingContainer>
  );
}

// ─── Instruction View ─────────────────────────────────────────────────────────────────────────

interface InstructionViewProps {
  template: any;
  selectedDate: string;
  confirmedSlot: any;
  calendarOwner: string;
  onNext: () => void;
  setView: (v: PageView) => void;
  setConfirmedSlot: (s: any) => void;
}

export function InstructionView({
  template, selectedDate, confirmedSlot, calendarOwner,
  onNext, setView, setConfirmedSlot,
}: InstructionViewProps) {
  return (
    <BookingContainer>
      <div className="px-6 py-5 border-b border-gray-100">
        <button type="button" className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-gray-50 transition-colors mb-4"
          onClick={() => { setView("slots"); setConfirmedSlot(null); }}>
          <ChevronLeft className="h-5 w-5 text-gray-600" />
        </button>
        <h2 className="text-xl font-bold text-gray-900">預約說明</h2>
        <div className="mt-3 space-y-1.5 text-sm text-gray-600">
          <div className="flex items-center gap-2"><Clock className="h-4 w-4 text-gray-400" /><span>{getWeekdayName(selectedDate)}, {getDateDisplay(selectedDate)}</span></div>
          <div className="flex items-center gap-2"><span className="ml-6">{formatTime(confirmedSlot.startTime)} - {formatTime(confirmedSlot.endTime)}</span></div>
          {calendarOwner && <div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-gray-400" /><span>負責人：{calendarOwner}</span></div>}
        </div>
      </div>
      <div className="flex-1 px-6 py-6 max-w-md mx-auto w-full">
        <div className="p-5 bg-amber-50 border border-amber-200 rounded-xl">
          <p className="text-sm text-amber-900 whitespace-pre-wrap leading-relaxed">{template.instructionText}</p>
        </div>
        <Button className="w-full h-12 mt-8 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base"
          onClick={onNext}>
          下一步
        </Button>
      </div>
    </BookingContainer>
  );
}

// ─── Cancel View（取消確認 / 已取消）────────────────────────────────────────

interface CancelViewProps {
  templateType: string;
  tenantName: string;
  roomNumber: string;
  currentBookingTime: number; // epoch ms
  isCancelling: boolean;
  cancelled: boolean;
  onConfirm: () => void;
}

function formatEpochTaipei(ms: number): string {
  if (!ms) return "";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
}

export function CancelView({
  templateType, tenantName, roomNumber, currentBookingTime, isCancelling, cancelled, onConfirm,
}: CancelViewProps) {
  if (cancelled) {
    return (
      <BookingContainer>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-sm text-center">
            <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mx-auto mb-5">
              <XCircle className="h-9 w-9 text-gray-400" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">已取消{templateType}</h2>
            <p className="text-sm text-gray-500">您的{templateType}預約已取消，如需重新預約請聯繫一方或重新開啟連結。</p>
          </div>
        </div>
      </BookingContainer>
    );
  }
  return (
    <BookingContainer>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="h-7 w-7 text-red-500" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">取消{templateType}</h1>
            <p className="text-sm text-gray-500">確定要取消這筆{templateType}預約嗎？此動作無法復原。</p>
          </div>
          <div className="bg-gray-50 rounded-xl p-5 space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-gray-400">類型</span><span className="font-semibold text-gray-900">{templateType}</span></div>
            <div className="flex justify-between"><span className="text-gray-400">姓名</span><span className="font-semibold text-gray-900">{tenantName}</span></div>
            {roomNumber && <div className="flex justify-between"><span className="text-gray-400">房間</span><span className="font-semibold text-gray-900">{roomNumber}</span></div>}
            <div className="flex justify-between"><span className="text-gray-400">時間</span><span className="font-semibold text-gray-900">{formatEpochTaipei(currentBookingTime)}</span></div>
          </div>
          <Button className="w-full h-12 mt-6 bg-red-500 hover:bg-red-600 text-white rounded-full font-semibold text-base"
            onClick={onConfirm} disabled={isCancelling}>
            {isCancelling ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />取消中...</>) : `確定取消${templateType}`}
          </Button>
          <p className="text-xs text-gray-400 text-center mt-3">若只是想換時間，請改用卡片上的「變更時間」</p>
        </div>
      </div>
    </BookingContainer>
  );
}

// ─── Success View ──────────────────────────────────────────────────────────────────────────────

interface SuccessViewProps {
  template: any;
  selectedDate: string;
  confirmedSlot: any;
  selectedSlot: any;
  tenantName: string;
  roomNumber: string;
  propertyName: string;
  address: string;
  calendarOwner: string;
}

export function SuccessView({
  template, selectedDate, confirmedSlot, selectedSlot,
  tenantName, roomNumber, propertyName, address, calendarOwner,
}: SuccessViewProps) {
  const slot = confirmedSlot || selectedSlot;
  return (
    <BookingContainer>
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center">
          <SuccessAnimation />
          <h2 className="text-2xl font-bold text-gray-900 mb-2" style={{ animation: "fadeInUp 0.5s ease-out 0.6s both" }}>預約成功！</h2>
          <p className="text-sm text-gray-500 mb-8" style={{ animation: "fadeInUp 0.5s ease-out 0.8s both" }}>您的{template.templateType}預約已確認</p>
          <div className="text-left bg-gray-50 rounded-xl p-5 space-y-3" style={{ animation: "fadeInUp 0.5s ease-out 1s both" }}>
            <div className="text-sm"><span className="text-gray-400">日期</span><p className="font-semibold text-gray-900 mt-0.5">{getDateDisplayFull(selectedDate)}</p></div>
            <div className="text-sm"><span className="text-gray-400">時間</span><p className="font-semibold text-gray-900 mt-0.5">{slot ? `${formatTime(slot.startTime)} - ${formatTime(slot.endTime)}` : ""}</p></div>
            <div className="text-sm"><span className="text-gray-400">姓名</span><p className="font-semibold text-gray-900 mt-0.5">{tenantName}</p></div>
            {roomNumber && <div className="text-sm"><span className="text-gray-400">房號</span><p className="font-semibold text-gray-900 mt-0.5">{propertyName ? `${propertyName} - ${roomNumber}` : roomNumber}</p></div>}
            {address && <div className="text-sm"><span className="text-gray-400">地址</span><p className="font-semibold text-gray-900 mt-0.5">{address}</p></div>}
            {calendarOwner && <div className="text-sm"><span className="text-gray-400">負責人</span><p className="font-semibold text-gray-900 mt-0.5">{calendarOwner}</p></div>}
          </div>
          <div className="mt-6 space-y-3" style={{ animation: "fadeInUp 0.5s ease-out 1.2s both" }}>
            <a href={buildGoogleCalendarUrl({
              title: `${propertyName || roomNumber}${template.templateType}`,
              date: selectedDate,
              startTime: slot?.startTime || "", endTime: slot?.endTime || "",
              description: `${template.templateType}預約\n姓名：${tenantName}\n房號：${propertyName ? `${propertyName} - ${roomNumber}` : roomNumber}`,
            })} target="_blank" rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 w-full h-12 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base transition-colors">
              <CalendarPlus className="h-5 w-5" />加到 Google 日曆
            </a>
            <p className="text-xs text-gray-400 text-center">如需變更預約請聯繫管理員</p>
          </div>
        </div>
      </div>
      <style>{`@keyframes fadeInUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </BookingContainer>
  );
}
