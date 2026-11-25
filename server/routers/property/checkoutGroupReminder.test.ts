import assert from "node:assert/strict";
import test from "node:test";
import { postToHub, probeHub, roommateGroupNotifyPath } from "../../booking/hubRouting";
import {
  CHECKOUT_GROUP_DEFAULT_TEXT,
  CHECKOUT_GROUP_RULE_KEY,
  checkoutGroupHubOutcome,
  checkoutGroupScanWindow,
  enqueueCheckoutGroupReminder,
  planCheckoutGroupReminder,
  resolveCheckoutGroupContext,
  selectCheckoutGroupResidence,
  taipeiYmd,
} from "./checkoutGroupReminder";
import { runOutreach } from "./outreachHandlers";

const early = Date.parse("2026-12-30T17:59:59+08:00");
const atSix = Date.parse("2026-12-30T18:00:00+08:00");
const dayThree = Date.parse("2027-01-02T09:30:00+08:00");

test("退租日以台北日期計算，UTC 16:00 換日", () => {
  assert.equal(taipeiYmd(Date.parse("2026-12-31T15:59:59.999Z")), "2026-12-31");
  assert.equal(taipeiYmd(Date.parse("2026-12-31T16:00:00.000Z")), "2027-01-01");
  for (const bad of [null, "無效時間", Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.equal(taipeiYmd(bad), "");
    assert.equal(planCheckoutGroupReminder(bad, early), null);
  }
});

test("每日掃描以台北日界線取 D+3，排今天 18:00", () => {
  assert.deepEqual(checkoutGroupScanWindow(early), {
    from: Date.parse("2027-01-01T16:00:00Z"),
    until: Date.parse("2027-01-02T16:00:00Z"),
    sendAt: atSix,
  });
});

test("今天、明天、後天的退租預約立即補發，已過或隔四天不補發", () => {
  for (const ymd of ["2026-12-30", "2026-12-31", "2027-01-01"]) {
    assert.deepEqual(planCheckoutGroupReminder(Date.parse(ymd + "T09:30:00+08:00"), early), { sendAt: early, immediate: true });
  }
  for (const ymd of ["2026-12-29", "2027-01-03"]) {
    assert.equal(planCheckoutGroupReminder(Date.parse(ymd + "T09:30:00+08:00"), early), null);
  }
});

test("距退租三天時，18:00 前排程，18:00 起立即補發", () => {
  assert.deepEqual(planCheckoutGroupReminder(dayThree, early), { sendAt: atSix, immediate: false });
  assert.deepEqual(planCheckoutGroupReminder(dayThree, atSix), { sendAt: atSix, immediate: true });
  assert.deepEqual(planCheckoutGroupReminder(dayThree, atSix + 1), { sendAt: atSix + 1, immediate: true });
});

test("改期前同規則已發送時，保留 D+3 定時排程並跳過立即補發", () => {
  assert.equal(planCheckoutGroupReminder(dayThree, atSix, true), null);
  assert.equal(planCheckoutGroupReminder(dayThree - 86_400_000, early, true), null);
  assert.deepEqual(planCheckoutGroupReminder(dayThree, early, true), { sendAt: atSix, immediate: false });
});

const residence = { room: "A３", contractNo: "約-01", property: "測試案場", propertyId: "測試案場識別碼", tenantCount: 1 };
const other = { ...residence, room: "B4" };
const booking = { id: 42, tenantUid: "測試租客", tenantName: "預約姓名", roomNumber: " ａ 3　", bookingTime: dayThree };
const dedupeKey = CHECKOUT_GROUP_RULE_KEY + ":42:2027-01-02";

test("多個住處以房號的空白、全半形與大小寫正規化選唯一一筆", () => {
  assert.equal(selectCheckoutGroupResidence([null, other, residence], booking.roomNumber).residence, residence);
  assert.equal(selectCheckoutGroupResidence([other], booking.roomNumber).residence, other);
  assert.equal(selectCheckoutGroupResidence([other, residence, { ...residence, room: "a3" }], booking.roomNumber).reason, "ambiguous_residence");
  assert.equal(selectCheckoutGroupResidence([other, residence], 123).reason, "room_not_matched");
  assert.equal(selectCheckoutGroupResidence(null, booking.roomNumber).reason, "no_residence");
});

test("解析依案場識別碼取案場編號，並用該合約與 UID 取本名", async () => {
  const lookup = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (sql.includes("from property.properties")) {
      assert.deepEqual(params, [residence.propertyId]);
      return [{ site_no: 123, short_name: "測試簡稱", ownership_region: "總公司", hq_internal_category: null }] as T[];
    }
    assert.match(sql, /join contract\.tenant_contract_parties/);
    assert.deepEqual(params, [residence.contractNo, residence.propertyId, booking.tenantUid]);
    return [{ name: "合約本名" }] as T[];
  };
  const result = await resolveCheckoutGroupContext(booking, {
    resolveResidences: async options => {
      assert.deepEqual(options, { lineUid: booking.tenantUid, includeExpiredCheckout: true });
      return [residence, other];
    },
    sbQuery: lookup,
  });
  assert.deepEqual(result, { context: { siteNo: "123", tenantName: "合約本名", room: "A３", propertyName: "測試簡稱" }, reason: "" });
});

