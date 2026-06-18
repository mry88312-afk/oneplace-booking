import { useState, useRef, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, ChevronUp, ChevronDown, Upload, Wand2 } from "lucide-react";

type Btn = { id: number; label: string; atype: "uri" | "message" | "postback"; url: string; text: string; query?: string; icon?: string };
// 「查詢」按鈕用 postback，data 走 mh:*，由 /api/line/inbound 認租客後查詢並 reply。
const QUERY_OPTIONS = [
  { data: "mh:contract", label: "合約查詢" },
  { data: "mh:rent", label: "繳租紀錄" },
  { data: "mh:va", label: "繳租帳號" },
  { data: "mh:repair", label: "報修進度" },
  { data: "mh:faq", label: "常見問題" },
];
let _seq = 1;
const nb = (label = "", url = ""): Btn => ({ id: _seq++, label, atype: "uri", url, text: "" });

const lc = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);

/** 依尺寸 + 按鈕數算出畫布與各按鈕格子座標（全版 2 欄、半版 1 列）。 */
function layout(size: "full" | "half", n: number) {
  const W = 2500;
  if (size === "half") {
    const H = 843, tabH = 170, cols = Math.max(1, n), cellW = W / cols, cellH = H - tabH;
    const cells = Array.from({ length: n }, (_, i) => ({ x: Math.round(i * cellW), y: tabH, w: Math.round(cellW), h: cellH }));
    return { W, H, tabH, cells };
  }
  const H = 1686, tabH = 300, rows = Math.max(1, Math.ceil(n / 2)), cellW = 1250, cellH = (H - tabH) / rows;
  const cells = Array.from({ length: n }, (_, i) => ({ x: (i % 2) * cellW, y: Math.round(tabH + Math.floor(i / 2) * cellH), w: cellW, h: Math.round(cellH) }));
  return { W, H, tabH, cells };
}

function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function lineIcon(g: CanvasRenderingContext2D, type: string, cx: number, cy: number, s: number, col: string) {
  g.strokeStyle = col; g.lineWidth = Math.max(5, Math.round(s * 0.085)); g.lineJoin = "round"; g.lineCap = "round";
  const h = s / 2;
  if (type === "doc") { g.beginPath(); g.moveTo(cx - h * 0.7, cy - h); g.lineTo(cx + h * 0.3, cy - h); g.lineTo(cx + h * 0.7, cy - h * 0.6); g.lineTo(cx + h * 0.7, cy + h); g.lineTo(cx - h * 0.7, cy + h); g.closePath(); g.stroke(); g.beginPath(); g.moveTo(cx - h * 0.4, cy); g.lineTo(cx + h * 0.4, cy); g.moveTo(cx - h * 0.4, cy + h * 0.4); g.lineTo(cx + h * 0.4, cy + h * 0.4); g.stroke(); }
  else if (type === "list") { rr(g, cx - h * 0.65, cy - h, s * 0.65, s, s * 0.12); g.stroke(); g.beginPath(); for (let k = -1; k <= 1; k++) { g.moveTo(cx - h * 0.3, cy + k * h * 0.45); g.lineTo(cx + h * 0.4, cy + k * h * 0.45); } g.stroke(); }
  else if (type === "pin") { g.beginPath(); g.arc(cx, cy - h * 0.2, h * 0.55, Math.PI, 0); g.lineTo(cx, cy + h * 0.9); g.closePath(); g.stroke(); g.beginPath(); g.arc(cx, cy - h * 0.2, h * 0.18, 0, Math.PI * 2); g.stroke(); }
  else if (type === "building") { rr(g, cx - h * 0.6, cy - h, s * 0.6, s * 0.95, s * 0.06); g.stroke(); g.beginPath(); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 0; b++) { g.rect(cx - h * 0.32 + a * h * 0.34, cy - h * 0.55 + b * h * 0.5, h * 0.18, h * 0.18); } g.stroke(); }
  else if (type === "pay") { g.beginPath(); g.arc(cx, cy, h * 0.6, 0, Math.PI * 2); g.stroke(); g.font = "600 " + Math.round(s * 0.7) + "px sans-serif"; g.fillStyle = col; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText("$", cx, cy + 2); }
  else if (type === "star") { g.beginPath(); for (let t = 0; t < 10; t++) { const rad = t % 2 ? h * 0.45 : h * 0.95; const ang = -Math.PI / 2 + t * Math.PI / 5; const px = cx + Math.cos(ang) * rad, py = cy + Math.sin(ang) * rad; t ? g.lineTo(px, py) : g.moveTo(px, py); } g.closePath(); g.stroke(); }
  else { g.beginPath(); g.arc(cx, cy, h * 0.55, 0, Math.PI * 2); g.stroke(); }
}
function iconFor(lab: string) {
  lab = lab || "";
  if (/帳號/.test(lab)) return "doc";                                  // 繳租帳號/虛擬帳號 → 文件
  if (/繳租|繳費|付款|帳單|匯款|轉帳/.test(lab)) return "pay";          // 繳租/匯款紀錄 → $
  if (/合約|簽約/.test(lab)) return "doc";
  if (/修繕|維修|報修|記錄|紀錄|查詢/.test(lab)) return "list";
  if (/地圖|找房|看房|位置|聯絡|專員/.test(lab)) return "pin";
  if (/好物|推薦|優惠|精選|團購|社群|社團/.test(lab)) return "star";   // 團購社群 → 星星
  if (/品牌|公司|關於|問題|常見/i.test(lab)) return "building";
  return "dot";
}

