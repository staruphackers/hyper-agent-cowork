# Phase 2 重新規劃：以上游 AI 連線池為底的路由外掛

- 日期：2026-10-26
- 狀態：草案，待 Kimi 拍板（第 8 節）
- 取代：`2026-09-26-agent-cowork-backlog.md` 的 B1–B3 做法
- 前置：`2026-10-26-upstream-sync-and-zhtw-polish.md` 第 7 節 S5

## 1. 結論

不再自建 `routingPolicy` 欄位與 heartbeat 選擇邏輯。改寫一個本地外掛，實作上游的 `onRouteAiConnection`，讓上游的「AI 連線池」負責鎖定、任務釘選、帳號權限與復原；外掛只決定「新任務該用池裡哪個成員」。

這樣 B1、B2 大部分可以不改 core 完成；B3「任務做到一半額度用完就換帳號」是上游刻意不支援的行為，需要一個小的 fork core 修改，建議放到第二階段，等第一階段在 VPS 跑穩再決定。

**最重要的前提**：跨供應商路由（例如 Claude 用完換 Codex）只有在代理人使用 Paperclip Runner 時才成立；舊版轉接器（`claude_local`、`codex_local`）只能在同一供應商的帳號之間輪替。所以 S3 staging 必須先確認 Runner 在你的 VPS 映像能跑，這份計畫才有意義。

## 2. 上游提供了什麼（2026-10-26 實讀程式碼）

來源：#14967（`0e0b63e5a`）、`doc/connections/AI-CONNECTION-ROUTERS.md`、`packages/shared/src/ai-connection-router.ts`、`server/src/services/ai-connection-router.ts`。

| 項目 | 上游行為 |
|---|---|
| 開關 | 執行個體旗標 `enableAiConnectionRouters` 預設關閉，**沒有 UI 開關**，自架要用 instance-admin API `PATCH /api/instance/settings/experimental` 打開；每個池也預設停用 |
| 池 | 組織範圍的虛擬連線；成員 = 一個已存在的帳號（grant）＋執行框架（`codex`／`acpx` claude、grok／`opencode`）＋模型＋推理強度，最多 100 個 |
| 模式 | `round_robin`（不查用量）或 `usage_aware`（查用量，15 秒預算、60 秒快取，超過門檻 `thresholdPercent` 就跳過） |
| 任務釘選 | 依「組織＋池＋代理人＋task key」釘選；同一任務之後每一輪、重設工作階段、壓縮都沿用同一個成員 |
| 額度用完 | 外掛回 `exhausted` → 這一輪延後並排程 `ai_connection_pool_wait`，不扣失敗重試次數，UI 顯示「Pool exhausted」；**已釘選的任務不會換成員** |
| 外掛介面 | `onRouteAiConnection(request)` → `selected`／`exhausted`／`unavailable`；request 只有授權過的中繼資料：池設定、代理人 ID、task key、上次選的成員、候選成員與用量，**沒有憑證、沒有任務內容** |
| 權限 | 外掛需要 `ai.connections.route` 能力；core 會再驗一次外掛回傳的成員，回傳未授權成員會被拒絕 |
| 紀錄 | 每次分配寫 activity log（`ai_connection.pool_selected`）；run 紀錄寫入選到的成員與覆寫說明，資料留在本機資料庫 |
| 開源版缺口 | 上游的輪替與額度外掛是 **私有的 Cloud 外掛**，開源版只有 core 與介面，沒有可用的路由外掛 |

## 3. 原 backlog 對照

| # | 原計畫 | 新做法 | 要改 core？ |
|---|---|---|---|
| B1 | 四層 `routingPolicy` 規則模型 | 規則放在外掛設定裡（外掛自己的 instance config），池本身就是「可選成員清單」；不新增資料表欄位 | 否 |
| B2 | 每次 run 依規則選 profile | 外掛在 `onRouteAiConnection` 裡套規則。task key 通常就是任務 ID，外掛用 `issues.read` 讀優先順序與標籤，用 `agents.read` 讀代理人本月花費／預算（`spentMonthlyCents`／`budgetMonthlyCents`）算出預算使用率 | 否 |
| B3 | 額度用完 → 換 fallback profile | 新任務：`usage_aware` 模式本來就會跳過超過門檻的成員，外掛可以照順序挑下一個。**做到一半的任務**：上游會等額度恢復，不會換人；要換就得改 core 的釘選邏輯 | 第二階段才需要 |
| B4 | 模型覆寫擴充 | 上游已有批次改預設模型（#17215）與池成員的模型覆寫；先用上游 | 否 |
| B5 | 依 profile 歸因成本 | 改成「依池成員歸因」：run 紀錄已經有成員 ID，成本頁再補一個分組即可 | 小改 |
| B6 | 文件與發行 | 照舊，寫 zh-TW 指南「AI 連線池與自動路由」 | 否 |

### 與 fork 的執行設定檔（runtime profiles）怎麼分工

- **執行設定檔**：人工切換整個代理人的執行框架與模型（例如這週改用 Codex）。保留，不動。
- **AI 連線池**：同一個代理人，不同任務自動分到不同帳號或模型。新功能由這裡負責。
- 兩者不互相引用；代理人的 AI 連線若設成池，執行設定檔只決定執行框架，帳號由池決定。第一階段要寫測試確認兩者同時開時不會互相覆蓋（風險見第 6 節）。

