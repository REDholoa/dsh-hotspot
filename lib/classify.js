// 分类与聚合：把抓到的条目分成「梗」和「热点」，再按话题聚合、按综合热度排行。
//
// ── 为什么要分开 ─────────────────────────────────────────────────────────────
// 直接把 B站视频、B站热搜词、抖音热榜混成一张榜，会把「某个游戏梗」和
// 「某国机场遇袭」排在一起比热度，两者量纲、性质、阅读意图都不同。分开更可用。
//
// 这里的两组含义是：
//   · 梗   —— 娱乐 / 生活 / 流行文化（可以玩的、看热闹的）
//   · 热点 —— 时事 / 事件 / 信息（需要知道的）
//
// ── 分类口径（启发式，可调）───────────────────────────────────────────────
// 判别顺序：
//   1. B站视频有官方分区（tname），分区是强信号，优先按分区归类；
//   2. 否则用细分规则表匹配标题，命中即给该组 +2 分（细分类别判别力强）；
//   3. 再叠加零散特征词：数字型事件特征（死/伤/亿/%）加分到热点，
//      口语化语气词加分到梗；
//   4. 仍打平时用「标题形态」兜底（第一人称 / 短句 / 感叹 → 梗）。
//
// 这是规则法而非模型，一定存在错判的个例。因此面板上把「细分」标签和
// 判定依据（via）一并展示，你能直接看出它为什么被这么分；要调风格改下面的规则表即可。
//
// ── 聚合与综合热度 ───────────────────────────────────────────────────────────
// 同一件事常常同时占着好几个榜位（「郑钦文退赛」在抖音有多条、B站热搜也有一条）。
// 这里把指同一件事的条目聚成一个话题簇，簇的
//     综合热度 = 簇内所有条目热度之和
// 并据此排行 —— 这正是「以条目几个的综合热度进行排行」。
//
// 聚类的关键信号是**共享的、有区分度的词**（「郑钦文」「复联5」「桂花香」），
// 而不是长字面重合：同义改写（「武网官方回应郑钦文退赛」vs「郑钦文因伤退出武汉网球公开赛」）
// 几乎没有 5 字以上的公共子串，但都含「郑钦文」。
// 因此做法是：按候选词的**文档频次（DF）**筛出既非独有、又非泛用的词，
// 共享这类词的条目并为一簇。
//
// 注意：B站热度是播放量、抖音热度是热度值，两者量纲不同，求和是「并排叠加」
// 而非严格可比。面板会同时显示条目数与平台构成，便于判断名次是「一条极高」
// 还是「多条中等」堆出来的。

import { cjkGramsOf, commonSubstrings, longestCommonSubstringLength } from './text.js';

/** 分类标签。 */
export const GROUP_MEME = 'meme';
export const GROUP_NEWS = 'news';

/** 组名（面板展示用）。 */
export const GROUP_LABEL = { [GROUP_MEME]: '梗', [GROUP_NEWS]: '热点' };

/**
 * 细分规则表。按数组顺序匹配，**第一个命中的规则**决定细分名与所属分组，
 * 该组同时 +2 分。组内靠前的规则更具体，所以顺序有意义。
 */