/** 匯出 PNG；>1MB 自動改 JPEG（符合 LINE ≤1MB）。 */
export function exportImg(cv: HTMLCanvasElement): Promise<{ dataBase64: string; contentType: "image/png" | "image/jpeg" }> {
  return new Promise((resolve) => {
    const toB64 = (blob: Blob, ct: "image/png" | "image/jpeg") => {
      const fr = new FileReader(); fr.onload = () => resolve({ dataBase64: String(fr.result), contentType: ct }); fr.readAsDataURL(blob);
    };
    cv.toBlob((b) => {
      if (b && b.size <= 1024 * 1024) toB64(b, "image/png");
      else cv.toBlob((b2) => toB64(b2 as Blob, "image/jpeg"), "image/jpeg", 0.85);
    }, "image/png");
  });
}

/** 共用的選單繪圖（產生器預覽 + 一鍵重套用都用這個，確保樣式一致）。 */
export function renderRichMenuCanvas(
  canvas: HTMLCanvasElement,
  opts: { color: string; tabA: string; tabB: string; active: number; size: "full" | "half"; buttons: { id?: number; label: string; icon?: string }[]; imgs?: Record<number, HTMLImageElement>; showIcon?: boolean },
) {
  const { color, active, size } = opts;
  const buttons = opts.buttons || [];
  const imgs = opts.imgs || {};
  const showIcon = opts.showIcon !== false;
  const { W, H, tabH, cells } = layout(size, Math.max(1, buttons.length));
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext("2d"); if (!g) return;
  g.fillStyle = color; g.fillRect(0, 0, W, H);
  const fam = 'system-ui,"PingFang TC","Microsoft JhengHei",sans-serif';
  const tabs = [opts.tabA || "一般服務", opts.tabB || "合約與紀錄"];
  g.font = "700 " + Math.round(tabH * 0.38) + "px " + fam; g.textAlign = "center"; g.textBaseline = "middle";
  for (let i = 0; i < 2; i++) {
    const x = i * (W / 2), on = i === active;
    g.fillStyle = on ? color : "#ffffff"; g.fillRect(x, 0, W / 2, tabH);
    g.fillStyle = on ? "#ffffff" : color; g.fillText(tabs[i], x + W / 4, tabH / 2);
  }
  buttons.forEach((b, m) => {
    const c = cells[m]; if (!c) return;
    const pad = Math.min(56, c.h * 0.13, c.w * 0.08), rad = Math.min(70, c.h * 0.17);
    const iconS = Math.min(150, c.h * 0.30, c.w * 0.46), labelF = Math.max(46, Math.min(100, Math.round(c.h * 0.18)));
    g.save(); g.shadowColor = "rgba(0,0,0,0.20)"; g.shadowBlur = Math.round(c.h * 0.06); g.shadowOffsetY = Math.round(c.h * 0.03);
    g.fillStyle = "#ffffff"; rr(g, c.x + pad, c.y + pad, c.w - 2 * pad, c.h - 2 * pad, rad); g.fill(); g.restore();
    if (showIcon) {
      const iconCy = c.y + c.h / 2 - c.h * 0.16;
      const im = b.id != null ? imgs[b.id] : undefined;
      if (b.icon && im && im.complete && im.naturalWidth) {
        const ar = im.naturalWidth / im.naturalHeight; let w = iconS, h = iconS;
        if (ar > 1) h = iconS / ar; else w = iconS * ar;
        g.drawImage(im, c.x + c.w / 2 - w / 2, iconCy - h / 2, w, h);
      } else {
        lineIcon(g, iconFor(b.label), c.x + c.w / 2, iconCy, iconS, color);
      }
    }
    g.fillStyle = color; g.font = "700 " + labelF + "px " + fam; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(b.label || "", c.x + c.w / 2, showIcon ? c.y + c.h / 2 + c.h * 0.22 : c.y + c.h / 2);
  });
  void H;
}

