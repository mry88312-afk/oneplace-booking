/**
 * P22b' — 續約「付款設定 / 更新個資」步驟（委派架構）。
 *
 * 機密邏輯（三竹 OTP、虛擬帳號產生、企業代碼）不在本 repo，
 * 而是直接呼叫既有的 tenant-form-liff 服務 API（固定 IP 已白名單、env/VA 邏輯只存在那台）。
 *
 * 子步驟：form（補個資→發OTP）→ otp（驗證→取VA+寫Ragic+推卡+n8n，全在那台）→ done（顯示VA）
 *
 * 對應 tenant-form-liff 端點：
 *   POST /api/send-otp   { phone, name?, email?, job? } → { success, message, isForeignPhone?, devMode? }
 *   POST /api/verify-otp { phone, otp }                 → { success, message, virtualAccount, verifyToken }
 *   POST /api/submit     { uid, name, phone, idNumber, email, job, virtualAccount, verifyToken, lineProfile } → { success }
 */
import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Wallet, ShieldCheck, Copy, CheckCircle2, Phone } from "lucide-react";
import { BookingContainer } from "./utils";

// 你現有的 tenant-form-liff（匯訂）服務公開網址；機密邏輯都在這台。
// 可用 VITE_REMITTANCE_API_BASE build 變數覆蓋，否則用下方常數。
const REMITTANCE_API =
  (import.meta as any).env?.VITE_REMITTANCE_API_BASE ||
  "https://deposit.zeabur.app/api"; // tenant-form-liff（匯訂）正式服務

