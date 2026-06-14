/**
 * messaging hub — Phase 1 後端 router（asset 圖片託管 + rich menu 管理／發布）。
 *
 * 單一事實來源在 Supabase messaging schema；本 router 把它發布／同步到 LINE。
 * 全部走 adminProcedure（自帶 x-admin-password 驗證）。
 * - 圖片上傳：收 base64 → Storage REST（SUPABASE_SERVICE_ROLE_KEY）→ 寫 messaging.asset。
 * - rich menu：DB CRUD → 可重入 publish（建新→上傳圖→重指 alias→刪舊）→ 預設／個別租客指派 → reconcile。
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure } from "../../_core/trpc";
import { sbQuery, isSupabaseConfigured } from "../../db/supabaseClient";
import * as line from "./lineRichMenuClient";
import { RICH_MENU_SIZE, type LineRichMenuObject, type LineArea } from "./lineRichMenuClient";

const BUCKET = "line-assets";
const sbUrl = () => process.env.SUPABASE_URL;
const sbKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertDb() {
  if (!isSupabaseConfigured())
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "SUPABASE_DB_URL 未設定" });
}
function assertStorage() {
  if (!sbUrl() || !sbKey())
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY 未設定（請於 Zeabur 環境變數設定後重新部署）",
    });
}

/** 上傳位元組到公開 bucket，回傳 public URL。 */
async function storageUpload(path: string, bytes: Buffer, contentType: string): Promise<string> {
  assertStorage();
  const resp = await fetch(`${sbUrl()}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    // 同時帶 apikey + Authorization：相容舊 service_role JWT 與新版 sb_secret_ 金鑰
    headers: { apikey: sbKey() as string, Authorization: `Bearer ${sbKey()}`, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes as any,
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Storage 上傳失敗 ${resp.status}: ${t.slice(0, 200)}` });
  }
  return `${sbUrl()}/storage/v1/object/public/${BUCKET}/${path}`;
}

// ─── area 映射 ───────────────────────────────────────────────
const AREA_ACTION_TYPES = ["uri", "message", "postback", "richmenuswitch"] as const;

function mapAreaToLine(a: any): LineArea {
  const bounds = { x: a.x, y: a.y, width: a.width, height: a.height };
  const p = a.action_payload || a.actionPayload || {};
  const t = a.action_type || a.actionType;
  if (t === "uri")
    return { bounds, action: { type: "uri", label: a.label || p.label || undefined, uri: String(p.uri || "") } };
  if (t === "message")
    return { bounds, action: { type: "message", label: a.label || p.label || undefined, text: String(p.text || "") } };
  if (t === "postback")
    return { bounds, action: { type: "postback", label: a.label || p.label || undefined, data: String(p.data || ""), displayText: p.displayText ? String(p.displayText) : undefined } };
  return { bounds, action: { type: "richmenuswitch", richMenuAliasId: String(p.richMenuAliasId || ""), data: String(p.data || "switch") } };
}
function assembleLineMenu(m: any, areas: any[]): LineRichMenuObject {
  const size = m.size === "half" ? RICH_MENU_SIZE.half : RICH_MENU_SIZE.full;
  return {
    size,
    selected: !!m.selected,
    name: String(m.name || m.key).slice(0, 300),
    chatBarText: String(m.chat_bar_text || "選單").slice(0, 14),
    areas: areas.map(mapAreaToLine),
  };
}

const areaInput = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  actionType: z.string(),
  actionPayload: z.any().optional(),
  label: z.string().optional(),
  sortOrder: z.number().int().optional(),
});

