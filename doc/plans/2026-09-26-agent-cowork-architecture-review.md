# Agent Cowork 架構審查與升級計畫

- 日期：2026-09-26
- 狀態：Proposed（等 Kimi 選定方向後才開工）
- 審查對象：`hyper-agent-cowork`（Paperclip 繁中發行版），基準 commit `22435f8`（即將發佈的 `v2026.925.0-zhtw.6`）
- 審查主題：AI Agent 隨時切換 AI 模型／轉接器（harness）、承接或調度任務、變更角色時，系統的可用性與工作穩定度
- 方法：靜態程式碼審查（server / packages / ui）、既有架構文件（`doc/architecture/`）、本次 zhtw.2–zhtw.6 修 bug 過程中的實測；**未做**負載測試與多 Agent 長時間實跑

> English abstract: this is a QA and architecture review of how Paperclip binds an agent to one harness, one model and one AI connection, what survives a switch, how tasks hand off between agents, and how runs recover from failure. It proposes an "Agent Cowork" layer (runtime profiles, routing policy, handoff packet) built on the existing issue/run model and the native Paperclip Runner, with a phased plan and a manual QA matrix.

## 0. 結論

1. **Paperclip 的核心假設是「一個 Agent = 一個 harness + 一個模型 + 一個 AI 連線」。** 切換模型是「改 Agent 設定」，不是「派工時的選擇」。改模型會在下一次執行時重置 CLI session；改 harness 會直接刪掉這個 Agent 全部的任務 session（`server/src/services/agents.ts:799-809`）。
2. **任務層級已經有「模型覆寫」，但只做了一半。** 任務頁的 Model lane（Primary／Override）可以覆寫模型與思考強度，但只支援 `claude_local`、`codex_local`、`opencode_local`，不能換 harness，覆寫值與 AI 連線是否相容只在執行時才檢查（`ui/src/lib/issue-assignee-overrides.ts`、`server/src/services/heartbeat.ts:21136-21139`）。
3. **沒有 per-run 模型選擇、沒有 fallback、沒有多組 runtime profile。** 上游在 v2026.916.0 刻意移除「cheap model profiles」，理由是只留一條模型選擇路徑（`releases/v2026.916.0.md`）。任何「多模型」設計都必須在這個前提上加層，而不是把舊機制加回來。
4. **任務交接靠 issue 本身，不靠 session。** 交接載體是 issue 的描述、留言、`plan` 文件、work products、執行工作區；新 assignee 拿不到前一位的 CLI 對話 session。這是正確的設計（session 綁 harness），但目前沒有「交接包」把上下文整理給下一位。
5. **穩定度的基礎工程其實不差。** 執行鎖（atomic checkout）、durable continuation、stranded-issue reconciliation、native status arbitration、預算硬停都已存在（`doc/architecture/`）。真正的弱點是「切換」這件事沒有被當成一級事件：切換後的 session／skills／連線／覆寫沒有一致的失效與驗證流程。
6. **建議方向：不重做執行核心，在 issue／run 層加三個新概念。** Runtime Profile（Agent 可掛多組執行設定）、Routing Policy（任務→profile 的選擇與 fallback 規則）、Handoff Packet（交接時自動整理的結構化上下文）。優先以 `paperclip_runner`（native runner，已於 self-hosted 預設開啟，且每次 run 都持久化 provider）作為多模型執行的基礎。分三階段推進，詳見第 6 節。

## 1. 現況架構地圖

```
Company
 ├─ Agent（persona：name / role / title / reportsTo / permissions / budget）
 │    └─ Runtime（adapterType + adapterConfig{model, effort, env, cwd, instructions, skills}
 │                + runtimeConfig{aiConnection, heartbeat}）   ← 一對一，切換 = 修改
 ├─ Issue（單一 assigneeAgentId；checkoutRunId / executionRunId 執行鎖；
 │         assigneeAdapterOverrides{adapterConfig}；plan 文件；留言；work products；
 │         executionWorkspaceId；originRunId；conversation*）
 ├─ Heartbeat run（runtimeMode legacy|native；runnerProfileJson；sessionIdBefore/After；
 │                 usageJson；resultJson；retryOfRunId；scheduledRetry*；livenessState）
 ├─ agent_task_sessions（company, agent, adapterType, taskKey 唯一）← session 綁 harness
 ├─ cost_events（provider / biller / model / tokens / costCents / heartbeatRunId / issueId）
 └─ Governance（approvals、budget_policies、execution blockers、routines、review policy）
```

三條執行路徑：

| 路徑 | 說明 | 模型／provider 決定點 |
|---|---|---|
| Direct adapter（legacy） | server 直接 spawn CLI（claude / codex / opencode / pi / grok / gemini / kimi / cursor / hermes） | Agent `adapterConfig.model`，可被 issue 覆寫 |
| Paperclip Runner（native） | `paperclip_runner` 轉接器 → Rust `runnerd` → qualified provider（Codex / OpenCode / ACPX-Claude / Claude Managed / AWS AgentCore） | 每次 run 持久化 `runnerProfileJson`；禁止靜默 fallback（`doc/architecture/paperclip-runner-compatibility.md`） |
| Gateway / chat（hermes_gateway、openclaw_gateway、chat connectors） | 外部對話橋接 | 由外部系統決定 |

`enableNativeRunner` 在 self-hosted 預設為 `true`（`server/src/services/instance-settings.ts:227,272`），Docker 映像也內建 Rust 工具鏈編譯 runner（`Dockerfile:54-72`），所以 VPS 上可以直接用。

## 2. 轉接器能力矩陣（切換前必看）

