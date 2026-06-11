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
  VerifyView, PhoneView, RegisterView, RemittanceView,
  CalendarViewPage, SlotsView, InstructionView, FormView, SuccessView, CancelView,
} from "@/components/booking";

export default function BookingPublic() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId || "";

  // 初始從 URL 讀取 uid（不依賴 LIFF，直接可用）
  const initialSearch = typeof window !== "undefined" ? window.location.search : "";
  const initialParams = useMemo(() => new URLSearchParams(initialSearch), [initialSearch]);
  const uidFromUrl = initialParams.get("uid") || "";
  const debugMode = initialParams.get("debug") === "1";

  // presetT 初值直接從 URL 讀（格式 A：?t=xxx 進來，mount 當下就在 URL 上）
  // 若是格式 B（liff.state encoded），liff.init() 完成還原 URL 後會再覆寫一次
  const [presetT, setPresetT] = useState(() => {
    const t = initialParams.get("t") || "";
    return /^(\d{8}|\d{12})$/.test(t) ? t : "";
  });
  const isPresetMode = /^(\d{8}|\d{12})$/.test(presetT);

  // P23：卡片動作模式（?reschedule=<bookingId> 變更時間 / ?cancel=<bookingId> 取消）
  const [actionMode, setActionMode] = useState<"none" | "reschedule" | "cancel">(() => {
    if (initialParams.get("reschedule")) return "reschedule";
    if (initialParams.get("cancel")) return "cancel";
    return "none";
  });
  const [actionBookingId, setActionBookingId] = useState<number | null>(() => {
    const v = initialParams.get("reschedule") || initialParams.get("cancel");
    const n = v ? parseInt(v, 10) : NaN;
    return !isNaN(n) ? n : null;
  });
  const isActionMode = actionMode !== "none";

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
  const [contractRecordId, setContractRecordId] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState<string | null>(null);
  const [bookingResult, setBookingResult] = useState<{ success: boolean; bookingId?: number } | null>(null);
  // P22b 續約付款設定（匯訂）— 只在 renewal 啟用，verify 後、選時段前插入
  const [remittanceDone, setRemittanceDone] = useState(false);
  const [verifiedPhone, setVerifiedPhone] = useState("");
  const [remittanceVA, setRemittanceVA] = useState(""); // 付款設定取得的虛擬帳號，帶到確認卡
  const [verifiedEmail, setVerifiedEmail] = useState(""); // 既有 email，付款設定頁顯示用
  // P23 卡片動作
  const [actionCancelled, setActionCancelled] = useState(false);
  const [actionTenantName, setActionTenantName] = useState("");
  const [actionRoomNumber, setActionRoomNumber] = useState("");
  const [actionBookingTime, setActionBookingTime] = useState(0);
  const [actionTemplateType, setActionTemplateType] = useState("");
  const actionStartedRef = useRef(false);
  const inFlightRef = useRef(false); // 防止重複送出（多次點 Confirm → 重複預約/多張卡片）

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
    console.log("[BOOKING] jumpToPresetForm 觸發", { date: ps.date, start: ps.startTimeDisplay, assignee: ps.assigneeName });
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

  // P22b：身份驗證後是否需先做付款設定（匯訂）— 只在 renewal 啟用
  const needsRemittance = (tmpl: typeof template) => tmpl?.projectId === "renewal";
  // 付款設定完成後繼續原本流程（指定時段 or 選日期）
  const continueAfterRemittance = (va?: string) => {
    setRemittanceDone(true);
    if (va) setRemittanceVA(va);
    if (isPresetMode && presetSlotQuery.data) jumpToPresetForm(presetSlotQuery.data, template);
    else setView("calendar");
  };

  const verifyRetryRef = useRef(0);
  const verifyMutation = trpc.booking.verifyTenantUid.useMutation({
    onSuccess: (data) => {
      verifyRetryRef.current = 0;
      setTenantName(data.tenantName); setRoomNumber(data.roomNumber);
      setPropertyName(data.propertyName || ""); setAddress(data.address || "");
      if (data.contractRecordId) setContractRecordId(data.contractRecordId);
      setVerifiedPhone((data as any).phone || "");
      setVerifiedEmail((data as any).email || "");
      console.log("[BOOKING] verify success — isPresetMode:", isPresetMode, "presetSlot.data:", !!presetSlotQuery.data, "presetT:", presetT);
      if (needsRemittance(template) && !remittanceDone) {
        setView("remittance");
      } else if (isPresetMode && presetSlotQuery.data) {
        jumpToPresetForm(presetSlotQuery.data, template);
      } else {
        if (isPresetMode) console.log("[BOOKING] presetSlot 尚未回來 → 先進 calendar，等 useEffect 補救");
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
      if (data.contractRecordId) setContractRecordId(data.contractRecordId);
      setVerifiedPhone((data as any).phone || phoneInput.trim());
      setVerifiedEmail((data as any).email || "");
      if (needsRemittance(template) && !remittanceDone) {
        setView("remittance");
      } else if (isPresetMode && presetSlotQuery.data) {
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
      if (err.message === "PHONE_NOT_FOUND") {
        toast.info("查無資料，請填寫基本資料完成註冊後即可繼續預約");
        setView("register");
      }
      else if (isUnavailable) toast.error("服務暖機中，請稍後重新開啟連結");
      else toast.error(err.message || "查詢失敗");
    },
  });

  const registerMutation = trpc.booking.registerTenantByPhone.useMutation({
    onSuccess: (data) => {
      // 後端只回 {success, ragicId}；顯示資料直接用使用者剛填的欄位
      setTenantName(nameInput.trim()); setRoomNumber(roomInput.trim());
      setPropertyName(""); setAddress(locationInput.trim());
      if (data.success) toast.success("已為您建立資料，請繼續預約");
      setVerifiedPhone(phoneInput.trim());
      if (needsRemittance(template) && !remittanceDone) {
        setView("remittance");
      } else if (isPresetMode && presetSlotQuery.data) {
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
    onSettled: () => { inFlightRef.current = false; },
  });

  // P23：卡片動作（變更時間 / 取消）
  const effectiveActionUid = lineUserId || uid;
  const rescheduleInfoQuery = trpc.booking.getBookingForReschedule.useQuery(
    { bookingId: actionBookingId!, uid: effectiveActionUid! },
    { enabled: isActionMode && !!actionBookingId && !!effectiveActionUid, retry: false },
  );
  const cancelMutation = trpc.booking.cancelBookingPublic.useMutation({
    onSuccess: () => setActionCancelled(true),
    onError: (err) => toast.error(err.message || "取消失敗"),
  });
  const rescheduleMutation = trpc.booking.rescheduleBooking.useMutation({
    onSuccess: (data) => { setBookingResult({ success: true, bookingId: data.bookingId }); setView("success"); setIsBooking(false); },
    onError: (err) => { toast.error(err.message || "變更失敗"); setIsBooking(false); },
    onSettled: () => { inFlightRef.current = false; },
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
        // 此時才能正確讀取 window.location.search 中的 t 參數（針對格式 B：liff.state encoded）
        // 格式 A（直接 ?t=）的 t 已在 mount 時就 set 過了，這裡為了 cover 格式 B 再讀一次
        const postInitParams = new URLSearchParams(window.location.search);
        const tParam = postInitParams.get("t") || "";
        console.log("[BOOKING] liff.init done — window.location.search:", window.location.search, "tParam:", tParam, "isLoggedIn:", liff.isLoggedIn(), "isInClient:", liff.isInClient());
        if (/^(\d{8}|\d{12})$/.test(tParam)) setPresetT(tParam);
        // P23：改期/取消參數（格式 B：liff.state 還原後才讀得到）
        const rs = postInitParams.get("reschedule");
        const cc = postInitParams.get("cancel");
        if (rs || cc) {
          const n = parseInt(rs || cc || "", 10);
          if (!isNaN(n)) { setActionBookingId(n); setActionMode(rs ? "reschedule" : "cancel"); }
        }

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
    if (!isActionMode && effectiveUid && templateQuery.data && canVerify && view === "verify" && !isVerifying && !verifyMutation.isSuccess) {
      handleVerify();
    }
  }, [uidFromUrl, lineUserId, templateQuery.data, liffReady]);

  // P23：卡片動作模式 — 取得預約資料後直接路由（取消→確認頁；改期→選日期）
  useEffect(() => {
    if (!isActionMode || actionStartedRef.current) return;
    const info = rescheduleInfoQuery.data;
    if (!info) return;
    actionStartedRef.current = true;
    setTenantName(info.tenantName); setRoomNumber(info.roomNumber); setAddress(info.address || "");
    setActionTenantName(info.tenantName); setActionRoomNumber(info.roomNumber);
    setActionBookingTime(info.currentBookingTime); setActionTemplateType(info.templateType);
    setView(actionMode === "cancel" ? "cancel" : "calendar");
  }, [rescheduleInfoQuery.data, isActionMode, actionMode]);

  useEffect(() => {
    if (slotsQuery.data) { setCalendarOwner(slotsQuery.data.calendarOwner || ""); setCalendarId(slotsQuery.data.calendarId || ""); }
  }, [slotsQuery.data]);

  // 當 presetSlotQuery 回來時，如果驗證已完成且還在 calendar/slots 頁，跳轉到問卷頁
  // 包含 slots 是因為使用者可能已點日期切到 slots 頁，這時 preset 仍應拉回指定時段
  useEffect(() => {
    if (
      isPresetMode &&
      presetSlotQuery.data &&
      verifyMutation.isSuccess &&
      (view === "calendar" || view === "slots") &&
      template
    ) {
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
    registerMutation.mutate({ projectId, phone, name: nameInput.trim(), uid: lineUserId || uidFromUrl || undefined, location: locationInput.trim(), roomNumber: roomInput.trim() });
  };

  const handleSelectDate = (date: string) => { setSelectedDate(date); setSelectedSlot(null); setConfirmedSlot(null); setView("slots"); };
  const handleSelectSlot = (slot: any) => setSelectedSlot(slot);

  // P23：改期送出（更新 Ragic 日期，不開新任務）
  const doReschedule = (slot: { startTime: string; endTime: string; calendarId?: string; calendarOwner?: string }) => {
    if (!actionBookingId || !effectiveActionUid) return toast.error("缺少預約識別，請重新從卡片開啟");
    if (inFlightRef.current) return; // 防重複送出（多次點 Confirm → 多張卡片）
    inFlightRef.current = true;
    setIsBooking(true);
    rescheduleMutation.mutate({
      bookingId: actionBookingId, uid: effectiveActionUid,
      date: selectedDate, startTime: slot.startTime, endTime: slot.endTime,
      calendarId: slot.calendarId || calendarId, assigneeName: slot.calendarOwner || calendarOwner,
    });
  };
  // P23：取消送出
  const handleCancelConfirm = () => {
    if (!actionBookingId || !effectiveActionUid) return toast.error("缺少預約識別，請重新從卡片開啟");
    cancelMutation.mutate({ bookingId: actionBookingId, uid: effectiveActionUid });
  };

  const handleConfirmSlot = () => {
    if (!selectedSlot) return;
    // 改期模式：選完時段直接更新，不走說明頁/問卷
    if (actionMode === "reschedule") { setConfirmedSlot(selectedSlot); doReschedule(selectedSlot); return; }
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
      // 圖片 > 500KB 先壓縮，避免 base64 後撐爆 tRPC body limit
      let blob: Blob = file;
      if (file.type.startsWith("image/") && file.size > 500 * 1024) {
        const { compressImage } = await import("@/lib/uploadUtils");
        blob = await compressImage(file);
      }
      // 編成 base64 data URL，存進 state，預約確認時一起送給 server
      // server 收到後判斷是 data: 開頭就直接解碼上傳 Ragic（不繞 S3 / 不繞 MANUS）
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("讀檔失敗"));
        reader.readAsDataURL(blob);
      });
      setFileUploads((prev) => ({ ...prev, [fieldLabel]: { name: file.name, url: dataUrl } }));
      setFormAnswers((prev) => ({ ...prev, [fieldLabel]: dataUrl }));
      toast.success("檔案已就緒");
    } catch (err: any) {
      toast.error(err.message || "檔案處理失敗");
    } finally {
      setIsUploading(null);
    }
  };

  const doBooking = (slot: { startTime: string; endTime: string; calendarId?: string; calendarOwner?: string }) => {
    if (inFlightRef.current) return; // 防重複送出
    inFlightRef.current = true;
    setIsBooking(true);
    confirmMutation.mutate({
      projectId, uid: uid || lineUserId || phoneInput.trim() || "unknown",
      tenantName, roomNumber, date: selectedDate,
      startTime: slot.startTime, endTime: slot.endTime,
      calendarId: slot.calendarId || calendarId, assigneeName: slot.calendarOwner || calendarOwner,
      phone: phoneInput.trim() || undefined, address: address || undefined,
      formAnswers: Object.keys(formAnswers).length > 0 ? formAnswers : undefined,
      contractRecordId: contractRecordId ?? undefined,
      virtualAccount: remittanceVA || undefined,
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

  // P17 debug: mount 時 log 一次初始 URL state
  const mountLoggedRef = useRef(false);
  useEffect(() => {
    if (mountLoggedRef.current) return;
    mountLoggedRef.current = true;
    console.log("[BOOKING] mount", {
      url: window.location.href,
      search: window.location.search,
      projectId,
      uidFromUrl,
      presetT_initial: presetT,
      isPresetMode_initial: isPresetMode,
      initialUrl: initialUrlRef.current,
      debugMode,
    });
  }, []);

  // P17 debug overlay (?debug=1 啟用) — 用 DOM API 避開所有 view 都要包 fragment
  useEffect(() => {
    if (!debugMode) return;
    let el = document.getElementById("__booking_debug__");
    if (!el) {
      el = document.createElement("div");
      el.id = "__booking_debug__";
      el.style.cssText =
        "position:fixed;bottom:0;right:0;background:rgba(0,0,0,0.85);color:white;padding:8px 12px;font-size:11px;font-family:monospace;z-index:9999;max-width:92vw;line-height:1.4;border-top-left-radius:8px;pointer-events:none;white-space:pre-wrap;word-break:break-all";
      document.body.appendChild(el);
    }
    const verifyStatus = verifyMutation.isPending
      ? "pending"
      : verifyMutation.isSuccess
        ? "ok"
        : verifyMutation.isError
          ? `err:${verifyMutation.error?.message}`
          : "idle";
    const presetStatus = !isPresetMode
      ? "(off)"
      : presetSlotQuery.isPending
        ? "pending"
        : presetSlotQuery.isSuccess
          ? "ok"
          : presetSlotQuery.isError
            ? `err:${presetSlotQuery.error?.message}`
            : "idle";
    el.textContent =
      `url: ${window.location.href.slice(-90)}\n` +
      `projectId: ${projectId}\n` +
      `uid(url): ${uidFromUrl || "(none)"}\n` +
      `lineUid: ${lineUserId || "(none)"}\n` +
      `presetT: ${presetT || "(none)"} isPreset: ${isPresetMode}\n` +
      `view: ${view}\n` +
      `liffReady: ${liffReady} liffErr: ${liffError || "(none)"}\n` +
      `verify: ${verifyStatus}\n` +
      `presetSlot: ${presetStatus}`;
  }, [
    debugMode,
    view,
    presetT,
    isPresetMode,
    uidFromUrl,
    lineUserId,
    liffReady,
    liffError,
    verifyMutation.isPending,
    verifyMutation.isSuccess,
    verifyMutation.isError,
    verifyMutation.error?.message,
    presetSlotQuery.isPending,
    presetSlotQuery.isSuccess,
    presetSlotQuery.isError,
    presetSlotQuery.error?.message,
    projectId,
  ]);
  useEffect(() => {
    return () => {
      document.getElementById("__booking_debug__")?.remove();
    };
  }, []);

  // Render
  if (templateQuery.isLoading) return <BookingLoadingScreen />;
  if (templateQuery.error || !template) return <BookingErrorScreen message={templateQuery.error?.message} />;

  // P23 卡片動作模式：載入中 / 權限錯誤 / 取消確認
  if (isActionMode) {
    if (rescheduleInfoQuery.isError) return <BookingErrorScreen message={rescheduleInfoQuery.error?.message || "無法載入這筆預約"} />;
    if (view === "verify") return <BookingLoadingScreen />;
  }
  if (view === "cancel") return <CancelView templateType={actionTemplateType || template.templateType} tenantName={actionTenantName} roomNumber={actionRoomNumber} currentBookingTime={actionBookingTime} isCancelling={cancelMutation.isPending} cancelled={actionCancelled} onConfirm={handleCancelConfirm} />;

  if (view === "verify") return <VerifyView template={template} liffReady={liffReady} liffError={liffError} uidFromUrl={uidFromUrl} lineUserId={lineUserId} isVerifying={isVerifying} verifyMutation={verifyMutation} setView={setView} handleVerify={handleVerify} />;
  if (view === "phone") return <PhoneView phoneInput={phoneInput} setPhoneInput={setPhoneInput} isVerifying={isVerifying} verifyByPhoneMutation={verifyByPhoneMutation} handlePhoneVerify={handlePhoneVerify} />;
  if (view === "register") return <RegisterView phoneInput={phoneInput} nameInput={nameInput} setNameInput={setNameInput} locationInput={locationInput} setLocationInput={setLocationInput} roomInput={roomInput} setRoomInput={setRoomInput} isVerifying={isVerifying} registerMutation={registerMutation} handleRegister={handleRegister} setView={setView} />;
  if (view === "remittance") return <RemittanceView template={template} name={tenantName} phone={verifiedPhone || phoneInput} existingEmail={verifiedEmail} uid={lineUserId || uid} onComplete={continueAfterRemittance} />;
  if (view === "calendar") return <CalendarViewPage template={template} tenantName={tenantName} roomNumber={roomNumber} propertyName={propertyName} address={address} selectedDate={selectedDate} onSelectDate={handleSelectDate} availableDays={availableDays} datesWithSlots={datesWithSlots} multiDayLoaded={!!multiDayQuery.data} multiDayLoading={multiDayQuery.isLoading} />;
  if (view === "slots") return <SlotsView template={template} selectedDate={selectedDate} selectedSlot={selectedSlot} slotsQuery={slotsQuery} onSelectSlot={handleSelectSlot} onConfirmSlot={handleConfirmSlot} setView={setView} setSelectedSlot={setSelectedSlot} isBooking={isBooking} />;
  if (view === "instruction" && confirmedSlot) return <InstructionView template={template} selectedDate={selectedDate} confirmedSlot={confirmedSlot} calendarOwner={calendarOwner} onNext={handleInstructionNext} setView={setView} setConfirmedSlot={setConfirmedSlot} />;
  if (view === "form" && confirmedSlot) return <FormView template={template} selectedDate={selectedDate} confirmedSlot={confirmedSlot} calendarOwner={calendarOwner} formAnswers={formAnswers} setFormAnswers={setFormAnswers} fileUploads={fileUploads} setFileUploads={setFileUploads} isUploading={isUploading} isBooking={isBooking} handleFileUpload={handleFileUpload} handleConfirmBooking={handleConfirmBooking} setView={setView} setConfirmedSlot={setConfirmedSlot} isPreset={isPresetMode} />;
  if (view === "success" && bookingResult?.success) return <SuccessView template={template} selectedDate={selectedDate} confirmedSlot={confirmedSlot} selectedSlot={selectedSlot} tenantName={tenantName} roomNumber={roomNumber} propertyName={propertyName} address={address} calendarOwner={calendarOwner} />;

  return null;
}