const SUBCATEGORY_RULES = [
  // ── 梗：娱乐 / 生活 / 流行文化 ──────────────────────────────────────
  { group: GROUP_MEME, name: '网络流行语', re: /是什么梗|什么水平|绷不住|破防|整活|上头|社死|emo|绝了|离谱|无语|笑死|笑不活|谁来管管|怎么做到|礼貌吗|栓Q|尊嘟|精神状态|抽象|逆天|迷惑行为|精神状态|难绷|麻了|赢麻|什么档次|确认过眼神|一整个|浅浅|冤种|显眼包|搭子/ },
  { group: GROUP_MEME, name: '游戏电竞', re: /游戏|电竞|战队|选手|赛事|英雄联盟|王者荣耀|原神|LOL|DOTA|CS2|CSGO|Steam|主机|手游|开黑|上分|版本|赛季|主播|解说|对局|排位|抽卡|副本|皮肤|更新公告|测试服|MOBA|FPS/ },
  { group: GROUP_MEME, name: '娱乐搞笑', re: /搞笑|沙雕|神操作|名场面|翻车|吐槽|盘点|整蛊|段子|相声|小品|喜剧|笑点|综艺感|挑战|实况|抽象|离谱|乐子|节目效果|高能|沙雕|整活|鬼畜|二创/ },
  { group: GROUP_MEME, name: '二次元', re: /二次元|cosplay|cos|谷子|手办|漫展|同人|vtuber|虚拟主播|中之人|番剧|新番|国创|漫画|动漫|动画|手书|音游|痛车|漫改/ },
  { group: GROUP_MEME, name: '影视综艺', re: /电影|电视剧|剧集|开播|定档|首映|票房|角色|演员|导演|预告|花絮|大结局|剧透|综艺|真人秀|短片|微电影|纪录片|剧场版|上映/ },
  { group: GROUP_MEME, name: '音乐舞蹈', re: /音乐|歌曲|专辑|演唱会|音乐节|live|翻唱|原唱|舞台|直拍|舞蹈|编舞|随机舞蹈|remix|beat|歌单|演奏|合唱|音乐现场/ },
  { group: GROUP_MEME, name: '生活方式', re: /美食|做饭|菜谱|探店|旅行|旅游|穿搭|美妆|健身|减肥|养宠|宠物|手工|日常|vlog|露营|骑行|收纳|装修|桂花|银杏|金秋|秋天|赏秋|假日|假期|周末|打卡|攻略|宝藏|慢充|citywalk|出行|居家|亲子|咖啡|甜品|夜市|露营|自驾/ },

  // ── 热点：时事 / 事件 / 信息 ────────────────────────────────────────
  { group: GROUP_NEWS, name: '时政要闻', re: /国务院|外交部|国防部|发改委|教育部|卫健委|工信部|央行|人大|政协|两会|主席|总书记|总统|总理|首相|部长|发言人|政策|出台|新政|会议|峰会|论坛|声明|条约|联合国|白宫|欧盟|决议|立法|中央|党建|纪委|监察/ },
  { group: GROUP_NEWS, name: '国际局势', re: /袭击|空袭|战争|冲突|交火|打击|军队|军方|武装|导弹|无人机|边境|撤军|停火|谈判|制裁|恐袭|政变|伤亡|遇难|难民|开战|停战/ },
  { group: GROUP_NEWS, name: '天气灾害', re: /台风|暴雨|洪水|内涝|地震|高温|寒潮|干旱|山火|泥石流|预警|停课|停工|避险|气旋|强对流|冰雹|大风|暴雪|防汛|抗旱/ },
  { group: GROUP_NEWS, name: '健康医疗', re: /疫情|病例|病毒|流感|疫苗|就医|药品|医保|医院|癌症|传染|防控|体检|疾控|医生|患者|手术|门诊|养生堂|疾病/ },
  { group: GROUP_NEWS, name: '社会民生', re: /警方|公安|民警|警察|法院|检察|判决|判刑|起诉|抓获|嫌疑人|嫌犯|拘留|查处|醉驾|肇事|通报|事故|火灾|车祸|坠楼|溺亡|失联|救援|击毙|市民|居民|社区|物业|养老|社保|入学|高考|考研|地铁|公交|高铁|航班|快递|外卖|农民工|食品安全|补贴|骗局|诈骗|虚假|警惕|提醒/ },
  { group: GROUP_NEWS, name: '财经商业', re: /股价|上市|融资|收购|营收|利润|裁员|破产|市值|利率|汇率|房价|楼市|GDP|CPI|PMI|出口|进口|关税|亿元|万亿|同比|环比|经济|消费|就业|失业率|降息|加息|财报|投资|基金|债券|银行|景气|指数|物流业|制造业|产能/ },
  { group: GROUP_NEWS, name: '科技数码', re: /芯片|人工智能|大模型|显卡|算力|机器人|卫星|火箭|航天|发射|操作系统|开源|鸿蒙|英伟达|半导体|自动驾驶|5G|6G|量子|数据中心|算法|手机|笔记本|处理器|电池|新能源/ },
  { group: GROUP_NEWS, name: '文体赛事', re: /比赛|夺冠|冠军|决赛|半决赛|联赛|世界杯|奥运|亚运|全运|网球|篮球|足球|乒乓|羽毛球|马拉松|田径|游泳|F1|公开赛|大满贯|退赛|奖牌|国家队|国奥|教练|球员|转会|赛季报销/ },
];

