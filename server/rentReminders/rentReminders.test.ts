import { test } from "node:test";
import assert from "node:assert/strict";
import { Bill, Identity, buildFlex, decide, inSendWindow, overdueDays, taipeiDate, tenantInboxUrl } from "./domain";
import { parseRows, parseWorkbook } from "./source";
import ExcelJS from "exceljs";
import { runRentReminders } from "./service";
import { relayPushOnce } from "../routers/property/bookingConfirmHandler";

const bill: Bill = {
  id: "123", contractId: "456", name: "2026/08-帳單", payer: "公司付款人", room: "測試 A301",
  due: "2026-08-01", period: "2026-08-01 ~ 2026-08-31", leaseEnd: "2027-07-31",
  total: 10500, rent: 10000, fees: [{ name: "租金", amount: 10000 }, { name: "水電", amount: 500 }], issue: null,
};
const identity: Identity = {
  contract_id: "contract", jgb_id: null, raw_jgb_id: "456", contract_no: "A00001",
  end_date: "2027-07-31", move_out_date: null, status: "active", ownership_region: "總公司",
  hq_internal_category: null, tenant_id: "tenant", tenant_name: "測試承租人", uid: "U" + "1".repeat(32),
  property_name: "測試案場", property_deleted: null,
};
test("台北日期與 D+2 邊界、歷史帳單", () => {
  assert.equal(taipeiDate(new Date("2026-10-20T16:00:00Z")), "2026-10-21");
  assert.equal(overdueDays("2026-08-01", "2026-10-20"), 80);
  assert.equal(decide({ ...bill, due: "2026-10-19" }, [identity], "2026-10-20").eligible, false);
  assert.equal(decide({ ...bill, due: "2026-10-18" }, [identity], "2026-10-20").eligible, true);
  assert.equal(decide(bill, [identity], "2026-10-20").eligible, true);
  assert.equal(inSendWindow(new Date("2026-10-21T03:59:59Z"), "2026-10-21"), false);
  assert.equal(inSendWindow(new Date("2026-10-21T04:00:00Z"), "2026-10-21"), true);
  assert.equal(inSendWindow(new Date("2026-10-21T04:15:00Z"), "2026-10-21"), false);
});
test("只限總公司、排除靠行、示範、過期與取消合約", () => {
  for (const patch of [
    { ownership_region: "加盟" }, { ownership_region: "高雄" }, { ownership_region: null },
    { hq_internal_category: "靠行" }, { tenant_name: "游 凰儀" }, { tenant_name: "藍 堂嘉" },
    { end_date: "2026-10-19" }, { end_date: null }, { status: "cancelled" },
    { move_out_date: "2026-10-19" }, { property_deleted: "2026-10-20" },
  ]) assert.equal(decide(bill, [{ ...identity, ...patch }], "2026-10-20").eligible, false, JSON.stringify(patch));
  assert.equal(decide({ ...bill, leaseEnd: "2026-10-19" }, [identity], "2026-10-20").eligible, false);
});
test("ID fallback、主客唯一、UID 衝突與缺漏，不以付款人姓名篩選", () => {
  assert.equal(decide(bill, [identity], "2026-10-20").eligible, true);
  for (const rows of [null, [], [identity, identity], [{ ...identity, jgb_id: "999" }],
    [{ ...identity, uid: null }], [{ ...identity, uid_conflict: true }]]) {
    assert.equal(decide(bill, rows, "2026-10-20").eligible, false);
  }
});
test("壞數字／日期／明細不允許通知，卡片顯示整張金額與原帳單名稱", () => {
  for (const patch of [{ rent: NaN }, { total: Infinity }, { due: "2026-02-30" }, { issue: "明細不符" }])
    assert.equal(decide({ ...bill, ...patch }, [identity], "2026-10-20").eligible, false);
  const message = JSON.stringify(buildFlex(bill, identity, "2026-10-20"));
  assert.match(message, /2026\/08-帳單/);
  assert.match(message, /已逾期 80 天/);
  assert.match(message, /10,500/);
  assert.match(message, /水電/);
});
test("租客對話以唯一合約主承租人 UID 開啟，缺漏與衝突不提供連結", () => {
  assert.equal(tenantInboxUrl("456", [identity]), `https://fieldops.zeabur.app/inbox?uid=${identity.uid}`);
  assert.equal(tenantInboxUrl("456", [{ ...identity, jgb_id: "456", raw_jgb_id: null }]),
    `https://fieldops.zeabur.app/inbox?uid=${identity.uid}`);
  // Conversation access remains available when a bill is not currently eligible for reminders.
  assert.ok(tenantInboxUrl("456", [{ ...identity, status: "cancelled", end_date: "2025-01-01" }]));
  for (const rows of [null, [], [identity, identity], [{ ...identity, jgb_id: "999" }],
    [{ ...identity, uid: null }], [{ ...identity, uid: "Ubad&other=1" }],
    [{ ...identity, uid_conflict: true }], [{ ...identity, tenant_id: null }]]) {
    assert.equal(tenantInboxUrl("456", rows), null);
  }
  assert.equal(tenantInboxUrl("999", [identity]), null);
});
const feeNames = ["租金", "押金", "車位租金", "車位押金", "電費", "水費", "瓦斯費", "網路費", "第四台",
  "管理費", "車位管理費", "清潔費", "公共服務維護費用", "行政費用", "-續約＿押金遞延", "-折扣"];
