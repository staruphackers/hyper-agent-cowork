# 把 Hyper Agent Cowork 部署到自己的 VPS（Docker）

這份文件帶你從一台全新的 Ubuntu VPS，到能用網址登入、介面是繁體中文、agent 可以開工的 Hyper Agent Cowork。
全程只用 Docker 映像 `ghcr.io/staruphackers/hyper-agent-cowork`，不需要在 VPS 上裝 Node.js 或 pnpm。

> 本平台是上游 [Paperclip](https://github.com/paperclipai/paperclip) 的繁中發行版，**執行環境與環境變數都和上游相同**，
> 遇到本文沒寫到的進階設定，可直接對照上游文件 [`doc/DOCKER.md`](../DOCKER.md) 與 [`doc/DEPLOYMENT-MODES.md`](../DEPLOYMENT-MODES.md)。

## 0. 先決定兩件事

### 0.1 主機規格

| 項目 | 建議 | 說明 |
| --- | --- | --- |
| 作業系統 | Ubuntu 22.04 / 24.04 LTS | 本文指令以 Ubuntu 為準 |
| CPU / RAM | 2 vCPU / 4 GB 起 | agent（Claude Code、Codex CLI）是在容器內執行的，1 vCPU / 2 GB 也能跑，但同時跑多個 agent 會吃緊 |
| 磁碟 | 40 GB SSD 起 | 資料庫、上傳檔、agent 工作區都在同一個 volume |
| 費用參考 | 每月約 USD 6–24 | 一般 VPS 商（Hetzner、Vultr、Linode、DigitalOcean）的 2 vCPU / 4 GB 方案；模型 API 費用另計 |

### 0.2 存取方式（二選一）

| 方案 | 適合誰 | 網址 | 安全性 |
| --- | --- | --- | --- |
| **A. Tailscale 私網（推薦新手）** | 只有你或少數人用、不需要對外 webhook | `https://<主機名>.<tailnet>.ts.net` | 不開公網 port，最安全 |
| **B. 公網網域＋Caddy HTTPS** | 要從任何地方登入、要接 Slack／GitHub webhook | `https://cowork.你的網域.com` | 需要防火牆、關閉自由註冊 |
| **C. GitHub 原始碼安裝（不用 Docker）** | 不想跑 Docker、或要直接改程式碼 | 同 A 或 B | 要自備 Node 24＋Rust，升級要重新建置 |

兩個方案的容器設定幾乎一樣，差別只在「誰站在 3100 port 前面」與 `PAPERCLIP_PUBLIC_URL` 填什麼。

## 1. 安裝 Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
docker --version && docker compose version
```

## 2. 建立設定目錄與 `.env`

```bash
mkdir -p ~/hyper-agent-cowork && cd ~/hyper-agent-cowork

cat > .env <<'ENV'
# ── 必填：session 簽章密鑰（用 openssl rand -hex 32 產生，之後不要再改）──
BETTER_AUTH_SECRET=請換成openssl產生的64碼
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=請換成另一組openssl產生的64碼

# ── 使用者實際打開的網址（含 https://，不要有結尾斜線）──
PAPERCLIP_PUBLIC_URL=https://cowork.example.com

# ── 部署模式：authenticated = 需要登入 ──
PAPERCLIP_DEPLOYMENT_MODE=authenticated
# 第一次啟動先用 private（可以在瀏覽器認領第一個管理員），設定完再改 public
PAPERCLIP_DEPLOYMENT_EXPOSURE=private

# ── 前面有反向代理（Caddy／Nginx／Tailscale Serve）時，信任 1 層代理 ──
TRUST_PROXY=1

# ── 模型金鑰（選填；也可以之後在平台的 Secrets 頁面設定，或改綁訂閱帳號）──
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
ENV

# 自動填入兩組密鑰
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" .env
sed -i "s|^PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=.*|PAPERCLIP_TOOL_ACTION_SIGNING_SECRET=$(openssl rand -hex 32)|" .env
chmod 600 .env
```

`PAPERCLIP_PUBLIC_URL` 是登入、OAuth 回呼、允許的主機名（hostname allowlist）的唯一來源，**一定要跟你真正打開的網址一模一樣**，否則會出現「Missing Host header」或登入後一直被踢回登入頁。

## 3. `docker-compose.yml`

```yaml
services:
  cowork:
    image: ghcr.io/staruphackers/hyper-agent-cowork:latest
    container_name: hyper-agent-cowork
    restart: unless-stopped
    # 上限 2048 個行程：agent 失控時容器自己倒，不會拖垮整台主機
    pids_limit: 2048
    ports:
      # 只綁在本機 127.0.0.1，對外一律走 Caddy 或 Tailscale，不要直接開 3100
      - "127.0.0.1:3100:3100"
    env_file: .env
    environment:
      HOST: "0.0.0.0"
      PAPERCLIP_HOME: /paperclip
      SERVE_UI: "true"
    volumes:
      # 內嵌 PostgreSQL、上傳檔、secrets 主金鑰、agent 工作區全部在這個 volume
      - hac-data:/paperclip

volumes:
  hac-data:
```

正式環境建議把 `latest` 換成固定版本（例如 `:2026.925.0-zhtw.1`），升級時自己改 tag，避免某次 `pull` 意外升級。

## 4A. 方案 A：Tailscale 私網

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
# 在 tailnet 內提供 HTTPS（憑證由 Tailscale 自動簽）
sudo tailscale serve --bg 3100
tailscale status   # 記下 <主機名>.<tailnet>.ts.net
```

把 `.env` 的 `PAPERCLIP_PUBLIC_URL` 改成 `https://<主機名>.<tailnet>.ts.net`，然後跳到第 5 節。手機裝 Tailscale App 也能連。

## 4B. 方案 B：公網網域＋Caddy

1. 到 DNS 加一筆 A 紀錄：`cowork.你的網域.com → VPS 的 IP`。
2. 安裝 Caddy 並設定反向代理（Caddy 會自動申請 Let's Encrypt 憑證）：

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

sudo tee /etc/caddy/Caddyfile <<'CADDY'
cowork.example.com {
    reverse_proxy 127.0.0.1:3100
}
CADDY
sudo systemctl reload caddy
```

3. 防火牆只開 SSH、80、443：

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
sudo ufw status
```

3100 因為只綁 `127.0.0.1`，從外面本來就連不到。

## 4C. 方案 C：從 GitHub 原始碼安裝（不用 Docker，進階）

適合不想跑 Docker、或要在同一台機器上直接改程式碼的人。缺點是要自備建置環境，而且升級要重新建置一次。

```bash
# 1. 建置工具：Node.js 24、Rust、基本編譯器
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs build-essential pkg-config git
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source "$HOME/.cargo/env"

# 2. 從本 fork 的 tag 安裝（會在本機建置，4 GB RAM 以上，約 15–25 分鐘）
npx --registry https://registry.npmjs.org paperclipai install \
  --repo staruphackers/hyper-agent-cowork \
  --ref v2026.925.0-zhtw.1

# 3. 初始化並安裝成系統服務（互動式：選「Private network」或「Custom」並填公開網址）
paperclipai onboard
paperclipai service install   # 之後用 paperclipai service status / restart
```

- 反向代理與防火牆做法與方案 B 相同（Caddy 指到 `127.0.0.1:3100`）。
- 升級：`paperclipai update --repo staruphackers/hyper-agent-cowork --ref <新 tag>`，會先自動備份資料庫再切換；`paperclipai update --rollback` 可回復。
- 資料在 `~/.paperclip/`，備份請用 `paperclipai db:backup`。
- 安裝 git ref 等於在你的機器上執行該版本的建置腳本，請只安裝你信任的 tag。

## 5. 啟動並建立第一個管理員

```bash
cd ~/hyper-agent-cowork
docker compose pull
docker compose up -d
docker compose logs -f --tail=100     # 看到 listening / health 字樣即可 Ctrl+C
curl -s http://127.0.0.1:3100/api/health
```

1. 用瀏覽器打開 `PAPERCLIP_PUBLIC_URL`。
2. 註冊帳號（第一個帳號）。
3. 在設定畫面按 **Claim this instance（認領此執行個體）**，這個帳號就成為 instance admin，接著進入建立組織的引導流程。
4. 開啟 **帳號選單 → 語言 → 繁體中文**，頁面重新整理後就是繁中介面。

> 「在瀏覽器認領」只在 `PAPERCLIP_DEPLOYMENT_EXPOSURE=private` 時開放，這也是為什麼第一次啟動要用 private。
> 在你完成認領之前，任何能打開這個網址的人都能搶先註冊並認領，所以**先啟動、馬上認領**，不要放著過夜。

### 5.1 認領完成後改成正式設定（方案 B 必做）

```bash
sed -i 's/^PAPERCLIP_DEPLOYMENT_EXPOSURE=.*/PAPERCLIP_DEPLOYMENT_EXPOSURE=public/' .env
echo 'PAPERCLIP_AUTH_DISABLE_SIGN_UP=true' >> .env     # 關閉自由註冊，之後用邀請加人
docker compose up -d                                   # 會用新環境變數重建容器
```

`public` 模式會開啟登入頻率限制與較嚴格的部署檢查；方案 A（Tailscale）維持 `private` 即可。

## 6. 讓 agent 用你的 Claude／Codex 訂閱（不用 API key）

平台新增 agent 時，畫面會給你一段要在容器內執行的登入指令。**一定要以 `node` 使用者執行**，例如綁 Codex：

```bash
docker exec -it -u node hyper-agent-cowork bash -lc "export CODEX_HOME=<畫面給的路徑> && mkdir -p \$CODEX_HOME && codex -c 'cli_auth_credentials_store=\"file\"' login --device-auth"
```

Claude 的做法相同：`docker exec -it -u node hyper-agent-cowork bash -lc "<畫面給的指令>"`。
用 root 進容器登入的話，憑證檔會是 root 的，平台實際跑 agent 的 `node` 使用者讀不到，就會出現權限錯誤。

## 7. 升級版本

```bash
cd ~/hyper-agent-cowork
docker compose pull            # 抓新映像（latest 或你固定的 tag）
docker compose up -d           # 重建容器；資料庫遷移會在啟動時自動執行
docker image prune -f          # 清掉舊映像
```

升級前先做一次第 8 節的備份。本 fork 的版本號格式是 `v<上游版本>-zhtw.<序號>`，release 說明會標註對應的上游 commit。

## 8. 備份與還原

資料庫是容器內嵌的 PostgreSQL，**停機備份最保險**：

```bash
cd ~/hyper-agent-cowork
docker compose stop
docker run --rm -v hac-data:/data -v "$PWD":/backup alpine \
  tar czf "/backup/hac-backup-$(date +%F).tgz" -C /data .
docker compose start
```

還原到一台新機器：

```bash
docker volume create hac-data
docker run --rm -v hac-data:/data -v "$PWD":/backup alpine \
  sh -c "cd /data && tar xzf /backup/hac-backup-YYYY-MM-DD.tgz"
docker compose up -d
```

建議用 cron 每天凌晨跑一次備份並把 `.tgz` 同步到物件儲存（例如 Cloudflare R2、S3、Google Drive）。`.env` 也要一起備份，`BETTER_AUTH_SECRET` 遺失會讓所有人的登入 session 失效。

## 9. 常見問題

| 症狀 | 原因與處理 |
| --- | --- |
| 打開網址出現 `Missing Host header` 或 hostname 不在允許清單 | `PAPERCLIP_PUBLIC_URL` 和實際網址不一致。改正後 `docker compose up -d`；若需要多個網址，加 `PAPERCLIP_ALLOWED_HOSTNAMES=a.example.com,b.example.com` |
| 登入後又跳回登入頁、或 OAuth 回呼失敗 | 網址少了 `https://`、或 Caddy 前面又有一層 Cloudflare Proxy 卻沒設 `TRUST_PROXY`。同一台主機只有 Caddy 時 `TRUST_PROXY=1` 即可 |
| 認領按鈕不見了 | `PAPERCLIP_DEPLOYMENT_EXPOSURE` 已經是 `public`。先改回 `private` 認領，再改回 `public` |
| 容器一直重啟、log 出現 `EACCES /paperclip` | volume 權限問題。entrypoint 會自動 `chown`；若你改用 bind mount，請確認目錄可由 UID 1000 寫入 |
| agent 一直「權限錯誤」 | 訂閱登入是用 root 做的（第 6 節），請以 `-u node` 重做 |
| agent 跑到一半被殺 | RAM 不足。加記憶體或先加 swap：`sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` |
| 想確認服務活著 | `curl -s http://127.0.0.1:3100/api/health` |

## 10. 上線前檢查清單

- [ ] `.env` 權限 600，沒有進任何 git repo
- [ ] 3100 只綁 `127.0.0.1`（或只在 Tailscale 內）
- [ ] 第一個管理員已認領，且已設定 `PAPERCLIP_AUTH_DISABLE_SIGN_UP=true`（方案 B）
- [ ] `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`（方案 B）／`private`（方案 A）
- [ ] 防火牆只開 22、80、443
- [ ] 備份 cron 已設定並實際還原測試過一次
- [ ] 映像固定到版本 tag，升級走第 7 節流程
- [ ] agent 預算上限已在平台設定（避免 API 費用失控）