| 轉接器 | Session 續接 | Skills 落點 | Instructions 交付 | AI 連線（Connections） | 模型清單 | 任務層模型覆寫 |
|---|---|---|---|---|---|---|
| `claude_local` | `--resume` | prompt bundle（`--add-dir`） | `--append-system-prompt-file` | Anthropic 訂閱／API key | 動態探索＋refresh | ✅ |
| `codex_local` | `resume <id>` | `CODEX_HOME/skills` | 前置於 prompt | OpenAI 訂閱／API key | 動態探索＋refresh | ✅ |
| `opencode_local` | `--session` | `~/.claude/skills` | 前置於 prompt | 只有 OpenRouter API key（模型必須 `openrouter/`）；本發行版另加 OpenCode API key 模式 | 動態探索（Zen／Go 偵測為本發行版新增） | ✅ |
| `pi_local` | `--session <file>` | `~/.pi/agent/skills`＋`--skill` | `--append-system-prompt` | 無（只吃 provider API key） | 動態探索（本發行版補 placeholder 列舉） | ❌ |
| `grok_local` | `--resume`（未納入 session-management registry，無 compaction） | `<cwd>/.claude/skills`＋`Agents.md` | `Agents.md`／`--rules` | xAI 訂閱／API key | 靜態清單 | ❌ |
| `gemini_local` | `--resume` | `~/.gemini/skills` | 是 | 無 | 靜態清單 | ❌ |
| `kimi_local` | `-r` | `~/.kimi-code/skills` | 是 | 無 | 靜態清單 | ❌ |
| `cursor` | `--resume` | `~/.cursor/skills` | 是 | 無 | 動態探索 | ❌ |
| `hermes_local` | `--resume`（canonical id） | `~/.hermes/skills` | 是 | 無 | 自動偵測 | ❌ |
| `paperclip_runner` | native session | Codex skills 路徑 | 是 | 依 provider | 合併清單 | ❌（provider 每 run 持久化） |
| `cursor_cloud`／gateways／process／http | 無或 codec | 無 | 否 | 無 | 無 | ❌ |

來源：`server/src/adapters/registry.ts:254-840`、`packages/adapter-utils/src/session-compaction.ts:51-97`、`packages/shared/src/ai-connections.ts:71-160`、`packages/shared/src/environment-support.ts:67-87`。

重點：**每個 harness 的 skills 落點、instructions 交付方式、session 續接方式都不同**，所以「切換 harness」本質上是「換一台機器」，不是「換一顆腦」。這是後面所有設計的約束。

## 3. QA 發現

嚴重度定義：**P0** 會造成錯誤結果、資料外洩或權限失守；**P1** 會讓工作中斷、需要人工介入；**P2** 體驗與可維護性問題。每一條都附程式位置，方便之後開 issue。

### 3.1 切換 AI 模型／轉接器（harness）

| ID | 嚴重度 | 發現 | 證據 | 影響 | 建議 |
|---|---|---|---|---|---|
| SW-1 | P1 | 切換 harness 會刪除該 Agent **所有**任務 session，並清空 runtime session；`paperclip_runner` 只要改 provider／acpxAgent／model 也一樣 | `server/src/services/agents.ts:799-809` | 進行中的多輪任務全部從零開始；沒有提醒使用者 | 切換前顯示「將重置 N 個任務的對話」並要求確認；把 session 重置寫成活動紀錄 |
| SW-2 | P1 | 同一 harness 改模型不會立刻清 session，但下一次執行時因設定指紋不同而重置（指紋含 adapter、adapterConfig、instructions、issueOverrides、workspace、environment、secrets、runtimeSkills） | `heartbeat.ts:5754-5781, 6770-6787, 6825-6898, 21354-21371` | 使用者以為「只是換模型」，實際上等於開新對話；模型間無法沿用上下文 | 這是正確行為，但要在 UI 明講；長期靠 Handoff Packet 補上下文（第 5 節） |
| SW-3 | P1 | 執行中切換 harness 會直接中止正在啟動的 run | `heartbeat.ts:20106-20111` | 任務停在 in_progress，等 30 秒的 stranded reconciliation 才會補跑 | 切換時若有 running run，先擋下並提示「等待完成或先取消」 |
| SW-4 | P1 | 任務層模型覆寫（Model lane）只支援 `claude_local`／`codex_local`／`opencode_local`；Pi、Grok、Gemini、Kimi、Cursor 都不能在任務層換模型 | `ui/src/lib/issue-assignee-overrides.ts:1-9`；`IssueProperties.tsx:720-845` | 想要「這個任務用便宜模型」只能改 Agent 全域設定 | 把白名單改成「凡是有模型清單的 harness 都支援」，並加入各 harness 的 effort 鍵對應 |
| SW-5 | P1 | 任務層覆寫與 AI 連線的相容性只在執行時檢查；存覆寫時不檢查；Agent 改 harness 後舊覆寫也不會重新驗證 | 執行時：`ai-connection-runtime.ts:222-231` → `ai-connections.ts:224-235`；存檔時：`routes/issues.ts` 無檢查 | 任務排程後才報「Select an AI connection compatible…」，Agent 卡住 | 儲存覆寫時做 preflight（同一支 `isAiConnectionCompatible`）；Agent 切 harness 時掃描其待辦任務的覆寫並標記失效 |
| SW-6 | P0（已修） | 切換到不支援 AI 連線的 harness 時，舊的 `runtimeConfig.aiConnection` 被帶過去，存檔就 422 | 修正於 `routes/agents.ts:5428-5443`（commit `22435f8`，zhtw.6） | Grok→Pi 無法切換 | 已修；保留回歸測試 |
| SW-7 | P2 | 切換 harness 後 `defaultEnvironmentId` 若與新 harness 的 driver 不相容會 422，不會自動清空。複查：這是上游刻意的行為（有測試保護，訊息也清楚），不是 bug | `routes/agents.ts:5456-5466`；`agent-permissions-routes.test.ts`「rejects switching an agent away from an SSH-capable runtime…」 | 只影響有用 SSH／sandbox 環境的部署 | 留在 backlog：UI 在切換 harness 時自動把不相容的環境選項清掉並提示 |
| SW-8 | P2 | 切換 harness 不會清掉前一個 harness 的 skills 目錄（`~/.claude/skills`、`~/.pi/agent/skills`…）與受管憑證 home（`codex-home`、`grok-home`） | 各 adapter `skills.ts`；`codex-home.ts:129-139`、`grok-home.ts:94-104` | 磁碟殘留、舊 skill 版本被舊 harness 誤用 | 加「清理前一 harness 落點」的 best-effort 步驟，寫進活動紀錄 |
| SW-9 | P2 | 沒有 per-run 模型參數：`wakeAgentSchema` 無 model 欄位，Routine 也沒有模型／harness 欄位 | `packages/shared/src/validators/agent.ts:220-241`；`packages/db/src/schema/routines.ts:26-55` | 定時任務無法指定便宜模型 | 納入 Routing Policy（第 5 節） |
| SW-10 | P2 | 沒有任何 fallback：provider 失敗只會重試同一模型（Codex 的 transient fallback 只換 session／呼叫方式，不換模型） | `codex-local/src/server/execute.ts:279-304`；`heartbeat.ts:15241-15245` | 模型限流或停機時整個 Agent 停擺 | 納入 Routing Policy 的 fallback 規則，但要遵守上游「不得靜默 fallback」原則：必須寫入 run 紀錄與留言 |
| SW-11 | P2 | `grok_local` 有 `--resume` 但沒納入 session-management registry，沒有 session compaction | `session-compaction.ts:51-97` | Grok 長任務 context 會爆 | 補進 registry |

