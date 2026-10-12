// 客户端半边静态校验：不需要浏览器，用最小 React 桩真实执行一遍渲染路径。
//
//   node tools/client-check.mjs
//
// 它做四件事：
//   1. 跑一次真实抓取，拿到与线上完全一致的 feed 负载（客户端要吃的就是它）；
//   2. 用 window.__ModuleLoader__ 桩加载 client/client.js，校验模块导出契约；
//   3. 用假的 slots/connection 调 apply()，校验侧边栏与主面板的注册参数；
//   4. 用「按序喂 hooks 的 React 桩」把四个页签的组件树真的渲染一遍，
//      任何 undefined 访问、拼写错误、空数据崩溃都会在这里暴露。

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. 拿一份真实的 feed（直接驱动 Host 半边的 RPC handler）
// ---------------------------------------------------------------------------
const tempHome = await mkdtemp(path.join(os.tmpdir(), 'dsh-hotspot-client-'));
process.env.DSH_HOME = tempHome;

console.log('【1】准备真实 feed 负载');
const { runSlot, BILI_VIDEO_SLOT, BILI_KEYWORD_SLOT, DOUYIN_SLOT } = await import('../lib/sources.js');
const { computeStats } = await import('../lib/stats.js');
const { emptyHistory, dateKey } = await import('../lib/store.js');

const [videos, keywords, hot] = await Promise.all([
  runSlot(BILI_VIDEO_SLOT),
  runSlot(BILI_KEYWORD_SLOT),
  runSlot(DOUYIN_SLOT),
]);
const snapshot = {
  date: dateKey(),
  capturedAt: Date.now(),
  durationMs: 300,
  sources: {
    bili: {
      videos: { ok: true, stale: false, provider: videos.provider, label: videos.label, kind: videos.kind, error: null, capturedAt: Date.now(), items: videos.items.slice(0, 50) },
      keywords: { ok: true, stale: false, provider: keywords.provider, label: keywords.label, kind: keywords.kind, error: null, capturedAt: Date.now(), items: keywords.items.slice(0, 50) },
    },
    douyin: {
      hot: { ok: true, stale: false, provider: hot.provider, label: hot.label, kind: hot.kind, error: null, capturedAt: Date.now(), items: hot.items.slice(0, 50) },
    },
  },
};
const history = emptyHistory();
history.days[snapshot.date] = snapshot;
history.updatedAt = Date.now();

/** 与 Host 的 projectItem 一致：下发前剥掉封面字段。 */
const project = (item) => {
  const { cover: _cover, ...rest } = item;
  return rest;
};
const feed = {
  meta: {
    plugin: 'dsh-hotspot',
    refreshHour: 6,
    historyPath: path.join(tempHome, 'storages', 'dsh-hotspot', 'history.json'),
    historyDays: 1,
    updatedAt: history.updatedAt,
    nextRefreshAt: Date.now() + 3600_000,
    sourceDate: snapshot.date,
    isToday: true,
    ageMs: 1000,
    durationMs: 300,
    stale: false,
    refreshing: false,
    lastError: null,
    ready: true,
  },
  platforms: {
    bili: {
      videos: { ...snapshot.sources.bili.videos, count: snapshot.sources.bili.videos.items.length, attempts: [], items: snapshot.sources.bili.videos.items.map(project) },
      keywords: { ...snapshot.sources.bili.keywords, count: snapshot.sources.bili.keywords.items.length, attempts: [], items: snapshot.sources.bili.keywords.items.map(project) },
    },
    douyin: {
      hot: { ...snapshot.sources.douyin.hot, count: snapshot.sources.douyin.hot.items.length, attempts: [], items: snapshot.sources.douyin.hot.items.map(project) },
    },
  },
  stats: computeStats(history, snapshot.date),
};
check('feed 负载构建成功', feed.stats.totals.all > 0, `总数=${feed.stats.totals.all}`);
console.log(`  总数=${feed.stats.totals.all}，跨平台共现=${feed.stats.crossPlatform.length}，高频词=${feed.stats.wordFreq.length}`);

// 也需要一份「空数据」的 feed，验证各页签在无数据时不崩。
const emptyFeed = {
  ...feed,
  platforms: {
    bili: {
      videos: { ok: false, stale: false, provider: null, label: null, kind: null, error: '全部数据源失败', capturedAt: null, count: 0, attempts: [], items: [] },
      keywords: { ok: false, stale: false, provider: null, label: null, kind: null, error: '全部数据源失败', capturedAt: null, count: 0, attempts: [], items: [] },
    },
    douyin: {
      hot: { ok: false, stale: false, provider: null, label: null, kind: null, error: '全部数据源失败', capturedAt: null, count: 0, attempts: [], items: [] },
    },
  },
  stats: computeStats(emptyHistory(), dateKey()),
};