/** 由產生器設定算出點擊區（一鍵重套用用）。 */
export function buildConfigAreas(cfg: any) {
  const size = cfg.size === "half" ? "half" : "full";
  const btns = Array.isArray(cfg.buttons) ? cfg.buttons : [];
  const { W, tabH, cells } = layout(size, Math.max(1, btns.length));
  const act = parseInt(String(cfg.active ?? "0"), 10);
  const areas: any[] = [];
  if (cfg.switchAlias) {
    const tabX = act === 0 ? W / 2 : 0;
    areas.push({ x: Math.round(tabX), y: 0, width: Math.round(W / 2), height: tabH, actionType: "richmenuswitch", actionPayload: { richMenuAliasId: cfg.switchAlias, data: "switch" }, sortOrder: 0 });
  }
  btns.forEach((b: any, i: number) => {
    const c = cells[i]; if (!c) return;
    let actionType = "uri"; let payload: any = { uri: b.url || "" };
    if (b.atype === "postback") { actionType = "postback"; payload = { data: b.query || "", displayText: b.label || undefined }; }
    else if (b.atype === "message") { actionType = "message"; payload = { text: b.text || "" }; }
    areas.push({ x: c.x, y: c.y, width: c.w, height: c.h, actionType, actionPayload: payload, label: b.label, sortOrder: i + 1 });
  });
  return areas;
}