### 3.2 任務繼承與交接（A → B）

| ID | 嚴重度 | 發現 | 證據 | 影響 | 建議 |
|---|---|---|---|---|---|
| HO-1 | P1 | **沒有結構化交接包。** B 收到 `issue_assigned` 喚醒（帶 PATCH 留言 id、被中斷的 `interruptedRunId`），prompt 內有描述、`plan` 文件、最多 8 則／12k 字的喚醒留言、完整留言歷史與 `completedWork` 摘要；但 A 在 `reassign_task` 填的 `reason` 只存成留言與活動紀錄，不會渲染成 prompt 的交接段落；work products／artifacts 也不在 prompt 內，B 要自己呼叫 `GET /issues/:id/work-products` | `routes/issues.ts:14559-14599`；`heartbeat.ts:5590-5623, 20586-20853`；`execution-continuation.ts:108-416`；`packages/adapter-utils/src/server-utils.ts:2452-2473`；`native-runtime/paperclip-runner-tool-authority.ts:1091-1115`；`heartbeat.ts:8530-8706` | 換模型或換人後，新執行者要自己從留言堆裡重建脈絡；便宜模型常常做不到 | Handoff Packet（第 5.4 節） |
| HO-2 | P1 | 連續性摘要是固定模板、不用 LLM：從描述抓 Objective／Acceptance Criteria、用 regex 抓檔案路徑、猜下一步；每次 run 後重建 | `heartbeat.ts:13909-13948`；`issue-continuation-summary.ts:136-209` | 跨模型交接時摘要品質不足 | Handoff Packet v1 先做確定性版本，v2 再用 economy profile 做 LLM 摘要（有成本上限） |
| HO-3 | P2 | 重新指派會取消舊 owner 的執行中 run（`errorCode: issue_reassigned`）、清掉執行鎖、作廢排隊中的 run；B 一定開新 session 且必須留言 | `routes/issues.ts:13402-13431`；`services/issues.ts:10834-10844`；`modules/run-dispatch/domain/policy.ts:573-585` | 行為正確，但 UI 沒有說「交接會中斷 A 正在做的事」 | 指派變更時顯示確認與影響 |
| HO-4 | P2 | 工作區綁 issue（首次使用後 `reuse_existing`），B 沿用同一 worktree；但沒有人描述 A 留下的工作區狀態（未提交檔案、分支） | `heartbeat.ts:21735-21763, 5882-5916` | B 可能覆蓋或誤解半成品 | Handoff Packet 內含 `git status` 摘要 |
| HO-5 | P2 | 子任務繼承父任務工作區；委派任務只有在 `originRunId` 存在且來源 plan 已被接受時，才會繼承 plan 指引 | `services/issues.ts:9896-9926`；`native-runtime/handoff-plan-context.ts` | 大部分委派拿不到 plan 脈絡 | 交接包一律附上最近一版 plan |
| HO-6 | P2 | 改動別人 `in_progress` 任務需要 `tasks:manage_active_checkouts`（CEO／主管鏈／明確授權）；一般 Agent 在 standard trust 下都能派工 | `routes/issues.ts:5337-5361`；`services/authorization.ts:2144-2173, 2264-2285` | 權限模型合理，但沒寫在使用者文件 | 補進 zh-TW 文件 |

### 3.3 調度彈性

