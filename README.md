# oh_my_deepseek_harness

> DeepSeek Harness 多智能体编排模式 — 灵感来自 [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)

以 **Orchestrator** 为控制平面，调度 **Explorer / Librarian / Observer /
Oracle / Designer / Fixer** 六个职责严格隔离的专职子代理，在 DeepSeek
Harness 中实现“调查 → 判断 → 执行 → 验证”的完整工作流。

本插件是一个 **DSH agent preset（可切换的模式）**：安装后可在 Web 界面
的 Agent preset 选择器中与 `standard`（标准模式）、`code`、`minimal`、
`cordis` 并列选择，随时切换，互不影响。

---

## 灵感来源

本项目是对 [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim)
（opencode 平台的精简多智能体套件）在 DeepSeek Harness 上的移植与适配。

| 概念 | oh-my-opencode-slim（opencode） | 本项目（DeepSeek Harness） |
| --- | --- | --- |
| 模式/Agent 定义 | `opencode.json` + markdown 模式文件 | `agent.cordis.yml` 组合文件 + `prompts/*.md` |
| 子代理 | 内置 `task` 工具 + 模式切换 | `@deepseek-ai/dsh-tool-subagent` 委派工具 × 6 |
| 权限隔离 | 每模式 `allow`/`deny` 工具列表 | 每子代理 `toolFilter` → 编译为 `tools.restrict()` |
| 委托深度限制 | 角色内配置 | 宿主 `maxDepth` 机制 |
| 模型混用 | 每 Agent 指定 model | `agentOptions`（provider/model/maxTokens） |
| 宿主 | opencode | DeepSeek Harness（零侵入，纯增量 preset） |

设计文档中的角色分工（Orchestrator 路由、信息生产者/决策者/执行者分离、
envelope 返回协议）均与 oh-my-opencode-slim 一脉相承，并利用 DSH 的
原生能力做了机械化的权限强制。

---

## 特性

- 🎛️ **Orchestrator 控制平面**：理解目标、拆解任务、路由调度、整合结果、向用户汇报
- 🔍 **Explorer**：仓库静态事实（文件、符号、调用链、结构、已有模式）
- 📚 **Librarian**：外部知识（官方文档、第三方库、API、版本、标准）
- 👀 **Observer**：运行事实（测试输出、日志、截图、UI、复现）
- 🧠 **Oracle**：深度技术推理（根因、架构权衡、并发、安全、性能）
- 🎨 **Designer**：视觉/交互判断（UI/UX、布局、可访问性、规范输出）
- 🔧 **Fixer**：执行修改（唯一拥有 write/edit 的代理）
- 🛡️ **权限隔离**：工具面由 `toolFilter` 机械强制，非仅提示词约束。**只有 Fixer 拥有 write/edit 工具**；Explorer 与 Observer 仍保留可执行 shell（`bash`/`pwsh`），因为 DSH 权限层**无法表达只读 shell**——它们“只读”完全依赖 prompt 纪律，并非权限层强制。所以不要用无条件的“只有 Fixer 能修改”来描述：可执行 shell 的代理在技术上仍可经 shell 写文件，只是被 prompt 禁止
- 🚫 **禁止代理图**：`maxDepth: 1` + 过滤器双重保证 specialist 无法再生成代理
- ⚙️ **模型混用**：每个 specialist 可独立配置 provider / model / maxTokens
- 🔌 **零侵入**：不修改宿主任何文件，卸载即删目录

---

## 快速开始

### 环境要求

- DeepSeek Harness（Web 界面，默认 http://127.0.0.1:3080）
- Node.js ≥ 22（仅构建/安装脚本需要，运行时不需要）

### 安装

**方式一：直接使用已构建的 preset（推荐，无需构建）**

```powershell
# 把 preset 目录复制到 DSH 用户目录
$dsHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
Copy-Item -Recurse .\preset\orchestrator "$dsHome\.agent-presets\orchestrator"
```

**方式二：通过脚本安装（自动构建 + 复制）**

