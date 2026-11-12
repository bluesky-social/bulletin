import assert from "node:assert/strict";
import test from "node:test";
import { registrationRenewalDelay } from "./registration";

test("reauthorizes two minutes before a credential's registration expires", () => {
  const now = Date.parse("2026-08-12T12:00:00Z");
  const expiresAt = "2026-08-12T12:10:00Z";
  assert.equal(registrationRenewalDelay(expiresAt, now), 8 * 60 * 1000);
});

test("reauthorizes short-lived registrations halfway through", () => {
  const now = Date.parse("2026-08-12T12:00:00Z");
  assert.equal(
    registrationRenewalDelay("2026-08-12T12:01:00Z", now),
    30 * 1000,
  );
});

test("renews immediately when registration has expired", () => {
  const now = Date.parse("2026-08-12T12:00:00Z");
  assert.equal(registrationRenewalDelay("2026-08-12T11:59:00Z", now), 0);
});

test("renews immediately when persisted expiry is invalid", () => {
  assert.equal(registrationRenewalDelay("not-a-date"), 0);
});
