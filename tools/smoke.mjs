// 端到端冒烟测试：不依赖 DSH 运行时，用最小 ctx 桩跑通 Host 半边的真实代码路径。
//
//   node tools/smoke.mjs            # 写入临时 DSH_HOME（默认，可重复运行）
//   node tools/smoke.mjs --real     # 写入真实数据目录，给插件预热一份缓存
//
// 覆盖：
//   1. 插件激活 + RPC 路由注册；
//   2. 真实抓取三个数据槽位（B站排行榜 / B站热搜 / 抖音热榜）；
//   3. 快照合并与落盘；
//   4. 统计计算；
//   5. 用真实 fetch 走一遍线上协议（信封、端点匹配、信任栅栏、响应编码）。

import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const useReal = process.argv.includes('--real');
const tempHome = useReal ? null : await mkdtemp(path.join(os.tmpdir(), 'dsh-hotspot-smoke-'));
if (tempHome) process.env.DSH_HOME = tempHome;

const { apply, name, inject } = await import('../lib/index.js');
const { historyPath, readHistory } = await import('../lib/store.js');

const CHANNEL = '/dsh-hotspot';
let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log(`插件名: ${name}   inject: ${JSON.stringify(inject)}`);
console.log(`DSH_HOME: ${process.env.DSH_HOME}`);
console.log(`history:  ${historyPath()}\n`);

// --- 最小 Cordis ctx 桩（严格模拟 inject 语义）-------------------------------
//
// 真实 Cordis 的 Context 是一个 Proxy：读取一个「没有 inject 的服务」会直接抛
//     cannot get property "<name>" without inject
// 更隐蔽的是 mixin 出来的访问器（如 timer 服务的 ctx.timeout）：异常抛在**读取**
// 阶段，`typeof ctx.timeout === 'function'` 这种防御性判断根本挡不住。
//
// 早期的桩把 timeout 当普通函数挂在 ctx 上，于是本地测试全绿、装进 DSH 却启动失败。
// 这里按真实语义重建：只有 inject 列表里的服务可读，其余一律抛错。
const routes = [];
const effects = [];
let forcedRejection;

const webServerService = {
  register: (route) => {
    routes.push(route);
    return () => {
      const index = routes.indexOf(route);
      if (index >= 0) routes.splice(index, 1);
    };
  },
};
const connectionService = { requestRejection: () => forcedRejection };
const timerService = {
  timeout: (callback, delay) => {
    const handle = setTimeout(callback, delay);
    return () => clearTimeout(handle);
  },
};

/** 可被 inject 的服务表。 */
const SERVICES = { webServer: webServerService, connection: connectionService, timer: timerService };

/** 由服务 mixin 到 ctx 上的名字 → 它背后真正需要的服务名。 */
const MIXIN_SOURCES = { timeout: 'timer', interval: 'timer', throttle: 'timer', debounce: 'timer' };

const injected = new Set(inject);

/** Context 自身的成员：任何插件都能读，不经过 inject 检查。 */
const coreProps = {
  logger: () => ({
    info: () => {},
    warn: (...args) => console.warn('[warn]', ...args),
    error: (...args) => console.error('[error]', ...args),
  }),
  effect: (callback) => {
    const dispose = callback();
    effects.push(dispose);
    return () => {};
  },
  get: (serviceName) => (injected.has(serviceName) ? SERVICES[serviceName] : undefined),
};

const fakeCtx = new Proxy(coreProps, {
  get(target, prop) {
    if (typeof prop === 'symbol' || Object.hasOwn(target, prop)) return Reflect.get(target, prop);
    const required = MIXIN_SOURCES[prop] ?? prop;
    if (!SERVICES[required]) throw new Error(`cannot get property "${prop}" without inject`);
    if (!injected.has(required)) throw new Error(`cannot get property "${required}" without inject`);
    return SERVICES[required];
  },
});

