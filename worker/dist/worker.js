// 构建产物（node build.mjs 生成，不要手改）
// 源码：src/*.js + web/index.html

// ===== src/core.js =====
// 纯函数：平衡性判断、RESG ES module 解析、胜率收缩、state 组装、jev 请求/响应处理
// 无外部依赖，Node / Worker 通用
const NEGATIVE_STATS = ['承受伤害', '受到伤害', '所受伤害'];
function getBalanceTone(label, value) {
  const text = String(value).trim();
  const number = Number.parseFloat(text.replace(/[^+\-\d.]/g, ''));
  if (!Number.isFinite(number)) return 'neutral';
  const baseline = text.includes('%') && !/^[+-]/.test(text) ? 100 : 0;
  let delta = number - baseline;
  if (NEGATIVE_STATS.some((n) => label.includes(n))) delta *= -1;
  return delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral';
}

function parseModule(text) {
  const json = text.replace(/^\s*export\s+default\s*/, '').trim().replace(/;+\s*$/, '');
  return JSON.parse(json);
}

// 小样本收缩：样本少时向全局胜率靠拢，避免"1 场 100%"排第一
const SHRINK_K = 200;
function effWr(r) {
  if (r.champWr == null) return r.globalWr;
  const n = r.champTm || 0;
  return (r.champWr * n + r.globalWr * SHRINK_K) / (n + SHRINK_K);
}

function buildCandidateContextData(championDetail, augmentsData, candidates) {
  const { champion, bb = {}, ra = [] } = championDetail;
  const buffs = Object.entries(bb).map(([label, value]) => ({ label, value, tone: getBalanceTone(label, value) }));
  const champAugWr = new Map(ra.map((r) => [r[0], { tm: r[2], wm: r[3], wr: r[4] / 1e4 }]));
  const augById = new Map(augmentsData.items.map((a) => [a.id, a]));
  const rows = candidates.map((id) => {
    const a = augById.get(id) ?? { id, name: `海克斯#${id}` };
    const cw = champAugWr.get(id);
    return { id, name: a.name, description: a.description ?? '', globalWr: a.wr, globalTm: a.tm, champWr: cw?.wr ?? null, champTm: cw?.tm ?? null };
  });
  return { champion, buffs, rows };
}

const wrText = (r) =>
  `该英雄使用胜率 ${r.champWr !== null ? (r.champWr * 100).toFixed(2) + '%' : '样本不足'}${r.champTm ? `（${r.champTm} 场）` : ''}；全局胜率 ${(r.globalWr * 100).toFixed(2)}%。`;

function buildState(version, champion, buffs, rows, picked = []) {
  const buffLine = buffs.length
    ? buffs.map((b) => `${b.label}${b.value}(${b.tone === 'up' ? '加强' : b.tone === 'down' ? '削弱' : '持平'})`).join('；')
    : '无';
  const pickedLine = picked.length ? `本局已选海克斯：${picked.join('、')}（评估协同效应，避免功能重复）。` : '';
  return [
    `游戏：英雄联盟国服海克斯大乱斗，版本 ${version}。`,
    `我方英雄：${champion.name}（${champion.title}），全局胜率 ${(champion.wr * 100).toFixed(2)}%，样本 ${champion.tm} 场。`,
    `该英雄本版本平衡性调整：${buffLine}。`,
    pickedLine,
    `候选海克斯（3 选 1）：`,
    ...rows.map((r, i) => `  ${i + 1}. ${r.name}：${wrText(r)}`),
  ].filter(Boolean).join('\n');
}

function buildJevBody({ state, rows, model = 'jev-latest' }) {
  const criteria = {};
  for (const r of rows) criteria[r.name] = wrText(r) + (r.description ? `效果：${r.description.slice(0, 120)}` : '');
  const questions = {
    best_pick: {
      type: 'choice',
      instructions: '根据对局上下文（英雄、平衡性调整、各候选海克斯的胜率数据），选择当前最优的海克斯强化符文。',
      criteria,
    },
  };
  rows.forEach((r, i) => {
    questions[`score_${i}`] = { type: 'score', instructions: `评估「${r.name}」在当前对局下的强度。`, criteria: ['很弱', '较弱', '中等', '较强', '很强'] };
  });
  return { model, state, questions };
}

// 冲突检测：针对"已选出的那个"单独问（原版没告诉模型选了哪个，结果无意义）
function buildConflictBody({ state, row, model = 'jev-latest' }) {
  return {
    model,
    state: state + `\n拟选择的海克斯：${row.name}。效果：${(row.description || '').slice(0, 160)}`,
    questions: {
      no_conflict: {
        type: 'noul',
        instructions: `「${row.name}」与该英雄的定位和玩法是否存在明显冲突？`,
        criteria: { true: '存在明显冲突，不适配', false: '无冲突，适配良好' },
      },
    },
  };
}

function extractPick(data, rowCount) {
  const a = data.answers ?? {};
  const pick = a.best_pick ?? {};
  const ranking = [];
  for (let i = 0; i < rowCount; i++) {
    const s = a[`score_${i}`] ?? {};
    ranking.push({ score: s.score ?? null, confidence: s.confidence ?? null });
  }
  return { pick: pick.choice ?? null, confidence: pick.confidence ?? null, distribution: pick.probabilities ?? null, ranking, usage: data.usage ?? null };
}

// 清洗 RESG 海克斯描述：去掉 <crit> 等游戏标签、<br>、%i:xxx% 图标占位
function cleanDesc(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/%i:[a-zA-Z]+%/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ===== src/resg.js =====
// RESG 数据层：fetch（cf 边缘缓存）+ 查询 + 图标 URL

const RESG = 'https://resg.top/api/v1';
// ---------------- Worker ----------------
// caches.default 在 workers.dev 域名下不生效，改用 fetch 的 cf 缓存；versions 列表短缓存以便及时发现新版本
async function resgFetch(path) {
  const ttl = path === '/versions.js' ? 600 : 86400;
  const up = await fetch(RESG + path, {
    headers: { 'User-Agent': 'resg-jev-worker/0.2' },
    cf: { cacheEverything: true, cacheTtl: ttl },
  });
  if (!up.ok) throw new Error(`RESG ${up.status} ${path}`);
  return parseModule(await up.text());
}

const ico = (p) => (p ? 'https://resg.top' + p : null);
// 官方 Data Dragon（静态资源优先走官方）
const DD_VER = '16.19.1';
const DD = `https://ddragon.leagueoflegends.com/cdn/${DD_VER}`;
const champIcon = (alias, fallback) => (alias ? `${DD}/img/champion/${alias}.png` : fallback);
function findByQuery(items, q, fields) {
  const s = String(q).trim().toLowerCase();
  return items.find((it) => String(it.id) === s || fields.some((f) => String(it[f] ?? '').toLowerCase() === s));
}
async function latestVersion() { return (await resgFetch('/versions.js'))[0].version; }

// ===== src/arammeta.js =====
// arammeta 备用数据源（MIT 开源，台服 LCU 众包真实对局，每日更新）
// https://arammeta.com/api/tier-list.json — 英雄胜率 + 分稀有度海克斯胜率统计
// 仅在 RESG 失败时启用；海克斯名/图标用本站 RESG 元数据（简体），数字走 arammeta

const AM = 'https://arammeta.com/api/tier-list.json';
const AM_ICON = 'https://arammeta.com/';
let mem = null;

async function fetchArammeta(ctx) {
  if (mem) return mem;
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const key = new Request('https://am-cache.local/tier-list');
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) {
    mem = await hit.json();
    return mem;
  }
  const r = await fetch(AM, {
    headers: { 'User-Agent': 'hextech-recommender/0.3' },
    cf: { cacheTtl: 21600 },
  });
  if (!r.ok) throw new Error(`arammeta ${r.status}`);
  const data = await r.json();
  mem = data;
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return data;
}

// 单英雄详情：含胜率出装（items/singleItems/boots/spells）
async function fetchArammetaDetail(numericId, ctx) {
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const key = new Request(`https://am-cache.local/champ-${numericId}`);
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) return hit.json();
  const r = await fetch(`${AM.replace('/api/tier-list.json', '')}/api/champions/${numericId}.json`, {
    headers: { 'User-Agent': 'hextech-recommender/0.3' },
    cf: { cacheTtl: 21600 },
  });
  if (!r.ok) throw new Error(`arammeta detail ${r.status}`);
  const data = await r.json();
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } }));
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return data;
}

// 出装胜率数据 → 本站形状（id 直通 Data Dragon；名称优先简体官方字典）
function arammetaBuilds(detail, ddDict) {
  const itemName = (id, fallback) => ddDict?.[String(id)]?.name || fallback || `装备#${id}`;
  const itemIcon = (id) => `${DD}/img/item/${id}.png`;
  const itemDesc = (id) => ddDict?.[String(id)]?.desc || null;
  const itemPrice = (id) => ddDict?.[String(id)]?.price ?? null;
  const slimCombo = (c) => ({
    name: (c.items || []).map((it) => itemName(it.id, null)).filter(Boolean).join(' + ') || c.name_zh,
    items: (c.items || []).map((it) => ({ id: it.id, name: itemName(it.id, null), icon: itemIcon(it.id), desc: itemDesc(it.id), price: itemPrice(it.id) })),
    wr: c.wr ?? null, games: c.g ?? 0, lift: c.lift ?? null,
  });
  const slimSingle = (s) => ({
    id: +s.slug || null, name: itemName(s.slug, s.name_zh), icon: itemIcon(s.slug), desc: itemDesc(s.slug), price: itemPrice(s.slug),
    wr: s.wr ?? null, games: s.g ?? 0,
  });
  const items = detail?.items || {};
  const singles = detail?.singleItems || {};
  const boots = detail?.boots || {};
  const spells = detail?.spells || {};
  return {
    combos: (items.top || []).slice(0, 3).map(slimCombo),
    badCombos: (items.bot || []).slice(0, 3).map(slimCombo),
    singles: (singles.top || []).slice(0, 8).map(slimSingle),
    boots: (boots.top || []).slice(0, 3).map(slimSingle),
    spells: (spells.top || []).slice(0, 2).map((s) => ({ name: s.name_zh, wr: s.wr ?? null, games: s.g ?? 0 })),
  };
}

// /api/champions 形状
function arammetaChampions(data) {
  const out = [];
  for (const [id, c] of Object.entries(data?.champs || {})) {
    out.push({
      id: +id, name: c.name_zh || c.name_en, title: '', alias: c.alias || null,
      wr: c.wr ?? null, tm: c.g ?? 0, tier: null,
      icon: champIcon(c.alias, null),
    });
  }
  return out;
}

// /api/champion-detail 形状（augIds 取全局池，augWr 优先单英雄、缺省用全局）
function arammetaChampionDetail(data, numericId) {
  const c = data?.champs?.[String(numericId)];
  if (!c) return null;
  const augMeta = data.augs || {};
  const tops = [];
  for (const k of ['kPrismatic', 'kGold', 'kSilver']) {
    for (const t of (c.top?.[k] || [])) tops.push({ id: t.id, wr: t.wr, g: t.g, rarity: k });
  }
  tops.sort((a, b) => b.wr - a.wr);
  const seen = new Set(tops.map((t) => t.id));
  const augWr = tops.map((t) => [t.id, t.wr, t.g]);
  for (const [id, a] of Object.entries(augMeta)) {
    if (!seen.has(+id) && a.wr != null) augWr.push([+id, a.wr, a.g ?? 0]);
  }
  const topAugments = tops.slice(0, 8).map((t) => {
    const m = augMeta[String(t.id)] || {};
    return {
      id: t.id,
      name: m.name_zh || m.name_en || `海克斯#${t.id}`,
      wr: t.wr, tm: t.g,
      icon: m.icon ? AM_ICON + m.icon : null,
    };
  });
  return {
    version: data.patch_prefix || '16.20',
    champion: {
      id: +numericId, name: c.name_zh || c.name_en, title: '', alias: c.alias || null,
      wr: c.wr ?? null, tm: c.g ?? 0, tier: null,
      icon: champIcon(c.alias, null),
    },
    buffs: [],
    topAugments,
    augIds: Object.keys(augMeta).map(Number),
    augWr,
    source: 'arammeta-backup',
  };
}

// ===== src/items.js =====
// 官方 Data Dragon 装备字典：名称/价格/描述/图标以官方为准
// item.json 约 700KB，精简后经 Cache API + 内存缓存，只拉一次


let memDict = null;

async function getItemDict(ctx) {
  if (memDict) return memDict;
  const cache = (typeof caches !== 'undefined') ? caches.default : null;
  const key = new Request('https://dd-cache.local/items-' + DD.split('/cdn/')[1].split('/')[0]);
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) {
    memDict = await hit.json();
    return memDict;
  }
  const r = await fetch(`${DD}/data/zh_CN/item.json`, { cf: { cacheTtl: 86400 } });
  if (!r.ok) throw new Error(`ddragon item.json ${r.status}`);
  const raw = (await r.json()).data || {};
  const dict = {};
  for (const [id, it] of Object.entries(raw)) {
    dict[id] = {
      name: it.name || null,
      price: it.gold?.total ?? null,
      desc: cleanDesc(it.description || '').slice(0, 260) || null,
      icon: `${DD}/img/item/${id}.png`,
    };
  }
  memDict = dict;
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(dict), { headers: { 'content-type': 'application/json' } }));
    if (ctx?.waitUntil) ctx.waitUntil(put.catch(() => {}));
    else await put.catch(() => {});
  }
  return dict;
}

// ===== src/builds.js =====
// 出装推荐：主源 arammeta（真实胜率统计），cchappy 降为补充（陷阱海克斯/技能加点）+ 兜底
// 静态资源（图标/名称）走官方 Data Dragon CDN



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

