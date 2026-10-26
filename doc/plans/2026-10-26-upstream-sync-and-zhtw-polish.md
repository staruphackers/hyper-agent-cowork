# 上游同步評估、繁中翻譯優化與開發計畫重排（2026-10-26）

- 狀態：Proposal（待 Kimi 拍板，第 6 節）
- 前一份：`doc/plans/2026-09-26-agent-cowork-backlog.md`（Phase 2／3 待辦）
- 範圍：只評估與規劃。本文件不改程式、不動 VPS。

> English abstract: upstream `paperclipai/paperclip` master is 1,110 commits ahead of this fork's last sync point (`efce935`, 2026-09-24); the fork is 86 commits ahead. A trial merge produced 34 conflicted files, a migration-number collision at `0284`, and a heavily refactored `heartbeat.ts` (29,689 → 4,170 lines). After the sync, zh-TW coverage would fall from 97.4 % to about 75.5 % (3,365 new strings, 910 stale keys). Several upstream features overlap the fork's planned Phase 2/3 work, so the recommendation is: sync first on a staging copy, then re-scope Phase 2/3 on top of upstream, and run the zh-TW polish against the post-sync string set.

## 1. 結論

1. **值得同步，但不能直接 merge 上 production。** 上游一個月內累積 494 個 fix、119 個 perf、110 個 feat，其中有多項正好修在你常用的區域（heartbeat、wake-queue、OpenCode、Pi、Grok、Docker 啟動速度）。
2. **先同步、再翻譯、最後才做 Phase 2／3。** 上游已經出了「任務綁定 AI 路由」「同任務多代理人交接（cases）」「個人主要代理人」「訂閱費成本報表」等功能，和 backlog 的 B1–B5、C1、C3 高度重疊。若先自己做，之後每次同步都會撞。
3. **翻譯「怪怪的」主因不是大陸用語**，而是（a）同一英文字在不同情境共用一個翻譯、（b）句子被拆成片段各自翻、（c）核心名詞沒有統一詞彙表。要修的是機制與詞彙表，不只是逐條改字。

## 2. 現況數據（2026-10-26 實測）

| 項目 | 數值 | 驗證方式 |
|---|---|---|
| 上次同步點 | `efce935`（2026-09-24） | `git merge-base HEAD upstream/master` |
| 上游領先 | 1,110 commits（最新 `1fbbef4`，2026-10-25） | `git rev-list --count` |
| 你的 fork 領先 | 86 commits | 同上 |
| 試合併衝突 | 34 個檔案 | 暫存 worktree 中 `git merge --no-commit`，已丟棄 |
| 上游新 migration | 94 支（`0284`–`0377`） | `git diff --name-status` |
| 你的 migration | `0284_round_landau.sql`（runtime profiles，**已在 VPS 執行過**） | 同上 |
| `heartbeat.ts` | 你的版本 29,689 行，上游拆成 `server/src/services/heartbeat/*` 後主檔 4,170 行 | `wc -l` |
| 繁中覆蓋率（現在） | 11,297／11,595 = 97.4 % | `node ui/i18n-tools/check.mjs` |
| 繁中覆蓋率（同步後推估） | 10,387／13,752 = 75.5 %；新增未翻 3,365 條、失效 910 條 | 把 `ui/i18n-tools` 與字典套到上游 master 跑 `extract.mjs` + `check.mjs` |
| 簡體殘留／placeholder 不符 | 0／0 | `check.mjs` |

## 3. 上游值得同步的更新

### 3.1 必要（穩定性與你已踩過的坑）