/**
 * 只用于「不参与聚类的泛用词」。
 * 这些词在标题里很常见，但不指向具体话题 —— 让它们参与聚类会把
 * 「官方回应A」和「官方回应B」并成一个簇。
 */
const CLUSTER_STOPWORDS = new Set([
  '回应', '通报', '宣布', '公布', '表示', '消息', '官方', '视频', '直播',
  '挑战', '攻略', '记录', '分享', '盘点', '合集', '来了', '上新', '直拍',
  '舞台', '现场', '首次', '最新', '今日', '网友', '大家', '系列', '发布',
  '上线', '开启', '进行', '已经', '可以', '什么', '怎么', '这个', '就是',
]);

/**
 * B站官方分区（tname）→ 分组。用模式匹配而非穷举字典：
 * B站分区名有上百个且会变，穷举必漏；模式匹配更耐用。
 * 优先判「热点」类，因为「运动」「汽车」这类词不会出现在娱乐分区名里。
 */
const TNAME_NEWS_RE = /资讯|热点|社会|时事|新闻|财经|商业|科技|数码|知识|科普|军事|历史|法律|心理|纪录片|汽车|运动|体育|健康|教育|房产|科学|技术|机械|动物|自然|资讯/;
const TNAME_MEME_RE = /搞笑|鬼畜|生活|日常|美食|动物圈|时尚|美妆|舞蹈|音乐|动画|番剧|国创|漫画|影视|电影|电视剧|综艺|娱乐|明星|游戏|电竞|桌游|音游|亲子|手工|绘画|VOCALOID|同人|三次元/;

/** 数字型事件特征：死伤人数、金额、百分比 —— 事件类信息几乎一定带这些。 */
const NEWS_NUMBER_RE = /\d+\s*(?:死|伤|人|例|亿|万|元|%|％|公里|吨|架|辆|艘)/;

/**
 * 泛用短语特征：以功能字收尾、或以功能字/人称词开头。
 * 这类片段指向的是**句式**而不是话题：
 * 「请查收」「拍到了」「来到了」「放了什么」都会让两条毫不相干的标题并到一起；
 * 「次中国行」「第一次」这种则是公共子串从词中间切出来的残片。
 */
const FUNCTIONAL_TAIL_RE = /[了的到着过么啊吧呢吗呀哦嘛是在有和与就都也很更最]$/;
const FUNCTIONAL_HEAD_RE = /^(?:[次第的了是在和与被把让给对从向为就都也还又再才只刚已将会该其之而或及并于由至等这那各每某我你咱有没无不更太超])/;

/** 该词是否像「话题本体」而不是句式片段。 */
function looksLikeTopicTerm(gram) {
  if (FUNCTIONAL_TAIL_RE.test(gram)) return false;
  if (FUNCTIONAL_HEAD_RE.test(gram)) return false;
  return true;
}

/** 找到第一个命中的细分规则。 */
function matchSubcategory(text) {
  for (const rule of SUBCATEGORY_RULES) {
    if (rule.re.test(text)) return { group: rule.group, sub: rule.name };
  }
  return null;
}

/**
 * 规则表的「整词」版本：^…$ 锚定。
 *
 * 分类时要的是**子串**匹配（标题里出现「演唱会」就够），
 * 但判断「某个 n-gram 是不是类别词本身」时必须整词匹配 ——
 * 否则「桂花香」会因为含有「桂花」被误判成类别词，从而丢掉一个本来正确的话题聚合。
 */
const ANCHORED_CATEGORY_RES = SUBCATEGORY_RULES.map((rule) => new RegExp(`^(?:${rule.re.source})$`));

/** 该词是否是「类别词本身」（整词匹配），是的话不参与话题聚类。 */
function isCategoryTerm(gram) {
  if (CLUSTER_STOPWORDS.has(gram)) return true;
  return ANCHORED_CATEGORY_RES.some((re) => re.test(gram));
}

/**
 * 「领域类别词」—— 用来判断一个公共子串是不是仅仅因为「同属一个领域」才重合。
 *
 * 关键：**刻意排除「网络流行语」这条规则**。那条规则里列的就是梗本身
 * （破防 / 整活 / 上头 / 绝了 …），如果拿全表去排除，会把真正的梗也一起排掉。
 * 剩下的规则才是领域名词（演唱会 / 比赛 / 电影 / 游戏 / 财经 …），
 * 两条不同歌手的「演唱会」不该算成同一个梗。
 */
