import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, X, GripVertical } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export interface FormFieldDef {
  id: string;
  fieldType: "text" | "select" | "file" | "description" | "checkbox" | "line_uid" | "inbox_url";
  label: string;
  isRequired: boolean;
  options?: string[];
  allowOther?: boolean;
  selectionMode?: "radio" | "checkbox";
  ragicFieldId?: string;
  descriptionText?: string;
}

// ─── 單個可拖拉欄位卡片 ───────────────────────────────────────────────────────
function SortableFieldCard({
  field,
  index,
  onRemove,
  onUpdate,
}: {
  field: FormFieldDef;
  index: number;
  onRemove: () => void;
  onUpdate: (updates: Partial<FormFieldDef>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <Card className="border-dashed">
        <CardContent className="pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {/* 拖拉把手 */}
              <button
                type="button"
                {...attributes}
                {...listeners}
                className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none p-1 rounded"
                aria-label="拖拉排序"
              >
                <GripVertical className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium text-muted-foreground">欄位 {index + 1}</span>
            </div>
            <Button type="button" variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onRemove}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">欄位名稱</Label>
              <Input placeholder="例：備註" value={field.label} onChange={(e) => onUpdate({ label: e.target.value })} className="text-sm" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">欄位類型</Label>
              <Select value={field.fieldType} onValueChange={(v) => onUpdate({ fieldType: v as FormFieldDef["fieldType"] })}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="description">敍述（純告知）</SelectItem>
                  <SelectItem value="text">文字</SelectItem>
                  <SelectItem value="select">下拉選單</SelectItem>
                  <SelectItem value="checkbox">勾選（單選/多選）</SelectItem>
                  <SelectItem value="file">檔案上傳</SelectItem>
                  <SelectItem value="line_uid">LINE UID 回寫（系統自動）</SelectItem>
                  <SelectItem value="inbox_url">對話網址回寫（系統自動）</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {field.fieldType === "description" && (
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">說明文字</Label>
              <textarea
                placeholder="輸入要顯示給租客的說明文字..."
                value={field.descriptionText || ""}
                onChange={(e) => onUpdate({ descriptionText: e.target.value })}
                className="w-full text-sm border rounded-md p-2 min-h-[80px] resize-y bg-background"
              />
            </div>
          )}

          {(field.fieldType === "select" || field.fieldType === "checkbox") && (
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">
                {field.fieldType === "checkbox" ? "勾選項目" : "選項"}
              </Label>
              <div className="space-y-2">
                {(field.options || []).map((opt, optIdx) => (
                  <div key={optIdx} className="flex items-center gap-2">
                    <Input
                      value={opt}
                      onChange={(e) => {
                        const newOpts = [...(field.options || [])];
                        newOpts[optIdx] = e.target.value;
                        onUpdate({ options: newOpts });
                      }}
                      className="text-sm flex-1"
                      placeholder={`選項 ${optIdx + 1}`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive shrink-0 h-8 w-8 p-0"
                      onClick={() => {
                        const newOpts = (field.options || []).filter((_, i) => i !== optIdx);
                        onUpdate({ options: newOpts });
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => {
                    const newOpts = [...(field.options || []), ""];
                    onUpdate({ options: newOpts });
                  }}
                >
                  <Plus className="h-3 w-3 mr-1" /> 新增選項
                </Button>

                {/* 單選/多選切換 + 「其他」選項開關（僅 checkbox 顯示） */}
                {field.fieldType === "checkbox" && (
                  <div className="space-y-2 pt-1 border-t mt-2">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground">選擇模式：</Label>
                      <Select
                        value={field.selectionMode ?? "checkbox"}
                        onValueChange={(v) => onUpdate({ selectionMode: v as "radio" | "checkbox" })}
                      >
                        <SelectTrigger className="text-xs h-7 w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="checkbox">多選（勾選框）</SelectItem>
                          <SelectItem value="radio">單選（圓形按鈕）</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {(field.selectionMode ?? "checkbox") === "checkbox" && (
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={!!field.allowOther}
                          onCheckedChange={(v) => onUpdate({ allowOther: v })}
                        />
                        <Label className="text-xs text-muted-foreground cursor-pointer">
                          加入「其他（自填）」選項
                        </Label>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {field.fieldType === "line_uid" && (
            <div className="rounded-md bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 space-y-2">
              <p className="text-xs text-blue-700 dark:text-blue-300 font-medium">🔗 LINE UID 自動回寫</p>
              <p className="text-xs text-muted-foreground">租客完成預約後，系統會自動將其 LINE UID 寫入下方指定的 Ragic 欄位，不會顯示給租客填寫。</p>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Ragic 欄位 ID（必填）</Label>
                <Input placeholder="例：1012119" value={field.ragicFieldId || ""} onChange={(e) => onUpdate({ ragicFieldId: e.target.value })} className="text-sm" />
              </div>
            </div>
          )}

          {field.fieldType === "inbox_url" && (
            <div className="rounded-md bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 p-3 space-y-2">
              <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium">💬 對話網址自動回寫</p>
              <p className="text-xs text-muted-foreground">租客完成預約後，系統會自動將對話網址寫入下方指定的 Ragic 欄位，不會顯示給租客填寫。</p>
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Ragic 欄位 ID（必填）</Label>
                <Input placeholder="例：1012120" value={field.ragicFieldId || ""} onChange={(e) => onUpdate({ ragicFieldId: e.target.value })} className="text-sm" />
              </div>
            </div>
          )}

          {field.fieldType !== "description" && field.fieldType !== "line_uid" && field.fieldType !== "inbox_url" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground mb-1 block">Ragic 欄位 ID（選填）</Label>
                <Input
                  placeholder="例：1012118"
                  value={field.ragicFieldId || ""}
                  onChange={(e) => onUpdate({ ragicFieldId: e.target.value })}
                  className="text-sm"
                />
              </div>
              <div className="flex items-end gap-2 pb-1">
                <Switch checked={field.isRequired} onCheckedChange={(v) => onUpdate({ isRequired: v })} />
                <Label className="text-xs">必填</Label>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── 主元件 ───────────────────────────────────────────────────────────────────
export function FormFieldEditor({
  fields,
  onChange,
}: {
  fields: FormFieldDef[];
  onChange: (fields: FormFieldDef[]) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const addField = () =>
    onChange([
      ...fields,
      {
        id: `field-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fieldType: "text",
        label: "",
        isRequired: false,
      },
    ]);

  const removeField = (index: number) => onChange(fields.filter((_, i) => i !== index));

  const updateField = (index: number, updates: Partial<FormFieldDef>) => {
    const updated = [...fields];
    updated[index] = { ...updated[index], ...updates };
    onChange(updated);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = fields.findIndex((f) => f.id === active.id);
      const newIndex = fields.findIndex((f) => f.id === over.id);
      onChange(arrayMove(fields, oldIndex, newIndex));
    }
  };

  // 確保所有欄位都有 id（向下相容舊資料）
  const fieldsWithId = fields.map((f, i) =>
    f.id ? f : { ...f, id: `field-legacy-${i}` }
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold">自訂表單欄位</Label>
        <Button type="button" variant="outline" size="sm" onClick={addField}>
          <Plus className="h-3 w-3 mr-1" /> 新增欄位
        </Button>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        自訂欄位會在租客預約時顯示，用於收集額外資訊（如備註、特殊需求、檔案上傳等）。填寫結果會隨預約記錄一同儲存，並可選擇性同步至 Ragic。拖拉左側 <GripVertical className="inline h-3 w-3" /> 圖示可調整欄位順序。
      </p>
      {fieldsWithId.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">尚未設定自訂欄位（選填）</p>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={fieldsWithId.map((f) => f.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-4">
            {fieldsWithId.map((field, index) => (
              <SortableFieldCard
                key={field.id}
                field={field}
                index={index}
                onRemove={() => removeField(index)}
                onUpdate={(updates) => updateField(index, updates)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
