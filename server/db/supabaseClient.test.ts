import assert from "node:assert/strict";
import test from "node:test";

import {
  selectLatestCheckoutResidence,
  type CheckoutResidenceCandidateRow,
} from "./supabaseClient";

function candidate(
  overrides: Partial<CheckoutResidenceCandidateRow> = {},
): CheckoutResidenceCandidateRow {
  return {
    contract_no: "A00001",
    room: "1-A",
    property: "測試案場",
    property_id: "property-1",
    tenant_count: 1,
    start_date: "2025-01-01",
    deleted_at: null,
    move_out_date: null,
    legacy_state: "取消",
    ...overrides,
  };
}

test("退租允許不限時間的到期取消合約", () => {
  const result = selectLatestCheckoutResidence([
    candidate({ start_date: "2018-01-01", legacy_state: "取消" }),
  ]);

  assert.deepEqual(result.map(({ contractNo, room }) => ({ contractNo, room })), [
    { contractNo: "A00001", room: "1-A" },
  ]);
});

test("已填退租日或已刪除的合約不再可預約", () => {
  const result = selectLatestCheckoutResidence([
    candidate({ contract_no: "A00002", move_out_date: "2025-02-01" }),
    candidate({ contract_no: "A00003", deleted_at: "2025-02-02" }),
  ]);

  assert.deepEqual(result, []);
});

test("最新合約已退租時不倒退使用更舊合約", () => {
  const result = selectLatestCheckoutResidence([
    candidate({ contract_no: "A00001", room: "1-A", start_date: "2024-01-01" }),
    candidate({
      contract_no: "A00002",
      room: "2-B",
      start_date: "2025-01-01",
      move_out_date: "2025-02-01",
    }),
  ]);

  assert.deepEqual(result, []);
});

test("多份取消合約只取開始日最新的一份", () => {
  const result = selectLatestCheckoutResidence([
    candidate({ contract_no: "A00001", room: "1-A", start_date: "2024-01-01" }),
    candidate({ contract_no: "A00002", room: "2-B", start_date: "2025-01-01" }),
  ]);

  assert.equal(result[0]?.contractNo, "A00002");
  assert.equal(result[0]?.room, "2-B");
});

test("最新合約缺少房間時不退回更舊房間", () => {
  const result = selectLatestCheckoutResidence([
    candidate({ contract_no: "A00001", room: "1-A", start_date: "2024-01-01" }),
    candidate({ contract_no: "A00002", room: null, start_date: "2025-01-01" }),
  ]);

  assert.deepEqual(result, []);
});