const DOMAIN_CATEGORY_RES = SUBCATEGORY_RULES.filter((rule) => rule.name !== '网络流行语').map(
  (rule) => new RegExp(`^(?:${rule.re.source})$`),
);

/**
 * 给一条热点条目分类。
 * @returns {{ group: 'meme'|'news', sub: string, via: string }}
 */
export function classifyItem(item) {
  const title = String(item?.title ?? '');
  if (!title) return { group: GROUP_NEWS, sub: '其他', via: '空标题兜底' };

  // 1. B站视频：官方分区优先（分区是平台自己打的标，比关键词可靠）
  if (item.kind === 'video' && item.category) {
    const category = String(item.category);
    const hit = matchSubcategory(category);
    if (TNAME_NEWS_RE.test(category)) {
      return { group: GROUP_NEWS, sub: hit?.group === GROUP_NEWS ? hit.sub : '社会民生', via: `B站分区「${category}」` };
    }
    if (TNAME_MEME_RE.test(category)) {
      return { group: GROUP_MEME, sub: hit?.group === GROUP_MEME ? hit.sub : '其他梗', via: `B站分区「${category}」` };
    }
    if (hit) return { group: hit.group, sub: hit.sub, via: `B站分区「${category}」` };
  }

  // 2. 标题规则打分
  const hit = matchSubcategory(title);
  let memeScore = hit?.group === GROUP_MEME ? 2 : 0;
  let newsScore = hit?.group === GROUP_NEWS ? 2 : 0;
  if (NEWS_NUMBER_RE.test(title)) newsScore += 2;

  // 3. 口语化 / 第一人称 / 短感叹 → 偏梗
  //    注意排除「我国」：它是新闻里的高频词，不能当成第一人称。
  if (/我(?!国)|你|咱/.test(title)) memeScore += 1;
  if (/[啊吧吗呢哈呀哦嘛]$/.test(title) || /[！!？?]{1,}$/.test(title)) memeScore += 1;

  let group;
  let via;
  if (newsScore > memeScore) {
    group = GROUP_NEWS;
    via = hit?.group === GROUP_NEWS ? `细分「${hit.sub}」` : '事件/信息特征';
  } else if (memeScore > newsScore) {
    group = GROUP_MEME;
    via = hit?.group === GROUP_MEME ? `细分「${hit.sub}」` : '娱乐/生活特征';
  } else {
    // 4. 打平：短句偏梗，长叙述偏热点（不再按来源兜底，避免退化成「B站=梗」）
    const short = title.length <= 9;
    group = short ? GROUP_MEME : GROUP_NEWS;
    via = short ? '打平：短句偏梗' : '打平：长叙述偏热点';
  }

  const sub = hit && hit.group === group ? hit.sub : group === GROUP_MEME ? '其他梗' : '其他热点';
  return { group, sub, via };
}

/** 每个话题簇最多列出的细分子条目数（面板展开时用）。 */
const MAX_CLUSTER_MEMBERS = 12;

/**
 * 把条目按「是否在讲同一件事」聚成话题簇。
 *
 * 三轮设计，每一轮都针对一个具体的失败模式：
 *
 *   1. **候选词只取 3–6 字纯中文 n-gram，且必须至少被 3 条命中。**
 *      2 字 gram 会产生大量偶然重合（「广州把健身房搬进地铁」和「宋雨琦广州演唱会」
 *      共享「广州」；「新人第1次编曲」和「北方人第一次闻桂花香」共享「人第」），
 *      所以 2 字一律不参与。只出现 2 次的 3 字片段同样不够——它们多半是
 *      「请查收」「拍到了」这类句式片段，把 minDf 提到 3 就能挡掉。
 *      另外 looksLikeTopicTerm 再挡一层功能字收尾/人称开头的片段。
 *
 *   2. **每条只认一个「主词」，不做传递闭包。**
 *      早期版本让任意共享词的条目两两合并，结果是 A—词1—B—词2—C 一路串下去，
 *      把 14 条互不相关的视频粘成一大坨。改成每条挑一个主词、按键分组后，
 *      簇与簇天然不相交，链式误并直接消失。
 *      主词的挑法：**先看文档频次（越高说明越多条在讲它，越可能是话题本体），
 *      频次相同再取更长的**。若反过来优先长词，就会选中「武汉网球」这类
 *      只出现两次的碎片，反而让同一件事的两条各自成簇。
 *
 *   3. **再补一轮长字面重合（最长公共子串 ≥ 6）**，兜住只改了几个字的近似重复，
 *      以及「复联5定档…全球领先上映」这类靠中文 gram 抓不到数字后缀的情况。
 */
