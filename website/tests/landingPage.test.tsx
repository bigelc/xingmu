import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LandingPage from "../app/LandingPage";
import { BRAND, DOWNLOAD_URL, GITHUB_URL } from "../app/landingContent";
test("landing page renders the current brand and both platform download links", () => {
  const html = renderToStaticMarkup(createElement(LandingPage));
  assert.match(html, /醒目-个人效率工作台/); assert.match(html, /醒目 v2.0.0/);
  assert.match(html, /下载 macOS 版本/); assert.match(html, /下载 Windows 版本/);
  assert.equal((html.match(/data-direct-download=/g) || []).length, 2);
  assert.equal(BRAND, "醒目-个人效率工作台");
  assert.equal(GITHUB_URL, "https://github.com/bigelc/xingmu"); assert.equal(DOWNLOAD_URL, `${GITHUB_URL}/releases/latest`);
  assert.match(html, /相关内容会发送至对应服务/);
});
test("demo is clearly labeled and publishes no inherited screenshots or recordings", () => {
  const html = renderToStaticMarkup(createElement(LandingPage));
  assert.match(html, /交互界面示意/); assert.match(html, /使用虚构内容，不含个人数据/);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.match(html, /aria-expanded="true"/); assert.match(html, /aria-controls="workspace-demo"/);
  assert.doesNotMatch(html, /<video|<img|product-captures|tab-captures/);
  assert.deepEqual(readdirSync(new URL("../public", import.meta.url)), ["favicon.svg"]);
});
test("metadata and Pages build target the new site with light mode", () => {
  const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /https:\/\/bigelc.github.io\/xingmu\//);
  assert.match(layout, /colorScheme: "light"/);
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  assert.match(scripts["build:pages"], /NEXT_PUBLIC_BASE_PATH=.*xingmu/);
});