```powershell
node scripts/build.mjs        # 从 src/ + prompts/ 生成 preset/orchestrator/
node scripts/install.mjs      # 复制到 $DSH_HOME/.agent-presets/orchestrator/
```

**方式三：npm 包（需先将包发布到 npm registry 后方可使用）**

```bash
npm pack dsh-multi-agent-orchestrator   # 或 clone 仓库
tar -xzf dsh-multi-agent-orchestrator-*.tgz
node package/scripts/install.mjs
```

### 启用与切换（Web 界面）

安装后无需重启，Web 界面实时读取 `$DSH_HOME/.agent-presets/`。两种启用路径：

1. **按会话启用**：打开“新会话”界面（composer 上方），在 **Agent preset**
   选择 chip（位于 workspace 选择旁边）中点击，选择 **多智能体编排**，
   然后开始会话。该选择只影响这一个会话。
2. **设为默认**：设置（Settings）→ General → **Agent preset** → 选择
   **多智能体编排** → 点击 **Set as default**。之后新建的会话默认使用该模式。

切换回标准模式：同样路径选择 **标准模式（standard）** 即可。

> **注意**：preset 在会话创建时固定。已产生内容的会话不能中途切换 preset
> （工具目录会与历史日志不一致）；空白会话可在创建后、首次输入前切换。

### 卸载

```powershell
$dsHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
Remove-Item -Recurse "$dsHome\.agent-presets\orchestrator"
```

删除目录即完成卸载，宿主恢复原样，不影响任何其他模式。

### 验证安装

```powershell
node scripts/validate.mjs     # 真实 loader 方言解析 + 行名解析 + 过滤器校验
node --test tests/            # 测试套件（含真实挂载集成测试）
node scripts/smoke-mount.mjs  # 真实启动 harness 并挂载 preset 的集成验证
```

---

## 详细使用说明

### 1. 工作流

Orchestrator 强制执行：

```
facts before decisions
decisions before actions
actions before verification
verification before completion
```

1. **理解** — 复述目标，仅对用户拥有的选择提问
2. **调查** — 并行委派 Explorer / Librarian / Observer
3. **决策** — 根因/设计复杂时，先把证据交给 Oracle（技术）或 Designer（视觉）
4. **执行** — 目标明确后委派 Fixer（携带问题、文件、根因、期望行为、约束、验收标准、验证步骤）
5. **验证** — Fixer 完成后由 Observer 或测试确认
6. **汇报** — 总结发现、变更、验证、不确定性、下一步

### 2. 委派协议（envelope）

每个 specialist 返回统一信封：

```text
STATUS: SUCCESS | PARTIAL | BLOCKED | NOT_APPLICABLE
SUMMARY:
FINDINGS:
EVIDENCE:
UNCERTAINTIES:
RECOMMENDED_NEXT_STEP:
```

- **Fixer** 追加 `CHANGES:` / `VERIFICATION:`
- **Observer** 追加 `OBSERVED:` / `EXPECTED:` / `DIFFERENCE:`
- **Designer** 输出可交给 Fixer 的 `SPECIFICATION:`（组件、当前问题、期望
  行为、布局、间距、排版、响应式规则、交互、无障碍、验收标准）
- 信息不足返回 `UNKNOWN`/`BLOCKED`，禁止编造；Fixer 发现根因与输入不符时
  停止扩大修改并以 `STATUS: BLOCKED` 返回，附 `REASON:` 字段说明为何被阻塞

### 3. 权限矩阵

每个代理的工具面（allow 列表；未列出的一律不可见）：

| Agent | Read | Search | Web | Shell | Edit | Jobs | Ask user |
|-------|------|--------|-----|-------|------|------|----------|
| Orchestrator | read, read_image | grep, glob | web_search | — | — | — | ask_user_question |
| Explorer | read, read_image | grep, glob | — | bash/pwsh\* | — | — | — |
| Librarian | — | — | web_search | — | — | — | — |
| Observer | read, read_image | grep, glob | web_search | bash/pwsh\* | — | job_\* | — |
| Oracle | read, read_image | grep, glob | web_search | — | — | — | — |
| Designer | read, read_image | grep, glob | web_search | — | — | — | — |
| Fixer | read, read_image | grep, glob | web_search | bash/pwsh | **write, edit** | job_\* | — |

