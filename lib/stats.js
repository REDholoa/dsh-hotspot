// 统计层：把历史快照折算成面板需要的指标。
//
// 这是「可视化面板」的数据后端，全部为纯函数式计算，不碰网络与磁盘。
// 产出分五类：
//   1. 分布类 —— 来源构成、梗/热点构成、B站分区、热度分档、细分构成；
//   2. 排序类 —— 热点榜与梗榜（按话题聚合后的综合热度）；
//   3. 差分类 —— 相对上一份快照的新上榜 / 掉榜；
//   4. 梗类   —— 持续多日出现的关键词、跨平台共现词、标题高频词；
//   5. 趋势类 —— 多日条目数曲线。
//
// 关于「梗 / 热点」的分类与「综合热度」的口径，见 classify.js 顶部注释。

import { buildGroupRankings, buildMemeSpread, classifyItem, GROUP_MEME, GROUP_NEWS } from './classify.js';
import { gramsOf, gramsOverlap, isMeaningfulGram } from './text.js';

/** 统计窗口（天数）：趋势图与「持续热梗」的回看范围。 */
export const STATS_WINDOW_DAYS = 14;

/** 热度分档，从高到低。 */
const HEAT_BANDS = [
  { name: '≥1000万', min: 1e7, max: Infinity },
  { name: '100万–1000万', min: 1e6, max: 1e7 },
  { name: '10万–100万', min: 1e5, max: 1e6 },
  { name: '1万–10万', min: 1e4, max: 1e5 },
  { name: '<1万', min: 0, max: 1e4 },
];

/** 把一个平台的条目聚合成「短语 → 该短语的条目列表」。 */
function phraseIndex(items) {
  const index = new Map();
  for (const item of items) {
    const key = item.title;
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(item);
  }
  return index;
}

/** 取快照里所有「像梗的短语」：B站热搜词 + 抖音热榜条目标题。 */
function memePhrases(snapshot) {
  const out = [];
  for (const item of snapshot?.sources?.bili?.keywords?.items ?? []) out.push(item);
  for (const item of snapshot?.sources?.douyin?.hot?.items ?? []) out.push(item);
  return out;
}

/** 取快照里全部条目（含 B站视频）。 */
function allItems(snapshot) {
  return [
    ...(snapshot?.sources?.bili?.videos?.items ?? []),
    ...(snapshot?.sources?.bili?.keywords?.items ?? []),
    ...(snapshot?.sources?.douyin?.hot?.items ?? []),
  ];
}

/** 快照时间升序排列的 [date, snapshot] 列表。 */
function orderedDays(history, windowDays) {
  return Object.keys(history.days)
    .sort()
    .slice(-windowDays)
    .map((date) => [date, history.days[date]]);
}

/** 热度 Top N（跨平台合并排序，未聚合）。 */
function heatTop(items, limit = 12) {
  return [...items]
    .sort((a, b) => b.heat - a.heat)
    .slice(0, limit)
    .map((item) => ({
      title: item.title,
      source: item.source,
      kind: item.kind,
      rank: item.rank,
      heat: item.heat,
      url: item.url,
    }));
}