| ID | 嚴重度 | 發現 | 證據 | 影響 | 建議 |
|---|---|---|---|---|---|
| DS-1 | **P1** | 沒有容量感知的派工：可派工判斷只看生命週期與組織鏈，不看負載；沒有公司或 instance 層的併發上限，只有每個 Agent 的 `maxConcurrentRuns`（預設 20，範圍 1–50） | `services/agent-assignability.ts:104-171`；`packages/shared/src/constants.ts:77`；`heartbeat.ts:647-649, 19707-19846` | 在 KVM 2（2 vCPU／8 GB）上，幾個 Agent 同時開多個 CLI 進程就會把 VPS 拖垮 | instance 級併發上限（VPS 預設 2–3），並在 Agent 設定顯示建議值 |
| DS-2 | P2 | 事件喚醒種類完整（assigned／commented／mentioned／blockers resolved／children completed／review／approval）；定時 heartbeat 預設關閉；`wakeOnDemand` 可關 | `heartbeat.ts:1233-1248, 16552-16581, 26505` | 正常 | 保留 |
| DS-3 | P2 | Routine 只有一個 `assigneeAgentId`，沒有模型或 harness 欄位；手動觸發可覆寫 assignee | `packages/db/src/schema/routines.ts:23-142`；`validators/routine.ts:171-183` | 定時任務不能指定便宜模型 | Routing Policy 可掛在 routine |
| DS-4 | P2 | 自動「換人」只發生在卡住工作的復原：順序是 assignee → 其主管鏈 → 建立者主管鏈 → root → 任一可跑 Agent（依 id 排序）；沒有依技能、模型或成本挑人 | `services/recovery/issue-graph-liveness.ts:368-429` | 「調度」其實是人工的 | 先做容量上限（DS-1），再考慮技能標籤配對；不建議一開始做 LLM 派工 |
| DS-5 | P2 | 團隊套件不宣告 adapter／model；CTO 的 role 是 `engineering-manager`，不在 `AGENT_ROLES`，匯入不驗證 | `packages/teams-catalog/.../cto/AGENTS.md:1-10`；`company-portability.ts:3240, 5596` | 角色套件（RL-2）必須容忍未知 role | 匯入時把未知 role 對應到 `general` 並提示 |

### 3.4 角色、權限與組織

| ID | 嚴重度 | 發現 | 證據 | 影響 | 建議 |
|---|---|---|---|---|---|
| RL-1 | **P0** | Agent 可能可以把自己升為 CEO：`role` 只在「patch 只含 name/role/title/capabilities」時走同意閘；只要多帶一個非 profile 欄位（例如 `icon`），就走一般更新路徑，而一般路徑允許 Agent 改自己的設定 | `routes/agents.ts:5468-5476`；`services/change-consent-gate.ts:7`；`services/authorization.ts:2206-2217`；patch handler 內沒有其他 role 檢查 | 升為 CEO 後可改所有 Agent 權限、匯出／匯入公司、審批加入申請（`routes/agents.ts:5002-5026`、`routes/companies.ts:361-375`） | **立即修**：只要 patch 觸及 profile 欄位就套用同意閘（把 `profileOnlyChange` 改為 `touchesProfileFields`），並加回歸測試。此為程式碼路徑確認，尚未以整合測試實跑 |
| RL-2 | P1 | 除了 `ceo`，其他角色只是標籤：不影響權限、instructions、skills；改角色不會重新計算任何東西（降級的 CEO 保留 grants，升級的 Agent 拿不到 CEO instructions bundle 與核心 skills） | `services/authorization.ts:173-179, 2256, 2268`；`services/default-agent-instructions.ts:3-27`；`routes/agents.ts:2683-2735, 2934-2948`；`services/built-in-agents.ts:818-851` | 「角色」在 UI 看起來很重要，實際上大多沒作用；本發行版新增的角色編輯只改了標籤 | 定義「角色套件」：每個角色對應 instructions 模板、預設 skills、預設 grants；改角色時提供「重新套用角色套件」動作（不自動覆蓋使用者改過的內容） |
| RL-3 | P1 | 預設權限忽略角色：非低信任的 Agent 預設可建立 Agent、可建立 skills、都拿到 `tasks:assign` | `services/agent-permissions.ts:42-49`；`routes/agents.ts:1716-1730, 4791, 4968` | 一般工程 Agent 也能雇人、派工 | 依角色給預設值（CEO／PM 可派工與雇人；其他預設不行），並在雇用精靈顯示 |
| RL-4 | P2 | `canCreateSkills` 只記錄與顯示，伺服器不強制 | `routes/agents.ts:5041` | UI 上的開關是假的 | 在 company-skills 路由強制，或把 UI 開關改成說明文字 |
| RL-5 | P2 | 沒有「唯一 CEO」或「唯一 root」的約束；任何沒有主管的 Agent 都是 root | `services/agents.ts:1326-1347` | 「no active CEO」錯誤來自這裡：加入申請必須有 CEO 才能核准 | 公司層級設定 `primaryAgentId`（預設 CEO），讓核准與升級鏈有明確落點 |
| RL-6 | P2 | 卡住的工作依 assignee 主管鏈 → 建立者主管鏈 → root → 任何可跑的 Agent 升級；被終止的主管會停掉整棵子樹 | `services/recovery/issue-graph-liveness.ts:336-429`；`services/agent-invokability.ts:67-116` | 組織圖是有實際作用的，但使用者不知道 | 在組織圖 UI 註明「主管被終止會停掉整組」，終止前警告 |

### 3.5 執行穩定度與失敗處理

