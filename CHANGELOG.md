# 更新说明 / CHANGELOG

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