export function RichMenuGenerator({ open, onClose, onDone, initial }: { open: boolean; onClose: () => void; onDone: () => void; initial?: any }) {
  const upload = trpc.messaging.uploadAsset.useMutation();
  const upsert = trpc.messaging.upsertRichMenu.useMutation();

  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [chatBarText, setChatBarText] = useState("選單");
  const [size, setSize] = useState<"full" | "half">("full");
  const [selected, setSelected] = useState(true);
  const [tabA, setTabA] = useState("一般服務");
  const [tabB, setTabB] = useState("合約與紀錄");
  const [active, setActive] = useState("0"); // 本頁反白：0=A、1=B
  const [switchAlias, setSwitchAlias] = useState(""); // 點另一頁切到的 alias（單頁可留空）
  const [color, setColor] = useState("#2e4a36");
  const [msgPrefix, setMsgPrefix] = useState("▶");
  const [showIcon, setShowIcon] = useState(true);
  const [buttons, setButtons] = useState<Btn[]>([nb("我的合約"), nb("修繕報修"), nb("房屋繳租"), nb("好物推薦")]);
  const [tick, setTick] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgs = useRef<Record<number, HTMLImageElement>>({});
  const busy = upload.isPending || upsert.isPending;
  const act = parseInt(active, 10);
  const setCanvas = useCallback((node: HTMLCanvasElement | null) => { canvasRef.current = node; if (node) setTick((t) => t + 1); }, []);

  const draw = useCallback(() => {
    if (canvasRef.current) renderRichMenuCanvas(canvasRef.current, { color, tabA, tabB, active: act, size, buttons, imgs: imgs.current, showIcon });
  }, [color, tabA, tabB, act, buttons, size, showIcon]);

  useEffect(() => { if (open) draw(); }, [open, draw, tick]);

  // 開啟時載入設定：有 initial → 載回該選單的產生器設定（編輯）；無 → 重設為新範本
  useEffect(() => {
    if (!open) return;
    imgs.current = {};
    if (initial) {
      setKey(initial.key || ""); setName(initial.name || ""); setChatBarText(initial.chatBarText || "選單");
      setSize(initial.size === "half" ? "half" : "full"); setSelected(initial.selected !== false);
      setTabA(initial.tabA || "一般服務"); setTabB(initial.tabB || "合約與紀錄");
      setActive(String(initial.active ?? "0")); setSwitchAlias(initial.switchAlias || ""); setColor(initial.color || "#2e4a36"); setMsgPrefix(initial.msgPrefix ?? "▶"); setShowIcon(initial.showIcon !== false);
      const bs = Array.isArray(initial.buttons) && initial.buttons.length ? initial.buttons : [{ label: "" }];
      const mapped = bs.map((b: any) => ({ id: _seq++, label: b.label || "", atype: (b.atype === "message" || b.atype === "postback") ? b.atype : "uri", url: b.url || "", text: b.text || "", query: b.query || "", icon: b.icon || undefined } as Btn));
      setButtons(mapped);
      mapped.forEach((b) => { if (b.icon) { const im = new Image(); im.onload = () => { imgs.current[b.id] = im; setTick((t) => t + 1); }; im.src = b.icon; } });
    } else {
      setKey(""); setName(""); setChatBarText("選單"); setSize("full"); setSelected(true);
      setTabA("一般服務"); setTabB("合約與紀錄"); setActive("0"); setSwitchAlias(""); setColor("#2e4a36"); setMsgPrefix("▶"); setShowIcon(true);
      setButtons([nb("我的合約"), nb("修繕報修"), nb("房屋繳租"), nb("好物推薦")]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onIcon = (id: number, file?: File) => {
    if (!file) return;
    if (file.type !== "image/png" && file.type !== "image/jpeg") { toast.error("icon 需 PNG/JPEG"); return; }
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      setButtons((bs) => bs.map((b) => (b.id === id ? { ...b, icon: url } : b)));
      const im = new Image(); im.onload = () => { imgs.current[id] = im; setTick((t) => t + 1); }; im.src = url;
    };
    r.readAsDataURL(file);
  };
  const move = (i: number, dir: -1 | 1) => {
    setButtons((bs) => { const j = i + dir; if (j < 0 || j >= bs.length) return bs; const c = bs.slice(); [c[i], c[j]] = [c[j], c[i]]; return c; });
  };
  const patch = (id: number, p: Partial<Btn>) => setButtons((bs) => bs.map((b) => (b.id === id ? { ...b, ...p } : b)));
  const removeBtn = (id: number) => setButtons((bs) => (bs.length > 1 ? bs.filter((b) => b.id !== id) : bs));
  const addBtn = () => setButtons((bs) => (bs.length < 6 ? [...bs, nb()] : bs));

  const generate = async () => {
    if (!key.trim() || !name.trim()) { toast.error("請填 key 與名稱"); return; }
    const cv = canvasRef.current; if (!cv) return;
    draw();
    try {
      const img = await exportImg(cv);
      const { W, H, tabH, cells } = layout(size, Math.max(1, buttons.length));
      const asset = await upload.mutateAsync({ filename: key.trim() + (img.contentType === "image/jpeg" ? ".jpg" : ".png"), contentType: img.contentType, dataBase64: img.dataBase64, kind: "richmenu_image", width: W, height: H });
      const areas: any[] = [];
      if (switchAlias.trim()) {
        const tabX = act === 0 ? W / 2 : 0;
        areas.push({ x: Math.round(tabX), y: 0, width: Math.round(W / 2), height: tabH, actionType: "richmenuswitch", actionPayload: { richMenuAliasId: switchAlias.trim(), data: "switch" }, sortOrder: 0 });
      }
      buttons.forEach((b, i) => {
        const c = cells[i]; if (!c) return;
        let actionType: string = "uri"; let payload: any = { uri: b.url || "" };
        if (b.atype === "postback") { actionType = "postback"; payload = { data: b.query || "", displayText: b.label || undefined }; }
        else if (b.atype === "message") { actionType = "message"; payload = { text: (msgPrefix || "") + (b.text || "") }; }
        areas.push({ x: c.x, y: c.y, width: c.w, height: c.h, actionType, actionPayload: payload, label: b.label, sortOrder: i + 1 });
      });
      const generatorConfig = { key: key.trim(), name: name.trim(), chatBarText, size, selected, tabA, tabB, active, switchAlias, color, msgPrefix, showIcon, buttons: buttons.map((b) => ({ label: b.label, atype: b.atype, url: b.url, text: b.text, query: b.query, icon: b.icon })) };
      await upsert.mutateAsync({ key: key.trim(), name: name.trim(), chatBarText: (chatBarText.trim() || name.trim()).slice(0, 14), size, selected, imageAssetId: asset.assetId, aliasId: key.trim(), areas, generatorConfig });
      toast.success("已產生圖片並建立草稿選單，去「發布」即可");
      onDone(); onClose();
    } catch (e: any) {
      toast.error(e?.message || "產生失敗（圖片上傳需 Zeabur 設好 SUPABASE_URL／SUPABASE_SERVICE_ROLE_KEY）");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle><Wand2 className="h-4 w-4 inline mr-1" /> 範本產生器（自動產圖＋建好點擊區）</DialogTitle>
          <DialogDescription>填字、（可選）上傳 icon、調順序 → 一鍵產生圖片並建立草稿選單，之後直接發布。</DialogDescription>
        </DialogHeader>

        <div className="grid md:grid-cols-2 gap-4">
          {/* 左：設定 */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div><Label>key（小寫英數_-，≤32）{initial ? "（編輯中不可改）" : ""}</Label><Input value={key} disabled={!!initial} onChange={(e) => setKey(lc(e.target.value))} placeholder="menu_general" /></div>
              <div><Label>名稱（管理用 ≤300）</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="一般服務" /></div>
              <div><Label>選單列文字 chatBarText（≤14）</Label><Input value={chatBarText} maxLength={14} onChange={(e) => setChatBarText(e.target.value)} placeholder="選單" /></div>
              <div>
                <Label>尺寸</Label>
                <Select value={size} onValueChange={(v) => setSize(v as "full" | "half")}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full">全版 2500×1686</SelectItem>
                    <SelectItem value="half">半版 2500×843</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>頁籤 A 文字</Label><Input value={tabA} onChange={(e) => setTabA(e.target.value)} /></div>
              <div><Label>頁籤 B 文字</Label><Input value={tabB} onChange={(e) => setTabB(e.target.value)} /></div>
            </div>
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label>本頁反白</Label>
                <Select value={active} onValueChange={setActive}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">頁籤 A（{tabA}）</SelectItem>
                    <SelectItem value="1">頁籤 B（{tabB}）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>主色</Label>
                <div><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ width: 56, height: 38, padding: "2px", borderRadius: "6px", cursor: "pointer" }} /></div>
              </div>
              <div className="flex items-center gap-2 pb-2"><Switch checked={selected} onCheckedChange={setSelected} /><Label>預設展開</Label></div>
              <div className="flex items-center gap-2 pb-2"><Switch checked={showIcon} onCheckedChange={setShowIcon} /><Label>顯示 icon</Label></div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">推薦色</span>
              {["#2e4a36", "#1f3a4d", "#5c3a21", "#2c2c2a"].map((c) => (
                <button key={c} type="button" onClick={() => setColor(c)} title={c} style={{ width: 24, height: 24, borderRadius: 6, background: c, border: "1px solid rgba(0,0,0,0.2)", cursor: "pointer" }} />
              ))}
            </div>
            <div><Label>點另一頁切到的 alias（小寫，單頁可留空）</Label><Input value={switchAlias} onChange={(e) => setSwitchAlias(lc(e.target.value))} placeholder="menu_contract" /></div>
            <div><Label>發訊息前綴符號（舊式，建議改用「查詢」）</Label><Input value={msgPrefix} onChange={(e) => setMsgPrefix(e.target.value)} placeholder="▶" /><p className="text-xs text-muted-foreground mt-1">查詢類按鈕請選「查詢」(postback)：最穩定、租客打字不會誤觸、回覆免額度。此前綴僅供舊「發訊息」按鈕，且 LINE 會吃掉開頭特殊字、不建議再用。</p></div>

            <div className="space-y-2">
              <div className="flex items-center justify-between"><Label>按鈕（最多 6）</Label><Button size="sm" variant="outline" onClick={addBtn} disabled={buttons.length >= 6}><Plus className="h-4 w-4 mr-1" /> 新增</Button></div>
              {buttons.map((b, i) => (
                <div key={b.id} className="border rounded p-2 space-y-1.5">
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground w-5">{i + 1}</span>
                    <Input value={b.label} onChange={(e) => patch(b.id, { label: e.target.value })} placeholder="按鈕文字" className="flex-1" />
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => move(i, -1)} disabled={i === 0}><ChevronUp className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => move(i, 1)} disabled={i === buttons.length - 1}><ChevronDown className="h-4 w-4" /></Button>
                    <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-red-600" onClick={() => removeBtn(b.id)}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Select value={b.atype} onValueChange={(v) => patch(b.id, { atype: v as Btn["atype"] })}>
                      <SelectTrigger className="w-[92px] shrink-0"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="postback">查詢</SelectItem>
                        <SelectItem value="uri">連結</SelectItem>
                        <SelectItem value="message">發訊息</SelectItem>
                      </SelectContent>
                    </Select>
                    {b.atype === "postback" ? (
                      <Select value={b.query || ""} onValueChange={(v) => patch(b.id, { query: v })}>
                        <SelectTrigger className="flex-1"><SelectValue placeholder="選查詢類型" /></SelectTrigger>
                        <SelectContent>
                          {QUERY_OPTIONS.map((q) => <SelectItem key={q.data} value={q.data}>{q.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    ) : b.atype === "message" ? (
                      <Input value={b.text} onChange={(e) => patch(b.id, { text: e.target.value })} placeholder="點擊後送出的文字（例：我要報修）" className="flex-1" />
                    ) : (
                      <Input value={b.url} onChange={(e) => patch(b.id, { url: e.target.value })} placeholder="連結 URL（http/https/tel/line）" className="flex-1" />
                    )}
                    <label className="inline-flex items-center gap-1 px-2 py-1.5 text-xs border rounded cursor-pointer hover:bg-muted whitespace-nowrap">
                      <Upload className="h-3.5 w-3.5" /> {b.icon ? "換 icon" : "icon"}
                      <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => onIcon(b.id, e.target.files?.[0])} />
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 右：預覽 */}
          <div className="space-y-2">
            <Label>預覽（{size === "half" ? "2500×843" : "2500×1686"}）</Label>
            <canvas ref={setCanvas} className="w-full h-auto rounded border bg-white" />
            <p className="text-xs text-muted-foreground leading-relaxed">
              LINE 規範：圖 JPEG/PNG ≤1MB、長寬比(寬/高)≥1.45；key／alias 小寫英數_-（≤32）；點擊區 ≤20；連結需 http(s)／tel／line 開頭。沒填連結的按鈕發布時會自動略過（圖上仍有、暫不可點）。
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={generate} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Wand2 className="h-4 w-4 mr-1" />} 產生並建立選單</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