| ID | 嚴重度 | 發現 | 證據 | 影響 | 建議 |
|---|---|---|---|---|---|
| RB-1 | P1 | 執行中修改 Agent 設定沒有鎖也沒有提示；legacy run 用開始時的快照；run 結束後會把**舊快照**的 `adapterType`／`sessionId` 寫回 `agent_runtime_state`，並可能在舊 harness 名下重建任務 session | `routes/agents.ts:5286-5512`；`heartbeat.ts:20090, 19669-19683, 25195-25221` | 切換後殘留舊 session，下一次執行可能拿到錯的續接參數（程式碼路徑確認，未實跑） | 寫回前比對 `agent.updatedAt`／設定修訂 id，不一致就丟棄舊 session |
| RB-2 | **P1** | 預算是事後結算：run 結束才寫 `cost_events`，單一 run 可能超支；**Codex 永遠回報 `costUsd: null`**，用 API key 跑 Codex 的花費對預算完全不可見；訂閱記 0；沒有價目表 | `heartbeat.ts:19685-19704, 5164-5235`；`codex-local/src/server/execute.ts:1406, 1535`；`budgets.ts:718-864` | 預算硬停對 Codex API key、OpenCode Go、Pi 等幾乎無效 | 加價目表（每模型每百萬 token 單價，可由使用者維護）；沒有回報成本時用 token × 單價估算並標記 `estimated` |
| RB-3 | P1 | Gemini、Pi 的 429／限流沒有分類，落成一般失敗，不會設 quota monitor；Claude／Codex 有完整分類（auth_required、model_not_found、provider_quota、transient） | `gemini-local parse.ts:267-290` vs `execute.ts:744-752`；`pi-local/src/server/execute.ts`（無分類）；`claude-local parse.ts:13-30` | 用 OpenCode Go／Pi 時限流會被當成程式錯誤，Agent 進入 `error` | 在 adapter-utils 做共用的 429／quota 分類器 |
| RB-4 | P2 | 重試：transient／quota 各 2 次、間隔 30 秒、無 jitter；用盡後 issue 設 monitor（provider 給的 reset time 或 1 小時）；復原 owner 是 system，不進 attention；`failed_run` 只在重試用盡後出現；Agent 在 `error` 狀態仍可被喚醒 | `heartbeat.ts:788-798, 1063-1120, 25081-25085`；`recovery/service.ts:519-679`；`attention-exhausted-runs.ts:14-50` | 可接受，但使用者不知道「為什麼 1 小時後才動」 | 在任務頁顯示 monitor 到期時間與原因 |
| RB-5 | P2 | 本機執行預設**沒有 timeout**（sandbox 4 小時）；silent-run watchdog（1h／4h）只會開評估 issue，不會殺 run | `adapter-utils/src/execution-target.ts:378, 570-599`；`recovery/service.ts:156-158` | 便宜模型陷入迴圈時會一直跑、一直燒 token | VPS 預設 `timeoutSec`（建議 5400 秒）並在 UI 標示 |
| RB-6 | 撤回 | 執行投影的 `maxAttempts: 3` 是「總嘗試次數」（1 次初跑＋2 次重試），與 `attempt = 重試次數 + 1` 的算法一致；複查後不是問題 | `execution-projection.ts:176`；`execution-projection.test.ts:163` | 無 | 不處理 |
| RB-7 | P2 | 測試缺口：(a) 預算硬停真的取消 live run 沒有端對端測試；(b) 沒有「執行中改設定／切 harness」的測試；(c) timeout → `timed_out` + Agent `error` 沒有測試（fixture 用 `adapter_timed_out`，程式發 `timeout`）；(d) Gemini／Pi 限流無測試；(e) Codex 無價成本無測試 | `budgets-service.test.ts:122, 417, 538`；`heartbeat-process-recovery.test.ts:9102` | 這正是「切換」相關的風險區 | 每個 Phase 0 修補都附回歸測試 |
| RB-8 | ✅ 優點 | 重啟恢復完整：native recovery 有 controller generation 與 20 分鐘 lease；legacy run 60 秒 lease 每 10 秒續；graceful shutdown 標 `interrupted` 並排程重試；孤兒 run 每 5 分鐘清 | `native-restart-recovery.ts:449-612`；`legacy-controller-lease.ts:6-8, 67-111`；`heartbeat.ts:14972-15183`；`index.ts:1441-1507, 1760-1764` | VPS 升級／重啟不會遺失任務 | 保留；升級 SOP 已寫在 `doc/zh-TW/VPS-DEPLOY.md` |

### 3.6 成本與預算

| ID | 嚴重度 | 發現 | 證據 | 影響 | 建議 |
|---|---|---|---|---|---|
| CO-1 | P2 | 每次 run 都會寫 `cost_events`（provider／biller／model／tokens／costCents），`/costs/by-agent-model` 可以比較模型；但沒有結果品質或成功率欄位 | `heartbeat.ts:19685-19704`；`routes/costs.ts:201-218` | 可以知道「哪個模型花多少」，不知道「哪個模型做得好」 | 在 run 結果加 outcome 標籤（done / needs_review / failed / retried），成本頁加「每成功任務成本」 |
| CO-2 | P2 | 訂閱制執行成本記 0；模型若沒回報則記 `unknown` | `heartbeat.ts:24719-24770` | 成本比較失真 | 訂閱制以「配額視窗用量」（quota windows，Codex 已有 `getQuotaWindows`）取代金額 |
| CO-3 | P2 | 預算硬停（`budget_override_required`）與 `runtimeConfig.heartbeat.maxDailyCostCents` 都有，但沒有「切到便宜模型」的中間動作 | `services/budgets.ts:380-393`；`heartbeat.ts:16552-16582` | 只有「停」或「不停」 | Routing Policy 加 budget-aware 規則（超過 X% 改走 economy profile，並留言告知） |

## 4. 風險矩陣（對 Kimi 目前的使用情境）

