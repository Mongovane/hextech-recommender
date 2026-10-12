// Worker 入口：路由
import { recommend, championDetail } from './recommend.js';
import { ocrCards } from './ocr.js';
import { resgFetch, latestVersion, ico, champIcon, findByQuery } from './resg.js';
import { fetchBuilds } from './builds.js';
import { fetchArammeta, arammetaChampions, arammetaChampionDetail } from './arammeta.js';
import { cleanDesc } from './core.js';
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
  async fetch(req, env, ctx) {
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
        try {
          const v = url.searchParams.get('version') ?? (await latestVersion());
          const { items } = await resgFetch(`/versions/${v}/champions.js`);
          return json({ version: v, items: items.map((c) => ({ id: c.id, name: c.name, title: c.title, alias: c.alias, wr: c.wr, tm: c.tm, tier: c.tier, icon: champIcon(c.alias, ico(c.ip)) })) });
        } catch (e) {
          // 备用源：arammeta（台服众包）
          const am = await fetchArammeta(ctx);
          return json({ version: am.patch_prefix || '16.20', items: arammetaChampions(am), source: 'arammeta-backup' });
        }
      }
      if (url.pathname === '/api/augments') {
        const v = url.searchParams.get('version') ?? (await latestVersion());
        const { items } = await resgFetch(`/versions/${v}/augments.js`);
        return json({ version: v, items: items.map((a) => ({ id: a.id, name: a.name, wr: a.wr, tm: a.tm, tier: a.tier, icon: ico(a.ip), desc: cleanDesc(a.description) })) });
      }
      if (url.pathname === '/api/champion-detail') {
        const q = url.searchParams.get('name');
        if (!q) return json({ error: '需要 ?name=' }, 400);
        try {
          return json(await championDetail(q, url.searchParams.get('version')));
        } catch (e) {
          // 备用源：arammeta（台服众包），按数字 id / alias 匹配
          const am = await fetchArammeta(ctx);
          const v = url.searchParams.get('version') ?? (await latestVersion().catch(() => null));
          let numericId = null;
          try {
            const { items } = await resgFetch(`/versions/${v}/champions.js`);
            const ent = findByQuery(items, q, ['name', 'title', 'alias']);
            numericId = ent?.id ?? null;
          } catch { /* RESG 不可用时用 alias 直查 */ }
          if (numericId == null) {
            const hit = Object.entries(am.champs || {}).find(([, c]) =>
              [c.name_zh, c.name_en, c.alias].some((x) => String(x || '').toLowerCase() === String(q).trim().toLowerCase()));
            numericId = hit ? +hit[0] : null;
          }
          const d = numericId != null ? arammetaChampionDetail(am, numericId) : null;
          if (!d) return json({ error: 'champion not found (backup)' }, 404);
          return json(d);
        }
      }
      if (url.pathname === '/api/builds') {
        const q = url.searchParams.get('name');
        if (!q) return json({ error: '需要 ?name=' }, 400);
        try {
          const b = await fetchBuilds(q, ctx);
          return json(b ?? { none: true });
        } catch (e) {
          return json({ none: true, error: String(e.message || e) });
        }
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
