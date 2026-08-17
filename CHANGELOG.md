# 更新说明 / CHANGELOG

## v0.1.6（2026-08-17）— 审查修复批次：自定义角色、并发预算、测试去重与持久化

测试 190 项全部通过；validate OK；smoke（含 bootstrap）OK。

### P0 修复

- **自定义角色运行时可见**：新增 `runtime-catalog.mjs`（dist 复制、local
  按角色生成），`orchestration.mjs` 从它展开 Orchestrator allow-list；
  local build 的自定义 `subagent_<id>` 不再被边界收窄隐藏。writer 集合同步
  进入单写者锁。
- **预算并发安全**：gate 阶段预留 in-flight 配额（任务总委派、每 specialist
  尝试、保守连续失败容量），settle/错误/取消路径按 token 释放，并行委派
  不再绕过 12/3/3 机械上限。
- **workspace fingerprint 内容哈希**：`git status --porcelain` 从长度改为
  sha256 内容哈希；Observer/非 writer settle 时重新采样，外部改动不会再
  被误判为“同一 workspace”。
- **持久化即时可读**：`report()` / `snapshot()` 现在也会先加载磁盘状态，
  进程重启后 `broker_status` 无需先 gate 即可看到任务与 receipt。
- **broker_status receipt 详情**：报告包含每个 receipt 的 risk/exit/success/
  fingerprint 与结果摘要，Fixer/Observer 跑前可真正判断是否跳过。
- **Linux CI 修复**：`tests/artifacts.test.mjs` 不再硬编码反斜杠路径。

### P1 修复

- 路由表头不再重复渲染；`renderComposition(root)` 尊重传入 root。
- 自定义角色支持 `write`/`edit` 显式权限，自定义 executor 真正可写并纳入
  单写者锁；read/search 权限只接受已注册工具名。
- Observer prompt / 路由说明如实声明“只能读已有截图，不能截图/驱动浏览器”。
- README 测试命令改为 `node --test`；smoke/validate 支持相对 `DSH_CHECKOUT`。
- `listSessions()` 按最新写入时间排序；Oracle 复审必须发生在实现之后才
  满足 COMPLETE 门禁。
- 持久化状态新增 `writerTools`，status/metrics CLI 对自定义 executor 的
  状态推导一致。

## v0.1.5（2026-08-16）— 轨迹计数器客户端插件（We need… vs Let me…）

测试由 175 项增至 186 项，全部通过。

### 客户端插件：dsh-trajectory-counter

- 新增 `client/trajectory-counter/`：npm 包（`dsh.client` 声明 + 无操作
  服务端半部），在**会话 composer dock**（宿主 StatsLine 所在槽
  `conversation.composer.dock`，order 10）渲染 `We need… N (P%) · Let me…
  M (P%) · 其他 K (P%)` 实时计数——与状态行并排，直观呈现锚定/晋升后的
  首行轨迹分布。
- 分类口径与 dsh-anchored-standard 的测量一致：每条 `assistant/message`
  首行 → `we`（We need/We've/We're…）/ `let`（Let me/Let's…）/ `other`；
  分类逻辑 `src/classify.js` 为纯函数（单测覆盖），bundle 由
  `scripts/build-client.mjs` 生成（可复现门禁 + `node:vm` 伪加载器验证
  注册与渲染）。
- 安装：`npm run build:client` + `node scripts/install-client-plugin.mjs`
  （复制到部署 node_modules），随后在部署注册插件条目并重启 harness；
  验证 `/plugins/dsh-trajectory-counter/client.js` 出现在 boot manifest。

## v0.1.4（2026-08-16）— 融合 dsh-anchored-standard：锚定首请求 + 晋升

测试由 159 项增至 175 项，全部通过；validate OK；smoke 新增 **bootstrap 变体**
（`SMOKE_BOOTSTRAP=1` 独立进程验证真实链上首请求仅 8 个控制平面工具）。

### 锚定首请求（anchored bootstrap）

