import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Upload, Eye, Send, Star, UserPlus, RefreshCw, Image as ImageIcon, Wand2 } from "lucide-react";
import { RichMenuGenerator } from "./RichMenuGenerator";

type AreaForm = {
  x: number; y: number; width: number; height: number;
  actionType: "uri" | "richmenuswitch";
  uri?: string; label?: string; richMenuAliasId?: string; data?: string;
};
type MenuForm = {
  key: string; name: string; chatBarText: string; size: "full" | "half"; selected: boolean;
  imageAssetId: number | null; imageUrl: string | null; aliasId: string; areas: AreaForm[];
};

const STATUS: Record<string, { label: string; color: string }> = {
  draft: { label: "草稿", color: "bg-slate-100 text-slate-700" },
  published: { label: "已發布", color: "bg-green-100 text-green-800" },
  archived: { label: "已封存", color: "bg-zinc-100 text-zinc-500" },
};

const blankForm = (): MenuForm => ({
  key: "", name: "", chatBarText: "選單", size: "full", selected: true,
  imageAssetId: null, imageUrl: null, aliasId: "", areas: [],
});

/** 讀圖片檔 → data URL（base64）＋ 原始尺寸，供上傳與尺寸驗證。 */
function readImage(file: File): Promise<{ dataBase64: string; width: number; height: number; contentType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const img = new Image();
      img.onload = () => resolve({ dataBase64: dataUrl, width: img.naturalWidth, height: img.naturalHeight, contentType: file.type });
      img.onerror = () => reject(new Error("無法讀取圖片"));
      img.src = dataUrl;
    };
    reader.onerror = () => reject(new Error("讀取檔案失敗"));
    reader.readAsDataURL(file);
  });
}

