import { remittanceReceiptSchema, type RemittanceReceipt, type RemittanceStatus } from '../../../shared/remittance';

type Saved = { verifyToken?: string; receipt?: RemittanceReceipt; email: string; job: string };
type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
type API = {
  verify: (otp: string) => Promise<{ success: boolean; verifyToken?: string; message?: string }>;
  submit: (verifyToken: string) => Promise<RemittanceReceipt & RemittanceStatus>;
  status: (receipt: RemittanceReceipt) => Promise<RemittanceStatus>;
  complete: (receipt: RemittanceReceipt, profile: { email: string; job: string }) => Promise<{ virtualAccount: string }>;
};
export type FlowResult = { status: 'pending' | 'needs_review' } | { status: 'done'; virtualAccount: string };

/** Freeze optional edits with the operation. No OTP or government ID is stored.
 * Saving the verification capability precedes submission so a lost POST response
 * can be recovered using the native service's durable token deduplication. */
export function createRemittanceFlow(storage: StoragePort, scope: string, api: API) {
  const key = `renewal-remittance:v1:${scope}`;
  let state: Saved | undefined;
  try {
    const raw = JSON.parse(storage.getItem(key) || 'null');
    if (raw && typeof raw.email === 'string' && typeof raw.job === 'string') {
      const receipt = remittanceReceiptSchema.safeParse(raw.receipt);
      if (receipt.success) state = { receipt: receipt.data, email: raw.email, job: raw.job };
      else if (typeof raw.verifyToken === 'string' && /^[a-f0-9]{48}$/.test(raw.verifyToken)) state = { verifyToken: raw.verifyToken, email: raw.email, job: raw.job };
    }
  } catch { /* no usable saved operation */ }
  const save = (next: Saved) => {
    try { storage.setItem(key, JSON.stringify(next)); }
    catch { throw new Error('瀏覽器無法保存處理進度，請開啟瀏覽器儲存功能後重試'); }
    state = next;
  };
  let running: Promise<FlowResult> | undefined;
  async function advance(otp: string, profile: { email: string; job: string }): Promise<FlowResult> {
    if (!state) {
      const result = await api.verify(otp);
      if (!result.success) throw new Error(result.message || '驗證失敗，請檢查驗證碼');
      if (!result.verifyToken || !/^[a-f0-9]{48}$/.test(result.verifyToken)) throw new Error('手機已驗證，但尚未取得設定憑證，請聯絡服務人員');
      save({ verifyToken: result.verifyToken, ...profile });
    }
    const current = state!;
    let status: RemittanceStatus;
    if (!current.receipt) {
      const result = await api.submit(current.verifyToken!);
      const receipt = remittanceReceiptSchema.parse(result);
      save({ receipt, email: current.email, job: current.job });
      status = result;
    } else status = await api.status(current.receipt);
    if (status.status === 'needs_review') return { status: 'needs_review' };
    if (status.status !== 'ready' || !status.virtualAccount) return { status: 'pending' };
    const result = await api.complete(state!.receipt!, { email: state!.email, job: state!.job });
    if (!/^\d{10,20}$/.test(result.virtualAccount)) throw new Error('帳號尚未確認可用，請稍後重試');
    return { status: 'done', virtualAccount: result.virtualAccount };
  }
  return {
    hasSaved: () => Boolean(state),
    forgetRejectedVerification() {
      // Only call after an explicit UNAUTHORIZED response, never a timeout.
      if (state?.receipt) return false;
      storage.setItem(key, 'null');
      state = undefined;
      return true;
    },
    advance(otp: string, profile: { email: string; job: string }) {
      if (!running) running = advance(otp, profile).finally(() => { running = undefined; });
      return running;
    },
  };
}