\* Explorer 与 Observer 的 shell 是“只读纪律”：DSH 无法在权限层表达只读
shell（属已知限制），它们的 prompt 硬性限制为非变更/观测命令；可变更工具
（write/edit）在权限层被移除。Designer 与 Oracle 无 shell。

要点：

- 只有 **Fixer** 拥有 write/edit 工具；Explorer 与 Observer 拥有 shell，但
  仅凭 prompt 纪律保持只读（DSH 权限层无法表达只读 shell，属已知限制）；
  只有 **Orchestrator** 拥有 `subagent_*` 委派工具与 `ask_user_question`
- 边界安装失败时 **fail-closed**：`agent/created` 监听内同步 throw 会否决
  该代理发布——工具注册表不可用时拒绝创建根代理，绝不 fail-open 运行
- 所有过滤器均为 **allow 白名单**（deny-by-default）
- `bash` 仅在非 Windows 注册、`pwsh` 仅在 Windows 注册；含 shell 的过滤器
  生成 `!!js process.platform === 'win32' ? [...] : [...]` 表达式，由 loader
  激活时求值，避免 `tools.restrict()` 对未注册工具名抛错
- Orchestrator 自身被边界行（`orchestration.mjs`）限制为控制平面集合，
  不能写文件、不能跑 shell、不能直接执行

### 4. 路由策略

Orchestrator 的 prompt 内嵌路由表（由 `src/routing/policy.js` 渲染，
测试与提示词共享同一来源）：

| Specialist | 何时使用 |
|---|---|
| Explorer | where / which file / implementation / call chain / repository structure / existing pattern / configuration |
| Librarian | documentation / third-party library / framework behavior / API / version compatibility / standards |
| Observer | screenshot / runtime behavior / UI rendering / test output / console / network / logs |
| Oracle | multiple solutions / high-risk change / complex root cause / architecture tradeoff / concurrency / security / performance |
| Designer | UI / UX / layout / interaction / accessibility / visual consistency |
| Fixer | 仅当修改目标/根因/验收标准明确时 |

核心纪律：模糊的 bug 报告先调查后修复（`route()` 对无明确目标的任务回退
到调查代理）；信息代理之间冲突时，证据交给 Oracle 而非自行裁决。

### 5. 为不同 Agent 配置不同 provider / model

把 `model-routing.json.example` 复制为 `model-routing.json` 并修改，然后
**用本地构建模式**重新构建安装（见下方要点：普通 `npm run build` 的 dist
模式**故意忽略**本地的 `model-routing.json`）：

```powershell
Copy-Item model-routing.json.example model-routing.json
# 编辑 model-routing.json：为每个 specialist 指定 provider / model / maxTokens
node scripts/build.mjs --local     # 或等价的 npm run build:local
node scripts/install.mjs --force
```

```json
{
  "explorer":  { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 8000 },
  "librarian": { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 4000 },
  "observer":  { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 8000 },
  "oracle":    { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 16000 },
  "designer":  { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 8000 },
  "fixer":     { "provider": "deepseek-official", "model": "deepseek-v4-flash", "maxTokens": 12000 }
}
```

要点：

- `model-routing.json` 已在 `.gitignore` 中（可包含密钥相关配置）；示例文件
  `model-routing.json.example` 随仓库分发
- **provider 必须已在宿主中注册**（如 `deepseek-official`，或通过
  Settings → Models 配置的 pi-ai 等适配器），model 必须是该 provider 提供的
  模型名。未配置的 specialist 保持继承 Orchestrator 的路由
- 三个字段（provider / model / maxTokens）**全部必填**——这是
  `dsh-tool-subagent` 的 schema 要求，缺失会构建失败
