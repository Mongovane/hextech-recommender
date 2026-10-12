// 出装推荐：主源 arammeta（真实胜率统计），cchappy 降为补充（陷阱海克斯/技能加点）+ 兜底
// 静态资源（图标/名称）走官方 Data Dragon CDN
import { resgFetch, findByQuery, latestVersion, DD } from './resg.js';
import { getItemDict } from './items.js';
import { fetchArammeta, fetchArammetaDetail, arammetaBuilds } from './arammeta.js';

const CC = 'https://test.cchappy.top/api/public/hextech-aram';

async function ccFetch(path, ctx) {
  // 三层：cf 边缘缓存(1h) → 成功后写 Cache API 快照 → 失败时读快照兜底
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const key = new Request('https://builds-cache.local' + path);
  try {
    const up = await fetch(CC + path, {
      headers: { 'User-Agent': 'hextech-recommender/0.3' },
      cf: { cacheTtl: 3600 },
    });
    if (!up.ok) throw new Error(`cchappy ${up.status} ${path}`);
    const data = await up.json();
    if (cache) {
      const put = cache.put(key, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
      if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
      else await put.catch(() => {});
    }
    return { data, stale: false };
  } catch (e) {
    const hit = cache ? await cache.match(key).catch(() => null) : null;
    if (hit) return { data: await hit.json(), stale: true };
    throw e;
  }
}

const slimItem = (it) => {
  if (!it || it.id == null) return null;
  return {
    id: it.id,
    name: it.name || `装备#${it.id}`,
    price: it.price ?? null,
    desc: String(it.description || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null,
    icon: `${DD}/img/item/${it.id}.png`,
    qty: it.quantity > 1 ? it.quantity : null,
  };
};
const slimList = (arr) => (arr || []).map(slimItem).filter(Boolean);

// 官方字典覆盖：名称/价格/描述/图标以 Data Dragon 为准，cchappy 只提供"出什么"
function enrichWithOfficial(items, dict) {
  if (!dict) return items;
  return items.map((it) => {
    const off = dict[String(it.id)];
    return off ? { ...it, name: off.name || it.name, price: off.price ?? it.price, desc: off.desc || it.desc, icon: off.icon || it.icon } : it;
  });
}

async function numericIdFor(query, ctx) {
  // RESG 数字 id → arammeta 同 id；RESG 不可用时用 arammeta 自查
  try {
    const v = await latestVersion();
    const { items } = await resgFetch(`/versions/${v}/champions.js`);
    const ent = findByQuery(items, query, ['name', 'title', 'alias']);
    if (ent?.id != null) return { id: ent.id, name: ent.name, alias: ent.alias };
  } catch { /* fall through */ }
  try {
    const am = await fetchArammeta(ctx);
    const q = String(query).trim().toLowerCase();
    const hit = Object.entries(am.champs || {}).find(([, c]) =>
      [c.name_zh, c.name_en, c.alias].some((x) => String(x || '').toLowerCase() === q));
    if (hit) return { id: +hit[0], name: hit[1].name_zh, alias: hit[1].alias };
  } catch { /* ignore */ }
  return null;
}

export async function fetchBuilds(query, ctx) {
  const who = await numericIdFor(query, ctx);
  if (!who) return null;
  const dict = await getItemDict(ctx).catch(() => null);

  // 主源：arammeta 胜率出装
  try {
    const detail = await fetchArammetaDetail(who.id, ctx);
    const b = arammetaBuilds(detail, dict);
    // 补充：cchappy 陷阱海克斯 + 技能加点（best-effort）
    let traps = [], skills = [];
    try {
      const { data: d } = await ccFetch(`/heroes/${encodeURIComponent(who.alias || '')}`, ctx);
      const bg = d?.data?.config?.buildGuides?.[0];
      if (bg) {
        traps = (bg.trapAugments || []).map((t) => ({ id: t.id, name: t.name })).filter((t) => t.id != null);
        skills = [bg.primarySkill, bg.secondarySkill].filter(Boolean);
      }
    } catch { /* 补充失败不影响主数据 */ }
    return { source: 'arammeta', champion: who.name, alias: who.alias, traps, skills, ...b };
  } catch (e) { /* 降级走 cchappy 全量 */ }

  // 兜底：cchappy 攻略
  const { data: d, stale } = await ccFetch(`/heroes/${encodeURIComponent(who.alias || '')}`, ctx);
  const bg = d?.data?.config?.buildGuides?.[0];
  if (!bg) return null;
  return {
    source: 'cchappy', fallback: true,
    champion: who.name, alias: who.alias,
    stale: !!stale,
    guide: bg.name || null,
    skills: [bg.primarySkill, bg.secondarySkill].filter(Boolean),
    notes: String(bg.notes || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
    starting: enrichWithOfficial(slimList(bg.startingItems), dict),
    core: enrichWithOfficial(slimList(bg.coreItems), dict),
    optional: enrichWithOfficial(slimList(bg.optionalItems), dict),
    traps: (bg.trapAugments || []).map((t) => ({ id: t.id, name: t.name })).filter((t) => t.id != null),
    spells: (bg.summonerSpells || []).map((s) => ({
      name: s.name,
      icon: `${DD}/img/spell/${s.imageFull || s.key + '.png'}`,
    })),
  };
}