export function clusterItems(items) {
  const count = items.length;
  if (count === 0) return [];

  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  // 候选词：3–6 字纯中文 n-gram
  const candidates = items.map((item) => cjkGramsOf(item.title, 3, 6));

  // 文档频次（DF）
  const df = new Map();
  for (const set of candidates) {
    for (const gram of set) df.set(gram, (df.get(gram) ?? 0) + 1);
  }

  // 有区分度的词：至少 3 条命中（2 条命中多半是句式片段），
  // 且不超过总量的 12%（超了就说明它太泛用）
  const minDf = 3;
  const maxDf = Math.max(minDf + 2, Math.round(count * 0.12));
  const keysPerItem = candidates.map((set) => {
    const kept = [...set].filter((gram) => {
      const freq = df.get(gram) ?? 0;
      if (freq < minDf || freq > maxDf) return false;
      if (!looksLikeTopicTerm(gram)) return false;
      return !isCategoryTerm(gram);
    });
    // 同一条里，被更长候选词包含的短词丢掉（「郑钦文」在时丢掉「郑钦」）
    return kept.filter((gram) => !kept.some((other) => other !== gram && other.includes(gram)));
  });

  // 每条挑一个主词：优先文档频次高（更像话题本体），其次更长
  const buckets = new Map();
  keysPerItem.forEach((keys, index) => {
    let best = null;
    for (const gram of keys) {
      if (best === null) {
        best = gram;
        continue;
      }
      const freq = df.get(gram) ?? 0;
      const bestFreq = df.get(best) ?? 0;
      if (freq > bestFreq || (freq === bestFreq && gram.length > best.length)) best = gram;
    }
    if (best === null) return;
    if (!buckets.has(best)) buckets.set(best, []);
    buckets.get(best).push(index);
  });
  for (const [, bucket] of buckets) {
    for (let k = 1; k < bucket.length; k += 1) union(bucket[0], bucket[k]);
  }

  // 长字面重合：兜住近似重复标题
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      if (find(i) === find(j)) continue;
      if (longestCommonSubstringLength(items[i].title, items[j].title) >= 6) union(i, j);
    }
  }

  const groups = new Map();
  items.forEach((item, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(item);
  });
  return [...groups.values()];
}

