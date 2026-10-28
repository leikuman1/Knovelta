# 开发经验

开发与 Review 前先读 [代码规范](docs/code-standards.md)，再读本页相关条目。记录、每日复盘、晋升和容量限制见 [工作流说明](docs/lessons-workflow.md)。

## 待验证与积累

<!-- lesson:L001 -->
<a id="l001"></a>
### L001 · 先确认 hydration 差异由谁引入

- 问题键：`hydration-external-dom`
- 规则：遇到 hydration mismatch 时先核对属性差异及浏览器扩展；只有应用确实需要容忍该差异时才使用 `suppressHydrationWarning`。
- 原因：忽略警告不会阻止扩展修改 DOM，也可能隐藏应用自身在该节点上的渲染差异。为单一扩展直接添加兼容代码可能带来不必要的维护和返工。
- 证据：
  - 2026-10-27 | record:docs/lessons-evidence.md#r20261027-hydration | 沉浸式翻译向 html 注入主题属性；首次添加忽略配置后，经用户确认已撤回。
<!-- /lesson -->

<!-- lesson:L002 -->
<a id="l002"></a>
### L002 · 在流被消费或取消前采集测试所需响应

- 问题键：`stream-response-observation`
- 规则：测试流式页面时，先确定响应由谁消费和取消；需要完整响应的测试应在消费前复制真实响应，避免事后依赖 CDP 回读已取消的流。
- 原因：页面收到 done 后取消 reader，浏览器调试协议可能无法再读取响应体。此时错误来自测试观察方式，不能据此改写应用业务流程。
- 证据：
  - 2026-10-27 | record:docs/lessons-evidence.md#r20261027-stream | Playwright 报 Network.getResponseBody 无数据；测试在浏览器 fetch 层 clone 真实响应后，完整五项浏览器测试通过。
<!-- /lesson -->

<!-- lesson:L003 -->
<a id="l003"></a>
### L003 · 修改依赖与使用依赖的检查必须串行

- 问题键：`dependency-install-test-race`
- 规则：同一工作目录中的 npm install、npm ci、原生模块重建与依赖这些文件的构建或测试串行执行；通知其他执行者依赖正在变化。
- 原因：安装会替换 node_modules，检查可能遇到缺失或混合版本。共享文件可并行读取，修改共同依赖时需要明确执行顺序。
- 证据：
  - 2026-10-27 | record:docs/lessons-evidence.md#r20261027-dependencies | 准备重跑浏览器测试时启动 npm ci，协调线程随即暂停测试，安装及 SQLite 原生模块重建完成后再统一验证。
<!-- /lesson -->

<!-- lesson:L004 -->
<a id="l004"></a>
### L004 · 使用框架原生路由表达接口

- 问题键：`framework-native-routing`
- 规则：Next.js API 使用对应目录中的 route.ts 和 HTTP 方法导出；仅在确有通配需求时使用 catch-all，避免在一个入口按路径段重新分发全部接口。
- 原因：为减少文件而集中全部接口，会重复框架的路由能力，并让安全校验、参数解析和聊天流程堆在同一文件中，增加阅读和修改成本。
- 证据：
  - 2026-10-28 | record:docs/lessons-evidence.md#r20261028-routing | 用户指出 catch-all 通过多组 if 手动分发所有 API，确认采用原生文件路由并迁移处理逻辑。
<!-- /lesson -->

<!-- lesson:L005 -->
<a id="l005"></a>
### L005 · 校验器不能静默跳过未识别的输入

- 问题键：`validation-silent-omission`
- 规则：格式校验须检查每个输入项；引用定位与内容校验共用解析结果，必填字段缺失时拒绝，回归测试覆盖有效与无效内容混合及相邻记录边界。
- 原因：仅提取匹配项会漏掉错误证据；定位支持的格式多于后续解析时，缺失值又可能绕过校验，使不可靠日期被计入晋升。
- 证据：
  - 2026-10-28 | record:docs/lessons-evidence.md#r20261028-validation | CodeRabbit 指出证据项被静默忽略、单引号及标题锚点和缺失日期绕过校验；逐项验证并统一记录解析，24 项经验测试通过。
<!-- /lesson -->

## 已晋升索引

暂无。满足三个不同日期且证据经核对后，移动完整规则到代码规范，本节只保留链接。