## 4. 外掛設計（第一階段）

套件：`packages/plugins/plugin-hac-router`（以 `examples/plugin-hello-world-example` 為骨架）。

Manifest：

- capabilities：`ai.connections.route`、`issues.read`、`agents.read`（外掛 SDK 沒有直接讀成本的 client；預算使用率用代理人的本月花費與預算計算）
- `aiConnectionRouter: { name: "智慧路由池", description: "依任務優先順序、標籤與預算分配 AI 帳號" }`

外掛設定（instance config，JSON，有 zod 驗證）：

```json
{
  "rules": [
    { "when": { "priority": ["critical", "high"] }, "prefer": ["<memberId>"] },
    { "when": { "labels": ["文案", "翻譯"] }, "prefer": ["<memberId>"] },
    { "when": { "budgetPercentAtLeast": 80 }, "prefer": ["<便宜的 memberId>"] }
  ],
  "default": "round_robin"
}
```

選擇流程（只在新任務、沒有釘選時生效；有釘選就照 core 規定回傳同一成員）：

1. 讀任務（task key 不是任務 ID，例如 `__heartbeat__`，就跳過規則）。
2. 由上到下套規則，第一條符合的規則給出偏好成員清單。
3. 在偏好清單裡，跳過用量超過門檻的候選；都超過就退回全部候選的輪替。
4. 全部候選都超過門檻 → 回 `exhausted`，`retryAt` 取最早重置時間。
5. 回傳結果附 `skipped` 理由，讓 run 紀錄看得出為什麼選這個成員。

外掛完全不碰憑證，也不寫資料庫；規則錯了最多是選錯成員，不會越權。

## 5. 里程碑與工時

| 階段 | 內容 | 估計 |
|---|---|---|
| P2-0 | S3 staging 確認 Paperclip Runner 能跑，並在 staging 用 API 打開 `enableAiConnectionRouters` | Kimi 0.5 天 |
| P2-1 | 外掛骨架、manifest、設定驗證、輪替與規則選擇；單元測試（規則比對、門檻跳過、exhausted） | 2 天 |
| P2-2 | 整合測試：沿用 `server/src/__tests__/ai-connection-router.test.ts` 的測試資料，裝外掛跑真正的分配與釘選；測試「執行設定檔＋池」同時開 | 1.5 天 |
| P2-3 | zh-TW 指南與外掛設定頁說明；版本說明 | 0.5 天 |
| P2-4 | staging 實測：兩個你自己的帳號，各跑 3 個任務，確認分配、釘選、額度用完的等待行為 | Kimi 0.5 天 |
| P2-5（第二階段，另外拍板） | fork core 修改：任務在 `provider_quota` 重試用盡後解除釘選並重新分配，最多 2 次、冷卻 30 分鐘、在任務留言說明 | 2–3 天 |

第一階段合計：開發約 4 天＋你驗收約 1 天。

## 6. 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| **供應商條款** | 用多個個人訂閱帳號輪替來繞過用量上限，可能違反 Anthropic、OpenAI 的消費者條款，最壞是帳號被停 | 池成員優先放 API key、Team／Enterprise 方案，或本來就是不同人的帳號；個人訂閱帳號互相輪替不建議。**這點要你決定** |
| 上游是實驗功能 | 介面可能改；每次同步都可能要調外掛 | 外掛只用 `onRouteAiConnection` 一個介面；把介面版本寫進測試，同步時一跑就知道有沒有壞 |
| 只有 Runner 能跨供應商 | 舊轉接器的代理人只能同供應商輪替 | P2-0 先確認 Runner；不行就第一階段只做同供應商輪替 |
| 與執行設定檔衝突 | 切換設定檔時可能改到池綁定，或反過來 | P2-2 專門測；有衝突就在切換設定檔時保留 AI 連線綁定 |
| 已釘選任務不會換帳號 | 長任務遇到額度用完會一直等 | 第一階段接受，UI 會顯示「Pool exhausted」；第二階段 P2-5 再處理 |
| 沒有 UI 開關 | 要用 API 打開旗標 | 寫進 zh-TW 指南，附 curl 範例（token 一律以 `***` 表示） |

## 7. 驗證方式

- `pnpm --filter <外掛> test`：規則、門檻、exhausted 單元測試。
- `cd server && pnpm exec vitest run src/__tests__/ai-connection-router.test.ts`＋新增的外掛整合測試。
- `pnpm -r typecheck`、`pnpm build`、`pnpm check:module-boundaries`。
- staging：activity log 出現 `ai_connection.pool_selected`，兩個任務分到不同成員，同一任務第二輪成員不變。

## 8. 待 Kimi 拍板

1. **同意第一階段（P2-0 到 P2-4）照這份做**，B3 的「任務中途換帳號」延到第二階段另外決定。
2. **池成員要放哪種帳號**：建議 API key 或團隊方案，避開個人訂閱帳號互相輪替的條款風險。
3. **規則的維度**：先做「優先順序、標籤、預算使用率」三種就好，還是要加別的（例如依代理人角色）。

## 9. 成本

- 開發在 Claude Code session 內完成，不新增付費服務。
- `usage_aware` 模式每次分配新任務會查一次各帳號用量（有 60 秒快取），不產生模型費用。
- staging 實測會實際跑 AI 任務：兩個帳號各 3 個小任務，用 API key 的話估計 US$1–3。
