import test from "node:test";
import assert from "node:assert/strict";
import { LATEST_RELEASE_API_URL, selectMacDownloadUrl, selectWindowsDownloadUrl } from "../app/landingDownload.mjs";
const asset = (name, tag = "v2.0.0") => ({ name, state: "uploaded", browser_download_url: `https://github.com/bigelc/xingmu/releases/download/${tag}/${name}` });
for (const [platform, suffix, select] of [["Mac", "arm64.dmg", selectMacDownloadUrl], ["Windows", "windows-x64-setup.exe", selectWindowsDownloadUrl]]) {
  test(`${platform} resolves only the current version and correct installer`, () => {
    const correct = asset(`Xingmu-2.0.0-${suffix}`);
    const release = { tag_name: "v2.0.0", assets: [asset(`Xingmu-1.9.0-${suffix}`), asset(`Xingmu-2.0.0-${suffix}.sha256`), asset(`AnotherApp-2.0.0-${suffix}`), correct] };
    assert.equal(select(release), correct.browser_download_url);
    assert.equal(select({ ...release, assets: release.assets.slice(0, 3) }), null);
    assert.equal(select({ tag_name: "v2.1.3", assets: [asset(`Xingmu-2.1.3-${suffix}`, "v2.1.3")] }), `https://github.com/bigelc/xingmu/releases/download/v2.1.3/Xingmu-2.1.3-${suffix}`);
  });
  test(`${platform} rejects unsafe URLs, wrong architectures and unpublished assets`, () => {
    for (const change of [{ state: "new" }, { browser_download_url: "https://example.com/installer" }, { browser_download_url: "javascript:alert(1)" }, { browser_download_url: `https://github.com/other/project/releases/download/v2.0.0/Xingmu-2.0.0-${suffix}` }]) assert.equal(select({ tag_name: "v2.0.0", assets: [{ ...asset(`Xingmu-2.0.0-${suffix}`), ...change }] }), null);
    assert.equal(select({ tag_name: "v2.0.0", assets: [asset("Xingmu-2.0.0-windows-arm64-setup.exe"), asset("Xingmu-2.0.0-x64.dmg")] }), null);
    for (const value of [null, {}, { tag_name: "garbage", assets: [] }, { tag_name: "v2.0.0", draft: true, assets: [asset(`Xingmu-2.0.0-${suffix}`)] }, { tag_name: "v2.0.0", prerelease: true, assets: [asset(`Xingmu-2.0.0-${suffix}`)] }]) assert.equal(select(value), null);
  });
}
test("latest release uses the new repository", () => assert.equal(LATEST_RELEASE_API_URL, "https://api.github.com/repos/bigelc/xingmu/releases/latest"));
