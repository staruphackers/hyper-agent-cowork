# 先在 staging 驗收，再升級正式站（以 zhtw.13 為例）

這份是給 Hostinger VPS（Docker Compose 部署，見 `VPS-DEPLOY.md`）用的逐步指令。每一步都可以直接複製貼上。之後每次大版升級都可以照這份做，只要把版本號換掉。

- 新版映像：`ghcr.io/staruphackers/hyper-agent-cowork:2026.1026.0-zhtw.13`
- 舊版映像（回滾用）：`ghcr.io/staruphackers/hyper-agent-cowork:2026.1019.0-zhtw.12`
- 正式站目錄：`~/hyper-agent-cowork`（volume：`hyper-agent-cowork_hac-data`）
- staging 目錄：`~/hac-staging`（volume：`hac-staging_data`）

> **貼給任何人（包括 AI）看的輸出，若含金鑰、token、密碼，一律換成 `***`。**

## 整體流程

| 階段 | 用什麼資料 | 排程 | 目的 | 你要花的時間 |
|---|---|---|---|---|
| 0. 前置檢查 | — | — | 確認正式站不會被意外升級、主機資源夠 | 5 分鐘 |
| 1. 備份正式站 | 正式資料 | — | 回滾的唯一依據 | 5 分鐘（停機 1–3 分鐘） |
| 2. staging A | 正式資料的**副本** | **關閉** | 驗證遷移、舊資料、介面、翻譯；演練主金鑰搬移 | 40 分鐘 |
| 3. staging B | **空白**資料 | 開啟 | 驗證新增代理人、實際執行任務、登入、Paperclip Runner | 40 分鐘 |
| 4. 清掉 staging | — | — | 釋放資源、刪除副本 | 5 分鐘 |
| 5. 升級正式站 | 正式資料 | — | staging 都通過才做 | 15 分鐘 |

**為什麼 staging A 要關排程**：副本裡有你所有的代理人、例行工作和外部連線（Slack、GitHub、Email 等）。如果排程開著，staging 會以你的身分真的去執行任務、發訊息、留言，客戶可能會收到重複內容。關掉排程後，代理人不會自己開工。

**為什麼 staging B 用空白資料**：要實際跑任務才能驗證執行功能，但不能用正式資料去跑。空白資料裡只有你臨時建的測試代理人，不會碰到客戶。

---

## 0. 前置檢查

```bash
cd ~/hyper-agent-cowork
grep -n "image:" docker-compose.yml
free -h
df -h /
docker volume ls | grep hac-data
```

確認以下 4 點：

1. `image:` 是 `...:2026.1019.0-zhtw.12`（固定版本）。**如果是 `:latest`**，先改成固定版本，再繼續：
   ```bash
   sed -i 's|hyper-agent-cowork:latest|hyper-agent-cowork:2026.1019.0-zhtw.12|' docker-compose.yml
   grep -n "image:" docker-compose.yml
   ```
   這只改設定檔，不會重啟容器。之後只要執行 `docker compose up -d`，就會固定用 zhtw.12。
2. `free -h` 的 `available` 至少 3 GB。不夠的話，staging 改在離峰時段做，或先照 `VPS-DEPLOY.md` 第 9 節加 swap。
3. `df -h /` 剩餘空間至少是「資料 volume 大小 × 3」（備份一份、staging 副本一份、新映像約 2–3 GB）。
4. 有看到 `hyper-agent-cowork_hac-data`。名字不一樣的話，把下面指令裡的 volume 名稱都換成你的。

## 1. 備份正式站

```bash
cd ~/hyper-agent-cowork
docker compose stop
docker run --rm -v hyper-agent-cowork_hac-data:/data -v "$PWD":/backup alpine \
  tar czf "/backup/hac-backup-$(date +%F)-pre-zhtw13.tgz" -C /data .
docker compose start
ls -lh hac-backup-*-pre-zhtw13.tgz
cp .env ".env.backup-$(date +%F)" && chmod 600 ".env.backup-$(date +%F)"
```