- 融合 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
  的核心机制（其实测表明首请求可见的工具 schema 决定会话轨迹质量），原生
  实现于 `src/orchestration/bootstrap.mjs`（随 preset 发布，import-free）：
- **新会话首请求只暴露控制平面工具**（`DEFAULT_BOOTSTRAP_ALLOW`：
  read/read_image/grep/glob/ask_user_question/todo_write/broker_status/
  broker_route），无委派工具、无 web_search——首轮成为干净的"理解任务"回合；
- **晋升**：第二个 `agent/pre-step`（即首请求完成后的下一个模型请求——
  `either` 语义：工具调用或纯文本回复都晋升）用 restrict disposer 交换到完整
  `ORCHESTRATOR_ALLOW`；
- **首请求剥离自动注入**（`agent-instructions`/`skill-catalog` source.kind），
  晋升后恢复——对应上游杠杆 3；
- **恢复会话恒不锚定**（事件日志已有 `tool/call` 或 `assistant/message` 即
  直接完整面）；**one-shot 子代理恒不锚定**（单请求即全角色过滤器，同上游
  "子代理无条件晋升"）；
- **健壮性**：bootstrap restrict 失败降级为完整面并告警；上下文剥离失败
  降级为保留全部消息（与上游同规则）。
- 配置：`$DSH_ORCHESTRATION_BOOTSTRAP`——默认开启；`0`/`off` 关闭；JSON
  数组自定义首请求工具。晋升时工具目录变化一次，KV 前缀缓存在该点断开
  （与上游一致，已文档化）。

### 其他

- smoke-mount 支持 `SMOKE_BOOTSTRAP=1` 变体（独立进程，因 preset 行在
  apply 时读 env 且模块按进程缓存）；`tests/bootstrap-smoke.test.mjs` 跨进程
  断言真实链首请求工具面。
- 提示词新增 BOOTSTRAP PHASE 说明；README 增加多模型子代理与 bootstrap
  配置说明、致谢 dsh-anchored-standard。

## v0.1.3（2026-08-16）— 完成门禁 + 审查闭环 + pytest 分层减量 + broker_route

测试由 150 项增至 159 项，全部通过；validate OK；smoke 真实链探针新增
`broker_route`（16 个工具可见）。

### 完成门禁 + 审查闭环（面向“主代理管着子代理完成任务”）

- broker 按记录**自动派生任务状态**：`PLANNED → RUNNING → IMPLEMENTED`
  （Fixer SUCCESS）→ `VERIFIED`（Observer SUCCESS）→ `COMPLETE`（未咨询
  Oracle，或最新 Oracle 为 SUCCESS）。`broker_status` 显示每个任务的状态与
  完成提示；Orchestrator prompt 强制“状态非 COMPLETE 不得宣布完成”。
- **审查失败闭环机械化**：最新 Oracle 复审为 `BLOCKED` 时，该 TASK_ID 的
  **全部后续委派在门前被 DENY**（reason: review blocked）——必须换新
  TASK_ID 以修正方案重开，或停止汇报。

### pytest 分层与减量（解决“pytest 太多导致进度慢”）

- **receipt 注解 schema**：`<command> [risk=R0-R3,exit=N,counts=M,fail=a::b;c]: <result>`
  机械解析（`parseReceiptLine`/`receiptSucceeded`）；纯 `<command>: <result>`
  仍兼容。
- **重复验证机械检测**：同一任务、相同命令、相同 workspace fingerprint 的
  重复 receipt 被标记 `duplicate` 并计数，警告写入结果记录；fingerprint
  不可用时保守不标记。Observer prompt 明确“不重跑 Fixer 已跑过的相同命令，
  改为核对 receipt + 升层验证 + 抽样复核”。
- **报告式 receipt 预算**：每任务默认 12 条（`maxReceiptsPerTask`，可经
  `$DSH_ORCHESTRATION_BUDGETS` 覆盖），超限在 broker_status 与结果警告中
  提示。