- `maxTokens` 是该 specialist 单次输出的上限；`oracle` 这类深度推理角色建议
  给更大预算，`librarian` 这类短查询角色可以收紧
- **构建模式区分（重要）**：`npm run build`（dist 模式）**刻意不读取任何
  `model-routing.json`**——它生成的是随仓库提交、CI 验证的标准继承 preset
  （所有 specialist 继承 Orchestrator 的 provider/model）。只有
  `npm run build:local`（即 `node scripts/build.mjs --local`）才会读取本地的
  `model-routing.json`，把 `agentOptions` 写入每个委派行，用于个人按
  specialist 定制路由。本地模式不会改变 dist 构建产物，两者互不影响
- 因此：**配置完 `model-routing.json` 后必须用本地构建再安装**；否则沿用
  文档命令 `npm run build`（dist）时，你的路由配置不会生效，specialist 仍
  全部继承 Orchestrator 的路由

### 6. 自定义提示词与权限

- **提示词**：编辑 `prompts/*.md`（七个代理各一个），然后
  `node scripts/build.mjs && node scripts/install.mjs --force`
- **权限**：编辑 `src/permissions/agent-permissions.js`（每个代理的 allow
  列表），然后重新构建安装
- **路由规则**：编辑 `src/routing/policy.js`（`ROUTING_RULES` 数组），
  路由表会自动渲染进 Orchestrator 的 prompt
- **Agent 目录**：编辑 `src/agents/catalog.js`（工具名、persona 文件、
  委派参数）

### 7. 项目结构

```
preset/orchestrator/          # 生成的可安装 preset（可直接复制使用）
├── agent.cordis.yml          # 组合文件：Orchestrator persona + 六个委派工具 + 边界行
├── preset.yml                # 显示元数据（选择器中的名称/描述）
└── orchestration.mjs         # 边界行：agent/created 时收紧根代理的工具面
prompts/                      # 七个代理的系统提示词（Orchestrator + 6 specialists）
src/
├── agents/catalog.js         # 六个 specialist 的定义（工具名、persona、过滤器）
├── config/                   # schema 校验、默认值、模型路由、组合 loader
├── orchestration/orchestration.mjs  # 边界行（根代理工具收窄；零依赖）
├── permissions/agent-permissions.js # 每代理权限矩阵（唯一事实来源）
└── routing/                  # 路由规则 + scoreTask/route + envelope 模板
scripts/                      # build / install / validate / smoke-mount
tests/                        # 测试套件（node:test）
.github/workflows/ci.yml      # GitHub Actions：build + validate + test
```

### 8. 架构说明

- **模式 = DSH agent preset**：DSH 原生机制，会话代理的工具、提示词、能力
  由 preset 组合文件决定；Web UI 有原生选择器
- **specialist = 委派工具实例**：每个 specialist 是 `@deepseek-ai/dsh-tool-subagent`
  的一个实例，自带专属 persona、toolFilter、maxDepth；子代理通过宿主
  `ctx.subagents` 生成，上下文完全隔离（spawn，不继承父对话）
- **maxDepth: 1**：Orchestrator（深度 0）可生成 specialist（深度 1）；
  specialist 再试图生成任何代理会被宿主拒绝（深度 2 > 1）——加上过滤器
  不暴露 `subagent_*` 工具，双重机械保证
- **边界行 orchestration.mjs**：监听 `agent/created`，只对根代理调用
  `agent.ctx.tools.restrict(...)`，把 Orchestrator 收窄为控制平面
- **零侵入**：不修改宿主行、不覆盖 provider/MCP、不动 shipped 预设、
  不写 profile patch 层

### 9. 测试

```powershell
node --test tests/
```

