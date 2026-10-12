// 数据源适配层：B站 / 抖音 的热点抓取。
//
// 设计原则（对应用户选定的「官方公开接口直连为主 + 第三方聚合兜底」）：
//   1. 每个「数据槽位」有一组按优先级排列的 provider；
//   2. 依次尝试，第一个成功且非空的结果胜出；
//   3. 全部失败时抛出聚合错误，由上层决定是否沿用磁盘缓存（stale 展示）。
//
// 所有 provider 都返回统一形态：
//   { provider: string, label: string, items: HotItem[] }
//
// HotItem:
//   {
//     id: string,            // 平台内稳定唯一 id（用于跨天差分）
//     source: 'bili'|'douyin',
//     kind: 'video'|'keyword'|'hot',
//     rank: number,          // 榜单名次，从 1 开始
//     title: string,
//     url: string,
//     heat: number,          // 热度：播放量 / 热度值，已归一化为数字
//     author: string,
//     category: string,
//     cover: string,
//     publishedAt: number|null,
//     metrics: Record<string, number>,
//   }

import { cleanText, fetchJson, httpsUrl, num, parseHeat, str, toMillis } from './http.js';

/** B站 web 接口要求的 Referer，缺失会被风控。 */
const BILI_REFERER = 'https://www.bilibili.com/';
const BILI_APP_REFERER = 'https://app.bilibili.com/';
const DOUYIN_REFERER = 'https://www.douyin.com/';
const AGGREGATOR_REFERER = 'https://www.baidu.com/';

/** 抖音热榜标签位：1=热 3=新，其余（0 等）视为无标签。约定为尽力而为的映射。 */
function douyinLabel(label) {
  const value = num(label);
  if (value === 1) return '热';
  if (value === 3) return '新';
  return '';
}

/** 抖音搜索页链接（热榜条目没有详情页，官方站内搜索是等价入口）。 */
function douyinSearchUrl(word) {
  return `https://www.douyin.com/search/${encodeURIComponent(word)}`;
}

// ---------------------------------------------------------------------------
// B站 · 视频榜
// ---------------------------------------------------------------------------

/** 官方：全站排行榜（100 条，含播放/点赞/弹幕）。 */
async function biliRanking() {
  const json = await fetchJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
    referer: BILI_REFERER,
  });
  if (num(json?.code) !== 0) throw new Error(`B站接口 code=${json?.code} ${str(json?.message)}`);
  const list = Array.isArray(json?.data?.list) ? json.data.list : [];
  const items = list
    .map((video, index) => {
      const bvid = str(video?.bvid);
      const title = cleanText(video?.title);
      if (!title) return null;
      return {
        id: `bili:video:${bvid || title}`,
        source: 'bili',
        kind: 'video',
        rank: index + 1,
        title,
        url: bvid ? `https://www.bilibili.com/video/${bvid}` : str(video?.short_link_v2),
        heat: num(video?.stat?.view),
        author: cleanText(video?.owner?.name),
        category: str(video?.tname),
        cover: httpsUrl(video?.pic),
        publishedAt: toMillis(video?.pubdate),
        metrics: {
          like: num(video?.stat?.like),
          danmaku: num(video?.stat?.danmaku),
          reply: num(video?.stat?.reply),
        },
      };
    })
    .filter(Boolean);
  return { provider: 'bilibili:ranking', label: 'B站排行榜（官方）', items };
}

/** 第三方兜底：aa1 的 B站热门搬运，热度是「551.9万」这种中文字符串。 */
async function biliAa1() {
  const json = await fetchJson('https://v.api.aa1.cn/api/bilibili-rs/index.php', {
    referer: AGGREGATOR_REFERER,
  });
  const list = Array.isArray(json?.data) ? json.data : [];
  const items = list
    .map((video, index) => {
      const title = cleanText(video?.title);
      if (!title) return null;
      return {
        id: `bili:video:${str(video?.link) || title}`,
        source: 'bili',
        kind: 'video',
        rank: index + 1,
        title,
        url: str(video?.link),
        heat: parseHeat(video?.heat),
        author: '',
        category: '',
        cover: '',
        publishedAt: null,
        metrics: {},
      };
    })
    .filter(Boolean);
  return { provider: 'aa1:bilibili', label: 'B站热门（aa1 聚合）', items };
}

