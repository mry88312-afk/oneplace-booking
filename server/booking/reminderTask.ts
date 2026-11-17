import { ragicGet } from '../routers/property/bookingHelpers';

/** 空單筆需以同表可讀的正向對照確認；異常資料保留待查。 */
export async function reminderTaskExists(path: string, id: string): Promise<boolean> {
  if (!path || !/^\d+$/.test(id)) throw new Error('預約缺少有效 Ragic 任務對應，待核對');
  const record = await ragicGet(`${path}/${id}`, undefined, { allowNotFound: true });
  if (record === null) return false;
  if (typeof record === 'object' && !Array.isArray(record) && Object.keys(record).length === 0) {
    const control = await ragicGet(path, { limit: '1' });
    if (control && typeof control === 'object' && !Array.isArray(control) &&
        Object.values(control).some(value => value && typeof value === 'object' && '_ragicId' in value)) return false;
    throw new Error('Ragic 任務表讀取權限無法確認，待核對');
  }
  const item = record && typeof record === 'object' && !Array.isArray(record)
    ? (record._ragicId !== undefined ? record : record[id]) : null;
  if (!item || typeof item !== 'object' || Array.isArray(item) || String(item._ragicId) !== id) {
    throw new Error('Ragic 任務查詢結果無法確認，待核對');
  }
  return true;
}
