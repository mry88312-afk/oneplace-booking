import { useState, useMemo, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import liff from "@line/liff";

import {
  getTaipeiNow, toDateStr,
  BookingLoadingScreen, BookingErrorScreen,
  type PageView,
} from "@/components/booking";
import {
  VerifyView, PhoneView, RegisterView,
  CalendarViewPage, SlotsView, InstructionView, FormView, SuccessView,
} from "@/components/booking";

export default function BookingPublic() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId || "";

  // 初始從 URL 讀取 uid（不依賴 LIFF，直接可用）
  const initialSearch = typeof window !== "undefined" ? window.location.search : "";
  const initialParams = useMemo(() => new URLSearchParams(initialSearch), [initialSearch]);
  const uidFromUrl = initialParams.get("uid") || "";

  // presetT 需要在 liff.init() 完成後才能正確讀取（LIFF 會還原 liff.state 到正確 URL）
  // 使用 state 儲存，在 liffReady 後更新
  const [presetT, setPresetT] = useState("");
  const isPresetMode = /^(\d{8}|\d{12})$/.test(presetT);

  const [view, setView] = useState<PageView>("verify");
  const [uid, setUid] = useState(uidFromUrl);
  const [liffReady, setLiffReady] = useState(false);
  const [liffError, setLiffError] = useState<string | null>(null);
  const [lineUserId, setLineUserId] = useState<string | null>(null);
  const liffInitRef = useRef(false);
  const initialUrlRef = useRef((window as any).__INITIAL_URL__ || window.location.href);
  const [tenantName, setTenantName] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [address, setAddress] = useState("");
  const [phoneInput, setPhoneInput] = useState("");
  const [nameInput, setNameInput] = useState("");
  const [locationInput, setLocationInput] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [selectedSlot, setSelectedSlot] = useState<{
    startTime: string; endTime: string; calendarId?: string; calendarOwner?: string;
  } | null>(null);
  const [confirmedSlot, setConfirmedSlot] = useState<{
    startTime: string; endTime: string; calendarId?: string; calendarOwner?: string;
  } | null>(null);
  const [calendarOwner, setCalendarOwner] = useState("");
  const [calendarId, setCalendarId] = useState("");
  const [formAnswers, setFormAnswers] = useState<Record<string, string>>({});
  const [fileUploads, setFileUploads] = useState<Record<string, { name: string; url: string }>>({});
  const [isVerifying, setIsVerifying] = useState(false);
  const [isBooking, setIsBooking] = useState(false);
  const [isUploading, setIsUploading] = useState<string | null>(null);
  const [bookingResult, setBookingResult] = useState<{ success: boolean; bookingId?: number } | null>(null);

  const templateQuery = trpc.booking.getPublicTemplate.useQuery(
    { projectId },
    {
      enabled: !!projectId,
      retry: (failureCount, error: any) => {
        const isUnavailable = error?.message === "SERVICE_UNAVAILABLE" || error?.data?.httpStatus === 503;
        return isUnavailable && failureCount < 3;
      },
      retryDelay: (attempt) => attempt * 5000,
    }
  );
  const slotsQuery = trpc.booking.getAvailableSlots.useQuery(
    { projectId, date: selectedDate },
    { enabled: !!selectedDate && view === "slots", retry: false }
  );
  const template = templateQuery.data;

  // 指定時段模式：解析 t 參數
  const presetSlotQuery = trpc.booking.resolvePresetSlot.useQuery(
    { projectId, t: presetT },
    { enabled: isPresetMode && !!projectId, retry: false }
  );

  const [multiDayDates, setMultiDayDates] = useState<string[]>([]);
  const multiDayQuery = trpc.booking.getAvailableSlotsMultiDay.useQuery(
    { projectId, dates: multiDayDates },
    { enabled: multiDayDates.length > 0, retry: false, staleTime: 5 * 60 * 1000 }
  );

  useEffect(() => {
    if (view !== "calendar" || !template) return;
    const today = getTaipeiNow();
    const maxDays = template.bookableDaysAhead || 14;
    const minLead = template.minLeadDays ?? 0;
    const dates: string[] = [];
    // 從 minLeadDays 開始生成日期，跳過太近的日期
    const startOffset = Math.max(minLead, 1);
    for (let i = startOffset; i <= maxDays; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      dates.push(toDateStr(d));
    }
    setMultiDayDates(dates);
  }, [view, template?.bookableDaysAhead, template?.minLeadDays]);

  // 指定時段模式：驗證後跳到問卷頁的輔助函數
  const jumpToPresetForm = (ps: NonNullable<typeof presetSlotQuery.data>, tmpl: typeof template) => {
    const slot = { startTime: ps.startTime, endTime: ps.endTime, calendarId: ps.calendarId, calendarOwner: ps.assigneeName };
    setSelectedDate(ps.date);
    setConfirmedSlot(slot);
    setCalendarOwner(ps.assigneeName);
    setCalendarId(ps.calendarId);
    if (tmpl?.instructionEnabled && tmpl?.instructionText) {
      setView("instruction");
    } else if (tmpl?.fields && tmpl.fields.length > 0) {
      setView("form");
    } else {
      doBooking(slot);
    }
  };

  const verifyRetryRef = useRef(0);
  const verifyMutation = trpc.booking.verifyTenantUid.useMutation({
    onSuccess: (data) => {
      verifyRetryRef.current = 0;
      setTenantName(data.tenantName); setRoomNumber(data.roomNumber);
      setPropertyName(data.propertyName || ""); setAddress(data.address || "");
      if (isPresetMode && presetSlotQuery.data) {
        jumpToPresetForm(presetSlotQuery.data, template);
      } else {
        setView("calendar");
      }
      setIsVerifying(false);
    },
    onError: (err) => {
      const isUnavailable = err.message === "SERVICE_UNAVAILABLE" || (err as any)?.data?.httpStatus === 503;
      if (isUnavailable && verifyRetryRef.current < 3) {
        verifyRetryRef.current += 1;
        const delay = verifyRetryRef.current * 5000;
        toast.info(`服務正在啟動中，${delay / 1000} 秒後自動重試...`);
        setTimeout(() => {
          const effectiveUid = lineUserId || uid;
          if (effectiveUid?.trim()) {
            verifyMutation.mutate({ projectId, uid: effectiveUid.trim() });
          }
        }, delay);
        return;
      }
      verifyRetryRef.current = 0;
      setIsVerifying(false);
      if (err.message === "NEED_PHONE") setView("phone");
      else if (isUnavailable) toast.error("服務暖機中，請稍後重新開啟連結");
      else toast.error(err.message || "驗證失敗");
    },
  });

  const phoneRetryRef = useRef(0);
  const verifyByPhoneMutation = trpc.booking.verifyByPhone.useMutation({
    onSuccess: (data) => {
      phoneRetryRef.current = 0;
      setTenantName(data.tenantName); setRoomNumber(data.roomNumber);
      setPropertyName(data.propertyName || ""); setAddress(data.address || "");
      if (isPresetMode && presetSlotQuery.data) {
        jumpToPresetForm(presetSlotQuery.data, template);
      } else {
        setView("calendar");
      }
      setIsVerifying(false);
    },
    onError: (err) => {
      const isUnavailable = err.message === "SERVICE_UNAVAILABLE" || (err as any)?.data?.httpStatus === 503;
      if (isUnavailable && phoneRetryRef.current < 3) {
        phoneRetryRef.current += 1;
        const delay = phoneRetryRef.current * 5000;
        toast.info(`服務正在啟動中，${delay / 1000} 秒後自動重試...`);
        const phone = phoneInput.trim().replace(/[\s\-()]/g, "");
        setTimeout(() => {
          verifyByPhoneMutation.mutate({ projectId, phone, uid: lineUserId || uidFromUrl || undefined });
        }, delay);
        return;
      }
      phoneRetryRef.current = 0;
      setIsVerifying(false);
      if (err.message === "PHONE_NOT_FOUND") toast.error("查無資料，請與我們聯繫");
      else if (isUnavailable) toast.error("服務暖機中，請稍後重新開啟連結");
      else toast.error(err.message || "查詢失敗");
    },
  });

  const registerMutation = trpc.booking.registerTenantByPhone.useMutation({
    onSuccess: (data) => {
      setTenantName(data.tenantName); setRoomNumber(data.roomNumber || "");
      setPropertyName(data.propertyName || ""); setAddress(data.address || "");
      if (data.isNewRecord) toast.success("已為您建立資料，請繼續預約");
      if (isPresetMode && presetSlotQuery.data) {
        jumpToPresetForm(presetSlotQuery.data, template);
      } else {
        setView("calendar");
      }
      setIsVerifying(false);
    },
    onError: (err) => { setIsVerifying(false); toast.error(err.message || "建立資料失敗"); },
  });

  const confirmMutation = trpc.booking.confirmBooking.useMutation({
    onSuccess: (data) => {
      setBookingResult({ success: true, bookingId: data.bookingId });
      setView("success"); setIsBooking(false);
    },
    onError: (err) => { toast.error(err.message || "預約失敗"); setIsBooking(false); },
  });

  // LIFF init
  useEffect(() => {
    const liffId = templateQuery.data?.liffId;
    if (!liffId || liffInitRef.current) return;
    liffInitRef.current = true;
    const ATTEMPT_KEY = `liff_login_${liffId}`;
    const hasAttemptedLogin = sessionStorage.getItem(ATTEMPT_KEY) === 'true';
    const initialUrl = new URL(initialUrlRef.current);
    const initialHadCode = initialUrl.searchParams.has('code');
    if (initialHadCode) window.history.replaceState(null, '', initialUrlRef.current);

    liff.init({ liffId, withLoginOnExternalBrowser: false })
      .then(async () => {
        // liff.init() 完成後，LIFF 已將 liff.state 還原到正確 URL
        // 此時才能正確讀取 window.location.search 中的 t 參數
        const postInitParams = new URLSearchParams(window.location.search);
        const tParam = postInitParams.get("t") || "";
        if (/^(\d{8}|\d{12})$/.test(tParam)) setPresetT(tParam);

        const isLoggedIn = liff.isLoggedIn();
        const isInClient = liff.isInClient();
        if (isLoggedIn) {
          sessionStorage.removeItem(ATTEMPT_KEY);
          try { const p = await liff.getProfile(); if (p.userId) { setLineUserId(p.userId); setLiffReady(true); return; } } catch {}
          try { const t = liff.getDecodedIDToken(); if (t?.sub) { setLineUserId(t.sub); setLiffReady(true); return; } } catch {}
          setLiffError("LINE 登入異常，請改用電話驗證"); setLiffReady(true);
        } else if (isInClient) {
          setLiffError("LINE App 內部驗證失敗"); setLiffReady(true);
        } else if (hasAttemptedLogin) {
          sessionStorage.removeItem(ATTEMPT_KEY);
          setLiffError("無法透過 LINE 驗證，請改用其他方式"); setLiffReady(true);
        } else {
          sessionStorage.setItem(ATTEMPT_KEY, 'true');
          liff.login({ redirectUri: window.location.origin + window.location.pathname });
        }
      })
      .catch((err: any) => {
        sessionStorage.removeItem(ATTEMPT_KEY);
        setLiffError(err?.message || "LIFF 初始化失敗"); setLiffReady(true);
      });
  }, [templateQuery.data?.liffId, projectId]);

  // Auto-verify
  useEffect(() => {
    const hasLiffId = !!templateQuery.data?.liffId;
    const canVerify = hasLiffId ? liffReady : true;
    const effectiveUid = lineUserId || uidFromUrl;
    if (effectiveUid && templateQuery.data && canVerify && view === "verify" && !isVerifying && !verifyMutation.isSuccess) {
      handleVerify();
    }
  }, [uidFromUrl, lineUserId, templateQuery.data, liffReady]);

  useEffect(() => {
    if (slotsQuery.data) { setCalendarOwner(slotsQuery.data.calendarOwner || ""); setCalendarId(slotsQuery.data.calendarId || ""); }
  }, [slotsQuery.data]);

  // 當 presetSlotQuery 回來時，如果驗證已完成且還在 calendar 頁，跳轉到問卷頁
  // （处理 presetT 在 verify 後才設定、query 非同步回來的情況）
  useEffect(() => {
    if (isPresetMode && presetSlotQuery.data && verifyMutation.isSuccess && view === "calendar" && template) {
      jumpToPresetForm(presetSlotQuery.data, template);
    }
  }, [presetSlotQuery.data, isPresetMode, verifyMutation.isSuccess, view, template]);

  const availableDays = useMemo(() => (template?.routingDays || []) as number[], [template?.routingDays]);
  const datesWithSlots = useMemo(() => {
    if (!multiDayQuery.data?.slotsByDate) return new Set<string>();
    return new Set(Object.keys(multiDayQuery.data.slotsByDate));
  }, [multiDayQuery.data?.slotsByDate]);

  // Handlers
  const handleVerify = () => {
    const effectiveUid = lineUserId || uid;
    if (!effectiveUid?.trim()) { setView("phone"); return; }
    setIsVerifying(true);
    verifyMutation.mutate({ projectId, uid: effectiveUid.trim() });
  };

  const handlePhoneVerify = () => {
    const phone = phoneInput.trim().replace(/[\s\-()]/g, "");
    if (!phone) return toast.error("請輸入電話號碼");
    if (!/^0\d{8,9}$/.test(phone)) return toast.error("請輸入有效的手機號碼（如 0912345678）");
    setIsVerifying(true);
    verifyByPhoneMutation.mutate({ projectId, phone, uid: lineUserId || uidFromUrl || undefined });
  };

  const handleRegister = () => {
    const phone = phoneInput.trim().replace(/[\s\-()]/g, "");
    if (!phone) return toast.error("請輸入電話號碼");
    if (!nameInput.trim()) return toast.error("請輸入姓名");
    if (!locationInput.trim()) return toast.error("請輸入居住位置");
    if (!roomInput.trim()) return toast.error("請輸入房間");
    setIsVerifying(true);
    registerMutation.mutate({ projectId, phone, name: nameInput.trim(), uid: lineUserId || uidFromUrl || undefined, location: locationInput.trim(), room: roomInput.trim() });
  };

  const handleSelectDate = (date: string) => { setSelectedDate(date); setSelectedSlot(null); setConfirmedSlot(null); setView("slots"); };
  const handleSelectSlot = (slot: any) => setSelectedSlot(slot);
  const handleConfirmSlot = () => {
    if (!selectedSlot) return;
    setConfirmedSlot(selectedSlot);
    if (template?.instructionEnabled && template?.instructionText) {
      setView("instruction");
    } else if (template?.fields && template.fields.length > 0) {
      setView("form");
    } else {
      doBooking(selectedSlot);
    }
  };

  const handleInstructionNext = () => {
    if (template?.fields && template.fields.length > 0) setView("form");
    else if (confirmedSlot) doBooking(confirmedSlot);
  };

  const handleFileUpload = async (fieldLabel: string, file: File) => {
    setIsUploading(fieldLabel);
    try {
      const fd = new FormData(); fd.append("file", file);
      const resp = await fetch("/api/upload", { method: "POST", body: fd });
      if (!resp.ok) throw new Error("上傳失敗");
      const data = await resp.json();
      setFileUploads((prev) => ({ ...prev, [fieldLabel]: { name: file.name, url: data.url } }));
      setFormAnswers((prev) => ({ ...prev, [fieldLabel]: data.url }));
      toast.success("檔案上傳成功");
    } catch (err: any) { toast.error(err.message || "檔案上傳失敗"); }
    finally { setIsUploading(null); }
  };

  const doBooking = (slot: { startTime: string; endTime: string; calendarId?: string; calendarOwner?: string }) => {
    setIsBooking(true);
    confirmMutation.mutate({
      projectId, uid: uid || lineUserId || phoneInput.trim() || "unknown",
      tenantName, roomNumber, date: selectedDate,
      startTime: slot.startTime, endTime: slot.endTime,
      calendarId: slot.calendarId || calendarId, assigneeName: slot.calendarOwner || calendarOwner,
      phone: phoneInput.trim() || undefined, address: address || undefined,
      formAnswers: Object.keys(formAnswers).length > 0 ? formAnswers : undefined,
    });
  };

  const handleConfirmBooking = () => {
    if (!confirmedSlot) return;
    if (template?.fields) {
      for (const field of template.fields) {
        if (field.fieldType === "description" || field.fieldType === "line_uid" || field.fieldType === "inbox_url") continue;
        if (field.isRequired && !formAnswers[field.label]) { toast.error(`請填寫「${field.label}」`); return; }
      }
    }
    doBooking(confirmedSlot);
  };

  useEffect(() => {
    document.title = template?.name ? `${template.name} - 一方生活` : "一方生活 - 預約服務";
    return () => { document.title = "外勤工作站"; };
  }, [template?.name]);

  // Render
  if (templateQuery.isLoading) return <BookingLoadingScreen />;
  if (templateQuery.error || !template) return <BookingErrorScreen message={templateQuery.error?.message} />;

  if (view === "verify") return <VerifyView template={template} liffReady={liffReady} liffError={liffError} uidFromUrl={uidFromUrl} lineUserId={lineUserId} isVerifying={isVerifying} verifyMutation={verifyMutation} setView={setView} handleVerify={handleVerify} />;
  if (view === "phone") return <PhoneView phoneInput={phoneInput} setPhoneInput={setPhoneInput} isVerifying={isVerifying} verifyByPhoneMutation={verifyByPhoneMutation} handlePhoneVerify={handlePhoneVerify} />;
  if (view === "register") return <RegisterView phoneInput={phoneInput} nameInput={nameInput} setNameInput={setNameInput} locationInput={locationInput} setLocationInput={setLocationInput} roomInput={roomInput} setRoomInput={setRoomInput} isVerifying={isVerifying} registerMutation={registerMutation} handleRegister={handleRegister} setView={setView} />;
  if (view === "calendar") return <CalendarViewPage template={template} tenantName={tenantName} roomNumber={roomNumber} propertyName={propertyName} address={address} selectedDate={selectedDate} onSelectDate={handleSelectDate} availableDays={availableDays} datesWithSlots={datesWithSlots} multiDayLoaded={!!multiDayQuery.data} multiDayLoading={multiDayQuery.isLoading} />;
  if (view === "slots") return <SlotsView template={template} selectedDate={selectedDate} selectedSlot={selectedSlot} slotsQuery={slotsQuery} onSelectSlot={handleSelectSlot} onConfirmSlot={handleConfirmSlot} setView={setView} setSelectedSlot={setSelectedSlot} />;
  if (view === "instruction" && confirmedSlot) return <InstructionView template={template} selectedDate={selectedDate} confirmedSlot={confirmedSlot} calendarOwner={calendarOwner} onNext={handleInstructionNext} setView={setView} setConfirmedSlot={setConfirmedSlot} />;
  if (view === "form" && confirmedSlot) return <FormView template={template} selectedDate={selectedDate} confirmedSlot={confirmedSlot} calendarOwner={calendarOwner} formAnswers={formAnswers} setFormAnswers={setFormAnswers} fileUploads={fileUploads} setFileUploads={setFileUploads} isUploading={isUploading} isBooking={isBooking} handleFileUpload={handleFileUpload} handleConfirmBooking={handleConfirmBooking} setView={setView} setConfirmedSlot={setConfirmedSlot} isPreset={isPresetMode} />;
  if (view === "success" && bookingResult?.success) return <SuccessView template={template} selectedDate={selectedDate} confirmedSlot={confirmedSlot} selectedSlot={selectedSlot} tenantName={tenantName} roomNumber={roomNumber} propertyName={propertyName} address={address} calendarOwner={calendarOwner} />;

  return null;
}
