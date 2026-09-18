import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveTenantVirtualAccount,
  type Tenant,
} from "./lineInboundHandlers";

const tenant = (virtualAccount: string | null): Tenant => ({
  id: "tenant-1",
  primary_name: "Test Tenant",
  primary_phone: "0900000000",
  virtual_account: virtualAccount,
});

test("prefers the tenant virtual account without querying receipts", async () => {
  let queried = false;

  const result = await resolveTenantVirtualAccount(tenant("12345678901234"), async () => {
    queried = true;
    return [];
  });

  assert.equal(result, "12345678901234");
  assert.equal(queried, false);
});

test("uses the sole distinct nonblank receipt account linked through active contracts", async () => {
  let sql = "";
  let params: readonly unknown[] = [];

  const result = await resolveTenantVirtualAccount(tenant("  "), async (query, values) => {
    sql = query;
    params = values ?? [];
    return [
      { virtual_account: " 12345678901234 " },
      { virtual_account: "12345678901234" },
      { virtual_account: "" },
      { virtual_account: null },
    ];
  });

  assert.equal(result, "12345678901234");
  assert.deepEqual(params, ["tenant-1"]);
  assert.match(sql, /contract\.tenant_contract_parties/);
  assert.match(sql, /contract\.tenant_contracts/);
  assert.match(sql, /finance\.rent_receipts/);
  assert.match(sql, /rr\.latest_contract_no\s*=\s*tc\.contract_no/);
  assert.match(sql, /nullif\s*\(\s*btrim\s*\(\s*tc\.contract_no::text\s*\)\s*,\s*''\s*\)\s+is\s+not\s+null/i);
  assert.match(sql, /tc\.status\s*=\s*'active'/);
  assert.match(sql, /tc\.deleted_at\s+is\s+null/);
  assert.match(sql, /rr\.deleted_at\s+is\s+null/);
  assert.doesNotMatch(sql, /primary_name|tenant_name/);
});

test("leaves the account unresolved when no fallback account exists", async () => {
  const result = await resolveTenantVirtualAccount(tenant(null), async () => []);

  assert.equal(result, null);
});

test("leaves the account unresolved when active contracts produce multiple accounts", async () => {
  const result = await resolveTenantVirtualAccount(tenant(null), async () => [
    { virtual_account: "11111111111111" },
    { virtual_account: "22222222222222" },
  ]);

  assert.equal(result, null);
});
