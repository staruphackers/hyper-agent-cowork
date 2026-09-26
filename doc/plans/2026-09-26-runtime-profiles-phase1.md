# Phase 1：Runtime Profiles（一個 Agent 掛多組執行設定）

- 日期：2026-09-26
- 狀態：Implemented in `zhtw.8`（M1–M4 完成；2026-09-26）
- 前置：`doc/plans/2026-09-26-agent-cowork-architecture-review.md` 第 5.2 節與第 6 節
- 發行目標：`v2026.925.0-zhtw.8`

> English abstract: an agent gains named runtime profiles (harness + model + AI connection + default environment). The agent row stays the source of truth for the active runtime, so upstream code paths are untouched; a profile is a durable snapshot that can be re-applied through the existing agent PATCH validation. Task sessions are namespaced by the active profile so switching back resumes the previous conversation. Everything is additive and hidden behind an instance flag.

## 1. 目標與非目標

目標：

1. 一個 Agent 可以保存多組「執行設定」（profile）：harness、模型與思考強度、AI 連線綁定、預設環境。
2. 一鍵切換 profile，切換走既有的 Agent 更新驗證（模型清單、連線相容、環境 driver、執行中 run 的 409 保護、設定修訂）。
3. 每個 profile 有自己的任務 session 命名空間，切回來可以續接舊對話。
4. 全部 additive：關閉 `enableRuntimeProfiles` 後行為與上游一致。

非目標（留給 Phase 2／3）：

- 任務或 Routine 層自動選 profile（Routing Policy）。
- 失敗時自動 fallback（Kimi 已決定允許跨 provider，Phase 2 實作，必須留言與記錄）。
- 公司匯出／匯入包含 profiles。
- 在 profile 編輯器裡直接改模型：v1 只能「用現在的設定存成 profile」，要改就先啟用再從一般設定頁改，改動會同步寫回啟用中的 profile。

## 2. 資料模型（全部 additive）

```
agent_runtime_profiles
  id uuid pk
  company_id uuid → companies
  agent_id uuid → agents (on delete cascade)
  name text                         -- 每個 agent 內唯一
  tier text default 'primary'       -- primary | economy | fallback | specialist
  adapter_type text
  adapter_config jsonb default {}   -- 與 agents.adapter_config 同格式（含 secret_ref）
  runtime_config jsonb default {}   -- 只使用 aiConnection
  default_environment_id uuid null → environments (on delete set null)
  enabled boolean default true
  sort_order integer default 0
  last_activated_at timestamptz null
  created_at / updated_at
  unique (agent_id, name)

agents.active_runtime_profile_id uuid null → agent_runtime_profiles (on delete set null)

agent_task_sessions.runtime_profile_key text not null default ''
  unique index 改為 (company_id, agent_id, adapter_type, runtime_profile_key, task_key)
```

不變量：

- `agents.adapterType / adapterConfig / runtimeConfig.aiConnection / defaultEnvironmentId` 永遠是「啟用中的執行設定」；上游所有讀取路徑不用改。
- 若 `active_runtime_profile_id` 有值，該 profile 的四個欄位與 agent 一致。由 `agentService.update` 在同一個交易內鏡射維持。
- `runtime_profile_key` 為啟用中的 profile id；沒有 profile 的 Agent 用空字串，等於上游行為。

## 3. 行為

| 動作 | 做法 |
|---|---|
| 建立 profile | `POST /agents/:id/runtime-profiles { name, tier, source: "current" }`：把 Agent 目前的四個欄位快照成 profile。若 Agent 尚無啟用中的 profile，這個 profile 直接成為啟用中，並把現有 `runtime_profile_key=''` 的 session 改掛到它名下，舊對話不會遺失 |
| 啟用 profile | `POST /agents/:id/runtime-profiles/:profileId/activate[?cancelActiveRuns=true]`：組出 patch（四個欄位＋`activeRuntimeProfileId`），交給既有的 `PATCH /agents/:id` 處理函式；因此 SW-3 的 409、模型／連線／環境驗證、同意閘、設定修訂全部沿用。服務層在 `activeRuntimeProfileId` 改變時**不刪**任務 session，只重置 legacy 的 `agent_runtime_state.sessionId`，並寫 `last_activated_at` |
| 編輯啟用中的設定 | 走原本的設定頁；服務層把改動鏡射到啟用中的 profile |
| 改名／分級／停用 | `PATCH /agents/:id/runtime-profiles/:profileId { name?, tier?, enabled?, sortOrder? }` |
| 刪除 | `DELETE …/:profileId`；啟用中的不可刪（409） |
| 切換前預檢 | `POST …/:profileId/preflight` 回傳執行中 run 數、目標 profile 名下可續接的 session 數、目前 profile 的 session 數；UI 用這些數字組確認文字 |
| Session 命名空間 | heartbeat 的 `getTaskSession / upsertTaskSession / clearTaskSessions / listTaskSessions / resetRuntimeSession` 與 native runner 的 goal 查詢都帶 `runtimeProfileKey = agent.activeRuntimeProfileId ?? ""` |
| 就地改 harness（非切換 profile） | 只刪目前 key 的 session（無 profile 時 key 為空字串，等於上游「全刪」） |