// ---------------------------------------------------------------------------
// B站 · 热搜词（梗的主要来源）
// ---------------------------------------------------------------------------

/** 官方：PC 端热搜广场。 */
async function biliSearchSquare() {
  const json = await fetchJson('https://api.bilibili.com/x/web-interface/search/square?limit=50', {
    referer: BILI_REFERER,
  });
  if (num(json?.code) !== 0) throw new Error(`B站热搜接口 code=${json?.code} ${str(json?.message)}`);
  const list = Array.isArray(json?.data?.trending?.list) ? json.data.trending.list : [];
  return { provider: 'bilibili:search-square', label: 'B站热搜（官方）', items: mapBiliKeywords(list) };
}

/** 官方兜底：App 端热搜排行（与 PC 端不同源，互为冗余）。 */
async function biliAppTrending() {
  const json = await fetchJson('https://app.bilibili.com/x/v2/search/trending/ranking?limit=50', {
    referer: BILI_APP_REFERER,
  });
  if (num(json?.code) !== 0) throw new Error(`B站 App 热搜接口 code=${json?.code} ${str(json?.message)}`);
  const list = Array.isArray(json?.data?.list) ? json.data.list : [];
  return { provider: 'bilibili:app-trending', label: 'B站热搜（官方 App）', items: mapBiliKeywords(list) };
}

