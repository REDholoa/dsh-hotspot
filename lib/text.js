// 文本工具：中文无分词器时的 n-gram 提取与相似度判定。
//
// 被 stats.js（统计）与 classify.js（梗/热点分类与聚合）共用，
// 单独成文件是为了避免两者互相 import 形成环。
//
// 口径说明（重要）：
//   中文没有词边界，这里用 2–6 字的滑窗 n-gram 作为「近似词」。
//   它有两个已知副作用，代码里都做了针对性处理：
//     1. 滑窗错位会产生近义碎片（全球领先 / 球领先上）→ gramsOverlap 判重；
//     2. 长度越短的 gram 越泛用（「官方」「回应」）→ 按用途限定长度下限。

/** n-gram 提取时丢弃的纯功能词片段，降低噪音。 */
export const GRAM_STOPWORDS = new Set([
  '的', '了', '是', '在', '和', '与', '我', '你', '他', '她', '它', '们',
  '一个', '这个', '那个', '什么', '怎么', '为什么', '可以', '没有', '就是',
  '真的', '不是', '还是', '但是', '因为', '所以', '如果', '已经', '自己',
  '视频', '官方', '全集', '完整', '更新', '第一', '第二', '第三',
  '到了', '我的', '你的', '他的', '我们', '你们', '他们',
  '东西', '时候', '现在', '今天', '昨天', '明天', '开始', '最后',
]);

/** 取出文本里的中文连续片段与拉丁/数字片段。 */
export function runsOf(text) {
  const cjk = String(text ?? '').match(/[\u4e00-\u9fa5]+/g) ?? [];
  const latin = String(text ?? '').match(/[A-Za-z0-9]{2,}/g) ?? [];
  return { cjk, latin };
}

/**
 * 提取 n-gram 集合：中文取连续片段里的 min–max 字滑窗，拉丁词整词保留（小写）。
 * @param {string} text
 * @param {number} [min]
 * @param {number} [max]
 * @returns {Set<string>}
 */
export function gramsOf(text, min = 2, max = 4) {
  const grams = new Set();
  const { cjk, latin } = runsOf(text);
  for (const run of cjk) {
    for (let size = min; size <= max; size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) {
        const gram = run.slice(i, i + size);
        if (!GRAM_STOPWORDS.has(gram)) grams.add(gram);
      }
    }
  }
  for (const word of latin) grams.add(word.toLowerCase());
  return grams;
}

/**
 * 只取「纯中文且长度在 [min,max] 内」的 gram。
 * 分类与聚合用它，可以避开数字串（2026）与英文缩写带来的误匹配。
 */
export function cjkGramsOf(text, min = 3, max = 5) {
  const out = new Set();
  const { cjk } = runsOf(text);
  for (const run of cjk) {
    for (let size = min; size <= max; size += 1) {
      for (let i = 0; i + size <= run.length; i += 1) {
        const gram = run.slice(i, i + size);
        if (!GRAM_STOPWORDS.has(gram)) out.add(gram);
      }
    }
  }
  return out;
}

/** 最长公共子串长度：判断两个短语是否只是「同一个词的滑窗错位」。 */
export function longestCommonSubstringLength(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!left || !right) return 0;
  const cols = right.length + 1;
  let prev = new Array(cols).fill(0);
  let best = 0;
  for (let i = 1; i <= left.length; i += 1) {
    const curr = new Array(cols).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > best) best = curr[j];
      }
    }
    prev = curr;
  }
  return best;
}

/**
 * 两个 n-gram 是否「实质重复」：互相包含，或仅错位一个字符。
 * 例：全球领先 / 球领先上 → 最长公共子串「球领先」= 3 = 4-1，判为重复。
 */
export function gramsOverlap(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  return longestCommonSubstringLength(left, right) >= Math.min(left.length, right.length) - 1;
}

/** 该 gram 是否值得当作「话题词」（排除纯数字与过短英文）。 */
export function isMeaningfulGram(gram) {
  const value = String(gram ?? '');
  if (!value) return false;
  if (/^\d+$/.test(value)) return false;
  if (/^[a-z]{1,2}$/.test(value)) return false;
  return true;
}

/**
 * 取出拉丁/数字词并小写化。
 * 梗不只有中文：`S16`、`REA`、`VCT`、`Citywalk` 这类缩写同样是被反复复用的梗词。
 */
export function latinTokensOf(text) {
  const { latin } = runsOf(text);
  return latin.map((word) => word.toLowerCase());
}

/**
 * 两串之间所有「极大公共子串」（长度 ≥ minLen）。
 *
 * 「极大」= 无法再向左右扩展。这正好用来抽取**被复用的短语**：
 * 滑窗 n-gram 会把「全球领先上映」切成一堆错位碎片（球领先上 / 领先上映 / …），
 * 而极大公共子串直接给出完整的那一段。
 *
 * 例：commonSubstrings('复联5定档全球领先上映', '复联5定档1216全球领先上映')
 *     → ['复联5定档', '全球领先上映']
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [minLen]
 * @returns {string[]} 长的排前面
 */
export function commonSubstrings(a, b, minLen = 2) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (!left || !right) return [];
  const rows = left.length;
  const cols = right.length;
  const found = [];
  let prev = new Array(cols + 1).fill(0);
  for (let i = 1; i <= rows; i += 1) {
    const curr = new Array(cols + 1).fill(0);
    for (let j = 1; j <= cols; j += 1) {
      if (left[i - 1] !== right[j - 1]) continue;
      curr[j] = prev[j - 1] + 1;
      // 只有「右边再也接不下去」的位置才是极大公共子串的结尾
      const extendable = i < rows && j < cols && left[i] === right[j];
      if (!extendable && curr[j] >= minLen) found.push(left.slice(i - curr[j], i));
    }
    prev = curr;
  }
  const kept = [];
  for (const candidate of found.sort((x, y) => y.length - x.length)) {
    if (kept.some((longer) => longer.includes(candidate))) continue;
    kept.push(candidate);
  }
  return kept;
}
