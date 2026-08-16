# oh_my_deepseek_harness 审计核验与修改文档

- 审计快照：`bernardleex526/oh_my_deepseek_harness@6a252cd`（main）
- 核验/修改环境：Windows 11 + Node 24.16，DSH `@deepseek-ai/dsh@0.1.0-rc.6`
  真实安装（`C:\Users\bernard\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）
- 修改后：测试 **175/175 通过**（原 92；P0 轮 126，P1/P2 轮 150，附录 B 轮 159，
  附录 C 轮 175），`validate` OK，`smoke` 真实链探针全绿（`docs/` 附录 A/B/C 记录各轮）

---

## 一、问题核验结论（先核验，后修改）

核验方式：逐文件阅读 + 对 DSH rc.6 真实源码（dsh-tools / dsh-tool-subagent /
dsh-subagent-* / dsh-agent-presets）逐行比对 + 运行时复现（YAML 注入、真实链
探针）。结论分为 **成立（已修）**、**成立但超出 preset 范围（记录）**、
**未复现/已过时** 三档。

| # | 审计声明 | 核验方法 | 结论 |
|---|---|---|---|
| 1 | P0：`route()`/`scoreTask()`/`parseEnvelope()`/`renderDelegationPrompt()` 只被测试调用，未接入运行时 | grep 全库引用；`orchestration.mjs` 仅做边界限制与 Fixer 锁 | **成立**。运行时只调用 `loader.js` 里的 `renderRoutingTable()`（渲染 prompt）。已修：解析器与委派模板接入真实执行链 |
| 2 | P0：锁按 `exec.agent.id` 分组，两会话同项目可并发写 | 读 `orchestration.mjs:84-86`（callerKey） | **成立**。已修：改为规范化 workspace（会话 cwd）键 |
| 3 | P0：ask 审批时释放锁，DSH 审批后直接 dispatch 不重跑 pre-execute | 读 dsh-tools `prepareExecution`（3098-3130）：`pre-execute` 只跑一次；`serviceAsk` allowed-once 直接进入 `dispatch` | **成立且是最严重的洞**。已修：锁在 ask/deny 期间保持，smoke 真实链探针验证 |
| 4 | P0：Explorer/Observer 有 shell，可绕过 Fixer 写锁 | `agent-permissions.js:116-133`：explorer `shell:true`、observer `shell:true+jobs` | **成立**。DSH 权限层无法表达"只读 shell"，属宿主限制；README/prompt 已如实记录，非本次可修 |
| 5 | P0：无真正调度器（并行=一条消息多个调用；第二个 Fixer 被拒而非排队） | `orchestrator.md:71-74`；pre-execute deny 逻辑 | **成立**。排队需要宿主级调度器（pre-execute 无法挂起等待），超出 preset 范围；已记录。可做的部分（串行正确性、预算、门禁）已做 |
| 6 | P0：无可靠完成门禁（预算/重试/验证全凭 prompt） | `orchestrator.md:176-182` 明言 PROMPT-ENFORCED | **成立**。已修：预算（12 委派/任务、3 尝试/specialist/任务、3 连续失败硬停）机械强制；envelope 结果机械校验 |
| 7 | P1：envelope 解析器只读同行字段，不支持多行 CHANGES/VERIFICATION、不识别 Observer/Designer 扩展字段 | `handoff.js:80` 单行正则；`fixer.md`（CHANGES/VERIFICATION 多行）、`observer.md`（OBSERVED/EXPECTED/DIFFERENCE）、`designer.md`（SPECIFICATION） | **成立**。已修：v2 多行解析 + 角色字段 + TASK_ID，接入 post-execute |
| 8 | P1：one-shot 子代理导致上下文/测试重复；大结果整体字符裁剪 | `build.mjs:82` backgroundMode one-shot；pruner 20000/12000/3000 无字段排除 | **成立**。one-shot 是架构决策（README 已披露）；artifact store 属 P1，超出本次范围，已记录 |
| 9 | P1：失败后无事务恢复（`git checkout --` 可能覆盖用户修改） | `fixer.md:145-165` TRANSACTION RULES | **成立**。真实回滚需要隔离 worktree/journal（P1），超出 preset 范围；已记录，prompt 策略保留 |
| 10 | 根代理身份靠持久化 parentSession，恢复/导入会话可能被当子代理 | `childSessionMeta`（dsh-subagent）持久化 `parentSession`；`orchestration.mjs:117` 据此跳过限制 | **成立**（边界情况）。rc.6 无"活根会话"信号，无法在不改宿主时区分；已记录 |
| 11 | `list_agents` 只列 continuable children，不是角色目录 | `dsh-tool-subagent-control/lib/types/list-agents.js:36-38` 明确过滤 one-shot | **成立**。属宿主语义；README 已说明 |
| 12 | README 关于 continuable/child filter 的说明与 rc.6 漂移 | 比对 `tools.restrict()`（dsh-tools 2772-2786：未知名字 restrict 时即抛错）与 README 349-355 | **未复现**。README 描述与 rc.6 行为一致（5c98797 已重写 README；审计可能基于旧版）。未改动该部分说明 |
| 13 | provider/model 直接插值 YAML，特殊字符可改结构 | 运行时复现：model 名含 `: ` → `yaml.load` 抛 "bad indentation" | **成立**（实证）。已修：JSON 双引号标量发射 + 回环解析测试 |
| 14 | `--force` 安装是目录合并覆盖，旧文件残留 | `install.mjs:45` `cpSync(recursive, force)` | **成立**。已修：force 时先整目录删除再复制 |
| 15 | 上游 RC 阶段，应按 tarball+integrity 建兼容矩阵 | `package.json` 已精确 pin rc.6；CI 双 OS 矩阵 | **部分成立**。版本已锁定；tarball 级矩阵超出本次范围，已记录 |
| 16 | mount 测试不跑真实模型回合，不能证明真实行为 | `smoke-mount.mjs:13` "No model request is made"；README 389-394 | **成立**。无法在不引入 stub LLM provider 时修复；已把**机械层真实链探针**（stub 工具 + 真实 `tools.execute()`）加入 smoke，把"可验证"的边界推到最大 |
| 17 | 测试计数 74/74 | 实测 | **已过时**。快照实际 92 项（90 过 + 2 需 DSH checkout）；本次后 126 项全过 |
| 18 | 推荐架构：TaskGraph + OrchestrationBroker + writer queue + 结果门禁 | 评估 | **部分实施**。见下节"范围决策" |

### 范围决策

审计推荐的完整 TaskGraph/调度器/跨进程锁需要宿主级能力（pre-execute 无法
挂起等待、进程本地状态、restrict 无法表达只读 shell）。在"不修改 DSH 宿主"
约束下，本次实施其 **P0 中可机械化的全部**：

- 任务状态：以 **TASK_ID 协议**做任务边界的机械近似（(session, taskId) 键控
  预算与结果存储），而非完整状态机；
- 写串行化：workspace 粒度锁 + ask 审批洞修复（含真实链验证）；
- 结果门禁：post-execute 机械校验 + block 反馈；
- 预算：pre-execute 机械 deny；
- 可观测：`broker_status` 只读工具。

未实施（如实记录）：跨进程锁、artifact store、隔离 worktree/journal 回滚、
完整状态机、动态模型选择、运行面板。

---

## 二、修改计划（实施前定稿）

1. **协议层**：新建 `src/orchestration/protocol.mjs`——envelope v2 多行解析、
   TASK_ID 提取/校验、`renderEnvelope`/`renderDelegationPrompt` 升级；`handoff.js`
   改为再导出 shim（单一事实源）。
2. **Broker 层**：新建 `src/orchestration/broker.mjs`——workspace 写锁（所有权
   token）、每 (session, taskId) 预算门禁、settle 记录与 envelope 门禁、报告；
   纯模块、无 npm 依赖（随 preset 发布）。
3. **运行时行**：重写 `src/orchestration/orchestration.mjs`——pre-execute 门禁
   （TASK_ID/预算/写锁，ask/deny 保持锁，throw 释放）、execute markDispatched +
   finally 释放、post-execute settle + block、注册 `broker_status`。
4. **构建/安装**：`build.mjs` 复制 broker/protocol 进 preset、agentOptions YAML
   安全发射；`install.mjs` force 整目录替换；`validate.mjs` 新增文件与导入约束校验。
5. **提示词**：7 个文件统一 TASK_ID 协议与机械门禁说明。
6. **测试**：更新 envelope/handoff/orchestration/delegation/mount；新增
   broker.test.mjs；model-routing 加 YAML 安全测试；smoke 加真实链探针。
7. **文档**：README/CHANGELOG/本文档。

---

## 三、实施内容（文件级）

### 新增

| 文件 | 内容 |
|---|---|
| `src/orchestration/protocol.mjs` | envelope v2：多行段、TASK_ID 必填+格式、角色证据段常量、`extractTaskId`、`renderEnvelope`/`renderDelegationPrompt`（首行 TASK_ID） |
| `src/orchestration/broker.mjs` | `createBroker()`：workspace 规范化/`callerWorkspace`/`sessionKey`、`gate`（TASK_ID→预算→写锁）、`markDispatched`、`releaseWriter`（所有权）、`settle`（记录+门禁+block 决策）、`report`/`snapshot`/`reset` |
| `tests/broker.test.mjs` | 21 项单元测试：写锁粒度与所有权、TASK_ID 门禁、三类预算、连续失败重置、settle 记录/透传/门禁、报告与 reset |
| `docs/audit-verification-and-modification.md` | 本文档 |
| `preset/orchestrator/broker.mjs`、`preset/orchestrator/protocol.mjs` | 构建产物（随 preset 发布） |

### 修改

| 文件 | 变更 |
|---|---|
| `src/orchestration/orchestration.mjs` | 重写：broker 驱动链 + ask/deny 保持锁 + `broker_status` 注册；`ORCHESTRATOR_ALLOW` 增 `broker_status`；导出 `broker` 供测试重置 |
| `src/routing/handoff.js` | 改为 `export * from "../orchestration/protocol.mjs"` |
| `src/permissions/agent-permissions.js` | `BROKER_STATUS_TOOL` 常量并入 `ORCHESTRATOR_ALLOW` |
| `src/index.js` | 补导出 broker/protocol |
| `scripts/build.mjs` | 复制 broker/protocol 进 preset；`agentOptions` 用 `JSON.stringify` 发射 provider/model（双引号标量） |
| `scripts/install.mjs` | `--force` 改为整目录替换（先 rm 再 cp） |
| `scripts/validate.mjs` | 校验新 preset 文件存在、`./broker.mjs`/`./protocol.mjs` 相对导入、无裸导入；`broker_status` 计入已注册工具 |
| `scripts/smoke-mount.mjs` | 新增 `realChainProbes()`：stub `subagent_fixer` 影子化 + 真实 `tools.execute()`，三探针（并发拒绝 / 信封 block / ask 锁保持）；探针在 dispose 前运行 |
| `prompts/orchestrator.md` | TASK_ID 纪律、机械门禁说明、BUDGET 章节改写、`broker_status` 边界、结果处理说明 |
| `prompts/fixer.md` | TASK_ID 回显（含 BLOCKED 模板）；SUCCESS 必须 CHANGES+VERIFICATION（机械强制说明） |
| `prompts/observer.md` | TASK_ID 回显；SUCCESS 必须 OBSERVED |
| `prompts/designer.md` | TASK_ID 回显；SUCCESS 必须 SPECIFICATION |
| `prompts/explorer.md`、`librarian.md`、`oracle.md` | TASK_ID 回显 |
| `preset/orchestrator/agent.cordis.yml`、`preset/orchestrator/orchestration.mjs` | 重新生成 |
| `tests/envelope.test.mjs` | v2 断言（TASK_ID 必填/格式、多行段、REASON 进 sections 不进 fields、extractTaskId 整行匹配） |
| `tests/handoff.test.mjs` | taskId 参数必填、首行声明、模板含 TASK_ID |
| `tests/orchestration.test.mjs` | fakeExec 带 prompt/cwd；ask/deny 保持锁（反转旧断言）；workspace 键隔离/回退；TASK_ID 门禁；beforeEach `broker.reset()` |
| `tests/delegation.test.mjs` | import-free 断言放宽为"仅同目录相对导入" |
| `tests/model-routing.test.mjs` | 引号发射断言 + YAML 特殊字符回环解析测试 |
| `tests/mount.test.mjs` | 断言 `broker_status` 可见 + 三个真实链探针结果 |
| `README.md` | 「限制与已知问题」重写为机械门禁现状 + 剩余限制如实记录；测试表/FAQ 更新 |
| `CHANGELOG.md` | 新增 2026-08-15 条目 |

---

## 四、验证结果

```
npm test        → 126/126 通过（原 92；新增 broker 21 项、真实链探针、YAML 安全等）
npm run build   → dist 产物含 orchestration.mjs / broker.mjs / protocol.mjs
npm run validate→ OK — 19 rows, 6 specialists, 17 packages deep-checked
npm run smoke   → OK — 15 tools（含 broker_status）
                  real-chain probes: gateDenied=true envelopeBlocked=true askSerialized=true
