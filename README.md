# dsh-multi-agent-orchestrator

DeepSeek Harness 的多智能体编排插件：一个可切换的 Agent 模式（agent preset），
以 **Orchestrator** 为控制平面，调度 **Explorer / Librarian / Observer /
Oracle / Designer / Fixer** 六个职责严格隔离的专职子代理，完整实现
“调查 → 判断 → 执行 → 验证”的工作流。

设计目标（与设计文档一致）：

> **Harness 管“怎么运行 Agent”；Plugin 管“为什么调用哪个 Agent”。**

本插件**不重新实现** harness 的 agent 循环、工具调用、会话、权限、子代理、
上下文压缩——全部复用宿主能力。插件只做一件事：**注册职责隔离的代理，并
决定何时把工作委派给谁**。

---

## 一、安装

```powershell
# 1. 构建 preset（已提交的 preset/orchestrator/ 也可直接使用）
node scripts/build.mjs

# 2. 安装到 DSH 用户目录（默认 $DSH_HOME = ~/.dsh）
node scripts/install.mjs

# 3. 验证
node scripts/validate.mjs
node --test tests/
```

安装脚本会把 `preset/orchestrator/` 复制到
`$DSH_HOME/.agent-presets/orchestrator/`。Web 界面实时读取该目录，
无需重启：打开会话开始处的 **Agent preset 选择器**（或 设置 → Agent preset），
选择 **“多智能体编排”** 即可。卸载 = 删除该目录，宿主恢复原样。

> 该模式是纯增量的：不修改任何宿主行、不覆盖 provider/MCP、不动
> `standard`/`code`/`minimal`/`cordis` 预设、不写入 profile patch 层。

## 一·五、启用与切换（Web 界面）

启用路径有两条，均在 Web 界面（默认 http://127.0.0.1:3080）完成：

1. **按会话启用**：在“新会话”界面（composer 上方）找到 **Agent preset** 选择
   chip（在 workspace 选择旁边），点开选择 **多智能体编排**，然后开始会话。
   该选择只影响这一个会话；运行中的会话保持它开始时的 preset。
2. **设为默认**：设置（Settings）→ General → **Agent preset** → 选择
   **多智能体编排** 并 “Set as default”。之后新建的会话默认使用该模式。

切换回来同样简单：任一路径选择回 **标准模式**（standard）即可。两种模式共存，
互不影响；标准模式的一切能力保持不变。

> 注意：preset 在会话创建时固定。已经产生过内容的会话不能中途切换 preset
> （工具目录会与历史日志不一致）；空白会话可以在创建后、首次输入前切换。

---

## 二、模式结构（“模式” = DSH agent preset）

```
preset/orchestrator/
├── agent.cordis.yml       # 组合文件：Orchestrator persona + 六个委派工具 + 边界行
├── preset.yml             # 显示元数据（选择器中的名称/描述）
└── orchestration.mjs      # 边界行：agent/created 时收紧根代理的工具面
```

- **Orchestrator** = 会话代理本身。它的 persona 是完整系统提示词
  （`complete: true`），包含身份、任务、路由策略（§17）、工作流（§27）、
  委派协议与收尾报告格式。
- **六个 specialist** = 通过六个 `@deepseek-ai/dsh-tool-subagent` 实例生成：
  `subagent_explorer`、`subagent_librarian`、`subagent_observer`、
  `subagent_oracle`、`subagent_designer`、`subagent_fixer`。每个实例自带
  **专属 persona**、**toolFilter**（编译进子代理作用域的 `tools.restrict()`，
  是真正的权限边界而非提示词约束）、以及 **maxDepth: 1**。
- **maxDepth: 1** 的语义：Orchestrator（深度 0）可以生成 specialist
  （深度 1）；specialist 再试图生成任何代理都会因深度 2 > 1 被宿主拒绝。
  加上 toolFilter 完全不给 specialist 暴露 `subagent_*` 工具，
  “specialist 不能调用其他 specialist” 有双重机械保证。
- **边界行 orchestration.mjs**：监听 `agent/created`，只对**根代理**
  （无 `parentSession` 头）调用 `agent.ctx.tools.restrict(...)`，把
  Orchestrator 的工具面收窄为控制平面集合。子代理不受影响——它们的工具面
  由各自委派工具的 toolFilter 决定。

---

## 三、权限模型

每个代理的工具面（allow 列表；未列出的一律不可见）：

