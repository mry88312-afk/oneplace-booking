import { useState, useEffect, lazy, Suspense } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const BookingAdmin = lazy(() => import("./BookingAdmin"));

const PW_KEY = "adminPassword";

/**
 * 後台登入閘門 + 路由守衛（P19b）。
 * - sessionStorage 存密碼，trpc header 自動帶上（見 main.tsx）
 * - 驗證方式：呼叫 adminProcedure getServiceAccountEmail，成功即視為登入
 * - P19c 會把下方 placeholder 換成真正的 BookingAdmin
 */
export default function AdminGate() {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [pw, setPw] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const utils = trpc.useUtils();

  // 驗證目前 sessionStorage 的密碼是否有效
  const validate = async () => {
    await utils.booking.getServiceAccountEmail.invalidate();
    await utils.booking.getServiceAccountEmail.fetch();
  };

  useEffect(() => {
    const saved = sessionStorage.getItem(PW_KEY);
    if (!saved) {
      setChecking(false);
      return;
    }
    validate()
      .then(() => setAuthed(true))
      .catch(() => sessionStorage.removeItem(PW_KEY))
      .finally(() => setChecking(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogin = async () => {
    if (!pw.trim()) return;
    setSubmitting(true);
    sessionStorage.setItem(PW_KEY, pw.trim());
    try {
      await validate();
      setAuthed(true);
    } catch {
      sessionStorage.removeItem(PW_KEY);
      toast.error("密碼錯誤");
    } finally {
      setSubmitting(false);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem(PW_KEY);
    setAuthed(false);
    setPw("");
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="flex items-center justify-center min-h-screen p-6 bg-muted/30">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>預約後台登入</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>管理密碼</Label>
              <input
                type="password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                className="mt-1.5 h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                autoFocus
              />
            </div>
            <Button className="w-full" onClick={handleLogin} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  驗證中...
                </>
              ) : (
                "登入"
              )}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <BookingAdmin onLogout={handleLogout} />
    </Suspense>
  );
}
