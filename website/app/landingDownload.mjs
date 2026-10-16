export const LATEST_RELEASE_API_URL = "https://api.github.com/repos/bigelc/xingmu/releases/latest";
function selectDownloadUrl(release, suffix) {
  if (!release || release.draft || release.prerelease || !Array.isArray(release.assets) || typeof release.tag_name !== "string") return null;
  const match = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name);
  if (!match) return null;
  const name = `Xingmu-${match[1]}-${suffix}`;
  const expectedUrl = `https://github.com/bigelc/xingmu/releases/download/${release.tag_name}/${name}`;
  const asset = release.assets.find(candidate => candidate?.name === name && candidate.state === "uploaded" && candidate.browser_download_url === expectedUrl);
  return asset?.browser_download_url ?? null;
}
export function selectWindowsDownloadUrl(release) { return selectDownloadUrl(release, "windows-x64-setup.exe"); }
export function selectMacDownloadUrl(release) { return selectDownloadUrl(release, "arm64.dmg"); }