| 测试文件 | 覆盖 |
|---|---|
| `routing.test.mjs` | 路由策略：模糊任务不直接路由 Fixer |
| `permissions.test.mjs` | 权限矩阵：Explorer 不能写、Librarian 仅 web、Fixer 可写且唯一、Designer 无 shell、任何 specialist 看不到 `subagent_*` |
| `delegation.test.mjs` | 六个委派工具 spawn 语义、maxDepth 1、边界行只收窄根代理 |
| `model-routing.test.mjs` | 每 Agent 模型路由配置的加载与校验 |
| `envelope.test.mjs` | 信封**状态与字段校验**：`parseEnvelope`/`isKnownStatus` 接受四个标准状态，拒绝未知/缺失/重复字段，缺可选 section 给 warning，完整 envelope 可回环解析 |
| `handoff.test.mjs` | handoff **委派提示词渲染**：role-specific 的“可修改/禁止修改”约束 + 每个委派都内嵌信封模板（envelope 状态校验在上面的 `envelope.test.mjs`） |
| `orchestration.test.mjs` | 控制平面运行时机制：fail-closed 边界安装 + 单写者守卫（取锁/拒绝/完成与错误路径解锁/兜底） |
| `harness-compat.test.mjs` | 无 host patch 层、不改宿主行、无 provider/MCP 行、确定性构建、工具结果裁剪预算（20000/12000/3000） |
| `mount.test.mjs` | **真实集成**：启动 harness、挂载 preset、断言组合激活与边界生效 |

---

## 限制与已知问题 / 兼容范围

以下限制都是**如实**记录，而非未支持的借口——它们来自当前 DSH rc 版本的真实
能力边界，或是有意的架构取舍。

### 版本兼容性（DSH 与 npm 生态）

- 本项目构建并测试于 `@deepseek-ai/dsh@0.1.0-rc.6`（`dsh-base`、
  `dsh-tool-subagent`、`dsh-compaction-tool-result-pruner` 均为
  `0.1.0-rc.6`）。rc 阶段的 API 具有**波动风险**：任一底层包的接口调整都
  可能影响本 preset，升级前请先跑 `npm test` 与 `scripts/smoke-mount.mjs`。
- 更早的 `0.0.1-rc.1 / rc.3` 这条线**无法从公共 npm 安装**（依赖树损坏），
  因此**不在支持范围内**。请使用 `0.1.0-rc.x` 及以上。

### 运行时调度是“模型跟随”而非机械状态机

- 路由表 + **ROUTING PRECEDENCE**（风险门 → 明确目标 → 信号强度 → 默认
  Explorer）是内嵌在 **Orchestrator prompt** 里的纪律。`route()` /
  `scoreTask()` 是 CI 验证的**参考实现**，不是运行时钩子——它们不参与实际
  分发决策。
- 本文档中的单写者守卫（`orchestration.mjs` 里的 `tools/pre-execute` /
  `tools/execute` / `tools/post-execute`）只做**单写者守卫**，不实现机器化
  路由状态机。**在当前的 preset-only 架构下，无法实现机械的“分派前状态
  机”**——任务分解与路由完全交给 Orchestrator 模型。
- 同理，`parseEnvelope()` 与 `renderDelegationPrompt()` 是**库参考工具**，
  由单元测试验证；它们在当前 preset-only 架构下**不是运行时钩子**——运行时
  envelope 校验/委派提示词渲染需要 DSH 宿主集成，本 preset 并未接入，故不会
  在真实分发时机械校验 specialist 的返回信封。

### 子代理皆为 one-shot

- 六个 specialist 均为 **one-shot**：每次调用都把上下文**重新转录**给子
  代理，子代理不保留跨调用会话。
- **未开启 continuable 会话**。DSH 的 continuation 机制把跟随子代理的
  `send_message` 工具注册在**一个 continuable 子代理开始之后**，而
  Orchestrator 的 allow-list 边界在会话设置时就安装完毕；`tools.restrict()` 在
  restrict 时就对**当前未注册**的名字抛错（`dsh-tools/lib/index.js:2777-2785`），
  且 `restrictableNames` 只覆盖继承/全局层工具（`dsh-tools/lib/types/index.js:504-508`）。
  因此 `send_message` 无法被加入 Orchestrator 的 allow-list，continuable 子代理
  将无法被 Orchestrator 触达——这是**架构性限制，未实现**。
