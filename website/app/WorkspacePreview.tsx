"use client";
import { useState } from "react";
const tabs = [{ id: "todo", label: "待办" }, { id: "notes", label: "笔记" }, { id: "usage", label: "AI 用量" }] as const;
const tasks = [
  { title: "今天的重点", color: "blue", tasks: ["整理今天的三个重点", "留出一段专注时间"] },
  { title: "正在推进", color: "green", tasks: ["把想法整理成下一步", "完成后记下一点收获"] },
  { title: "学习与积累", color: "amber", tasks: ["读一篇收藏的文章", "记录一个值得保留的观点"] },
  { title: "生活与日常", color: "rose", tasks: ["出门走走，换个思路", "让今天有一个轻松的结尾"] },
];
export default function WorkspacePreview() {
  const [expanded, setExpanded] = useState(true);
  const [active, setActive] = useState<(typeof tabs)[number]["id"]>("todo");
  return <figure className="preview" data-section="preview">
    <div className="preview-stage">
      <button className="notch" aria-expanded={expanded} aria-controls="workspace-demo" onClick={() => setExpanded(value => !value)}><span className="notch-dot" aria-hidden="true" />醒目<span aria-hidden="true">{expanded ? "⌃" : "⌄"}</span></button>
      {expanded ? <div className="demo-window" id="workspace-demo">
        <div className="demo-header"><div className="demo-brand"><span className="brand-symbol" aria-hidden="true">目</span><strong>醒目</strong><span>个人效率工作台</span></div><span className="demo-status">把注意力，留给当下</span></div>
        <div className="demo-tabs" role="tablist" aria-label="查看界面示意">{tabs.map(tab => <button id={`tab-${tab.id}`} key={tab.id} role="tab" aria-selected={active === tab.id} aria-controls={`panel-${tab.id}`} onClick={() => setActive(tab.id)}>{tab.label}</button>)}</div>
        <div className="demo-content" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
          {active === "todo" && <div className="task-grid">{tasks.map(group => <div className={`task-group ${group.color}`} key={group.title}><h3><span aria-hidden="true" />{group.title}</h3>{group.tasks.map(task => <div className="task-row" key={task}><span className="task-circle" aria-hidden="true" /><span>{task}</span></div>)}</div>)}</div>}
          {active === "notes" && <div className="note-demo"><aside><span className="tiny-label">我的笔记</span><div className="note-list-item">值得留下的想法<span>刚刚</span></div><div className="note-list-muted">阅读与思考</div></aside><article><span className="tiny-label">随手记录</span><h3>值得留下的想法</h3><p>不必等到想法完整，先把它记下来。</p><p>一个问题、一句话、一次小小的进展，都可以成为下一步的起点。</p><span className="note-tag">本地笔记</span></article></div>}
          {active === "usage" && <div className="usage-demo"><div><span className="tiny-label">平台账户用量</span><h3>让消费与用量有据可查</h3><p>导入官方账单后，按日期、模型与 API Key 查看已有统计。</p></div><div className="usage-metrics">{["已导入消费", "请求次数", "总 Token"].map(label => <div key={label}><span>{label}</span><strong>—</strong><small>等待导入账单</small></div>)}</div><p className="demo-footnote">账户统计与本程序调用记录分开查看。</p></div>}
        </div>
      </div> : <div className="collapsed-hint" id="workspace-demo"><span>收起界面，回到手头的事。</span><small>点击上方「醒目」重新展开</small></div>}
    </div>
    <figcaption>交互界面示意 · 使用虚构内容，不含个人数据<span>试试切换工作区，或点击顶部收起</span></figcaption>
  </figure>;
}
