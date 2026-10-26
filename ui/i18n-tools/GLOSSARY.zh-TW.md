# 繁體中文（zh-TW）詞彙表與翻譯規範

機器可讀的版本是同目錄的 `glossary.zh-TW.json`，這份文件說明用法與理由。2026-10-26 依 Kimi 拍板定案（見 `doc/plans/2026-10-26-upstream-sync-and-zhtw-polish.md` 第 6.3 節）。

## 怎麼用

- 補翻或修改 `ui/src/i18n/locales/zh-TW.json` 時，核心名詞一律照下表。
- `node ui/i18n-tools/check.mjs` 會檢查 `forbidden` 清單：值裡出現禁用詞就列出並以非 0 結束。
- 台灣本來就這樣用、但字面上含禁用詞的複合詞，放在 `allowedCompounds`（例如「用戶端」含「用戶」）。

## 核心名詞

| 英文 | 譯法 | 備註 |
|---|---|---|
| Agent | 代理人 | |
| Board | 董事會 | Paperclip 的人類治理者；看板類 UI 才用「看板」 |
| Adapter | 轉接器 | |
| Harness | 執行框架 | 與 Adapter 區分 |
| Issue / Task | 任務 | sub-issue → 子任務 |
| Approve / Approval | 核准 | |
| Review | 審查 | |
| Session | 工作階段 | |
| Token（驗證憑證） | Token | 保留英文 |
| token（LLM 用量） | token | 保留英文 |
| Company | 組織 | |
| Run | 執行 | |
| Routine | 例行工作 | |
| Skill | 技能 | |
| Connection | 連線 | |
| Instance | 執行個體 | |
| Workspace | 工作區 | |
| Secret | 機密 | |
| Apps | 應用程式 | |
| Artifact | 產出物 | |
| Restore point | 還原點 | |
| Runtime profile | 執行設定檔 | |

產品與品牌名稱（Paperclip、Claude、Codex、OpenAI、OpenRouter、OpenCode、Grok、GitHub、Slack、MCP、API、CLI、Paperclip Runner 等）保留英文。

## 寫法

- 用「你」，不用「您」。
- 中文句子用全形標點：，。：；（）「」；中文裡的引號用「」不用直引號。
- 中文與英文字母、數字之間留一個半形空格：「設定 API 金鑰」「3 個任務」。
- 程式碼、路徑、網址、環境變數、`{{佔位符}}` 原樣保留。
- 相對時間：2 分鐘前、1 分 4 秒；空狀態：尚無任務。

## 為什麼要禁用這些詞

翻譯「怪怪的」多半來自中國大陸用語或機器翻譯腔（當前、會話、令牌、暫無、匹配、批准……）。禁用清單只收「在台灣幾乎不會這樣寫」的詞；有歧義、台灣也常用的詞（例如代碼、檢測、保存、活躍）不列入，避免誤判。