function exportFixture() {
  const headers = ["合約ID", "帳單ID", "帳單狀態", "付款人", "合約租期", "帳單描述", "帳單週期", "物件名稱",
    "繳費期限", "幣別", "應到帳金額", "已到帳金額", ...feeNames];
  const row: unknown[] = ["456", "123", "應到帳", "測試", "2026-01-01 ~ 2027-01-01", "2026/08-帳單", "2026-08", "A301",
    "2026-08-01", "TWD", 9500, null, ...feeNames.map(n => n === "租金" ? 10000 : n === "-折扣" ? -500 : 0)];
  const footer: unknown[] = Array(headers.length).fill(null); footer[3] = "總計"; footer[10] = 9500;
  return [headers, row, footer];
}
test("完整匯出總計、負折扣與缺欄位／重複帳單／錯誤總計", () => {
  assert.equal(parseRows(exportFixture())[0].total, 9500);
  assert.equal(parseRows(exportFixture())[0].issue, null);
  for (const mutate of [
    (r: unknown[][]) => { r[0][0] = "未知"; },
    (r: unknown[][]) => { r.splice(1, 0, r[1]); },
    (r: unknown[][]) => { r[2][10] = 9000; },
    (r: unknown[][]) => { r[1][2] = "已到帳"; },
  ]) { const rows = exportFixture(); mutate(rows); assert.throws(() => parseRows(rows)); }
  const mismatch = exportFixture(); mismatch[1][12] = 8000;
  assert.match(parseRows(mismatch)[0].issue!, /明細/);
});
test("實際 JGB 結構含發票報表，僅讀帳務報表", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("帳務報表").addRows(exportFixture());
  workbook.addWorksheet("發票報表").addRow(["不是帳單"]);
  const bytes = await workbook.xlsx.writeBuffer();
  const rows = await parseWorkbook(bytes);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "123");
});
function harness(options: { paid?: boolean; uncertain?: boolean; empty?: boolean; stale?: boolean; failSource?: boolean; changedUid?: boolean } = {}) {
  let claimed = false, sends = 0, reads = 0;
  const calls: { sql: string; params: any[] }[] = [];
  const now = new Date("2026-10-21T04:00:00Z");
  const deps = {
    query: async <T = any>(sql: string, params: any[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      let rows: object[] = [];
      if (sql.includes("insert into outreach.rent_reminder_runs")) {
        if (!claimed) { claimed = true; rows = [{ id: "run" }]; }
      } else if (sql.includes("as paid")) rows = [{ paid: options.paid ?? false }];
      else if (sql.includes("returning id")) rows = [{ id: "schedule" }];
      return rows as T[];
    },
    fetchBills: async () => {
      if (options.failSource) throw new Error("JGB 匯出失敗");
      return { bills: options.empty ? [] : [bill], batch: "fixture", digest: "digest",
        fetchedAt: new Date(+now - (options.stale ? 16 * 60000 : 0)) };
    },
    identities: async () => {
      reads++;
      return [{ ...identity, uid: options.changedUid && reads > 1 ? "U" + "2".repeat(32) : identity.uid }];
    },
    settings: async () => ({ enabled: true, test_mode: false, start_date: "2026-10-21" }),
    send: async () => { sends++; return options.uncertain ? { accepted: false, error: "結果不明" } : { accepted: true, messageId: "line-id" }; },
    now: () => now,
  };
  return { deps, calls, sends: () => sends };
}
test("同日重疊執行及重跑只送一次，先記錄嘗試再發送", async () => {
  const h = harness();
  await Promise.all([runRentReminders(h.deps), runRentReminders(h.deps)]);
  await runRentReminders(h.deps);
  assert.equal(h.sends(), 1);
  assert.equal(h.calls.filter(c => c.sql.includes("attempt_count=1")).length, 1);
  assert.ok(h.calls.some(c => c.params.includes("sent")));
});
test("已入帳／來源失敗／過期／收件人變更／空來源不發", async () => {
  for (const option of [{ paid: true }, { failSource: true }, { stale: true }, { changedUid: true }, { empty: true }]) {
    const h = harness(option); await runRentReminders(h.deps);
    assert.equal(h.sends(), 0, JSON.stringify(option));
  }
});
test("暫停、測試模式與未生效時不建立發送批次", async () => {
  for (const setting of [{ enabled: false, test_mode: false, start_date: "2026-10-21" },
    { enabled: true, test_mode: true, start_date: "2026-10-21" },
    { enabled: true, test_mode: false, start_date: "2026-10-22" }]) {
    const h = harness(); h.deps.settings = async () => setting;
    await runRentReminders(h.deps); assert.equal(h.calls.length, 0);
  }
});
test("不明回執只嘗試一次並保留待核對原因", async () => {
  const h = harness({ uncertain: true });
  await runRentReminders(h.deps); await runRentReminders(h.deps);
  assert.equal(h.sends(), 1);
  assert.ok(h.calls.some(c => c.params.includes("結果不明")));
  assert.ok(!h.calls.some(c => c.params.includes("sent")));
});
test("relay 明確 LINE ID 才成功，HTTP 200 空物件及逾時不重試", async () => {
  const original = globalThis.fetch;
  const oldSecret = process.env.BOOKING_WEBHOOK_SECRET;
  process.env.BOOKING_WEBHOOK_SECRET = "unit-test-only";
  try {
    for (const body of [{}, { ok: true }, { error: "failed" }, { sentMessages: [{ id: "123" }] }]) {
      let count = 0;
      globalThis.fetch = async () => { count++; return new Response(JSON.stringify(body)); };
      const result = await relayPushOnce(identity.uid!, { type: "text", text: "fixture" });
      assert.equal(result.accepted, "sentMessages" in body); assert.equal(count, 1);
    }
    let count = 0;
    globalThis.fetch = async () => { count++; throw new Error("timeout"); };
    assert.equal((await relayPushOnce(identity.uid!, {})).accepted, false);
    assert.equal(count, 1);
  } finally {
    globalThis.fetch = original;
    if (oldSecret === undefined) delete process.env.BOOKING_WEBHOOK_SECRET;
    else process.env.BOOKING_WEBHOOK_SECRET = oldSecret;
  }
});
