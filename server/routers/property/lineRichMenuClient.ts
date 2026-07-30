/**
 * LINE Messaging API — rich menu 低階封裝（messaging hub Phase 1）。
 *
 * 與既有 push 共用 LINE_MESSAGING_TENANT_ACCESS_TOKEN（同一把 channel access token
 * 即可呼叫 rich menu 端點）。CRUD／alias／assign 走 api.line.me；圖片二進位上傳走
 * api-data.line.me 的 content 端點。錯誤一律拋出含 HTTP 狀態與訊息。
 */
const API = "https://api.line.me";
const API_DATA = "https://api-data.line.me";

function token(): string {
  const t = process.env.LINE_MESSAGING_TENANT_ACCESS_TOKEN;
  if (!t) throw new Error("LINE_MESSAGING_TENANT_ACCESS_TOKEN not set");
  return t;
}

/** 呼叫 api.line.me 的 JSON 端點。jsonBody 省略＝無 body（GET/DELETE）。 */
async function lineCall(method: string, path: string, jsonBody?: unknown): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token()}` };
  let body: string | undefined;
  if (jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(jsonBody);
  }
  const resp = await fetch(`${API}${path}`, { method, headers, body, signal: AbortSignal.timeout(15000) });
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error(`LINE ${method} ${path} → ${resp.status}: ${text.slice(0, 300)}`);
  return text && (text[0] === "{" || text[0] === "[") ? JSON.parse(text) : text || null;
}

export type LineArea = {
  bounds: { x: number; y: number; width: number; height: number };
  action:
    | { type: "uri"; label?: string; uri: string }
    | { type: "message"; label?: string; text: string }
    | { type: "postback"; label?: string; data: string; displayText?: string }
    | { type: "richmenuswitch"; richMenuAliasId: string; data: string };
};

export type LineRichMenuObject = {
  size: { width: number; height: number };
  selected: boolean;
  name: string;
  chatBarText: string;
  areas: LineArea[];
};

/** 建立 rich menu，回傳 LINE 產生的 richMenuId。 */
export async function createRichMenu(menu: LineRichMenuObject): Promise<string> {
  const res = await lineCall("POST", "/v2/bot/richmenu", menu);
  if (!res?.richMenuId) throw new Error(`LINE createRichMenu 回應缺 richMenuId: ${JSON.stringify(res).slice(0, 200)}`);
  return res.richMenuId as string;
}

/** 上傳選單圖片位元組（走 api-data.line.me）。contentType 須為 image/png 或 image/jpeg。 */
export async function uploadRichMenuImage(richMenuId: string, bytes: ArrayBuffer | Buffer, contentType: string): Promise<void> {
  const resp = await fetch(`${API_DATA}/v2/bot/richmenu/${richMenuId}/content`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": contentType },
    body: bytes as any,
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`LINE uploadRichMenuImage → ${resp.status}: ${t.slice(0, 300)}`);
  }
}

export async function deleteRichMenu(richMenuId: string): Promise<void> {
  await lineCall("DELETE", `/v2/bot/richmenu/${richMenuId}`);
}

/** 列出帳號上所有 rich menu 的 id（用於 reconcile 比對）。 */
export async function listRichMenuIds(): Promise<string[]> {
  const res = await lineCall("GET", "/v2/bot/richmenu/list");
  return Array.isArray(res?.richmenus) ? res.richmenus.map((m: any) => m.richMenuId).filter(Boolean) : [];
}

/** 設為全體預設選單。 */
export async function setDefaultRichMenu(richMenuId: string): Promise<void> {
  await lineCall("POST", `/v2/bot/user/all/richmenu/${richMenuId}`);
}
/** 取消全體預設選單（撤銷）——之後未被個別指派的使用者就看不到任何預設選單。 */
export async function cancelDefaultRichMenu(): Promise<void> {
  await lineCall("DELETE", "/v2/bot/user/all/richmenu");
}

/** 用 replyToken 回覆（免費、不耗推播額度）。messages 為 LINE message 物件陣列；token 約 1 分鐘內有效、僅能用一次。 */
export async function replyMessage(replyToken: string, messages: any[]): Promise<void> {
  await lineCall("POST", "/v2/bot/message/reply", { replyToken, messages });
}

/** 指派／取消指派個別使用者（by LINE uid）。 */
export async function linkUserRichMenu(uid: string, richMenuId: string): Promise<void> {
  await lineCall("POST", `/v2/bot/user/${uid}/richmenu/${richMenuId}`);
}
export async function unlinkUserRichMenu(uid: string): Promise<void> {
  await lineCall("DELETE", `/v2/bot/user/${uid}/richmenu`);
}

/**
 * 建立或更新 alias（切換用的穩定把手）。alias 已存在則改指向新的 richMenuId。
 * 可重入：先嘗試建立，遇「已存在」再改用更新端點。
 */
export async function upsertRichMenuAlias(aliasId: string, richMenuId: string): Promise<void> {
  try {
    await lineCall("POST", "/v2/bot/richmenu/alias", { richMenuAliasId: aliasId, richMenuId });
  } catch (e: any) {
    const msg = String(e?.message || "");
    // 409 conflict 或 400 already exists → 改走更新端點重指
    if (msg.includes("→ 409") || msg.includes("→ 400") || msg.toLowerCase().includes("exist")) {
      await lineCall("POST", `/v2/bot/richmenu/alias/${aliasId}`, { richMenuId });
    } else {
      throw e;
    }
  }
}
export async function deleteRichMenuAlias(aliasId: string): Promise<void> {
  await lineCall("DELETE", `/v2/bot/richmenu/alias/${aliasId}`);
}

/** rich menu 尺寸常數（LINE 僅接受這兩種）。 */
export const RICH_MENU_SIZE = {
  full: { width: 2500, height: 1686 },
  half: { width: 2500, height: 843 },
} as const;