for (const [region, category] of [["加盟", null], ["總公司", "靠行"], ["總公司", "外來"]]) {
  test(`排除案場歸屬 ${region}／${category ?? "無分類"}`, async () => {
    const result = await resolveCheckoutGroupContext(booking, {
      resolveResidences: async () => [residence],
      sbQuery: async <T>(sql: string) => sql.includes("from property.properties")
        ? [{ site_no: "123", short_name: "測試簡稱", ownership_region: region, hq_internal_category: category }] as T[]
        : [],
    });
    assert.equal(result.context?.siteNo, "");
    assert.equal(result.context?.tenantName, booking.tenantName);
    assert.equal(result.reason, "ineligible_property");
  });
}

test("無法辨識案場仍排程，保留台北日期、原因與去重碼", async () => {
  const sendAt = new Date(atSix).toISOString();
  const deps = {
    resolveContext: async () => ({ context: null, reason: "property_not_found" }),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      assert.match(sql, /on conflict \(dedupe_key\) where dedupe_key is not null do nothing returning id/);
      assert.deepEqual(params.slice(4, 7), [CHECKOUT_GROUP_RULE_KEY, "2026-12-30", sendAt]);
      assert.equal(params[8], dedupeKey);
      assert.deepEqual(JSON.parse(String(params[7])), {
        booking_id: 42, booking_date: "2027-01-02", booking_time: "09:30", tenant_name: "預約姓名",
        room: "ａ 3", site_no: "", checkout_month: "1", checkout_day: "2", context_error: "property_not_found",
      });
      return [];
    },
  };
  assert.equal(await enqueueCheckoutGroupReminder(booking, sendAt, deps), undefined);
});

const card = { type: "text", text: CHECKOUT_GROUP_DEFAULT_TEXT };

function dispatchFixture(options: {
  deliveryStatus?: string;
  redirect?: boolean;
  site?: string;
  due?: boolean;
  cancelled?: boolean;
  bookingTime?: number;
  taskExists?: boolean;
  claim?: boolean;
} = {}) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const hubCalls: unknown[] = [];
  const relayCalls: unknown[] = [];
  const checks: string[] = [];
  const deps: NonNullable<Parameters<typeof runOutreach>[1]> = {
    isConfigured: () => true,
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes("select s.id")) return [{
        id: "排程識別碼", rule_key: CHECKOUT_GROUP_RULE_KEY, status: "confirmed", source: "booking",
        tenant_uid: "", recipient_phone: "保護測試", due: options.due ?? true, dedupe_key: dedupeKey,
        card_template: card, vars: {
          site_no: options.site ?? "123", context_error: "ineligible_property", booking_id: 42, booking_date: "2027-01-02",
          room: "A3", tenant_name: '王"小明"', checkout_month: "1", checkout_day: "2",
        },
      }] as T[];
      if (sql.includes("from outreach.settings") && sql.startsWith("select")) {
        return [{ u: options.redirect ? "測試收件人" : null }] as T[];
      }
      assert.match(sql, /^update outreach\.schedule/);
      updates.push({ sql, params });
      return (options.claim !== false && sql.includes("returning id") ? [{ id: "排程識別碼" }] : []) as T[];
    },
    readBooking: async id => {
      checks.push("預約");
      assert.equal(id, 42);
      return {
        status: options.cancelled ? "cancelled" : "confirmed",
        bookingTime: options.bookingTime ?? dayThree, ragicRecordId: "84", ragicTaskPath: "fixture",
      };
    },
    taskExists: async (path, id) => {
      checks.push("任務");
      assert.deepEqual([path, id], ["fixture", "84"]);
      return options.taskExists ?? true;
    },
    relay: async (...args) => {
      relayCalls.push(args);
      return { success: true };
    },
    notifyGroup: async payload => {
      assert.match(updates.at(-1)?.sql || "", /_hub_dispatch_started/);
      hubCalls.push(payload);
      return { ok: true, deliveryStatus: options.deliveryStatus ?? "sent" };
    },
  };
  return { dispatch: () => runOutreach(["排程識別碼"], deps), relayCalls, hubCalls, checks, updates };
}

test("有效預約在核對與 claim 後派送渲染好的純文字，重複回執視為已發送", async () => {
  const fixture = dispatchFixture({ deliveryStatus: "duplicate" });
  assert.equal((await fixture.dispatch()).sent, 1);
  assert.deepEqual(fixture.checks, ["預約", "任務"]);
  assert.deepEqual(fixture.hubCalls, [{
    siteNo: "123", dedupeKey,
    text: card.text.replace("{{room}}", "A3").replace("{{tenant_name}}", '王"小明"')
      .replace("{{checkout_month}}", "1").replace("{{checkout_day}}", "2"),
  }]);
  assert.deepEqual(fixture.relayCalls, []);
  assert.match(fixture.updates[1].sql, /status='sent', sent_at=now\(\)/);
});

