# HEXTECH 推荐官 · 海克斯大乱斗三选一决策

英雄联盟（国服）海克斯大乱斗的海克斯强化三选一推荐工具。

- **数据**：[RESG](https://resg.top)（国服大乱斗统计站）为主，arammeta（MIT 开源台服众包）为备；装备静态走官方 Data Dragon
- **决策**：[Typesafe jev](https://typesafe.ai) 做 choice / score / 冲突检测，无 Key 时自动降档为纯胜率规则（含小样本收缩）
- **识别**：一键悬浮识别（屏幕共享 + Document PiP + Tesseract 本地 OCR，不耗 AI 额度）+ 持续监测自动跟随
- **形态**：Cloudflare Worker（网页 + API 二合一），单文件 `dist/worker.js` 直接粘贴部署

## 架构

```
游戏 PC（Chrome/Edge）                              Cloudflare
┌─────────────────────────┐                        ┌─────────────────────┐
│ 网页 →「一键悬浮识别」     │  屏幕共享（整个屏幕）    │ worker/             │
│  └─ 悬浮窗（Document PiP） │                        │  /api/recommend   │
│      ├─ 本地 OCR 识别三卡片 │ ── 海克斯名 ────────▶ │    ├─ RESG 数据   │
│      ├─ 选人界面自动识别英雄 │                        │    └─ jev 决策    │
│      └─ 持续监测（自动重识） │ ◀── 推荐排序 ──────── │  / → 网页版       │
└─────────────────────────┘                        └─────────────────────┘
```

核心链路全在浏览器本地完成（OCR 不走服务器）；Worker 只做数据 + 决策。

## 功能

### 一键悬浮识别
1. 点「一键悬浮识别」，在浏览器弹窗里选择**整个屏幕**（一次选择管全程）。
2. 弹出悬浮窗（画中画，常置顶，可拖到角落）。
3. 点「识别」或勾选「持续监测」即可。

### 持续监测（选人 4 秒 / 对局 8 秒）
- 勾选后自动轮询：出卡/刷新（卡片签名变化）自动重识推荐，无卡时等待下一轮。
- **选人阶段自动识别英雄**：Tesseract + 英雄名字典，中央大字加权。
- **换英雄跟随**：选人阶段换英雄，连续两轮识别一致后自动切换并 toast 提示，同时清空本局已选；手动在输入框指定的英雄优先级最高，永不被覆盖。
- 进对局后自动切到 8 秒/轮；静默监测不调用 AI 兜底。

### 悬浮窗
- LoL 赫克斯风格（深金边框、直角面板），可折叠（`−` 收成细条）。
- 英雄输入框：中文 / 称号 / 英文别名 / 拼音搜索，与主页同逻辑。
- 新卡高亮：发现新三选一时自动展开 + 金框闪烁 + 提示音（可静音）。
- 结果可点选记为「本局已选」，参与后续轮次协同评估。

### 识别说明
- 本地 OCR 优先（Tesseract.js，首次加载后缓存），不消耗 AI 额度。
- 卡片匹配为两阶段：严格匹配找 2 张后，在同一横带上放宽一档补第 3 张（游戏字体易错 2 字，如"吞噬灵魂"→"知叭灵魂"）。
- 手动模式本地没认全时，可走 AI 兜底（需配置 Workers AI 绑定）。

## 快速开始

### 1. 部署 Worker（Dashboard 粘贴，最简单）

```bash
cd worker && node build.mjs   # 生成 dist/worker.js（单文件）
```

1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → 点进你的 Worker（没有就 Create）
2. 右上角 **Edit code** → 全选删除原代码 → 把 `dist/worker.js` 全文粘贴进去 → **Save and Deploy**
3. 回到 Worker 页面 → **Settings**：
   - **Variables and Secrets** → Add variable：
     - `TYPESAFE_API_KEY`（选 Secret 类型；不设则用纯胜率规则）
     - `ACCESS_TOKEN`（Secret，可选；设置后所有 `/api/*` 需要 `?token=` 或 `X-Token` 头）
   - **Bindings** → Add binding → **AI** → 变量名严格填 `AI`（`/api/ocr*` 需要）
4. 每次改完 Secrets / Bindings 要 **Redeploy** 才生效
5. 验证：访问 `https://你的worker.workers.dev/api/status`，应返回 `{"jev":true/false,"ocr":true/false}`

部署后如页面还是旧版，`Ctrl+F5` 硬刷新（Worker 响应无缓存头，一般是浏览器缓存）。

### 2. 使用流程

1. 打开 Worker 网址，点「一键悬浮识别」，选择**整个屏幕**并分享。
2. 选人阶段：悬浮窗自动识别英雄（或手动输入，支持拼音）。
3. 勾选「持续监测」，进游戏后每轮三选一自动识别推荐。
4. 点推荐结果可记为已选；换英雄自动跟随切换。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 网页版 |
| GET | `/api/status` | `{jev, ocr}` 可用性 |
| GET | `/api/versions` | 版本列表 |
| GET | `/api/champions?version=` | 173 英雄（胜率/场次/分级/图标） |
| GET | `/api/augments?version=` | 211 海克斯（同上） |
| GET | `/api/champion-detail?name=` | 英雄详情：平衡 buff、热门海克斯 top5 |
| POST | `/api/recommend` | `{champion, augments:[], picked?, mode?}` → 排序推荐；`mode:"wr"` 强制纯胜率 |
| POST | `/api/ocr` | `{image\|images}` base64 → 三卡片识别 + 模糊匹配 |
| POST | `/api/ocr-recommend` | `{champion, image\|images, picked?, mode?}` → 一步出推荐 |
| GET | `/api/builds?name=` | 出装推荐：出门/核心/备选装、召唤师技能、技能加点、陷阱海克斯 |

响应里 `degraded` 字段表示降档原因（`no-key` / `jev-error` / `conflict` / `low-confidence`）。

**数据源**：RESG 为主；RESG 失败时 `/api/champions`、`/api/champion-detail` 自动降级为 arammeta（台服 LCU 众包，每日更新），前端显示"备用数据(台服)"标识。出装胜率以 arammeta 为主、cchappy 人工攻略为补充。Hexdata 永不作为自动数据源。

## 开发

```
worker/
├── src/          # Worker 后端源码（ESM 模块）
│   ├── index.js      # 路由（__OVERLAY_HTML__ 占位符内联前端）
│   ├── core.js       # 纯函数
│   ├── resg.js       # RESG 数据层（cf 边缘缓存）
│   ├── arammeta.js   # arammeta 备用源
│   ├── items.js      # 装备/ Data Dragon
│   ├── builds.js     # 出装逻辑
│   ├── recommend.js  # 推荐逻辑
│   └── ocr.js        # Workers AI OCR（手动模式兜底）
├── web/index.html    # 前端源码（一键悬浮识别 / PiP / 本地 OCR 全在这里）
└── build.mjs         # 打包 → dist/worker.js（单文件，dashboard 直接粘贴）
```

改完源码跑 `node build.mjs` 重新生成 `dist/worker.js` 再部署。`dist/` 不进 git。

`capture/lol_capture.py` 为旧版本地截屏热键工具（F8/F9/F10），一键悬浮识别已覆盖其场景，仅作备用保留。

## 数据与合规

- 数据来自 RESG（个人运营站），本项目只读、低频、按版本缓存，请勿高频请求。
- 本工具只做信息展示与推荐，**不代打、不自动选卡**，所有游戏内操作由玩家完成。
- 注意 Riot 关于 overlay 展示海克斯胜率的相关政策，公开发布前请自行确认合规边界。

## License

MIT

## 更新记录

- **2026-10-12**：一键悬浮识别全链路实测（生产 tesseract.js 5.1.1 + 两张实机截图）；OCR 两阶段匹配；悬浮窗 LoL 赫克斯风格重绘 + 折叠 + 新卡高亮；换英雄跟随；拼音搜索进悬浮窗；修 stopCapture 条件反转。
- **2026-10-11**：采用用户 v4 版本为新基准；一键悬浮识别（屏幕共享一次管全程）+ 选人自动识别英雄 + 持续监测。
- **2026-10-10**：重构为源码工程；RESG + arammeta 双源；出装胜率主源切 arammeta。
