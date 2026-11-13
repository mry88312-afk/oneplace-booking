import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BOOKING_ACTION_PROJECT_IDS, projectIdsForBookingActions } from "./bookingActions";
import { getLockedBundle, listLockedProjectIds } from "./lockedTemplates";

test("every locked 退租/續約 template is recognised by its projectId", () => {
  for (const projectId of listLockedProjectIds()) {
    const type = getLockedBundle(projectId)?.template.templateType;
    if (type !== "退租" && type !== "續約") continue;
    assert.ok(
      BOOKING_ACTION_PROJECT_IDS[type].includes(projectId),
      `locked template ${projectId} (${type}) is missing from BOOKING_ACTION_PROJECT_IDS`,
    );
  }
});

test("online renewal and checkout entries are covered", () => {
  assert.deepEqual(projectIdsForBookingActions(["退租"]), ["checkout"]);
  assert.deepEqual(projectIdsForBookingActions(["續約"]).sort(), ["contract", "renewal"]);
  assert.deepEqual(projectIdsForBookingActions(["續約", "退租"]).sort(), ["checkout", "contract", "renewal"]);
});

test("an empty action list fails loudly instead of matching nothing", () => {
  assert.throws(() => projectIdsForBookingActions([]), /No booking projectIds configured/);
});

test("outreach no longer keys off bt_contractAction, which is empty in the booking database", () => {
  const source = readFileSync(new URL("../routers/property/outreachHandlers.ts", import.meta.url), "utf8");
  assert.equal(/bookingTemplates\.contractAction/.test(source), false);
  assert.equal((source.match(/projectIdsForBookingActions\(/g) ?? []).length, 3);
});