驗證：`ls -lh` 看得到備份檔，而且大小不是 0。

⚠️ **這個備份檔同時含有「加密的帳號憑證」和「解密用的主金鑰」**（第 2.4 節會處理）。在主金鑰搬出來之前，這個檔案只能放在 VPS 上或你私人加密的地方，不要上傳到共用雲端硬碟。

## 2. staging A：正式資料副本、排程關閉

### 2.1 建立 staging 目錄

```bash
mkdir -p ~/hac-staging && cd ~/hac-staging
cp ~/hyper-agent-cowork/.env .env && chmod 600 .env
sed -i 's|^PAPERCLIP_PUBLIC_URL=.*|PAPERCLIP_PUBLIC_URL=http://localhost:3101|' .env
grep -n "PAPERCLIP_PUBLIC_URL" .env

cat > docker-compose.yml <<'YAML'
name: hac-staging
services:
  cowork:
    image: ghcr.io/staruphackers/hyper-agent-cowork:2026.1026.0-zhtw.13
    container_name: hac-staging
    restart: "no"
    pids_limit: 2048
    ports:
      - "127.0.0.1:3101:3100"
    env_file: .env
    environment:
      HOST: "0.0.0.0"
      PAPERCLIP_HOME: /paperclip
      SERVE_UI: "true"
      PAPERCLIP_MAX_CONCURRENT_RUNS: "1"
      # staging A：關閉排程，代理人不會自己開工
      HEARTBEAT_SCHEDULER_ENABLED: "false"
    volumes:
      - data:/paperclip
volumes:
  data:
YAML
```

### 2.2 把備份還原到 staging 的 volume

```bash
cd ~/hac-staging
docker volume create hac-staging_data
docker run --rm -v hac-staging_data:/data -v ~/hyper-agent-cowork:/backup:ro alpine \
  sh -c "cd /data && tar xzf /backup/hac-backup-$(date +%F)-pre-zhtw13.tgz"
docker run --rm -v hac-staging_data:/data alpine find /data -name master.key
```

驗證：最後一行要印出 `/data/instances/default/secrets/master.key`。**印出別的路徑或什麼都沒有，先停下來把輸出貼給我。**

> 備份不是今天做的，就把 `$(date +%F)` 換成備份檔上的日期。

### 2.3 啟動並驗收

```bash
cd ~/hac-staging
docker compose pull
docker compose up -d
docker compose logs -f --tail=200
```

看到 `listening` 或 `health` 字樣就按 Ctrl+C。log 裡應該會出現套用遷移的訊息。

在**你自己的電腦**開一個終端機，建立 SSH 通道（只有你連得到 staging，不對外開放）：

```bash
ssh -L 3101:127.0.0.1:3101 <你的 VPS 使用者>@<VPS IP>
```

不要關掉這個視窗，然後用瀏覽器打開 `http://localhost:3101`，用正式站的帳號登入。

逐項檢查（✅／❌ 都記下來）：

| # | 檢查 | 怎麼看 | 通過條件 |
|---|---|---|---|
| A1 | 健康檢查 | VPS 上執行 `curl -s http://127.0.0.1:3101/api/health` | 回應包含 `ok` 或 status 200 |
| A2 | 遷移數量正確 | `docker compose logs \| grep -i "pending migrations"` | 出現 `Applying 94 pending migrations`，而且後面的清單裡沒有 `0378_round_landau`（fork 自己的遷移已經套用過，不會重跑） |
| A3 | 舊資料都在 | 組織、代理人、任務、例行工作、成本頁 | 數量和正式站一樣 |
| A4 | 舊任務的對話紀錄 | 打開幾個最近的任務 | 留言、執行紀錄、文件都在 |
| A5 | 執行設定檔 | 有設定檔的代理人 → 設定頁 | 設定檔清單還在、能看到目前啟用哪一個 |
| A6 | 機密遮罩 | OpenClaw 代理人（有的話）→ 設定 | `devicePrivateKeyPem` 顯示為遮罩 |
| A7 | AI 連線 | 設定 → AI 連線 | 帳號都在、狀態正常（**先不要按重新登入**） |
| A8 | 繁中用語 | 導覽列、任務頁、代理人設定、收件匣、成本頁、新增代理人精靈 | 記下任何讀起來怪的字句（截圖最好） |

