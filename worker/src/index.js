import { recommend, championDetail } from './recommend.js';
import { ocrCards } from './ocr.js';
import { resgFetch, latestVersion, ico, champIcon, findByQuery } from './resg.js';
import { fetchBuilds } from './arammayhem.js';
import { fetchArammeta, arammetaChampions, arammetaChampionDetail } from './arammeta.js';
import { cleanDesc } from './core.js';
import { DESKTOP_EXE_B64, DESKTOP_BAT_TPL, FAVICON_SVG, TOUCH_SVG } from './assets.js';
// Worker 入口：路由






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
      if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.svg') {
        return new Response(FAVICON_SVG, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...cors } });
      }
      if (url.pathname.startsWith('/apple-touch-icon')) {
        return new Response(TOUCH_SVG, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ...cors } });
      }
      if (url.pathname === '/download/hextech-overlay.exe' || url.pathname === '/download/HEXTECH推荐官悬浮窗.exe') {
        const binStr = atob(DESKTOP_EXE_B64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        return new Response(bytes, {
          headers: {
            'Content-Type': 'application/vnd.microsoft.portable-executable',
            'Content-Disposition': 'attachment; filename="HEXTECH_Overlay.exe"; filename*=UTF-8\'\'HEXTECH%E6%8E%A8%E8%8D%90%E5%AE%98%E6%82%AC%E6%B5%AE%E7%AA%97.exe',
            ...cors,
          },
        });
      }
      if (url.pathname === '/download/hextech-overlay.bat') {
        const origin = url.origin;
        const body = DESKTOP_BAT_TPL.replace(/__APP_ORIGIN__/g, origin).replace(/\r?\n/g, '\r\n');
        return new Response(body, {
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="HEXTECH_Overlay_Launcher.bat"',
            ...cors,
          },
        });
      }

      if (url.pathname.startsWith('/api/') && env.ACCESS_TOKEN) {
        const t = req.headers.get('X-Token') || url.searchParams.get('token');
        if (t !== env.ACCESS_TOKEN) return json({ error: 'unauthorized' }, 401);
      }

      if (url.pathname === '/api/status') return json({ jev: !!env.TYPESAFE_API_KEY, ocr: !!env.AI });
      if (url.pathname === '/api/versions') {
        try { return json(await resgFetch('/versions.js')); }
        catch {
          try { const am = await fetchArammeta(ctx); return json([{ version: am.patch_prefix || '16.20' }]); }
          catch { return json([{ version: '16.20' }]); }
        }
      }
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
        try {
          const v = url.searchParams.get('version') ?? (await latestVersion());
          const { items } = await resgFetch(`/versions/${v}/augments.js`);
          return json({ version: v, items: items.map((a) => ({ id: a.id, name: a.name, wr: a.wr, tm: a.tm, tier: a.tier, icon: ico(a.ip), desc: cleanDesc(a.description) })) });
        } catch {
          const am = await fetchArammeta(ctx);
          const items = Object.entries(am.augs || {}).map(([id, a]) => ({
            id: +id, name: a.name_zh || a.name_en || `海克斯#${id}`, wr: a.wr ?? 0.5, tm: a.g ?? 0,
            tier: a.rarity === 'kPrismatic' ? 'T0' : a.rarity === 'kGold' ? 'T1' : 'T2',
            icon: a.icon ? AM_ICON + a.icon : null, desc: cleanDesc(a.desc_zh || a.description || '')
          }));
          return json({ version: am.patch_prefix || '16.20', items, source: 'arammeta-backup' });
        }
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
        // Cache API：出装数据按版本+英雄缓存 1 小时
        const cacheKey = new Request(url.toString() + '&v=fix65', { method: 'GET' });
        try {
          const cached = await caches.default.match(cacheKey);
          if (cached) return cached;
        } catch {}
        try {
          const b = await fetchBuilds(q, ctx);
          const resp = json(b ?? { none: true });
          // 异步写入缓存，不阻塞返回
          try {
            const toCache = resp.clone();
            toCache.headers.set('Cache-Control', 'public, max-age=3600');
            ctx.waitUntil(caches.default.put(cacheKey, toCache));
          } catch {}
          return resp;
        } catch (e) {
          return json({ none: true, error: String(e.message || e) });
        }
      }
      if (url.pathname === '/api/recommend' && req.method === 'POST') {
        const body = await req.json();
        if (!body.champion || !Array.isArray(body.augments) || body.augments.length === 0) return json({ error: '需要 {champion, augments:[...]}' }, 400);
        try {
          return json(await recommend(body, env));
        } catch (err) {
          const am = await fetchArammeta(ctx);
          const q = String(body.champion).trim().toLowerCase();
          const hit = Object.entries(am.champs || {}).find(([, c]) => [c.name_zh, c.name_en, c.alias].some(x => String(x || '').toLowerCase() === q));
          const cObj = hit ? hit[1] : null;
          const cTop = new Map();
          if (cObj && cObj.top) {
            for (const k of ['kPrismatic', 'kGold', 'kSilver']) for (const t of (cObj.top[k] || [])) cTop.set(t.id, { wr: t.wr, tm: t.g });
          }
          const augList = Object.entries(am.augs || {}).map(([id, a]) => ({ id: +id, name: a.name_zh || a.name_en, wr: a.wr ?? 0.5, tm: a.g ?? 0 }));
          const rows = body.augments.map(aq => {
            const a = findByQuery(augList, aq, ['name']) || { id: 0, name: aq, wr: 0.5, tm: 0 };
            const cw = cTop.get(a.id);
            const r = { name: a.name, champWr: cw ? cw.wr : null, champTm: cw ? cw.tm : null, globalWr: a.wr, score: null };
            return { ...r, eff: effWr(r) };
          }).sort((a, b) => b.eff - a.eff);
          return json({ version: am.patch_prefix || '16.20', pick: rows[0]?.name || null, confidence: null, source: 'arammeta-backup', degraded: 'resg-fallback', ranking: rows });
        }
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
