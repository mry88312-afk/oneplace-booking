import { readFileSync } from "node:fs";
import { FIELDOPS_BASE_URL } from "../../shared/fieldops";

// 既有切換腳本從建置產物匯入此名稱。
export const legacyHub = FIELDOPS_BASE_URL;
export const notifyPath = "/api/booking/notify-line";
export const relayPath = "/api/line/relay";
export const roommateGroupNotifyPath = "/api/booking/roommate-group-notify";
export type HubPath = typeof notifyPath | typeof relayPath | typeof roommateGroupNotifyPath;
type Route = { primary: "zeabur" } | { primary: "gcp"; origin: string };

export function parseRoute(raw: string): Route {
  const config = JSON.parse(raw);
  if (config?.primary === "zeabur") return { primary: "zeabur" };
  if (config?.primary === "gcp" && typeof config.origin === "string") {
    const u = new URL(config.origin);
    if (u.origin === config.origin && /^https:\/\/[a-z0-9-]+\.oneplace\.com\.tw$/.test(u.origin))
      return { primary: "gcp", origin: u.origin };
  }
  throw Error("服務中台切換設定無效");
}

export function activeRoute(): Route {
  const file = process.env.BOOKING_HUB_ROUTE_FILE;
  return file ? parseRoute(readFileSync(file, "utf8")) : { primary: "zeabur" };
}

function request(url: string, secret: string, body: string, timeout: number) {
  return fetch(url, { method: "POST", redirect: "error", headers: {
    "Content-Type": "application/json", "X-Webhook-Secret": secret,
  }, body, signal: AbortSignal.timeout(timeout) });
}

// 只有空白探測可在站台間切換，正式內容由選定的站台處理一次。
export async function probeHub(origin: string, path: HubPath, secret: string): Promise<boolean> {
  try {
    const r = await request(origin + path, secret, "{}", 3000);
    if (r.status !== 400) { await r.body?.cancel(); return false; }
    // 群組端點對缺少 siteNo、text 或 dedupeKey 回 400。
    if (path === roommateGroupNotifyPath) {
      await r.body?.cancel();
      return true;
    }
    const body = await r.json();
    const required = path === relayPath ? ["lineEndpoint", "payload"] : ["tenantUid", "flexMessage"];
    return body?.error === "missing_fields" && Array.isArray(body.required)
      && required.every(k => body.required.includes(k));
  } catch { return false; }
}

type HubResponse = { ok: boolean; status?: number; error?: string; messageId?: string; deliveryStatus?: string };

export async function postToHub(path: HubPath, payload: object, opts?: { requireMessageId?: boolean }): Promise<HubResponse> {
  const secret = process.env.BOOKING_WEBHOOK_SECRET;
  if (!secret) return { ok: false, error: "BOOKING_WEBHOOK_SECRET 未設定；未發送" };
  let origin = FIELDOPS_BASE_URL;
  try {
    const route = activeRoute();
    if (route.primary === "gcp") {
      if (await probeHub(route.origin, path, secret)) origin = route.origin;
      else console.warn("[hub-route] Configured hub readiness failed; dispatch via default FieldOps origin");
    }
  } catch {
    return { ok: false, error: "中台路由設定無法讀取；未發送" };
  }
  // Once the real payload leaves us, neither HTTP errors nor timeouts prove non-delivery.
  // Never replay it to this or the other site.
  const groupNotice = path === roommateGroupNotifyPath;
  try {
    const r = await request(origin + path, secret, JSON.stringify(payload), 15000);
    console.info(`[hub-route] ${origin} ${path} HTTP ${r.status}`);
    if (r.ok) {
      const body = await r.json();
      if (groupNotice) {
        if (r.status === 200 && body?.ok === true && typeof body.status === "string")
          return { ok: true, status: r.status, deliveryStatus: body.status };
      } else if (body && typeof body === "object" && !Array.isArray(body) && !body.error
        && body.success !== false && body.ok !== false) {
        const id = body.sentMessages?.[0]?.id;
        if (!opts?.requireMessageId || (typeof id === "string" && id.trim()))
          return { ok: true, status: r.status, messageId: typeof id === "string" ? id : undefined };
      }
    } else await r.body?.cancel();
    if (groupNotice) return { ok: false, status: r.status, error: `群組通知回應未確認（HTTP ${r.status}）` };
    return { ok: false, status: r.status, error: `中台回應未確認（HTTP ${r.status}），請核對，勿重送` };
  } catch {
    if (groupNotice) return { ok: false, error: "群組通知結果未確認（連線中斷、逾時或回應無效）" };
    return { ok: false, error: "發送結果不明（逾時、連線中斷或回應無效），請核對，勿重送" };
  }
}