授權：讀取同 `agent_config:read`，寫入同 `agent_config:update`（Agent 可管理自己的 profile，與今天可以 PATCH 自己的 harness 一致）。回應中的 `adapterConfig.env` 一律用與 Agent 相同的遮罩。

活動紀錄：`agent.runtime_profile_created / updated / deleted / activated`。

Feature flag：實例設定 `experimental.enableRuntimeProfiles`（self-hosted 預設開）。它只控制 UI 顯示；API 永遠可用，與上游「UI 隱藏不是安全邊界」一致。

## 4. 里程碑

| 里程碑 | 內容 | 驗證 |
|---|---|---|
| M1 資料層＋API | schema、migration、shared 型別與驗證、服務、路由、OpenAPI、活動紀錄 | 路由測試（mock）、服務測試（embedded Postgres，以 postgres 系統帳號執行） |
| M2 Session 命名空間 | heartbeat 與 native runner 帶 profile key；`agentService.update` 的鏡射與保留 session | 既有 heartbeat 資料庫測試＋新增案例 |
| M3 UI | 設定頁「執行設定」上方的 Runtime profiles 面板：存成 profile、啟用（含預檢確認）、改名、刪除；flag 關閉時隱藏 | 元件測試、i18n 檢查、token gates |
| M4 文件與發行 | zh-TW 指南、README、審查報告狀態；typecheck、測試；`zhtw.8` | 同 Phase 0 的驗證流程 |

## 4.1 實作對照

| 里程碑 | 落點 |
|---|---|
| M1 | `packages/db/src/schema/agent_runtime_profiles.ts`、migration `0284_round_landau.sql`、`packages/shared` 型別／驗證／feature catalog、`server/src/services/agent-runtime-profiles.ts`、`server/src/routes/agents.ts`（六條路由＋`patchAgentHandler` 共用）、OpenAPI；測試：`agent-permissions-routes.test.ts`「runtime profile routes」、`agent-runtime-profiles-service.test.ts`（embedded Postgres）、`agent-runtime-profiles.test.ts` |
| M2 | `heartbeat.ts` 的 `getTaskSession / upsertTaskSession / clearTaskSessions / resetRuntimeSession` 帶 `runtimeProfileKey`；`agents.ts` 的 `update` 鏡射與保留 session；`native-codex-runner.ts` goal 查詢；RB-1 守衛也偵測 profile 切換 |
| M3 | `ui/src/components/agents/RuntimeProfilesPanel.tsx`（掛在代理人「執行環境」分頁最上方）、`agentsApi.*RuntimeProfile*`、實例實驗功能開關、zh-TW 字串；測試：`RuntimeProfilesPanel.test.tsx` |
| M4 | `doc/zh-TW/VPS-DEPLOY.md` 6.2 節、README、本文件 |

## 5. 風險與對策

| 風險 | 對策 |
|---|---|
| `heartbeat.ts` 是 29k 行的檔案，改 session 鍵值容易漏 | 只改五個入口函式與 native runner 一處查詢；用 grep 確認 `agentTaskSessions` 的每個使用點 |
| 兩個 profile 用同一 harness 但不同模型，舊 session 的設定指紋不同 | 指紋本來就含 `adapterConfig`，切回相同設定就會通過；不同模型自然不續接，這是正確行為 |
| 使用者在 profile 啟用中改了設定，忘了那會覆蓋 profile | UI 明確標示「下方的修改會存到啟用中的 profile：<名稱>」 |
| Agent 自己呼叫 activate 換到更貴的模型 | 授權沿用 `agent_config:update`；成本控制留在 Phase 2 的 Routing Policy 與預算規則 |
| 與上游合併衝突 | 新表、新欄位、新路由檔；`agents.ts` 與 `heartbeat.ts` 的改動集中且小 |
