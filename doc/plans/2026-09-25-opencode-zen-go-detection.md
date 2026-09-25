# OpenCode Zen／Go 方案：介面設定與自動偵測

日期：2026-09-25　狀態：待 Kimi 確認後執行　範圍：`opencode_local` 轉接器的新增代理人精靈與代理人設定頁

## 1. 背景與已驗證事實

來源：OpenCode 官方 repo 的文件原始檔（`packages/web/src/content/docs/zen.mdx`、`go.mdx`）、
OpenCode CLI 原始碼 `packages/opencode/src/provider/provider.ts`、models.dev 的 provider 定義。

| 項目 | OpenCode Zen | OpenCode Go |
| --- | --- | --- |
| 計費 | 儲值、按 token 計費（pay-as-you-go） | 月費 10 美元，每個模型有月額度（15～60 美元），5 小時 20%、每週 50% |
| OpenCode provider id | `opencode` | `opencode-go` |
| 模型 id 格式 | `opencode/<model>` | `opencode-go/<model>` |
| API base | `https://opencode.ai/zen/v1` | `https://opencode.ai/zen/go/v1`（models.dev 註明為未公開文件的介面） |
| 模型範圍 | 100 多個，含 Claude、GPT、Gemini、Grok 與 9 個免費模型 | 41 個開放權重模型（DeepSeek、GLM、Kimi、Qwen、MiniMax、MiMo、Grok 等） |
| 環境變數 | `OPENCODE_API_KEY` | `OPENCODE_API_KEY`（同一把金鑰） |
| CLI 登入 | `opencode auth login` → OpenCode Zen | `opencode auth login` → OpenCode Go |
| 額度用完 | 儲值歸零就停 | 可在 console 開「Use balance」改扣 Zen 儲值 |

CLI 行為（provider.ts）：`opencode` provider 在沒有金鑰時只保留 `cost.input === 0` 的模型，
這就是介面只列出 7 個免費模型的原因。CLI 本身沒有任何「方案偵測」：只要金鑰存在，
Zen 與 Go 兩份目錄都會整份列出，不管帳號實際有沒有訂閱或儲值。

## 2. 目標

1. 介面上直接選方案（Zen／Go）並貼金鑰，不需要進容器。
2. 按「偵測」後，平台用這把金鑰向 OpenCode 查詢，顯示 Zen、Go 各自是否開通與可用模型。
3. 模型下拉依方案分組並標示計費方式與免費模型；選到未開通方案的模型時提出警告。
4. 既有代理人的設定頁也能重新偵測（用已儲存的密鑰）。

## 3. 方案設計

### 3.1 偵測（伺服器端）

新增 `POST /api/companies/:companyId/adapters/opencode_local/opencode-plans`

- 輸入：精靈階段傳暫時性的 `apiKey`；設定頁則傳既有密鑰的 reference，由伺服器解析。
- 伺服器分別呼叫 `GET https://opencode.ai/zen/v1/models` 與 `GET https://opencode.ai/zen/go/v1/models`，
  帶 `Authorization: Bearer <key>`，逾時 5 秒。
- 回應：`{ zen: { status, models[] }, go: { status, models[] } }`，`status` 為
  `active`（200 且有模型）、`inactive`（401／402／403）、`unknown`（其他錯誤或格式無法解析）。
- 金鑰不落地、不寫 log、不進活動紀錄；套用公司存取檢查與簡單頻率限制。
- 後備：任一端點無法解析時，退回容器內 `opencode models` 的輸出，用前綴分組，
  免費模型以 `-free` 結尾或已知免費清單判斷。

### 3.2 介面

新增代理人精靈（OpenCode → 登入方式「供應商 API 金鑰」）：

- 「API 金鑰供應商」改為兩個明確選項：OpenCode Zen（儲值）、OpenCode Go（月費）。兩者都對應 `OPENCODE_API_KEY`。
- 金鑰欄位旁加「偵測方案」按鈕；結果以兩個徽章呈現（Zen 已開通／未開通、Go 已開通／未開通，各附模型數）。
- 模型下拉分組標題改為「OpenCode Go · 月費方案」、「OpenCode Zen · 儲值計費」，免費模型加「免費」標記；
  偵測為未開通的方案預設隱藏付費模型，可切換「顯示未開通的模型」。
- 選到未開通方案的模型時顯示警告，但不阻擋（使用者可能剛訂閱）。
- 「執行測試」維持現狀，仍是最終驗證。

代理人設定頁（既有代理人）：同樣的分組標籤與「重新偵測」按鈕，金鑰來自已儲存的密鑰。

### 3.3 文件

- 新增 `doc/zh-TW/OPENCODE-PLANS.md`：上表、選模型原則、費用控管。
- `doc/zh-TW/VPS-DEPLOY.md` 6.1 節改寫成介面操作，容器內登入降為備援做法。

## 4. 分階段

| 階段 | 內容 | 是否需要發版 | 預估 |
| --- | --- | --- | --- |
| 0 | 今天就能用：容器內 `opencode auth login` 選 OpenCode Go，下拉就會多出 OPENCODE-GO 群組 | 否 | 5 分鐘 |
| 1 | 供應商選項 Zen／Go、分組標籤、免費標記、提示文字、文件 | 是 | 半天 |
| 2 | 偵測端點、偵測按鈕、方案徽章、隱藏未開通模型、警告、設定頁重新偵測 | 是 | 1 天 |
| 3（選配） | 顯示 Go 額度用量。只有在 OpenCode API 有提供用量資料時才做 | 是 | 視 API 而定 |

建議：階段 1 與 2 合併成一個版本 `v2026.925.0-zhtw.3` 發布，少一次升級。

## 5. 風險與對策

- Go 的 models 端點未公開文件，格式可能變動：解析失敗時退回容器內清單，不讓精靈壞掉。
- Docker 映像每週重抓最新 CLI，`opencode models` 輸出格式若變動會影響後備路徑：測試涵蓋解析器。
- 與上游 Paperclip 合併衝突：改動集中在精靈與一個新路由，維持小而獨立。
- 金鑰安全：偵測呼叫走 HTTPS 到自己的伺服器再到 OpenCode，不儲存；與現在建立代理人時的密鑰流程同等級。
- 費用：偵測只是 GET 請求，不產生模型費用。模型費用由方案決定，代理人月預算上限仍是最後閘門。

## 6. 需要 Kimi 決定或提供

1. 同意階段 1＋2 合併發一版（建議），或先發階段 1。
2. 在 VPS 上跑一次下面的取樣指令，把輸出（不含金鑰）貼回來，用來確認兩個端點的回應格式，可加快階段 2：

```bash
read -s -p "OPENCODE_API_KEY: " K; echo
for u in https://opencode.ai/zen/v1/models https://opencode.ai/zen/go/v1/models; do
  echo "== $u"; curl -s -o /tmp/oc.json -w 'HTTP %{http_code}\n' -H "Authorization: Bearer $K" "$u"; head -c 600 /tmp/oc.json; echo
done
unset K; rm -f /tmp/oc.json
```
