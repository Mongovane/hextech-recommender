# Electron 桌面悬浮层方案（先说明，不动手）

> **2026-10-14 状态更新**：fix69 已内置桌面端分发——Worker 提供 `/download/HEXTECH推荐官悬浮窗.exe`（透明置顶原生悬浮窗）+ `/download/hextech-overlay.bat` 一键启动脚本。本文档的调研结论仍有效，但 MVP 已有现成产物，先用现成的；Electron 自研套壳仅作为长期备选。

针对 10-12 对话里的两个需求：① 悬浮窗整体透明、视觉融合进游戏；② 悬浮球形态、需要时再展开。
浏览器 PiP 的三个硬天花板（已在对话里验证过）：标题栏去不掉、透明区域照样挡鼠标、没有"已打开窗口改大小"接口。
桌面端 overlay 能把这三个全解掉。

## 方案对比

| | Electron 自研套壳 | Overwolf 平台 | 维持浏览器 PiP |
|---|---|---|---|
| 透明融合（无边框+背景全透明） | ✅ 原生支持 | ✅ 原生支持 | ❌ 标题栏去不掉 |
| 点击穿透（透明区不挡游戏操作） | ✅ `setIgnoreMouseEvents` | ✅ `InputPassThrough` | ❌ 系统级限制，无解 |
| 悬浮球↔面板按需变形 | ✅ `setSize` 随时调，无闪烁无 teleport | ✅ | ❌ 只能关窗重开，位置会跳 |
| 出新卡自动展开（无手势） | ✅ 主进程直接调，不被拦截 | ✅ | ⚠️ 可能被浏览器拦截，不可靠 |
| 选窗步骤 | ✅ 自动按标题抓 LoL 窗口，零手动 | ✅ 游戏事件 API | ❌ 每次都要手动分享屏幕 |
| 代价 | 用户装一个 exe；多维护一个桌面工程；仅 Windows | 用户装 Overwolf 客户端；要走它的应用审核/上架流程 | 零代价 |
| 反作弊口径 | 见下"风险" | Blitz/Porofessor 同类，平台背书 | 同左（也是读屏） |

结论：只自己用的话，Electron 套壳是最轻的路——前端复用现有页面，后端零改动。

## MVP 设计（最小可行）

**核心思路**：Electron 窗口直接加载生产站 `https://hks.mongovanee.workers.dev/`。
页面里的 `/api/*` 都是相对路径，后端、OCR 流水线、推荐逻辑、持续监测定时器**一行不用改**；
Worker 以后怎么更新，桌面端自动跟着变。Electron 只解决三件事：窗口形态、点击穿透、免手动抓窗。

新增文件（全部在 `electron/` 下，不碰现有工程）：

```
electron/
  package.json        # electron + electron-builder
  main.js             # ~130 行：透明窗口 / 穿透 / 悬浮球变形 / 热键 / 抓窗 IPC
  preload.js          # ~25 行：只暴露 capture + setMode 两个 API（contextIsolation 保持开）
```

渲染层补丁（`worker/web/index.html`，约 60 行，四个挂载点）：

1. `startCapture()`（约 1002 行）：首行加分支——`window.electronAPI` 存在时走 Electron 抓窗，不再调 `getDisplayMedia`。**"选窗麻烦"这个痛点永久消失**：主进程用 `desktopCapturer` 按窗口标题自动匹配 LoL（` /league of legends/i`，匹配不到回退整屏）。
2. `grabFrame()`（约 1027 行）：加 Electron 分支——`electronAPI.grabGame()` 返回 PNG dataURL → 画到 canvas → 后面 `cropFrame` / `runOcr` / 自动监测链路原样复用。
3. `openPip()`（约 1123 行）：Electron 下不走 `documentPictureInPicture`，改为把同一套 pipbox HTML/CSS 直接渲染进主文档（overlay 模式，`body` 加 `overlay` class 复用现有 `.pip` 样式）。
4. `pipAlert()`（新卡提醒）：追加 `electronAPI.setMode('panel')`——主进程调 `setSize`，**不需要用户手势**，浏览器版"自动展开可能被拦截"的问题不存在。

主进程关键行为：