// ---------------------------------------------------------------------------
// 2. 加载客户端模块
// ---------------------------------------------------------------------------
console.log('\n【2】客户端模块契约');
const source = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');

let spec = null;
const windowStub = { __ModuleLoader__: { load: (value) => { spec = value; } } };
const documentStub = {
  head: { appendChild: () => {} },
  getElementById: () => null,
  createElement: () => ({ set textContent(_v) {}, remove: () => {} }),
};

const runClient = new Function('window', 'document', source);
runClient(windowStub, documentStub);

check('调用了 window.__ModuleLoader__.load', spec !== null);
check('模块 id 为 dsh-hotspot', spec?.id === 'dsh-hotspot', String(spec?.id));
check('factory 是函数', typeof spec?.factory === 'function');

// ---------------------------------------------------------------------------
// 3. React 桩 + 渲染器
// ---------------------------------------------------------------------------
/** 按序喂 hooks 的 React 桩：useState 从 queue 取值，保证首帧就是「有数据」状态。 */
function createReactStub(queue) {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState: (initial) => [queue.length > 0 ? queue.shift() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useCallback: (factory) => factory,
    useRef: (value) => ({ current: value }),
  };
}

/**
 * 把 createElement 树递归展开成文本，函数组件会被真实调用。
 * 同时收集宿主元素的 className —— 布局（滚动容器）是否成链只能这样验证。
 */
function renderTree(node, out, classes) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child, out, classes);
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (typeof node.type === 'function') {
    renderTree(node.type(node.props), out, classes);
    return;
  }
  if (typeof node.props?.className === 'string') classes.push(node.props.className);
  out.push(`<${node.type}>`);
  renderTree(node.props?.children, out, classes);
  out.push(`</${node.type}>`);
}

/** 渲染主面板的某个页签，返回 { text, classes }。 */
function renderTab(tab, payload) {
  // Panel 的 useState 顺序：feed / error / loading / refreshing / tab，
  // 之后子组件自己的 useState 继续从同一个队列里取。
  const queue = [payload, null, false, false, tab];
  if (tab === 'spread') queue.push('all', null); // SpreadTab 的范围 / 细分筛选
  if (tab === 'news') queue.push(null); // GroupTab 的细分筛选
  if (tab === 'raw') queue.push('bili-keywords'); // RawTab 的子榜选择
  const react = createReactStub(queue);
  const exports = spec.factory((name) => {
    if (name === 'react') return react;
    throw new Error(`unexpected require(${name})`);
  });
  const registered = [];
  const ctx = makeClientCtx(registered, react);
  exports.apply(ctx);
  const options = registered.find((entry) => entry.options.name === 'main');
  const out = [];
  const classes = [];
  renderTree(options.component({}), out, classes);
  return { text: out.join(''), classes };
}

