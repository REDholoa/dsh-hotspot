// HTTP 与数值解析小工具：无第三方依赖，统一超时、UA、错误语义。
//
// 所有数据源都是「公开只读接口」，这里只做最朴素的 GET + JSON 解析；
// 任何失败都抛 Error（由 sources.js 决定是否回退到下一个数据源）。

/** 统一的浏览器 UA：部分接口对空 UA / 脚本 UA 会拒绝或返回风控页。 */
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 单次请求超时（毫秒）。热点接口都很快，15s 足够区分「慢」和「挂」。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * 带超时的 GET，返回响应文本。
 * @param {string} url
 * @param {{ referer?: string, timeoutMs?: number, accept?: string }} [options]
 * @returns {Promise<string>}
 */
export async function fetchText(url, options = {}) {
  const { referer, timeoutMs = DEFAULT_TIMEOUT_MS, accept = 'application/json, text/plain, */*' } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: accept,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return await response.text();
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`请求超时（${timeoutMs}ms）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带超时的 GET + JSON 解析。
 * 上游返回 HTML（风控页 / 错误页）时，JSON.parse 的报错信息很难懂，这里换成可读错误。
 * @param {string} url
 * @param {{ referer?: string, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
export async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    const head = text.trim().slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`响应不是 JSON：${head}`);
  }
}

/** 安全转数字：undefined/null/NaN 一律 0。 */
export function num(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 安全转字符串并去掉首尾空白。 */
export function str(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

/** 清洗标题：去掉 B 站接口惯用的 <em> 高亮标签与 HTML 实体。 */
export function cleanText(value) {
  return str(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 接口偶尔返回 http:// 的图片地址；页面是 http(s) 混用时浏览器会拦，这里统一升级到 https。 */
export function httpsUrl(value) {
  const url = str(value);
  if (!url) return '';
  return url.startsWith('http://') ? `https://${url.slice(7)}` : url;
}

/**
 * 解析中文热度写法：'551.9万' → 5519000，'1.2亿' → 120000000，'1234' → 1234。
 * 第三方聚合接口常用这种字符串，官方接口都是数字。
 */
export function parseHeat(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = str(value);
  if (!text) return 0;
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*([万亿wWkK]?)/);
  if (!match) return 0;
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return 0;
  const unit = match[2];
  const factor = unit === '万' || unit === 'w' || unit === 'W' ? 1e4 : unit === '亿' ? 1e8 : unit === 'k' || unit === 'K' ? 1e3 : 1;
  return Math.round(base * factor);
}

/** 把毫秒或秒级时间戳统一成毫秒；非法值返回 null。 */
export function toMillis(value) {
  const parsed = num(value);
  if (parsed <= 0) return null;
  return parsed > 1e12 ? Math.round(parsed) : Math.round(parsed * 1000);
}
