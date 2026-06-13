import { useState, useRef, useEffect, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, ChevronUp, ChevronDown, Upload, Wand2 } from "lucide-react";

type Btn = { id: number; label: string; url: string; icon?: string };
let _seq = 1;
const nb = (label = "", url = ""): Btn => ({ id: _seq++, label, url });

const W = 2500, H = 1686, TAB_H = 300;

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
  if (/繳租|繳費|付款|帳單/.test(lab)) return "pay";
  if (/合約|簽約/.test(lab)) return "doc";
  if (/修繕|維修|報修|記錄|紀錄|查詢/.test(lab)) return "list";
  if (/地圖|找房|看房|位置|聯絡|專員/.test(lab)) return "pin";
  if (/好物|推薦|優惠|精選/.test(lab)) return "star";
  if (/品牌|公司|關於|問題|常見/i.test(lab)) return "building";
  return "dot";
}

function exportImg(cv: HTMLCanvasElement): Promise<{ dataBase64: string; contentType: "image/png" | "image/jpeg" }> {
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

export function RichMenuGenerator({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const upload = trpc.messaging.uploadAsset.useMutation();
  const upsert = trpc.messaging.upsertRichMenu.useMutation();

  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [tabA, setTabA] = useState("一般服務");
  const [tabB, setTabB] = useState("合約與紀錄");
  const [active, setActive] = useState("0"); // 本頁反白哪個頁籤：0=A、1=B
  const [switchAlias, setSwitchAlias] = useState(""); // 點另一個頁籤要切到的 alias（單頁可留空）
  const [color, setColor] = useState("#3a5a40");
  const [buttons, setButtons] = useState<Btn[]>([nb("我的合約"), nb("修繕報修"), nb("房屋繳租"), nb("好物推薦")]);
  const [tick, setTick] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgs = useRef<Record<number, HTMLImageElement>>({});
  const busy = upload.isPending || upsert.isPending;
  const act = parseInt(active, 10);

  const draw = useCallback(() => {
    const cv = canvasRef.current; if (!cv) return;
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d"); if (!g) return;
    g.fillStyle = color; g.fillRect(0, 0, W, H);
    const tabFont = '500 64px system-ui,"PingFang TC","Microsoft JhengHei",sans-serif';
    const tabs = [tabA || "一般服務", tabB || "合約與紀錄"];
    for (let i = 0; i < 2; i++) {
      const x = i * 1250, on = i === act;
      g.fillStyle = on ? color : "#ffffff"; g.fillRect(x, 0, 1250, TAB_H);
      g.fillStyle = on ? "#ffffff" : color; g.font = tabFont; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(tabs[i], x + 625, TAB_H / 2);
    }
    const n = Math.max(1, buttons.length), rows = Math.ceil(n / 2), cellW = 1250, cellH = (H - TAB_H) / rows;
    const pad = Math.min(56, cellH * 0.13), rad = Math.min(70, cellH * 0.17);
    const iconS = Math.min(160, cellH * 0.34), labelF = Math.max(40, Math.min(66, Math.round(cellH * 0.135)));
    const labFont = "500 " + labelF + 'px system-ui,"PingFang TC","Microsoft JhengHei",sans-serif';
    buttons.forEach((b, m) => {
      const cx = (m % 2) * cellW, cy = TAB_H + Math.floor(m / 2) * cellH;
      g.save(); g.shadowColor = "rgba(0,0,0,0.20)"; g.shadowBlur = Math.round(cellH * 0.06); g.shadowOffsetY = Math.round(cellH * 0.03);
      g.fillStyle = "#ffffff"; rr(g, cx + pad, cy + pad, cellW - 2 * pad, cellH - 2 * pad, rad); g.fill(); g.restore();
      const iconCy = cy + cellH / 2 - iconS * 0.55;
      const im = imgs.current[b.id];
      if (b.icon && im && im.complete && im.naturalWidth) {
        const ar = im.naturalWidth / im.naturalHeight; let w = iconS, h = iconS;
        if (ar > 1) h = iconS / ar; else w = iconS * ar;
        g.drawImage(im, cx + cellW / 2 - w / 2, iconCy - h / 2, w, h);
      } else {
        lineIcon(g, iconFor(b.label), cx + cellW / 2, iconCy, iconS, color);
      }
      g.fillStyle = color; g.font = labFont; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(b.label || "", cx + cellW / 2, cy + cellH / 2 + iconS * 0.62);
    });
  }, [color, tabA, tabB, act, buttons]);

  useEffect(() => { if (open) draw(); }, [open, draw, tick]);

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
      const asset = await upload.mutateAsync({ filename: key.trim() + (img.contentType === "image/jpeg" ? ".jpg" : ".png"), contentType: img.contentType, dataBase64: img.dataBase64, kind: "richmenu_image", width: W, height: H });
      const n = buttons.length, rows = Math.ceil(n / 2), cellH = (H - TAB_H) / rows;
      const areas: any[] = [];
      if (switchAlias.trim()) {
        const tabX = act === 0 ? 1250 : 0;
        areas.push({ x: tabX, y: 0, width: 1250, height: TAB_H, actionType: "richmenuswitch", actionPayload: { richMenuAliasId: switchAlias.trim(), data: "switch" }, sortOrder: 0 });
      }
      buttons.forEach((b, i) => {
        areas.push({ x: (i % 2) * 1250, y: Math.round(TAB_H + Math.floor(i / 2) * cellH), width: 1250, height: Math.round(cellH), actionType: "uri", actionPayload: { uri: b.url || "" }, label: b.label, sortOrder: i + 1 });
      });
      await upsert.mutateAsync({ key: key.trim(), name: name.trim(), chatBarText: name.trim().slice(0, 14), size: "full", selected: true, imageAssetId: asset.assetId, aliasId: key.trim(), areas });
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
              <div><Label>key（英數_-）</Label><Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="menu_general" /></div>
              <div><Label>名稱</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="一般服務" /></div>
              <div><Label>頁籤 A 文字</Label><Input value={tabA} onChange={(e) => setTabA(e.target.value)} /></div>
              <div><Label>頁籤 B 文字</Label><Input value={tabB} onChange={(e) => setTabB(e.target.value)} /></div>
              <div>
                <Label>本頁反白</Label>
                <Select value={active} onValueChange={setActive}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="0">頁籤 A（{tabA}）</SelectItem>
                    <SelectItem value="1">頁籤 B（{tabB}）</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div><Label>主色</Label><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-full h-9 rounded border" /></div>
            </div>
            <div><Label>點另一個頁籤切到的 alias（單頁可留空）</Label><Input value={switchAlias} onChange={(e) => setSwitchAlias(e.target.value)} placeholder="menu_contract" /></div>

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
                    <Input value={b.url} onChange={(e) => patch(b.id, { url: e.target.value })} placeholder="連結 URL（uri）" className="flex-1" />
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
            <Label>預覽（2500×1686）</Label>
            <canvas ref={canvasRef} className="w-full h-auto rounded border" />
            <p className="text-xs text-muted-foreground">產生後會建立草稿，按鈕連結與切換已寫入點擊區；之後到清單按「發布」。</p>
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