// --- 0. 先证明桩本身够严格（防止将来又被改宽而放走同类 bug）------------------
console.log('【0】测试桩严格性');
let strictRejection = '';
try {
  void fakeCtx.timeout;
} catch (error) {
  strictRejection = error.message;
}
check(
  '未 inject timer 时读取 ctx.timeout 会被拒绝（正是 DSH 的行为）',
  strictRejection === 'cannot get property "timer" without inject',
  strictRejection || '（竟然读到了，桩太宽松）',
);
check('插件 inject 未声明 timer（因此绝不能用 ctx.timeout）', !inject.includes('timer'), JSON.stringify(inject));

// --- 1. 激活 ----------------------------------------------------------------
console.log('\n【1】插件激活与路由注册');
apply(fakeCtx);
check('注册了 1 条 RPC 路由', routes.length === 1, `实际 ${routes.length}`);
check('路由为 prefix 且路径正确', routes[0]?.kind === 'prefix' && routes[0]?.path === CHANNEL, JSON.stringify(routes[0] && { kind: routes[0].kind, path: routes[0].path }));

// --- 起一个真实 HTTP 服务，把注册的路由接上去 --------------------------------
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const route = routes.find((entry) => (entry.kind === 'prefix' ? pathname.startsWith(entry.path) : pathname === entry.path));
  if (!route) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no route');
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    try {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(error));
    } catch {
      /* 响应可能已发出 */
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/** 走线上协议调一次 RPC。 */
async function rpc(endpoint, payload, { method, contentType = 'application/json', rpcId = 'test-1' } = {}) {
  const response = await fetch(`${base}${CHANNEL}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify({ rpcId, method: method ?? endpoint, payload }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// --- 2. 线上协议：错误分支 ---------------------------------------------------
console.log('\n【2】线上协议错误分支');
const badType = await rpc('feed', {}, { contentType: 'text/plain' });
check('content-type 非 JSON → 415', badType.status === 415, `实际 ${badType.status}`);

const mismatch = await rpc('feed', {}, { method: 'status' });
check('method 与 endpoint 不符 → gateway/bad-request', mismatch.body?.result?.error?.code === 'gateway/bad-request', JSON.stringify(mismatch.body?.result?.error));

const unknown = await rpc('nope', {});
check('未知 endpoint → bad-request', unknown.body?.result?.ok === false && unknown.body?.result?.error?.code === 'bad-request', JSON.stringify(unknown.body?.result?.error));

const notFound = await fetch(`${base}/other/feed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check('非本通道路径 → 404', notFound.status === 404, `实际 ${notFound.status}`);

forcedRejection = 401;
const rejected = await fetch(`${base}${CHANNEL}/feed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"rpcId":"x","method":"feed"}' });
check('信任栅栏拒绝 → 401', rejected.status === 401, `实际 ${rejected.status}`);
forcedRejection = undefined;

// --- 3. 真实抓取 ------------------------------------------------------------
console.log('\n【3】真实抓取（三个数据槽位）');
const started = Date.now();
const refreshed = await rpc('refresh', {}, { rpcId: 'refresh-1' });
const elapsed = Date.now() - started;
check('refresh 返回 ok', refreshed.body?.result?.ok === true, JSON.stringify(refreshed.body?.result?.error));
console.log(`  抓取耗时 ${elapsed}ms`);

const feed = refreshed.body?.result?.value;
if (!feed) {
  console.error('\n无法继续：refresh 未返回 value');
  await new Promise((resolve) => server.close(resolve));
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
  process.exit(1);
}

const { meta, platforms, stats } = feed;
for (const [source, slots] of Object.entries(platforms)) {
  for (const [slot, record] of Object.entries(slots)) {
    check(
      `${source}.${slot} 抓取成功（${record.count} 条，来源 ${record.provider}）`,
      record.ok && record.count > 0,
      record.error ?? '',
    );
    if (record.attempts?.length) {
      console.log(`      尝试: ${record.attempts.map((a) => `${a.id}${a.ok ? '✓' : `✗(${a.error})`}`).join('  ')}`);
    }
    for (const item of record.items.slice(0, 2)) {
      console.log(`      #${item.rank} ${item.title.slice(0, 36)}  热度=${item.heat}`);
    }
  }
}

// --- 4. 元信息与统计 --------------------------------------------------------
console.log('\n【4】元信息与统计');
check('isToday 为真', meta.isToday === true);
check('stale 为假', meta.stale === false, `stale=${meta.stale} lastError=${meta.lastError}`);
check('下次刷新落在 06:00', new Date(meta.nextRefreshAt).getHours() === 6, new Date(meta.nextRefreshAt).toLocaleString('zh-CN'));
check('统计总数为正', stats.totals.all > 0);
check('来源分布非空', stats.bySource.length > 0);
check('热度 Top 非空', stats.heatTop.length > 0);
check('趋势含当天', stats.trend.length >= 1);
console.log(`  总数=${stats.totals.all} (B站视频 ${stats.totals.biliVideo} / B站热搜 ${stats.totals.biliKeyword} / 抖音 ${stats.totals.douyinHot})`);
console.log(`  热度分档: ${stats.heatBands.map((b) => `${b.name}=${b.count}`).join(', ')}`);
console.log(`  分类 Top5: ${stats.byCategory.slice(0, 5).map((c) => `${c.name}=${c.count}`).join(', ') || '（无）'}`);
console.log(`  跨平台共现: ${stats.crossPlatform.slice(0, 8).map((c) => c.term).join(', ') || '（无）'}`);
console.log(`  高频词 Top8: ${stats.wordFreq.slice(0, 8).map((w) => `${w.word}×${w.count}`).join(', ') || '（无）'}`);

// --- 5. 落盘 ----------------------------------------------------------------
console.log('\n【5】落盘校验');
const history = await readHistory();
const days = Object.keys(history.days);
check('history.json 中存在快照', days.length > 0, `天数=${days.length}`);
check('快照结构与统计一致', history.days[days.at(-1)]?.sources?.douyin?.hot?.items?.length > 0);
console.log(`  天数=${days.length} 日期=${days.join(', ')}`);
console.log(`  updatedAt=${history.updatedAt ? new Date(history.updatedAt).toLocaleString('zh-CN') : 'null'}`);

// --- 6. feed 幂等（不触发抓取） ---------------------------------------------
console.log('\n【6】feed 只读缓存');
const before = Date.now();
const feedAgain = await rpc('feed', {});
check('feed 返回 ok', feedAgain.body?.result?.ok === true);
check('feed 明显快于抓取（读缓存）', Date.now() - before < elapsed, `${Date.now() - before}ms vs ${elapsed}ms`);
check('feed 与 refresh 数据一致', feedAgain.body?.result?.value?.stats?.totals?.all === stats.totals.all);

// --- 7. 分类与话题聚合 -------------------------------------------------------
console.log('\n【7】分类与话题聚合');
const { classifyItem, clusterItems, GROUP_MEME, GROUP_NEWS } = await import('../lib/classify.js');

// 分类：B站官方分区优先
check('B站「搞笑」分区 → 梗', classifyItem({ kind: 'video', category: '搞笑', title: '《司机の噩梦》' }).group === GROUP_MEME);
check('B站「社会」分区 → 热点', classifyItem({ kind: 'video', category: '社会', title: '某某事件后续' }).group === GROUP_NEWS);
check('「我国物流业…」→ 热点（「我国」不算第一人称）', classifyItem({ source: 'douyin', title: '我国物流业景气水平进一步提升' }).group === GROUP_NEWS);
check('含死伤数字 → 热点', classifyItem({ source: 'douyin', title: '某地发生事故致3死5伤' }).group === GROUP_NEWS);
check('旅行攻略 → 梗（生活方式）', classifyItem({ source: 'douyin', title: '汕头爽吃攻略请查收' }).group === GROUP_MEME);

// 聚合：共享实体 → 同一个话题簇
const sameTopic = clusterItems([
  { title: '武网官方回应郑钦文退赛' },
  { title: '郑钦文因伤退出武汉网球公开赛' },
  { title: '郑钦文首夺中网女单冠军' },
]);
check('共享实体「郑钦文」聚成 1 个话题', sameTopic.length === 1, `实际 ${sameTopic.length}`);

// 聚合回归：只共享 2 字城市名或句式片段时不能聚合
// （早期版本因为 2 字 gram + 传递闭包，把这些全粘成一坨）
const unrelated = clusterItems([
  { title: '广州把健身房搬进地铁了' },
  { title: '宋雨琦广州演唱会绿光舞台直拍' },
  { title: '汕头爽吃攻略请查收' },
  { title: '北京秋景拍摄宝藏机位请查收' },
  { title: '新人第1次编曲耶' },
  { title: '当北方人第一次闻桂花香' },
]);
check('只共享「广州」「请查收」「人第」时不应聚合', unrelated.length === 6, `实际 ${unrelated.length}`);

// 聚合：近似重复标题 → 同簇
const nearDup = clusterItems([{ title: '复联5定档1216全球领先上映' }, { title: '复联5定档全球领先上映' }]);
check('近似重复标题聚成 1 个话题', nearDup.length === 1, `实际 ${nearDup.length}`);

// 实时数据上的排行不变量
const memeGroup = stats.groups.meme;
const newsGroup = stats.groups.news;
check(
  '梗 + 热点 的条目数之和 = 全部条目数',
  memeGroup.totals.items + newsGroup.totals.items === stats.totals.all,
  `${memeGroup.totals.items}+${newsGroup.totals.items} vs ${stats.totals.all}`,
);
check('两组都非空', memeGroup.totals.items > 0 && newsGroup.totals.items > 0, `梗 ${memeGroup.totals.items} / 热点 ${newsGroup.totals.items}`);
check('话题按综合热度降序', memeGroup.clusters.every((c, i, all) => i === 0 || all[i - 1].aggregateHeat >= c.aggregateHeat));
const multi = [...memeGroup.clusters, ...newsGroup.clusters].filter((c) => c.itemCount > 1);
check('存在跨条目聚合的话题', multi.length > 0, `多条目话题 ${multi.length} 个`);
check('多条目话题的综合热度 = 成员热度之和', multi.every((c) => Math.abs(c.members.reduce((s, m) => s + m.heat, 0) - c.aggregateHeat) < 1));
console.log(`  梗 ${memeGroup.totals.items} 条→${memeGroup.totals.clusters} 话题；热点 ${newsGroup.totals.items} 条→${newsGroup.totals.clusters} 话题；多条目话题 ${multi.length} 个`);
for (const cluster of [...multi].sort((a, b) => b.itemCount - a.itemCount).slice(0, 3)) {
  console.log(`  · [${cluster.sub}] ${cluster.topic.slice(0, 28)} — ${cluster.itemCount} 条，综合热度 ${cluster.aggregateHeat}`);
}

// --- 8. 流传度榜（梗榜） -----------------------------------------------------
console.log('\n【8】流传度榜（梗榜）');
const { buildMemeSpread } = await import('../lib/classify.js');

const phrase = (id, source, title, rank, heat) => ({
  id, source, kind: source === 'douyin' ? 'hot' : 'keyword', rank, heat, title, url: `https://example.test/${id}`,
});
const video = (id, title, rank, heat) => ({
  id, source: 'bili', kind: 'video', rank, heat, title, url: `https://example.test/${id}`, category: '搞笑',
});
const snap = (keywords, videos, hot) => ({
  sources: { bili: { keywords: { items: keywords }, videos: { items: videos } }, douyin: { hot: { items: hot } } },
});

// 第 1 天：某梗被两条不同条目用到；第 2 天（今天）只剩一条，但还有一条「视频」也在用 ——
// 视频必须被排除，而跨天持续仍应让它进榜
const spread = buildMemeSpread([
  ['2026-01-01', snap([phrase('k1', 'bili', '打工人第一次出现', 5, 100)], [], [phrase('d1', 'douyin', '今天聊打工人', 9, 200)])],
  ['2026-01-02', snap([], [video('v1', '打工人相关的搞笑视频', 3, 999)], [phrase('d2', 'douyin', '打工人又来了', 7, 300)])],
]);
const row = spread.rows.find((entry) => entry.term === '打工人');
check('跨天持续、今天只被 1 条使用的梗仍能进榜', row !== undefined, JSON.stringify(spread.rows.map((r) => r.term)));
check('days 正确统计为 2', row?.days === 2, String(row?.days));
check('usageCount 只数今天的短语条目', row?.usageCount === 1, String(row?.usageCount));
check('视频条目不参与梗榜统计', (row?.members ?? []).every((m) => m.kind !== 'video'), JSON.stringify((row?.members ?? []).map((m) => m.kind)));
check(
  '流传度分 = 使用条目数 + 2×(天数−1) + 3×(平台数−1)',
  row ? row.spread === row.usageCount + 2 * (row.days - 1) + 3 * (row.platforms - 1) : false,
);

// 只被用过一次、且没跨天 -> 不进榜
const single = buildMemeSpread([['2026-01-02', snap([phrase('k9', 'bili', '孤零零的热搜词', 1, 10)], [], [])]]);
check('只用过一次且没跨天的词不进榜', single.rows.length === 0, JSON.stringify(single.rows.map((r) => r.term)));

// 噪音过滤：数字碎片 + 2 字偶然重合 + 领域类别词
const junk = buildMemeSpread([
  [
    '2026-01-02',
    snap(
      [],
      [],
      [
        phrase('j1', 'douyin', '笑死定档1216', 1, 10),
        phrase('j2', 'douyin', '笑死定档10月', 2, 10),
        phrase('j3', 'douyin', '广州把健身房搬进地铁了', 3, 10),
        phrase('j4', 'douyin', '宋雨琦广州演唱会绿光舞台直拍', 4, 10),
      ],
    ),
  ],
]);
check('数字碎片「定档1」被过滤', !junk.rows.some((r) => /[\u4e00-\u9fa5]/.test(r.term) && /\d$/.test(r.term)), JSON.stringify(junk.rows.map((r) => r.term)));
check('2 字偶然重合「广州」被过滤', !junk.rows.some((r) => r.term === '广州'), JSON.stringify(junk.rows.map((r) => r.term)));
check('领域类别词「演唱会」不被当成梗', !junk.rows.some((r) => r.term === '演唱会'), JSON.stringify(junk.rows.map((r) => r.term)));

// 实时数据上的不变量
const spreadLive = stats.memeSpread;
check('实时流传度榜已生成', spreadLive !== undefined);
check('流传度榜不含视频条目', spreadLive.rows.every((r) => r.members.every((m) => m.kind !== 'video')));
check('流传度榜按流传度分降序', spreadLive.rows.every((r, i, all) => i === 0 || all[i - 1].spread >= r.spread));
check('每个上榜梗词都被 ≥2 条今日条目使用', spreadLive.rows.every((r) => r.usageCount >= 2), JSON.stringify(spreadLive.rows.filter((r) => r.usageCount < 2).map((r) => `${r.term}:${r.usageCount}`)));
console.log(`  参与统计的梗组短语 ${spreadLive.totals.phrases} 条 → 识别出 ${spreadLive.totals.memes} 个被复用的梗词`);
for (const r of spreadLive.rows.slice(0, 6)) {
  console.log(`  · 【${r.term}】流传度 ${r.spread}（${r.usageCount} 条 / ${r.days} 天 / ${r.platforms} 平台）— ${r.sub}`);
}

// --- 收尾 -------------------------------------------------------------------
await new Promise((resolve) => server.close(resolve));
for (const dispose of effects) {
  if (typeof dispose === 'function') {
    try {
      await dispose();
    } catch {
      /* 忽略释放期错误 */
    }
  }
}
check('路由随 effect 释放', routes.length === 0, `剩余 ${routes.length}`);

if (tempHome) await rm(tempHome, { recursive: true, force: true });

console.log(failures === 0 ? '\n✅ 冒烟测试全部通过' : `\n❌ 冒烟测试失败：${failures} 项`);
process.exitCode = failures === 0 ? 0 : 1;