| 風險 | 機率 | 影響 | 對應發現 | 先做什麼 |
|---|---|---|---|---|
| Agent 自我升級成 CEO、改別人權限或匯出公司資料 | 中（需要 Agent 被 prompt injection 或自行決定） | 高 | RL-1 | Phase 0 立即修 |
| VPS 被併發 CLI 進程拖垮，所有 Agent 一起變慢或被 OOM | 高 | 高 | DS-1、RB-5 | Phase 0：instance 併發上限＋預設 timeout |
| 用 API key 的 Codex／OpenCode Go／Pi 花費不受預算控制 | 高 | 中（每月 200 USD 紅線） | RB-2 | Phase 0：估算價目表；短期先在各 provider 後台設硬上限 |
| 切換模型後任務「失憶」，重做或做錯 | 高 | 中 | SW-1、SW-2、HO-1、HO-2 | Phase 1–3：切換確認＋Handoff Packet |
| 切換 harness 後殘留舊 session／skills，行為怪異 | 中 | 中 | RB-1、SW-8 | Phase 0／1 |
| 限流被當成錯誤，Agent 卡在 error | 中 | 中 | RB-3 | Phase 0 |
| 任務層覆寫存了不相容模型，排程後才失敗 | 中 | 低 | SW-5 | Phase 0 |

## 5. 目標架構：Agent Cowork

### 5.1 設計原則

1. **Agent 是「人」，Runtime 是「工具」。** Agent 保留身分、角色、組織、權限、預算、記憶（`$AGENT_HOME`）；執行設定（harness、模型、AI 連線、環境）抽成可多組掛載的 Runtime Profile。
2. **每次 run 只用一個 profile，且持久化。** 沿用上游原則：一條模型選擇路徑、每 run 記錄實際 runtime、禁止靜默 fallback（`doc/architecture/paperclip-runner-compatibility.md`）。fallback 可以有，但必須留言、寫 run 紀錄、可回溯。
3. **切換是一級事件。** 有 preflight 驗證、有影響說明、有活動紀錄、有回滾（設定修訂已存在）。
4. **交接靠 issue，不靠 session。** session 永遠不跨 harness；跨模型／跨人的脈絡由 Handoff Packet 承載，並存成 issue 文件讓人也看得到。
5. **成本與品質要能回溯到 profile。** 否則「換模型有沒有比較好」永遠只能靠感覺。
6. **只做 additive 變更並放在 feature flag 後面。** 本發行版要持續合併上游，新表、新欄位、新路由都用新增，不改上游語意；以 `enableAgentCowork` instance 設定開關。

### 5.2 Runtime Profile

```
agent_runtime_profiles
  id, company_id, agent_id, name, tier(primary|economy|fallback|specialist),
  adapter_type, adapter_config(jsonb), ai_connection(jsonb), default_environment_id,
  enabled, sort_order, created_at, updated_at
```

- 遷移：把現有 `agents.adapterType / adapterConfig / runtimeConfig.aiConnection` 複製成每個 Agent 的 `primary` profile；舊欄位保留並持續等於 primary（雙寫），上游程式碼不用改。
- 驗證：每個 profile 走現有的 adapter 設定驗證、`isAiConnectionCompatible`、環境 driver 檢查、`testEnvironment`；不合格的 profile 只能存成 `enabled=false`。
- session 命名空間：`agent_task_sessions` 現在以 `(company, agent, adapterType, taskKey)` 為鍵，加上 `profile_id`；同一 harness 的兩個 profile（例如 Codex gpt-6-sol 與 Codex gpt-5.6-terra）也各自保存 session，切回來時可以續接。
- Skills、instructions、`$AGENT_HOME` 記憶維持 per-agent，不分 profile（它們本來就是 harness 無關的鍵）。

### 5.3 Routing Policy

宣告式規則，不用 LLM 決定；由公司預設 → Agent → Issue（擴充現有 Model lane）→ Routine 逐層覆蓋。每次 run 把選擇結果寫進 `heartbeat_runs.runnerProfileJson.routing = { profileId, ruleId, reason }`。

| 規則 | 範例 | 備註 |
|---|---|---|
| `explicit` | 這個 issue 用 `economy` | 現有 Model lane 升級版；所有有模型清單的 harness 都支援（修 SW-4） |
| `byWorkMode` | `planning` → economy；`standard` → primary | 便宜模型做規劃與整理，貴模型做實作 |
| `byPriority` | `urgent` → primary | |
| `onBudgetPercent` | 花費 ≥ 80% → economy，≥ 100% → 停（現有硬停） | 修 CO-3 |
| `onProviderFailure` | quota／transient 重試用盡 → fallback profile，冷卻 30 分鐘 | 必須留言＋活動紀錄；`paperclip_runner` 只允許 fallback 到同樣合格的 provider |
| `perRun` | `POST /agents/:id/wake { profileId }` | 授權同 assignee override |

不做的事：不做 Hermes 式的關鍵字複雜度分類；不在 server 內做跨 provider 的通用路由器（與 `doc/plans/2026-04-06-smart-model-routing.md` 的結論一致）。

### 5.4 Handoff Packet

觸發：重新指派、release、Agent 主動呼叫 `handoff`、Routing 因失敗換 profile。

```
handoff (issue document, append-only revisions)
  from: {agentId, profileId, runId}   to: {agentId|null, profileId|null}
  reason: 文字（reassign_task 的 reason、fallback 規則 id…）
  objective / acceptance: 從描述與 plan 抽出，標記已完成／未完成
  progress: completedWork 摘要（現有 continuation summary）
  workspace: branch、最後 commit、未提交檔案數、是否有衝突
  workProducts: [{id, title, kind, url}]（修 HO-1）
  openQuestions / risks / nextSteps
```

- v1 完全確定性（從既有資料組裝，零 LLM 成本）；渲染成 prompt 的「Handoff」段落，並存成 issue 文件 `handoff` 讓人看得到。
- v2 可選：用 economy profile 產生 200 字內的自然語言摘要，每次上限例如 0.02 USD，失敗就退回 v1。

### 5.5 切換 Preflight（Agent 設定與 Issue 覆寫共用）