/** 客户端 ctx 桩。 */
function makeClientCtx(registered, react) {
  return {
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject: (_key, callback) => {
        callback();
        return () => {};
      },
      register: (options, component) => {
        registered.push({ options, component });
        return () => {};
      },
    },
    connection: {
      rpc: {
        call: async () => ({ ok: true, value: null }),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 4. 校验 apply() 的注册参数
// ---------------------------------------------------------------------------
console.log('\n【3】apply() 注册契约');
const reactForApply = createReactStub([]);
const registered = [];
const clientExports = spec.factory((name) => {
  if (name === 'react') return reactForApply;
  throw new Error(`unexpected require(${name})`);
});

check('导出 name', clientExports.name === 'dsh-hotspot', String(clientExports.name));
check('导出 inject 含 slots 与 connection', Array.isArray(clientExports.inject) && clientExports.inject.includes('slots') && clientExports.inject.includes('connection'), JSON.stringify(clientExports.inject));
check('导出 apply 函数', typeof clientExports.apply === 'function');

clientExports.apply(makeClientCtx(registered, reactForApply));
const mainReg = registered.find((entry) => entry.options.name === 'main');
const sideReg = registered.find((entry) => entry.options.name === 'sidebar.panellist');

check('注册了 main 面板', mainReg !== undefined);
check('main 的 key 为 hotspot', mainReg?.options.key === 'hotspot', String(mainReg?.options.key));
check('注册了 sidebar.panellist 图标', sideReg !== undefined);
check('sidebar.panellist 的 id 与 main key 一致', sideReg?.options.id === mainReg?.options.key, `${sideReg?.options.id} vs ${mainReg?.options.key}`);
check('sidebar.panellist 提供 label', typeof sideReg?.options.label === 'function' && typeof sideReg.options.label() === 'string', String(sideReg?.options.label));

// 图标组件要能渲染
const iconOut = [];
try {
  renderTree(sideReg.component({ size: 18 }), iconOut, []);
  check('侧边栏图标可渲染', iconOut.join('').includes('<svg>'));
} catch (error) {
  check('侧边栏图标可渲染', false, error.message);
}

// ---------------------------------------------------------------------------
// 5. 五个页签 × 有数据 / 空数据 全渲染
// ---------------------------------------------------------------------------
console.log('\n【4】页签渲染（真实数据）');
const TAB_EXPECTATIONS = {
  overview: ['热点雷达', '流传榜 Top 8', '热点榜 Top 8', '跨平台共现词'],
  spread: ['流传榜', '参与统计的短语条目', '被反复复用的词', '仅梗', '仅热点', '流传度', '视频内容不参与统计'],
  news: ['细分', '条目数', '聚合后的话题数', '榜首综合热度', '按综合热度排序'],
  raw: ['原始榜', 'B站热搜', 'B站排行', '抖音热榜', '数据源'],
  stats: ['梗 / 热点构成', '流传榜 · 细分构成', '热点 · 细分构成', '来源构成', '热度分档', 'B站分区分布', '趋势', '标题高频词', '持续热梗', '与上一份快照对比'],
};

/** 每个页签应当出现「本页自己那份数据」里的真实内容，用来证明不是渲染了空壳。 */
const TAB_SAMPLES = {
  overview: () => [
    ...feed.stats.memeSpread.rows.map((row) => row.term),
    ...feed.stats.groups.news.clusters.map((c) => c.topic.slice(0, 12)),
  ],
  spread: () => feed.stats.memeSpread.rows.map((row) => row.term),
  news: () => feed.stats.groups.news.clusters.map((c) => c.topic.slice(0, 12)),
  raw: () => [
    ...feed.platforms.bili.keywords.items.map((item) => item.title.slice(0, 12)),
    ...feed.platforms.douyin.hot.items.map((item) => item.title.slice(0, 12)),
  ],
  stats: () => [
    ...feed.stats.memeSpread.subCategories.map((entry) => entry.name),
    ...feed.stats.groups.news.subCategories.map((entry) => entry.name),
    ...feed.stats.wordFreq.map((entry) => entry.word),
  ],
};

for (const [tab, needles] of Object.entries(TAB_EXPECTATIONS)) {
  let text = '';
  let classes = [];
  try {
    const rendered = renderTab(tab, feed);
    text = rendered.text;
    classes = rendered.classes;
    check(`${tab} 页签渲染成功（${text.length} 字符）`, true);
  } catch (error) {
    check(`${tab} 页签渲染成功`, false, `${error.message}\n${error.stack?.split('\n')[1] ?? ''}`);
    continue;
  }
  for (const needle of needles) {
    check(`${tab} 包含「${needle}」`, text.includes(needle));
  }
  const samples = TAB_SAMPLES[tab]();
  check(
    `${tab} 渲染出了本页的真实条目`,
    samples.some((sample) => text.includes(sample)),
    samples.length ? `候选示例：${samples.slice(0, 3).join(' / ')}` : '（无候选）',
  );
  // 布局回归：必须有「固定头 + 滚动区」这两层，否则内容会被父容器裁掉、无法滚动
  check(`${tab} 具备滚动容器结构`, classes.some((c) => c.includes('dh-scroll')) && classes.some((c) => c.includes('dh-scrollinner')));
}

console.log('\n【5】页签渲染（空数据，不应崩溃）');
for (const tab of Object.keys(TAB_EXPECTATIONS)) {
  try {
    const { text, classes } = renderTab(tab, emptyFeed);
    check(`${tab} 空数据渲染成功（${text.length} 字符）`, text.length > 0);
    check(`${tab} 空数据仍保留滚动结构`, classes.some((c) => c.includes('dh-scroll')));
  } catch (error) {
    check(`${tab} 空数据渲染成功`, false, error.message);
  }
}

await rm(tempHome, { recursive: true, force: true });
console.log(failures === 0 ? '\n✅ 客户端校验全部通过' : `\n❌ 客户端校验失败：${failures} 项`);
process.exitCode = failures === 0 ? 0 : 1;
