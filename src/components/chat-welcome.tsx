import { Icon, type IconName } from "./ui";

const starters: { icon: IconName; title: string; description: string; prompt: string }[] = [
  { icon: "plus", title: "记下一个发现", description: "把零散理解整理成笔记", prompt: "帮我记一下：" },
  { icon: "search", title: "找回已有知识", description: "从笔记中寻找答案与来源", prompt: "我的笔记里有没有关于……的记录？" },
  { icon: "review", title: "补充一篇笔记", description: "结合新信息，审阅后更新", prompt: "我想补充一篇已有笔记：" },
];

export function ChatWelcome({ onDraft }: { onDraft: (prompt: string) => void }) {
  return <div className="chat-welcome">
    <h1>记录与提问</h1>
    <p className="welcome-description">写下新发现，补充已有笔记，或从知识库中查找答案。</p>
    <h2 className="starter-heading">输入示例</h2>
    <div className="starter-list" aria-label="输入示例">
      {starters.map(starter => <button className="starter-card" key={starter.title} onClick={() => onDraft(starter.prompt)}>
        <span className="starter-icon"><Icon name={starter.icon} width="18" height="18" /></span>
        <span><strong>{starter.title}</strong><small>{starter.description}</small></span>
        <Icon name="chevron" width="15" height="15" />
      </button>)}
    </div>
    <p className="starter-hint">选择一种开始方式，编辑后发送。</p>
  </div>;
}
