# i18n-tools：建置期字串包裝機制

## 機制一句話

原始碼裡的 991 個 `.tsx`（＋ `.ts`）檔案永遠保持 pristine——一個字都不改。真正的翻譯是在
**build/dev-server 時**，由 `babel-plugin-i18n-wrap.mjs` 這個 Vite plugin 掃描每個檔案的
JSX 文字、白名單屬性字串、白名單物件屬性字串，把它們原地包成 `__t("...")`（key＝原文，
keyless 模式），再交給 `@vitejs/plugin-react` 繼續編譯。upstream 每週幾十個 commit 不會撞到
任何手改過的 TSX，因為根本沒有 TSX 被手改過。

## ⚠️ 與原始設計的重大差異（先讀這段）

原計畫是寫一個真正的「Babel plugin」，掛進 `@vitejs/plugin-react` 的 `babel.plugins` 選項。
這條路在本 repo 完全走不通，原因（已在 `babel-plugin-i18n-wrap.mjs` 檔頭詳細記錄）：

- `@vitejs/plugin-react@6.1.1` 已經**整個拿掉 Babel**，JSX/TSX 轉換改用 OXC（Rust）；讀它的
  `dist/index.d.ts` 可確認 `Options` 介面根本沒有 `babel` 這個欄位。
- 本 repo 釘的 `typescript@7.0.2` 是 TypeScript 官方的 Go 原生重寫預覽版，沒有經典的
  `ts.createSourceFile`／`ts.transform`／`ts.createPrinter` API，只有給 language-service 用的
  「unstable」RPC 介面，不適合拿來做同步的單檔原始碼轉換。
- 整個 workspace 沒有任何 `package.json` 直接宣告 `@babel/core`（或 `@babel/parser`／
  `@babel/types`／`@babel/generator`）——它們只是深埋在 pnpm store 裡、透過 Storybook 工具鏈
  （`react-docgen` 等）間接拉進來的 transitive dependency。

因此實際實作改用 **`@babel/parser`**（只需要 parser，不需要 core/traverse/generator）：
parse 出正確的節點位置 → 收集 `{start, end, replacement}` 編輯清單 → 直接在**原始字串**上做
span 級別的拼接替換（不整檔重印）。好處：沒動到的程式碼逐位元組不變，不會有 printer 造成的
格式漂移風險。`@babel/parser` 本身不是任何 `package.json` 的直接依賴，執行時透過
`resolveFromPnpmStore()` 從 pnpm 的 `.pnpm` 虛擬倉庫解析（見下方「已知限制」）。

## 三支腳本

```bash
# 掃描 ui/src/**/*.{ts,tsx}，寫出 source/strings.json（每個字串出現次數/種類/首次位置）
# 與 source/stats.json（總覽統計）。純讀取，不改任何檔案。
node ui/i18n-tools/extract.mjs

# 比對 source/strings.json 與 locales/zh-TW.json：已翻/未翻/字典裡多出來的 key（stale）、
# 簡體字殘留、{{placeholder}} 一致性。exit code 非 0 代表有簡體殘留或 placeholder 不符。
node ui/i18n-tools/check.mjs

# extract.mjs 與 check.mjs 共用的核心引擎；也是 Vite plugin 本體
# （`createI18nWrapVitePlugin`，已掛進 vite.config.ts 與 vitest.config.ts）。
# 一般不需要直接跑這支。
ui/i18n-tools/babel-plugin-i18n-wrap.mjs
```

## upstream sync 之後的 SOP

原始碼不用改。做兩件事：

1. `node ui/i18n-tools/extract.mjs` —— 重新掃描，`source/strings.json` 會反映新增/刪除的
   可翻譯字串。
2. `node ui/i18n-tools/check.mjs` —— 看「未翻」的數字漲了多少，決定要不要挑幾條加進
   `ui/src/i18n/locales/zh-TW.json`（keyless：key 就是英文原文，一字不改；value 是繁體中文）。

**不用做**：不用碰任何 `.tsx`／`.ts` 原始碼、不用重新跑 wrap（wrap 是 build 時自動發生的）。

## 機制細節

### 三種擷取規則

| kind | 位置 | 條件 |
|---|---|---|
| `jsx` | JSXText（`<div>這裡的文字</div>`） | 正規化後（JSX 標準的空白折疊演算法）至少含 2 個英文字母 |
| `attr` | 白名單屬性（`title`／`placeholder`／`label`／`aria-label` 等 19 個） | 字串值至少含 2 個英文字母 |
| `obj` | 白名單物件屬性 key（`label`／`title`／`description` 等 11 個） | 值以大寫字母開頭 **且**（含空白或長度 ≥12）**且**不含 `/`、`_`、`{` |
| `manual` | 既有手寫的 `t("...")` / `__t("...")` 呼叫 | 只用來讓 `check.mjs` 的覆蓋率統計不要誤判「stale」，**永遠不會被 wrap 或重複包裝** |