export const messagingRouter = router({
  // ── 圖片資產 ──────────────────────────────────────────────
  uploadAsset: adminProcedure
    .input(
      z.object({
        filename: z.string().min(1).max(200),
        contentType: z.enum(["image/png", "image/jpeg"]),
        dataBase64: z.string().min(1),
        kind: z.enum(["flex_image", "richmenu_image"]).default("flex_image"),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      assertDb();
      const raw = input.dataBase64.includes(",") ? input.dataBase64.slice(input.dataBase64.indexOf(",") + 1) : input.dataBase64;
      const buf = Buffer.from(raw, "base64");
      if (buf.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "圖片內容為空" });
      if (input.kind === "richmenu_image") {
        // LINE 規範：JPEG/PNG、寬 800–2500、高 ≥250、長寬比(寬/高) ≥1.45、檔案 ≤1MB
        if (buf.length > 1024 * 1024)
          throw new TRPCError({ code: "BAD_REQUEST", message: `圖文選單圖片需 ≤1MB（目前 ${(buf.length / 1024 / 1024).toFixed(2)}MB）` });
        if (input.width && input.height) {
          const w = input.width, h = input.height;
          if (w < 800 || w > 2500) throw new TRPCError({ code: "BAD_REQUEST", message: `圖文選單寬度需 800–2500（目前 ${w}）` });
          if (h < 250) throw new TRPCError({ code: "BAD_REQUEST", message: `圖文選單高度需 ≥250（目前 ${h}）` });
          if (w / h < 1.45) throw new TRPCError({ code: "BAD_REQUEST", message: `圖文選單長寬比(寬/高)需 ≥1.45（目前 ${(w / h).toFixed(2)}）` });
        }
      }
      const safe = input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
      const path = `${input.kind}/${randomUUID()}-${safe}`;
      const publicUrl = await storageUpload(path, buf, input.contentType);
      const rows = await sbQuery<{ id: number }>(
        `insert into messaging.asset (bucket_path, public_url, kind, content_type, width, height, byte_size, uploaded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [path, publicUrl, input.kind, input.contentType, input.width ?? null, input.height ?? null, buf.length, "admin"],
      );
      return { assetId: Number(rows[0].id), publicUrl }; // bigint 經 pg 回傳是字串 → 轉 number
    }),

  listAssets: adminProcedure
    .input(z.object({ kind: z.enum(["flex_image", "richmenu_image"]).optional() }).optional())
    .query(async ({ input }) => {
      assertDb();
      return sbQuery(
        `select id, public_url, kind, content_type, width, height, byte_size,
                to_char(created_at at time zone 'Asia/Taipei','YYYY-MM-DD HH24:MI') as created_at
           from messaging.asset ${input?.kind ? "where kind=$1" : ""}
          order by id desc limit 200`,
        input?.kind ? [input.kind] : [],
      );
    }),

  // ── 圖文選單 ──────────────────────────────────────────────
  listRichMenus: adminProcedure.query(async () => {
    assertDb();
    return sbQuery(
      `select rm.id, rm.key, rm.name, rm.chat_bar_text, rm.size, rm.selected, rm.image_asset_id,
              rm.line_rich_menu_id, rm.status, rm.generator_config,
              (select a.public_url from messaging.asset a where a.id = rm.image_asset_id) as image_url,
              coalesce((select json_agg(ar order by ar.sort_order, ar.id)
                          from messaging.rich_menu_area ar where ar.rich_menu_id = rm.id), '[]') as areas,
              (select al.alias_id from messaging.rich_menu_alias al where al.rich_menu_key = rm.key limit 1) as alias_id,
              (select string_agg(asg.scope || coalesce(':' || asg.tenant_uid, ''), ', ')
                 from messaging.rich_menu_assignment asg where asg.rich_menu_key = rm.key and asg.status='active') as assignments
         from messaging.rich_menu rm order by rm.created_at desc`,
    );
  }),

  upsertRichMenu: adminProcedure
    .input(
      z.object({
        key: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/, "key 僅能小寫英數、_、-（≤32，會作為 LINE rich menu alias）"),
        name: z.string().min(1).max(300),
        chatBarText: z.string().min(1).max(14).default("選單"),
        size: z.enum(["full", "half"]).default("full"),
        selected: z.boolean().default(true),
        imageAssetId: z
          .preprocess((v) => (v === null || v === undefined || v === "" ? null : Number(v)), z.number().int().positive().nullable())
          .optional(),
        aliasId: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/, "alias 僅能小寫英數、_、-（≤32）").optional(),
        areas: z.array(areaInput).max(20, "點擊區最多 20 個").default([]),
        generatorConfig: z.any().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      assertDb();
      for (const a of input.areas) {
        if (!AREA_ACTION_TYPES.includes(a.actionType as any))
          throw new TRPCError({ code: "BAD_REQUEST", message: `不支援的點擊區動作類型：${a.actionType}（僅支援 uri、richmenuswitch）` });
      }
      // 編輯即視為需重新發布 → status 回 draft
      const up = await sbQuery<{ id: number }>(
        `insert into messaging.rich_menu (key,name,chat_bar_text,size,selected,image_asset_id,generator_config,status,updated_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,'draft',now())
         on conflict (key) do update set name=excluded.name, chat_bar_text=excluded.chat_bar_text,
           size=excluded.size, selected=excluded.selected, image_asset_id=excluded.image_asset_id,
           generator_config=coalesce(excluded.generator_config, rich_menu.generator_config),
           status='draft', updated_at=now()
         returning id`,
        [input.key, input.name, input.chatBarText, input.size, input.selected, input.imageAssetId ?? null,
         input.generatorConfig ? JSON.stringify(input.generatorConfig) : null],
      );
      const menuId = up[0].id;
      await sbQuery(`delete from messaging.rich_menu_area where rich_menu_id=$1`, [menuId]);
      let i = 0;
      for (const a of input.areas) {
        await sbQuery(
          `insert into messaging.rich_menu_area (rich_menu_id,x,y,width,height,action_type,action_payload,label,sort_order)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [menuId, a.x, a.y, a.width, a.height, a.actionType, JSON.stringify(a.actionPayload ?? {}), a.label ?? null, a.sortOrder ?? i++],
        );
      }
      // 確保有 alias 列（切換的穩定把手；預設用 key 當 alias_id）
      const aliasId = input.aliasId || input.key;
      await sbQuery(
        `insert into messaging.rich_menu_alias (alias_id, rich_menu_key)
         values ($1,$2)
         on conflict (alias_id) do update set rich_menu_key=excluded.rich_menu_key, line_synced=false, updated_at=now()`,
        [aliasId, input.key],
      );
      return { id: menuId, key: input.key, status: "draft", aliasId };
    }),

  previewRichMenu: adminProcedure
    .input(z.object({ key: z.string() }))
    .query(async ({ input }) => {
      assertDb();
      const m = (await sbQuery<any>(`select * from messaging.rich_menu where key=$1`, [input.key]))[0];
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: `找不到圖文選單 ${input.key}` });
      const areas = await sbQuery<any>(`select * from messaging.rich_menu_area where rich_menu_id=$1 order by sort_order, id`, [m.id]);
      return assembleLineMenu(m, areas); // 只回傳將送往 LINE 的 JSON，不呼叫 LINE
    }),

  publishRichMenu: adminProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ input }) => {
      assertDb();
      const m = (await sbQuery<any>(`select * from messaging.rich_menu where key=$1`, [input.key]))[0];
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: `找不到圖文選單 ${input.key}` });
      const areas = await sbQuery<any>(`select * from messaging.rich_menu_area where rich_menu_id=$1 order by sort_order, id`, [m.id]);
      if (!m.image_asset_id) throw new TRPCError({ code: "BAD_REQUEST", message: "尚未設定選單圖片，無法發布" });
      const asset = (await sbQuery<any>(`select * from messaging.asset where id=$1`, [m.image_asset_id]))[0];
      if (!asset) throw new TRPCError({ code: "BAD_REQUEST", message: "選單圖片資產不存在" });

      // 由公開 URL 取得位元組（公開 bucket，不需金鑰）
      const imgResp = await fetch(asset.public_url, { signal: AbortSignal.timeout(20000) });
      if (!imgResp.ok) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `讀取選單圖片失敗 ${imgResp.status}` });
      const bytes = Buffer.from(await imgResp.arrayBuffer());
      if (bytes.length > 1024 * 1024)
        throw new TRPCError({ code: "BAD_REQUEST", message: `選單圖片需 ≤1MB（目前 ${(bytes.length / 1024 / 1024).toFixed(2)}MB）` });
      const contentType = asset.content_type === "image/jpeg" ? "image/jpeg" : "image/png";

      // 建新選單 → 上傳圖（失敗則清掉剛建的，不留半成品）
      // 過濾沒填或不合規的 uri 點擊區（LINE 要求 uri 須為 http/https/tel/line 開頭，否則回 400）
      const validUri = (u: string) => /^(https?|tel|line):/i.test(u.trim());
      const okArea = (a: any) => {
        if (a.action_type === "uri") return validUri(String(a.action_payload?.uri || ""));
        if (a.action_type === "message") return !!String(a.action_payload?.text || "").trim();
        if (a.action_type === "postback") return !!String(a.action_payload?.data || "").trim();
        return true; // richmenuswitch
      };
      const sendAreas = areas.filter(okArea);
      if (sendAreas.length === 0) throw new TRPCError({ code: "BAD_REQUEST", message: "沒有可用的點擊區（按鈕都沒填內容、也沒有切換頁）" });
      const newId = await line.createRichMenu(assembleLineMenu(m, sendAreas));
      try {
        await line.uploadRichMenuImage(newId, bytes, contentType);
      } catch (e) {
        await line.deleteRichMenu(newId).catch(() => {});
        throw e;
      }

      // 重指 alias 到新選單
      const aliasRow = (await sbQuery<any>(`select alias_id from messaging.rich_menu_alias where rich_menu_key=$1 limit 1`, [input.key]))[0];
      const aliasId = aliasRow?.alias_id || input.key;
      await line.upsertRichMenuAlias(aliasId, newId);
      await sbQuery(`update messaging.rich_menu_alias set line_synced=true, updated_at=now() where alias_id=$1`, [aliasId]);

      const oldId: string | null = m.line_rich_menu_id;
      await sbQuery(`update messaging.rich_menu set line_rich_menu_id=$1, status='published', updated_at=now() where id=$2`, [newId, m.id]);

      // 既有指派重指到新 id（預設／個別租客）
      const asg = await sbQuery<any>(`select scope, tenant_uid from messaging.rich_menu_assignment where rich_menu_key=$1 and status='active'`, [input.key]);
      for (const a of asg) {
        if (a.scope === "default") await line.setDefaultRichMenu(newId).catch((e: any) => console.error("[messaging] publish setDefault:", e?.message));
        else if (a.tenant_uid) await line.linkUserRichMenu(a.tenant_uid, newId).catch((e: any) => console.error("[messaging] publish relink:", e?.message));
      }
      // 刪舊選單避免孤兒
      if (oldId && oldId !== newId) await line.deleteRichMenu(oldId).catch((e: any) => console.error("[messaging] publish delete old:", e?.message));

      return { key: input.key, lineRichMenuId: newId, aliasId };
    }),

  setDefaultRichMenu: adminProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ input }) => {
      assertDb();
      const m = (await sbQuery<any>(`select line_rich_menu_id from messaging.rich_menu where key=$1`, [input.key]))[0];
      if (!m?.line_rich_menu_id) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "請先發布此選單再設為預設" });
      await line.setDefaultRichMenu(m.line_rich_menu_id);
      await sbQuery(`delete from messaging.rich_menu_assignment where scope='default'`);
      await sbQuery(`insert into messaging.rich_menu_assignment (scope, rich_menu_key, status) values ('default',$1,'active')`, [input.key]);
      return { ok: true };
    }),

  // 撤銷：清除「全體預設」選單。已被個別指派(指派給特定 UID)的人不受影響、仍看得到。
  clearDefault: adminProcedure.mutation(async () => {
    assertDb();
    await line.cancelDefaultRichMenu();
    await sbQuery(`delete from messaging.rich_menu_assignment where scope='default'`);
    return { ok: true };
  }),

  assignTenant: adminProcedure
    .input(z.object({ uid: z.string().min(1), key: z.string() }))
    .mutation(async ({ input }) => {
      assertDb();
      const m = (await sbQuery<any>(`select line_rich_menu_id from messaging.rich_menu where key=$1`, [input.key]))[0];
      if (!m?.line_rich_menu_id) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "請先發布此選單再指派" });
      await line.linkUserRichMenu(input.uid, m.line_rich_menu_id);
      await sbQuery(`delete from messaging.rich_menu_assignment where scope='tenant' and tenant_uid=$1`, [input.uid]);
      await sbQuery(`insert into messaging.rich_menu_assignment (scope, tenant_uid, rich_menu_key, status) values ('tenant',$1,$2,'active')`, [input.uid, input.key]);
      return { ok: true };
    }),

  unassignTenant: adminProcedure
    .input(z.object({ uid: z.string().min(1) }))
    .mutation(async ({ input }) => {
      assertDb();
      await line.unlinkUserRichMenu(input.uid).catch((e: any) => console.error("[messaging] unlink:", e?.message));
      await sbQuery(`delete from messaging.rich_menu_assignment where scope='tenant' and tenant_uid=$1`, [input.uid]);
      return { ok: true };
    }),

  deleteRichMenu: adminProcedure
    .input(z.object({ key: z.string() }))
    .mutation(async ({ input }) => {
      assertDb();
      const m = (await sbQuery<any>(`select id, line_rich_menu_id from messaging.rich_menu where key=$1`, [input.key]))[0];
      if (!m) throw new TRPCError({ code: "NOT_FOUND", message: `找不到圖文選單 ${input.key}` });
      const aliasRow = (await sbQuery<any>(`select alias_id from messaging.rich_menu_alias where rich_menu_key=$1 limit 1`, [input.key]))[0];
      if (aliasRow?.alias_id) await line.deleteRichMenuAlias(aliasRow.alias_id).catch(() => {});
      if (m.line_rich_menu_id) await line.deleteRichMenu(m.line_rich_menu_id).catch((e: any) => console.error("[messaging] delete LINE menu:", e?.message));
      await sbQuery(`delete from messaging.rich_menu_assignment where rich_menu_key=$1`, [input.key]);
      await sbQuery(`delete from messaging.rich_menu_alias where rich_menu_key=$1`, [input.key]);
      await sbQuery(`delete from messaging.rich_menu where id=$1`, [m.id]); // areas 隨 cascade 刪除
      return { ok: true };
    }),

  reconcile: adminProcedure.mutation(async () => {
    assertDb();
    const lineIds = await line.listRichMenuIds();
    const tracked = (await sbQuery<any>(`select line_rich_menu_id from messaging.rich_menu where line_rich_menu_id is not null`)).map((r) => r.line_rich_menu_id);
    const trackedSet = new Set(tracked);
    const removed: string[] = [];
    for (const id of lineIds) {
      if (!trackedSet.has(id)) {
        await line.deleteRichMenu(id).catch((e: any) => console.error("[messaging] reconcile delete:", e?.message));
        removed.push(id);
      }
    }
    return { removed, keptTracked: tracked.length };
  }),
});
