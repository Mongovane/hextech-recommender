# HEXTECH 推荐官 · 海克斯大乱斗三选一决策

英雄联盟（国服）海克斯大乱斗的海克斯强化三选一推荐工具。

- **数据**：[RESG](https://resg.top)（国服大乱斗统计站），英雄专属海克斯胜率 / 平衡性 buff / 分级
- **决策**：[Typesafe jev](https://typesafe.ai) 做 choice / score / 冲突检测，无 Key 时自动降档为纯胜率规则（含小样本收缩）
- **识别**：截图 → Workers AI 视觉模型识别三卡片标题 → 模糊匹配标准名
- **形态**：Cloudflare Worker（网页 + API 二合一）+ 本地截屏热键工具（Python）

## 架构

```
游戏 PC（Windows）                    Cloudflare
┌──────────────┐                     ┌─────────────────────┐
│ capture/     │  截图 base64        │ worker/             │
│ F8 截屏识别   │ ────────────────▶ │  /api/ocr-recommend │
│ F9 记已选     │                   │    ├─ Workers AI OCR │
│ F10 换英雄    │  ◀──────────────── │    ├─ RESG 数据     │
└──────────────┘   推荐排序          │    └─ jev 决策      │
                                     │  / → 网页版（手机也能用）│
                                     └─────────────────────┘
```

Worker 看不到游戏屏幕，截屏必须在本地完成；Worker 只做数据 + 决策。

## 快速开始

### 1. 部署 Worker

**A. Dashboard 粘贴（最简单）**

```bash
cd worker && node build.mjs   # 生成 dist/worker.js（单文件）
```

Cloudflare dashboard → Workers → 从 Hello World 创建 → 编辑代码 → 粘贴 `dist/worker.js` → 部署。

**B. wrangler**

```bash
cd worker
npx wrangler login
npx wrangler secret put TYPESAFE_API_KEY   # 可选；不设则用纯胜率规则
npx wrangler secret put ACCESS_TOKEN       # 可选；设置后 /api/* 需要 ?token= 或 X-Token
npm run deploy
```

**环境变量 / 绑定**

| 名称 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `TYPESAFE_API_KEY` | Secret | 否 | jev API Key；不设则降档为胜率规则 |
| `ACCESS_TOKEN` | Secret | 否 | 设置后所有 `/api/*` 需鉴权（防公开滥用） |
| `AI` | Binding | 否 | Workers AI 绑定，`/api/ocr*` 需要 |

`GET /api/status` 可查看 jev / ocr 是否可用。

### 2. 本地截屏工具（Windows 游戏 PC）

```bash
cd capture
pip install -r requirements.txt
# 配置（环境变量或直接改文件顶部）
set HEXTECH_WORKER=https://你的worker.workers.dev
set HEXTECH_TOKEN=你的ACCESS_TOKEN   # Worker 没设 ACCESS_TOKEN 则留空
python lol_capture.py
```

| 热键 | 动作 |
|---|---|
| `F8` | 截屏当前三选一 → 识别 → 打印推荐排序 |
| `F9` | 把上次推荐项记为"本局已选"（下一轮参与协同评估） |
| `F10` | 重新设置英雄（优先从游戏 Live Client API 自动读） |

游戏建议用**无边框**模式；独占全屏可能截到黑屏。`CROP` 变量可按你的分辨率微调截图区域。

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

响应里 `degraded` 字段表示降档原因（`no-key` / `jev-error` / `conflict` / `low-confidence`）。

## 开发

```
worker/
├── src/          # Worker 源码（ESM 模块）
│   ├── index.js      # 路由
│   ├── core.js       # 纯函数（RESG 解析、state、jev 请求体）
│   ├── resg.js       # RESG 数据层（cf 边缘缓存）
│   ├── recommend.js  # 推荐逻辑
│   └── ocr.js        # Workers AI OCR
├── web/index.html    # 前端页面源码
└── build.mjs         # 打包 → dist/worker.js（单文件）
```

改完源码跑 `node build.mjs` 重新生成 `dist/worker.js` 再部署。`dist/` 不进 git。

## 数据与合规

- 数据来自 RESG（个人运营站），本项目只读、低频、按版本缓存，请勿高频请求。
- 本工具只做信息展示与推荐，**不代打、不自动选卡**，所有游戏内操作由玩家完成。
- 注意 Riot 关于 overlay 展示海克斯胜率的相关政策，公开发布前请自行确认合规边界。

## License

MIT