/** 两个 B站热搜接口字段基本一致，共用一个映射。 */
function mapBiliKeywords(list) {
  return list
    .map((entry, index) => {
      const keyword = cleanText(entry?.keyword ?? entry?.show_name);
      if (!keyword) return null;
      return {
        id: `bili:keyword:${keyword}`,
        source: 'bili',
        kind: 'keyword',
        rank: index + 1,
        title: keyword,
        url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`,
        heat: num(entry?.heat_score),
        author: '',
        category: '热搜',
        cover: httpsUrl(entry?.icon),
        publishedAt: null,
        metrics: {},
      };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// 抖音 · 热榜
// ---------------------------------------------------------------------------

/** 官方：Web 端热榜接口。实测无需 Cookie / 签名即可返回完整 word_list。 */
async function douyinOfficial() {
  const url =
    'https://www.douyin.com/aweme/v1/web/hot/search/list/' +
    '?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1';
  const json = await fetchJson(url, { referer: DOUYIN_REFERER });
  const list = Array.isArray(json?.data?.word_list) ? json.data.word_list : [];
  const items = list
    .map((entry, index) => {
      const title = cleanText(entry?.word);
      if (!title) return null;
      const cover = entry?.word_cover?.url_list;
      return {
        id: `douyin:hot:${str(entry?.sentence_id) || title}`,
        source: 'douyin',
        kind: 'hot',
        rank: index + 1,
        title,
        url: douyinSearchUrl(title),
        heat: num(entry?.hot_value),
        author: '',
        category: douyinLabel(entry?.label),
        cover: httpsUrl(Array.isArray(cover) ? cover[0] : ''),
        publishedAt: toMillis(entry?.event_time),
        metrics: {
          video: num(entry?.video_count),
          discuss: num(entry?.discuss_video_count),
        },
      };
    })
    .filter(Boolean);
  return { provider: 'douyin:hotsearch', label: '抖音热榜（官方）', items };
}

/** 第三方兜底 1：60s API。 */
async function douyin60s() {
  const json = await fetchJson('https://60s.viki.moe/v2/douyin', { referer: 'https://60s.viki.moe/' });
  const list = Array.isArray(json?.data) ? json.data : [];
  const items = list
    .map((entry, index) => {
      const title = cleanText(entry?.title);
      if (!title) return null;
      return {
        id: `douyin:hot:${title}`,
        source: 'douyin',
        kind: 'hot',
        rank: index + 1,
        title,
        url: str(entry?.link) || douyinSearchUrl(title),
        heat: num(entry?.hot_value),
        author: '',
        category: '',
        cover: httpsUrl(entry?.cover),
        publishedAt: toMillis(entry?.event_time_at),
        metrics: {},
      };
    })
    .filter(Boolean);
  return { provider: '60s:douyin', label: '抖音热榜（60s 聚合）', items };
}

/** 第三方兜底 2：qqsuu 聚合。 */
async function douyinQqsuu() {
  const json = await fetchJson('https://api.qqsuu.cn/api/dm-douyinhot', { referer: AGGREGATOR_REFERER });
  const list = Array.isArray(json?.data?.list) ? json.data.list : [];
  const items = list
    .map((entry, index) => {
      const title = cleanText(entry?.word);
      if (!title) return null;
      return {
        id: `douyin:hot:${title}`,
        source: 'douyin',
        kind: 'hot',
        rank: index + 1,
        title,
        url: douyinSearchUrl(title),
        heat: num(entry?.hotindex),
        author: '',
        category: douyinLabel(entry?.label),
        cover: '',
        publishedAt: null,
        metrics: {},
      };
    })
    .filter(Boolean);
  return { provider: 'qqsuu:douyin', label: '抖音热榜（qqsuu 聚合）', items };
}

// ---------------------------------------------------------------------------
// 槽位定义 + 回退执行
// ---------------------------------------------------------------------------

/** B站视频榜槽位：官方排行榜为主，aa1 聚合兜底。 */
export const BILI_VIDEO_SLOT = [
  { id: 'bilibili:ranking', kind: 'official', run: biliRanking },
  { id: 'aa1:bilibili', kind: 'thirdparty', run: biliAa1 },
];

/** B站热搜词槽位：PC 热搜为主，App 热搜兜底（同为官方，互为冗余）。 */
export const BILI_KEYWORD_SLOT = [
  { id: 'bilibili:search-square', kind: 'official', run: biliSearchSquare },
  { id: 'bilibili:app-trending', kind: 'official', run: biliAppTrending },
];

/** 抖音热榜槽位：官方热榜为主，两个第三方聚合依次兜底。 */
export const DOUYIN_SLOT = [
  { id: 'douyin:hotsearch', kind: 'official', run: douyinOfficial },
  { id: '60s:douyin', kind: 'thirdparty', run: douyin60s },
  { id: 'qqsuu:douyin', kind: 'thirdparty', run: douyinQqsuu },
];

/**
 * 依次尝试一组 provider，返回第一个成功且非空的结果。
 * 全部失败时抛错，错误信息里带上每个 provider 的失败原因（便于在页面上诊断）。
 * @param {Array<{ id: string, kind: string, run: () => Promise<{provider: string, label: string, items: any[]}> }>} providers
 * @returns {Promise<{ provider: string, label: string, kind: string, items: any[], attempts: Array<{id: string, ok: boolean, error?: string}> }>}
 */
export async function runSlot(providers) {
  const attempts = [];
  for (const candidate of providers) {
    try {
      const result = await candidate.run();
      if (!result.items.length) throw new Error('返回空列表');
      attempts.push({ id: candidate.id, ok: true });
      return { ...result, kind: candidate.kind, attempts };
    } catch (error) {
      attempts.push({ id: candidate.id, ok: false, error: error?.message ?? String(error) });
    }
  }
  const detail = attempts.map((a) => `${a.id}: ${a.error}`).join(' | ');
  throw new Error(`全部数据源失败 → ${detail}`);
}