- 并行是通过**一条消息内多个 one-shot 工具调用**实现的（见 prompt）。

### 工具结果裁剪预算

- 结果裁剪预算为 **thresholdChars 20000 / headChars 12000 / tailChars 3000**，
  对**整个结果（含 envelope）**生效。DSH 的 pruner **没有字段排除机制**
  （无法只保留 envelope 而裁剪正文），因此六个 specialist prompt 都被指示
  **保持简短输出**、把 envelope 与关键证据放在 head 窗口内（详见各 prompt
  的 Brevity 小节）。

### 单写者（single-writer）

- **Fixer 委派由机械守卫 + prompt 规则双重串行**：`orchestration.mjs` 在
  `tools/pre-execute` 取锁、`tools/execute` 的 `finally` 解锁（并在
  `tools/post-execute` 兜底），确保任意时刻最多一个写能力的委派在途。
- **不存在自动 workspace 回滚**。Fixer 按 `TRANSACTION RULES` 返回**完整 diff**
  并在 `PARTIAL` / `BLOCKED` 时给出明确的 keep-vs-revert 决策（可回滚则
  `git checkout -- <files>`，否则列出遗留修改的文件与原因），由 Orchestrator
  决定保留还是回滚——这是文档化的显式策略，不是自动能力。

### 预算（经费）是 prompt 强制，不是 harness 原生

- 每任务 **最多 12 次 specialist 委派**、**最多 4 个信息代理并行**、**每个
  specialist 最多 2 次重试**、**3 次连续非 SUCCESS → 停止**——这些全部内嵌在
  Orchestrator 的 **BUDGET & TERMINATION** 一节，且 DSH 在**本版本没有
  任务预算 API**（`@deepseek-ai/dsh@0.1.0-rc.6` 未提供），因此预算只能靠
  prompt 纪律执行。唯一的**硬性**（非 prompt）强制是上面的单写者守卫。

### web_fetch 限制

见下方 FAQ：由 preset 行注册在 agent 平面，无法经 `toolFilter` / `restrict`
下发给子代理。此处不重复。

### stub 模型 / 评估说明

- 完整的“真实模型调用”行为评估需要**活的 provider**。CI 只验证
  挂载 / 权限 / 路由 / handoff / envelope 等**机械机制**；不跑真实模型回合。
- 仓库的 devDeps 中**没有可用的 stub / mock LLM provider**（已检查
  `node_modules/@deepseek-ai`），因此未提供真实调用的集成测试。

---

## 常见问题

- **选择器里看不到该模式？** 确认 `$DSH_HOME/.agent-presets/orchestrator/`
  存在且包含 `agent.cordis.yml`；Web 端选择器实时读盘，无需重启
- **改了 prompts 没生效？** prompts 在构建时内联进 `agent.cordis.yml`，
  改完运行 `node scripts/build.mjs && node scripts/install.mjs --force`
- **想要后台委派 / fork？** 当前六个委派工具为前台 one-shot（并行通过一条
  消息内多个工具调用实现）。**continuable 会话因架构限制未启用**：DSH 把跟随
  子代理的 `send_message` 工具注册在 continuable 子代理开始之后，而
  `tools.restrict()` 对当前未注册的名字在 restrict 时就抛错，`send_message`
  无法被加入 Orchestrator 的 allow-list（详见上文“限制与已知问题”）
- **web_fetch 未启用？** 与宿主默认一致（SSRF 防护）；需要时在组合的
  `tool-web` 行打开 `fetch: true` 并挂载相应 fetch provider。注意：DSH 的
  `web_fetch` 由 preset 行注册在 agent 平面，无法通过 `toolFilter`/`restrict`
  下发给子代理（`restrict` 只接受宿主/祖先层注册的全局工具名）
- **如何贡献？** 欢迎 PR：新 specialist、路由规则、权限调整、测试

---

## 许可证

[MIT](LICENSE)

## 致谢

- [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) —
  本项目的角色体系与工作流设计的灵感来源
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
  提供全部底层能力的宿主平台