1. 模型存在於該 harness 的清單；AI 連線相容；環境 driver 相容；必要 secret 存在；CLI 已安裝（`testEnvironment`）。
2. 顯示影響：「將重置 N 個任務的對話」「目前有 1 個執行中的 run」；執行中預設擋下，提供「取消並切換」。
3. 切換後：best-effort 清理前一 harness 的 skills 落點；寫 `agent.runtime_switched` 活動紀錄（before／after、原因）；run 結束寫回 runtime state 前比對設定修訂 id（修 RB-1）。

### 5.6 角色套件（Role Package）

- 每個 role 對應：instructions 模板、預設 skills、預設 grants（例如只有 `ceo`／`pm` 預設可派工與雇人）。
- 改角色時提供「重新套用角色套件」動作（預設不自動覆蓋使用者改過的內容）；Agent 自己發起的 role 變更一律走同意閘（修 RL-1、RL-2、RL-3）。
- 公司層級 `primaryAgentId`（預設 CEO）：加入申請核准、升級鏈、預設 reportsTo 都指向它（修 RL-5）。

### 5.7 成本與品質歸因

- `cost_events` 加 `profile_id`；run 結果加 `outcome`（done／needs_review／failed／retried／handed_off）。
- 成本頁新增「依 profile」與「每完成任務成本」；訂閱制顯示配額視窗用量而不是 0 元。
- 沒有回報成本的 provider 用 token × 價目表估算並標記 `estimated`（修 RB-2）。
- 之後若要做「一個 run 用兩個模型」（cheap preflight），沿用 2026-04-06 計畫的 `executionSegments` 契約；本計畫不包含。

### 5.8 與上游的關係

- 所有 schema 變更 additive；舊欄位雙寫；新功能在 `enableAgentCowork` 後面，關閉時行為與上游一致。
- 每個 Phase 都先 rebase 上游最新 release 再開工，避免在 29k 行的 `heartbeat.ts` 上累積衝突。
- 適合回饋上游的部分：RL-1 安全修正、RB-3 限流分類、SW-4 覆寫白名單、RB-6 顯示不一致。

## 5.9 Phase 0 出貨狀態（2026-09-26 更新）

`zhtw.7` 已實作的 Phase 0 項目：

| 發現 | 做法 | 驗證 |
|---|---|---|
| RL-1 | patch 只要觸及 `name`／`role`／`title`／`capabilities` 就套用同意閘；其餘欄位仍走一般更新授權 | `agent-permissions-routes.test.ts`「agent self-updates that touch profile fields」 |
| SW-3 | 有 queued／running／scheduled_retry 的 run 時，切換 harness 回 409 `agent_runs_active`；帶 `?cancelActiveRuns=true` 才取消（errorCode `agent_adapter_switched`）後切換；設定頁會先詢問 | 同上「harness switches while runs are active」 |
| SW-5 | 任務建立與更新時，覆寫模型會用 `isAiConnectionCompatible` 對 assignee 的 AI 連線做 preflight，不相容回 422 `ai_connection_incompatible` | `issue-comment-reopen-routes.test.ts`「task-level model overrides…」 |
| DS-1 | `PAPERCLIP_MAX_CONCURRENT_RUNS`：整台 instance 的同時執行上限，於佇列放行時與每代理人上限取小 | `instance-run-cap.test.ts` |
| RB-5 | `PAPERCLIP_LOCAL_ADAPTER_TIMEOUT_SEC`：本機／SSH 執行未設 `timeoutSec` 時的預設逾時 | `execution-target-sandbox.test.ts`「applies the instance default timeout…」 |
| RB-3 | adapter-utils 新增共用的 `classifyProviderFailureText`；Pi、OpenCode、Gemini 失敗時回報 `errorFamily`（`transient_upstream`／`provider_quota`）與 `retryNotBefore` | `provider-failure-classification.test.ts` |
| RB-1 | run 結束時若代理人的 harness 已變更，不再把舊 harness 的 session／adapterType 寫回 runtime state，也不重建任務 session | 靠既有 `heartbeat-process-recovery.test.ts` 回歸；尚無專屬測試 |

未納入 Phase 0：SW-7（上游刻意行為）、RB-6（撤回）。

### 5.10 Phase 1 出貨狀態（2026-09-26 更新）

Kimi 核准後於 `zhtw.8` 實作 Runtime Profiles，設計與里程碑見 `doc/plans/2026-09-26-runtime-profiles-phase1.md`。同時核准 Phase 2 的 fallback 允許跨 provider（每次都必須留言與記錄）。

## 6. 升級路線圖

工時是「一位開發者＋AI 輔助」的粗估，含測試與文件；不含等待上游合併。雲端成本：全部階段都不需要新的 SaaS 或 VPS 升級；唯一可能的新支出是 Handoff v2 的 LLM 摘要（可關、可設上限）。

| 階段 | 內容 | 對應發現 | 粗估 | 發行 |
|---|---|---|---|---|
| **Phase 0：止血** | RL-1 同意閘修正＋回歸測試；SW-3 執行中擋切換；SW-5 覆寫存檔 preflight；SW-7 環境不相容自動清空；DS-1 instance 併發上限（VPS 預設 2）；RB-5 本機預設 timeout；RB-3 共用 429 分類器（Gemini／Pi／OpenCode）；RB-6 顯示修正；RB-1 寫回比對 | P0／P1 | 1–2 週 | zhtw.7 |
| **Phase 1：Runtime Profiles** | 新表與遷移（雙寫）；Agent 設定頁「執行設定」分頁可建多組 profile；切換 preflight 與活動紀錄；session 加 profile 命名空間；SW-8 清理 | SW-1、SW-2、SW-8、RB-1 | 3–4 週 | zhtw.8 |
| **Phase 2：Routing Policy** | 公司／Agent／Issue／Routine 四層規則；`onBudgetPercent`、`onProviderFailure`（含留言與冷卻）；per-run `profileId`；Model lane 支援所有 harness；run 紀錄 routing 結果 | SW-4、SW-9、SW-10、DS-3、CO-3 | 3–4 週 | zhtw.9 |
| **Phase 3：Handoff Packet＋角色套件** | Handoff v1 文件與 prompt 段落；work products 進 prompt；角色套件與重新套用；`primaryAgentId`；成本頁依 profile 與 outcome | HO-1～HO-5、RL-2、RL-3、RL-5、CO-1、CO-2 | 3–4 週 | zhtw.10 |
| **Phase 4（選配）** | Handoff v2 LLM 摘要；容量感知派工（依負載與技能標籤）；`executionSegments` 多模型單 run；價目表 UI | DS-4、RB-2 | 視需求 | — |

