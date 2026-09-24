# Hyper Agent Cowork

**給每個人一支 AI 代理人團隊的開源工作平台——像管理公司一樣，管理你手下的 AI agent。**

<p align="center">
  <a href="#快速開始"><strong>快速開始</strong></a> &middot;
  <a href="#繁體中文化說明"><strong>繁體中文化說明</strong></a> &middot;
  <a href="https://github.com/paperclipai/paperclip"><strong>上游專案 Paperclip</strong></a> &middot;
  <a href="https://paperclip.ing"><strong>上游官網</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
</p>

## 關於本專案

Hyper Agent Cowork 是開源專案 [Paperclip](https://github.com/paperclipai/paperclip)（官網：<https://paperclip.ing>）的**台灣繁體中文發行版**。

- **介面全面繁中化**：採用「建置期字串包裝＋繁中字典」的做法——在 build 時把介面字串包成翻譯呼叫、再對照繁中字典顯示。上游的介面原始碼幾乎不動（只改了建置設定與語言切換入口的數行），因此可以持續同步上游的新版本。
- **功能與上游一致**：除了介面語言，本平台的行為、資料結構與 API 都跟上游 Paperclip 相同。
- **本專案非 Paperclip 官方出品**，與 Paperclip 團隊沒有隸屬或背書關係。Paperclip 的名稱、商標、官方社群與文件皆屬上游專案所有；本 README 中凡提到「上游」，指的就是 Paperclip 官方。

<br/>

<div align="center">
  <video src="https://github.com/user-attachments/assets/773bdfb2-6d1e-4e30-8c5f-3487d5b70c8f" width="600" controls></video>
  <br/>
  <sub>▲ 示範影片畫面取自上游 Paperclip（英文介面）。</sub>
</div>

<br/>

## 把 AI agent 當成一家公司來經營

開源的 AI agent 團隊編排（orchestration）平台。

**如果 OpenClaw 是一位「員工」，那 Hyper Agent Cowork（基於 Paperclip）就是那間「公司」。**

本平台由 Node.js 伺服器與 React 介面組成，負責編排一整支 AI agent 團隊來經營一門生意。你自備 agent、指派目標，然後在同一個儀表板上追蹤工作進度與花費。

它看起來像一套任務管理工具，底下其實是組織圖、預算、治理、目標對齊與 agent 之間的協作機制。

**你管的是商業目標，不是 pull request。**

|        | 步驟            | 範例                                                              |
| ------ | --------------- | ----------------------------------------------------------------- |
| **01** | 訂定目標        | _「打造第一名的 AI 筆記 App，做到每月經常性營收 100 萬美元。」_   |
| **02** | 組建團隊        | CEO、CTO、工程師、設計師、行銷——任何 bot、任何供應商都行。        |
| **03** | 核准並開跑      | 審閱策略、設定預算、按下開始，接著在儀表板上盯進度。              |

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>支援<br/>串接</strong></td>
    <td align="center"><img src="doc/assets/logos/openclaw.svg" width="32" alt="OpenClaw" /><br/><sub>OpenClaw</sub></td>
    <td align="center"><img src="doc/assets/logos/claude.svg" width="32" alt="Claude" /><br/><sub>Claude Code</sub></td>
    <td align="center"><img src="doc/assets/logos/codex.svg" width="32" alt="Codex" /><br/><sub>Codex</sub></td>
    <td align="center"><img src="doc/assets/logos/cursor.svg" width="32" alt="Cursor" /><br/><sub>Cursor</sub></td>
    <td align="center"><img src="doc/assets/logos/bash.svg" width="32" alt="Bash" /><br/><sub>Bash</sub></td>
    <td align="center"><img src="doc/assets/logos/http.svg" width="32" alt="HTTP" /><br/><sub>HTTP</sub></td>
  </tr>
</table>

<em>只要收得到 heartbeat（定時喚醒訊號），就能錄取上工。</em>

</div>

<br/>

## 這個平台適合你，如果你……

- ✅ 想打造**自主運作的 AI 組織**
- ✅ 要**協調許多不同的 agent**（OpenClaw、Codex、Claude、Cursor）朝同一個目標前進
- ✅ 同時開著 **20 個 Claude Code 終端機**，早就搞不清楚誰在做什麼
- ✅ 希望 agent **24 小時自主運作**，但仍保有稽核工作、必要時插手的能力
- ✅ 想**掌握花費**並落實預算上限
- ✅ 想要一套**用起來就像任務管理工具**的 agent 管理流程
- ✅ 想**用手機**管理你的自主事業

<br/>

## 四大支柱

一個 AI agent 組織要真正產出成果，有四件事必須到位：任務、組織、訓練與基礎設施。Paperclip 正是圍繞這四大支柱打造的。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/paperclipai/paperclip/1ec33ffd8b597f7e36aac3e2fbb4665b8c42dc3c/doc/assets/four-pillars-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/paperclipai/paperclip/1ec33ffd8b597f7e36aac3e2fbb4665b8c42dc3c/doc/assets/four-pillars-light.png">
  <img src="https://raw.githubusercontent.com/paperclipai/paperclip/1ec33ffd8b597f7e36aac3e2fbb4665b8c42dc3c/doc/assets/four-pillars-light.png" alt="Paperclip 的四大支柱（圖片取自上游 Paperclip）">
</picture>

<sub>▲ 圖片取自上游 Paperclip。</sub>

| 支柱 | 對象 | 涵蓋範圍 |
| --- | --- | --- |
| **Agentic 任務管理（Agentic Task Manager）**——宣告意圖、agent 動手、你驗收成果。 | 所有人，每天使用 | 任務、核准與審查關卡 · 主動出擊的 agent 同事 · 可稽核的 routine（例行任務）與工作流程 · 以 diff、截圖與測試驗收 |
| **Agent 組織圖（Org Chart for Agents）**——為人類與 agent 定義角色、權限與邊界。 | 管理者 | 人類＋agent 混合組織圖 · 職責、委派、專業分工 · 治理：誰能做什麼 · 有範圍限制的 secret 與公司邊界 |
| **Agent 員工訓練（Agent Employee Training）**——設計、訓練並評估你的 AI 員工。 | 推動者 | Skill Studio 與全組織共用 skill · eval（評測）與存檔的測試執行 · 主動學習迴路與品質指標 · agent 績效考核 |
| **Agentic OS**——讓工作跑得起來的基礎設施。 | IT 與平台團隊 | 跨供應商執行環境：任何模型、任何 agent · 沙盒、整合與 MCP（Model Context Protocol）伺服器 · SSO、GRC、RBAC 與成本控管 · 資料隱私、內部追蹤資料收集、資料價值持續累積 |

<br/>

## 功能

<table>
<tr>
<td align="center" width="33%">
<h3>🔌 自備 agent</h3>
任何 agent、任何執行環境，同一張組織圖。只要收得到 heartbeat，就能錄取上工。
</td>
<td align="center" width="33%">
<h3>🎯 目標對齊</h3>
每一項任務都能追溯到組織使命。agent 知道<em>要做什麼</em>，也知道<em>為什麼</em>。
</td>
<td align="center" width="33%">
<h3>💓 Heartbeat（定時喚醒）</h3>
agent 依排程醒來、檢查工作、採取行動。委派沿著組織圖上下流動。
</td>
</tr>
<tr>
<td align="center">
<h3>💰 成本控管</h3>
每個 agent 都有每月預算，用到上限就停下來，不會花費失控。
</td>
<td align="center">
<h3>🏢 多組織</h3>
一次部署、多個組織，資料完全隔離。用一個控制台管理你旗下所有事業。
</td>
<td align="center">
<h3>🎫 工單系統</h3>
每段對話都有紀錄、每個決策都有說明。完整的工具呼叫追蹤與不可竄改的稽核日誌。
</td>
</tr>
<tr>
<td align="center">
<h3>🛡️ 治理</h3>
核准聘用、推翻策略、隨時暫停或終止任何 agent。
</td>
<td align="center">
<h3>📊 組織圖</h3>
階層、角色、匯報關係。你的 agent 有主管、有職稱，也有職務說明。
</td>
<td align="center">
<h3>📱 支援行動裝置</h3>
隨時隨地監控、管理你的自主事業。
</td>
</tr>
</table>

<br/>

## 本平台解決的問題

| 沒有本平台時                                                                                           | 有了本平台                                                                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| ❌ 開了 20 個 Claude Code 分頁，搞不清楚哪個在做什麼；電腦一重開，全部歸零。                           | ✅ 任務以工單管理、對話有串接脈絡，session 重開機後依然保留。                                                  |
| ❌ 得從好幾個地方手動蒐集脈絡，才能提醒 bot 你到底在做什麼。                                           | ✅ 脈絡從任務一路往上連到專案與公司目標——你的 agent 永遠知道要做什麼、為什麼。                               |
| ❌ 一堆 agent 設定資料夾雜亂無章，還得自己重新發明任務管理、溝通與 agent 之間的協調機制。              | ✅ 內建組織圖、工單、委派與治理——你經營的是一家公司，不是一堆腳本。                                           |
| ❌ 失控的迴圈燒掉幾百美元的 token，在你察覺之前就把額度用光。                                           | ✅ 成本追蹤會呈現 token 預算，額度用完就為 agent 降速；管理層用預算來排優先順序。                              |
| ❌ 有固定要跑的工作（客服、社群、報表），每次都得記得手動啟動。                                         | ✅ Heartbeat 依排程處理例行工作，管理層負責督導。                                                              |
| ❌ 有了點子，得先找到 repo、開 Claude Code、開著分頁一路盯著它。                                        | ✅ 在平台上新增一項任務，你的 coding agent 會一路做到完成，管理層再審閱成果。                                 |

<br/>

## 為什麼本平台與眾不同

它把編排工作中最難搞的細節都處理對了。

|                                   |                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| **原子化執行。**                  | 任務領取（checkout）與預算限制都是原子操作，不會重複作業，也不會花費失控。               |
| **持久的 agent 狀態。**           | agent 在每次 heartbeat 之間延續同一個任務脈絡，而不是每次從頭來過。                      |
| **執行期注入 skill。**            | agent 可以在執行期學會平台的工作流程與專案脈絡，不需要重新訓練。                         |
| **可回復的治理機制。**            | 核准關卡確實執行、設定變更都有版本紀錄，出錯的變更可以安全回復。                         |
| **理解目標的執行。**              | 任務帶著完整的目標脈絡鏈，agent 始終看得到「為什麼」，而不只是一個標題。                 |
| **可攜的公司範本。**              | 匯出／匯入組織、agent 與 skill，並自動清除 secret、處理名稱衝突。                        |
| **真正的多組織隔離。**            | 每個實體都限定在所屬公司範圍內，一次部署即可經營多家公司，資料與稽核軌跡各自獨立。       |

<br/>

## 底層架構

本平台是一套完整的控制平面（control plane），不是一層包裝。在你打算自己從頭打造這些東西之前，先知道它們已經存在了：

```
┌──────────────────────────────────────────────────────────────┐
│                       PAPERCLIP SERVER                       │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │Identity & │  │  Work &   │  │ Heartbeat │  │Governance │  │
│  │  Access   │  │   Tasks   │  │ Execution │  │& Approvals│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Org Chart │  │Workspaces │  │  Plugins  │  │  Budget   │  │
│  │ & Agents  │  │ & Runtime │  │           │  │ & Costs   │  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
│                                                              │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  │
│  │ Routines  │  │ Secrets & │  │ Activity  │  │  Company  │  │
│  │& Schedules│  │  Storage  │  │ & Events  │  │Portability│  │
│  └───────────┘  └───────────┘  └───────────┘  └───────────┘  │
└──────────────────────────────────────────────────────────────┘
         ▲              ▲              ▲              ▲
   ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐  ┌─────┴─────┐
   │  Claude   │  │   Codex   │  │   CLI     │  │ HTTP/web  │
   │   Code    │  │           │  │  agents   │  │   bots    │
   └───────────┘  └───────────┘  └───────────┘  └───────────┘
```

### 各子系統

<table>
<tr>
<td width="50%">

**身分與存取（Identity & Access）**——兩種部署模式（受信任的本機模式，或需驗證登入的模式）、board（管理層）使用者、agent API key、短效期的執行 JWT、公司成員資格、邀請流程，以及 OpenClaw 上線引導。每一筆會變更資料的請求都能追溯到操作者。

</td>
<td width="50%">

**組織圖與 agent（Org Chart & Agents）**——agent 有角色、職稱、匯報關係、權限與預算。Adapter（轉接器）範例對應上圖：Claude Code、Codex、Cursor／Gemini／bash 等 CLI agent、OpenClaw 等 HTTP／webhook bot，以及外部 adapter 外掛。只要收得到 heartbeat，就能錄取上工。

</td>
</tr>
<tr>
<td>

**工作與任務系統（Work & Task System）**——issue 會連結到公司／專案／目標／上層任務，具備帶執行鎖的原子化領取、一等公民級的阻擋相依關係、留言、文件、附件、工作產出、標籤與收件匣狀態。不會重複作業，也不會遺失脈絡。

</td>
<td>

**Heartbeat 執行（Heartbeat Execution）**——以資料庫為後盾的喚醒佇列，支援合併重複喚醒、預算檢查、workspace（工作區）解析、secret 注入、skill 載入與 adapter 呼叫。每次執行都會產出結構化日誌、成本事件、session 狀態與稽核軌跡；孤兒執行會被自動回收處理。

</td>
</tr>
<tr>
<td>

**Workspace 與執行環境（Workspaces & Runtime）**——專案 workspace、隔離的執行 workspace（git worktree、操作者分支），以及執行期服務（開發伺服器、預覽網址）。agent 每次都在正確的目錄、帶著正確的脈絡工作。

</td>
<td>

**治理與核准（Governance & Approvals）**——board 核准流程、含審查／核准階段的執行政策、決策追蹤、預算硬性停損、agent 暫停／恢復／終止，以及完整稽核日誌。沒有你的簽核，什麼都不會上線。

</td>
</tr>
<tr>
<td>

**預算與成本控管（Budget & Cost Control）**——依公司、agent、專案、目標、issue、供應商與模型追蹤 token 與花費。可設定範圍化的預算政策，含警示門檻與硬性停損；超支時自動暫停 agent 並取消排隊中的工作。

</td>
<td>

**Routine 與排程（Routines & Schedules）**——以 cron、webhook 與 API 觸發的週期性任務，支援並行與補跑政策。每次 routine 執行都會建立一筆可追蹤的 issue 並喚醒指派的 agent——不必手動啟動。

</td>
</tr>
<tr>
<td>

**外掛（Plugins）**——全執行個體共用的外掛系統，採行程外 worker、依能力授權的主機服務、工作排程、工具開放與介面擴充。不必 fork 就能擴充本平台。

</td>
<td>

**Secret 與儲存（Secrets & Storage）**——執行個體層級與公司層級的 secret、加密的本機儲存、由供應商提供的物件儲存、附件與工作產出。敏感值不會進入 prompt，除非某次範圍化的執行明確需要。

</td>
</tr>
<tr>
<td>

**活動與事件（Activity & Events）**——會變更資料的動作、heartbeat 狀態變化、成本事件、核准、留言與工作產出，都會被記錄為持久的活動紀錄，讓操作者可以稽核發生了什麼、為什麼發生。

</td>
<td>

**公司可攜性（Company Portability）**——匯出與匯入整個組織（agent、skill、專案、routine 與 issue），自動清除 secret 並處理名稱衝突。一次部署、多家公司、資料完全隔離。

</td>
</tr>
</table>

<br/>

## 本平台不是什麼

|                              |                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| **不是聊天機器人。**         | agent 有的是職務，不是聊天視窗。                                                                       |
| **不是 agent 開發框架。**    | 我們不教你怎麼打造 agent，而是教你怎麼經營一家由 agent 組成的公司。                                    |
| **不是工作流程建構器。**     | 沒有拖拉式流水線。本平台模擬的是公司——有組織圖、目標、預算與治理。                                     |
| **不是 prompt 管理工具。**   | agent 自帶 prompt、模型與執行環境；本平台管理的是它們所處的組織。                                      |
| **不是單一 agent 工具。**    | 這是給團隊用的。如果你只有一個 agent，大概用不到；如果你有二十個——那你一定需要。                       |
| **不是程式碼審查工具。**     | 本平台編排的是工作，不是 pull request。審查流程請自備。                                                |

<br/>

## 快速開始

開源、自架，不需要任何 Paperclip 帳號。本 fork 的主要安裝方式是 Docker 映像，裝起來就是繁體中文介面。

### 用 Docker 啟動（建議）

先產生一組登入驗證用的密鑰：

```bash
openssl rand -hex 32
```

把輸出的字串填進下方 `BETTER_AUTH_SECRET`，再啟動容器：

```bash
docker run -d --name hyper-agent-cowork -p 3100:3100 \
  -e HOST=0.0.0.0 -e PAPERCLIP_HOME=/paperclip -e SERVE_UI=true \
  -e BETTER_AUTH_SECRET=<用 openssl rand -hex 32 產生> \
  -v hyper-agent-cowork-data:/paperclip \
  ghcr.io/staruphackers/hyper-agent-cowork:latest
```

接著：

1. 用瀏覽器開啟 <http://localhost:3100>。
2. 依畫面指示建立第一個管理員帳號。
3. 開啟帳號選單 → 語言，選擇 **繁體中文**（語言代碼 zh-TW）。

資料存放在名為 `hyper-agent-cowork-data` 的 Docker volume，容器刪除重建後仍會保留。

### 綁定 Claude／Codex 訂閱

若要讓 agent 使用你的 Claude 或 Codex 訂閱帳號，平台畫面會提供對應的登入指令。請在容器內**以 `node` 身分**執行畫面給的指令，例如綁定 Codex：

```bash
docker exec -it -u node hyper-agent-cowork bash -lc "export CODEX_HOME=<畫面給的路徑> && mkdir -p \$CODEX_HOME && codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth"
```

依終端機顯示的網址與代碼完成裝置登入即可。Claude 的綁定方式相同：以 `docker exec -it -u node hyper-agent-cowork bash -lc "<畫面給的指令>"` 執行。

> ⚠️ **不要使用 Docker Desktop 的「Exec」分頁執行登入指令。** 該分頁預設以 root 身分進入容器，產生的憑證檔權限屬於 root，平台實際執行 agent 的 `node` 使用者會讀不到，導致權限錯誤。請一律用上方的 `docker exec -u node` 指令。

### 上游原版安裝方式（英文介面）

以下是上游 Paperclip 官方的安裝方式，照譯保留供參考。**注意：這些方式安裝到的是上游英文原版，不含本 fork 的繁體中文介面。**

```bash
curl -fsSLO https://paperclip.ing/install.sh
curl -fsSLO https://paperclip.ing/install.sh.sha256
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c install.sh.sha256
else
  shasum -a 256 -c install.sh.sha256
fi
bash install.sh
```

安裝程式會確保系統上有 Node.js 24.11 以上版本、在 `~/.paperclip/cli` 下安裝一份受管理的 Paperclip CLI，並啟動互動式上線引導。在支援的 Linux 與 macOS 系統上，它也可以把 Paperclip 安裝成背景服務。checksum 可以偵測傳輸或發佈過程的錯誤，但它與安裝腳本來自同一個來源；若需要獨立來源，請改用固定 release tag 或 commit 的 GitHub 副本。

非互動式的受管理安裝：

```bash
curl -fsSL https://paperclip.ing/install.sh | bash -s -- --no-prompt --no-onboard
paperclipai onboard --yes
```

用管線（pipe）執行的方式，需要系統上已經有支援版本的 Node.js、npm 與 npx。如果需要安裝 Node.js，請先下載並檢視 `install.sh` 再執行，避免透過管線接受任何需要特權的相依套件安裝指令。

想試用 Paperclip、又不想永久安裝任何東西：

```bash
npx --registry https://registry.npmjs.org paperclipai onboard --yes
```

若要一個已初始化好 CEO agent 的隔離測試執行個體，請用 `test-drive`。它在前景執行，不會安裝服務、不會建立第一項任務，並且只在設定成功後才開啟瀏覽器：

```bash
ANTHROPIC_API_KEY=... npx paperclipai test-drive
OPENAI_API_KEY=... npx paperclipai test-drive --harness codex
OPENROUTER_API_KEY=... npx paperclipai test-drive \
  --harness opencode \
  --model openrouter/anthropic/claude-sonnet-4.5
```

沒有指定 `--data-dir` 時，每次執行都會建立一個獨立、會保留下來的暫存目錄，啟動時會印出它的絕對路徑。傳入 `--data-dir` 可重複使用同一個目錄；傳入 `--no-browser` 則不開啟初始化好的執行個體。若是從一個連結的 Git worktree 中執行，`test-drive` 也會啟用在該 worktree 中執行任務。憑證與重複使用的行為請見 [`doc/CLI.md`](doc/CLI.md#isolated-manual-test-drives)。

> **疑難排解：私有 npm registry 的 `.npmrc`**
>
> 如果這裡出現 `paperclipai`（或類似套件）的 `E404` 錯誤，而你透過全域 `~/.npmrc` 使用私有 npm registry（例如 GitHub Packages），`npx` 可能是在那個私有 registry 找 `paperclipai`，而不是公開的 npm registry。
>
> 診斷：
>
> ```bash
> npm config get registry
> ```
>
> 解法（跨平台；讓這個指令強制使用公開 npm registry）：
>
> ```bash
> npx --registry https://registry.npmjs.org paperclipai onboard --yes
> ```

上述快速安裝路徑預設使用受信任的本機 loopback 模式，第一次啟動最快。若要改以需驗證登入／私有模式啟動，請明確指定 bind 預設值：

```bash
paperclipai onboard --yes --bind lan
# 或：
paperclipai onboard --yes --bind tailnet
```

如果你已經設定過 Paperclip，重新執行 `onboard` 會保留既有設定。要修改設定請用 `paperclipai configure`。

固定版本、canary 與 git-ref 安裝、更新、回復、服務管理與解除安裝，請見 [`doc/INSTALLING.md`](doc/INSTALLING.md)。

或手動安裝：

```bash
git clone https://github.com/paperclipai/paperclip.git
cd paperclip
pnpm install
pnpm dev
```

這會在 `http://localhost:3100` 啟動 API 伺服器，並自動建立內嵌的 PostgreSQL 資料庫——不需要任何設定。

> **系統需求：** Node.js 24.11+、pnpm 9.15+

<br/>

## 繁體中文化說明

### 切換語言

- 開啟**帳號選單 → 語言**，選擇「繁體中文」（zh-TW）或「English」。切換後頁面會重新整理一次。
- 選擇會存在瀏覽器的 localStorage，鍵名為 `paperclip.locale`；清除瀏覽器資料後會回到預設偵測。
- 沒有手動選過時，會依瀏覽器語言自動判斷：瀏覽器為 `zh-TW`／`zh-Hant` 時預設顯示繁體中文，其餘預設顯示英文。

### 翻譯覆蓋範圍

- 介面字串約 **10,600 條**已翻成台灣繁體中文，技術詞（agent、heartbeat、workspace、routine 等）視語境保留英文。
- 少數情況仍會顯示英文：
  - 部分相對時間（例如 "3h ago"）；
  - 帶有人名或其他動態內容插值的句子；
  - 上游新版本剛加入、字典還沒補上的字串（缺翻譯時會直接顯示英文原文，不會出錯）。
- agent 產生的內容（任務說明、留言、報告）使用什麼語言，取決於你的指示與所用模型，不在介面翻譯範圍內。

### 同步上游的方式

繁中化是在 build 時把介面字串包成翻譯呼叫、再查繁中字典，**上游介面元件幾乎不動**（只改了建置設定與語言切換入口的數行），因此合併上游新版本時幾乎不會產生衝突；README 本身的處理方式見下方。同步上游後的標準流程（重新擷取字串、檢查未翻譯數量、補字典）請見 repo 內的 [`ui/i18n-tools/README.md`](ui/i18n-tools/README.md)。

上游英文 README 保留在 [`README.en.md`](README.en.md)。本檔（`README.md`）透過 `.gitattributes` 的 `merge=ours` 在合併上游時保留繁中版；每次同步後以 `git show up/master:README.md > README.en.md` 更新英文原文，再人工比對差異補進本檔。

<br/>

## 常見問題（FAQ）

**典型的架設長什麼樣子？**
在本機，一個 Node.js 行程就能管理內嵌的 Postgres 與本機檔案儲存。正式環境請改指向你自己的 Postgres，並用你習慣的方式部署。設定好專案、agent 與目標之後，其餘交給 agent 處理。

如果你是個人創業者，可以用 Tailscale 在外出時連回本平台；之後需要時，再部署到例如 Vercel 等環境。

**可以同時經營多家公司嗎？**
可以。單一部署可以經營不限數量的公司，資料完全隔離。

**本平台和 OpenClaw、Claude Code 這類 agent 有什麼不同？**
本平台是「使用」這些 agent。它把它們編排成一家公司——有組織圖、預算、目標、治理與權責歸屬。

**為什麼要用本平台，而不是直接讓 OpenClaw 去用 Asana 或 Trello？**
agent 編排有很多細節：誰領取了哪份工作、怎麼維持 session、怎麼監控花費、怎麼建立治理——本平台幫你處理好這些。

（「自備工單系統」已列入 Roadmap）

**agent 會一直持續執行嗎？**
預設情況下，agent 依排程的 heartbeat 與事件觸發（任務指派、@ 提及）執行。你也可以接上 OpenClaw 這類持續運作的 agent。你帶 agent 來，本平台負責協調。

<br/>

## 開發

```bash
pnpm dev              # 完整開發模式（API + UI，監看檔案變更）
pnpm dev:once         # 完整開發模式，不監看檔案變更
pnpm dev:server       # 只啟動伺服器
pnpm dev:mobile       # 在 :3101 提供預先建置的 UI 給手機／平板（/api 代理到 :3100）
pnpm dev:both         # 同時執行 `pnpm dev` 與 `pnpm dev:mobile`
pnpm build            # 建置全部
pnpm typecheck        # 型別檢查
pnpm test             # 低成本的預設測試（只跑 Vitest）
pnpm test:watch       # Vitest 監看模式
pnpm test:e2e         # Playwright 瀏覽器測試套件
pnpm db:generate      # 產生資料庫 migration
pnpm db:migrate       # 套用 migration
```

`pnpm test` 不會執行 Playwright。瀏覽器測試套件是分開的，通常只在修改相關流程或 CI 中才執行。

完整開發指南請見 [doc/DEVELOPING.md](doc/DEVELOPING.md)。

<br/>

## Roadmap（上游開發藍圖）

以下為上游 Paperclip 的開發藍圖，本 fork 會隨同步上游一併取得這些功能。

- ✅ 外掛系統（例如加入知識庫、自訂追蹤、佇列等）
- ✅ 支援 OpenClaw／claw 類型的 agent 員工
- ✅ companies.sh——匯入與匯出整個組織
- ✅ 簡易的 AGENTS.md 設定
- ✅ Skills Manager、Skill Studio 與 Skills Store
- ✅ 排程 routine
- ✅ 更完善的預算功能
- ✅ agent 審查與核准
- ✅ 多位人類使用者
- ✅ 雲端／沙盒 agent（e2b、Cloudflare、Daytona、Modal、Novita、自架 Kubernetes）
- ✅ Artifacts 與工作產出
- ✅ 深度規劃（規劃模式、有版本紀錄的計畫、計畫核准）
- ✅ 強制成果落實（watchdog、復原動作、審查關卡）
- ✅ MCP 工具閘道與 Apps（受治理的工具存取）
- ✅ 可依 agent 設定存取權限的 Secret 管理器
- ✅ 活動日誌與動作歸屬
- ✅ 自我修復的執行與自動復原
- ✅ agent 評測與回饋
- ⚪ 記憶／知識
- ⚪ MAXIMIZER MODE
- ⚪ 工作佇列
- ⚪ 自我組織
- ⚪ 自動化的組織學習
- ⚪ CEO 對話
- 🟡 雲端部署（多租戶隔離與公司匯入／匯出已上線）
- ⚪ 桌面 App
- ⚪ 自備工單系統（以 Asana／Linear／Jira 作為入口）
- ⚪ 已連結的 App（一鍵整合，例如 Vercel）

這是精簡版的藍圖預覽，完整內容請見 [ROADMAP.md](ROADMAP.md)。

<br/>

## 上游社群外掛

外掛與更多資源可在上游社群整理的 [awesome-paperclip](https://github.com/gsxdsm/awesome-paperclip) 找到。

## 可觀測性（Observability）

伺服器端內建選用（opt-in）的 OpenTelemetry 自動檢測（只有 traces）。設定 `OTEL_EXPORTER_OTLP_ENDPOINT` 後才會啟用，並可透過標準的 `OTEL_EXPORTER_OTLP_PROTOCOL` 環境變數選擇 `grpc`、`http/protobuf` 或 `http/json`。`@opentelemetry/api` 是一般的伺服器相依套件；SDK、自動檢測與 exporter 套件則是選用的 peer dependency——只有需要追蹤時才要安裝。安裝指令與完整環境變數說明請見 [doc/observability.md](doc/observability.md)。

另外也內建選用的 Sentry 錯誤監控，涵蓋伺服器與瀏覽器。設定 `SENTRY_DSN_FRONTEND` 啟用瀏覽器端、設定 `SENTRY_DSN_BACKEND` 啟用伺服器端——兩個變數都可以單獨設定，舊版的 `SENTRY_DSN` 變數仍可作為任一端的備援。支援的伺服器 SDK 版本為 `@sentry/node@10.71.0`，屬於伺服器的選用 peer dependency，只有需要錯誤監控時才要安裝；瀏覽器 SDK `@sentry/browser` 也固定在同一個版本。安裝指令、隱私設定與完整的預設收集項目，請見 [doc/observability.md](doc/observability.md#sentry-error-monitoring)。

## 遙測（Telemetry）

上游 Paperclip 會收集匿名的使用遙測資料，用來了解產品的使用情況並加以改善。不會收集任何個人資訊、issue 內容、prompt、檔案路徑或 secret。私有 repository 的參照會先以每次安裝各自的 salt 雜湊後才送出。

> ℹ️ 本 fork 沒有修改遙測行為：預設啟用，資料會送往上游 Paperclip 的端點。不想傳送請依下表停用。

修改遙測事件的貢獻者，請遵循 [Telemetry Data Contract](packages/shared/src/telemetry/README.md)。
尚未列入自動產生之合約的第一方新事件提案，請遵循 [Telemetry Workflow](doc/TELEMETRY_WORKFLOW.md)。

遙測**預設為啟用**，可用下列任一方式停用：

| 方式                 | 做法                                                    |
| -------------------- | ------------------------------------------------------- |
| 環境變數             | `PAPERCLIP_TELEMETRY_DISABLED=1`                        |
| 通用慣例             | `DO_NOT_TRACK=1`                                        |
| CI 環境              | 當 `CI=true` 時自動停用                                 |
| 設定檔               | 在 Paperclip 設定檔中設定 `telemetry.enabled: false`    |

以 Docker 啟動本 fork 時，可在 `docker run` 加上 `-e PAPERCLIP_TELEMETRY_DISABLED=1` 停用。

## 貢獻

- **功能與核心程式碼**：本 fork 不修改上游原始碼，功能面的問題與改進請直接貢獻給上游 Paperclip，並依上游的[貢獻指南](CONTRIBUTING.md)進行。
- **繁體中文翻譯**：翻譯錯誤、用語不道地或漏翻的字串，歡迎在本 repo 回報或提交修正；字典與工具的使用方式請見 [`ui/i18n-tools/README.md`](ui/i18n-tools/README.md)。

<br/>

## 上游社群

以下為上游 Paperclip 的官方社群管道，並非本 fork 經營：

- [Discord](https://discord.gg/m4HZY7xNG3)——加入上游社群
- [Twitter / X](https://x.com/papercliping)——追蹤上游更新與公告
- [GitHub Issues](https://github.com/paperclipai/paperclip/issues)——向上游回報 bug 與功能需求
- [GitHub Discussions](https://github.com/paperclipai/paperclip/discussions)——上游的點子與 RFC 討論
- [上游官方文件](https://docs.paperclip.ing)

<br/>

## 授權

本專案以 **MIT 授權**釋出。

- 上游 Paperclip 原始碼：`Copyright (c) 2025 Paperclip AI`（上游 README 另標示為 MIT © 2026 [Paperclip Labs, Inc](https://paperclip.ing)）。
- 本 fork 的繁體中文化部分（翻譯字典與建置期包裝工具）同樣以 MIT 授權釋出。
- 原始授權聲明完整保留於 [LICENSE](LICENSE)，散布或修改時請一併保留。

<br/>

---

<p align="center">
  <sub>以 MIT 授權開源。為想把事情做完、而不是整天看顧 agent 的人打造。<br/>Hyper Agent Cowork 為 Paperclip 的台灣繁體中文發行版，非 Paperclip 官方出品。</sub>
</p>
