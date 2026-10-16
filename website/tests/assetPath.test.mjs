import test from "node:test";
import assert from "node:assert/strict";
import { assetPathWithBase } from "../app/assetPath.mjs";
test("public assets support repository-scoped Pages and local preview", () => {
  assert.equal(assetPathWithBase("/favicon.svg", "/xingmu"), "/xingmu/favicon.svg");
  assert.equal(assetPathWithBase("favicon.svg", "/xingmu/"), "/xingmu/favicon.svg");
  assert.equal(assetPathWithBase("/favicon.svg", ""), "/favicon.svg");
});