| 類別 | 代表 commit | 對你的意義 |
|---|---|---|
| Heartbeat 復原 | #16855 重試中收到留言不再中斷、#16791 對帳卡住的 running 狀態、#16358／#16355 重啟後遺失 lease 的 run 會重試、#11699 週期復原一次只跑一條 | VPS 重啟、容器更新後任務卡住的機率下降 |
| Wake queue | #16357 被停止的排隊 run 保留待辦、#13912 壞掉的留言 id 不再擋住整個任務 | 與你 zhtw.12 修的「佇列斷鏈」同一區，互補 |
| OpenCode／Pi | #17398 沙箱 OOM 時保住代理人、#16863 記錄 `opencode serve` 停止原因、#10249 Pi 執行紀錄不再二次方成長 | 你主力用 OpenCode Go／Pi，直接受益 |
| Docker | #16672 以預編譯 bundle 啟動、#15992／#16475 開機不再全樹 chown | VPS 重啟與升級更快 |
| 安全 | #14413 雲端認證 header 遮罩、#16168 回饋遮罩保留公開 id、提示詞注入防護（connections） | 降低 log 洩漏風險 |

### 3.2 高價值功能（同步後可直接用）

- Git workspace restore points 與過期回收（#17238、#17241、#17248、#17271）：工作區不再無限長大。
- 代理人批次編輯連線與預設模型（#17215）。
- 訂閱費與 API 花費並列的成本頁（#15634）。
- 私人任務與分享權限（#14717、#14718、#10633）。
- 自訂 AI gateway 接入（#17253）、多 harness 自訂模型 provider（#14970）。

### 3.3 與你的 Phase 2／3 重疊（同步後要重新規劃）

| 你的 backlog | 上游已有 | 建議 |
|---|---|---|
| B1–B3 routing policy／fallback | #14967 實驗性「任務綁定 AI 路由」：帳號池輪替、任務固定帳號與 session，策略由外掛提供 | 改成「寫一個 routing 外掛」接上游介面，不另建 `routingPolicy` 欄位 |
| B4 模型覆寫擴充 | #17215 批次改預設模型、#14970 自訂 provider | 先用上游，缺什麼再補 |
| B5／D4 成本歸因 | #15634 訂閱費報表 | 只補「依 runtime profile 歸因」 |
| C1 Handoff packet | #16959 cases：持久化流程與同任務交接 | 改成在 cases 上加你的交接摘要格式 |
| C3 公司層 `primaryAgentId` | #15470 個人主要代理人 | 直接採用，取消自建 |

### 3.4 需要特別注意的行為改變

- **新建 Claude／Codex／Pi／OpenCode 代理人預設改用 Paperclip Runner**（#15683、#15993、#17120、#17142）。Runner 在你的 Hostinger Docker 映像裡能不能跑，必須在 staging 實測；不行就要在設定裡把預設改回舊路徑。
- 左側導覽改成 Chat 優先（#15100），操作習慣會變。

## 4. 同步風險（KMO：已知、可測、可退）

