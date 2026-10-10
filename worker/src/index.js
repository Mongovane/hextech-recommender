// Worker 入口：路由
import { recommend, championDetail } from './recommend.js';
import { ocrCards } from './ocr.js';
import { resgFetch, latestVersion, ico } from './resg.js';
// 由 build.mjs 内联 web/index.html 生成
const OVERLAY_HTML = __OVERLAY_HTML__;
// Cloudflare Worker：RESG 数据 + jev 决策 + OCR（单文件，直接粘贴/部署）
// 环境变量：TYPESAFE_API_KEY（secret，可选）  ACCESS_TOKEN（secret，可选，设置后访问 /api/* 需 ?token= 或 X-Token）
// 绑定：AI（OCR 用，可选）
export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Token',
};
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      if (url.pathname === '/') return new Response(OVERLAY_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

      if (url.pathname.startsWith('/api/') && env.ACCESS_TOKEN) {
        const t = req.headers.get('X-Token') || url.searchParams.get('token');
        if (t !== env.ACCESS_TOKEN) return json({ error: 'unauthorized' }, 401);
      }

      if (url.pathname === '/api/status') return json({ jev: !!env.TYPESAFE_API_KEY, ocr: !!env.AI });
      if (url.pathname === '/api/versions') return json(await resgFetch('/versions.js'));
      if (url.pathname === '/api/champions') {
        const v = url.searchParams.get('version') ?? (await latestVersion());
        const { items } = await resgFetch(`/versions/${v}/champions.js`);
        return json({ version: v, items: items.map((c) => ({ id: c.id, name: c.name, title: c.title, alias: c.alias, wr: c.wr, tm: c.tm, tier: c.tier, icon: ico(c.ip) })) });
      }
      if (url.pathname === '/api/augments') {
        const v = url.searchParams.get('version') ?? (await latestVersion());
        const { items } = await resgFetch(`/versions/${v}/augments.js`);
        return json({ version: v, items: items.map((a) => ({ id: a.id, name: a.name, wr: a.wr, tm: a.tm, tier: a.tier, icon: ico(a.ip) })) });
      }
      if (url.pathname === '/api/champion-detail') {
        const q = url.searchParams.get('name');
        if (!q) return json({ error: '需要 ?name=' }, 400);
        return json(await championDetail(q, url.searchParams.get('version')));
      }
      if (url.pathname === '/api/recommend' && req.method === 'POST') {
        const body = await req.json();
        if (!body.champion || !Array.isArray(body.augments) || body.augments.length === 0) return json({ error: '需要 {champion, augments:[...]}' }, 400);
        return json(await recommend(body, env));
      }
      if (url.pathname === '/api/ocr' && req.method === 'POST') return json(await ocrCards(await req.json(), env));
      if (url.pathname === '/api/ocr-recommend' && req.method === 'POST') {
        const body = await req.json();
        if (!body.champion) return json({ error: '需要 {champion, image|images}' }, 400);
        const { version, cards } = await ocrCards(body, env);
        const names = cards.map((c) => c.matched).filter(Boolean);
        const failed = cards.filter((c) => !c.matched).map((c) => c.ocr);
        if (names.length < 2) return json({ version, cards, error: `只识别出 ${names.length} 张卡片（${failed.join('、') || '无'} 匹配失败），请手动输入` }, 400);
        const rec = await recommend({ champion: body.champion, augments: names, version, picked: body.picked ?? [], mode: body.mode }, env);
        return json({ version, cards, recommend: rec });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};