- **风险分层与测试选择规则内嵌 Fixer prompt**：R0 不跑 pytest；R1 精确
  nodeid；R2 unit+contract；R3 最小失败用例→integration/E2E；变更测试
  选择决策树（直接修改→源码映射→同包→改共享件自动跳级→全量每 fingerprint
  至多一次）；失败分类（assertion 只重跑失败 nodeid、collection/infra
  诊断一次即 BLOCKED、flaky 精确重跑一次）。
- metrics CLI 新增：任务状态分布、receipt 风险层统计、重复验证计数；
  status CLI 显示派生任务状态。

### broker_route：路由参考实现接入运行时

- `route()`/`scoreTask()` 迁入 `src/orchestration/policy.mjs`（随 preset
  发布，`src/routing/policy.js` 改为 shim）；Orchestrator 新增 advisory
  工具 `broker_route`（传子问题文本，返回建议角色与候选，与提示词内嵌
  路由表同源）。smoke 真实链探针验证。

### 其他

- 清理冗余：删除 `catalog.specialistById`（无引用）、smoke-mount 遗留的
  `const data = []`、orchestration-status 未使用的 fs 导入。
- `deriveTaskState`/`parseReceiptLine`/`receiptSucceeded` 为公开纯函数，
  供测试与 CLI 复用。

## v0.1.2（2026-08-16）— P1/P2：ArtifactStore 持久化、测试 receipt 去重、自定义角色、状态/指标 CLI

在机械编排运行时之上继续实施审计报告的 P1/P2 项。测试由 126 项增至
150 项，全部通过；validate 与 smoke 真实链探针保持全绿。

### P1：持久化 / 崩溃恢复 / 任务 replay（可选开启）

- 新增 **ArtifactStore**（`src/orchestration/artifacts.mjs`，随 preset 发布，
  仅 node 内置模块）：设置 `$DSH_ORCHESTRATION_HOME` 后，每次委派的结果
  全文与解析元数据落到 `<root>/artifacts/<session>/<taskId>/…`（含内容
  hash），会话状态（预算、结果、receipts、fingerprint）落到
  `<root>/state/<session>.json`。
- **崩溃恢复**：broker 首次访问某会话时自动从磁盘重载状态——进程重启后
  预算计数、连续失败硬停、完整结果历史原样恢复（`tests/broker.test.mjs`
  有跨实例重载测试）。
- **workspace fingerprint**：Fixer 每次运行记录 before/after 的 git 指纹
  （HEAD + porcelain 状态哈希，best-effort，失败为 null），为 keep-vs-revert
  决策提供机械证据。
- **测试 receipt**：从 Fixer 的 VERIFICATION / Observer 的 OBSERVED 机械提取
  `<command>: <result>` 行；`broker_status` 新增 `taskId` 参数，Fixer/Observer
  （过滤器新增只读 `broker_status`）可先查既有 receipt 再决定是否重跑相同
  命令（同一 pytest 套件不再跑两遍，prompt 纪律 + 机械记录双轨）。
- `broker_status` 新增 `includeArtifacts` 参数；报告基于 **root session** 键
  （`rootSessionKey` 沿 parentSession 上溯），子代理查询看到的是委派方的状态。

### P2：自定义角色 / 预算配置 / 状态与指标 CLI

- **自定义角色注册**（`src/config/roles.js`，构建期）：项目根放 `roles.json`
  （id/role/personaFile/description/permissions 子集），`npm run build:local`
  合并为额外 `subagent_<id>` 委派工具行（与内置同款隔离：own persona、
  toolFilter、maxDepth 1、one-shot），并支持 `model-routing.json` 为其配模型；
  dist 构建永不读取。校验严格：内置 id 冲突、非 snake id、未知权限键、
  错误类型均构建期报错。`assertAgentDefinition` 的 id 规则改按 TOOL_NAME
  （委派工具名才是宿主侧标识）。
- **预算环境配置**：`$DSH_ORCHESTRATION_BUDGETS`（JSON）覆盖
  每任务委派数 / 每 specialist 尝试数 / 连续失败上限，非法值忽略。
- **CLI**：`npm run status [sessionId] [--home]`（单会话状态：任务、结果、
  receipts、fingerprint、artifacts）与 `npm run metrics [--home]`（跨会话
  质量指标：各 specialist 结果分布与成功率、协议 block 率、receipt 总数）。
