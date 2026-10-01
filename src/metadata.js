'use strict';
/**
 * metadata.js — 从 game-wind 的 video.json spec 合成投稿元数据
 *
 * spec 里**没有任何现成的标题/简介/标签/分区字段**，全部在这里新建。
 * 文案刻意与视频内保持一致，常量抄自 game-wind/tools/video/render.js：
 *   BRAND      render.js:130
 *   fullDate   render.js:134-137
 *   titleStat  render.js:210-215
 *   DISCLAIMER render.js:220-221
 * 改日期格式或免责声明措辞时，两边要一起改。
 */

// ---- 抄自 render.js 的常量 ----
const BRAND = '游戏投资榜单快报';
const DISCLAIMER =
  '本视频榜单排名非游戏公司官方数据，可能存在较大误差，仅供行业观察参考，不构成任何投资建议。';

// B 站硬限制
const TITLE_MAX = 80;
const DESC_MAX = 2000;
const TAG_MAX = 10;
const TAG_LEN_MAX = 20;

/** 2026-09-29 → 2026.09.29（对齐 render.js:134-137） */
function fullDate(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  return m ? `${m[1]}.${m[2]}.${m[3]}` : date || '';
}

/**
 * 一句话概况，对齐 render.js:210-215 的 titleStat 语义，
 * 但标题里用「，」而不是片头那种「·」，读起来更顺。
 */
function statText(spec) {
  const s = spec.summary || {};
  if (spec.baseline) return '首次运行，已建立基线';
  if (!s.change_count) return '今日畅销榜无重大变化';
  return `畅销榜 ${s.change_count} 条重大变化，${s.company_count} 家公司`;
}

/** 标题：游戏投资榜单快报 2026.10.01｜畅销榜 15 条重大变化，6 家公司 */
function buildTitle(spec) {
  const t = `${BRAND} ${fullDate(spec.date)}｜${statText(spec)}`;
  return t.length <= TITLE_MAX ? t : t.slice(0, TITLE_MAX - 1) + '…';
}

/** 把 summary 里某家公司的变化排成行，按幅度降序 */
function changeLines(group, limit) {
  const changes = (group.changes || []).slice().sort((a, b) => (b.delta || 0) - (a.delta || 0));
  return changes.slice(0, limit).map((c) => `  · ${c.game} ${c.region_name} ${c.move}`);
}

/**
 * 简介。不能用 data/reports/<date>.md 全文——实测 3100~3700 字符，
 * 超 B 站 2000 上限，所以用 spec 重新渲染一份精简版。
 * 条数按上限动态裁剪：先砍每家公司展示的变化条数，再砍公司数。
 */
function buildDesc(spec) {
  const s = spec.summary || {};
  const groups = (s.companies || []).slice();
  const header = [`${BRAND} ${fullDate(spec.date)}`, '与前一天对比', ''];

  const tail = [
    '【说明】',
    DISCLAIMER,
    '',
    '完整的分地区、分榜单前五名，见视频中「公司全览」部分。',
  ];

  const budget = DESC_MAX - header.join('\n').length - tail.join('\n').length - 200;

  for (let perCompany = 6; perCompany >= 1; perCompany--) {
    for (let maxCompanies = groups.length; maxCompanies >= 1; maxCompanies--) {
      const body = [];
      body.push('【今日总结】');
      body.push(statText(spec) + '。');
      body.push('');
      for (const g of groups.slice(0, maxCompanies)) {
        const lines = changeLines(g, perCompany);
        if (!lines.length) continue;
        body.push(`${g.company}${g.market ? `（${g.market}）` : ''}`);
        body.push(...lines);
        body.push('');
      }
      const cross = (s.cross_region || []).slice(0, 6);
      if (cross.length) {
        body.push('【跨区信号】');
        body.push(...cross.map((c) => `· ${c}`));
        body.push('');
      }
      if (body.join('\n').length <= budget) {
        return header.concat(body, tail).join('\n').slice(0, DESC_MAX);
      }
    }
  }

  // 极端情况（某天变化条数爆炸）兜底：只留概况和免责声明
  return header
    .concat([`【今日总结】`, statText(spec) + '。', '', '【说明】', DISCLAIMER])
    .join('\n')
    .slice(0, DESC_MAX);
}

/** 标签长度/合法性检查：B 站单标签上限 20 字符，且不接受纯空白 */
function cleanTag(t) {
  const s = String(t || '').replace(/[\s,，、]+/g, '').trim();
  if (!s || s.length > TAG_LEN_MAX) return null;
  return s;
}

/**
 * 标签。固定词打底，再用 spec 里的公司名/游戏名补足。
 * 公司名按「变化条数」降序取——变化多的公司正是这期的主角，比按字母序有意义。
 */
function buildTags(spec, cfg) {
  const p = (cfg && cfg.publish) || {};
  const max = p.maxTags || TAG_MAX;
  const out = [];
  const push = (t) => {
    const c = cleanTag(t);
    if (c && !out.includes(c) && out.length < max) out.push(c);
  };

  for (const t of p.tagsFixed || []) push(t);

  const s = spec.summary || {};
  const groups = (s.companies || [])
    .slice()
    .sort((a, b) => (b.changes || []).length - (a.changes || []).length);

  // 公司名（上榜的才值得当标签）
  for (const g of groups) push(g.company);
  // 变化幅度最大的几款游戏
  const games = [];
  for (const g of groups) for (const c of g.changes || []) games.push(c);
  games.sort((a, b) => (b.delta || 0) - (a.delta || 0));
  for (const c of games.slice(0, 4)) push(c.game);

  return out.slice(0, max);
}

/** 汇总：一次生成全部字段 */
function build(spec, cfg) {
  const tid = (cfg.publish && cfg.publish.tid) || null;
  return {
    title: buildTitle(spec),
    desc: buildDesc(spec),
    tags: buildTags(spec, cfg),
    tid,
    copyright: (cfg.publish && cfg.publish.copyright) || 1,
  };
}

module.exports = {
  build,
  buildTitle,
  buildDesc,
  buildTags,
  fullDate,
  statText,
  BRAND,
  DISCLAIMER,
  TITLE_MAX,
  DESC_MAX,
};