| # | 風險 | 嚴重度 | 證據 | 對策 |
|---|---|---|---|---|
| R1 | **Migration 編號撞號**：你的 `0284_round_landau` 與上游 `0284_petite_genesis` 同號 | 高 | 試合併 `_journal.json` 衝突 | 你的 migration 改號為 `0378_*`，**SQL 內容一字不改**（`packages/db/src/client.ts` 以內容 hash 對應已執行的 migration，理論上 VPS 不會重跑；仍須在 staging 用 production 備份實測）；上游 94 支先跑。已確認上游 migration 沒有碰 `agent_task_sessions` 索引或 runtime profile 欄位 |
| R2 | **heartbeat 修正被默默弄丟**：上游把 2.5 萬行拆進 `heartbeat/` 目錄，你的 86 行改動（runtime profile session key、Phase 0 切換防護）要手動搬到 `session-preparation.ts`、`task-context.ts`、`run-state.ts` 等新位置 | 高 | 7 個衝突區塊 + 上游 13 個檔案改用 `agentTaskSessions` | 逐 commit 移植清單（第 5 節步驟 3），每一項配回歸測試 |
| R3 | **wake-queue 修正被覆蓋**：上游 `policy.ts` 仍是舊邏輯（`if (facts.legacyExecutionNeedsReconciliation)`），沒有修你 zhtw.12 修的 bug | 高 | `git show upstream/master:…/policy.ts` 第 111 行 | 保留你的 `runOwnsLegacyReconciliation`；可考慮回饋給上游 PR，之後就不用每次維護 |
| R4 | AI 連線／裝置碼登入（zhtw.11 的 B1–B4、M1–M3、S1–S3）衝突：`local-ai-login.ts` 10 處、`ai-connections.ts`、`useLocalAiLogin.ts` | 中高 | 試合併 | 上游也在 #17106、#17129 改登入流程；以你的行為為準，逐條對照測試 |
| R5 | Runner 預設改變導致新代理人在 VPS 跑不起來 | 中 | 3.4 節 | staging 新建四種代理人各跑一個任務 |
| R6 | 繁中覆蓋率掉到約 75 %，後台大量英文 | 中 | 第 2 節 | 同步 PR 同時補翻（第 5 節步驟 5） |
| R7 | OpenClaw 遮罩修正（七輪審查）被改壞 | 中 | `openclaw-gateway/execute.ts`、`redaction.ts` 兩邊都改過 | 你的 OpenClaw 測試全數要過；`redaction.ts` 試合併時自動合併，需人工 diff 確認 |
| R8 | 資料庫無法回退：94 支 migration 跑完後，舊映像不保證能讀新 schema | 高 | — | rollback 只能「還原升級前的 volume 備份 + 換回舊 tag」，所以備份是硬性前提 |

已確認不會出事的：`Dockerfile` 自動合併後保留了 Grok／Pi CLI 安裝；上游完全沒動 `ui/src/i18n` 與 `ui/i18n-tools`，翻譯機制不會衝突。

## 5. 建議執行順序

1. **開同步分支**：`sync/upstream-2026-10`（從 `main`），`git merge upstream/master`，用 merge commit，不 rebase。
2. **先解 R1**：migration 改號、`_journal.json` 以上游為底再接上你的那一支、snapshot 以上游為準後 `pnpm db:generate` 確認沒有 drift。
3. **逐一移植 fork 修正**（依 `git log efce935..main` 的 86 個 commit 建清單），每項標記：已移植／上游已修可捨棄／需改寫。重點：runtime profiles、wake-queue、AI 登入、OpenClaw、approvals 遮罩還原。
4. **驗證**：`pnpm -r typecheck`、`pnpm test:run`、`pnpm build`、`pnpm check:token-gates`；全部綠燈才進下一步。
5. **翻譯補齊**：`extract.mjs` → `check.mjs` → 刪 910 條失效 key → 依第 6 節詞彙表補翻 3,365 條 → 再跑 `check.mjs`（目標 ≥ 97 %）。
6. **VPS staging**：同一台 VPS 開第二個 compose project（不同 port、不對外），還原一份 production 備份進去，跑新映像。驗收：既有任務能續接、runtime profiles 能切換、四種代理人新建各跑一個任務、裝置碼登入、OpenClaw doctor。
7. **Production 升級**：備份 volume → 換 tag → `pull && up -d` → health → 同 staging 驗收清單。失敗就還原備份＋換回 `zhtw.12`。

## 6. 繁中翻譯優化

### 6.1 根本原因（實測）

1. **keyless 一字一譯的情境衝突**：`Issues` → 「項」（被計數情境「3 issues」佔走）、`Issue` → 「問題」，但多數畫面把 issue 譯成「任務」；`Harness` 與 `Adapter` 都譯成「轉接器」，兩個不同概念在畫面上分不出來。
2. **句子片段翻譯**：1,059 條 key 是被 `{變數}` 切開的片段（開頭或結尾是空白、逗號、括號），各自翻譯後語序不自然，例如「沒有它，繫結無法落地」「並在從分配欄位隱藏此使用者前移動活躍分配」。
3. **核心名詞不一致**：session＝工作階段 35／會話 14；token＝token 55／令牌 15／權杖 1；approval＝審核 112／核准 20／批准 56。
4. **殘留用語與標點**：當前 48、計劃 46、暫無 35、令牌 26、會話 20、自定義 11、檢測 9、獲取 7、保存 6、超時 6；半形標點夾中文約 40 條、直引號 16 條、「併」誤用 4 條（簡轉繁殘留）。

