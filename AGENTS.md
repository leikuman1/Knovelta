# Coding Agent 工作约定

项目背景与工程命令见 [CLAUDE.md](CLAUDE.md)，需求见 [开发规格](MemoAgent_Development_Spec.md)。本文件供支持 AGENTS.md 的 Coding Agent 读取，两处冲突时先遵循用户当前要求并核对实际代码。

## 开发与 Review

- 开始修改或 Review 前阅读 [代码规范](docs/code-standards.md)，再查阅 [LESSONS.md](LESSONS.md) 中与当前任务相关的经验；用问题键合并同类问题。
- 遇到可复用的错误或实际返工时，按 [经验工作流](docs/lessons-workflow.md) 记录规则、原因、证据和发生日期。没有新发现不改经验文件。
- 只有同一问题在至少三个不同发生日期有独立证据时才晋升，不把复盘日期、同日多提交或重复测试当作复发。
- 记录后运行 `npm run lessons:check`；人工核对证据语义，自动校验不能代替判断。
- 复盘不自动提交或推送，不读取密钥、私人知识目录或未经请求的会话缓存。Review 仍按真实缺陷和验证结果报告，不为了增加经验而制造问题。

## 当前项目边界

仅推进 Phase 1，单用户、单 Agent。Agent 使用 Vercel AI SDK，只能生成结构化 Proposal。Markdown 正文修改必须展示 Diff 并由用户批准，经受控后端检查版本后执行；原文只追加，保留来源、版本、审计和失败恢复。默认运行数据放 `workspace/`，不得提交。