### 2.4 演練：把主金鑰搬出資料 volume（資安項目 S-1）

這一步只在 staging 演練，正式站之後另外找時間做。

```bash
cd ~/hac-staging
docker compose stop

# 1) 把主金鑰複製到 volume 外面，只有容器裡的 node 使用者（uid 1000）能讀
mkdir -p secrets && chmod 700 secrets
docker run --rm -v hac-staging_data:/data -v "$PWD/secrets":/out alpine \
  cp /data/instances/default/secrets/master.key /out/master.key
sudo chown 1000:1000 secrets/master.key && sudo chmod 400 secrets/master.key
ls -l secrets/

# 2) 讓容器改讀外面這一份（唯讀掛載）
cat > docker-compose.override.yml <<'YAML'
services:
  cowork:
    environment:
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: /run/hac-secrets/master.key
    volumes:
      - ./secrets/master.key:/run/hac-secrets/master.key:ro
YAML

# 3) 把 volume 裡那一份改名（不刪，演練失敗還能改回來）
docker run --rm -v hac-staging_data:/data alpine \
  mv /data/instances/default/secrets/master.key /data/instances/default/secrets/master.key.moved

docker compose up -d
docker compose logs --tail=100 | grep -i -E "master key|secrets" || true
```

驗證：

| # | 檢查 | 通過條件 |
|---|---|---|
| K1 | log | 沒有 `Secrets master key file is missing` 或 `Invalid ... master key` |
| K2 | 設定 → AI 連線 | 帳號狀態和 2.3 的 A7 一樣（代表憑證解得開） |
| K3 | 設定 → 機密（Secrets） | 機密清單都在，沒有出現解密錯誤 |

K1–K3 都通過，代表這個做法在正式站可行。任何一項失敗就把 log 貼給我（金鑰值不會出現在 log 裡，但貼之前還是先看一下）。演練失敗的話，這樣改回來：

```bash
docker compose stop
rm docker-compose.override.yml
docker run --rm -v hac-staging_data:/data alpine \
  mv /data/instances/default/secrets/master.key.moved /data/instances/default/secrets/master.key
docker compose up -d
```

## 3. staging B：空白資料、排程開啟

先把 staging A 的副本整個刪掉（包含 volume、主金鑰複本），再用全新的資料啟動。

```bash
cd ~/hac-staging
docker compose down -v
shred -u secrets/master.key 2>/dev/null || sudo shred -u secrets/master.key
rm -f docker-compose.override.yml

# 全新的密鑰，不沿用正式站的
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=.*|PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)|" .env
# 開啟排程
sed -i 's|HEARTBEAT_SCHEDULER_ENABLED: "false"|HEARTBEAT_SCHEDULER_ENABLED: "true"|' docker-compose.yml
grep -n "HEARTBEAT_SCHEDULER_ENABLED" docker-compose.yml

docker compose up -d
docker compose logs -f --tail=100
```

用同一條 SSH 通道打開 `http://localhost:3101`，照 `VPS-DEPLOY.md` 第 5 節認領管理員，建立一個測試組織（名字取「staging 測試」）。

