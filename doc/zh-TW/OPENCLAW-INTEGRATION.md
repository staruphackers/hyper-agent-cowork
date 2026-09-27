# 把 OpenClaw 接進 Hyper Agent Cowork（企業串接指南）

> 適用：`zhtw.10` 起。對象：幫企業把既有的 OpenClaw（自架或 Hostinger 等代管主機）接成 Hyper Agent Cowork 的代理人。
> 本指南整理自 2026-09 第一次實際串接時踩過的問題，每一步都附「怎樣算成功」。

## 0. 串接前檢查（先確認再開始）

| # | 項目 | 怎樣算 OK |
|---|---|---|
| 0.1 | Hyper Agent Cowork 有固定網址（HTTPS） | 瀏覽器開 `https://<平台網址>/api/health` 回 JSON，`status` 為 ok |
| 0.2 | OpenClaw gateway 有固定網址（`wss://`） | 在 OpenClaw 主機以外的地方連得到；**不要用 trycloudflare 這類臨時隧道**，它每次重開網址都會變 |
| 0.3 | 手上有 OpenClaw gateway token | OpenClaw 設定裡的 gateway token（之後貼到 `x-openclaw-token`） |
| 0.4 | 可以登入 OpenClaw 主機的終端機 | 等一下要執行一次 `openclaw devices approve` |
| 0.5 | 知道 OpenClaw 執行帳號的家目錄 | 在 OpenClaw 主機執行 `echo $HOME`。Hostinger 範本通常是 `/data`，所以金鑰檔會在 `/data/.openclaw/workspace/` |

## 1. 建立邀請

1. 在平台建立代理人邀請（公司的成員／存取管理頁），把邀請網址交給 OpenClaw，請它讀邀請附帶的 `onboarding.txt` 照做。
2. 加入指示已經寫明三件事，OpenClaw 照做即可：
   - **不要修改自己的 gateway 設定**（`trustedProxies`、綁定位址、驗證方式），也不要自己開臨時隧道。
   - **保持裝置驗證開啟**，不要設定 `disableDeviceAuth`。
   - **API 金鑰存到固定位置**：`~/.openclaw/workspace/paperclip-claimed-api-key.json`。存在別處時，加入時要在 `agentDefaultsPayload.claimedApiKeyPath` 填入絕對路徑。

> 為什麼要特別交代：OpenClaw 自己改設定會觸發 gateway 重啟。部分代管主機（例如 Hostinger 的 OpenClaw 範本）的啟動程式**不會自動把 gateway 重新拉起來**，OpenClaw 會整個停住，後台一直卡在「Please wait」。

## 2. 核准加入申請

- 在平台核准 OpenClaw 送來的加入申請。
- 如果看到「**Agent "…" is already connected to this OpenClaw gateway**」：代表同一個 OpenClaw 之前已經接過。請先封存舊的代理人，或拒絕這筆申請。**不要**建立第二個代理人連到同一個 OpenClaw，兩個代理人會搶同一個 OpenClaw，任務狀態會亂掉。
- 核准後，OpenClaw 會用加入時拿到的一次性密碼換取平台 API 金鑰，並存到上面那個固定位置。

## 3. 核准裝置（只需要一次）

平台每個 OpenClaw 代理人都有自己的裝置金鑰（加入時自動產生）。第一次連線時，OpenClaw 會要求你核准這個裝置：

1. 到代理人設定頁按「測試連線」。
2. 如果結果顯示「OpenClaw is waiting for you to approve this agent's device」，照提示在 OpenClaw 主機執行：
   ```bash
   openclaw devices approve <requestId>
   ```
   Hostinger 範本要進容器執行：
   ```bash
   docker exec -it <openclaw 容器名稱> openclaw devices approve <requestId>
   ```
3. 再按一次「測試連線」，應出現「Gateway connect probe succeeded (signed with this agent's device key)」。

## 4. 驗收（全部通過才算接好）

| # | 動作 | 怎樣算成功 |
|---|---|---|
| 4.1 | 在平台主機執行健檢：`docker exec -i <平台容器名稱> node /app/scripts/openclaw-doctor.mjs` | 該代理人沒有 `FAIL`；`Summary` 的 FAIL 為 0 |
| 4.2 | 代理人設定頁按「儲存」，再跑一次 4.1 | 仍然 0 個 FAIL（確認存檔沒有把密碼存成遮罩字串） |
| 4.3 | 按「測試連線」 | 顯示 probe succeeded，沒有 missing scope 警告 |
| 4.4 | 指派一個測試任務給這個代理人 | 任務收到 OpenClaw 的回覆 |
| 4.5 | 請代理人「完成後把任務標成完成」 | 任務狀態由代理人自己改成完成（代表它讀得到 API 金鑰） |

健檢腳本只會列出設定名稱與 PASS／WARN／FAIL，**不會印出任何密碼或金鑰**，可以放心把輸出貼給支援人員。

## 5. 常見問題對照表

| 看到的現象 | 原因 | 處理方式 |
|---|---|---|
| 設定頁出現或健檢回報 `***REDACTED***` | 舊版存檔時把遮罩字串寫回資料庫（`zhtw.9` 已修正） | 重新填 gateway token；在 OpenClaw 以新的裝置金鑰重新核准一次 |
| `DECODER routines::unsupported`／錯誤碼 `openclaw_gateway_device_key_invalid` | 裝置金鑰不是有效的 PEM（常是被存成遮罩字串） | 產生新的 Ed25519 裝置金鑰寫入該代理人，再核准一次裝置 |
| `missing scope: operator.write`／錯誤碼 `openclaw_gateway_missing_scope` | 關掉了裝置驗證，或裝置核准時沒有給操作權限 | 取消勾選「Disable device auth」，重新核准裝置 |
| `pairing required`／錯誤碼 `openclaw_gateway_pairing_required` | 裝置還沒核准 | 照第 3 節執行 `openclaw devices approve` |
| 代理人能回覆，但不會自己把任務標成完成 | OpenClaw 找不到平台 API 金鑰檔 | 確認金鑰檔在 `~/.openclaw/workspace/paperclip-claimed-api-key.json`（`~`＝執行帳號的家目錄）；放在別處就在設定頁的「Claimed API key path」填入絕對路徑 |
| OpenClaw 後台卡在「Please wait」、gateway 沒有回應 | gateway 重啟後，代管主機的啟動程式沒把它拉回來 | `docker restart <openclaw 容器名稱>`；之後避免讓 OpenClaw 自行修改 gateway 設定 |
| 「測試連線」成功但派工失敗 | `zhtw.10` 以前的測試只檢查連得上，不檢查權限 | 升級到 `zhtw.10`，測試連線會用裝置金鑰簽名，並顯示實際取得的權限 |
| 同一個 OpenClaw 出現兩個代理人 | 重新邀請後又核准了一次 | 封存多出來的那一個；`zhtw.10` 起核准時會直接擋下 |
| 側欄「最近任務」按封存後還在 | 這裡的「封存」只是從**收件匣**封存，清單記的是這台瀏覽器最近開過的 5 個任務 | 要讓它消失：打開任務 →「⋯」→「隱藏此任務」 |

## 6. 給維運人員：健檢腳本的結束碼

| 結束碼 | 意思 |
|---|---|
| 0 | 沒有 FAIL（可能有 WARN） |
| 1 | 至少一個 FAIL |
| 2 | 連不上資料庫（外部資料庫請設定 `DATABASE_URL`） |

加上 `--json` 可輸出 JSON，方便接監控。