/** 把一个话题簇折算成榜上一行。 */
function buildCluster(members) {
  const sorted = [...members].sort((a, b) => b.heat - a.heat);
  const primary = sorted[0];

  let aggregateHeat = 0;
  let bestRank = Number.POSITIVE_INFINITY;
  const platforms = { bili: 0, douyin: 0 };
  const subCounts = new Map();

  for (const member of members) {
    aggregateHeat += member.heat;
    if (typeof member.rank === 'number' && member.rank < bestRank) bestRank = member.rank;
    platforms[member.source] = (platforms[member.source] ?? 0) + 1;
    const sub = member.__sub ?? '其他';
    subCounts.set(sub, (subCounts.get(sub) ?? 0) + 1);
  }

  // 簇的细分标签取「成员里最多的那个细分」
  const sub = [...subCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '其他';

  return {
    topic: primary.title,
    url: primary.url,
    aggregateHeat,
    itemCount: members.length,
    platforms,
    bestRank: Number.isFinite(bestRank) ? bestRank : null,
    sub,
    // 话题名用热度最高的那条标题；多条时面板会展开列出全部细分条目
    members: sorted.slice(0, MAX_CLUSTER_MEMBERS).map((member) => ({
      title: member.title,
      source: member.source,
      kind: member.kind,
      heat: member.heat,
      rank: member.rank,
      url: member.url,
      sub: member.__sub ?? '其他',
      via: member.__via ?? '',
    })),
    hiddenMembers: Math.max(0, members.length - MAX_CLUSTER_MEMBERS),
  };
}

/** 热点榜上最多给出多少个话题簇（梗榜走流传度榜，不用这个）。 */
const MAX_CLUSTERS = 30;

// ---------------------------------------------------------------------------
// 流传度榜（梗榜）
// ---------------------------------------------------------------------------
//
// 用户要的不是「哪个梗最热」，而是「哪个梗被大量人反复用」——
// 前者是热度榜（谁的热度高谁靠前），后者是**流传度榜**。
//
// 因此这里换掉三件事：
//   1. **不吃视频条目**。视频是内容作品，不是被复用的梗；梗榜只用
//      「B站热搜词 + 抖音热榜条目」这类**短语**作为统计对象。
//   2. **统计单位从「话题簇」换成「梗词」**。一个词被多少条**不同**的榜单
//      条目用上，才是「大量人员在用」的可用代理。
//   3. **排序完全不用热度值**。流传度只由「使用条目数 / 出现天数 / 平台覆盖」三项构成。
//
// 流传度分（刻意做成可解释的整数，而不是黑箱权重）：
//     流传度分 = 使用条目数 + 2 × (出现天数 − 1) + 3 × (平台数 − 1)
//   · 使用条目数：今天有多少条不同的榜单条目用到了这个词（主要因子）
//   · 出现天数  ：跨天持续出现，才算「反复用」而不是一次性热搜
//   · 平台数    ：B站与抖音都出现，说明跨平台扩散
//
// ⚠️ 局限：拿不到「真实用户数」，所以用「不同榜单条目数」当代理。
// 一条热榜条目背后可能是成千上万人在用同一个词，这个代理偏保守但方向正确。

/**
 * 不参与流传度排名的泛用词。
 *
 * 两类：
 *   1. **句式模板**：`请查收`、`一定要` 这类复用度很高但没有梗的含义；
 *   2. **泛用名词**：`中国`、`网友`、`现场` 这类几乎任何榜单都会出现的高频词——
 *      它们的使用条目数天然很高，不加过滤会直接霸占榜首，把真正的梗挤下去。
 */
const MEME_STOPWORDS = new Set([
  // 句式模板
  '请查收', '请收好', '一定要', '你知道吗', '是什么', '怎么办', '真的会',
  '建议', '提醒', '注意', '警惕', '攻略', '指南', '盘点', '合集',
  // 泛用名词 / 地点 / 身份 / 时间
  '中国', '美国', '日本', '韩国', '俄罗斯', '英国', '法国', '德国', '印度',
  '全球', '世界', '全国', '国际', '官方', '网友', '现场', '记者', '媒体',
  '最新', '今日', '今年', '去年', '目前', '近日', '当天', '昨天', '今天',
  '视频', '直播', '报道', '新闻', '消息', '数据', '结果', '原因', '影响',
  '男子', '女子', '老人', '孩子', '学生', '家长', '市民', '居民', '员工',
  '公司', '企业', '市场', '政府', '国家', '警方', '玩家', '观众', '粉丝',
  '团队', '活动', '时间', '问题', '情况', '地方', '事情', '方式', '内容',
  '一个', '我们', '你们', '他们', '这样', '那样', '现在', '已经', '可以',
  // 平台 / 品牌名本身不是梗，只是「东西出现在哪个榜上」
  'B站', 'b站', '抖音', '微博', '快手', '小红书', '知乎', '淘宝', '微信',
  '视频号', 'bilibili', 'douyin', 'weibo', '央视频', '央视',
]);

/** 梗词长度上限：再长就不是「被复用的词」，而是重复标题了。 */
const MAX_MEME_LEN = 8;

/**
 * 判断一个「公共子串」是否够格当作梗词。
 * 依次挡掉：
 *   · 过短/过长；
 *   · 纯数字；
 *   · **混着中文却以数字收尾/开头**的片段（`定档1` 这种是 LCS 蹭到
 *     「定档」后面恰好都是 1 的偶然结果，不是词）；
 *   · 泛用词与句式模板；
 *   · 以功能字收尾 / 以人称词开头的句式片段；
 *   · **领域类别词本身**（演唱会 / 比赛 / 电影…），但**不排除梗词**
 *     —— 判定表刻意剔除了「网络流行语」那条规则，见 DOMAIN_CATEGORY_RES。
 */
function isMemeTerm(term) {
  const value = String(term ?? '').trim();
  if (value.length < 2 || value.length > MAX_MEME_LEN) return false;
  if (/^\d+$/.test(value)) return false;

  const hasCjk = /[\u4e00-\u9fa5]/.test(value);
  if (hasCjk && /^[\d]|[\d]$/.test(value)) return false;
  if (hasCjk && /\d/.test(value)) {
    // 含数字时，被数字切开的每段都得是「词」而不是单字残片：
    //   「复联5定档」→ ['复联','定档'] 两段都成词 ✓
    //   「下24分」   → ['下','分']     两段都是单字残片 ✗
    const parts = value.split(/\d+/).filter((part) => part.length > 0);
    if (parts.some((part) => part.length < 2)) return false;
  }

  if (MEME_STOPWORDS.has(value)) return false;
  if (!looksLikeTopicTerm(value)) return false;
  if (DOMAIN_CATEGORY_RES.some((re) => re.test(value))) return false;
  return true;
}

/**
 * 该梗词至少要被多少条今天的条目用到。
 * 2 字纯中文片段太容易偶然重合（`广州`、`联盟`、`B站`），所以要求更高。
 */
function minUsageFor(term) {
  return /^[\u4e00-\u9fa5]{2}$/.test(term) ? 3 : 2;
}

/** 取一份快照里的「短语条目」：B站热搜词 + 抖音热榜条目（**不含视频**）。 */
function phraseItemsOf(snapshot) {
  return [
    ...(snapshot?.sources?.bili?.keywords?.items ?? []),
    ...(snapshot?.sources?.douyin?.hot?.items ?? []),
  ];
}

/**
 * 取一份快照里参与「流传度」统计的短语条目（带细分与分组标签）。
 *
 * 注意：这里**不按梗/热点筛掉**，两组短语都收。
 * 原因是「流传度」是**短语的属性**而不是话题性质的属性：
 * 只收梗组会把复用度最高的词（例如被 6 条同时引用的「郑钦文」）直接丢掉，
 * 榜单会瘦到没意义。分组标签随行下发，面板上可以按「仅梗 / 仅热点」过滤。
 * 唯一被排除的是**视频条目** —— 视频是内容作品，不是被复用的表达。
 */
function memeEntriesOf(snapshot) {
  const out = [];
  for (const item of phraseItemsOf(snapshot)) {
    const classified = classifyItem(item);
    out.push({ item, sub: classified.sub, group: classified.group });
  }
  return out;
}

/** 流传度榜每行最多列出多少条「代表条目」。 */
const MAX_SPREAD_MEMBERS = 12;

/**
 * 构建流传度榜（梗榜）。
 *
 * 算法：
 *   1. 取每天「梗」组里的**短语**条目（B站热搜词 + 抖音热榜，**不含视频**）；
 *   2. 当天条目**两两求极大公共子串** —— 直接得到被两条同时复用的短语。
 *      用极大公共子串而不是滑窗 n-gram，是因为后者会把「全球领先上映」
 *      碎成十几个错位片段（球领先上 / 领先上映 / …）霸占整个榜单；
 *      历史各天也做同样的提取，好让「今天只出现一次但连着出现好几天」的
 *      老梗也能进榜（days ≥ 2）；
 *   3. 对每个候选梗词，回填它在**今天**的使用条目数、平台覆盖，
 *      以及跨天的出现天数；
 *   4. 过滤：必须今天还在用，且（今天被复用 ≥ minUsage 次，或跨天 ≥ 2 天）；
 *   5. 按流传度分排序。
 *
 * @param {Array<[string, object]>} daySnapshots 按日期升序的 [date, snapshot]
 * @param {number} limit 榜单条数上限
 */
export function buildMemeSpread(daySnapshots, limit = 40) {
  const dayCount = daySnapshots.length;
  if (!dayCount) {
    return { rows: [], hidden: 0, totals: { phrases: 0, memes: 0, days: 0, bili: 0, douyin: 0 }, subCategories: [] };
  }

  const entriesByDay = daySnapshots.map(([, snapshot]) => memeEntriesOf(snapshot));
  const today = entriesByDay[dayCount - 1];
  const biliPhrases = today.filter((entry) => entry.item.source !== 'douyin').length;

  // 1+2. 每天两两求极大公共子串，汇总出候选梗词
  const candidates = new Set();
  for (const entries of entriesByDay) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        for (const term of commonSubstrings(entries[i].item.title, entries[j].item.title, 2)) {
          if (isMemeTerm(term)) candidates.add(term);
        }
      }
    }
  }

  // 3+4. 回填统计量并过滤
  const rows = [];
  for (const term of candidates) {
    // 今天用到它的条目（去重）
    const usage = today.filter((entry) => entry.item.title.includes(term));
    const usageCount = usage.length;
    if (usageCount === 0) continue;

    let days = 0;
    for (const entries of entriesByDay) {
      if (entries.some((entry) => entry.item.title.includes(term))) days += 1;
    }
    if (usageCount < minUsageFor(term) && days < 2) continue;

    const platforms = new Set(usage.map((entry) => entry.item.source));
    const subCounts = new Map();
    const groupCounts = new Map();
    for (const entry of usage) {
      subCounts.set(entry.sub, (subCounts.get(entry.sub) ?? 0) + 1);
      groupCounts.set(entry.group, (groupCounts.get(entry.group) ?? 0) + 1);
    }

    const spread = usageCount + 2 * (days - 1) + 3 * (platforms.size - 1);
    const sub = [...subCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '其他梗';
    const group = [...groupCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? GROUP_MEME;
    const members = [...usage]
      .sort((a, b) => a.item.rank - b.item.rank)
      .map((entry) => ({
        title: entry.item.title,
        source: entry.item.source,
        kind: entry.item.kind,
        rank: entry.item.rank,
        heat: entry.item.heat,
        url: entry.item.url,
        sub: entry.sub,
      }));

    rows.push({
      term,
      spread,
      usageCount,
      days,
      platforms: platforms.size,
      sub,
      group,
      url: members[0]?.url ?? '',
      members: members.slice(0, MAX_SPREAD_MEMBERS),
      hiddenMembers: Math.max(0, members.length - MAX_SPREAD_MEMBERS),
    });
  }

  rows.sort((a, b) => b.spread - a.spread || b.usageCount - a.usageCount || b.term.length - a.term.length || a.term.localeCompare(b.term));

  // 细分构成
  const subMap = new Map();
  for (const row of rows) {
    const entry = subMap.get(row.sub) ?? { name: row.sub, clusters: 0, items: 0, heat: 0 };
    entry.clusters += 1;
    entry.items += row.usageCount;
    entry.heat += row.spread;
    subMap.set(row.sub, entry);
  }

  return {
    rows: rows.slice(0, limit),
    hidden: Math.max(0, rows.length - limit),
    totals: {
      phrases: today.length,
      memes: rows.length,
      days: dayCount,
      bili: biliPhrases,
      douyin: today.length - biliPhrases,
      // 按分组拆开的词条数，供面板「全部 / 仅梗 / 仅热点」过滤时显示数量
      memeTerms: rows.filter((row) => row.group === GROUP_MEME).length,
      newsTerms: rows.filter((row) => row.group === GROUP_NEWS).length,
    },
    subCategories: [...subMap.values()].sort((a, b) => b.items - a.items),
  };
}

/**
 * 分类 + 聚合 + 排行。
 * @param {Array<object>} items 全部条目
 * @returns {{ meme: object, news: object }}
 */
export function buildGroupRankings(items) {
  const classified = items.map((item) => {
    const result = classifyItem(item);
    return { ...item, __group: result.group, __sub: result.sub, __via: result.via };
  });

  const out = {};
  for (const group of [GROUP_MEME, GROUP_NEWS]) {
    const subset = classified.filter((item) => item.__group === group);
    const clusters = clusterItems(subset)
      .map(buildCluster)
      .sort((a, b) => b.aggregateHeat - a.aggregateHeat || b.itemCount - a.itemCount);

    // 细分构成：每个细分下有多少条目、多少话题、合计热度
    const subMap = new Map();
    for (const cluster of clusters) {
      const entry = subMap.get(cluster.sub) ?? { name: cluster.sub, clusters: 0, items: 0, heat: 0 };
      entry.clusters += 1;
      entry.items += cluster.itemCount;
      entry.heat += cluster.aggregateHeat;
      subMap.set(cluster.sub, entry);
    }

    out[group] = {
      label: GROUP_LABEL[group],
      totals: {
        items: subset.length,
        clusters: clusters.length,
        heat: subset.reduce((sum, item) => sum + item.heat, 0),
        bili: subset.filter((item) => item.source === 'bili').length,
        douyin: subset.filter((item) => item.source === 'douyin').length,
      },
      clusters: clusters.slice(0, MAX_CLUSTERS),
      hiddenClusters: Math.max(0, clusters.length - MAX_CLUSTERS),
      subCategories: [...subMap.values()].sort((a, b) => b.heat - a.heat),
    };
  }
  return out;
}
