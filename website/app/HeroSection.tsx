"use client";
import { useState, type MouseEvent } from "react";
import { DOWNLOAD_URL, VERSION } from "./landingContent";
import { LATEST_RELEASE_API_URL, selectMacDownloadUrl, selectWindowsDownloadUrl } from "./landingDownload.mjs";
export default function HeroSection() {
  const [pending, setPending] = useState<"mac" | "windows" | null>(null);
  const startDownload = async (event: MouseEvent<HTMLAnchorElement>, platform: "mac" | "windows") => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault(); if (pending) return; setPending(platform);
    try {
      const response = await fetch(LATEST_RELEASE_API_URL, { headers: { Accept: "application/vnd.github+json" }, credentials: "omit", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("release_unavailable");
      const release = await response.json();
      const url = platform === "mac" ? selectMacDownloadUrl(release) : selectWindowsDownloadUrl(release);
      window.location.assign(url ?? DOWNLOAD_URL);
    } catch { window.location.assign(DOWNLOAD_URL); }
    finally { setPending(null); }
  };
  return <section className="hero" data-section="hero" id="top">
    <div className="version-badge"><span aria-hidden="true" />醒目 v{VERSION}</div>
    <h1>让重要的事，<br /><em>始终醒目。</em></h1>
    <p className="hero-description">一个常驻屏幕顶部的个人效率工作台。<br className="desktop-break" />待办、笔记、录音与 AI 服务，随手展开，随时继续。</p>
    <div className="download-actions" id="download">
      <a className="button button-primary" href={DOWNLOAD_URL} onClick={event => startDownload(event, "mac")} aria-busy={pending === "mac"} data-direct-download="mac">{pending === "mac" ? "正在查找安装包…" : "下载 macOS 版本"}<span aria-hidden="true">↓</span></a>
      <a className="button button-secondary" href={DOWNLOAD_URL} onClick={event => startDownload(event, "windows")} aria-busy={pending === "windows"} data-direct-download="windows">{pending === "windows" ? "正在查找安装包…" : "下载 Windows 版本"}<span aria-hidden="true">↓</span></a>
    </div>
    <p className="platform-note">macOS 13+ · Apple Silicon<span aria-hidden="true"> / </span>Windows 10/11 · x64</p>
  </section>;
}