| Agent | Read | Search | Web | Shell | Edit | Jobs | Ask user |
|-------|------|--------|-----|-------|------|------|----------|
| Orchestrator | read, read_image | grep, glob | web_search | — | — | — | ask_user_question |
| Explorer | read, read_image | grep, glob | — | bash/pwsh* | — | — | — |
| Librarian | — | — | web_search | — | — | — | — |
| Observer | read, read_image | grep, glob | web_search | bash/pwsh | — | job_* | — |
| Oracle | read, read_image | grep, glob | web_search | — | — | — | — |
| Designer | read, read_image | grep, glob | web_search | bash/pwsh | — | — | — |
| Fixer | read, read_image | grep, glob | web_search | bash/pwsh | write, edit | job_* | — |

\* Explorer 的 shell 是“只读纪律”：DSH 无法在权限层表达只读 shell，
因此其 prompt 硬性限制为非变更命令；可变更工具（write/edit）在权限层被移除。

实现要点：

- `bash` 只在非 Windows 注册，`pwsh` 只在 Windows 注册。生成器对含 shell 的
  过滤器输出 `!!js process.platform === 'win32' ? [...] : [...]` 表达式，
  由 loader 在入口激活时求值，避免 `tools.restrict()` 对未注册工具名抛错。
- 只有 **Fixer** 拥有 write/edit；只有 **Orchestrator** 拥有
  `subagent_*` 委派工具与 `ask_user_question`。
- Orchestrator 自身被边界行限制为控制平面集合：
  `read, read_image, grep, glob, ask_user_question, todo_write, web_search,
  list_agents, subagent_*`——它不能写文件、不能跑 shell、不能直接执行。

---

## 四、路由策略（§17）

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

核心纪律：**facts before decisions, decisions before actions, actions before
verification, verification before completion**。Fixer 只有在目标明确时才被
路由（`route()` 对模糊 bug 报告会回退到调查代理）；信息代理之间出现冲突时，
冲突证据交给 Oracle 而非自行裁决。

---

## 五、代理返回协议（§24）

每个 specialist 返回统一 envelope：

```text
STATUS: SUCCESS | PARTIAL | BLOCKED | NOT_APPLICABLE
SUMMARY:
FINDINGS:
EVIDENCE:
UNCERTAINTIES:
RECOMMENDED_NEXT_STEP:
```

- Fixer 追加 `CHANGES:` / `VERIFICATION:`。
- Observer 追加 `OBSERVED:` / `EXPECTED:` / `DIFFERENCE:`。
- Designer 输出可交给 Fixer 的 `SPECIFICATION:`（组件、问题、期望行为、
  布局、间距、排版、响应式规则、交互、无障碍、验收标准）。
- 信息不足时返回 `UNKNOWN`/`BLOCKED`，禁止编造；Fixer 发现根因与输入不符时
  停止扩大修改并返回 `BLOCKED / NEED REASONING`。

---

## 六、项目结构

```
src/
├── agents/catalog.js                 # 六个 specialist 的定义（工具名、persona、过滤器）
├── config/                           # schema 校验、默认值、组合 loader
├── orchestration/orchestration.mjs   # 边界行（根代理工具收窄；零依赖）
├── permissions/agent-permissions.js  # 每代理权限矩阵（唯一事实来源）
└── routing/
    ├── policy.js                     # 路由规则 + scoreTask/route + 路由表渲染
    └── handoff.js                    # 委派 prompt 与 envelope 模板
prompts/                              # 七个代理的系统提示词（Orchestrator + 6 specialists）
scripts/
├── build.mjs                         # 生成 preset/orchestrator/
├── install.mjs                       # 安装到 $DSH_HOME/.agent-presets/
├── validate.mjs                      # 真实 loader 方言解析 + 行名解析 + 过滤器校验
└── smoke-mount.mjs                   # 真实 boot + mount 集成测试
tests/                                # node:test 测试套件
```

## 七、测试

```powershell
node --test tests/
```

- `routing.test.mjs` — 路由策略（§17、§13）映射正确；模糊任务不直接路由 Fixer。
- `permissions.test.mjs` — 权限矩阵（§19、§26 Test 6–11）：Explorer 不能写、
  Librarian 仅 web、Observer 不能改、Fixer 可写且唯一、Orchestrator 有委派
  工具但无变更工具、任何 specialist 都看不到 `subagent_*`。
- `delegation.test.mjs` — 六个委派工具 spawn 语义、maxDepth 1、边界行只收窄
  根代理（用假 ctx 驱动 `agent/created`）。
- `harness-compat.test.mjs` — 不携带 host patch 层、不改宿主行、无 provider/MCP
  行、组合可确定性地重建。