| # | 檢查 | 怎麼做 | 通過條件 |
|---|---|---|---|
| B1 | 新增代理人精靈 | 建一個 Codex 代理人，選角色、職稱、主管 | 建立成功；角色、職稱、主管都有存進去 |
| B2 | Codex 裝置碼登入 | AI 連線 → 用 ChatGPT 帳號登入 | 畫面顯示驗證碼，授權後狀態變成已連線 |
| B3 | 實際執行 | 給 Codex 代理人一個小任務（例如「寫三句自我介紹」） | 任務完成，有執行紀錄 |
| B4 | **Paperclip Runner** | 看 B3 的執行紀錄是不是走 Paperclip Runner | 有跑完，沒有出現 Runner 啟動失敗 |
| B5 | 對話接續 | 在 B3 的任務留言「再加一句」 | 代理人接續上一輪內容，不是從頭開始 |
| B6 | Grok 登入（有用的話） | 同 B2 | 同 B2 |
| B7 | Claude 瀏覽器登入（有用的話） | AI 連線 → Claude → 貼上代碼 | 狀態變成已連線 |
| B8 | OpenCode | 用 API key 建一個 OpenCode 代理人 | 看得到 Zen／Go 方案標示，能跑一個小任務 |
| B9 | 切換執行框架 | 代理人有任務在跑的時候切換執行框架 | 會先詢問是否取消執行中的任務 |

**B4 最重要**：新版新增的代理人預設用 Paperclip Runner。B4 失敗的話，正式站升級後新建代理人時，要在精靈裡把 Runner 改回 legacy，或先不要升級，把錯誤訊息貼給我。

成本：B2–B8 會用到你的 AI 帳號。用訂閱帳號跑幾個小任務沒有額外費用；用 API key 的話，估計 US$1 以內。

## 4. 清掉 staging

```bash
cd ~/hac-staging
docker compose down -v
cd ~ && rm -rf ~/hac-staging
docker image prune -f
docker volume ls | grep hac-staging || echo "staging volume 已刪除"
```

另外在 AI 供應商的後台，把 staging B 登入產生的 session 或 token 撤銷（ChatGPT、Claude 的「已登入裝置」或 token 清單）。

## 5. 升級正式站（staging A、B 都通過才做）

挑一個沒有代理人在跑重要任務的時段。

```bash
cd ~/hyper-agent-cowork
# 距離第 1 步超過一天，或中間有新資料，就重做一次第 1 步的備份

sed -i 's|hyper-agent-cowork:2026.1019.0-zhtw.12|hyper-agent-cowork:2026.1026.0-zhtw.13|' docker-compose.yml
grep -n "image:" docker-compose.yml
docker compose pull
docker compose up -d
docker compose logs -f --tail=200
```

升級後馬上檢查：A1、A3、A7，再實際讓一個代理人跑一個小任務（同 B3）。

### 回滾（升級後有重大問題才做）

```bash
cd ~/hyper-agent-cowork
docker compose down
docker run --rm -v hyper-agent-cowork_hac-data:/data -v "$PWD":/backup:ro alpine \
  sh -c "find /data -mindepth 1 -delete && cd /data && tar xzf /backup/hac-backup-YYYY-MM-DD-pre-zhtw13.tgz"
sed -i 's|hyper-agent-cowork:2026.1026.0-zhtw.13|hyper-agent-cowork:2026.1019.0-zhtw.12|' docker-compose.yml
docker compose up -d
```

把 `YYYY-MM-DD` 換成備份檔的日期。回滾會讓資料回到備份那一刻，升級後產生的任務和留言都會不見。

## 6. 回報給我的格式

```text
0. 前置：image 原本是 ___；available ___ GB；磁碟剩 ___
1. 備份：檔名 ___，大小 ___
2. staging A：A1 ✅/❌ … A8 ✅/❌（不順的用語：___）
   主金鑰演練：K1 ✅/❌ K2 ✅/❌ K3 ✅/❌
3. staging B：B1 ✅/❌ … B9 ✅/❌（B4 錯誤訊息：___）
4. 清除：✅/❌
有 ❌ 的項目請附 log（金鑰、token 一律換成 ***）
```