async function postJson(path: string, body: any): Promise<any> {
  const resp = await fetch(`${REMITTANCE_API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // 這些端點即使驗證失敗也回 JSON（400/401），故不依賴 resp.ok
  try {
    return await resp.json();
  } catch {
    return { success: false, message: `服務回應異常 (${resp.status})` };
  }
}

interface RemittanceViewProps {
  template: any;
  /** 驗證後帶入的姓名（可編輯） */
  name: string;
  /** 驗證後帶入的電話（產 VA / 發 OTP 用） */
  phone: string;
  /** LINE userId（推虛擬帳號卡片用） */
  uid: string | null;
  /** 完成後續約流程繼續（回到 calendar / preset form），帶回虛擬帳號供確認卡顯示 */
  onComplete: (virtualAccount?: string) => void;
}

export function RemittanceView({ name, phone, uid, onComplete }: RemittanceViewProps) {
  const normalizedPhone = (phone || "").replace(/\D/g, "");
  const [sub, setSub] = useState<"form" | "otp" | "done">("form");

  const [nameInput, setNameInput] = useState(name || "");
  const [idNumber, setIdNumber] = useState("");
  const [email, setEmail] = useState("");
  const [job, setJob] = useState("");

  const [isForeign, setIsForeign] = useState(false);
  const [otpDigits, setOtpDigits] = useState<string[]>(Array(6).fill(""));
  const [manualCode, setManualCode] = useState("");      // 客服/外國：可輸入較長的萬能碼
  const [manualMode, setManualMode] = useState(false);
  const otpRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [virtualAccount, setVirtualAccount] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const useManual = isForeign || manualMode;
  const otpValue = (useManual ? manualCode : otpDigits.join("")).trim();
  const clearOtp = () => { setOtpDigits(Array(6).fill("")); setManualCode(""); };

  const handleDigitChange = (i: number, raw: string) => {
    const d = raw.replace(/\D/g, "");
    if (d.length > 1) {
      // 貼上 / iOS 簡訊自動填入：把多碼分散到各格
      setOtpDigits((prev) => {
        const next = [...prev];
        for (let k = 0; k < d.length && i + k < 6; k++) next[i + k] = d[k];
        return next;
      });
      otpRefs.current[Math.min(i + d.length, 5)]?.focus();
      return;
    }
    setOtpDigits((prev) => { const next = [...prev]; next[i] = d; return next; });
    if (d && i < 5) otpRefs.current[i + 1]?.focus();
  };
  const handleDigitKey = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !otpDigits[i] && i > 0) otpRefs.current[i - 1]?.focus();
  };

  const startCountdown = () => {
    setCountdown(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { if (timerRef.current) clearInterval(timerRef.current); return 0; }
        return c - 1;
      });
    }, 1000);
  };
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  const handleSendOtp = async () => {
    if (!nameInput.trim()) return toast.error("請輸入姓名");
    if (!idNumber.trim()) return toast.error("請輸入身分證字號或護照號碼");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return toast.error("請輸入有效的電子郵件");
    if (!job.trim()) return toast.error("請輸入職業");
    if (!/^\d{8,15}$/.test(normalizedPhone)) {
      return toast.error("檔內電話格式有誤，請改用電話驗證或聯繫客服");
    }
    setSending(true);
    try {
      const r = await postJson("/send-otp", {
        phone: normalizedPhone, name: nameInput.trim(), email: email.trim(), job: job.trim(),
      });
      if (r.success) {
        if (r.devMode) toast.success("開發模式：請用固定驗證碼");
        else toast.success("驗證碼已發送至您的手機");
        setIsForeign(false);
        setSub("otp");
        startCountdown();
      } else if (r.isForeignPhone) {
        setIsForeign(true);
        setSub("otp");
        toast.info("外國電話無法發送簡訊，請聯繫一方客服取得驗證碼");
      } else {
        toast.error(r.message || "發送失敗");
      }
    } catch (err: any) {
      toast.error(err?.message || "網路錯誤，請稍後重試");
    } finally {
      setSending(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0) return;
    setSending(true);
    try {
      const r = await postJson("/send-otp", {
        phone: normalizedPhone, name: nameInput.trim(), email: email.trim(), job: job.trim(),
      });
      if (r.success) { toast.success("驗證碼已重新發送"); clearOtp(); startCountdown(); }
      else toast.error(r.message || "發送失敗");
    } catch (err: any) {
      toast.error(err?.message || "網路錯誤");
    } finally {
      setSending(false);
    }
  };

  const handleVerify = async () => {
    if (otpValue.length < 4) return toast.error("請輸入完整驗證碼");
    setVerifying(true);
    try {
      const r = await postJson("/verify-otp", { phone: normalizedPhone, otp: otpValue });
      if (!r.success || !r.virtualAccount) {
        toast.error(r.message || "驗證失敗");
        clearOtp();
        return;
      }
      const va = r.virtualAccount as string;
      const token = r.verifyToken as string;
      setVirtualAccount(va);
      // 立即提交：tenant-form-liff 端寫回 Ragic + 推 VA 卡 + 發 n8n
      const sr = await postJson("/submit", {
        uid: uid || "",
        name: nameInput.trim(),
        phone: normalizedPhone,
        idNumber: idNumber.trim().toUpperCase(),
        email: email.trim(),
        job: job.trim(),
        virtualAccount: va,
        verifyToken: token,
        lineProfile: uid ? { userId: uid } : null,
      });
      if (!sr.success) { toast.error(sr.message || "資料儲存失敗"); return; }
      setSub("done");
    } catch (err: any) {
      toast.error(err?.message || "驗證失敗，請稍後重試");
    } finally {
      setVerifying(false);
    }
  };

  const handleCopy = () => {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(virtualAccount).then(
        () => toast.success("帳號已複製"),
        () => toast.error("複製失敗，請手動複製"),
      );
    } else {
      toast.error("複製失敗，請手動複製");
    }
  };

  // ─── form 子步驟 ─────────────────────────────────────────────────────────
  if (sub === "form") {
    return (
      <BookingContainer>
        <div className="flex-1 px-6 py-6 max-w-md mx-auto w-full">
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-[#6B8E6B] rounded-full flex items-center justify-center mx-auto mb-4">
              <Wallet className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">更新個人資料</h1>
            <p className="text-sm text-gray-500">完成付款設定，取得中信專屬固定式匯款帳號</p>
          </div>
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-medium text-gray-700">姓名 <span className="text-red-500">*</span></Label>
              <Input value={nameInput} onChange={(e) => setNameInput(e.target.value)} className="mt-1.5 h-11" placeholder="您的本名" />
            </div>
            <div>
              <Label className="text-sm font-medium text-gray-700">手機號碼</Label>
              <input value={normalizedPhone} readOnly className="mt-1.5 h-11 w-full rounded-md border border-input bg-muted px-3 text-base text-gray-600" />
            </div>
            <div>
              <Label className="text-sm font-medium text-gray-700">身分證字號 / 護照號碼 <span className="text-red-500">*</span></Label>
              <Input value={idNumber} onChange={(e) => setIdNumber(e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase())} className="mt-1.5 h-11" placeholder="A123456789" />
            </div>
            <div>
              <Label className="text-sm font-medium text-gray-700">電子郵件 <span className="text-red-500">*</span></Label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1.5 h-11" placeholder="you@example.com" />
            </div>
            <div>
              <Label className="text-sm font-medium text-gray-700">職業 <span className="text-red-500">*</span></Label>
              <Input value={job} onChange={(e) => setJob(e.target.value)} className="mt-1.5 h-11" placeholder="例：軟體工程師" />
            </div>
            <Button className="w-full h-12 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base"
              onClick={handleSendOtp} disabled={sending}>
              {sending ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />發送中...</>) : "發送驗證碼"}
            </Button>
            <p className="text-xs text-gray-400 text-center">我們將發送簡訊驗證碼至上方手機號碼以確認身份</p>
          </div>
        </div>
      </BookingContainer>
    );
  }

  // ─── otp 子步驟 ──────────────────────────────────────────────────────────
  if (sub === "otp") {
    const busy = verifying;
    return (
      <BookingContainer>
        <div className="flex-1 px-6 py-6 max-w-md mx-auto w-full">
          <div className="text-center mb-6">
            <div className="w-14 h-14 bg-[#6B8E6B] rounded-full flex items-center justify-center mx-auto mb-4">
              <ShieldCheck className="h-7 w-7 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">手機驗證</h1>
            {isForeign ? (
              <p className="text-sm text-amber-600">外國電話請聯繫一方客服取得驗證碼後輸入</p>
            ) : (
              <p className="text-sm text-gray-500">驗證碼已發送至 {normalizedPhone}</p>
            )}
          </div>
          <div className="space-y-5">
            {useManual ? (
              <input
                inputMode="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value.slice(0, 20))}
                placeholder="輸入客服提供的驗證碼"
                className="h-14 text-xl text-center w-full rounded-xl border-2 border-gray-200 bg-white px-3 focus:outline-none focus:border-[#6B8E6B] focus:ring-2 focus:ring-[#6B8E6B]/20"
                autoFocus
              />
            ) : (
              <div
                className="flex justify-center gap-2"
                onPaste={(e) => {
                  const t = e.clipboardData.getData("text");
                  if (/\d/.test(t)) { e.preventDefault(); handleDigitChange(0, t); }
                }}
              >
                {otpDigits.map((dgt, i) => (
                  <input
                    key={i}
                    ref={(el) => { otpRefs.current[i] = el; }}
                    inputMode="numeric"
                    maxLength={1}
                    value={dgt}
                    onChange={(e) => handleDigitChange(i, e.target.value)}
                    onKeyDown={(e) => handleDigitKey(i, e)}
                    autoComplete={i === 0 ? "one-time-code" : "off"}
                    autoFocus={i === 0}
                    className="w-11 h-14 text-2xl font-bold text-center rounded-xl border-2 border-gray-200 bg-white text-gray-900 focus:outline-none focus:border-[#6B8E6B] focus:ring-2 focus:ring-[#6B8E6B]/20 transition-colors"
                  />
                ))}
              </div>
            )}
            <Button className="w-full h-12 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base"
              onClick={handleVerify} disabled={busy || otpValue.length < 4}>
              {busy ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />驗證中...</>) : "驗證並取得帳號"}
            </Button>
            <div className="flex items-center justify-center gap-3 text-sm">
              <button type="button" className="text-gray-400 hover:text-gray-600" onClick={() => setSub("form")}>返回修改</button>
              {!isForeign && (
                <>
                  <span className="text-gray-300">|</span>
                  <button type="button" disabled={countdown > 0 || sending}
                    className={countdown > 0 ? "text-gray-300" : "text-[#6B8E6B] hover:underline"}
                    onClick={handleResend}>
                    {countdown > 0 ? `重新發送 (${countdown})` : "重新發送驗證碼"}
                  </button>
                </>
              )}
            </div>
            {!isForeign && (
              <p className="text-center text-xs">
                <button type="button" className="text-gray-400 hover:text-[#6B8E6B]"
                  onClick={() => { setManualMode((m) => !m); clearOtp(); }}>
                  {manualMode ? "改用簡訊 6 位數驗證碼" : "收不到簡訊？改輸入客服提供的驗證碼"}
                </button>
              </p>
            )}
          </div>
        </div>
      </BookingContainer>
    );
  }

  // ─── done 子步驟 ─────────────────────────────────────────────────────────
  return (
    <BookingContainer>
      <div className="flex-1 px-6 py-6 max-w-md mx-auto w-full">
        <div className="text-center mb-6">
          <div className="w-14 h-14 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="h-7 w-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 mb-1">付款設定完成</h1>
          <p className="text-sm text-gray-500">這是您的專屬固定虛擬帳號，已同步傳送到您的 LINE</p>
        </div>
        <div className="rounded-xl bg-[#F5F7FA] border border-gray-200 p-5 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">銀行代碼</span>
            <span className="font-bold text-gray-900">822（中國信託）</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-gray-500">虛擬帳號</span>
            <span className="font-bold text-gray-900 text-lg tracking-wider">{virtualAccount}</span>
          </div>
          <Button variant="outline" className="w-full h-10" onClick={handleCopy}>
            <Copy className="h-4 w-4 mr-2" />複製帳號
          </Button>
        </div>
        <Button className="w-full h-12 mt-8 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base"
          onClick={() => onComplete(virtualAccount)}>
          繼續預約時段
        </Button>
        <p className="mt-3 flex items-center justify-center gap-1 text-xs text-gray-400">
          <Phone className="h-3 w-3" />如有疑問請聯繫一方客服
        </p>
      </div>
    </BookingContainer>
  );
}