- 动态模型选择与 Web 运行面板确认为宿主能力边界，README 如实记录。

### 其他

- smoke-mount 的子代理过滤器校验改为对 standing scope 的 **visible** 面
  （`restrictableNames` 只含宿主全局工具，预设自身注册的工具只在 visible
  中——子代理继承的正是 visible 全集）；smokeMount 失败路径也保证释放
  harness fiber（此前失败会挂起测试 runner）。
- 预设模块允许 `node:` 内置导入（preset 目录无 node_modules 的限制不变）。

## v0.1.1（2026-08-15）— 机械编排运行时（OrchestrationBroker）：写锁、预算与信封门禁接入真实执行链

本轮依据审计报告（问题逐条核验见 `docs/audit-verification-and-modification.md`）实施，
把此前"纯 prompt 纪律 + 单写者守卫"升级为**真实工具链上的机械门禁**：
测试由 92 项增至 126 项，全部通过；validate 深度校验 17 个 DSH 包；
smoke 新增**真实链探针**（stub 工具影子化 `subagent_fixer` 驱动真实
`tools.execute()`），验证并发 Fixer 被拒、坏信封被 block、ask 审批期间写锁保持。

### P0：单写者守卫修复（workspace 粒度 + ask 审批洞）

- **锁键从 `exec.agent.id` 改为规范化 workspace**（会话 cwd，大小写折叠）：
  两个会话打开同一项目会互相串行，不同项目互不阻塞；无 cwd 时回退到
  caller id / "unknown" 桶。
- **修复 ask 审批洞**：原实现在收到 `ask` 时释放锁，而 DSH 审批通过后直接
  dispatch、**不会重跑 `tools/pre-execute`**（dsh-tools lib/index.js:3098-3130），
  导致审批后的 Fixer 无锁执行。现在锁在 ask/deny 期间**保持持有**，由
  execute-finally 或 post-execute 按 token 所有权释放；仅下游 pre-execute
  throw（绕过两者）在 catch 中释放。smoke 真实链探针 `askSerialized=true`
  验证该修复。

### P0：TASK_ID 协议 + 机械预算

- 新增 **TASK_ID 协议**：每次委派 prompt 首行必须声明 `TASK_ID: <id>`，
  缺失即被 `tools/pre-execute` 机械 DENY；envelope 必须原样回显该 id。
- 新增 **OrchestrationBroker**（`src/orchestration/broker.mjs`，进程本地、
  无 npm 依赖，随 preset 发布）：按 (session, taskId) 机械强制
  每任务 12 次委派上限、每 specialist 每任务 3 次尝试上限、3 次连续非
  SUCCESS 硬停；换新 TASK_ID 即重置。
- 新增只读 `broker_status` 工具（Orchestrator allow-list 内），可查每任务
  预算、尝试次数、连续失败数与最近结果。

### P0：envelope 结果门禁接入真实执行路径

- `parseEnvelope` 升级为 **v2 多行协议**（`src/orchestration/protocol.mjs`，
  单一事实源）：支持多行 CHANGES / VERIFICATION / SPECIFICATION / OBSERVED
  等段；TASK_ID 必填并校验格式；重复规范段报错；REASON 等扩展段收集到
  sections 不报错。
- 每次委派 dispatch 后，结果文本在 `tools/post-execute` 被机械解析校验：
  缺 STATUS / SUMMARY / TASK_ID、TASK_ID 不匹配、未知状态、SUCCESS 缺角色
  证据段（Fixer 的 CHANGES+VERIFICATION、Observer 的 OBSERVED、Designer 的
  SPECIFICATION）→ **block** 并附修正反馈；真实工具错误（provider 超时等）
  原样透传但计入失败尝试。

### P1：构建/安装/文档适配

- `agentOptions` 的 provider/model 改为 **JSON 双引号标量发射**：含 `: `、`#`、
  `[` 等 YAML 敏感字符的模型名不再能破坏组合结构（含回环解析测试）。
