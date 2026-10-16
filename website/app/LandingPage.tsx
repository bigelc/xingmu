import HeroSection from "./HeroSection";
import WorkspacePreview from "./WorkspacePreview";
import { BRAND, CAPABILITIES, DOWNLOAD_URL, GITHUB_URL, VERSION } from "./landingContent";
export default function LandingPage() {
  return <>
    <a className="skip-link" href="#main">跳到正文</a>
    <header className="site-header"><a className="brand" href="#top" aria-label={BRAND}><span className="brand-symbol" aria-hidden="true">目</span><span>醒目<small>个人效率工作台</small></span></a><nav aria-label="主要导航"><a href="#features">功能</a><a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub ↗</a><a className="nav-download" href="#download">下载</a></nav></header>
    <main id="main"><HeroSection /><WorkspacePreview />
      <section className="features section-shell" id="features" data-section="features"><div className="section-heading"><span className="eyebrow">少一点切换，多一点专注</span><h2>把日常工作，放在顺手的地方。</h2></div><div className="feature-grid">{CAPABILITIES.map(item => <article key={item.number}><span className="feature-number">{item.number}</span><h3>{item.title}</h3><p>{item.body}</p><span className="feature-label">{item.label}</span></article>)}</div></section>
      <section className="local-section section-shell" data-section="local"><div><span className="eyebrow">你的工具，由你决定</span><h2>本地保存，按需连接。</h2><p>工作内容在自己的电脑上管理。启用联网功能时，相关内容会发送至对应服务；AI 服务与工作区都可以按需配置。</p></div><ul><li><span aria-hidden="true">✓</span>不用的工作区，可以关闭</li><li><span aria-hidden="true">✓</span>AI 连接和模型，由你选择</li><li><span aria-hidden="true">✓</span>开源代码，公开可查</li></ul></section>
      <section className="closing section-shell" data-section="closing"><span className="eyebrow">醒目 v{VERSION}</span><h2>从下一件小事，开始。</h2><a className="button button-primary" href="#download">选择你的版本<span aria-hidden="true">↑</span></a><a className="release-link" href={DOWNLOAD_URL} target="_blank" rel="noreferrer">查看发布记录 ↗</a></section>
    </main>
    <footer className="site-footer"><span>醒目-个人效率工作台</span><span>macOS & Windows · 开源</span><a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub ↗</a></footer>
  </>;
}