async function fetchBuilds(query, ctx) {
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

// ===== src/recommend.js =====
// 推荐：jev 决策 + 本地降级 + 英雄详情


const JEV = 'https://api.typesafe.ai/v1/systemone';
async function jevCall(env, body) {
  const jr = await fetch(JEV, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!jr.ok) throw new Error(`jev ${jr.status}`);
  return jr.json();
}

async function recommend({ champion, augments, version, picked = [], mode }, env) {
  const v = version ?? (await latestVersion());
  const [champs, augs] = await Promise.all([resgFetch(`/versions/${v}/champions.js`), resgFetch(`/versions/${v}/augments.js`)]);
  const champEnt = findByQuery(champs.items, champion, ['name', 'title', 'alias']);
  if (!champEnt) throw new Error(`找不到英雄：${champion}`);
  const seen = new Set();
  const augEnts = augments.map((q) => {
    const a = findByQuery(augs.items, q, ['name']);
    if (!a) throw new Error(`找不到海克斯：${q}`);
    return a;
  }).filter((a) => !seen.has(a.id) && seen.add(a.id));
  const pickedNames = [...new Set(picked.map(String).map((s) => s.trim()).filter(Boolean))]
    .map((q) => findByQuery(augs.items, q, ['name'])?.name).filter(Boolean);
  const detail = await resgFetch(`/versions/${v}/champions/${champEnt.id}.js`);
  const { champion: ch, buffs, rows } = buildCandidateContextData(detail, augs, augEnts.map((a) => a.id));
  const state = buildState(v, ch, buffs, rows, pickedNames);

  const rankedLocal = rows
    .map((r) => ({ name: r.name, champWr: r.champWr, champTm: r.champTm, globalWr: r.globalWr, score: null, _e: effWr(r) }))
    .sort((a, b) => b._e - a._e)
    .map(({ _e, ...r }) => ({ ...r, eff: _e }));
  const local = (extra = {}) => ({ version: v, pick: rankedLocal[0].name, confidence: null, source: 'local-fallback', conflictProb: null, ranking: rankedLocal, usage: null, ...extra });

  // mode=wr（纯胜率）或未配置 jev：不调用 jev，直接按修正胜率排序
  if (mode === 'wr' || !env.TYPESAFE_API_KEY) return local({ source: 'win-rate', degraded: mode === 'wr' ? null : 'no-key' });

  let jevData;
  try { jevData = await jevCall(env, buildJevBody({ state, rows })); }
  catch (e) { return local({ source: 'win-rate', degraded: 'jev-error', jevError: String(e.message || e) }); }
  const { pick, confidence, distribution, ranking, usage } = extractPick(jevData, rows.length);

  // 冲突检测：只对选中的那个问一次；失败不影响主结果
  let conflictProb = null;
  const pickedRow = rows.find((r) => r.name === pick);
  if (pickedRow) {
    try { conflictProb = (await jevCall(env, buildConflictBody({ state, row: pickedRow })))?.answers?.no_conflict?.noul ?? null; } catch {}
  }

  const ranked = rows
    .map((r, i) => ({ name: r.name, champWr: r.champWr, champTm: r.champTm, globalWr: r.globalWr, score: ranking[i]?.score ?? null, eff: effWr(r) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  // 三选一置信度天然偏低，阈值放宽到 0.4
  const ok = pick && (confidence === null || confidence >= 0.4) && (conflictProb === null || conflictProb < 0.5);
  return {
    version: v, pick: ok ? pick : rankedLocal[0].name, confidence, distribution, conflictProb,
    source: ok ? 'jev' : 'win-rate', degraded: ok ? null : ((conflictProb ?? 0) >= 0.5 ? 'conflict' : 'low-confidence'),
    ranking: ok ? ranked : rankedLocal, usage,
  };
}

async function championDetail(query, version) {
  const v = version ?? (await latestVersion());
  const [champs, augs] = await Promise.all([resgFetch(`/versions/${v}/champions.js`), resgFetch(`/versions/${v}/augments.js`)]);
  const champEnt = findByQuery(champs.items, query, ['name', 'title', 'alias']);
  if (!champEnt) throw new Error(`找不到英雄：${query}`);
  const detail = await resgFetch(`/versions/${v}/champions/${champEnt.id}.js`);
  const { champion, bb = {}, ra = [] } = detail;
  const buffs = Object.entries(bb).map(([label, value]) => ({ label, value, tone: getBalanceTone(label, value) }));
  const augById = new Map(augs.items.map((a) => [a.id, a]));
  const topAugments = ra.slice().sort((a, b) => b[2] - a[2]).slice(0, 5).map((r) => {
    const a = augById.get(r[0]);
    return { id: r[0], name: a?.name ?? `海克斯#${r[0]}`, wr: r[4] / 1e4, tm: r[2], icon: ico(a?.ip) };
  });
  // augIds：该英雄有对局数据的海克斯 id，前端据此过滤
  return { version: v, champion: { ...champion, icon: champIcon(champion.alias ?? champEnt.alias, ico(champion.ip ?? champEnt.ip)) }, buffs, topAugments, augIds: ra.map((r) => r[0]), augWr: ra.map((r) => [r[0], r[4] / 1e4, r[2]]) };
}

// ===== src/ocr.js =====
// OCR：Workers AI 视觉模型识别三卡片标题 + 模糊匹配标准海克斯名

// ---------- OCR ----------
const OCR_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const dataUrl = (b64, mime = 'image/jpeg') => { const s = String(b64 || ''); return s.startsWith('data:') ? s : `data:${mime || 'image/jpeg'};base64,${s}`; };

async function ocrImage(env, b64, mime) {
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

const normName = (s) => String(s ?? '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
function lev(a, b) {
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
function sim(a, b) {
  if (a === b) return 1;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 2 && l.includes(s) && s.length / l.length >= 0.5) return 0.9; // 原版单字也能 0.95 误配
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}
function matchAugment(ocrText, augItems) {
  const n = normName(ocrText);
  if (!n) return { ocr: ocrText, matched: null, score: 0 };
  let best = null, bestScore = 0;
  for (const a of augItems) {
    const s = sim(normName(a.name), n);
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return { ocr: ocrText, matched: bestScore >= 0.5 ? best.name : null, score: +bestScore.toFixed(3) };
}

async function ocrCards(body, env) {
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

// ===== src/index.js =====
// Worker 入口：路由






// 由 build.mjs 内联 web/index.html 生成
const OVERLAY_HTML = "<!DOCTYPE html>\n<html lang=\"zh\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>海克斯大乱斗 · 最优推荐</title>\n<style>\n:root{--bg:#050b14;--panel:#0b1626;--line:#173049;--txt:#e6f1f7;--mut:#7f97a8;--cy:#19d3e6;--gold:#f0c35a;--up:#3ddc97;--down:#ff6b7a;--hex:polygon(25% 3%,75% 3%,100% 50%,75% 97%,25% 97%,0 50%)}\n*{box-sizing:border-box}\nhtml{background:var(--bg)}\nbody{margin:0;color:var(--txt);font:14px/1.5 system-ui,-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif;min-height:100vh;\nbackground:radial-gradient(900px 500px at 85% -10%,#0d3a52 0,transparent 60%),radial-gradient(700px 400px at -10% 30%,#2a1d4d 0,transparent 55%),var(--bg)}\nbody:before{content:\"\";position:fixed;inset:0;pointer-events:none;opacity:.07;\nbackground-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='98'%3E%3Cpath d='M28 2l26 15v30L28 62 2 47V17zM28 62v34M2 47L2 80M54 47v33' fill='none' stroke='%2319d3e6' stroke-width='1'/%3E%3C/svg%3E\")}\n.wrap{position:relative;max-width:980px;margin:0 auto;padding:20px 16px 60px}\nheader{display:flex;align-items:center;gap:14px;margin-bottom:22px}\n.logo{width:44px;height:48px;clip-path:var(--hex);background:linear-gradient(135deg,var(--cy),var(--gold));display:grid;place-items:center;color:#041018;font-weight:900;font-size:20px}\nh1{font-size:22px;margin:0;letter-spacing:2px}\nh1 small{display:block;font-size:11px;color:var(--mut);letter-spacing:3px;font-weight:400}\n#version{margin-left:auto}\nselect,input{background:#08111e;border:1px solid var(--line);color:var(--txt);padding:10px 12px;border-radius:8px;font:inherit;outline:none;transition:.15s}\ninput{width:100%}\ninput:focus,select:focus{border-color:var(--cy);box-shadow:0 0 0 3px #19d3e622}\n.step{display:flex;align-items:center;gap:10px;margin:26px 0 10px;color:var(--mut);font-size:12px;letter-spacing:2px;text-transform:uppercase}\n.step b{width:22px;height:24px;clip-path:var(--hex);background:var(--cy);color:#041018;display:grid;place-items:center;font-size:12px}\n.step:after{content:\"\";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}\n.panel{background:linear-gradient(180deg,#0d1b2e,var(--panel));border:1px solid var(--line);border-radius:14px;padding:16px}\n.field{position:relative}\n.clr{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:26px;height:26px;border:0;border-radius:50%;background:#12263d;color:var(--mut);cursor:pointer;display:none;place-items:center;padding:0;z-index:5}\n.clr.show{display:grid}\n.clr:hover{color:var(--cy);background:#16304d}\n.clr .ico{width:14px;height:14px}\n.iconbtn{flex:none;width:38px;height:38px;border-radius:10px;border:1px solid var(--line);background:#0a1524;color:var(--mut);cursor:pointer;display:grid;place-items:center;padding:0}\n.iconbtn:hover{color:var(--cy);border-color:var(--cy)}\n.iconbtn .ico{width:18px;height:18px}\n.setpop{position:absolute;top:70px;right:16px;width:320px;max-width:calc(100vw - 32px);background:#0c1a2c;border:1px solid var(--cy);border-radius:12px;padding:14px;z-index:50;display:none;box-shadow:0 14px 40px #000a}\n.setpop.open{display:block}\n.setrow{display:flex;align-items:center;gap:8px;margin-bottom:10px}\n.setrow .st{margin-left:auto;font-size:12px;font-weight:400}\n.st.ok{color:var(--up)}.st.no{color:var(--down)}\n.setpop input{flex:1;min-width:0}\n@keyframes flash{0%,100%{box-shadow:none}30%{box-shadow:0 0 0 3px #19d3e6aa}}\ninput.flash{animation:flash 1.2s ease}\n.rc .desc{font-size:12px;color:var(--mut);margin:2px 0 8px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.5}\n.opt .od{display:block;font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}\n.opt>span{min-width:0}\n.drop{position:absolute;top:100%;left:0;right:0;margin-top:6px;background:#0c1a2c;border:1px solid var(--cy);border-radius:10px;max-height:300px;overflow:auto;z-index:20;display:none;box-shadow:0 14px 40px #000a}\n.drop.open{display:block}\n.opt{padding:9px 12px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}\n.opt.on,.opt:hover{background:#12304a}\n.opt small{color:var(--mut);white-space:nowrap}\n.tier{font-size:10px;padding:1px 6px;border-radius:4px;background:#1b3550;margin-left:6px;vertical-align:middle}\n.tier.T0{background:#8b3dff}.tier.T1{background:#1f7bff}\n.champ{display:flex;gap:16px;align-items:flex-start;margin-top:12px}\n.mono{flex:none;width:76px;height:84px;clip-path:var(--hex);background:linear-gradient(160deg,var(--cy),#6a35ff);display:grid;place-items:center;font-size:32px;font-weight:900;color:#fff}\n.champ h2{margin:0;font-size:20px}\n.stat{color:var(--mut);font-size:12px}\n.pills,.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}\n.pill{font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--line);background:#0a1524}\n.pill.up{color:var(--up);border-color:#3ddc9755}.pill.down{color:var(--down);border-color:#ff6b7a55}\n.chip{font-size:12px;padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:#0a1524;color:var(--txt);cursor:pointer;transition:.15s}\n.chip:hover{border-color:var(--cy);color:var(--cy)}\n.chip small{color:var(--mut);margin-left:4px}\n.shot img{max-width:100%;border-radius:8px;margin-top:10px;display:none;border:1px solid var(--line)}\n.btn{border:0;border-radius:10px;padding:11px 20px;font:inherit;font-weight:700;cursor:pointer;color:#041018;background:linear-gradient(135deg,var(--cy),#5fe8c0);transition:.15s}\n.btn:hover{filter:brightness(1.1);transform:translateY(-1px)}\n.btn:disabled{opacity:.45;transform:none;cursor:wait}\n.btn.gold{background:linear-gradient(135deg,var(--gold),#ff9d4a)}\n.btn.ghost{background:#0a1524;color:var(--txt);border:1px solid var(--line)}\n.slots{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}\n.slot{position:relative;padding:12px;border-radius:14px;border:1px solid var(--line);background:#08111e}\n.slot i{position:absolute;top:-10px;left:12px;font-style:normal;font-size:11px;font-weight:800;padding:1px 9px;border-radius:99px;background:var(--cy);color:#041018}\n.cta{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}\n.cta .btn.main{flex:1;font-size:16px;padding:14px}\n.results{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:6px}\n.rc{position:relative;padding:18px 14px 14px;border-radius:16px;border:1px solid var(--line);background:linear-gradient(180deg,#0e1d31,#09121f);animation:in .4s both}\n.rc.pick{border-color:var(--gold);background:linear-gradient(180deg,#2a2210,#0d1522 70%);box-shadow:0 0 0 1px #f0c35a55,0 0 40px #f0c35a33;transform:translateY(-6px)}\n.rc .rank{position:absolute;top:-12px;left:14px;width:28px;height:30px;clip-path:var(--hex);background:#173049;display:grid;place-items:center;font-weight:800;font-size:13px}\n.rc.pick .rank{background:var(--gold);color:#241a02}\n.crown{position:absolute;top:-16px;right:12px;font-size:22px}\n.rc h3{margin:6px 0 2px;font-size:17px}\n.big{font-size:30px;font-weight:900;color:var(--cy);letter-spacing:-1px}\n.rc.pick .big{color:var(--gold)}\n.bar{height:6px;border-radius:3px;background:#12263b;margin:10px 0 6px;overflow:hidden}\n.fill{height:100%;border-radius:3px;background:linear-gradient(90deg,var(--cy),#6a35ff);transition:width .8s cubic-bezier(.2,.8,.2,1)}\n.rc.pick .fill{background:linear-gradient(90deg,var(--gold),#ff9d4a)}\n.rc .btn{width:100%;margin-top:10px;padding:8px;font-size:13px}\n.warn{margin-top:14px;padding:10px 14px;border-radius:10px;background:#3a141b;border:1px solid #ff6b7a66;color:#ffb3bb;font-size:13px}\n.meta{margin-top:12px;color:var(--mut);font-size:12px}\n.badge{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;margin-right:6px;background:#12304a;color:var(--cy)}\n.badge.local{background:#3a2d10;color:var(--gold)}\n#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(80px);background:#12304a;border:1px solid var(--cy);padding:10px 18px;border-radius:99px;transition:.3s;z-index:50}\n#toast.show{transform:translateX(-50%)}\n.rail{display:flex;flex-wrap:wrap;gap:8px;align-items:center}\n@keyframes in{from{opacity:0;transform:translateY(14px)}}\n@media(max-width:720px){.slots,.results{grid-template-columns:1fr}.rc.pick{transform:none}.champ{flex-direction:column}}\n\n.opt{align-items:center}.opt>span{flex:1}\n.oic{width:24px;height:24px;border-radius:5px;flex:none}.cic{width:18px;height:18px;border-radius:4px;flex:none}.ric{width:34px;height:34px;border-radius:8px;flex:none}\n.mono img{width:100%;height:100%;object-fit:cover;display:block}.mono{overflow:hidden;filter:drop-shadow(0 0 14px #19d3e688)}\n.chip{display:inline-flex;align-items:center;gap:6px}\n.rc h3{display:flex;align-items:center;gap:8px}\n.ctrl{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin-bottom:16px}\n.seg{display:inline-flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}\n.seg button{background:#08111e;color:var(--mut);border:0;padding:8px 14px;font:inherit;cursor:pointer;transition:.2s}\n.seg button.on{background:linear-gradient(135deg,var(--cy),#5fe8c0);color:#041018;font-weight:700}\n.sw{display:flex;gap:8px;align-items:center;color:var(--mut);cursor:pointer;font-size:13px}.sw input{width:auto;accent-color:var(--cy)}.sw em{font-style:normal;color:var(--cy)}\n.bg{position:fixed;inset:0;overflow:hidden;pointer-events:none}\n.bg i{position:absolute;bottom:-120px;background:linear-gradient(#19d3e61f,#6a35ff10);clip-path:var(--hex);animation:rise linear infinite}\n@keyframes rise{to{transform:translateY(-125vh) rotate(60deg)}}\n.rc{transition:transform .15s ease-out,box-shadow .3s;transform-style:preserve-3d}\n.rc:before{content:\"\";position:absolute;inset:0;border-radius:16px;pointer-events:none;background:radial-gradient(240px circle at var(--mx,50%) var(--my,0),#ffffff16,transparent 60%)}\n@property --a{syntax:'<angle>';initial-value:0deg;inherits:false}\n.rc.pick:after{content:\"\";position:absolute;inset:-2px;border-radius:18px;padding:2px;pointer-events:none;background:conic-gradient(from var(--a),transparent 0 65%,var(--gold),#fff,var(--gold),transparent);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;animation:spin 3s linear infinite}\n@keyframes spin{to{--a:360deg}}\n.crown{animation:bob 1.6s ease-in-out infinite}@keyframes bob{50%{transform:translateY(-5px) rotate(8deg)}}\n.rc.nodata{opacity:.85}.tag{display:inline-block;font-size:11px;padding:1px 8px;border-radius:99px;background:#3a2d10;color:var(--gold);margin-top:4px}\n.rc.sk{height:210px;background:linear-gradient(100deg,#0e1d31 30%,#18334f 50%,#0e1d31 70%);background-size:200% 100%;animation:sh 1.1s linear infinite}\n@keyframes sh{to{background-position:-200% 0}}\n.spark{position:fixed;width:9px;height:10px;clip-path:var(--hex);background:var(--gold);pointer-events:none;z-index:60;animation:sp 1s ease-out forwards}\n@keyframes sp{to{transform:translate(var(--dx),var(--dy)) scale(.2);opacity:0}}\n\n.ico{width:1.15em;height:1.15em;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;vertical-align:-.2em;flex:none}\n.btn,.seg button{display:inline-flex;align-items:center;justify-content:center;gap:6px}\n.logo .ico{width:26px;height:26px;stroke:#041018}\n.shot .ico{width:30px;height:30px;color:var(--cy);display:block;margin:0 auto 6px}\n.crown{line-height:0}.crown .ico{width:26px;height:26px;color:var(--gold);filter:drop-shadow(0 0 6px #f0c35a99)}\n.pill .ico{width:13px;height:13px;vertical-align:-2px}\n.chip small .ico{width:11px;height:11px}\n.warn{display:flex;gap:8px;align-items:center}.warn .ico{color:var(--down);width:18px;height:18px}\n.mark .ico{width:15px;height:15px}\n\n.shot{display:block;position:relative;overflow:hidden;text-align:center;cursor:pointer;padding:30px 20px;border-radius:14px;border:1px solid var(--line);\nbackground:radial-gradient(420px 140px at 50% 0,#0f3350 0,transparent 70%),linear-gradient(180deg,#0a1a2c,#08111e);transition:.25s}\n.shot:before{content:\"\";position:absolute;inset:9px;pointer-events:none;opacity:.5;transition:.25s;border-radius:6px;background:\nlinear-gradient(var(--cy),var(--cy)) 0 0/18px 2px,linear-gradient(var(--cy),var(--cy)) 0 0/2px 18px,\nlinear-gradient(var(--cy),var(--cy)) 100% 0/18px 2px,linear-gradient(var(--cy),var(--cy)) 100% 0/2px 18px,\nlinear-gradient(var(--cy),var(--cy)) 0 100%/18px 2px,linear-gradient(var(--cy),var(--cy)) 0 100%/2px 18px,\nlinear-gradient(var(--cy),var(--cy)) 100% 100%/18px 2px,linear-gradient(var(--cy),var(--cy)) 100% 100%/2px 18px;background-repeat:no-repeat}\n.shot:hover,.shot.over{border-color:#19d3e688;box-shadow:0 0 30px #19d3e620 inset}\n.shot:hover:before,.shot.over:before{inset:5px;opacity:1}\n.shot:hover:after,.shot.over:after{opacity:1;animation:scan 1.8s linear infinite}\n@keyframes scan{from{transform:translateY(-60px)}to{transform:translateY(240px)}}\n.shot img{max-height:240px;margin:14px auto 0}\n.cands{display:flex;flex-wrap:wrap;gap:10px;margin-top:16px;align-items:center}.cands .stat{width:100%}\n.cc{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:12px;border:1px solid var(--line);background:#0a1524;font-size:13px;transition:.25s;animation:in .3s both}\n.cc img{width:26px;height:26px;border-radius:6px}.cc b{color:var(--cy)}.cc small{color:var(--mut)}\n.cc.best{border-color:var(--gold);background:linear-gradient(135deg,#2a2210,#0a1524);box-shadow:0 0 18px #f0c35a40}\n.cc.best b,.cc.best .ico{color:var(--gold)}.cc.nd{opacity:.8}.cc.bad{border-color:#ff6b7a66;color:var(--down)}\n.seg button:disabled{opacity:.4;cursor:not-allowed}\n.warn.deg{margin:0 0 14px;background:#2d2410;border-color:#f0c35a66;color:var(--gold)}.warn.deg .ico{color:var(--gold)}\n\n.chip.tgl{color:var(--mut)}.chip.tgl.on{border-color:var(--cy);color:var(--cy);background:#0c2a3c}\n.chip em{font-style:normal;color:var(--mut);margin-left:2px}.chip.tgl.on em{color:var(--cy)}\n.chip .ico{width:14px;height:14px}\n.capbox{display:none;margin-top:12px}.capbox.on{display:block}\n.capbox video{width:100%;max-height:200px;border-radius:10px;border:1px solid var(--line);background:#000;object-fit:contain}\n.pip .pipbox{padding:12px;display:grid;gap:8px}.pip .pipbox .btn{width:100%}\n\n/* ===== v3：玻璃透明主题 + 动效 ===== */\n:root{--glass:rgba(10,24,40,.34);--glass2:rgba(255,255,255,.035);--ln:rgba(120,200,230,.16)}\n::selection{background:#19d3e655}\nhtml{scroll-behavior:smooth}\n*{scrollbar-width:thin;scrollbar-color:#1d4260 transparent}\n.wrap{max-width:1040px;z-index:1}\nbody:after{content:\"\";position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(520px circle at var(--cx,50%) var(--cy2,30%),rgba(25,211,230,.07),transparent 60%)}\n.panel{position:relative;background:var(--glass);border:1px solid var(--ln);backdrop-filter:blur(10px) saturate(1.2);-webkit-backdrop-filter:blur(10px) saturate(1.2);box-shadow:inset 0 1px 0 rgba(255,255,255,.05)}\n.panel:focus-within{z-index:30}\n.slot,.cc,.chip,.pill,.seg,.iconbtn,.btn.ghost{background:var(--glass2);border-color:var(--ln)}\ninput,select{background:rgba(6,14,26,.35);border-color:var(--ln)}\n.seg button{background:transparent}.seg button.on{background:linear-gradient(135deg,var(--cy),#5fe8c0)}\n.rc{background:linear-gradient(180deg,rgba(20,44,70,.42),rgba(9,18,31,.18));backdrop-filter:blur(8px);border-color:var(--ln)}\n.rc.pick{background:linear-gradient(180deg,rgba(64,50,14,.5),rgba(13,21,34,.18) 70%);border-color:var(--gold)}\n.drop,.setpop{background:rgba(9,20,34,.9);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}\n.chip,.cc,.slot,.btn{transition:.2s}\n.chip:hover{transform:translateY(-1px);background:rgba(25,211,230,.08)}\n.slot:focus-within{border-color:var(--cy);box-shadow:0 0 0 3px rgba(25,211,230,.12),0 0 24px rgba(25,211,230,.12)}\n.btn{position:relative;overflow:hidden}\n.btn:not(:disabled):after{content:\"\";position:absolute;top:0;bottom:0;left:-60%;width:40%;background:linear-gradient(100deg,transparent,rgba(255,255,255,.35),transparent);transform:skewX(-20deg);transition:left .6s;pointer-events:none}\n.btn:not(:disabled):hover:after{left:130%}\n.btn.xl{padding:15px 28px;font-size:16px}\n.rv{opacity:0;transform:translateY(16px);transition:opacity .6s,transform .6s cubic-bezier(.2,.8,.2,1)}.rv.in{opacity:1;transform:none}\n.mono{animation:flt 5s ease-in-out infinite}@keyframes flt{50%{transform:translateY(-4px)}}\n.step b{animation:pls 2.4s ease-in-out infinite}@keyframes pls{50%{filter:drop-shadow(0 0 7px rgba(25,211,230,.9))}}\n/* 英雄卡 */\n.champ{align-items:center;gap:18px;margin-top:4px}\n.cinfo{flex:1;min-width:0}\n.cwr{text-align:right;flex:none}.cwr b{display:block;font-size:34px;font-weight:900;color:var(--cy);letter-spacing:-1px;text-shadow:0 0 22px rgba(25,211,230,.45)}.cwr small{color:var(--mut);font-size:11px}\n.sec{margin-top:18px;padding-top:14px;border-top:1px solid var(--ln)}\n.sh{display:flex;align-items:baseline;gap:10px;font-size:13px;font-weight:700;letter-spacing:1px;list-style:none}\n.sh small{color:var(--mut);font-weight:400;letter-spacing:0;font-size:12px}\ndetails.sec>summary{cursor:pointer;align-items:center}details.sec>summary::-webkit-details-marker{display:none}\n.chev{margin-left:auto;display:inline-flex;transition:transform .25s}details.sec[open] .chev{transform:rotate(180deg)}.sh .ico{width:18px;height:18px;color:var(--cy);align-self:center}\n#builds>.stat[style*=\"margin:8px 0 4px\"]{margin:16px 0 6px!important;display:flex;align-items:center;gap:8px;letter-spacing:1px}\n#builds>.stat[style*=\"margin:8px 0 4px\"]:before{content:\"\";width:3px;height:12px;border-radius:2px;background:currentColor}\n#builds .chips{gap:8px}#builds .cic{width:24px;height:24px}\n/* 一键识别区 */\n.scan{display:flex;gap:16px;flex-wrap:wrap;padding:16px;border-radius:14px;border:1px solid var(--ln);background:linear-gradient(135deg,rgba(25,211,230,.07),rgba(106,53,255,.06));transition:.3s}\n.scan-main{flex:1 1 320px;display:grid;gap:8px;align-content:center}\n.scan-sub{color:var(--mut);font-size:12px}\n.scan-side{display:flex;flex-wrap:wrap;gap:8px;align-items:center;align-content:center}\n.scan.live{border-color:rgba(61,220,151,.5);box-shadow:0 0 30px rgba(61,220,151,.1) inset}\n.scan.live .scan-sub:before{content:\"\";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--up);margin-right:6px;animation:blk 1.4s infinite}\n@keyframes blk{50%{opacity:.25}}\n.mini{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border:1px solid var(--ln);border-radius:10px;cursor:pointer;color:var(--mut);background:var(--glass2);transition:.2s}\n.mini:hover,.mini.over{color:var(--cy);border-color:var(--cy);background:rgba(25,211,230,.08)}\n.pv{display:none;max-height:220px;max-width:100%;margin:12px auto 0;border-radius:10px;border:1px solid var(--ln)}\n/* 设置面板 */\n.setpop{width:340px;padding:0;overflow:hidden;border-color:var(--ln);box-shadow:0 18px 50px rgba(0,0,0,.55)}\n.sph{padding:14px 16px;font-weight:800;letter-spacing:1px;border-bottom:1px solid var(--ln);display:flex;align-items:baseline;gap:8px}.sph small{color:var(--mut);font-weight:400;font-size:11px;letter-spacing:0}\n.sb{padding:6px 16px 14px}\n.srow{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid rgba(120,200,230,.08)}\n.srow .ico{width:18px;height:18px;margin-top:1px}.srow.ok .ico{color:var(--up)}.srow.no .ico{color:var(--gold)}\n.srow b{display:block;font-size:13px}\n.hint{font-size:12px;color:var(--mut);line-height:1.6}\n.hint code{background:rgba(25,211,230,.1);color:var(--cy);padding:1px 6px;border-radius:5px;cursor:pointer}\n.srow .st{margin-left:auto;font-size:11px;font-style:normal;padding:2px 8px;border-radius:99px;white-space:nowrap}\n.srow.ok .st{background:rgba(61,220,151,.14);color:var(--up)}.srow.no .st{background:rgba(240,195,90,.14);color:var(--gold)}\n.sgrp{font-size:11px;letter-spacing:2px;color:var(--mut);margin:14px 0 6px}\n.tokrow{display:flex;gap:8px;margin-bottom:8px}.tokrow input{flex:1;min-width:0}.tokrow .btn{flex:1;padding:8px}\n/* 悬浮窗 */\nbody.pip{padding:0;min-height:0;background:#071322}\n/* 悬浮窗：LoL 赫克斯风格（深金边框、直角面板、不透明） */\nbody.pip{background:#010a13}\n.pip .pipbox{padding:0;display:grid;gap:0;background:linear-gradient(180deg,#0d1729,#060c17);border:1px solid #8a6d3b;border-radius:4px;box-shadow:0 0 0 1px #000,0 12px 32px rgba(0,0,0,.8),inset 0 1px 0 rgba(240,230,210,.08);overflow:hidden}\n.pip .pipbox .btn{width:100%}\n.pip-top{display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:13px;background:linear-gradient(180deg,rgba(240,195,90,.12),transparent 70%);border-bottom:1px solid rgba(138,109,59,.4)}\n.pip-top .sp{flex:1}\n.pip-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--up);box-shadow:0 0 8px var(--up)}\n.pip-ico{background:#0a1322;border:1px solid #8a6d3b;color:#f0e6d2;border-radius:3px;min-width:26px;height:26px;cursor:pointer;font-size:14px;line-height:1;padding:0 4px}\n.pip-ico:hover{border-color:var(--gold);color:#fff}\n#pipBody{display:grid;gap:8px;padding:10px 12px 12px}\n.pip-hero{margin:0;position:relative}\n.pip-hero input{width:100%;padding:9px 12px;font-size:13px;background:#04090f;border:1px solid #2a3f57;border-radius:3px;color:var(--txt)}\n.pip-hero input:focus{border-color:var(--gold);outline:none}\n.pip-hero .drop{max-height:220px;background:#0a1322;border:1px solid #8a6d3b}\n.auto{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--mut);cursor:pointer}.auto input{width:auto;accent-color:var(--cy)}\n.pipres{display:grid;gap:6px}.pipres .cc{font:inherit;font-size:13px;color:var(--txt);cursor:pointer;justify-content:flex-start;text-align:left;background:#0a1322;border:1px solid #2a3f57;border-radius:3px}\n.pipres .cc.best{border-color:var(--gold);box-shadow:inset 0 0 12px rgba(240,195,90,.12)}\n@keyframes pipFlash{0%,100%{box-shadow:0 0 0 1px #000,0 12px 32px rgba(0,0,0,.8)}30%,70%{box-shadow:0 0 0 2px var(--gold),0 0 26px var(--gold)}}\n.pip .pipbox.flash{animation:pipFlash 1.1s ease 3}\n/* v5：游戏内 HUD 优先小巧、内容可滚动，避免推荐列表撑出悬浮窗（选择器已修正） */\nbody.pip{width:100%;height:100%;overflow:hidden;font-size:12px}\nbody.pip .pipbox{height:100%;min-height:0;grid-template-rows:auto minmax(0,1fr)}\nbody.pip .pip-top{padding:6px 8px;min-height:34px}\nbody.pip #pipMsg{font-size:11px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\nbody.pip #pipBody{min-height:0;overflow:auto;overscroll-behavior:contain;gap:7px;padding:8px}\nbody.pip .pip-hero input{padding:7px 9px;font-size:12px}\nbody.pip #pipGo{padding:8px 12px;font-size:13px}\nbody.pip .auto{font-size:11px;line-height:1.35}\nbody.pip .pipres{gap:4px}\nbody.pip .pipres .cc{padding:5px 7px;min-height:32px;font-size:12px}\nbody.pip .pipres .cc b{margin-left:auto}\nbody.pip .pip-hero .drop{max-height:130px}\n@media(max-height:260px){body.pip #pipBody{gap:4px;padding:5px}body.pip .auto{font-size:10px}}\n@media(max-width:720px){.cwr{display:none}}\n@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}.rv{opacity:1;transform:none}}\n\n/* ===== v4：HUD 扫描框 / 海克斯卡片 / 出装卡片 / 提示卡 ===== */\n.hud{position:relative;overflow:hidden;padding:34px 20px 26px;text-align:center;border-radius:16px;background:radial-gradient(560px 170px at 50% 0,rgba(25,211,230,.12),transparent 70%);transition:.3s}\n.hud .cn{position:absolute;width:24px;height:24px;border:2px solid var(--cy);opacity:.7;transition:.3s;pointer-events:none}\n.cn.n1{top:10px;left:10px;border-right:0;border-bottom:0;border-top-left-radius:6px}.cn.n2{top:10px;right:10px;border-left:0;border-bottom:0;border-top-right-radius:6px}\n.cn.n3{bottom:10px;left:10px;border-right:0;border-top:0;border-bottom-left-radius:6px}.cn.n4{bottom:10px;right:10px;border-left:0;border-top:0;border-bottom-right-radius:6px}\n.hud:hover .cn,.hud.over .cn,.hud.live .cn{opacity:1;filter:drop-shadow(0 0 6px var(--cy))}\n.hud:hover .cn.n1,.hud.over .cn.n1,.hud.live .cn.n1{top:5px;left:5px}.hud:hover .cn.n2,.hud.over .cn.n2,.hud.live .cn.n2{top:5px;right:5px}\n.hud:hover .cn.n3,.hud.over .cn.n3,.hud.live .cn.n3{bottom:5px;left:5px}.hud:hover .cn.n4,.hud.over .cn.n4,.hud.live .cn.n4{bottom:5px;right:5px}\n.hud.live .cn{border-color:var(--up);filter:drop-shadow(0 0 6px var(--up))}\n.scanline{position:absolute;left:0;right:0;top:-70px;height:70px;pointer-events:none;opacity:0;background:linear-gradient(180deg,transparent,rgba(25,211,230,.13) 70%,rgba(25,211,230,.5))}\n.hud:hover .scanline,.hud.over .scanline,.hud.live .scanline{opacity:1;animation:hudscan 2.6s linear infinite}\n@keyframes hudscan{to{top:100%}}\n.hud-ico{width:58px;height:58px;margin:0 auto 12px;border-radius:50%;display:grid;place-items:center;color:var(--cy);background:rgba(25,211,230,.1);box-shadow:0 0 0 1px rgba(25,211,230,.3),0 0 30px rgba(25,211,230,.2)}.hud-ico .ico{width:28px;height:28px}\n.hud.live .hud-ico{color:var(--up);background:rgba(61,220,151,.1);box-shadow:0 0 0 1px rgba(61,220,151,.4),0 0 30px rgba(61,220,151,.2)}\n.hud-title{font-size:18px;font-weight:800;letter-spacing:1px}\n.hud-sub{margin:6px auto 18px;max-width:560px;color:var(--mut);font-size:13px}.hud-sub a{color:var(--cy);cursor:pointer;text-decoration:underline}\n.hud.live .hud-sub:before{content:\"\";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--up);margin-right:6px;animation:blk 1.4s infinite}\n.hud-more{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:16px}\nbutton.mini{font:inherit;font-size:13px}button.mini:disabled{opacity:.4;cursor:not-allowed}\n.hud.off .xl{filter:grayscale(.85);opacity:.55}.hud.off .hud-ico{color:var(--mut);box-shadow:0 0 0 1px var(--ln)}\n/* 设置 */\n.srow{align-items:center}.srow b{display:inline;font-size:13px}\n.how{margin-left:6px;width:22px;height:22px;border-radius:50%;border:1px solid var(--ln);background:none;color:var(--mut);cursor:pointer;display:none;place-items:center;font-size:12px;padding:0}.srow.no .how{display:grid}.how:hover{color:var(--cy);border-color:var(--cy)}\n.howbox{display:none;margin:-2px 0 8px 28px;font-size:12px;color:var(--mut);line-height:1.6}.howbox code{background:rgba(25,211,230,.1);color:var(--cy);padding:1px 6px;border-radius:5px;cursor:pointer}\n.sgrp{margin:12px 0 6px}\n/* 常用海克斯 */\n#topSort .seg{margin-top:0}\n#tops{display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));gap:12px;margin-top:12px}\n.ac{position:relative;padding:14px;border-radius:14px;border:1px solid var(--ln);background:linear-gradient(180deg,rgba(25,211,230,.06),rgba(255,255,255,.015));cursor:pointer;transition:.25s;overflow:hidden}\n.ac:hover{transform:translateY(-3px);border-color:rgba(25,211,230,.5);box-shadow:0 10px 30px rgba(0,0,0,.35),0 0 24px rgba(25,211,230,.12)}\n.ac.in{border-color:var(--up);background:linear-gradient(180deg,rgba(61,220,151,.1),rgba(255,255,255,.015))}\n.ac.in .ac-meta:after{content:\" · 已填入\";color:var(--up)}\n.ac-top{display:flex;gap:12px;align-items:center}\n.ac-ic{flex:none;width:54px;height:54px;border-radius:14px;padding:2px;background:linear-gradient(135deg,rgba(255,255,255,.2),rgba(255,255,255,.04))}\n.ac-ic.t-T0{background:linear-gradient(135deg,#a56bff,#5b2bd6)}.ac-ic.t-T1{background:linear-gradient(135deg,#4aa0ff,#1f5fe0)}\n.ac-ic img{width:100%;height:100%;border-radius:12px;display:block;object-fit:cover}\n.ac-nm{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;align-items:flex-start}.ac-nm b{font-size:15px;line-height:1.25}.ac-nm .tier{margin:0}\n.ac-info{flex:none;width:28px;height:28px;border-radius:50%;border:1px solid var(--ln);background:rgba(255,255,255,.04);color:var(--mut);cursor:pointer;display:grid;place-items:center;padding:0;align-self:flex-start}.ac-info:hover,.ac.open .ac-info{color:var(--cy);border-color:var(--cy)}.ac-info .ico{width:15px;height:15px}\n.ac-wr{display:flex;align-items:baseline;gap:8px;margin-top:12px}.ac-wr b{font-size:28px;font-weight:900;color:var(--cy);letter-spacing:-1px}.ac-wr .d{font-size:12px;font-weight:700}\n.ac-bar{height:5px;border-radius:3px;background:rgba(255,255,255,.07);margin:8px 0 6px;overflow:hidden}.ac-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--cy),#6a35ff);border-radius:3px}\n.ac-meta{font-size:12px;color:var(--mut)}\n.ac-desc{margin-top:10px;font-size:12.5px;line-height:1.65;color:#b9cad6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.ac.open .ac-desc{-webkit-line-clamp:unset}\n.ac-more{display:none;grid-template-columns:1fr 1fr;gap:6px 12px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);font-size:12px;color:var(--mut)}.ac-more b{display:block;color:var(--txt);font-size:13px}.ac.open .ac-more{display:grid}\n.ac-fill{position:absolute;left:0;right:0;bottom:0;padding:9px;font-size:12.5px;font-weight:800;color:#041018;background:linear-gradient(135deg,var(--cy),#5fe8c0);transform:translateY(100%);transition:.25s;display:flex;align-items:center;justify-content:center;gap:6px}.ac:hover .ac-fill{transform:none}\n.more{grid-column:1/-1;padding:10px;border-radius:12px;border:1px solid var(--ln);background:rgba(255,255,255,.03);color:var(--mut);font:inherit;cursor:pointer;transition:.2s}.more:hover{color:var(--cy);border-color:var(--cy)}\n/* 出装推荐 */\n.bs{margin-top:22px}.bs:first-child{margin-top:12px}\n.bh{display:flex;align-items:center;gap:8px;margin-bottom:12px}.bh b{font-size:14px;letter-spacing:1px}.bh small{color:var(--mut);font-size:12px}.bh .ico{color:var(--cy);width:18px;height:18px}\n.bs.bad .bh .ico,.bs.bad .bh b{color:var(--down)}\n.cb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px}\n.cb{position:relative;padding:18px 14px 12px;border-radius:14px;border:1px solid var(--ln);background:linear-gradient(180deg,rgba(25,211,230,.05),rgba(255,255,255,.01));transition:.25s}.cb:hover{transform:translateY(-2px)}\n.cb.best{border-color:rgba(240,195,90,.7);background:linear-gradient(180deg,rgba(80,62,16,.35),rgba(255,255,255,.01));box-shadow:0 0 28px rgba(240,195,90,.12)}\n.cb.bad{border-color:rgba(255,107,122,.35);background:linear-gradient(180deg,rgba(90,20,30,.28),rgba(255,255,255,.01))}\n.cb-rk{position:absolute;top:-10px;left:12px;font-size:11px;font-weight:800;padding:1px 10px;border-radius:99px;background:#173049;color:var(--txt)}.cb.best .cb-rk{background:var(--gold);color:#241a02}\n.cb-items{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.pl{font-style:normal;color:var(--mut);font-weight:700}\n.bi{display:inline-block;width:48px;height:48px;border-radius:11px;overflow:hidden;border:1px solid rgba(255,255,255,.16);flex:none;background:#0a1524;transition:.2s}.bi:hover{transform:scale(1.08);border-color:var(--cy)}.bi img{width:100%;height:100%;display:block}\n.cb-wr{display:flex;align-items:baseline;gap:10px;margin-top:12px}.cb-wr b{font-size:26px;font-weight:900;color:var(--cy)}.cb.best .cb-wr b{color:var(--gold)}.cb.bad .cb-wr b{color:var(--down)}.cb-wr small{color:var(--mut);font-size:12px}\n.cb-nm{margin-top:6px;font-size:12px;color:#9fb4c3;line-height:1.5}\n.tl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));gap:10px}\n.tl{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:12px;border:1px solid var(--ln);background:rgba(255,255,255,.025);transition:.2s}.tl:hover{border-color:rgba(25,211,230,.45);transform:translateY(-2px)}\n.tl-t{flex:1;min-width:0}.tl-t b{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13.5px;line-height:1.3}.tl-t small{color:var(--mut);font-size:11.5px}\n.tl-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.07);margin-top:6px;overflow:hidden}.tl-bar i{display:block;height:100%;background:linear-gradient(90deg,var(--cy),#6a35ff)}\n.tl-w{font-size:17px;font-weight:800;color:var(--cy)}.qty{color:var(--gold);margin-right:4px}\n.sp-grid{display:flex;flex-wrap:wrap;gap:10px}.sp{display:flex;align-items:baseline;gap:10px;padding:10px 16px;border-radius:12px;border:1px solid var(--ln);background:rgba(255,255,255,.025)}.sp b{font-size:14px}.sp span{font-weight:800;color:var(--cy);font-size:16px}.sp small{color:var(--mut)}\n.sk{display:flex;gap:8px;align-items:center;color:var(--mut);margin-top:22px}.sk b{display:inline-grid;place-items:center;width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,var(--cy),#5fe8c0);color:#041018}\n.trap-row{display:flex;flex-wrap:wrap;gap:10px}.trap{display:inline-flex;align-items:center;gap:8px;padding:6px 14px 6px 6px;border-radius:12px;border:1px solid rgba(255,107,122,.4);background:rgba(90,20,30,.25);font-size:13px}.trap img{width:34px;height:34px;border-radius:8px}\n.bsnote{font-size:12px;color:var(--gold);margin-bottom:6px}\n.up{color:var(--up)}.down{color:var(--down)}\n#tip{position:fixed;left:0;top:0;z-index:90;width:max-content;max-width:320px;pointer-events:none;opacity:0;transition:opacity .15s;padding:12px 14px;border-radius:12px;background:rgba(7,18,32,.96);border:1px solid rgba(25,211,230,.4);box-shadow:0 14px 40px rgba(0,0,0,.6);backdrop-filter:blur(10px)}\n#tip.on{opacity:1}.tp-h{display:flex;gap:10px;align-items:center}.tp-h img{width:40px;height:40px;border-radius:9px}.tp-h b{display:block;font-size:14px}.tp-h span{font-size:12px;color:var(--gold)}\n.tp-d{margin-top:8px;font-size:12.5px;line-height:1.65;color:#c4d3de}.tp-s{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,.08);font-size:12px;color:var(--mut)}.tp-s b{margin-left:6px;color:var(--cy)}\n.srow .st{background:rgba(255,255,255,.06);color:var(--mut)}\n</style>\n</head>\n<body>\n<div class=\"bg\" id=\"bg\"></div>\n<div class=\"wrap\">\n<header>\n  <div class=\"logo\"><i data-i=\"swords\"></i></div>\n  <h1>HEXTECH 推荐官<small>海克斯大乱斗 · 三选一决策</small></h1>\n  <select id=\"version\"></select>\n  <button class=\"iconbtn\" id=\"setBtn\" title=\"设置\"><i data-i=\"settings\"></i></button>\n</header>\n<div class=\"setpop\" id=\"setPop\">\n  <div class=\"sph\">设置</div>\n  <div class=\"sb\">\n    <div class=\"srow\" id=\"rowJev\"><span id=\"siJev\"></span><b>jev 智能决策</b><em class=\"st\" id=\"stJev\">检测中…</em><button class=\"how\" data-how=\"Jev\" title=\"如何开启\">?</button></div>\n    <div class=\"howbox\" id=\"howJev\"></div>\n    <div class=\"srow\" id=\"rowLoc\"><span id=\"siLoc\"></span><b>本地识别（内置）</b><em class=\"st\" id=\"stLoc\">未加载</em></div>\n    <div class=\"srow\" id=\"rowOcr\"><span id=\"siOcr\"></span><b>AI 兜底识别</b><em class=\"st\" id=\"stOcr\">检测中…</em><button class=\"how\" data-how=\"Ocr\" title=\"如何开启\">?</button></div>\n    <div class=\"howbox\" id=\"howOcr\"></div>\n    <div class=\"sgrp\">访问令牌</div>\n    <div class=\"tokrow\"><input type=\"password\" id=\"tokenInput\" placeholder=\"ACCESS_TOKEN\" autocomplete=\"off\"><button class=\"iconbtn\" id=\"tokenEye\" title=\"显示 / 隐藏\"><i data-i=\"eye\"></i></button><button class=\"iconbtn\" id=\"tokenSave\" title=\"保存\"><i data-i=\"check\"></i></button><button class=\"iconbtn\" id=\"tokenClear\" title=\"清除\"><i data-i=\"x\"></i></button></div>\n    <div class=\"sgrp\">截图范围</div>\n    <select id=\"cropSel\"><option value=\"full\">整个画面</option><option value=\"band\">中部横带</option><option value=\"center\">中央</option></select>\n  </div>\n</div>\n<div id=\"draftBanner\" class=\"panel\" style=\"display:none;margin-bottom:10px\"></div>\n\n<div class=\"step\"><b>1</b>选择英雄</div>\n<div class=\"panel\">\n  <div class=\"field\"><input id=\"champInput\" placeholder=\"搜索英雄：亚索 / yasuo / ys\" autocomplete=\"off\"><button class=\"clr\" id=\"champClear\" title=\"清除\"><i data-i=\"x\"></i></button><div id=\"champDrop\" class=\"drop\"></div></div>\n  <div id=\"champCard\"></div>\n</div>\n\n<div class=\"step\"><b>2</b>本局已选（参与协同评估）</div>\n<div class=\"rail\" id=\"pickedChips\"></div>\n\n<div class=\"step\"><b>3</b>输入三选一</div>\n<div class=\"panel\">\n  <div class=\"hud\" id=\"scan\">\n    <i class=\"cn n1\"></i><i class=\"cn n2\"></i><i class=\"cn n3\"></i><i class=\"cn n4\"></i><div class=\"scanline\"></div>\n    <div class=\"hud-ico\"><i data-i=\"scan-line\"></i></div>\n    <div class=\"hud-title\">截取游戏画面，自动识别三张海克斯</div>\n    <div class=\"hud-sub\" id=\"liveSub\">点「一键悬浮识别」，选择「整个屏幕」分享一次：选人自动识别英雄，对局出卡/刷新自动识别推荐（本地识别，不耗 AI 额度）</div>\n    <button class=\"btn gold xl\" id=\"liveGo\"><i data-i=\"picture-in-picture-2\"></i>一键悬浮识别</button>\n    <div class=\"hud-more\">\n      <label class=\"mini\" id=\"shot\" for=\"shotInput\"><i data-i=\"camera\"></i>上传 / 粘贴 / 拖入截图</label>\n      <input type=\"file\" id=\"shotInput\" accept=\"image/*\" hidden>\n      <button class=\"mini\" id=\"capGo\"><i data-i=\"scan-line\"></i>截取并识别</button>\n      <button class=\"mini\" id=\"capStop\" disabled><i data-i=\"x\"></i>停止共享</button>\n      <button class=\"mini\" id=\"shotClear\">清除截图</button>\n    </div>\n    <img id=\"shotPreview\" class=\"pv\" alt=\"\">\n  </div>\n  <div class=\"capbox\" id=\"capBox\"><video id=\"capVideo\" muted playsinline></video></div>\n  <div class=\"cta\" style=\"margin:10px 0 18px\"><button class=\"btn gold\" id=\"ocrGo\">识别并推荐</button><span class=\"stat\" id=\"ocrMsg\" style=\"align-self:center\"></span></div>\n  <div class=\"ctrl\"><div class=\"seg\" id=\"seg\"><button data-m=\"auto\" class=\"on\"><i data-i=\"brain-circuit\"></i>智能（jev）</button><button data-m=\"wr\"><i data-i=\"chart-column\"></i>纯胜率排序</button></div>\n    <button class=\"chip tgl on\" id=\"onlyOk\" type=\"button\"><i data-i=\"list-filter\"></i>仅显示该英雄可选海克斯<em id=\"okCnt\"></em></button></div>\n  <div class=\"slots\">\n    <div class=\"slot\"><i>A</i><div class=\"field\"><input id=\"aug0\" placeholder=\"海克斯 1\" autocomplete=\"off\"><button class=\"clr\" id=\"augClear0\" title=\"清除\"><i data-i=\"x\"></i></button><div id=\"drop0\" class=\"drop\"></div></div></div>\n    <div class=\"slot\"><i>B</i><div class=\"field\"><input id=\"aug1\" placeholder=\"海克斯 2\" autocomplete=\"off\"><button class=\"clr\" id=\"augClear1\" title=\"清除\"><i data-i=\"x\"></i></button><div id=\"drop1\" class=\"drop\"></div></div></div>\n    <div class=\"slot\"><i>C</i><div class=\"field\"><input id=\"aug2\" placeholder=\"海克斯 3\" autocomplete=\"off\"><button class=\"clr\" id=\"augClear2\" title=\"清除\"><i data-i=\"x\"></i></button><div id=\"drop2\" class=\"drop\"></div></div></div>\n  </div>\n  <div class=\"cands\" id=\"cands\"></div>\n  <div class=\"cta\"><button class=\"btn main\" id=\"go\"><i data-i=\"zap\"></i>推荐最优</button><button class=\"btn ghost\" id=\"clearSlots\">清空</button></div>\n</div>\n\n<div class=\"step\"><b>4</b>推荐结果</div>\n<div id=\"out\"><div class=\"stat\">选好英雄和候选后，结果会出现在这里。</div></div>\n</div>\n<div id=\"toast\"></div>\n\n<script>\nconst ICONS = {\"brain-circuit\": \"<path d=\\\"M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z\\\" /> <path d=\\\"M9 13a4.5 4.5 0 0 0 3-4\\\" /> <path d=\\\"M6.003 5.125A3 3 0 0 0 6.401 6.5\\\" /> <path d=\\\"M3.477 10.896a4 4 0 0 1 .585-.396\\\" /> <path d=\\\"M6 18a4 4 0 0 1-1.967-.516\\\" /> <path d=\\\"M12 13h4\\\" /> <path d=\\\"M12 18h6a2 2 0 0 1 2 2v1\\\" /> <path d=\\\"M12 8h8\\\" /> <path d=\\\"M16 8V5a2 2 0 0 1 2-2\\\" /> <circle cx=\\\"16\\\" cy=\\\"13\\\" r=\\\".5\\\" /> <circle cx=\\\"18\\\" cy=\\\"3\\\" r=\\\".5\\\" /> <circle cx=\\\"20\\\" cy=\\\"21\\\" r=\\\".5\\\" /> <circle cx=\\\"20\\\" cy=\\\"8\\\" r=\\\".5\\\" />\", \"chart-column\": \"<path d=\\\"M3 3v16a2 2 0 0 0 2 2h16\\\" /> <path d=\\\"M18 17V9\\\" /> <path d=\\\"M13 17V5\\\" /> <path d=\\\"M8 17v-3\\\" />\", \"camera\": \"<path d=\\\"M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z\\\" /> <circle cx=\\\"12\\\" cy=\\\"13\\\" r=\\\"3\\\" />\", \"zap\": \"<path d=\\\"M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z\\\" />\", \"crown\": \"<path d=\\\"M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z\\\" /> <path d=\\\"M5 21h14\\\" />\", \"check\": \"<path d=\\\"M20 6 9 17l-5-5\\\" />\", \"triangle-alert\": \"<path d=\\\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\\\" /> <path d=\\\"M12 9v4\\\" /> <path d=\\\"M12 17h.01\\\" />\", \"x\": \"<path d=\\\"M18 6 6 18\\\" /> <path d=\\\"m6 6 12 12\\\" />\", \"swords\": \"<path d=\\\"m13 19 6-6\\\" /> <path d=\\\"M14.5 17.5 3.586 6.586A2 2 0 013 5.172V3h2.172a2 2 0 011.414.586L17.5 14.5\\\" /> <path d=\\\"m14.828 6.172 2.586-2.586A2 2 0 0118.828 3H21v2.172a2 2 0 01-.586 1.414l-2.586 2.586\\\" /> <path d=\\\"m16 16 4 4\\\" /> <path d=\\\"m19 21 2-2\\\" /> <path d=\\\"m5 14 4 4\\\" /> <path d=\\\"m5 21-2-2\\\" /> <path d=\\\"M7.5 16.5 4 20\\\" />\", \"trending-up\": \"<path d=\\\"M16 7h6v6\\\" /> <path d=\\\"m22 7-8.5 8.5-5-5L2 17\\\" />\", \"trending-down\": \"<path d=\\\"M16 17h6v-6\\\" /> <path d=\\\"m22 17-8.5-8.5-5 5L2 7\\\" />\", \"minus\": \"<path d=\\\"M5 12h14\\\" />\", \"arrow-right\": \"<path d=\\\"M5 12h14\\\" /> <path d=\\\"m12 5 7 7-7 7\\\" />\", \"settings\": \"<path d=\\\"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z\\\" /> <circle cx=\\\"12\\\" cy=\\\"12\\\" r=\\\"3\\\" />\"};\nObject.assign(ICONS, {\"monitor\": \"<rect width=\\\"20\\\" height=\\\"14\\\" x=\\\"2\\\" y=\\\"3\\\" rx=\\\"2\\\" /> <line x1=\\\"8\\\" x2=\\\"16\\\" y1=\\\"21\\\" y2=\\\"21\\\" /> <line x1=\\\"12\\\" x2=\\\"12\\\" y1=\\\"17\\\" y2=\\\"21\\\" />\", \"scan-line\": \"<path d=\\\"M3 7V5a2 2 0 0 1 2-2h2\\\" /> <path d=\\\"M17 3h2a2 2 0 0 1 2 2v2\\\" /> <path d=\\\"M21 17v2a2 2 0 0 1-2 2h-2\\\" /> <path d=\\\"M7 21H5a2 2 0 0 1-2-2v-2\\\" /> <path d=\\\"M7 12h10\\\" />\", \"picture-in-picture-2\": \"<path d=\\\"M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4\\\" /> <rect width=\\\"10\\\" height=\\\"7\\\" x=\\\"12\\\" y=\\\"13\\\" rx=\\\"2\\\" />\", \"list-filter\": \"<path d=\\\"M2 5h20\\\" /> <path d=\\\"M6 12h12\\\" /> <path d=\\\"M9 19h6\\\" />\"});\nObject.assign(ICONS, {\"chevron-down\": \"<path d=\\\"m6 9 6 6 6-6\\\" />\", \"circle-check\": \"<circle cx=\\\"12\\\" cy=\\\"12\\\" r=\\\"10\\\" /> <path d=\\\"m16 9-5.5 5.5L8 12\\\" />\", \"circle-alert\": \"<circle cx=\\\"12\\\" cy=\\\"12\\\" r=\\\"10\\\" /> <line x1=\\\"12\\\" x2=\\\"12\\\" y1=\\\"8\\\" y2=\\\"12\\\" /> <line x1=\\\"12\\\" x2=\\\"12.01\\\" y1=\\\"16\\\" y2=\\\"16\\\" />\", \"eye\": \"<path d=\\\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\\\" /> <circle cx=\\\"12\\\" cy=\\\"12\\\" r=\\\"3\\\" />\", \"eye-off\": \"<path d=\\\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\\\" /> <path d=\\\"M14.084 14.158a3 3 0 0 1-4.242-4.242\\\" /> <path d=\\\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\\\" /> <path d=\\\"m2 2 20 20\\\" />\", \"copy\": \"<rect width=\\\"14\\\" height=\\\"14\\\" x=\\\"8\\\" y=\\\"8\\\" rx=\\\"2\\\" ry=\\\"2\\\" /> <path d=\\\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\\\" />\"});\nObject.assign(ICONS, {\"info\": \"<circle cx=\\\"12\\\" cy=\\\"12\\\" r=\\\"10\\\" /> <path d=\\\"M12 16v-4\\\" /> <path d=\\\"M12 8h.01\\\" />\", \"plus\": \"<path d=\\\"M5 12h14\\\" /> <path d=\\\"M12 5v14\\\" />\", \"flame\": \"<path d=\\\"M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4\\\" />\", \"sword\": \"<path d=\\\"m11 19-6-6\\\" /> <path d=\\\"m5 21-2-2\\\" /> <path d=\\\"m8 16-4 4\\\" /> <path d=\\\"M9.5 17.5 20.414 6.586A2 2 0 0021 5.172V3h-2.172a2 2 0 00-1.414.586L6.5 14.5\\\" />\", \"skull\": \"<path d=\\\"m12.5 17-.5-1-.5 1h1z\\\" /> <path d=\\\"M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z\\\" /> <circle cx=\\\"15\\\" cy=\\\"12\\\" r=\\\"1\\\" /> <circle cx=\\\"9\\\" cy=\\\"12\\\" r=\\\"1\\\" />\", \"users\": \"<path d=\\\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\\\" /> <path d=\\\"M16 3.128a4 4 0 0 1 0 7.744\\\" /> <path d=\\\"M22 21v-2a4 4 0 0 0-3-3.87\\\" /> <circle cx=\\\"9\\\" cy=\\\"7\\\" r=\\\"4\\\" />\", \"footprints\": \"<path d=\\\"M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z\\\" /> <path d=\\\"M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z\\\" /> <path d=\\\"M16 17h4\\\" /> <path d=\\\"M4 13h4\\\" />\"});\nconst ic = n => `<svg class=\"ico\" viewBox=\"0 0 24 24\" aria-hidden=\"true\">${ICONS[n] || ''}</svg>`;\nconst hydrate = root => (root || document).querySelectorAll('i[data-i]').forEach(e => e.outerHTML = ic(e.dataset.i));\nconst $ = id => document.getElementById(id);\nconst S = { version: null, champions: [], augments: [], picked: [], seq: 0, augWr: new Map(), stat: { jev: true, ocr: true }, mode: 'auto', only: true, allowed: new Set() };\nconst esc = s => String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\nconst pct = (x, d = 1) => (x * 100).toFixed(d) + '%';\nconst fmtGames = n => n == null ? '' : n >= 10000 ? (n / 10000).toFixed(1) + '万场' : n.toLocaleString() + '场';\nfunction toast(t) { if (S.pipMsg) S.pipMsg.textContent = t; const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('show'), 2200); }\n\nconst _PB='阿八嚓哒妸发旮哈讥咔垃妈拏噢妑七呥扨它穵夕丫帀',_PL='abcdefghjklmnopqrstwxyz',_CO=new Intl.Collator('zh-Hans-CN');\nconst _pc=c=>{if(/[a-zA-Z]/.test(c))return c.toLowerCase();if(c<'\\u4e00'||c>'\\u9fff')return '';let r=-1;for(let i=0;i<_PB.length;i++){if(_CO.compare(_PB[i],c)<=0)r=i;else break}return r<0?'':_PL[r]};\nconst pyOf = s => [...String(s || '')].map(_pc).join('');\nconst withPy = items => (items.forEach(x => { x._py = pyOf(x.name) + ' ' + pyOf(x.title || ''); }), items);\n\nlet TOKEN = new URLSearchParams(location.search).get('token') || localStorage.getItem('hextech_token') || '';\nasync function api(p, opts = {}) {\n  if (TOKEN) opts.headers = { ...(opts.headers || {}), 'X-Token': TOKEN };\n  const r = await fetch(p, opts);\n  const d = await r.json().catch(() => ({}));\n  if (!r.ok) throw new Error(d.error || r.status);\n  return d;\n}\n\n// ---------- autocomplete（支持 ↑↓ 回车） ----------\nfunction autocomplete(inputId, dropId, getSource, onPick) {\n  const input = $(inputId), drop = $(dropId);\n  let hits = [], idx = -1;\n  const close = () => { drop.classList.remove('open'); idx = -1; };\n  const paint = () => [...drop.children].forEach((c, i) => c.classList.toggle('on', i === idx));\n  const pick = h => { input.value = h.name; close(); onPick(h); };\n  input.addEventListener('input', () => {\n    const raw = input.value.trim(), q = raw.toLowerCase(), qp = q.replace(/\\s+/g, '');\n    if (!q) return close();\n    hits = getSource().filter(x => x.name.toLowerCase().includes(q) || (x.title && x.title.includes(raw)) ||\n      (x.alias && x.alias.toLowerCase().includes(q)) || (x._py && x._py.includes(qp)))\n      .map(x => ({ x, r: (x.name.toLowerCase().startsWith(q) || (x.title && x.title.startsWith(raw))) ? 0 : (x._py && x._py.split(' ').some(w => w.startsWith(qp))) ? 1 : 2 }))\n      .sort((a, b) => a.r - b.r).slice(0, 8).map(o => o.x);\n    drop.innerHTML = '';\n    hits.forEach(h => {\n      const d = document.createElement('div');\n      d.className = 'opt';\n      d.innerHTML = `${h.icon ? `<img class=\"oic\" src=\"${esc(h.icon)}\" alt=\"\" onerror=\"this.remove()\">` : ''}<span>${esc(h.name)}${h.title ? ' · ' + esc(h.title) : ''}${h.tier ? `<span class=\"tier ${esc(h.tier)}\">${esc(h.tier)}</span>` : ''}${h.desc ? `<span class=\"od\">${esc(h.desc)}</span>` : ''}</span>` +\n        (h.wr ? `<small>${pct(h.wr)}${h.tm ? ' · ' + fmtGames(h.tm) : ''}</small>` : '');\n      d.onmousedown = e => { e.preventDefault(); pick(h); };\n      drop.appendChild(d);\n    });\n    idx = hits.length ? 0 : -1; paint();\n    drop.classList.toggle('open', hits.length > 0);\n  });\n  input.addEventListener('keydown', e => {\n    if (!drop.classList.contains('open')) return;\n    if (e.key === 'ArrowDown') { idx = (idx + 1) % hits.length; paint(); e.preventDefault(); }\n    else if (e.key === 'ArrowUp') { idx = (idx - 1 + hits.length) % hits.length; paint(); e.preventDefault(); }\n    else if (e.key === 'Enter' && idx >= 0) { pick(hits[idx]); e.preventDefault(); }\n    else if (e.key === 'Escape') close();\n  });\n  input.addEventListener('blur', () => setTimeout(close, 120));\n}\n\n// ---------- 英雄 ----------\nfunction renderChampCard(d) {\n  const c = d.champion; S.allowed = new Set(d.augIds || []); updateFilterLabel(); S.augWr = new Map((d.augWr || []).map(([id, wr, tm]) => [id, { wr, tm }])); renderCands();\n  const mono = c.icon ? `<img src=\"${esc(c.icon)}\" alt=\"\" onerror=\"this.remove()\">` : esc([...c.name][0]);\n  const buffs = d.buffs.length\n    ? d.buffs.map(b => `<span class=\"pill ${b.tone === 'up' ? 'up' : b.tone === 'down' ? 'down' : ''}\">${esc(b.label)} ${esc(b.value)} ${ic(b.tone === 'up' ? 'trending-up' : b.tone === 'down' ? 'trending-down' : 'minus')}</span>`).join('')\n    : '<span class=\"stat\">本版本无平衡性调整</span>';\n  const tops = d.topAugments.map(a => `<button class=\"chip aug-fill\" data-name=\"${esc(a.name)}\">${a.icon ? `<img class=\"cic\" src=\"${esc(a.icon)}\" alt=\"\" onerror=\"this.remove()\">` : ''}${esc(a.name)}<small>${pct(a.wr)}</small></button>`).join('');\n  $('champCard').innerHTML = `<div class=\"champ\"><div class=\"mono\">${mono}</div><div class=\"cinfo\">\n    <h2>${esc(c.name)} · ${esc(c.title)}<span class=\"tier ${esc(c.tier)}\">${esc(c.tier)}</span></h2>\n    <div class=\"stat\">${c.tm.toLocaleString()} 场${d.source === 'arammeta-backup' ? ' · <span style=\"color:var(--gold)\">备用数据(台服)</span>' : ''}</div>\n    <div class=\"pills\">${buffs}</div></div>\n    <div class=\"cwr\"><b data-count=\"${(c.wr * 100).toFixed(1)}\">${pct(c.wr)}</b><small>该英雄胜率</small></div></div>\n    <div class=\"sec\"><div class=\"sh\">${ic('flame')}<span>常用海克斯</span><small>点卡片填入空位 · 不限制候选范围</small></div><div id=\"topSort\" style=\"margin-top:12px\"></div><div id=\"tops\"></div></div>\n    <details class=\"sec\" open><summary class=\"sh\">${ic('sword')}<span>出装推荐</span><small id=\"bsrc\">点击收起 / 展开</small><span class=\"chev\">${ic('chevron-down')}</span></summary><div id=\"builds\"><span class=\"stat\">加载中…</span></div></details>`;\n  S.champWr = c.wr; renderTops(); fx($('champCard'));\n  renderBuilds(c.name).catch(() => {});\n  $('champCard').querySelectorAll('.aug-fill').forEach(b => { b.onclick = () => fillSlot(b.dataset.name); });\n}\nasync function selectChampion(h) {\n  const my = ++S.seq;\n  $('champInput').value = h.name;\n  $('champCard').innerHTML = '<div class=\"stat\" style=\"margin-top:10px\">加载中…</div>';\n  try {\n    const d = await api(`/api/champion-detail?name=${encodeURIComponent(h.name)}&version=${encodeURIComponent(S.version)}`);\n    if (my === S.seq) renderChampCard(d);\n  } catch (e) { if (my === S.seq) $('champCard').innerHTML = `<div class=\"stat\">加载失败：${esc(e.message)}</div>`; }\n}\n\n// ---------- 已选 ----------\nfunction renderPicked() {\n  const el = $('pickedChips');\n  el.innerHTML = (S.picked.length\n    ? S.picked.map((n, i) => `<button class=\"chip pk\" data-i=\"${i}\">${esc(n)}<small>${ic('x')}</small></button>`).join('') + '<button class=\"chip pkclear\">清空</button>'\n    : '<span class=\"stat\">暂无 — 在推荐结果里点「选它」，下一轮会参与协同评估</span>');\n  el.querySelectorAll('.pk').forEach(b => b.onclick = () => { S.picked.splice(+b.dataset.i, 1); renderPicked(); });\n  const c = el.querySelector('.pkclear'); if (c) c.onclick = () => { S.picked = []; renderPicked(); }; renderCands();\n}\n\n// ---------- 结果 ----------\nfunction renderResult(d) {\n  const cards = d.ranking.map((r, i) => {\n    const isPick = r.name === d.pick;\n    const hasWr = r.champWr != null;\n    const eff = r.eff != null ? r.eff : (hasWr ? r.champWr : r.globalWr);\n    const w = r.score != null ? Math.min(100, r.score / 4 * 100) : Math.max(4, Math.min(100, (eff - 0.4) / 0.2 * 100));\n    const icon = (S.augIcon || {})[r.name];\n    const desc = (S.augDesc || {})[r.name];\n    const raw = hasWr ? `原始 ${pct(r.champWr)}${r.champTm ? ' · ' + fmtGames(r.champTm) : ''}` : `全局 ${pct(r.globalWr)}`;\n    return `<div class=\"rc${isPick ? ' pick' : ''}${hasWr ? '' : ' nodata'}\" style=\"animation-delay:${i * .1}s\"><div class=\"rank\">${i + 1}</div>${isPick ? `<div class=\"crown\">${ic('crown')}</div>` : ''}\n      <h3>${icon ? `<img class=\"ric\" src=\"${esc(icon)}\" alt=\"\" onerror=\"this.remove()\">` : ''}${esc(r.name)}</h3>\n      ${desc ? `<div class=\"desc\">${esc(desc)}</div>` : ''}\n      <div class=\"big\" data-count=\"${(eff * 100).toFixed(1)}\">${pct(eff)}</div>\n      <div class=\"stat\">修正胜率 · ${raw}</div>${hasWr ? '' : '<div class=\"tag\">该英雄无对局数据</div>'}\n      <div class=\"bar\"><div class=\"fill\" style=\"width:0\" data-w=\"${w}\"></div></div>\n      <div class=\"stat\">${r.score != null ? 'jev 评分 ' + r.score.toFixed(2) + ' / 4' : '胜率相对强度'}</div>\n      <button class=\"btn ${isPick ? 'gold' : 'ghost'} mark\" data-name=\"${esc(r.name)}\">${ic('check')}选它</button></div>`;\n  }).join('');\n  const warn = d.conflictProb != null && d.conflictProb >= 0.5\n    ? `<div class=\"warn\">${ic('triangle-alert')}<span>jev 认为所选海克斯与英雄定位可能冲突（${(d.conflictProb * 100).toFixed(0)}%），请谨慎</span></div>` : '';\n  const meta = `<div class=\"meta\"><span class=\"badge ${d.source === 'jev' ? '' : 'local'}\">${d.source === 'jev' ? 'jev 决策' : d.source === 'win-rate' ? '纯胜率排序' : '本地规则'}</span>` +\n    (d.confidence != null ? `置信度 ${Number(d.confidence).toFixed(2)} · ` : '') + `版本 ${esc(d.version)}` +\n    (d.jevError ? ` · jev 不可用：${esc(d.jevError)}` : '') + (S.picked.length ? ` · 已考虑：${esc(S.picked.join('、'))}` : '') + '</div>';\n  const DEG = { 'no-key': 'jev 未配置，已降档为纯胜率排序', 'jev-error': 'jev 调用失败，已降档为纯胜率排序', 'low-confidence': 'jev 置信度不足，已降档为纯胜率排序', conflict: 'jev 判定最优项与英雄定位冲突，已降档为纯胜率排序' };\n  const deg = d.degraded ? `<div class=\"warn deg\">${ic('triangle-alert')}<span>${DEG[d.degraded] || '已降档为纯胜率排序'}</span></div>` : '';\n  return `${deg}<div class=\"results\">${cards}</div>${warn}${meta}`;\n}\nfunction showResult(html, target = $('out')) {\n  target.innerHTML = html;\n  requestAnimationFrame(() => { target.querySelectorAll('.fill').forEach(f => f.style.width = f.dataset.w + '%'); fx(target); });\n  target.querySelectorAll('.mark').forEach(b => { b.onclick = () => markPicked(b.dataset.n, true); });\n}\nfunction markPicked(n, fromPip) {\n  if (!S.picked.includes(n)) S.picked.push(n);\n  renderPicked();\n  [0, 1, 2].forEach(i => $('aug' + i).value = ''); renderCands();\n  $('out').innerHTML = `<div class=\"stat\">已记录「${esc(n)}」，输入下一轮候选继续。</div>`;\n  toast('已记入本局已选');\n  if (S.pipRes) S.pipRes.innerHTML = `<div class=\"stat\">已记录「${esc(n)}」，等待下一轮…</div>`;\n  if (S.pipAuto && S.pipAuto.checked) setAuto(true);\n  if (!fromPip) window.scrollTo({ top: 0, behavior: 'smooth' });\n}\n\n// ---------- 截图 ----------\nlet shotDataUrl = null;\nfunction handleShot(file) {\n  if (!file || !file.type.startsWith('image/')) return;\n  const img = new Image();\n  img.onload = () => {\n    const sc = Math.min(1, 1280 / img.width), cv = document.createElement('canvas');\n    cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);\n    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);\n    shotDataUrl = cv.toDataURL('image/jpeg', 0.72);\n    S.fullFrame = cropFrame(img, img.width, img.height, img.width / img.height >= 1.5);   // 原始分辨率；整屏截图只取中部横带，更快更准\n    getOcrWorker().catch(() => {});\n    const pv = $('shotPreview'); pv.src = shotDataUrl; pv.style.display = 'block';\n    URL.revokeObjectURL(img.src); $('ocrMsg').textContent = '';\n  };\n  img.src = URL.createObjectURL(file);\n}\n$('shotInput').onchange = e => handleShot(e.target.files[0]);\ndocument.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith('image/')); if (f) handleShot(f); });\nconst shot = $('scan');\n['dragenter', 'dragover'].forEach(t => shot.addEventListener(t, e => { e.preventDefault(); shot.classList.add('over'); }));\n['dragleave', 'drop'].forEach(t => shot.addEventListener(t, e => { e.preventDefault(); shot.classList.remove('over'); }));\nshot.addEventListener('drop', e => handleShot(e.dataTransfer.files[0]));\n\n// ---- 本地识别：词典定位 + 三张卡标题挑选（页面与测试共用同一份代码）----\nconst normT = s => String(s ?? '').replace(/[^\\u4e00-\\u9fffA-Za-z0-9]/g, '');\nfunction levT(a, b) {\n  const m = a.length, n = b.length; if (!m) return n; if (!n) return m;\n  let prev = Array.from({ length: n + 1 }, (_, j) => j);\n  for (let i = 1; i <= m; i++) { const cur = [i]; for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }\n  return prev[n];\n}\n// 名字越短越严格：2 字必须一致，3~4 字最多错 1 字，5 字以上最多错 2 字\nconst maxErrT = L => L <= 2 ? 0 : L <= 4 ? 1 : 2;\n// 把一行 OCR 结果拆成「字 + 横坐标」，用于合并行时仍能分辨三张卡的位置\nfunction lineCharsT(ln) {\n  const chars = [];\n  for (const w of (ln.words || [])) {\n    const t = normT(w.text); if (!t) continue; const { x0, x1 } = w.bbox;\n    [...t].forEach((ch, i) => chars.push({ ch, x: x0 + (x1 - x0) * (i + .5) / t.length }));\n  }\n  if (!chars.length) { const t = normT(ln.text), { x0, x1 } = ln.bbox; [...t].forEach((ch, i) => chars.push({ ch, x: x0 + (x1 - x0) * (i + .5) / t.length })); }\n  return chars;\n}\nfunction spotLineT(ln, dictN, errBonus) {\n  const chars = lineCharsT(ln), t = chars.map(c => c.ch).join(''), out = [];\n  if (t.length < 2) return out;\n  for (const [name, n] of dictN) {\n    const L = n.length, meS = maxErrT(L), me = meS + (errBonus || 0);\n    if (t.length < L - me) continue;\n    let best = 99, bi = 0, bw = 0;\n    for (let w = Math.max(2, L - meS); w <= L + meS; w++) for (let i = 0; i + w <= t.length; i++) {\n      const e = levT(n, t.slice(i, i + w)); if (e < best) { best = e; bi = i; bw = w; } if (best === 0) break;\n    }\n    if (best > me) continue;\n    const xs = chars.slice(bi, bi + bw).map(c => c.x);\n    // 分数 = 名字被匹配的字数 / max(名字长度, 整行长度)：名字只解释了行里一小部分时（如「虹吸」vs「灵瑰虹吸」）得分更低\n    out.push({ name, errs: best, score: (L - best) / Math.max(L, t.length), xc: xs.reduce((a, b) => a + b, 0) / xs.length });\n  }\n  return out;\n}\nfunction pickStrictT(lines, dictN, errBonus) {\n  const cands = [];\n  for (const ln of lines) {\n    const { y0, y1 } = ln.bbox, h = y1 - y0;\n    for (const m of spotLineT(ln, dictN, errBonus)) cands.push({ ...m, yc: (y0 + y1) / 2, h });\n  }\n  if (!cands.length) return [];\n  const byScore = (a, b) => b.score - a.score || b.name.length - a.name.length;\n  cands.sort(byScore);\n  const uniq = new Map(); for (const c of cands) if (!uniq.has(c.name)) uniq.set(c.name, c);\n  const list = [...uniq.values()], anchor = list[0], tol = Math.max(anchor.h * 0.9, 12);\n  const picked = [];\n  for (const c of list.filter(c => Math.abs(c.yc - anchor.yc) <= tol)) if (picked.every(p => Math.abs(p.xc - c.xc) > Math.max(c.h, p.h) * 2.5)) picked.push(c);\n  return picked.slice(0, 3).sort((a, b) => a.xc - b.xc);\n}\nfunction pickCardsT(lines, dictN) {\n  const picked = pickStrictT(lines, dictN, 0);\n  if (picked.length === 2) {\n    // 第三张标题可能有 2 个错字（如游戏字体 吞噬→知叭）：在同一横带上放宽一档补一次，位置不同才算\n    const anchor = picked[0], tol = Math.max(anchor.h * 0.9, 12);\n    const band = lines.filter(ln => Math.abs((ln.bbox.y0 + ln.bbox.y1) / 2 - anchor.yc) <= tol * 2);\n    for (const c of pickStrictT(band, dictN, 1)) {\n      if (picked.some(q => q.name === c.name)) continue;\n      if (picked.every(q => Math.abs(q.xc - c.xc) > Math.max(c.h, q.h) * 2.5)) picked.push(c);\n      if (picked.length >= 3) break;\n    }\n    picked.sort((a, b) => a.xc - b.xc);\n  }\n  return picked.slice(0, 3);\n}\n\n// ---- 自动识别英雄：选人界面中央大字最准，按文字大小加权 ----\nfunction detectChampionFromLines(lines) {\n  if (!S.champions.length) return null;\n  const dict = S.champions.map(c => [c.name, normT(c.name)]).filter(([, n]) => n.length >= 2);\n  let best = null;\n  for (const ln of lines) {\n    const t = normT(ln.text || '');\n    if (t.length < 2) continue;\n    const h = Math.max(0, (ln.bbox.y1 - ln.bbox.y0) || 0);\n    for (const [name, n] of dict) {\n      let hit = false, base = 0;\n      if (t.includes(n)) { hit = true; base = n.length / t.length; }\n      else if (n.length >= 3) {\n        const maxE = (n.length >= 4 && h >= 28) ? 2 : 1;  // 中央大字：游戏字体易错 2 字\n        for (let i = 0; i + n.length <= t.length + 1 && i < t.length; i++) {\n          const e = levT(n, t.slice(i, i + n.length));\n          if (e <= maxE) { hit = true; base = (n.length - e) / t.length; break; }\n        }\n      }\n      if (hit) { const q = base * (1 + h / 80); if (!best || q > best.q) best = { name, q }; }\n    }\n  }\n  return best && best.q >= 0.35 ? best : null;\n}\nasync function detectChampion() {\n  if (!S.fullFrame || !S.champions.length) return null;\n  const w = await getOcrWorker();\n  const { data } = await w.recognize(prepForOcr(S.fullFrame));\n  return detectChampionFromLines((data.lines || []).map(l => ({ text: l.text, bbox: l.bbox })));\n}\n\n// ---- Tesseract.js 懒加载（首次识别时才下载，之后 IndexedDB 缓存）----\nconst OCR_V = '5.1.1', OCR_BASES = ['https://cdn.jsdelivr.net/npm/', 'https://fastly.jsdelivr.net/npm/', 'https://unpkg.com/'];\nconst loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('脚本加载失败')); document.head.appendChild(s); });\nfunction setEngine(s) {\n  S.engine = s; const r = $('rowLoc'); if (!r) return;\n  r.className = 'srow ' + (s === '就绪' ? 'ok' : s === '加载失败' ? 'no' : '');\n  $('siLoc').innerHTML = ic(s === '就绪' ? 'circle-check' : s === '加载失败' ? 'circle-alert' : 'scan-line'); $('stLoc').textContent = s;\n}\nasync function getOcrWorker() {\n  if (S.ocrW) return S.ocrW;\n  if (S.ocrP) return S.ocrP;\n  S.ocrP = (async () => {\n    let last;\n    for (const b of OCR_BASES) {\n      try {\n        setEngine('加载中…');\n        if (!window.Tesseract) await loadScript(`${b}tesseract.js@${OCR_V}/dist/tesseract.min.js`);\n        const w = await Promise.race([\n          Tesseract.createWorker('chi_sim', 1, { workerPath: `${b}tesseract.js@${OCR_V}/dist/worker.min.js`, corePath: `${b}tesseract.js-core@${OCR_V}/`,\n            langPath: `${b}@tesseract.js-data/chi_sim/4.0.0_best_int`, gzip: true, logger: m => { if (S.ocrProg) S.ocrProg(m); } }),\n          new Promise((_, rej) => setTimeout(() => rej(new Error('加载超时')), window.OCR_TIMEOUT || 120000))]);\n        await w.setParameters({ tessedit_pageseg_mode: '11' });   // 稀疏文本：卡片标题分散在三列\n        S.ocrW = w; setEngine('就绪'); return w;\n      } catch (e) { last = e; }\n    }\n    setEngine('加载失败'); S.ocrP = null; throw last || new Error('识别引擎加载失败');\n  })();\n  S.ocrP.catch(() => { S.ocrP = null; });\n  return S.ocrP;\n}\n// 预处理：小于 1800 宽放大到 1920（实测放大后识别率明显更高），反色灰度（亮字暗底 → 暗字亮底）\nfunction prepForOcr(src) {\n  const w = src.width, h = src.height, sc = Math.abs(w - 1920) / 1920 < .1 ? 1 : 1920 / w;   // 统一到约 1920 宽：小图放大识别率更高，大图缩小更快\n  const cv = document.createElement('canvas'); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);\n  const ctx = cv.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, cv.width, cv.height);\n  const id = ctx.getImageData(0, 0, cv.width, cv.height), d = id.data;\n  for (let i = 0; i < d.length; i += 4) { const g = 255 - (d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114); d[i] = d[i + 1] = d[i + 2] = g; }\n  ctx.putImageData(id, 0, 0); return cv;\n}\nasync function localRecognize(onProg) {\n  if (!S.fullFrame) throw new Error('没有可识别的画面');\n  if (!S.augments.length) throw new Error('海克斯名单还没加载');\n  S.ocrProg = onProg;\n  const w = await getOcrWorker();\n  const { data } = await w.recognize(prepForOcr(S.fullFrame));\n  if (S.dictKey !== S.version + ':' + S.augments.length) { S.dictN = S.augments.map(a => [a.name, normT(a.name)]).filter(([, n]) => n.length >= 2); S.dictKey = S.version + ':' + S.augments.length; }\n  const picked = pickCardsT((data.lines || []).map(l => ({ text: l.text, bbox: l.bbox, words: l.words })), S.dictN);\n  return { cards: picked.map(c => ({ ocr: c.name, matched: c.name, score: +c.score.toFixed(2) })) };\n}\n\nconst runOcr = $('ocrGo').onclick = async () => {\n  S.lastOcrOk = false;\n  let champ = $('champInput').value.trim();\n  const btn = $('ocrGo'); btn.disabled = true; btn.textContent = '识别中…'; if (!S.silent) skeleton();\n  const say = t => { if (!S.silent) { $('ocrMsg').textContent = t; if (S.pipMsg) S.pipMsg.textContent = t; } };\n  const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ champion: champ, version: S.version, picked: S.picked, mode: S.mode, ...body }) });\n  const done = () => { btn.disabled = false; btn.textContent = '识别并推荐'; };\n  try {\n    let cards = null, rec, via = '', t0 = performance.now();\n    if (S.silent) {\n      // ===== 持续监测：一次 OCR 同时做英雄跟随 + 卡片识别 =====\n      if (!S.fullFrame) { done(); return false; }\n      let lines;\n      try {\n        const w = await getOcrWorker();\n        const { data } = await w.recognize(prepForOcr(S.fullFrame));\n        lines = (data.lines || []).map(l => ({ text: l.text, bbox: l.bbox, words: l.words }));\n      } catch (e) { console.warn('画面识别失败：', e); done(); return false; }\n      // 选人阶段：英雄自动识别 / 换英雄跟随（进对局后 lastSig 非空即停；手动指定的不覆盖）\n      if (!S.lastSig && (!champ || S.heroAuto)) {\n        const d = detectChampionFromLines(lines);\n        if (d && d.name !== champ) {\n          if (!champ || S.heroCand === d.name) {  // 首次直接采用；切换需连续两轮一致防抖\n            S.heroCand = null;\n            const prev = champ;\n            champ = d.name;\n            $('champInput').value = champ; S.heroAuto = true; syncPipChamp(champ);\n            if (prev && prev !== champ && S.picked.length) { S.picked = []; renderPicked(); }  // 换英雄=新对局，清已选\n            const h = S.champions.find(x => x.name === champ);\n            if (h) selectChampion(h);\n            toast(prev ? `检测到换英雄：${prev} → ${champ}，已切换` : `已自动识别英雄：${champ}`);\n          } else S.heroCand = d.name;\n        } else S.heroCand = null;\n        champ = $('champInput').value.trim();\n      }\n      if (!champ) { if (S.pipMsg) S.pipMsg.textContent = '监测中…（等待选人）'; done(); return false; }\n      if (S.dictKey !== S.version + ':' + S.augments.length) { S.dictN = S.augments.map(a => [a.name, normT(a.name)]).filter(([, n]) => n.length >= 2); S.dictKey = S.version + ':' + S.augments.length; }\n      const hit = pickCardsT(lines, S.dictN).map(c => ({ ocr: c.name, matched: c.name, score: +c.score.toFixed(2) }));\n      cards = (hit.length >= 3 || (hit.length >= 2 && !S.stat.ocr)) ? hit : null;\n      via = '本地识别';\n      // 无卡→重置签名等下一轮；卡片未变→跳过不重复推荐（刷新/新一轮自动重识）\n      if (!cards) {\n        if (S.lastSig) { S.lastSig = null; if (S.pipMsg) S.pipMsg.textContent = '监测中…（等待下一轮三选一）'; }\n        done(); return false;\n      }\n      const sig = cards.map(c => c.matched).sort().join('|');\n      if (sig === S.lastSig) { done(); return false; }\n      S.lastSig = sig;\n      rec = await post('/api/recommend', { augments: cards.map(c => c.matched) });\n    } else {\n      // ===== 手动模式 =====\n      // 点识别时：当前英雄是自动识别来的（或还没选），就按画面重识；手动指定的不覆盖\n      if (S.fullFrame && (!champ || S.heroAuto)) {\n        say('正在识别英雄…');\n        try {\n          const d = await detectChampion();\n          if (d && d.name !== champ) {\n            const prev = champ;\n            champ = d.name;\n            $('champInput').value = champ; S.heroAuto = true; syncPipChamp(champ);\n            if (prev && S.picked.length) { S.picked = []; renderPicked(); }\n            const h = S.champions.find(x => x.name === champ);\n            if (h) selectChampion(h);\n            toast(prev ? `已切换英雄：${prev} → ${champ}` : `已识别英雄：${champ}`);\n          }\n        } catch (e) { console.warn('英雄识别失败：', e); }\n      }\n      if (!champ) { done(); return toast('请先选英雄'); }\n      if (!S.fullFrame && !shotDataUrl) { done(); return toast('请先上传或粘贴截图'); }\n      // 1) 本地识别优先：不耗 AI 额度\n      try {\n        say('本地识别中…');\n        const r = await localRecognize(m => { if (m.status && /load|init/.test(m.status)) say('加载识别引擎 ' + Math.round((m.progress || 0) * 100) + '%（首次使用，之后会缓存）'); });\n        if (r.cards.length >= 3 || (r.cards.length >= 2 && !S.stat.ocr)) { cards = r.cards; via = '本地识别'; }\n      } catch (e) { console.warn('本地识别失败：', e); }\n      if (cards) rec = await post('/api/recommend', { augments: cards.map(c => c.matched) });\n      else {\n        // 2) AI 兜底（仅手动模式；静默监测不耗 AI 额度）\n        if (!S.stat.ocr) throw new Error('本地没认出足够的卡片，且未启用 AI 兜底。请手动输入，或换更清晰的画面');\n        say('本地没认全，交给 AI 识别…');\n        const d = await post('/api/ocr-recommend', { image: shotDataUrl });\n        cards = d.cards; rec = d.recommend; via = 'AI 识别';\n      }\n    }\n    [0, 1, 2].forEach(i => { $('aug' + i).value = (cards[i] && cards[i].matched) || ''; }); renderCands();\n    $('ocrMsg').innerHTML = `<span class=\"badge${via === 'AI 识别' ? ' local' : ''}\">${via} · ${((performance.now() - t0) / 1000).toFixed(1)}s</span>` + cards.map(c => { const ic0 = c.matched && (S.augIcon || {})[c.matched]; return `${ic0 ? `<img class=\"cic\" src=\"${esc(ic0)}\" alt=\"\" onerror=\"this.remove()\"> ` : ''}<b>${esc(c.matched || '未匹配')}</b>`; }).join(' ｜ ');\n    showResult(renderResult(rec)); pipNotify(rec); if (S.silent) pipAlert(); S.lastOcrOk = true;\n  } catch (e) {\n    const msg = /AI binding/.test(e.message) ? 'Worker 未配置 AI binding（dashboard → Settings → Bindings → 添加 AI）' : e.message;\n    if (!S.silent) $('ocrMsg').innerHTML = `<span style=\"color:var(--down)\">识别失败：${esc(msg)}</span>`;\n    if (S.pipMsg) S.pipMsg.textContent = S.silent ? '监测中…（还没看到三选一）' : '识别失败：' + msg;\n  }\n  btn.disabled = false; btn.textContent = '识别并推荐';\n}\n\n// ---------- 推荐 ----------\n$('clearSlots').onclick = () => { [0, 1, 2].forEach(i => $('aug' + i).value = ''); renderCands(); };\n$('go').onclick = async () => {\n  const btn = $('go'), champ = $('champInput').value.trim();\n  const augs = [0, 1, 2].map(i => $('aug' + i).value.trim()).filter(Boolean);\n  if (!champ || augs.length < 2) return toast('请先选英雄和至少 2 个海克斯');\n  btn.disabled = true; btn.textContent = '计算中…'; skeleton();\n  try {\n    const d = await api('/api/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ champion: champ, augments: augs, version: S.version, picked: S.picked, mode: S.mode }) });\n    showResult(renderResult(d));\n  } catch (e) { $('out').innerHTML = `<div class=\"warn\">请求失败：${esc(e.message)}</div>`; }\n  btn.disabled = false; btn.innerHTML = ic('zap') + '推荐最优';\n}\n\n// ---------- 初始化 ----------\nasync function init() {\n  try { S.stat = await api('/api/status'); } catch {}\n  applyStatus();\n  const vs = await api('/api/versions'), sel = $('version');\n  vs.forEach(v => { const o = document.createElement('option'); o.value = o.textContent = v.version; sel.appendChild(o); });\n  S.version = vs[0].version;\n  const load = async () => {\n    const [c, a] = await Promise.all([api(`/api/champions?version=${S.version}`), api(`/api/augments?version=${S.version}`)]);\n    S.champions = withPy(c.items); S.augments = withPy(a.items);\n    S.augIcon = {}; S.augDesc = {}; S.augments.forEach(a => { if (a.icon) S.augIcon[a.name] = a.icon; if (a.desc) S.augDesc[a.name] = a.desc; }); S.augById = new Map(S.augments.map(a => [a.id, a])); updateFilterLabel();\n  };\n  await load();\n  sel.onchange = async () => { S.version = sel.value; S.allowed = new Set(); resetAll(); await load(); };\n  autocomplete('champInput', 'champDrop', () => S.champions, h => { S.heroAuto = false; S.heroCand = null; selectChampion(h); });\n  [0, 1, 2].forEach(i => autocomplete('aug' + i, 'drop' + i, augSource, renderCands));\n  renderPicked();\n  const qs = new URLSearchParams(location.search), pre = qs.get('champion'), draft = qs.get('draft');\n  if (draft) { const b = $('draftBanner'); b.style.display = 'block'; b.innerHTML = `<b>第 ${esc(draft)} 轮强化选择</b><div class=\"stat\">在下方填入三个候选后点推荐</div>`; }\n  if (pre) { const h = S.champions.find(x => x.name === pre); S.heroAuto = false; if (h) selectChampion(h); else $('champInput').value = pre; }\n}\n// ---------- 过滤 / 模式 / 特效 ----------\nconst augSource = () => (S.only && S.allowed.size) ? S.augments.filter(a => S.allowed.has(a.id)) : S.augments;\nfunction updateFilterLabel() { $('okCnt').textContent = S.allowed.size ? `(${S.allowed.size}/${S.augments.length})` : '(选英雄后生效)'; }\n$('onlyOk').onclick = e => { S.only = !S.only; e.currentTarget.classList.toggle('on', S.only); };\n$('seg').onclick = e => { const b = e.target.closest('button'); if (!b || b.disabled) return; S.mode = b.dataset.m; [...$('seg').children].forEach(x => x.classList.toggle('on', x === b)); };\nfunction skeleton() { $('out').innerHTML = '<div class=\"results\">' + '<div class=\"rc sk\"></div>'.repeat(3) + '</div>'; }\nfunction fx(root) {\n  root.querySelectorAll('[data-count]').forEach(el => {\n    const to = +el.dataset.count, t0 = performance.now();\n    const step = t => { const k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 3); el.textContent = (to * e).toFixed(1) + '%'; if (k < 1) requestAnimationFrame(step); };\n    requestAnimationFrame(step);\n  });\n  root.querySelectorAll('.rc').forEach(c => {\n    const pk = c.classList.contains('pick') ? ' translateY(-6px)' : '';\n    c.onmousemove = e => { const r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;\n      c.style.transform = `perspective(700px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg)${pk}`; c.style.transform = `perspective(700px) rotateY(${x * 10}deg) rotateX(${-y * 10}deg)${pk}`; c.style.setProperty('--mx', (x + .5) * 100 + '%'); c.style.setProperty('--my', (y + .5) * 100 + '%'); };\n    c.onmouseleave = () => { c.style.transform = ''; };\n  });\n  const p = root.querySelector('.rc.pick');\n  if (p) setTimeout(() => { const r = p.getBoundingClientRect();\n    for (let i = 0; i < 16; i++) { const s = document.createElement('i'), a = Math.random() * 6.28, d = 60 + Math.random() * 90;\n      s.className = 'spark'; s.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + 40}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d}px`;\n      document.body.appendChild(s); setTimeout(() => s.remove(), 1000); } }, 350);\n}\n(() => { const bg = $('bg'); for (let i = 0; i < 14; i++) { const e = document.createElement('i'), s = 20 + Math.random() * 60;\n  e.style.cssText = `left:${Math.random() * 100}%;width:${s}px;height:${s * 1.1}px;animation-duration:${14 + Math.random() * 18}s;animation-delay:-${Math.random() * 20}s`; bg.appendChild(e); } })();\n\n// ---------- 候选预览（实时按修正胜率排序） / 能力探测 ----------\nfunction renderCands() {\n  const el = $('cands'); if (!el) return; markTopSlots();\n  [0, 1, 2].forEach(i => { const c = $('augClear' + i); if (c) c.classList.toggle('show', !!$('aug' + i).value); });\n  const rows = [0, 1, 2].map(i => $('aug' + i).value.trim()).filter(Boolean).map(n => {\n    const a = S.augments.find(x => x.name === n);\n    if (!a) return { bad: n };\n    const cw = S.augWr.get(a.id), t = cw ? cw.tm : 0;\n    return { a, raw: cw ? cw.wr : null, tm: t, nodata: !cw, picked: S.picked.includes(a.name), eff: cw ? (cw.wr * t + a.wr * 200) / (t + 200) : a.wr };\n  });\n  if (!rows.length) { el.innerHTML = ''; return; }\n  const ok = rows.filter(r => !r.bad).sort((a, b) => b.eff - a.eff);\n  const best = ok.find(r => !r.picked);\n  el.innerHTML = '<div class=\"stat\">当前候选 · 按修正胜率排序（小样本向全局收缩）' + (S.picked.length && S.mode === 'wr' ? ' · 纯胜率模式不评估与已选的搭配' : '') + '</div>' +\n    [...ok, ...rows.filter(r => r.bad)].map((r, i) => r.bad\n      ? `<span class=\"cc bad\">${ic('triangle-alert')}${esc(r.bad)}<small>未找到</small></span>`\n      : `<span class=\"cc${r === best ? ' best' : ''}${r.nodata ? ' nd' : ''}\" style=\"animation-delay:${i * .06}s\" ${tipAttr({ icon: r.a.icon, name: r.a.name, sub: r.picked ? '本局已选过' : '', desc: r.a.desc, stats: [['修正胜率', pct(r.eff)], ['全局胜率', pct(r.a.wr)]] })}>${r === best ? ic('crown') : ''}${r.a.icon ? `<img src=\"${esc(r.a.icon)}\" alt=\"\" onerror=\"this.remove()\">` : ''}${esc(r.a.name)} <b>${pct(r.eff)}</b><small>${r.picked ? '已选过' : r.nodata ? '该英雄无数据 · 用全局' : '原始 ' + pct(r.raw) + ' · ' + fmtGames(r.tm)}</small></span>`).join('');\n}\n['aug0', 'aug1', 'aug2'].forEach(id => $(id).addEventListener('input', renderCands));\nfunction applyStatus() {\n  const jevOff = !S.stat.jev, auto = $('seg').querySelector('[data-m=\"auto\"]');\n  if (jevOff) { S.mode = 'wr'; auto.disabled = true; auto.title = '未配置 TYPESAFE_API_KEY，已降档为纯胜率排序'; }\n  [...$('seg').children].forEach(x => x.classList.toggle('on', x.dataset.m === S.mode));\n  setEngine(S.engine || '未加载');\n  const HOW = {\n    Jev: 'Worker → Settings → Variables and Secrets 添加 <code data-copy>TYPESAFE_API_KEY</code>',\n    Ocr: '可选：本地没认全时由 AI 兜底。Worker → Settings → Bindings 添加 Workers AI，变量名 <code data-copy>AI</code>',\n  };\n  const setSt = (k, ok) => {\n    $('row' + k).className = 'srow ' + (ok ? 'ok' : 'no');\n    $('si' + k).innerHTML = ic(ok ? 'circle-check' : 'circle-alert');\n    $('st' + k).textContent = ok ? '可用' : (k === 'Ocr' ? '未启用' : '未配置');\n    $('how' + k).innerHTML = HOW[k];\n  };\n  setSt('Jev', S.stat.jev); setSt('Ocr', S.stat.ocr);\n}\n\n// ---------- 常用海克斯（常用 + 高胜率） ----------\n// 点击常用海克斯 chip → 填入首个空位；只有填满最后一个(C)才滚动下去\nfunction fillSlot(name) {\n  for (let i = 0; i < 3; i++) {\n    const el = $('aug' + i);\n    if (!el.value) {\n      el.value = name; renderCands();\n      toast(`已填入 ${'ABC'[i]} 位：${name}`);\n      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');\n      if (i === 2) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);\n      return;\n    }\n  }\n  toast('三个位置已满');\n}\nfunction renderTops(key) {\n  S.topKey = key = key || S.topKey || 'combo';\n  const base = S.champWr || .5, list = [];\n  S.augWr.forEach((v, id) => { const a = S.augById && S.augById.get(id); if (a) list.push({ a, wr: v.wr, tm: v.tm, eff: (v.wr * v.tm + a.wr * 200) / (v.tm + 200) }); });\n  const maxTm = Math.max(1, ...list.map(x => x.tm)), tms = list.map(x => x.tm).sort((a, b) => a - b), med = tms[tms.length >> 1] || 0;\n  const sorted = key === 'pop' ? list.sort((a, b) => b.tm - a.tm) : key === 'wr' ? list.sort((a, b) => b.eff - a.eff) : list.filter(x => x.tm >= med).sort((a, b) => b.eff - a.eff);\n  const cap = S.topAll ? 20 : 8, rows = sorted.slice(0, cap);\n  const tabs = [['combo', 'flame', '常用且高胜率'], ['pop', 'users', '最常用'], ['wr', 'trending-up', '最高胜率']];\n  $('topSort').innerHTML = `<div class=\"seg\">${tabs.map(([k, i, t]) => `<button data-k=\"${k}\" class=\"${k === key ? 'on' : ''}\">${ic(i)}${t}</button>`).join('')}</div>`;\n  $('topSort').querySelectorAll('button').forEach(b => { b.onclick = () => renderTops(b.dataset.k); });\n  $('tops').innerHTML = rows.length ? rows.map(r => {\n    const dl = (r.eff - base) * 100, desc = r.a.desc || (S.augDesc || {})[r.a.name], heat = Math.round(r.tm / maxTm * 100);\n    return `<div class=\"ac\" data-name=\"${esc(r.a.name)}\">\n      <div class=\"ac-top\"><div class=\"ac-ic t-${esc(r.a.tier || '')}\">${r.a.icon ? `<img src=\"${esc(r.a.icon)}\" alt=\"\" onerror=\"this.remove()\">` : ''}</div>\n        <div class=\"ac-nm\"><b>${esc(r.a.name)}</b>${r.a.tier ? `<span class=\"tier ${esc(r.a.tier)}\">${esc(r.a.tier)}</span>` : ''}</div>\n        <button class=\"ac-info\" title=\"详情\" aria-label=\"详情\">${ic('info')}</button></div>\n      <div class=\"ac-wr\"><b>${pct(r.eff)}</b><span class=\"d ${dl >= 0 ? 'up' : 'down'}\">${dl >= 0 ? '+' : ''}${dl.toFixed(1)}pp</span></div>\n      <div class=\"ac-bar\"><i style=\"width:${Math.max(6, heat)}%\"></i></div>\n      <div class=\"ac-meta\">${fmtGames(r.tm)} · 热度 ${heat}%</div>\n      ${desc ? `<div class=\"ac-desc\">${esc(desc)}</div>` : ''}\n      <div class=\"ac-more\"><span>专属胜率<b>${pct(r.wr)}</b></span><span>全局胜率<b>${pct(r.a.wr)}</b></span><span>样本<b>${r.tm.toLocaleString()} 场</b></span><span>较英雄均值<b>${dl >= 0 ? '+' : ''}${dl.toFixed(1)}pp</b></span></div>\n      <div class=\"ac-fill\">${ic('plus')}点击填入</div></div>`;\n  }).join('') + (sorted.length > 8 ? `<button class=\"more\" id=\"topMore\">${S.topAll ? '收起' : '展开更多（' + (Math.min(20, sorted.length) - 8) + '）'}</button>` : '') : '<span class=\"stat\">暂无该英雄的海克斯数据</span>';\n  $('tops').querySelectorAll('.ac').forEach(c => {\n    c.onclick = () => fillSlot(c.dataset.name);\n    c.querySelector('.ac-info').onclick = e => { e.stopPropagation(); c.classList.toggle('open'); };\n  });\n  const mo = $('topMore'); if (mo) mo.onclick = () => { S.topAll = !S.topAll; renderTops(); };\n  markTopSlots();\n}\nfunction markTopSlots() {\n  const have = [0, 1, 2].map(i => $('aug' + i).value.trim()).filter(Boolean);\n  document.querySelectorAll('#tops .ac').forEach(c => c.classList.toggle('in', have.includes(c.dataset.name)));\n}\n\n// ---------- 出装推荐（主源 arammeta 胜率统计；cchappy 为兜底） ----------\nasync function renderBuilds(name) {\n  const el = $('builds'); if (!el) return;\n  const pc = x => x == null ? '--' : (x * 100).toFixed(1) + '%';\n  const gs = g => g >= 10000 ? (g / 10000).toFixed(1) + '万场' : g >= 1000 ? (g / 1000).toFixed(1) + '千场' : (g || 0) + '场';\n  const itip = it => tipAttr({ icon: it.icon, name: it.name, sub: it.price ? it.price + ' 金币' : '', desc: it.desc, stats: it.wr != null ? [['胜率', pc(it.wr)], ['场次', gs(it.games)]] : [] });\n  const bi = it => `<span class=\"bi\" ${itip(it)}><img loading=\"lazy\" decoding=\"async\" src=\"${esc(it.icon)}\" alt=\"\" onerror=\"this.remove()\"></span>`;\n  const sec = (icon, title, sub, body, cls) => body ? `<div class=\"bs ${cls || ''}\"><div class=\"bh\">${ic(icon)}<b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>${body}</div>` : '';\n  const combos = (arr, bad) => (arr && arr.length) ? `<div class=\"cb-grid\">${arr.map((c, i) => `<div class=\"cb${!bad && i === 0 ? ' best' : ''}${bad ? ' bad' : ''}\">${bad ? '' : `<span class=\"cb-rk\">${i === 0 ? '最佳' : '#' + (i + 1)}</span>`}<div class=\"cb-items\">${c.items.map(bi).join('<i class=\"pl\">+</i>')}</div><div class=\"cb-wr\"><b>${pc(c.wr)}</b><small>${gs(c.games)}${c.lift != null ? ` · <span class=\"up\">+${(c.lift * 100).toFixed(1)}pp 提升</span>` : ''}</small></div><div class=\"cb-nm\">${esc(c.items.map(it => it.name).join(' + '))}</div></div>`).join('')}</div>` : '';\n  const tiles = arr => (arr && arr.length) ? `<div class=\"tl-grid\">${arr.map(it => `<div class=\"tl\" ${itip(it)}><span class=\"bi\"><img loading=\"lazy\" decoding=\"async\" src=\"${esc(it.icon)}\" alt=\"\" onerror=\"this.remove()\"></span><div class=\"tl-t\"><b>${esc(it.name)}</b><small>${gs(it.games)}</small><div class=\"tl-bar\"><i style=\"width:${Math.max(6, Math.min(100, ((it.wr || .5) - .45) / .15 * 100))}%\"></i></div></div><span class=\"tl-w\">${pc(it.wr)}</span></div>`).join('')}</div>` : '';\n  const spells = arr => (arr && arr.length) ? `<div class=\"sp-grid\">${arr.map(s => `<div class=\"sp\">${s.icon ? `<span class=\"bi\" style=\"width:34px;height:34px\"><img src=\"${esc(s.icon)}\" alt=\"\"></span>` : ''}<b>${esc(s.name)}</b>${s.wr != null ? `<span>${pc(s.wr)}</span><small>${gs(s.games)}</small>` : ''}</div>`).join('')}</div>` : '';\n  const skills = a => (a && a.length) ? `<div class=\"sk\">技能加点 · 主 <b>${esc(a[0])}</b>${a[1] ? ` 副 <b>${esc(a[1])}</b>` : ''}</div>` : '';\n  try {\n    const b = await api(`/api/builds?name=${encodeURIComponent(name)}`);\n    if (!b || b.none) { el.innerHTML = '<span class=\"stat\">暂无出装数据</span>'; return; }\n    const sr = $('bsrc'); if (sr) sr.textContent = (b.source === 'arammeta' ? '胜率统计 · 台服对局' : '人工攻略 · 非胜率统计') + (b.stale ? ' · 离线快照' : '');\n    const traps = (b.traps && b.traps.length) ? sec('skull', '陷阱海克斯', '别拿', `<div class=\"trap-row\">${b.traps.map(t => {\n      const a = S.augById && S.augById.get(t.id), nm = t.name || (a && a.name) || '', icon = a && a.icon, desc = (S.augDesc || {})[nm] || (a && a.desc);\n      return `<span class=\"trap\" ${tipAttr({ icon, name: nm, sub: '陷阱海克斯', desc })}>${icon ? `<img loading=\"lazy\" decoding=\"async\" src=\"${esc(icon)}\" alt=\"\" onerror=\"this.remove()\">` : ''}${esc(nm)}</span>`;\n    }).join('')}</div>`, 'bad') : '';\n    let body = '';\n    if (b.source === 'arammeta') {\n      body = sec('crown', '出装组合', '胜率最高', combos(b.combos)) + sec('sword', '单件装备胜率', '悬停查看介绍', tiles(b.singles)) + sec('footprints', '鞋子', '', tiles(b.boots)) +\n        sec('zap', '召唤师技能', '', spells(b.spells)) + sec('skull', '低胜率组合', '避坑', combos(b.badCombos, true), 'bad');\n    } else {\n      const grp = (t, arr) => sec('sword', t, '', (arr && arr.length) ? `<div class=\"tl-grid\">${arr.map(it => `<div class=\"tl\" ${itip(it)}><span class=\"bi\"><img loading=\"lazy\" decoding=\"async\" src=\"${esc(it.icon)}\" alt=\"\" onerror=\"this.remove()\"></span><div class=\"tl-t\"><b>${it.qty ? `<span class=\"qty\">${it.qty}×</span>` : ''}${esc(it.name)}</b>${it.price ? `<small>${it.price} 金币</small>` : ''}</div></div>`).join('')}</div>` : '');\n      body = grp('出门装', b.starting) + grp('核心装', b.core) + grp('备选', b.optional) + sec('zap', '召唤师技能', '', spells(b.spells)) + (b.guide ? `<div class=\"stat\" style=\"margin-top:12px\">方案：${esc(b.guide)}</div>` : '');\n    }\n    el.innerHTML = (b.stale ? '<div class=\"bsnote\">离线快照数据，可能滞后</div>' : '') + body + skills(b.skills) + traps;\n  } catch (e) { el.innerHTML = '<span class=\"stat\">出装数据获取失败</span>'; }\n}\n\n// ---------- 屏幕捕获 / 悬浮窗 ----------\nconst CROPS = { full: [0, 0, 1, 1], band: [0, .18, 1, .64], center: [.08, .2, .84, .6] };\nasync function startCapture() {\n  if (!navigator.mediaDevices?.getDisplayMedia) return toast('当前浏览器不支持屏幕捕获');\n  try {\n    const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });\n    S.stream = st; const v = $('capVideo'); v.srcObject = st; v.play().catch(() => {});\n    $('capBox').classList.add('on'); $('capStop').disabled = false;\n    st.getVideoTracks()[0].addEventListener('ended', () => { S.shareDropped = true; stopCapture(); });\n    toast('已连接游戏窗口'); $('scan').classList.add('live');\n    $('liveSub').textContent = '已连接：' + (st.getVideoTracks()[0].label || '游戏窗口') + '。在悬浮窗里点「识别」，或在这里点「截取并识别」';\n    $('liveGo').innerHTML = ic('picture-in-picture-2') + '重新打开悬浮窗';\n  } catch { toast('已取消共享'); }\n}\nfunction stopCapture() {\n  const st = S.stream; S.stream = null;\n  if (st) st.getTracks().forEach(t => { try { t.stop(); } catch {} }); $('capVideo').srcObject = null; $('capBox').classList.remove('on'); $('capStop').disabled = true;\n  stopAuto(); if (S.pipAuto) S.pipAuto.checked = false;\n  $('scan').classList.remove('live'); $('liveSub').innerHTML = S.defSub || DEFAULT_SUB; $('liveGo').innerHTML = ic('picture-in-picture-2') + '一键悬浮识别';\n  if (S.shareDropped) { S.shareDropped = false; toast('共享已断开，点「一键悬浮识别」重新连接'); }\n}\nfunction cropFrame(src, W, H, useCrop) {\n  const mode = $('cropSel').value, c = (useCrop && CROPS[mode]) || CROPS.full;\n  let x = W * c[0], w = W * c[2]; const y = H * c[1], h = H * c[3];\n  if (useCrop && mode !== 'full' && W / H > 2.2) { w = H * 2; x = (W - w) / 2; }\n  const fc = document.createElement('canvas'); fc.width = Math.round(w); fc.height = Math.round(h);\n  fc.getContext('2d').drawImage(src, x, y, w, h, 0, 0, fc.width, fc.height);\n  return fc;\n}\nasync function grabFrame() {\n  const tr = S.stream && S.stream.getVideoTracks()[0]; if (!tr) return false;\n  let src, W, H;\n  if ('ImageCapture' in window) { try { src = await new ImageCapture(tr).grabFrame(); W = src.width; H = src.height; } catch {} }  // 后台标签页也能取帧\n  if (!src) { const v = $('capVideo'); if (!v.videoWidth) return false; src = v; W = v.videoWidth; H = v.videoHeight; }\n  const fc = cropFrame(src, W, H, true); S.fullFrame = fc;   // 原始分辨率，给本地识别\n  const sw = fc.width, sh = fc.height, sc = Math.min(1, 1280 / sw), cv = document.createElement('canvas'); cv.width = Math.round(sw * sc); cv.height = Math.round(sh * sc);\n  cv.getContext('2d').drawImage(fc, 0, 0, cv.width, cv.height);\n  shotDataUrl = cv.toDataURL('image/jpeg', 0.82);   // 缩小版：预览 + AI 兜底用\n  const pv = $('shotPreview'); pv.src = shotDataUrl; pv.style.display = 'block';\n  return true;\n}\nasync function captureAndRun(silent) {\n  if (!S.stream) { toast('请先点「一键悬浮识别」并选择游戏窗口'); return false; }\n  if ($('ocrGo').disabled) return false;\n  if (!(await grabFrame())) { if (!silent) toast('还没拿到画面，请稍后再试'); return false; }\n  S.silent = !!silent;\n  try { await runOcr(); } finally { S.silent = false; }\n  return S.lastOcrOk;\n}\n$('capStop').onclick = stopCapture; $('capGo').onclick = () => captureAndRun(false); $('liveGo').onclick = liveStart;\n\n\n// ---------- 清除按钮 ----------\n// 清空英雄 → 下面所有内容联动清空（卡片、本局已选、A/B/C、候选预览、推荐结果）\nfunction resetAll() {\n  S.seq++; S.heroAuto = false; S.heroCand = null; syncPipChamp('');\n  $('champInput').value = ''; $('champClear').classList.remove('show');\n  $('champDrop').classList.remove('open'); $('champCard').innerHTML = '';\n  S.picked = []; renderPicked();\n  [0, 1, 2].forEach(i => $('aug' + i).value = '');\n  renderCands(); $('out').innerHTML = '<div class=\"stat\">选好英雄和候选后，结果会出现在这里。</div>';\n}\n$('champInput').addEventListener('input', e => $('champClear').classList.toggle('show', !!e.target.value));\n$('champClear').onclick = () => { resetAll(); toast('已清空，重新选择英雄'); };\n$('shotClear').onclick = () => { shotDataUrl = null; $('shotInput').value = ''; const pv = $('shotPreview'); pv.removeAttribute('src'); pv.style.display = 'none'; $('ocrMsg').textContent = ''; toast('截图已清除'); };\n\n// A/B/C 输入框：清除按钮 + 回车直接推荐\n[0, 1, 2].forEach(i => {\n  const inp = $('aug' + i), clr = $('augClear' + i);\n  clr.onclick = () => { inp.value = ''; clr.classList.remove('show'); renderCands(); inp.focus(); };\n  inp.addEventListener('keydown', e => {\n    if (e.key === 'Enter' && !$('drop' + i).classList.contains('open')) { e.preventDefault(); $('go').click(); }\n  });\n  inp.addEventListener('input', e => clr.classList.toggle('show', !!e.target.value));\n});\n\n// ---------- 设置面板（jev 配置入口） ----------\n$('tokenInput').value = localStorage.getItem('hextech_token') || '';\n$('setBtn').onclick = e => { e.stopPropagation(); $('setPop').classList.toggle('open'); };\ndocument.addEventListener('click', e => { if (!$('setPop').contains(e.target) && !$('setBtn').contains(e.target)) $('setPop').classList.remove('open'); });\n$('tokenSave').onclick = () => { const v = $('tokenInput').value.trim(); TOKEN = v; if (v) localStorage.setItem('hextech_token', v); else localStorage.removeItem('hextech_token'); toast(v ? '令牌已保存' : '令牌已清空'); };\n$('tokenClear').onclick = () => { localStorage.removeItem('hextech_token'); TOKEN = new URLSearchParams(location.search).get('token') || ''; $('tokenInput').value = ''; toast('令牌已清除'); };\n$('tokenEye').onclick = () => { const i = $('tokenInput'), show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('tokenEye').innerHTML = ic(show ? 'eye-off' : 'eye'); };\ndocument.addEventListener('click', e => { const c = e.target.closest('code[data-copy]'); if (c) { navigator.clipboard && navigator.clipboard.writeText(c.textContent); toast('已复制 ' + c.textContent); } });\n{ const cs = $('cropSel'); cs.value = localStorage.getItem('hextech_crop') || 'band'; cs.onchange = () => localStorage.setItem('hextech_crop', cs.value); }\n{ const els = document.querySelectorAll('.step,.panel,.rail,#out');\n  if ('IntersectionObserver' in window) {\n    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .05 });\n    els.forEach(el => { el.classList.add('rv'); io.observe(el); });\n  } }\n{ let raf = 0; document.addEventListener('pointermove', e => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; const s = document.documentElement.style; s.setProperty('--cx', e.clientX + 'px'); s.setProperty('--cy2', e.clientY + 'px'); }); }); }\n\n// ---------- v3：一键悬浮识别 / 自动监测 / 悬浮窗 ----------\nconst DEFAULT_SUB = '点一次，分享「整个屏幕」：选人界面自动识别英雄，对局中出卡/刷新自动识别推荐，全程不用再点（本地识别，不耗 AI 额度）';\nasync function liveStart() {\n  getOcrWorker().catch(() => {});   // 提前下载识别引擎，选完窗口就能直接用\n  if (S.stream) { await openPip().catch(e => toast('悬浮窗失败：' + e.message)); return; }\n  if (!$('champInput').value.trim()) toast('先选好英雄，识别时才知道用谁的数据');\n  const pip = openPip().catch(e => toast('悬浮窗失败：' + e.message));   // 与 getDisplayMedia 在同一次点击内发起，避免手势失效\n  await startCapture();\n  await pip;\n  if (S.pipMsg) S.pipMsg.textContent = S.stream ? '已连接，持续监测中…' : '未选择窗口';\n  if (S.stream && S.pipAuto && !S.pipAuto.checked) { S.pipAuto.checked = true; setAuto(true); toast('已开启持续监测：出卡/刷新自动识别'); }\n}\nfunction stopAuto() { clearTimeout(S.autoT); S.autoT = null; }\nfunction setAuto(on) {\n  stopAuto(); S.autoN = 0; S.lastSig = null; S.heroCand = null;\n  if (!on) return;\n  if (!S.stream) { toast('请先选择游戏窗口'); if (S.pipAuto) S.pipAuto.checked = false; return; }\n  const loop = async () => {\n    if (!S.autoT) return;\n    if (!S.tickBusy) {\n      S.tickBusy = true;\n      try { await autoTick(); } finally { S.tickBusy = false; }\n    }\n    if (S.autoT) S.autoT = setTimeout(loop, S.lastSig ? 8000 : 4000);  // 选人阶段 4s 更快跟上换英雄\n  };\n  S.autoT = setTimeout(loop, 500);\n}\nasync function autoTick() {\n  if (!S.autoT) return;\n  if (++S.autoN > 200) { stopAuto(); if (S.pipAuto) S.pipAuto.checked = false; toast('持续监测已达上限（约27分钟），可重新勾选继续'); return; }\n  await captureAndRun(true);\n}\nasync function openPip() {\n  if (!('documentPictureInPicture' in window)) { toast('浏览器不支持悬浮窗（需 Chrome / Edge 116+），请用页内「截取并识别」'); return; }\n  if (S.pip && !S.pip.closed) { S.pip.focus(); return; }\n  const w = await documentPictureInPicture.requestWindow({ width: 320, height: 300 });\n  S.pip = w;\n  [...document.styleSheets].forEach(ss => { try { const st = w.document.createElement('style'); st.textContent = [...ss.cssRules].map(r => r.cssText).join(' '); w.document.head.appendChild(st); } catch {} });\n  const d = w.document;\n  d.body.className = 'pip';\n  d.body.innerHTML = `<div class=\"pipbox\"><div class=\"pip-top\"><span class=\"pip-dot\"></span><span id=\"pipMsg\" class=\"stat\">${S.stream ? '已连接，点「识别」' : '等待选择游戏窗口…'}</span><span class=\"sp\"></span><button id=\"pipSnd\" class=\"pip-ico\" title=\"新卡提示音开/关\">🔊</button><button id=\"pipFold\" class=\"pip-ico\" title=\"折叠/展开\">−</button></div>\n    <div id=\"pipBody\">\n    <div class=\"pip-hero\"><input id=\"pipChamp\" placeholder=\"英雄：自动识别，可手动输入（支持拼音）\" autocomplete=\"off\"><div id=\"pipChampDrop\" class=\"drop\"></div></div>\n    <button class=\"btn gold xl\" id=\"pipGo\">${ic('scan-line')}识别</button>\n    <label class=\"auto\"><input type=\"checkbox\" id=\"pipAuto\"><span>持续监测（选人4秒/对局8秒，有新卡自动识别）</span></label>\n    <div id=\"pipRes\" class=\"pipres\"></div></div></div>`;\n  d.getElementById('pipGo').onclick = () => { try { S._ac = S._ac || new (window.AudioContext || window.webkitAudioContext)(); if (S._ac.state === 'suspended') S._ac.resume(); } catch (e) {} captureAndRun(false); };\n  d.getElementById('pipFold').onclick = () => {\n    const b = d.getElementById('pipBody'), folded = b.style.display !== 'none';\n    b.style.display = folded ? 'none' : 'grid'; d.getElementById('pipFold').textContent = folded ? '+' : '−'; S.pipFolded = folded;\n  };\n  d.getElementById('pipSnd').onclick = () => { S.pipMuted = !S.pipMuted; d.getElementById('pipSnd').textContent = S.pipMuted ? '🔇' : '🔊'; };\n  S.pipAuto = d.getElementById('pipAuto'); S.pipAuto.onchange = () => setAuto(S.pipAuto.checked);\n  S.pipMsg = d.getElementById('pipMsg'); S.pipRes = d.getElementById('pipRes');\n  S.pipChamp = d.getElementById('pipChamp');\n  S.pipChamp.value = $('champInput').value;\n  pipChampSearch(d);\n  S.pipChamp.addEventListener('change', () => applyPipChamp());\n  w.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key.toLowerCase() === 'r') captureAndRun(false); });\n  w.addEventListener('pagehide', () => { stopAuto(); S.pip = S.pipMsg = S.pipRes = S.pipAuto = S.pipChamp = null; });\n}\nfunction syncPipChamp(v) { if (S.pipChamp) S.pipChamp.value = v || ''; }\nfunction applyPipChamp() {\n  if (!S.pipChamp) return;\n  const v = S.pipChamp.value.trim();\n  if (!v || v === $('champInput').value.trim()) return;\n  $('champInput').value = v; S.heroAuto = false; S.heroCand = null;\n  const h = S.champions.find(x => x.name === v);\n  if (h) selectChampion(h);\n  toast(`已手动指定英雄：${v}`);\n}\nfunction pipBeep() {\n  if (S.pipMuted) return;\n  try {\n    S._ac = S._ac || new (window.AudioContext || window.webkitAudioContext)();\n    if (S._ac.state === 'suspended') { S._ac.resume(); return; }  // 未经手势解锁时不硬播\n    const t = S._ac.currentTime;\n    [523, 784].forEach((f, i) => {\n      const o = S._ac.createOscillator(), g = S._ac.createGain();\n      o.type = 'sine'; o.frequency.value = f;\n      g.gain.setValueAtTime(0.0001, t + i * 0.18);\n      g.gain.exponentialRampToValueAtTime(0.22, t + i * 0.18 + 0.02);\n      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);\n      o.connect(g); g.connect(S._ac.destination);\n      o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.2);\n    });\n  } catch (e) {}\n}\n// 静默监测发现新卡：自动展开 + 金框闪烁 + 提示音，高亮提醒选海克斯\nfunction pipAlert() {\n  if (!S.pip) return;\n  try {\n    const d = S.pip.document, b = d.getElementById('pipBody');\n    if (b && b.style.display === 'none') { b.style.display = 'grid'; d.getElementById('pipFold').textContent = '−'; S.pipFolded = false; }\n    const box = d.querySelector('.pipbox');\n    if (box) { box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash'); }\n    pipBeep();\n  } catch (e) {}\n}\n// 悬浮窗内英雄搜索：中文 / 称号 / 英文别名 / 拼音（与主页同逻辑）\nfunction pipChampSearch(d) {\n  const input = d.getElementById('pipChamp'), drop = d.getElementById('pipChampDrop');\n  let hits = [], idx = -1;\n  const close = () => { drop.classList.remove('open'); idx = -1; };\n  const paint = () => [...drop.children].forEach((c, i) => c.classList.toggle('on', i === idx));\n  const pick = h => { input.value = h.name; close(); applyPipChamp(); };\n  input.addEventListener('input', () => {\n    const raw = input.value.trim(), q = raw.toLowerCase(), qp = q.replace(/\\s+/g, '');\n    if (!q) { close(); return; }\n    hits = S.champions\n      .filter(x => x.name.toLowerCase().includes(q) || (x.title && x.title.includes(raw)) ||\n        (x.alias && x.alias.toLowerCase().includes(q)) || (x._py && x._py.includes(qp)))\n      .map(x => ({ x, r: x.name.toLowerCase().startsWith(q) ? 0 : (x._py && x._py.split(' ').some(w => w.startsWith(qp))) ? 1 : 2 }))\n      .sort((a, b) => a.r - b.r).slice(0, 8).map(o => o.x);\n    drop.innerHTML = '';\n    hits.forEach(h => {\n      const el = d.createElement('div'); el.className = 'opt';\n      el.innerHTML = `<span>${esc(h.name)}${h.title ? ' · ' + esc(h.title) : ''}</span>`;\n      el.onmousedown = e => { e.preventDefault(); pick(h); };\n      drop.appendChild(el);\n    });\n    idx = hits.length ? 0 : -1; paint();\n    drop.classList.toggle('open', hits.length > 0);\n  });\n  input.addEventListener('keydown', e => {\n    if (!drop.classList.contains('open')) return;\n    if (e.key === 'ArrowDown') { idx = (idx + 1) % hits.length; paint(); e.preventDefault(); }\n    else if (e.key === 'ArrowUp') { idx = (idx - 1 + hits.length) % hits.length; paint(); e.preventDefault(); }\n    else if (e.key === 'Enter' && idx >= 0) { pick(hits[idx]); e.preventDefault(); }\n    else if (e.key === 'Escape') close();\n  });\n  input.addEventListener('blur', () => setTimeout(close, 150));\n}\nfunction pipNotify(r) {\n  if (!S.pipRes) return;\n  S.pipMsg.textContent = (r.degraded ? '已降档为纯胜率排序' : '识别完成') + ' · 点候选记为已选';\n  S.pipRes.innerHTML = r.ranking.map(x => `<button class=\"cc${x.name === r.pick ? ' best' : ''}\" data-n=\"${esc(x.name)}\">${x.name === r.pick ? ic('crown') : ''}${esc(x.name)} <b>${pct(x.eff != null ? x.eff : (x.champWr != null ? x.champWr : x.globalWr))}</b></button>`).join('');\n  S.pipRes.querySelectorAll('.cc').forEach(b => { b.onclick = () => markPicked(b.dataset.n, true); });\n}\nfunction markPicked(n, fromPip) {\n  if (!S.picked.includes(n)) S.picked.push(n);\n  renderPicked();\n  [0, 1, 2].forEach(i => $('aug' + i).value = ''); renderCands();\n  $('out').innerHTML = `<div class=\"stat\">已记录「${esc(n)}」，输入下一轮候选继续。</div>`;\n  toast('已记入本局已选');\n  if (S.pipRes) S.pipRes.innerHTML = `<div class=\"stat\">已记录「${esc(n)}」，等待下一轮…</div>`;\n  if (S.pipAuto && S.pipAuto.checked) setAuto(true);\n  if (!fromPip) window.scrollTo({ top: 0, behavior: 'smooth' });\n}\n\n// ---------- v3：设置面板细节 / 动效 ----------\n$('tokenEye').onclick = () => { const i = $('tokenInput'), show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('tokenEye').innerHTML = ic(show ? 'eye-off' : 'eye'); };\ndocument.addEventListener('click', e => { const c = e.target.closest('code[data-copy]'); if (c) { navigator.clipboard && navigator.clipboard.writeText(c.textContent); toast('已复制 ' + c.textContent); } });\n{ const cs = $('cropSel'); cs.value = localStorage.getItem('hextech_crop') || 'band'; cs.onchange = () => localStorage.setItem('hextech_crop', cs.value); }\n{ const els = document.querySelectorAll('.step,.panel,.rail,#out');\n  if ('IntersectionObserver' in window) {\n    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .05 });\n    els.forEach(el => { el.classList.add('rv'); io.observe(el); });\n  } }\n{ let raf = 0; document.addEventListener('pointermove', e => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; const s = document.documentElement.style; s.setProperty('--cx', e.clientX + 'px'); s.setProperty('--cy2', e.clientY + 'px'); }); }); }\n\n// ---------- v4：悬浮介绍卡 ----------\nconst tipHtml = o => `<div class=\"tp-h\">${o.icon ? `<img src=\"${esc(o.icon)}\" alt=\"\">` : ''}<div><b>${esc(o.name)}</b>${o.sub ? `<span>${esc(o.sub)}</span>` : ''}</div></div>${o.desc ? `<div class=\"tp-d\">${esc(o.desc)}</div>` : ''}${o.stats && o.stats.length ? `<div class=\"tp-s\">${o.stats.map(([k, v]) => `<span>${esc(k)}<b>${esc(v)}</b></span>`).join('')}</div>` : ''}`;\nconst tipAttr = o => `data-tip=\"${esc(tipHtml(o))}\"`;\nconst TIP = document.createElement('div'); TIP.id = 'tip'; document.body.appendChild(TIP);\ndocument.addEventListener('mouseover', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t) { TIP.innerHTML = t.dataset.tip; TIP.classList.add('on'); } });\ndocument.addEventListener('mousemove', e => { if (!TIP.classList.contains('on')) return; const w = TIP.offsetWidth, h = TIP.offsetHeight; let x = e.clientX + 16, y = e.clientY + 16; if (x + w > innerWidth - 8) x = e.clientX - w - 16; if (y + h > innerHeight - 8) y = e.clientY - h - 16; TIP.style.transform = `translate(${Math.max(8, x)}px,${Math.max(8, y)}px)`; });\ndocument.addEventListener('mouseout', e => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t && !t.contains(e.relatedTarget)) TIP.classList.remove('on'); });\ndocument.addEventListener('click', e => { const b = e.target.closest('.how'); if (b) $('how' + b.dataset.how).classList.toggle('open'); });\n\nhydrate();\ninit().catch(e => { $('out').innerHTML = `<div class=\"warn\">初始化失败：${esc(e.message)}</div>`; });\n</script>\n</body>\n</html>\n\n\n";
// Cloudflare Worker：RESG 数据 + jev 决策 + OCR（单文件，直接粘贴/部署）
// 环境变量：TYPESAFE_API_KEY（secret，可选）  ACCESS_TOKEN（secret，可选，设置后访问 /api/* 需 ?token= 或 X-Token）
// 绑定：AI（OCR 用，可选）
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Token',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors } });
export default{
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
