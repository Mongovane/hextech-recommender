// 纯函数：平衡性判断、RESG ES module 解析、胜率收缩、state 组装、jev 请求/响应处理
// 无外部依赖，Node / Worker 通用
export const NEGATIVE_STATS = ['承受伤害', '受到伤害', '所受伤害'];
export function getBalanceTone(label, value) {
  const text = String(value).trim();
  const number = Number.parseFloat(text.replace(/[^+\-\d.]/g, ''));
  if (!Number.isFinite(number)) return 'neutral';
  const baseline = text.includes('%') && !/^[+-]/.test(text) ? 100 : 0;
  let delta = number - baseline;
  if (NEGATIVE_STATS.some((n) => label.includes(n))) delta *= -1;
  return delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral';
}

export function parseModule(text) {
  const json = text.replace(/^\s*export\s+default\s*/, '').trim().replace(/;+\s*$/, '');
  return JSON.parse(json);
}

// 小样本收缩：样本少时向全局胜率靠拢，避免"1 场 100%"排第一
export const SHRINK_K = 200;
export function effWr(r) {
  if (r.champWr == null) return r.globalWr;
  const n = r.champTm || 0;
  return (r.champWr * n + r.globalWr * SHRINK_K) / (n + SHRINK_K);
}

export function buildCandidateContextData(championDetail, augmentsData, candidates) {
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

export const wrText = (r) =>
  `该英雄使用胜率 ${r.champWr !== null ? (r.champWr * 100).toFixed(2) + '%' : '样本不足'}${r.champTm ? `（${r.champTm} 场）` : ''}；全局胜率 ${(r.globalWr * 100).toFixed(2)}%。`;

export function buildState(version, champion, buffs, rows, picked = []) {
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

export function buildJevBody({ state, rows, model = 'jev-latest' }) {
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
export function buildConflictBody({ state, row, model = 'jev-latest' }) {
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

export function extractPick(data, rowCount) {
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
export function cleanDesc(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/%i:[a-zA-Z]+%/g, '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
