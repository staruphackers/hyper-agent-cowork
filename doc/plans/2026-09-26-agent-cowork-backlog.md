# Agent Cowork 開發待辦（2026-09-26 起）

- 狀態：Active backlog（每個里程碑出貨後更新）
- 上游文件：`doc/plans/2026-09-26-agent-cowork-architecture-review.md`（審查與路線圖）、`doc/plans/2026-09-26-runtime-profiles-phase1.md`（Phase 1，已出貨於 `zhtw.8`）
- 已定案：Phase 2 的 fallback 允許跨 provider，但每次都要留言與記錄。

> English abstract: the ordered backlog after Phase 1. Section A is the operator checklist for shipping zhtw.8; B is Phase 2 (routing policy and fallback); C is Phase 3 (handoff packet and role packages); D holds small items that can be interleaved; E lists the decisions still needed before Phase 2 starts.

## A. 現在就做（Kimi 的操作待辦）

| # | 事項 | 備註 |
|---|---|---|
| A1 | 發佈 `v2026.925.0-zhtw.8`（GitHub Release，Target `main`，Create new tag on publish） | 等 Actions 綠燈約 10–15 分鐘 |
| A2 | VPS 升級：備份 volume → 改 tag → `pull && up -d` → health | 本版有資料庫遷移（新表 `agent_runtime_profiles`、`agents.active_runtime_profile_id`、`agent_task_sessions` 唯一索引重建），啟動時自動執行；升級前一定要備份 |
| A3 | 驗收 Runtime Profiles | 五步：存 `primary` → 再存 `economy` 並啟用 → 改成 OpenCode Go 便宜模型儲存 → 切回 `primary`，確認舊任務續接 → 有執行中 run 時切換要確認 → 刪除 `economy` |
| A4 | 回填審查報告第 7 節的 QA 矩陣結果 | 特別是 Q2、Q3、Q5、Q8 |

## B. Phase 2：Routing Policy 與 Fallback（下一個開發里程碑，3–4 週）

| # | 任務 | 內容 | 驗收 |
|---|---|---|---|
| B1 | 規則模型與儲存 | company／agent／issue／routine 四層 `routingPolicy`（jsonb，additive）；規則型別 `explicit`、`byWorkMode`、`byPriority`、`onBudgetPercent`、`onProviderFailure`；shared 驗證器；先做 agent 層與 issue 層的 UI | 驗證器測試；規則能存能讀 |
| B2 | 每次 run 選 profile | heartbeat 建立 run 時解析規則 → 選 profile → 產生 run 專用 runtime（不改 agent 列）；結果寫進 `heartbeat_runs.runnerProfileJson.routing = { profileId, ruleId, reason }` | 資料庫測試：同一 agent 兩個任務依規則跑不同模型 |
| B3 | Fallback | `provider_quota`／`transient_upstream` 重試用盡 → 下一個 `fallback` profile；每次都在任務留言、寫 run 紀錄；冷卻 30 分鐘、每任務最多 2 次；`paperclip_runner` 只允許 fallback 到合格 provider | 資料庫測試：模擬限流 → fallback → 留言存在 |
| B4 | Model lane 擴充 | 任務層模型覆寫支援所有有模型清單的 harness（SW-4）；Routine 加 `runtimeProfileId` 欄位 | UI 測試 |
| B5 | 成本歸因 | `cost_events.runtime_profile_id`（additive）；成本頁「依 profile」與「每完成任務成本」 | 成本查詢測試 |
| B6 | 文件與發行 | zh-TW 指南新增「自動路由與 fallback」；`zhtw.9` | 同 Phase 1 驗證流程 |

Phase 2 的技術前提（已在 Phase 1 準備好）：profile 有 `tier`，activation 的組裝函式 `composeActivationAdapterConfig` 可重用來產生 run 專用 runtime；session 命名空間已依 profile 分開。

## C. Phase 3：Handoff Packet 與角色套件（3–4 週）

| # | 任務 | 內容 |
|---|---|---|
| C1 | Handoff 文件 | 重新指派、release、fallback 換 profile 時自動產生 issue 文件 `handoff`：來源 run 摘要、plan 版本、驗收條件完成／未完成、工作區 git 狀態、work products 清單、交接原因；v1 完全確定性、零 LLM 成本 |
| C2 | Prompt 注入 | 新執行者的 prompt 加「Handoff」段落；work products 清單進 prompt（修 HO-1） |
| C3 | 角色套件 | role → instructions 模板、預設 skills、預設 grants；改角色時提供「重新套用角色套件」；公司層 `primaryAgentId`（修 RL-2、RL-3、RL-5） |
| C4 | 品質歸因 | run 結果加 `outcome`（done／needs_review／failed／retried／handed_off），成本頁顯示每完成任務成本（修 CO-1） |

## D. 小型 backlog（可穿插在里程碑之間）

| # | 事項 | 來源 |
|---|---|---|
| D1 | 切換 harness 時 UI 自動清掉不相容的環境選項並提示 | SW-7 |
| D2 | Profile 編輯器：直接在 profile 裡改模型與連線，不必先啟用 | Phase 1 非目標 |
| D3 | `grok_local` 納入 session-management registry（compaction） | SW-11 |
| D4 | 價目表估算：Codex API key 等未回報成本的 provider 以 token × 單價估算並標記 `estimated` | RB-2 |
| D5 | 調查 `native-session-resumption.test.ts` 三個在本開發容器既有失敗的測試（改動前就失敗） | 驗證流程 |
| D6 | 公司匯出／匯入包含 runtime profiles | Phase 1 非目標 |

## E. Phase 2 開工前需要 Kimi 決定

1. **run 專用 runtime 是否允許換 harness？** 建議第一版只允許「同 harness 換模型與 AI 連線」；跨 harness 只發生在 fallback，且用 Phase 1 的 activation 在 agent 層切換並留言。理由：per-run 的 adapterType 會牽動 run claim、adapter registry 與 session 命名空間，風險高。
2. **fallback 預設值**：冷卻 30 分鐘、每任務最多 2 次、fallback 後是否自動切回（建議不自動切回，下一個任務再依規則選）。
3. **預算規則的門檻**：建議 80% 走 economy、100% 沿用既有硬停。
