import { test } from "node:test";
import assert from "node:assert/strict";
import { allowIp, isAllowedNumber, toE164 } from "./guard.ts";
import { LIMITS } from "./config.ts";

test("phone guards", () => {
  assert.equal(toE164("(404) 663-9270"), "+14046639270");
  assert.equal(toE164("+1 800 934 6489"), "+18009346489");
  assert.equal(toE164("+91 90032 35680"), "");
  assert.equal(isAllowedNumber("+18009346489"), true);
  assert.equal(isAllowedNumber("+19005550123"), false);
  assert.equal(isAllowedNumber("+919003235680"), false);
});

test("per-IP rate limit", () => {
  for (let i = 0; i < LIMITS.callsPerIpPerHour; i++) assert.equal(allowIp("1.2.3.4", 1000), true);
  assert.equal(allowIp("1.2.3.4", 1000), false);
  assert.equal(allowIp("1.2.3.4", 1000 + 3600_001), true);
});