- 窗口：`frame:false, transparent:true, alwaysOnTop:'screen-saver', skipTaskbar:true`，启动尺寸 72×72（悬浮球）。
- 点击穿透：`setIgnoreMouseEvents(true, {forward:true})`——透明区鼠标直达游戏，球/按钮区域仍可点。
- 变形：点球 → `setSize(320,300)` 展开面板；再点收起 → 回 72×72。全程不关窗，无闪烁、无位置跳动。
- 全局热键（如 `Alt+Shift+H`）：一键收起/展开，游戏中盲操作。
- 出新卡：渲染层事件 → 主进程自动展开 + 保持原有金框闪烁/提示音。

main.js 骨架（示意，动手时再写全）：

```js
const { app, BrowserWindow, ipcMain, desktopCapturer, globalShortcut } = require('electron');
const path = require('path');
let win, mode = 'ball';
const SIZES = { ball: [72, 72], panel: [320, 300] };

function createWindow() {
  win = new BrowserWindow({
    width: 72, height: 72,   // 启动即悬浮球形态
    frame: false, transparent: true, backgroundColor: '#00000000',
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });   // 透明区点透
  win.loadURL('https://hks.mongovanee.workers.dev/?mode=overlay');
}
function setMode(m) {
  mode = m; const [w, h] = SIZES[m];
  win.setSize(w, h);
  win.setIgnoreMouseEvents(m === 'ball' ? false : true, { forward: true });
}
ipcMain.handle('set-mode', (_, m) => setMode(m));
ipcMain.handle('grab-game', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 1920, height: 1080 }
  });
  const hit = sources.find(s => /league of legends/i.test(s.name)) || sources.find(s => s.name === 'Entire Screen');
  return hit.thumbnail.toDataURL();   // 渲染层画到 canvas，走现有 OCR 链路
});
app.whenReady().then(() => {
  createWindow();
  globalShortcut.register('Alt+Shift+H', () => setMode(mode === 'ball' ? 'panel' : 'ball'));
});
```

preload.js：

```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  grabGame: () => ipcRenderer.invoke('grab-game'),
  setMode: (m) => ipcRenderer.invoke('set-mode', m),
});
```

## 测了什么 / 没测什么

**我在这台 Linux VM 上能验证的**：npm 依赖安装、main.js/preload.js 语法与启动流程、渲染层补丁与现有 `web/index.html` 合并无冲突（node 语法检查）、窗口创建/变形/IPC 逻辑走通。

**必须在你 Windows 真机上验证的**（我做不到，只能列出来给你当验收单）：
- `desktopCapturer` 能否抓到 LoL 对局窗口（国服客户端用无边框窗口模式一般可抓，全屏独占模式可能抓不到——这是最大的不确定项）；
- 点击穿透是否正常：游戏内点选、走位不受悬浮层影响；
- 悬浮球↔面板变形、全局热键、出新卡自动展开；
- electron-builder 打包出的 exe 在你机器上正常运行；
- OCR 识别率与浏览器版一致（同一套 tesseract 链路，预期一致，但要实测）。

## 风险与代价（诚实部分）

- **反作弊**：LoL 国服跑 Vanguard。方案本身不注入游戏进程、不读游戏内存，只是读屏幕像素+盖一个透明窗——和 Blitz/Overwolf 同类，也和现在的浏览器方案同风险等级。但自研工具没有官方背书，残余风险自担；介意的话 Overwolf 路线更稳。
- **维护成本**：多一个桌面端工程（不过渲染层和后端都复用，实际要维护的只有 `electron/` 下三个小文件+打包配置）。
- **仅 Windows**：国服 LoL 本来就只有 Windows 客户端，对你不是问题。
- **打包**：electron-builder 打 Windows 包，在 Linux 上需要 wine；更顺的是在你 Windows 机器上跑 `npm run dist`，一条命令。

## 需要你拍板

1. **按这个 MVP 开干**——我搭 `electron/` 工程（含上面四个渲染层挂载点），你在真机上按验收单验证；
2. **先缓**——继续用浏览器悬浮窗（1835 版已可用），以后再说；
3. **走 Overwolf**——我出 Overwolf 应用的对照方案。

工作量估计：方案 1 的首次可跑版本约 1–2 天（含打包），之后每次 Worker 更新桌面端零操作。