test("測試模式只把渲染文字交給個人轉送，排程保留原狀", async () => {
  const fixture = dispatchFixture({ redirect: true, site: "", due: false });
  assert.equal((await fixture.dispatch()).sent, 1);
  assert.deepEqual(fixture.hubCalls, []);
  assert.deepEqual(fixture.updates, []);
  assert.deepEqual(fixture.checks, []);
  const [uid, message, opts] = fixture.relayCalls[0] as [string, { type: string; text: string }, { record: boolean }];
  assert.equal(uid, "測試收件人");
  assert.equal(message.type, "text");
  assert.match(message.text, /A3房王"小明"預計於1月2日退租/);
  assert.deepEqual(opts, { record: false });
});

test("尚未到點、已取消或改期、Ragic 任務不存在、未取得 claim 都不派送", async () => {
  for (const options of [{ due: false }, { cancelled: true }, { bookingTime: dayThree + 86_400_000 }, { taskExists: false }, { claim: false }]) {
    const fixture = dispatchFixture(options);
    assert.equal((await fixture.dispatch()).skipped, 1);
    assert.deepEqual(fixture.hubCalls, []);
    assert.deepEqual(fixture.relayCalls, []);
  }
});

test("缺案場編號留原因，外勤站未找到群組或案場也記為 skipped", async () => {
  for (const status of ["property_not_found", "ambiguous_property", "no_group"]) {
    const fixture = dispatchFixture({ deliveryStatus: status });
    assert.equal((await fixture.dispatch()).skipped, 1);
    assert.deepEqual(fixture.updates.at(-1)?.params, ["排程識別碼", status]);
  }
  const fixture = dispatchFixture({ site: "" });
  assert.equal((await fixture.dispatch()).skipped, 1);
  assert.deepEqual(fixture.hubCalls, []);
  assert.deepEqual(fixture.updates[0].params, ["排程識別碼", "no_site_no:ineligible_property"]);
});

test("外勤站暫停發送時，記一次嘗試並解除群組排程的派送鎖", async () => {
  const fixture = dispatchFixture({ deliveryStatus: "outbound_disabled" });
  assert.equal((await fixture.dispatch()).failed, 1);
  assert.match(fixture.updates[0].sql, /attempt_count=coalesce\(attempt_count,0\)\+1/);
  // 未達上限：改回 confirmed 並解除派送鎖；達上限（6 次）：停在 suppressed 交人工核對
  assert.match(fixture.updates[1].sql, /when coalesce\(attempt_count,0\) >= \$3 then 'suppressed' else 'confirmed'/);
  assert.match(fixture.updates[1].sql, /else vars - '_hub_dispatch_started'/);
  assert.deepEqual(fixture.updates[1].params, ["排程識別碼", "outbound_disabled", "6"]);
});

test("外勤站沿用 webhook header，讀取 200 回執且單次呼叫不重送", async t => {
  const secret = process.env.BOOKING_WEBHOOK_SECRET;
  const route = process.env.BOOKING_HUB_ROUTE_FILE;
  process.env.BOOKING_WEBHOOK_SECRET = "fixture-only";
  delete process.env.BOOKING_HUB_ROUTE_FILE;
  t.after(() => {
    if (secret === undefined) delete process.env.BOOKING_WEBHOOK_SECRET;
    else process.env.BOOKING_WEBHOOK_SECRET = secret;
    if (route === undefined) delete process.env.BOOKING_HUB_ROUTE_FILE;
    else process.env.BOOKING_HUB_ROUTE_FILE = route;
  });
  const payload = { siteNo: "123", text: "測試通知", dedupeKey };
  for (const status of [200, 400, 401, 503, "network"] as const) {
    const mock = t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.ok(String(url).endsWith(roommateGroupNotifyPath));
      assert.equal(new Headers(init?.headers).get("x-webhook-secret"), "fixture-only");
      assert.equal(init?.body, JSON.stringify(payload));
      if (status === "network") throw new Error("測試連線中斷");
      return Response.json({ ok: status === 200, status: "sent" }, { status });
    });
    const receipt = await postToHub(roommateGroupNotifyPath, payload);
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
    const outcome = checkoutGroupHubOutcome(receipt);
    assert.equal(outcome.status, status === 200 ? "sent" : "failed");
    if (typeof status === "number" && status !== 200) assert.match(receipt.error || "", new RegExp(String(status)));
  }
  assert.equal(checkoutGroupHubOutcome({ ok: true, deliveryStatus: "unknown" }).status, "failed");
  assert.equal(checkoutGroupHubOutcome(null).status, "failed");
});

test("外勤站連通檢查只送空白請求，401 不算可用", async t => {
  const url = "https://fixture.oneplace.com.tw";
  for (const status of [400, 401]) {
    const mock = t.mock.method(globalThis, "fetch", async (requestUrl, init) => {
      assert.equal(requestUrl, url + roommateGroupNotifyPath);
      assert.equal(init?.body, "{}");
      return new Response(null, { status });
    });
    assert.equal(await probeHub(url, roommateGroupNotifyPath, "fixture-only"), status === 400);
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});
