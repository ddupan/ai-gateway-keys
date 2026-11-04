import assert from "node:assert/strict";
import { test } from "node:test";
import { inGroups, newKey, originAllowed, validId } from "./keys.js";

test("ids", () => {
  for (const ok of ["a", "research-auto", "panxiao81", "x".repeat(40)]) assert.ok(validId(ok), ok);
  for (const bad of ["", "-a", "a-", "A", "a_b", "a/b", "../x", "x".repeat(41)]) assert.ok(!validId(bad), bad);
});

test("keys are unique and unguessable-length", () => {
  const a = newKey(), b = newKey();
  assert.notEqual(a, b);
  assert.match(a, /^aigw_[A-Za-z0-9_-]{43}$/);
});

test("origin check", () => {
  assert.ok(originAllowed("https://ai-keys.lab.ddupan.top", "https://ai-keys.lab.ddupan.top/"));
  assert.ok(!originAllowed(undefined, "https://ai-keys.lab.ddupan.top"));
  assert.ok(!originAllowed("https://evil.example", "https://ai-keys.lab.ddupan.top"));
});

test("groups", () => {
  assert.ok(inGroups(["x", "platform-admins"], ["platform-admins"]));
  assert.ok(!inGroups(["x"], ["platform-admins"]));
  assert.ok(!inGroups("platform-admins", ["platform-admins"]));
});