- `install.mjs --force` 从目录合并改为**整目录替换**：旧版本删除的文件不再残留。
- 六个 specialist 提示词与 Orchestrator 提示词全部更新：TASK_ID 回显要求、
  机械门禁说明、budget 章节改写为"机械强制 + 分配纪律"。
- README「限制与已知问题」如实更新：跨进程锁、artifact store、会话恢复身份
  边界、Explorer/Observer 只读 shell 等剩余限制均已记录。

## 2026-08-14 — 发布安全、路由正确性、权限与协议全面修复

本轮基于逐条核查确认的问题清单（含运行时复现与 GitHub Actions 实际运行记录）实施，
测试由 45 项增至 92 项，全部通过；构建产物可复现；validate 对 17 个 DSH 包做深度校验；
smoke 在真实 Harness 中挂载 preset 并验证权限边界。

### 发布安全线（最高优先级）

- **免构建 preset 不再混入本机模型配置**：新增 dist/local 构建分离。
  `npm run build`（dist，默认）**永不读取** `model-routing.json`，生成标准继承产物
  （子代理继承 Orchestrator 的 provider/model，与 README 承诺一致）；`npm run build:local`
  读取个人 `model-routing.json` 生成带 `agentOptions` 的本地产物。已提交的
  `preset/orchestrator/agent.cordis.yml` 重建为干净产物（0 个 agentOptions）。
- **CI 修复**：提交 `package-lock.json`，改用 `npm ci`；新增 `ubuntu-latest` ×
  `windows-latest` 矩阵。注：原计划 pin 的 `@deepseek-ai/*@0.0.1-rc.1/rc.3` 在 npm
  上依赖树残缺（`dsh-tasks`、`dsh-bash-env` 等从未发布），无法安装；改用自洽的
  **0.1.0-rc.6 全线**（对应 `@deepseek-ai/dsh@0.1.0-rc.6`）。
- **Windows 测试命令修复**：`node --test tests/` 在 Windows 报 MODULE_NOT_FOUND，
  改为跨平台的 `node --test`。
- **集成测试不再假跳过**：删除 4 处硬编码的 `C:\Users\admin\...` 路径，统一
  `DSH_CHECKOUT`（默认 `node_modules/@deepseek-ai`）；测试从"目录缺失即跳过/静默通过"
  改为**缺失即失败**。DSH 测试依赖显式安装并锁定版本，CI 中真实挂载验证集成。
- **可复现门槛**：CI 增加 `npm run build` + `git diff --exit-code`，保证提交产物
  与构建输出一致。
- **发布元数据**：`repository`/`bugs`/`homepage` 替换 YOUR-NAME 占位符；
  README 的 npm 安装方式标注"需先发布到 registry"。

### 路由正确性

- `scoreTask()` 现在携带 `priority` 参与排序（此前优先级完全失效）。
- **风险/不确定性门禁优先于目标明确度**：只要命中 安全/架构/迁移/并发/性能/权衡/根因
  等 Oracle 词汇，即使有明确文件路径与 Fixer 意图，也先路由 Oracle
  （如 "Implement a high-risk security architecture redesign in src/auth.js" → Oracle）。
- **中文触发词**：6 个角色各新增中文词汇表，CJK 按子串匹配（不再依赖英文词边界正则），
  路由表以中英双语渲染进 Orchestrator prompt。
- `hasExplicitTarget()` 收紧：URL（`example.com`）、版本号（`v1.2`）、
  "Fix it so that it works"、"bug in production" 等不再误判为文件目标。
- Orchestrator prompt 新增 ROUTING PRECEDENCE 章节，明确门禁优先级与中英同表规则。
- `renderDelegationPrompt()` 按角色生成约束：Fixer 收到"可修改文件"授权，其余角色
  保留"禁止修改"——消除冲突指令。

### 权限与协议

- **权限边界 fail-closed**：工具注册表不可用时 Orchestrator 插件同步抛错、
  拒绝创建根代理（DSH 契约：同步异常否决 agent 发布），不再仅告警后继续运行。