每個階段的完成定義：`pnpm -r typecheck`、`pnpm test:run`、`pnpm build` 通過；zh-TW 文件更新；VPS 上跑過第 7 節對應的 QA 項目；可用 `enableAgentCowork=false` 回到上游行為。

## 7. 手動 QA 矩陣（VPS，zhtw.6 之後執行）

「目前預期」是依程式碼推論的結果，實際跑完請把結果回填到這張表；標 ⚠ 的是已知會失敗或不理想的項目。

| ID | 情境 | 步驟 | 目前預期 | 對應 |
|---|---|---|---|---|
| Q1 | 切 harness（有 AI 連線） | Nami：Grok → Pi，OpenCode API key，模型 `opencode-go/qwen3.8-flash`，測試連線 | zhtw.6 起可存檔、可連線；zhtw.5 會 422 | SW-6 |
| Q2 | 同 harness 換模型（任務進行中） | Codex Agent 在多輪任務中把 gpt-6-sol 改成 gpt-5.6-terra，再留言喚醒 | 下一次 run 開新 session，沒有提示 ⚠ | SW-2 |
| Q3 | 執行中切 harness | 任務 running 時把 Agent 從 Codex 改成 OpenCode | 該 run 被中止，30 秒內 `issue_continuation_needed` 補跑 ⚠（無提示） | SW-3 |
| Q4 | 任務層覆寫不相容 | OpenCode Agent 綁 OpenRouter 連線，任務 Model lane 覆寫成非 `openrouter/` 模型 | 存檔成功，執行時失敗「Select an AI connection compatible…」⚠ | SW-5 |
| Q5 | 重新指派進行中任務 | A 執行中，把 assignee 改成 B | A 的 run 取消（`issue_reassigned`），B 開新 session 並留言；B 的 prompt 有留言歷史但沒有 work products ⚠ | HO-1、HO-3 |
| Q6 | 改角色 | Dahye 從一般改成 CEO，再核准一筆加入申請 | 核准成功；Dahye 不會拿到 CEO instructions 與核心 skills ⚠ | RL-2、RL-5 |
| Q7 | Agent 自我升級（安全） | 用一個測試 Agent 的 API key `PATCH /api/agents/<自己>`，body `{ "role": "ceo", "icon": "x" }` | 目前預期 200（漏洞）⚠；Phase 0 後應 403 | RL-1 |
| Q8 | 預算硬停 | Claude API key Agent 設月預算 1 USD 跑任務；Codex API key Agent 同樣設定 | Claude：run 結束後暫停＋`budget_override_required`；Codex：永遠不會停 ⚠ | RB-2 |
| Q9 | 限流 | Pi＋OpenCode Go 連打到 429 | 一般失敗、Agent 進 `error`，不會設 quota monitor ⚠ | RB-3 |
| Q10 | 併發 | 3 個 Agent 各指派 5 個任務同時喚醒 | 最多 15 個 CLI 進程同時跑，觀察 `docker stats` 記憶體 ⚠ | DS-1 |
| Q11 | 容器重啟 | 任務 running 時 `docker compose restart` | run 標 `interrupted` 並排程重試，任務不遺失 | RB-8 |
| Q12 | Pi 無 key 的模型 | Pi Agent 選 `openai/gpt-6-sol` 且沒有 `OPENAI_API_KEY` | 任務被標 `configuration_incomplete` 並 blocked，有通知 | RB-4 |
| Q13 | 切 harness 後殘留 | Q3 之後查 `agent_runtime_state.adapter_type` 與 `agent_task_sessions` | 可能殘留舊 harness 的 session ⚠（未實跑） | RB-1 |

## 8. 需要 Kimi 決定的事

1. **是否先出 Phase 0（zhtw.7）？** 建議：是，而且 RL-1 要在下一版就修。
2. **Fallback 是否允許跨 provider？**（例如 Codex 限流 → OpenCode Go 的 gpt-6-luna）建議允許，但必須留言、寫紀錄、有冷卻時間；`paperclip_runner` 例外。
3. **Handoff v2 的 LLM 摘要要不要開？** 建議先不開，v1 確定性版本跑一個月再說。
4. **Profile 數量上限與 UI 位置。** 建議每 Agent 最多 4 組（primary／economy／fallback／specialist），放在 Agent 設定頁的「執行設定」分頁。
5. **是否維持可回饋上游的形態？** 建議是：additive schema、feature flag、每階段先 rebase。

## 9. 參考

- `doc/architecture/paperclip-runner.md`、`paperclip-runner-compatibility.md`、`durable-continuation-scheduler.md`、`native-status-arbitration.md`
- `doc/plans/2026-04-06-smart-model-routing.md`（cheap preflight 與 `executionSegments` 契約）
- `doc/plans/2026-09-25-opencode-zen-go-detection.md`
- `releases/v2026.916.0.md`（cheap model profiles 移除、native runner 預設開啟）
- `doc/zh-TW/VPS-DEPLOY.md`、`doc/zh-TW/OPENCODE-PLANS.md`
