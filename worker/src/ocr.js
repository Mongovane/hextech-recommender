// OCR：Workers AI 视觉模型识别三卡片标题 + 模糊匹配标准海克斯名
import { resgFetch, latestVersion } from './resg.js';
// ---------- OCR ----------
export const OCR_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
export const dataUrl = (b64, mime = 'image/jpeg') => { const s = String(b64 || ''); return s.startsWith('data:') ? s : `data:${mime || 'image/jpeg'};base64,${s}`; };

export async function ocrImage(env, b64, mime) {
  if (!env.AI) throw new Error('未配置 AI binding：dashboard → Settings → Bindings → 添加 AI（变量名 AI），或 wrangler.toml 加 [ai] binding = "AI"');
  const res = await env.AI.run(OCR_MODEL, {
    messages: [
      { role: 'system', content: '你是游戏界面文字识别器。只输出 JSON，不要解释。' },
      { role: 'user', content: [
        { type: 'text', text: '图片是英雄联盟海克斯大乱斗的三选一海克斯卡片界面，卡片从左到右排列。识别每张卡片的标题文字，按从左到右顺序输出 JSON：{"cards": ["左卡标题", "中卡标题", "右卡标题"]}。只输出 JSON，不要其他文字。' },
        { type: 'image_url', image_url: { url: dataUrl(b64, mime) } },
      ] },
    ],
    max_tokens: 200, temperature: 0,
  });
  const raw = res?.response ?? res?.result?.response ?? '';
  const obj = typeof raw === 'object' && raw ? raw : null;
  let parsed = obj;
  if (!parsed) {
    const m = String(raw).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('OCR 模型返回无法解析：' + String(raw).slice(0, 120));
    parsed = JSON.parse(m[0]);
  }
  const cards = parsed.cards ?? parsed.titles ?? [];
  if (!Array.isArray(cards)) throw new Error('OCR 返回格式异常');
  return cards.map((c) => String(c ?? '').trim()).filter(Boolean);
}

export const normName = (s) => String(s ?? '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
export function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
export function sim(a, b) {
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 2 && l.includes(s) && s.length / l.length >= 0.5) return 0.9; // 原版单字也能 0.95 误配
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}
export function matchAugment(ocrText, augItems) {
  const n = normName(ocrText);
  if (!n) return { ocr: ocrText, matched: null, score: 0 };
  let best = null, bestScore = 0;
  for (const a of augItems) {
    const s = sim(normName(a.name), n);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return { ocr: ocrText, matched: bestScore >= 0.5 ? best.name : null, score: +bestScore.toFixed(3) };
}

export async function ocrCards(body, env) {
  const v = body.version ?? (await latestVersion());
  const { items } = await resgFetch(`/versions/${v}/augments.js`);
  let texts;
  if (Array.isArray(body.images) && body.images.length) {
    texts = [];
    for (const img of body.images.slice(0, 3)) texts.push((await ocrImage(env, img, body.mime))[0] ?? '');
  } else if (body.image) texts = await ocrImage(env, body.image, body.mime);
  else throw new Error('需要 {image} 或 {images:[...]}（base64 图片）');
  const cards = texts.slice(0, 3).map((t) => matchAugment(t, items));
  // 去重：两张卡匹配到同一个海克斯时，只保留分高的
  const best = new Map();
  cards.forEach((c, i) => { if (c.matched && (!best.has(c.matched) || cards[best.get(c.matched)].score < c.score)) best.set(c.matched, i); });
  cards.forEach((c, i) => { if (c.matched && best.get(c.matched) !== i) c.matched = null; });
  return { version: v, cards };
}
