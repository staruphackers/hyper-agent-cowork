# 公開發行版與私有外掛的分工

2026-10-26 拍板：`staruphackers/hyper-agent-cowork` 維持**公開**，作為 Paperclip 的台灣繁中發行版；商業用途或不適合公開的東西，放在另外的**私有 repo**。

## 為什麼這樣分

- **成本**：公開 repo 的 GitHub Actions（含 arm64）和 GHCR 公開映像都免費。整個 repo 改私有的話，以現在的 CI 規模，每月大約要多付 US$60–160 的 Actions 費用，另外還有私有映像的儲存費，VPS 也要多放一組拉映像用的 token。
- **授權**：上游是 MIT 授權。公開或私有使用都可以，但要保留 `LICENSE` 和原本的版權聲明。
- **技術**：Paperclip 支援從外部安裝外掛，所以商業功能可以做成獨立的外掛，不用改公開的主程式。

## 什麼放哪裡

| 公開：`staruphackers/hyper-agent-cowork` | 私有：例如 `staruphackers/hac-private-plugins` |
|---|---|
| 繁中翻譯、詞彙表 | 商業化的外掛（例如 Phase 2 的 AI 路由外掛） |
| 穩定性與相容性修正、通用功能 | 客戶專屬設定、範本、提示詞 |
| 部署、升級、staging 文件 | 報價、交付、客戶名單等任何客戶資料 |
| 不含個人或客戶資訊的開發計畫 | 含帳號用法、商業判斷的計畫與決策紀錄 |
| 外掛要用到的通用 core 掛鉤（hook） | 與 Kimi_OS、Obsidian 的整合 |

不確定放哪裡時，先放私有，之後確定可以公開再搬過去。私有搬到公開很容易，公開的內容一旦被看過或複製，就收不回來了。

## 公開 repo 絕對不能放

- 金鑰、token、密碼、`.env`、主金鑰、備份檔（不管有沒有加密）
- 客戶名稱、客戶網域、客戶資料、真實的任務內容
- VPS 的 IP、主機名稱、SSH 帳號
- 個人 Email、電話、地址

已經推上公開 repo 的內容，就算之後刪掉，git 歷史裡還是找得到。萬一不小心推上去：金鑰類的要**立刻撤銷並重新產生**；其他資料先停止推送，再評估要不要改寫歷史，這是高風險操作，要先討論。

## 私有外掛怎麼開發和部署

1. **SDK 版本**：外掛依賴 `@paperclipai/plugin-sdk`，SDK 又依賴同一個 workspace 裡的 `@paperclipai/shared`。npm 上的版本可能比這個 fork 舊（例如 AI 連線池的 `onRouteAiConnection` 是 2026-10 才加的）。做法是在私有 repo 用 git submodule 引入這個公開 repo，固定在對應的版本 tag（例如 `v2026.1026.0-zhtw.13`），外掛透過 pnpm workspace 直接使用裡面的 SDK 和 shared。公開發行版升級時，submodule 也跟著改到新的 tag。
2. **測試**：外掛自己的單元測試用 SDK 的 `@paperclipai/plugin-sdk/testing`。需要真正的 server 才能測的整合測試，放在公開 repo，而且只測通用的 core 行為。
3. **部署到 VPS**：先在私有 repo 建置好外掛，把建置結果複製進資料 volume（例如 `/paperclip/plugins/<外掛名稱>`），再用絕對路徑安裝（見 `doc/plugins/LOCAL_PLUGIN_DEVELOPMENT.md`）。這樣不需要私有 npm registry，VPS 上也不用多放 token。
4. **升級**：公開發行版每升一版，私有外掛就要用新版 SDK 重新跑一次測試，通過了才部署。

## Git 提交身分

公開 repo 的 commit 請用 GitHub 的 noreply Email（`<id>+<帳號>@users.noreply.github.com`），不要用個人 Email。設定方式：

```bash
git config user.email "229493998+staruphackers@users.noreply.github.com"
```