```

真实链探针含义（`scripts/smoke-mount.mjs`，stub 工具影子化 `subagent_fixer`，
经真实 `tools.execute()` 走完整 pre-execute/execute/post-execute 瀑布）：

- `gateDenied=true`：同一 workspace 第二个并发 Fixer 被机械 DENY（证明
   standing-scope 门禁在真实管线生效，而非仅单元测试）；
- `envelopeBlocked=true`：无 TASK_ID 的坏信封在 post-execute 被 block 并以
   错误返回（结果门禁真实生效）；
- `askSerialized=true`：pre-execute 返回 ask 后锁保持持有，审批期间第二个
   Fixer 被拒，审批通过 dispatch 完成后锁释放（ask 洞闭合的端到端证明）。

---

## 五、剩余限制（如实记录，见 README）

1. 跨进程全局锁（lockfile）未实现——broker 状态进程本地；
2. artifact store 未实现——大结果仍整体裁剪（20000/12000/3000）；
3. 事务回滚仍为 prompt 策略（`git checkout -- <files>` 规则），无 journal；
4. 无完整任务状态机（IMPLEMENTED→VERIFIED→REVIEWED→COMPLETE 由模型驱动）；
5. 根代理身份靠持久化 parentSession，恢复/导入子代理会话的边界情况未解决
   （宿主无"活根会话"信号）；
6. Explorer/Observer 的只读 shell 仍是 prompt 纪律（宿主权限层限制）；
7. CI 不跑真实模型回合（无 stub LLM provider）；
8. TASK_ID 是任务边界的机械近似，id 分配纪律仍需 prompt 约束。

---

# 附录 A：P1/P2 实施记录（2026-08-16）

## 本轮核验/决策

- **P1 全项评估**：ArtifactStore ✅ 实施；崩溃恢复/任务 replay ✅ 实施（会话
  状态落盘 + 惰性重载）；workspace fingerprint ✅ 实施（git best-effort）；
  测试 receipt ✅ 实施（机械提取 + `broker_status` 去重查询）；审查失败闭环
  ——仍为 prompt 流程（Oracle 复审步骤），本轮未加机械层；隔离 worktree /
  journal 回滚——需拦截子代理内部写操作（宿主权限模型不支持），记录为未实施。
- **P2 全项评估**：自定义角色注册 ✅ 实施（构建期 roles.json，宿主无运行时
  角色注册 API）；预算配置 ✅ 实施（`$DSH_ORCHESTRATION_BUDGETS`）；运行状态
  面板——以 CLI（status/metrics）+ `broker_status` 工具近似 ✅，Web 面板需
  宿主 client 插件，记录为未实施；动态模型选择——宿主在 spawn 时解析
  `agentOptions`，运行期切换无 API，记录为未实施（构建期静态路由可用）；
  token/pytest 时间预算——宿主无 token 计量 API，pytest 时间需 shell 观测，
  记录为未实施（receipt 机制已覆盖"不重复跑"的一半目标）。

## 文件级变更

| 文件 | 变更 |
|---|---|
| `src/orchestration/artifacts.mjs`（新） | ArtifactStore：`writeArtifact`/`writeSessionState`/`readSessionState`/`listArtifacts`/`listSessions`/`contentHash`；仅 `$DSH_ORCHESTRATION_HOME` 启用；CLI 用 `cliStoreRoot` |
| `src/orchestration/broker.mjs` | store 注入与落盘（settle 后写 artifact + 会话状态）、首访惰性重载（崩溃恢复）、`extractReceipts`（VERIFICATION/OBSERVED 的 `<command>: <result>`）、fixer before/after `gitFingerprint`、`rootSessionKey`（子代理查 root 状态）、`readBudgetsFromEnv`、report 的 taskId/includeArtifacts 参数 |
| `src/orchestration/orchestration.mjs` | broker 构造接入 env 预算与 store；`broker_status` 参数升级（taskId/includeArtifacts），execute 按 `rootSessionKey` 出报告 |
| `src/permissions/agent-permissions.js` | 新增 `broker` 权限标志 → Fixer/Observer 过滤器含 `broker_status`（其余角色不可见） |
| `src/config/roles.js`（新） | 自定义角色：`loadCustomRoles`/`customSpecialist`，严格校验（snake id、角色词表、权限键/类型、内置冲突） |
| `src/config/model-routing.js` | `loadModelRouting(root, extraIds)` 支持自定义角色路由 |
| `src/config/schema.js` | `assertAgentDefinition` 的 id 校验改按 TOOL_NAME（委派工具名是宿主侧标识） |
| `scripts/build.mjs` | 复制 `artifacts.mjs` 进 preset；本地模式合并 roles.json（persona 追加 CUSTOM SPECIALISTS 段、按项目根解析自定义 persona 文件）；模型路由传入自定义 id |
| `scripts/validate.mjs` | 校验 artifacts.mjs 存在与相对导入；裸导入规则放宽为"兄弟文件 + `node:` 内置" |
| `scripts/orchestration-status.mjs`（新） | P2 状态 CLI（会话列表 / 单会话详情，支持 `--home`） |
| `scripts/orchestration-metrics.mjs`（新） | P2 指标 CLI（跨会话质量聚合，支持 `--home`） |
| `scripts/smoke-mount.mjs` | 子代理过滤器校验改用 standing **visible** 面（restrictableNames 只含宿主全局工具）；smokeMount finally 保证释放 harness fiber |
| `prompts/fixer.md` | TEST RECEIPTS & DEDUPE 小节：先查 `broker_status` 再决定是否重跑相同命令 |
| `prompts/observer.md` | 同样的 dedupe 说明；OBSERVED 按 `<command>: <result>` 格式输出 |
| `prompts/orchestrator.md` | `broker_status` 参数说明（taskId/includeArtifacts） |
| `tests/artifacts.test.mjs`（新） | 存储 CRUD、启用语义、损坏降级、会话枚举 |
| `tests/roles.test.mjs`（新） | 角色加载/校验/冲突、dist 不读 local 合并、隔离配置一致 |
| `tests/broker.test.mjs` | +receipts、+fingerprint、+rootSessionKey、+预算 env、+持久化重载、+report 过滤/artifacts |
| `tests/permissions.test.mjs` | REGISTERED 含 broker_status；Fixer/Observer 可查 broker_status 断言 |
| `tests/delegation.test.mjs` | 导入规则断言放宽（允许 `node:` 前缀） |
| `package.json` | `status`/`metrics` scripts |
| README / CHANGELOG / 本文档 | 同步更新 |

## 验证

```
npm test        → 150/150 通过（原 126）
npm run build   → 产物含 artifacts.mjs；REPRO 可复现
npm run validate→ OK（19 rows，17 packages deep-checked）
npm run smoke   → 15 tools；gateDenied=true envelopeBlocked=true askSerialized=true
npm run status  → 会话列表/详情（含 receipts、fingerprint、artifacts）✅ 实测
npm run metrics → 质量聚合 ✅ 实测
build:local     → roles.json + model-routing.json 端到端合并 ✅ 实测（引号安全路由）
```

## 新增的剩余限制（本轮后）

- 动态模型选择、Web 运行面板、token/pytest 时间预算：宿主能力边界，未实施；
- 审查失败闭环与隔离 worktree/journal 回滚：仍需宿主级支持，未实施；
- 对话内 pruner 裁剪依旧（完整原文已由 ArtifactStore 保存，可回看）。

---

# 附录 B：完成门禁 + 审查闭环 + pytest 分层 + broker_route（2026-08-16）

## 本轮内容

针对"主代理管着子代理完成任务"目标的最后三块差距：

1. **完成门禁**：`deriveTaskState()` 按记录派生任务状态
   （PLANNED → RUNNING → IMPLEMENTED → VERIFIED → COMPLETE），
   `broker_status`/status CLI 显示；Orchestrator prompt 强制"状态非 COMPLETE
   不得宣布完成"。
2. **审查失败闭环**：最新 Oracle 复审 BLOCKED → 任务状态 BLOCKED →
   `tools/pre-execute` 门禁对该 TASK_ID 的全部后续委派机械 DENY
   （kind: review）。
3. **pytest 分层与减量**：
   - receipt 注解 schema `[risk=R0-R3,exit,counts,fail]`（`parseReceiptLine`）；
   - 同任务同命令同 fingerprint 的重复验证机械标记（`duplicate` 计数 +
     结果警告），fingerprint 缺失时保守不标记；
   - 报告式 receipt 预算（`maxReceiptsPerTask`，默认 12）；
   - R0-R3 风险分层、变更测试选择决策树、失败分类规则内嵌 Fixer prompt；
     Observer 改为"核对 receipt + 升层验证 + 抽样复核，不重跑相同命令"。
4. **broker_route**：policy 迁入 `src/orchestration/policy.mjs`（随 preset
   发布），`routing/policy.js` 变 shim；Orchestrator 新增 advisory 路由工具，
   与提示词内嵌路由表同源；smoke 真实链探针验证 `routeAdvice=explorer`。

## 文件级变更

| 文件 | 变更 |
|---|---|
| `src/orchestration/policy.mjs`（新，随 preset 发布） | policy.js 原样迁入（import-free），`routing/policy.js` 变 shim |
| `src/orchestration/broker.mjs` | `deriveTaskState`/`parseReceiptLine`/`receiptSucceeded`；任务级 receipts 累积 + workspaceFingerprint + duplicateReceipts（含持久化/重载）；重复验证检测；Oracle BLOCKED 门禁；receipt 预算；report/snapshot 扩展 |
| `src/orchestration/orchestration.mjs` | 注册 `broker_route` 工具；ORCHESTRATOR_ALLOW 增加 broker_route |
| `src/permissions/agent-permissions.js` | `BROKER_ROUTE_TOOL` 并入 ORCHESTRATOR_ALLOW |
| `scripts/build.mjs` / `validate.mjs` | 复制/校验 policy.mjs；broker_route 计入已注册工具 |
| `scripts/smoke-mount.mjs` | 新增 broker_route 真实链探针；清理遗留 `const data = []` |
| `scripts/orchestration-status.mjs` | 显示派生任务状态 + receipts/重复计数；清理未用 fs 导入 |
| `scripts/orchestration-metrics.mjs` | 任务状态分布、receipt 风险层统计、重复验证计数 |
| `prompts/fixer.md` | TEST VERIFICATION PROTOCOL（receipt 格式、R0-R3、变更选择、失败分类） |
| `prompts/observer.md` | 不重跑规则（核对 + 升层 + 抽样） |
| `prompts/orchestrator.md` | TASK STATES & COMPLETION GATE、broker_route 说明 |
| `src/agents/catalog.js` | 删除无引用的 `specialistById` |
| 测试 | broker +9（注解/重复/状态/审查阻断/预算）、mount 探针断言、delegation 导入断言 |

## 验证

```
npm test        → 159/159 通过（原 150）
npm run build   → 产物含 policy.mjs；REPRO 可复现
npm run validate→ OK
npm run smoke   → 16 tools；gateDenied/envelopeBlocked/askSerialized=true，routeAdvice=explorer
status/metrics  → 任务状态 [COMPLETE]/[BLOCKED]/[IMPLEMENTED]、重复验证计数、R1-R3 分层统计 实测 ✅
```

## 剩余边界（如实）

- 完成门禁是**观测 + prompt 纪律**（broker 显示状态、prompt 强制遵守），
  不是宿主级"完成即停"；真正的完成事件仍需模型声明。
- receipt 预算与重复标记是**记录/警告级**（broker 看不到子代理内部执行的
  每个命令，只能看到 VERIFICATION/OBSERVED 里报告的）。
- 风险分层与测试选择是 Fixer 的 prompt 规则 + receipt 记录，不是对子代理
  shell 的机械拦截（宿主权限层不支持）。

---

# 附录 C：融合 dsh-anchored-standard 的锚定首请求（2026-08-16，v0.1.4）

## 来源与本地方案

参考仓库 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)
实测：首请求 API 可见的工具 schema 决定会话首轮轨迹质量（Minimal 工具对
5/5 锚定 vs standard 系 11/11 落入 standard-like）。其机制为
bootstrap（首请求最小工具）→ 首个持久信号 → 晋升（resident 目录）。

融合实现（非搬运：未复制其代码，按其机制在 DSH rc.6 上原生实现）：

| 上游要素 | 本地实现 |
|---|---|
| 首请求最小工具 schema | `DEFAULT_BOOTSTRAP_ALLOW`（8 个控制平面工具：read/read_image/grep/glob/ask_user_question/todo_write/broker_status/broker_route）——Orchestrator 无 shell 设计，锚定面取控制平面而非 bash 对 |
| 晋升信号（either） | 第二个 `agent/pre-step` 即首请求完成后的下一模型请求；用 `tools.restrict()` 返回的 disposer 交换到完整 `ORCHESTRATOR_ALLOW` |
| 剥离自动注入（杠杆 3） | pre-step 消息过滤 `agent-instructions`/`skill-catalog` source.kind，晋升后恢复；失败降级保留全部 |
| resume/reload 不丢阶段 | 事件日志含 `tool/call` 或 `assistant/message` → 直接完整面（`shouldBootstrapAgent`） |
| 子代理行为 | one-shot 子代理恒不锚定（等同上游"子代理无条件晋升"） |
| 健壮性 | bootstrap restrict 失败降级完整面 + 告警；剥离失败降级保留 |

不做（文档化）：晋升后 resident 收窄（上游因 Standard 目录巨大而设；我们
完整面仅 16 工具）、compaction-epoch（我们无 compaction 收窄）、
`bootstrapMaxTokens`（上游明示 opt-in 且依赖 profile 包的 prepareCall 行为）、
技能目录剥离（本 preset 未挂载 skill 插件）。

## 文件

| 文件 | 变更 |
|---|---|
| `src/orchestration/bootstrap.mjs`（新，随 preset 发布） | `parseBootstrapEnv`/`sessionHasDurableSignal`/`shouldBootstrapAgent`/`stripSuppressedContext` + 默认集与剥离源常量 |
| `src/orchestration/orchestration.mjs` | agent/created 按配置走 bootstrap restrict（disposer 保存）+ `installBootstrapPhase`（pre-step 计数晋升 + 上下文剥离 + 降级） |
| `prompts/orchestrator.md` | BOOTSTRAP PHASE 说明 |
| `scripts/build.mjs` / `validate.mjs` | 复制/校验 bootstrap.mjs |
| `scripts/smoke-mount.mjs` | `SMOKE_BOOTSTRAP=1` 变体：真实链断言首请求恰为 8 工具 |
| `tests/bootstrap.test.mjs`（新） | 纯函数：env 解析/信号判定/剥离 |
| `tests/bootstrap-smoke.test.mjs`（新） | 跨进程 spawn smoke 变体 |
| `tests/orchestration.test.mjs` | +7 行为用例（锚定/晋升/剥离/恢复/子代理/降级/关闭） |
| README / CHANGELOG / 本文档 | 同步 |

## 验证

```
npm test        → 175/175 通过（原 159）
npm run smoke   → 16 tools，四探针全绿（bootstrap 关闭路径）
SMOKE_BOOTSTRAP=1 node scripts/smoke-mount.mjs
                → bootstrap OK — 8 tools on FIRST request，委派工具隐藏
npm run build/validate → OK（产物含 bootstrap.mjs，REPRO 可复现）
```

## 使用与边界

- 默认开启；`$DSH_ORCHESTRATION_BOOTSTRAP=0` 关闭；JSON 数组自定义。
- 首请求无法直接委派（会以文本/规划回复，下一请求自动解锁）——这是锚定的
  预期代价；首轮工具面变化一次，KV 前缀缓存在该点断开。
- 真实模型收益（首轮轨迹质量）依据上游在 DeepSeek V4 Pro 上的实测；本插件
  自身尚未在真实模型会话中复测该收益，安装后建议用小任务验证。
