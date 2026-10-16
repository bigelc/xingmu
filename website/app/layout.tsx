import type { Metadata, Viewport } from "next";
import "./globals.css";
import { assetPath } from "./assetPath.mjs";
import { BRAND } from "./landingContent";
const description = "醒目，让重要的事始终醒目。适用于 macOS 与 Windows 的个人效率工作台，集中管理待办、笔记、链接、录音、AI 服务与账户用量。";
export const metadata: Metadata = {
  metadataBase: new URL("https://bigelc.github.io/xingmu/"), title: BRAND, description, applicationName: BRAND,
  keywords: ["醒目", "个人效率工作台", "macOS", "Windows", "待办", "本地笔记", "AI 用量"],
  icons: { icon: [{ url: assetPath("/favicon.svg"), type: "image/svg+xml" }], shortcut: assetPath("/favicon.svg") },
  alternates: { canonical: "https://bigelc.github.io/xingmu/" },
  openGraph: { type: "website", locale: "zh_CN", siteName: BRAND, title: BRAND, description, url: "https://bigelc.github.io/xingmu/" },
  twitter: { card: "summary", title: BRAND, description },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, colorScheme: "light", themeColor: "#faf9f6" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body>{children}</body></html>; }