- **Designer 移除 shell**（与其 prompt "NO shell" 一致）；Explorer/Observer 保留
  shell 但 prompt 与 README 如实声明：DSH 权限层无法表达只读 shell，只读靠 prompt
  纪律——不再使用无条件的"只有 Fixer 能修改"表述（write/edit 工具确实仅 Fixer 拥有）。
- **能力声明与工具对齐**：Observer 截图声明改为"读取已有截图/图片"；Librarian 如实
  声明只有 web_search。注：曾尝试为 Librarian 开启 web_fetch，实测证实 DSH
  `tools.restrict()` 只能限制继承层工具、preset 行注册的工具无法授权给子代理，
  故保持关闭（证据见 README FAQ）。
- **信封协议机械校验**：新增 `parseEnvelope()` / `isKnownStatus()`——STATUS 严格限
  4 值枚举、SUMMARY 必填、可选节缺失产生 warning、重复字段报错、容忍额外内容。
  `fixer.md` 的非标准状态 "BLOCKED / NEED REASONING" 标准化为 `STATUS: BLOCKED` +
  `REASON:` 字段（全仓 0 残留）。

### 运行时机制

- **单写者守卫（机械层）**：Orchestrator 插件用 tools/pre-execute + tools/execute +
  tools/post-execute 实现 Fixer 委派串行化——并发第二次 Fixer 调用被拒绝；按调用方
  （根会话）分键，避免多会话互相误伤；覆盖异常/deny/ask/取消路径的锁释放。
- **Fixer 事务规则**：改前记录 `git status`、EVIDENCE 必须含完整 `git diff`、
  PARTIAL/BLOCKED 必须回滚或明确列出残留文件——不留下无记录的半完成状态。
- **工具结果裁剪预算**：8192/4096/1024 → 20000/12000/3000（DSH pruner 仅 3 键、
  无字段排除机制）；6 个 specialist 提示词新增简洁性规则（envelope 前置、
  证据用 file:line 引用）。
- **代码审查阶段**：高风险改动的 diff 在 Fixer/Observer 之后送 Oracle 做设计/安全
  审阅，才算完成。
- **预算与终止状态机**：每任务 ≤12 次委派、≤4 个并行信息代理、写任务串行、
  每 specialist ≤2 次重试、连续 3 次非 SUCCESS 即终止汇报、NOT_APPLICABLE 只换路由
  一次、provider 错误停止重试（prompt 层约束，本版本 DSH 无任务预算 API）。

### 兼容范围与已知限制（如实声明）

- 构建/测试锁定 **DSH 0.1.0-rc.6** 线（dsh-base、dsh-tool-subagent、
  dsh-compaction-tool-result-pruner 等）；rc 阶段上游接口变化风险高。
- 运行时调度由模型遵循 prompt（路由表 + 门禁规则烘焙进 Orchestrator prompt）；
  `route()`/`scoreTask()` 为 CI 验证的参考实现，preset 架构下无法做前置路由状态机。
- specialist 为 one-shot；continuable 未启用（follow-up `send_message` 延迟注册与
  Orchestrator allow-list 边界冲突，有源码级证据）。
- `parseEnvelope()`/`renderDelegationPrompt()` 是库级工具（有单元测试），
  非运行时钩子——运行时信封校验需要 DSH 宿主集成。
- 真实模型端到端调用 eval 需要在线 provider；CI 已覆盖挂载/权限/路由/协议的全部
  机械层。DSH 包内无 stub provider。

### 验证

- `npm test`：92 pass / 0 fail（含真实 Harness 挂载测试、15 项插件守卫测试、
  10+ 项信封协议测试、中英双语路由测试）
- `npm run build` 幂等（两次构建 SHA256 一致）；`build:local` 可正确生成
  agentOptions 并可切回 dist
- `npm run validate`：19 rows、6 specialists、17 个包深度校验通过
- `npm run smoke`：真实 Harness 挂载成功，边界生效
- 全仓 0 残留：`C:\Users\admin`、`YOUR-NAME`、`NEED REASONING`、本地 provider 名