export function RichMenuManager() {
  const utils = trpc.useUtils();
  const menusQ = trpc.messaging.listRichMenus.useQuery();
  const upload = trpc.messaging.uploadAsset.useMutation();
  const upsert = trpc.messaging.upsertRichMenu.useMutation();
  const publish = trpc.messaging.publishRichMenu.useMutation();
  const setDefault = trpc.messaging.setDefaultRichMenu.useMutation();
  const assign = trpc.messaging.assignTenant.useMutation();
  const del = trpc.messaging.deleteRichMenu.useMutation();
  const reconcile = trpc.messaging.reconcile.useMutation();

  const [editing, setEditing] = useState<MenuForm | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assignUid, setAssignUid] = useState("");
  const [genOpen, setGenOpen] = useState(false);

  const busy = upsert.isPending || publish.isPending || setDefault.isPending || del.isPending || assign.isPending || reconcile.isPending;
  const refresh = () => utils.messaging.listRichMenus.invalidate();
  const expectedH = editing?.size === "half" ? 843 : 1686;

  const openNew = () => { setEditing(blankForm()); setIsNew(true); };
  const openEdit = (m: any) => {
    setIsNew(false);
    setEditing({
      key: m.key, name: m.name, chatBarText: m.chat_bar_text, size: m.size, selected: !!m.selected,
      imageAssetId: m.image_asset_id, imageUrl: m.image_url, aliasId: m.alias_id || m.key,
      areas: (m.areas || []).map((a: any) => ({
        x: a.x, y: a.y, width: a.width, height: a.height, actionType: a.action_type,
        uri: a.action_payload?.uri, label: a.label || a.action_payload?.label,
        richMenuAliasId: a.action_payload?.richMenuAliasId, data: a.action_payload?.data,
      })),
    });
  };

  const onPickImage = async (file: File | undefined) => {
    if (!editing || !file) return;
    if (file.type !== "image/png" && file.type !== "image/jpeg") { toast.error("圖片需為 PNG 或 JPEG"); return; }
    try {
      setUploading(true);
      const info = await readImage(file);
      if (!(info.width === 2500 && (info.height === 1686 || info.height === 843)))
        toast.warning(`尺寸 ${info.width}x${info.height} 非 2500x1686/843，發布時 LINE 可能拒絕`);
      const res = await upload.mutateAsync({
        filename: file.name, contentType: info.contentType as "image/png" | "image/jpeg",
        dataBase64: info.dataBase64, kind: "richmenu_image", width: info.width, height: info.height,
      });
      setEditing((e) => (e ? { ...e, imageAssetId: res.assetId, imageUrl: res.publicUrl } : e));
      toast.success("圖片已上傳");
    } catch (e: any) {
      toast.error(e?.message || "上傳失敗（請確認 Zeabur 已設 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）");
    } finally { setUploading(false); }
  };

  const updateArea = (i: number, patch: Partial<AreaForm>) =>
    setEditing((e) => (e ? { ...e, areas: e.areas.map((a, idx) => (idx === i ? { ...a, ...patch } : a)) } : e));
  const addArea = () =>
    setEditing((e) => (e ? { ...e, areas: [...e.areas, { x: 0, y: 0, width: 1250, height: e.size === "half" ? 843 : 843, actionType: "uri" }] } : e));
  const removeArea = (i: number) =>
    setEditing((e) => (e ? { ...e, areas: e.areas.filter((_, idx) => idx !== i) } : e));

  const save = async () => {
    if (!editing) return;
    if (!editing.key.trim() || !editing.name.trim()) { toast.error("請填 key 與名稱"); return; }
    const areas = editing.areas.map((a, i) => ({
      x: a.x, y: a.y, width: a.width, height: a.height, actionType: a.actionType, sortOrder: i, label: a.label,
      actionPayload: a.actionType === "uri"
        ? { uri: a.uri || "", label: a.label || undefined }
        : { richMenuAliasId: a.richMenuAliasId || "", data: a.data || "switch" },
    }));
    try {
      await upsert.mutateAsync({
        key: editing.key.trim(), name: editing.name.trim(), chatBarText: editing.chatBarText || "選單",
        size: editing.size, selected: editing.selected, imageAssetId: editing.imageAssetId,
        aliasId: editing.aliasId.trim() || undefined, areas,
      });
      toast.success("已儲存（草稿）— 記得按「發布」才會上 LINE");
      setEditing(null); refresh();
    } catch (e: any) { toast.error(e?.message || "儲存失敗"); }
  };

  const doPublish = async (key: string) => {
    try { const r = await publish.mutateAsync({ key }); toast.success(`已發布到 LINE（${String(r.lineRichMenuId).slice(0, 14)}…）`); refresh(); }
    catch (e: any) { toast.error(e?.message || "發布失敗"); }
  };
  const doDefault = async (key: string) => {
    try { await setDefault.mutateAsync({ key }); toast.success("已設為全體預設選單"); refresh(); }
    catch (e: any) { toast.error(e?.message || "設定失敗"); }
  };
  const doDelete = async (key: string) => {
    if (!window.confirm(`刪除圖文選單「${key}」？會一併從 LINE 移除。`)) return;
    try { await del.mutateAsync({ key }); toast.success("已刪除"); refresh(); }
    catch (e: any) { toast.error(e?.message || "刪除失敗"); }
  };
  const doPreview = async (key: string) => {
    try { setPreview(await utils.messaging.previewRichMenu.fetch({ key })); }
    catch (e: any) { toast.error(e?.message || "預覽失敗"); }
  };
  const doAssign = async () => {
    if (!assignFor || !assignUid.trim()) return;
    try { await assign.mutateAsync({ key: assignFor, uid: assignUid.trim() }); toast.success("已指派給該租客"); setAssignFor(null); setAssignUid(""); refresh(); }
    catch (e: any) { toast.error(e?.message || "指派失敗"); }
  };
  const doReconcile = async () => {
    try { const r = await reconcile.mutateAsync(); toast.success(`reconcile 完成：清除 ${r.removed.length} 個孤兒選單（保留 ${r.keptTracked} 個）`); }
    catch (e: any) { toast.error(e?.message || "reconcile 失敗"); }
  };

  const menus = menusQ.data || [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-lg font-semibold">圖文選單</h2>
          <p className="text-sm text-muted-foreground">以資料定義選單 → 一鍵發布到 LINE，支援多頁切換、預設與個別租客指派。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => refresh()}><RefreshCw className="h-4 w-4 mr-1" /> 重新整理</Button>
          <Button variant="outline" size="sm" onClick={doReconcile} disabled={busy}>清孤兒</Button>
          <Button size="sm" variant="outline" onClick={() => setGenOpen(true)}><Wand2 className="h-4 w-4 mr-1" /> 範本產生器</Button>
          <Button size="sm" onClick={openNew}><Plus className="h-4 w-4 mr-1" /> 新增選單</Button>
        </div>
      </div>

      {menusQ.isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> 載入中…</div>
      ) : menus.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">尚無圖文選單，點「新增選單」開始。</CardContent></Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {menus.map((m: any) => (
            <Card key={m.key}>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{m.name}</span>
                      <Badge className={STATUS[m.status]?.color}>{STATUS[m.status]?.label || m.status}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      key: {m.key}　alias: {m.alias_id || "—"}　{m.size === "half" ? "半版" : "全版"}
                    </div>
                  </div>
                </div>
                {m.image_url ? (
                  <img src={m.image_url} alt={m.name} className="w-full rounded border object-cover max-h-40" />
                ) : (
                  <div className="w-full h-24 rounded border border-dashed flex items-center justify-center text-muted-foreground text-sm">
                    <ImageIcon className="h-4 w-4 mr-1" /> 尚未設定圖片
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  點擊區 {(m.areas || []).length} 個{m.assignments ? `　指派：${m.assignments}` : ""}
                </div>
                <Separator />
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => openEdit(m)}>編輯</Button>
                  <Button size="sm" variant="outline" onClick={() => doPreview(m.key)}><Eye className="h-4 w-4 mr-1" /> 預覽</Button>
                  <Button size="sm" onClick={() => doPublish(m.key)} disabled={busy}><Send className="h-4 w-4 mr-1" /> 發布</Button>
                  <Button size="sm" variant="outline" onClick={() => doDefault(m.key)} disabled={busy}><Star className="h-4 w-4 mr-1" /> 設預設</Button>
                  <Button size="sm" variant="outline" onClick={() => { setAssignFor(m.key); setAssignUid(""); }}><UserPlus className="h-4 w-4 mr-1" /> 指派</Button>
                  <Button size="sm" variant="ghost" className="text-red-600" onClick={() => doDelete(m.key)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* 編輯／新增 dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isNew ? "新增圖文選單" : `編輯：${editing?.name}`}</DialogTitle>
            <DialogDescription>定義選單內容，儲存後按「發布」才會推到 LINE。</DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label>key（穩定識別，英數_-）</Label><Input value={editing.key} disabled={!isNew} onChange={(e) => setEditing({ ...editing, key: e.target.value })} placeholder="main_menu" /></div>
                <div><Label>名稱</Label><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="主選單" /></div>
                <div><Label>選單列文字（≤14字）</Label><Input value={editing.chatBarText} maxLength={14} onChange={(e) => setEditing({ ...editing, chatBarText: e.target.value })} /></div>
                <div>
                  <Label>尺寸</Label>
                  <Select value={editing.size} onValueChange={(v) => setEditing({ ...editing, size: v as "full" | "half" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="full">全版 2500×1686</SelectItem>
                      <SelectItem value="half">半版 2500×843</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div><Label>alias（切換用，預設＝key）</Label><Input value={editing.aliasId} onChange={(e) => setEditing({ ...editing, aliasId: e.target.value })} placeholder={editing.key} /></div>
                <div className="flex items-center gap-2 pt-6"><Switch checked={editing.selected} onCheckedChange={(c) => setEditing({ ...editing, selected: c })} /><Label>預設展開選單列</Label></div>
              </div>

              <div>
                <Label>選單圖片（2500×{expectedH}，PNG/JPEG，≤1MB）</Label>
                <div className="flex items-center gap-3 mt-1">
                  <label className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border rounded cursor-pointer hover:bg-muted">
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} 上傳圖片
                    <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => onPickImage(e.target.files?.[0])} disabled={uploading} />
                  </label>
                  {editing.imageUrl && <img src={editing.imageUrl} alt="預覽" className="h-12 rounded border" />}
                </div>
              </div>

              <Separator />
              <div className="flex items-center justify-between">
                <Label>點擊區（僅支援 開啟連結 uri／切換頁 richmenuswitch）</Label>
                <Button size="sm" variant="outline" onClick={addArea}><Plus className="h-4 w-4 mr-1" /> 新增點擊區</Button>
              </div>
              <div className="space-y-2">
                {editing.areas.map((a, i) => (
                  <div key={i} className="border rounded p-2 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">#{i + 1}</span>
                      <Button size="sm" variant="ghost" className="text-red-600 h-7" onClick={() => removeArea(i)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {(["x", "y", "width", "height"] as const).map((f) => (
                        <div key={f}><Label className="text-xs">{f}</Label><Input type="number" value={a[f]} onChange={(e) => updateArea(i, { [f]: parseInt(e.target.value || "0", 10) } as any)} /></div>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-xs">動作</Label>
                        <Select value={a.actionType} onValueChange={(v) => updateArea(i, { actionType: v as any })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="uri">開啟連結 (uri)</SelectItem>
                            <SelectItem value="richmenuswitch">切換頁 (richmenuswitch)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      {a.actionType === "uri" ? (
                        <div><Label className="text-xs">連結 URL</Label><Input value={a.uri || ""} onChange={(e) => updateArea(i, { uri: e.target.value })} placeholder="https://… 或 https://liff.line.me/…" /></div>
                      ) : (
                        <div><Label className="text-xs">切到哪個 alias</Label><Input value={a.richMenuAliasId || ""} onChange={(e) => updateArea(i, { richMenuAliasId: e.target.value })} placeholder="另一頁的 alias / key" /></div>
                      )}
                    </div>
                  </div>
                ))}
                {editing.areas.length === 0 && <p className="text-xs text-muted-foreground">尚無點擊區。</p>}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>取消</Button>
            <Button onClick={save} disabled={upsert.isPending || uploading}>{upsert.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null} 儲存草稿</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 預覽 dialog */}
      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>將送往 LINE 的選單 JSON</DialogTitle><DialogDescription>這是預覽，未對 LINE 做任何變更。</DialogDescription></DialogHeader>
          <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-[60vh]">{JSON.stringify(preview, null, 2)}</pre>
        </DialogContent>
      </Dialog>

      {/* 指派 dialog */}
      <Dialog open={!!assignFor} onOpenChange={(o) => !o && setAssignFor(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>指派給個別租客</DialogTitle><DialogDescription>輸入該租客的 LINE UID，覆蓋預設選單。</DialogDescription></DialogHeader>
          <div><Label>LINE UID</Label><Input value={assignUid} onChange={(e) => setAssignUid(e.target.value)} placeholder="U xxxxxxxx…" /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignFor(null)}>取消</Button>
            <Button onClick={doAssign} disabled={assign.isPending || !assignUid.trim()}>{assign.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null} 指派</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RichMenuGenerator open={genOpen} onClose={() => setGenOpen(false)} onDone={refresh} />
    </div>
  );
}
