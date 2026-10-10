// 构建脚本：src/*.js + web/index.html → dist/worker.js（单文件，dashboard 直接粘贴部署）
// 原理：core.js 是纯函数无外部依赖；各模块按依赖顺序拼接，去掉 import/export 关键字。
// 用法：node build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');

// 依赖顺序：core → resg → recommend → ocr → index
const order = ['src/core.js', 'src/resg.js', 'src/recommend.js', 'src/ocr.js', 'src/index.js'];
let out = '';
for (const f of order) {
  let code = read(f);
  code = code
    .replace(/^import\s+[^;]+;?\s*$/gm, '')          // 去掉 import 行
    .replace(/^export\s+default\s+/m, '__EXPORT_DEFAULT__') // 保留唯一的 export default
    .replace(/^export\s+(?=(async\s+function|function|const|let|class)\s)/gm, '');
  out += `\n// ===== ${f} =====\n` + code.trim() + '\n';
}
out = out.replace('__EXPORT_DEFAULT__', 'export default');

// 内联前端页面
const html = read('web/index.html');
if (!out.includes('__OVERLAY_HTML__')) throw new Error('src/index.js 缺少 __OVERLAY_HTML__ 占位符');
out = out.replace('__OVERLAY_HTML__', () => JSON.stringify(html));

const banner = `// 构建产物（node build.mjs 生成，不要手改）\n// 源码：src/*.js + web/index.html\n`;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist/worker.js'), banner + out);
console.log(`build ok: dist/worker.js (${Buffer.byteLength(banner + out)} bytes)`);
