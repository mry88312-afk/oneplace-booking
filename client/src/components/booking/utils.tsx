import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Loader2 } from "lucide-react";

// ─── Date utilities ──────────────────────────────────────────────────────────

export function getTaipeiNow(): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value || "0";
  return new Date(
    parseInt(get("year")),
    parseInt(get("month")) - 1,
    parseInt(get("day")),
    parseInt(get("hour")),
    parseInt(get("minute")),
    parseInt(get("second"))
  );
}

export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleTimeString("zh-TW", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Taipei",
  });
}

export function getWeekdayName(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dateObj = new Date(y, m - 1, d);
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  return `星期${names[dateObj.getDay()]}`;
}

export function getDateDisplay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${y}/${m}/${d}`;
}

export function getDateDisplayFull(dateStr: string): string {
  return `${getDateDisplay(dateStr)} ${getWeekdayName(dateStr)}`;
}

export function buildGoogleCalendarUrl(params: {
  title: string; date: string; startTime: string; endTime: string; description?: string;
}): string {
  const { title, startTime, endTime, description } = params;
  const fmt = (iso: string) => {
    const d = new Date(iso);
    const tp = new Date(d.getTime() + 8 * 3600000);
    return tp.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
  };
  const base = "https://calendar.google.com/calendar/render";
  const p = new URLSearchParams({
    action: "TEMPLATE", text: title,
    dates: `${fmt(startTime)}/${fmt(endTime)}`,
    ctz: "Asia/Taipei", details: description || "",
  });
  return `${base}?${p.toString()}`;
}

export function getTaipeiTimeStr(): string {
  const now = getTaipeiNow();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// ─── Shared components ───────────────────────────────────────────────────────

export const EFANG_LOGO = "https://d2xsxph8kpxj0f.cloudfront.net/310519663374214772/JMQD8oX855rUNkwEtNAJD2/efang-logo_28ee778f.png";

export function BookingContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f8f7f4] flex flex-col">
      <div className="bg-white border-b border-[#e8e5df] px-4 py-3 flex items-center justify-center">
        <img loading="lazy" src={EFANG_LOGO} alt="一方生活" className="h-8 object-contain" />
      </div>
      {children}
    </div>
  );
}

export function SuccessAnimation() {
  return (
    <div className="relative w-24 h-24 mx-auto mb-6">
      <div className="absolute inset-0 rounded-full bg-green-100 animate-ping opacity-20" />
      <div className="relative w-24 h-24 bg-green-50 rounded-full flex items-center justify-center border-2 border-green-200"
        style={{ animation: "bounceIn 0.6s ease-out" }}>
        <svg className="w-12 h-12 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 13l4 4L19 7" style={{ strokeDasharray: 24, strokeDashoffset: 24, animation: "drawCheck 0.5s ease-out 0.3s forwards" }} />
        </svg>
      </div>
      <style>{`
        @keyframes drawCheck { to { stroke-dashoffset: 0; } }
        @keyframes bounceIn { 0% { transform: scale(0); opacity: 0; } 50% { transform: scale(1.1); } 100% { transform: scale(1); opacity: 1; } }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}

export function LiffFailedAutoRedirect({ error, onRedirect }: { error: string; onRedirect: () => void }) {
  const [countdown, setCountdown] = useState(3);
  useEffect(() => {
    if (countdown <= 0) { onRedirect(); return; }
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown, onRedirect]);

  return (
    <div className="flex flex-col items-center py-8">
      <AlertCircle className="h-8 w-8 text-amber-400 mb-4" />
      <p className="text-sm text-gray-700 text-center mb-2">LINE 自動登入未成功</p>
      <p className="text-xs text-gray-400 text-center mb-4">{error}</p>
      <p className="text-xs text-gray-500 mb-4">{countdown > 0 ? `${countdown} 秒後自動跳轉電話驗證...` : "正在跳轉..."}</p>
      <Button className="rounded-full bg-[#6B8E6B] hover:bg-[#5A7A5A]" onClick={onRedirect}>立即改用電話驗證</Button>
    </div>
  );
}

export function BookingLoadingScreen() {
  return (
    <div className="min-h-screen bg-[#f8f7f4] flex flex-col">
      <div className="bg-white border-b border-[#e8e5df] px-4 py-3 flex items-center justify-center">
        <img loading="lazy" src={EFANG_LOGO} alt="一方生活" className="h-8 object-contain" />
      </div>
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B8E6B]" />
      </div>
    </div>
  );
}

export function BookingErrorScreen({ message }: { message?: string }) {
  return (
    <div className="min-h-screen bg-[#f8f7f4] flex flex-col">
      <div className="bg-white border-b border-[#e8e5df] px-4 py-3 flex items-center justify-center">
        <img loading="lazy" src={EFANG_LOGO} alt="一方生活" className="h-8 object-contain" />
      </div>
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center max-w-sm">
          <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-gray-900 mb-2">無法載入預約頁面</h2>
          <p className="text-sm text-gray-500">{message || "預約專案不存在或已停用"}</p>
        </div>
      </div>
    </div>
  );
}

export type PageView = "verify" | "phone" | "register" | "calendar" | "slots" | "instruction" | "form" | "success";