/** 分类构成（B站视频分区）。 */
function byCategory(videos, limit = 10) {
  const counts = new Map();
  for (const item of videos) {
    const name = item.category || '未分类';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/** 热度分档构成。 */
function byHeatBand(items) {
  return HEAT_BANDS.map((band) => ({
    name: band.name,
    count: items.filter((item) => item.heat >= band.min && item.heat < band.max).length,
  }));
}

/** 相对上一份快照的新上榜 / 掉榜 / 留存。 */
function diffAgainstPrevious(history, currentDate, currentItems) {
  const dates = Object.keys(history.days).sort();
  const previousDate = dates.filter((date) => date < currentDate).pop();
  if (!previousDate) {
    return { baseDate: null, newEntries: [], droppedEntries: [], stayed: 0 };
  }
  const previous = history.days[previousDate];
  const previousItems = allItems(previous);
  const currentIds = new Set(currentItems.map((item) => item.id));
  const previousIds = new Set(previousItems.map((item) => item.id));

  const project = (item) => ({ title: item.title, source: item.source, kind: item.kind, heat: item.heat, rank: item.rank, url: item.url });

  const newEntries = currentItems
    .filter((item) => !previousIds.has(item.id))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 20)
    .map(project);

  const droppedEntries = previousItems
    .filter((item) => !currentIds.has(item.id))
    .sort((a, b) => b.heat - a.heat)
    .slice(0, 20)
    .map(project);

  return {
    baseDate: previousDate,
    newEntries,
    droppedEntries,
    stayed: currentItems.filter((item) => previousIds.has(item.id)).length,
  };
}

/** 持续热梗：关键词在窗口内出现的不同天数。 */
function persistentKeywords(days, limit = 20) {
  const seen = new Map();
  for (const [date, snapshot] of days) {
    for (const item of memePhrases(snapshot)) {
      if (!seen.has(item.title)) seen.set(item.title, { keyword: item.title, source: item.source, days: new Set(), bestRank: item.rank, heat: item.heat });
      const record = seen.get(item.title);
      record.days.add(date);
      record.bestRank = Math.min(record.bestRank, item.rank ?? 999);
      record.heat = Math.max(record.heat, item.heat);
    }
  }
  return [...seen.values()]
    .filter((record) => record.days.size >= 2)
    .sort((a, b) => b.days.size - a.days.size || b.heat - a.heat)
    .slice(0, limit)
    .map((record) => ({ keyword: record.keyword, source: record.source, days: record.days.size, bestRank: record.bestRank, heat: record.heat }));
}

/**
 * 跨平台共现：同一 n-gram 同时命中 B站与抖音的短语。
 * 取 3–4 字中文 n-gram，外加长度 ≥3 的拉丁词；纯数字一律丢弃
 * （两条榜单里都出现的 "24" 没有任何话题含义）。
 */
function crossPlatformTerms(snapshot, limit = 18) {
  const bili = phraseIndex(snapshot?.sources?.bili?.keywords?.items ?? []);
  const douyin = phraseIndex(snapshot?.sources?.douyin?.hot?.items ?? []);
  if (!bili.size || !douyin.size) return [];

  const biliGrams = new Map();
  for (const phrase of bili.keys()) {
    for (const gram of gramsOf(phrase, 3, 4)) {
      if (!isMeaningfulGram(gram)) continue;
      if (!biliGrams.has(gram)) biliGrams.set(gram, new Set());
      biliGrams.get(gram).add(phrase);
    }
  }

  const douyinGrams = new Map();
  for (const phrase of douyin.keys()) {
    for (const gram of gramsOf(phrase, 3, 4)) {
      if (!isMeaningfulGram(gram)) continue;
      if (!douyinGrams.has(gram)) douyinGrams.set(gram, new Set());
      douyinGrams.get(gram).add(phrase);
    }
  }

  const hits = [];
  for (const [gram, biliPhrases] of biliGrams) {
    const douyinPhrases = douyinGrams.get(gram);
    if (!douyinPhrases) continue;
    const biliHeat = Math.max(...[...biliPhrases].map((p) => Math.max(...bili.get(p).map((i) => i.heat))));
    const douyinHeat = Math.max(...[...douyinPhrases].map((p) => Math.max(...douyin.get(p).map((i) => i.heat))));
    hits.push({
      term: gram,
      score: Math.min(biliPhrases.size, douyinPhrases.size),
      biliCount: biliPhrases.size,
      douyinCount: douyinPhrases.size,
      heat: biliHeat + douyinHeat,
      biliSample: [...biliPhrases][0],
      douyinSample: [...douyinPhrases][0],
    });
  }

  const sorted = hits.sort((a, b) => b.score - a.score || b.term.length - a.term.length || b.heat - a.heat);
  const kept = [];
  for (const hit of sorted) {
    if (kept.some((other) => gramsOverlap(other.term, hit.term))) continue;
    kept.push(hit);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** 标题高频词（3–4 字 n-gram 词频，启发式；2 字片段噪音过大故排除）。 */
function wordFrequency(items, limit = 24) {
  const counts = new Map();
  for (const item of items) {
    for (const gram of gramsOf(item.title, 3, 4)) {
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || b.word.length - a.word.length);

  const kept = [];
  for (const entry of ranked) {
    if (kept.some((other) => other.count >= entry.count && gramsOverlap(other.word, entry.word))) continue;
    kept.push(entry);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * 多日趋势：每天的条目数、总热度，以及梗/热点各自的条目数。
 *
 * 这里只用分类、不做话题聚合 —— 趋势图要的只是「每天梗/热点各多少条」，
 * 没必要为 14 天各跑一遍聚类（那是排行榜才需要的开销）。
 */
function trend(days) {
  return days.map(([date, snapshot]) => {
    const items = allItems(snapshot);
    let meme = 0;
    for (const item of items) if (classifyItem(item).group === GROUP_MEME) meme += 1;
    return {
      date,
      bili: items.filter((item) => item.source === 'bili').length,
      douyin: items.filter((item) => item.source === 'douyin').length,
      total: items.length,
      heat: items.reduce((sum, item) => sum + item.heat, 0),
      meme,
      news: items.length - meme,
    };
  });
}

/** 梗/热点构成（环形图用）。 */
function byGroup(groups) {
  return [
    { name: '梗', count: groups[GROUP_MEME].totals.items, color: '#8b5cf6' },
    { name: '热点', count: groups[GROUP_NEWS].totals.items, color: '#f59e0b' },
  ].filter((entry) => entry.count > 0);
}

/**
 * 汇总一份完整的统计结果。
 * @param {object} history
 * @param {string} currentDate 用于统计的日期键
 * @param {number} now 当前时间戳
 */
export function computeStats(history, currentDate, now = Date.now()) {
  const snapshot = history.days[currentDate] ?? null;
  const days = orderedDays(history, STATS_WINDOW_DAYS);
  const videos = snapshot?.sources?.bili?.videos?.items ?? [];
  const keywords = snapshot?.sources?.bili?.keywords?.items ?? [];
  const douyinHot = snapshot?.sources?.douyin?.hot?.items ?? [];
  const items = allItems(snapshot);
  const groups = buildGroupRankings(items);

  return {
    windowDays: STATS_WINDOW_DAYS,
    totals: {
      all: items.length,
      biliVideo: videos.length,
      biliKeyword: keywords.length,
      douyinHot: douyinHot.length,
      bili: videos.length + keywords.length,
      douyin: douyinHot.length,
      heat: items.reduce((sum, item) => sum + item.heat, 0),
    },
    bySource: [
      { name: 'B站视频', count: videos.length, color: '#fb7299' },
      { name: 'B站热搜', count: keywords.length, color: '#f59e0b' },
      { name: '抖音热榜', count: douyinHot.length, color: '#22d3ee' },
    ].filter((entry) => entry.count > 0),
    byGroup: byGroup(groups),
    // 热点榜：分类 + 话题聚合 + 综合热度排行（事件会占据多个榜位，聚合才有意义）
    groups,
    // 梗榜：流传度榜 —— 只统计被反复复用的**词**，且完全不用热度值
    memeSpread: buildMemeSpread(days),
    heatTop: heatTop(items),
    byCategory: byCategory(videos),
    heatBands: byHeatBand(items),
    diff: diffAgainstPrevious(history, currentDate, items),
    persistentKeywords: persistentKeywords(days),
    crossPlatform: crossPlatformTerms(snapshot),
    trend: trend(days),
    wordFreq: wordFrequency(items),
    generatedAt: now,
  };
}