### 6.2 做法

- **詞彙表成為 SoT**：新增 `ui/i18n-tools/GLOSSARY.zh-TW.md`，並讓 `check.mjs` 依詞彙表檢查禁用詞（例：「會話」「令牌」「當前」出現即警告），之後每次同步自動把關。
- **情境衝突**：wrap 機制支援「同英文 key、依檔案路徑給不同翻譯」的覆寫表（例如 `Issues` 在計數元件用「項」，在導覽用「任務」）。這是 i18n-tools 的小改動，不碰上游 TSX。
- **片段**：優先處理高曝光頁面（導覽、任務頁、代理人設定、收件匣、成本），把片段組合後在真實畫面上讀一遍再改。
- **驗收**：機械驗證（`check.mjs` 0 禁用詞、0 簡體、0 placeholder 不符）＋ Kimi 在 staging 走一遍主要頁面截圖確認語感。兩者缺一不算完成。

### 6.3 詞彙表草案（已定案者不重議）

| 英文 | 譯法 | 狀態 |
|---|---|---|
| Board | 董事會（看板類保留「看板」） | 已定案（`aea0e10bc`） |
| Adapter | 轉接器 | 已定案（`57881a114`） |
| Agent | 代理人 | 已定案（`eb8f316f6`） |
| Company | 組織 | 沿用現況（43 vs 7） |
| Issue | 任務（計數單位另議） | **待拍板** |
| Harness | 執行框架（與 Adapter 區分） | **待拍板** |
| Approve／Approval／Review | 核准／核准／審查（停用「審核」「批准」） | **待拍板** |
| Session | 工作階段 | **待拍板** |
| Token（驗證用） | Token（保留英文；LLM 計量也用 token） | **待拍板** |
| Run | 執行 | 沿用現況 |
| Routine | 例行工作 | 沿用現況 |
| Apps | 應用程式 | **待拍板**（現為「應用」） |

## 7. 開發計畫重排（取代 2026-09-26 backlog 的 B／C 段順序）

| 階段 | 內容 | 時程估計 |
|---|---|---|
| S0 | 本文件拍板 | 0.5 天 |
| S1 | 上游同步（第 5 節 1–4） | 3–5 天 |
| S2 | 翻譯補齊＋詞彙表＋情境覆寫（第 5 節 5、第 6 節） | 2–3 天 |
| S3 | VPS staging → production（第 5 節 6–7） | 1 天＋觀察 2–3 天 |
| S4 | 把 wake-queue 修正回饋上游（降低之後每次同步的維護成本） | 0.5 天 |
| S5 | Phase 2 重新規劃：以上游任務綁定 AI 路由（#14967）為底，寫 routing／fallback 外掛 | 規劃 1 天後再估 |
| S6 | Phase 3 重新規劃：以 cases（#16959）與個人主要代理人（#15470）為底 | 同上 |

之後建議每 2 週同步一次上游，把每次衝突控制在可人工審閱的量（這次 1,110 commits 是上次的 13 倍）。

## 8. 成本

- 同步與翻譯在 Claude Code session 內完成，不需新增付費服務。
- 若改用 API 批次翻譯 3,365 條字串，估計輸入加輸出約 50 萬 tokens，費用在 US$10 以內。
- staging 跑在現有 VPS（需約 2–3 GB 額外記憶體與一份資料庫備份的磁碟空間），無額外月費。
