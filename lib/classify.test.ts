import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRules, isHumanConfirmed } from "./classify.ts";

test("labels sample lines", () => {
  assert.equal(classifyRules("For billing, press 2.").label, "menu_prompt");
  assert.equal(classifyRules("Your call is important to us. Please continue to hold.").label, "recorded_message");
  assert.equal(classifyRules("♪ ♪").label, "hold_music");
  assert.equal(classifyRules("Hi, this is Maria in billing, how can I help you today?").label, "live_human");
  assert.equal(classifyRules("Calls may be recorded for quality purposes.").label, "recorded_message");
  assert.equal(classifyRules("Para español, oprima nueve.").label, "menu_prompt");
});

test("human confirmation rule", () => {
  const weak = { label: "live_human" as const, score: 0.5, source: "rules" as const };
  assert.equal(isHumanConfirmed([weak]), false);
  assert.equal(isHumanConfirmed([weak, weak]), true);
  assert.equal(isHumanConfirmed([{ ...weak, score: 0.9 }]), true);
});