- `mount.test.mjs` — **真实集成测试**：用 harness 自己的 base bundle 启动
  Cordis、挂载 agent-presets、以真实 loader 装载本 preset 并创建 agent，
  断言组合激活、边界生效、过滤器名全部通过 `restrict()` 校验。
  （需要 DSH checkout，缺失时自动跳过。）

## 八、为不同 Agent 配置不同的 provider / model

支持。每个 specialist 都是一个独立的 `dsh-tool-subagent` 实例，宿主会在生成
子代理时应用该实例的 `agentOptions`（provider/model/maxTokens），覆盖
Orchestrator 自身的路由（见 `dsh-subagent` 的 `resolveChildAgentOptions`）。

### 配置方式

把 `model-routing.json.example` 复制为 `model-routing.json` 并修改，然后重新
构建安装：

```powershell
Copy-Item model-routing.json.example model-routing.json
# 编辑 model-routing.json：为每个 specialist 指定 provider / model / maxTokens
node scripts/build.mjs
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
  `model-routing.json.example` 随仓库分发。
- **provider 必须已在宿主中注册**（如 `deepseek-official`，或通过
  Settings → Models 配置的 pi-ai 等适配器），model 必须是该 provider 提供的
  模型名。未配置的 specialist 保持继承 Orchestrator 的路由。
- 三个字段（provider / model / maxTokens）**全部必填**——这是
  `dsh-tool-subagent` 的 schema 要求，缺失会构建失败。
- `maxTokens` 是该 specialist 单次输出的上限；`oracle` 这类深度推理角色建议
  给更大预算，`librarian` 这类短查询角色可以收紧。
- 构建脚本在 `model-routing.json` 存在时把 `agentOptions` 写入每个委派行；
  不存在时生成的组合不包含 `agentOptions`（全部继承），默认行为不变。

> 除模型路由外，每个 specialist 的工具面（权限）也可以独立调整——见
> `src/permissions/agent-permissions.js`，改完重新构建即可。

## 九、作为开源插件分享

可以。本插件是一个**纯增量的 DSH agent preset**，不修改宿主任何文件，
非常适合以开源仓库 + npm 包两种形式分发。

### 仓库形式（推荐）

```bash
git init
git add .
git commit -m "dsh-multi-agent-orchestrator: multi-agent orchestration mode"
git remote add origin https://github.com/<you>/dsh-multi-agent-orchestrator.git
git push -u origin main
```

使用者克隆后：

```bash
npm install           # 无运行时依赖，仅开发工具
npm run build         # 生成 preset/orchestrator/
npm test              # 测试（需要时可跳过）
node scripts/install.mjs   # 安装到 ~/.dsh/.agent-presets/orchestrator
```

仓库已包含：`LICENSE`（MIT）、`.gitignore`、`.github/workflows/ci.yml`
（GitHub Actions：build + validate + test）、`model-routing.json.example`。

### npm 包形式（可选）

`package.json` 已配置好 `files` 与 `prepublishOnly`（发布前自动构建+校验）。
把 `repository`/`bugs`/`homepage` 字段改成你的地址后：

```bash
npm publish
```

使用者通过 npm 获取源码包后，用同样的方式安装 preset 目录：

```bash
npx dsh-multi-agent-orchestrator    # 或 npm pack 后解压
node scripts/install.mjs
```

> 说明：本插件不需要在 profile 里 `dsh plugin add`——它不是一个 host 插件
> 包，而是一个 agent preset。安装 = 把 `preset/orchestrator/` 放进
> `$DSH_HOME/.agent-presets/`。这样对宿主的侵入为零，卸载也只是一个目录。

## 十、常见问题

- **选择器里看不到该模式？** 确认 `$DSH_HOME/.agent-presets/orchestrator/`
  存在且包含 `agent.cordis.yml`；Web 端选择器实时读盘，无需重启。
- **改了 prompts 没生效？** prompts 在构建时内联进 `agent.cordis.yml`，
  改完运行 `node scripts/build.mjs && node scripts/install.mjs --force`。
- **想要后台委派 / fork？** 当前六个委派工具为前台 one-shot（并行通过一条
  消息内多个工具调用实现）。如需要，可在组合中追加 `backgroundMode: continuable`
  的实例并配 `send_message` 工具。
- **web_fetch 未启用？** 与宿主默认一致（SSRF 防护）；需要时在组合的
  `tool-web` 行打开 `fetch: true` 并挂载相应 fetch provider。
