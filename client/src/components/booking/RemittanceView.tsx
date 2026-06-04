/**
 * P22b — 續約「付款設定 / 更新個資」步驟。
 *
 * 插在身份驗證之後、選時段之前（只在 renewal 啟用）。
 * 內含三個子步驟：
 *   form → 補身分證/email/職業，發送 OTP
 *   otp  → 輸入簡訊驗證碼，驗證成功取得虛擬帳號並寫回 Ragic + 推卡 + n8n
 *   done → 顯示固定式虛擬帳號，按「繼續預約」回到選時段
 *
 * 後端：booking.remittanceSendOtp / remittanceVerifyOtp / remittanceSubmit（P22a）
 */
import { useState, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2, Wallet, ShieldCheck, Copy, CheckCircle2, Phone } from "lucide-react";
import { BookingContainer } from "./utils";

interface RemittanceViewProps {
  template: any;
  /** 驗證後帶入的姓名（可編輯） */
  name: string;
  /** 驗證後帶入的電話（產 VA / 發 OTP 用） */
  phone: string;
  /** LINE userId（推虛擬帳號卡片用） */
  uid: string | null;
  /** 完成後續約流程繼續（回到 calendar / preset form） */
  onComplete: () => void;
}

export function RemittanceView({ template, name, phone, uid, onComplete }: RemittanceViewProps) {
  const normalizedPhone = (phone || "").replace(/\D/g, "");
  const [sub, setSub] = useState<"form" | "otp" | "done">("form");

  // 表單欄位（姓名/電話帶入，其餘待補）
  const [nameInput, setNameInput] = useState(name || "");
  const [idNumber, setIdNumber] = useState("");
  const [email, setEmail] = useState("");
  const [job, setJob] = useState("");

  // OTP / VA 狀態
  const [otp, setOtp] = useState("");
  const [isForeign, setIsForeign] = useState(false);
  const [virtualAccount, setVirtualAccount] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const sendOtp = trpc.booking.remittanceSendOtp.useMutation();
  const verifyOtp = trpc.booking.remittanceVerifyOtp.useMutation();
  const submit = trpc.booking.remittanceSubmit.useMutation();

  const handleSendOtp = async () => {
    if (!nameInput.trim()) return toast.error("請輸入姓名");
    if (!idNumber.trim()) return toast.error("請輸入身分證字號或護照號碼");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return toast.error("請輸入有效的電子郵件");
    if (!job.trim()) return toast.error("請輸入職業");
    if (!/^\d{8,15}$/.test(normalizedPhone)) {
      return toast.error("檔內電話格式有誤，請改用電話驗證或聯繫客服");
    }
    try {
      const r = await sendOtp.mutateAsync({ phone: normalizedPhone });
      if (r.success) {
        if ((r as any).devMode) toast.success("開發模式：驗證碼 888888");
        else toast.success("驗證碼已發送至您的手機");
        setIsForeign(false);
        setSub("otp");
        startCountdown();
      } else if ((r as any).isForeignPhone) {
        // 外國電話無法發簡訊 → 進 OTP 步驟由客服用萬能碼救場
        setIsForeign(true);
        setSub("otp");
        toast.info("外國電話無法發送簡訊，請聯繫一方客服取得驗證碼");
      } else {
        toast.error(r.message || "發送失敗");
      }
    } catch (err: any) {
      toast.error(err?.message || "網路錯誤，請稍後重試");
    }
  };

  const handleResend = async () => {
    if (countdown > 0) return;
    try {
      const r = await sendOtp.mutateAsync({ phone: normalizedPhone });
      if (r.success) { toast.success("驗證碼已重新發送"); setOtp(""); startCountdown(); }
      else toast.error(r.message || "發送失敗");
    } catch (err: any) {
      toast.error(err?.message || "網路錯誤");
    }
  };

  const handleVerify = async () => {
    if (otp.trim().length < 4) return toast.error("請輸入完整驗證碼");
    try {
      const r = await verifyOtp.mutateAsync({ phone: normalizedPhone, otp: otp.trim() });
      if (!r.success || !(r as any).virtualAccount) {
        toast.error(r.message || "驗證失敗");
        setOtp("");
        return;
      }
      const va = (r as any).virtualAccount as string;
      const token = (r as any).verifyToken as string;
      setVirtualAccount(va);
      setVerifyToken(token);
      // 立即提交：寫回 Ragic + 推 VA 卡 + 發 n8n
      const sr = await submit.mutateAsync({
        uid: uid || undefined,
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
            <h1 className="text-2xl font-bold text-gray-900 mb-1">付款設定</h1>
            <p className="text-sm text-gray-500">更新個人資料並取得中信專屬固定式匯款帳號</p>
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
              onClick={handleSendOtp} disabled={sendOtp.isPending}>
              {sendOtp.isPending ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />發送中...</>) : "發送驗證碼"}
            </Button>
            <p className="text-xs text-gray-400 text-center">我們將發送簡訊驗證碼至上方手機號碼以確認身份</p>
          </div>
        </div>
      </BookingContainer>
    );
  }

  // ─── otp 子步驟 ──────────────────────────────────────────────────────────
  if (sub === "otp") {
    const busy = verifyOtp.isPending || submit.isPending;
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
          <div className="space-y-4">
            <input
              inputMode="numeric"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="請輸入驗證碼"
              className="h-14 text-2xl text-center tracking-[0.5em] w-full rounded-md border border-input bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B8E6B]"
              autoFocus
            />
            <Button className="w-full h-12 bg-[#6B8E6B] hover:bg-[#5A7A5A] text-white rounded-full font-semibold text-base"
              onClick={handleVerify} disabled={busy || otp.length < 4}>
              {busy ? (<><Loader2 className="h-4 w-4 animate-spin mr-2" />{submit.isPending ? "儲存中..." : "驗證中..."}</>) : "驗證並取得帳號"}
            </Button>
            <div className="flex items-center justify-center gap-3 text-sm">
              <button type="button" className="text-gray-400 hover:text-gray-600" onClick={() => setSub("form")}>返回修改</button>
              {!isForeign && (
                <>
                  <span className="text-gray-300">|</span>
                  <button type="button" disabled={countdown > 0 || sendOtp.isPending}
                    className={countdown > 0 ? "text-gray-300" : "text-[#6B8E6B] hover:underline"}
                    onClick={handleResend}>
                    {countdown > 0 ? `重新發送 (${countdown})` : "重新發送驗證碼"}
                  </button>
                </>
              )}
            </div>
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
          onClick={onComplete}>
          繼續預約時段
        </Button>
        <p className="mt-3 flex items-center justify-center gap-1 text-xs text-gray-400">
          <Phone className="h-3 w-3" />如有疑問請聯繫一方客服
        </p>
      </div>
    </BookingContainer>
  );
}