多行字串（含 `\n`）與含 `{{雙大括號}}` 的字串一律跳過——前者掃描全庫後發現幾乎都是塞在
`placeholder` 裡的 JSON/程式碼範例，後者是命名樣板（如 `{{issue.identifier}}-{{slug}}`），
兩者都不是要翻譯的自然語言。

### 為什麼是 `__t` 不是 `t`

避免跟元件內常見的 `const { t } = useTranslation();` 解構變數撞名。`__t` 從 `@/i18n` 匯入，
是一個**無狀態的純函式**（不是 hook），可以在模組頂層常數、非 React 函式裡直接呼叫。

### keyless 模式與語言切換

`i18next` 設定 `keySeparator: false, nsSeparator: false`：翻譯的 key 就是完整的英文原文字面，
不做 `a.b.c` 路徑解析。好處是不用為 ~7,000 個字串發明並維護一套合成 key；壞處（可接受）是
key 裡本身若剛好含 `.` 或 `:` 不會被誤判成路徑分隔符——因為根本沒有分隔符這回事。

某個 locale 沒有某個 key 的翻譯時，`i18next` 的預設行為就是把 key 原樣顯示出來——對 keyless
模式來說，這正好就是「顯示原始英文」，完全符合漸進式翻譯的需求，不用額外處理。

語言切換（`ui/src/components/LanguageSwitcher.tsx`，掛在帳號選單、`ThemeToggle` 旁邊）寫進
`localStorage["paperclip.locale"]` 後**整頁重新整理**——因為 `__t` 不是 hook，沒有辦法原地
讓所有已渲染的文字重新渲染。初始語言偵測順序：`localStorage` → `navigator.language`
（`zh-TW`/`zh-Hant*` → `zh-TW`；`zh*` → `zh-CN`；其餘取前兩碼比對已支援語言）→ 預設 `en`。
偵測邏輯全程做了 `typeof window/document/navigator/localStorage !== "undefined"` 防呆，因為
`@/i18n` 的 module-level 初始化程式碼在 vitest 預設的 `"node"` test environment（非 jsdom）
下也會被跑到——絕大多數元件測試檔一旦轉譯後都會自動 import `@/i18n`。

目前只有 `en`／`zh-TW` 有實際翻譯內容；其餘 38 個 bundled locale 檔案（`ar.json`／`ja.json`／
`fr.json`…）是空物件 `{}` 佔位符，`LanguageSwitcher` 也只列出這兩個，避免使用者切到一個
「切了但全部退回顯示英文」的語言誤以為壞掉。

## 已知限制

- **`@babel/parser` 解析靠 pnpm store 深路徑解析，不是宣告依賴**——如果未來某次
  `pnpm install` 讓 Babel 整條鏈從 workspace 消失（例如 Storybook 換掉 `react-docgen`），
  `resolveFromPnpmStore()` 會丟出清楚的錯誤訊息。修法：把 `@babel/parser` 加進
  `ui/package.json` 的 `devDependencies`（本次任務因「不准新增 dependency」而未這麼做）。
- **不處理模板字串**（`` `Hello ${name}` ``）——這類動態內容不在任務範圍內，需要人工用
  `t("Hello {{name}}", { name })` 這種帶插值的寫法手動改寫。
- **不處理已經是 `{"字串"}` 形式的 JSX 子節點表達式**（例如 `<span>{"already wrapped"}</span>`）
  ——這是刻意的：這類寫法通常代表作者有意繞開自動格式化或有特殊語意，擷取規則只認
  `JSXText`（沒有大括號包住的裸文字）。
- **物件屬性規則（`obj`，見 `OBJ_KEY_WHITELIST`）是三條規則裡最容易誤判的**——白名單 key
  名稱（`label`／`title`／`description`…）在非 UI 語境下也可能出現（例如某個資料表的欄位
  定義剛好叫 `label`）。目前的啟發式（大寫開頭＋含空白或夠長＋不含 `/_{`）在全庫掃描
  （`extract.mjs`）中沒有抓到明顯誤判，但發現新的誤判類別時，先加進
  `babel-plugin-i18n-wrap.mjs` 的 `qualifiesAsObjectValue()`／`qualifiesAsTranslatable()`，
  不要在下游（locale 檔／元件）繞過。
- **像 `arn:aws:secretsmanager:...` 這類技術識別碼**（出現在少數 `placeholder` 範例中）目前
  沒有專門的排除規則——風險很低（未翻譯時就是原樣顯示，不影響功能），但如果之後真的手動把
  這類字串誤譯成中文，畫面上會出現被翻譯過的範例代碼。發現時個別處理即可，不值得為了這種
  邊角案例加一條通用規則。

## README（繁中）同步

- `README.md` 是繁中版，`README.en.md` 是上游英文原文；`.gitattributes` 設定 `README.md merge=ours`。
- 新 clone 需先執行一次：`git config merge.ours.driver true`（否則合併時 `merge=ours` 不生效）。
- 每次同步上游後：`git show up/master:README.md > README.en.md`，再 `git diff HEAD~ -- README.en.md` 看上游改了什麼，人工補進 `README.md`。
