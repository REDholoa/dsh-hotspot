// dsh-hotspot · Host 半边
//
// 职责：
//   1. 抓取 B站 / 抖音 热点（sources.js），合并成「当日快照」并落盘（store.js）；
//   2. 每天 06:00（本地时间）自动刷新一次；启动时若发现当日快照缺失或过期，立刻补一次；
//   3. 通过 Connection RPC 通道 /dsh-hotspot 把数据交给 Web 客户端，并在 Host 侧算好统计（stats.js）。
//
// 关于 RPC 注册方式（关键实现细节）：
//   不能用 ctx.connection.rpc.handle()：它内部取到的是 Connection 服务自己的 context
//   （inject 只有 'credentials'），会抛 "cannot get property \"webServer\" without inject"。
//   因此由本插件自己 inject 'webServer'，用 rpc-channel.js 复刻同一套线上协议挂一条
//   prefix 路由 —— 客户端仍然走 ctx.connection.rpc.call()，两端协议不变。
//
// 关于失败降级：
//   单个数据槽位失败时，保留上一次成功抓到的该槽位数据并标记 stale，
//   而不是把整份快照作废 —— 部分新鲜好过整体空白。

import { installRpcChannel } from './rpc-channel.js';
import { computeStats } from './stats.js';
import {
  BILI_KEYWORD_SLOT,
  BILI_VIDEO_SLOT,
  DOUYIN_SLOT,
  runSlot,
} from './sources.js';
import {
  dateKey,
  emptyHistory,
  historyPath,
  isSnapshotStale,
  nextDailyAt,
  pruneDays,
  readHistory,
  writeHistory,
} from './store.js';

/** 插件名 / 客户端模块 id / RPC 通道 —— 三者必须与 package.json 的 name 一致。 */
const NAME = 'dsh-hotspot';
const CHANNEL = '/dsh-hotspot';

/** 每日刷新时刻（本地时间，0-23）。用户需求：每天 6 点更新一次。 */
const REFRESH_HOUR = 6;

/** 每个槽位最多下发给客户端多少条。B站排行榜有 100 条，面板只需要头部。 */
const MAX_ITEMS_PER_SLOT = 50;

/** 槽位定义：一个槽位 = 一个「数据槽」+ 一组按优先级排列的数据源。 */
const SLOTS = [
  { source: 'bili', slot: 'videos', providers: BILI_VIDEO_SLOT },
  { source: 'bili', slot: 'keywords', providers: BILI_KEYWORD_SLOT },
  { source: 'douyin', slot: 'hot', providers: DOUYIN_SLOT },
];

/** RPC 失败信封（形状与 dsh-pocket 对齐，符合 DSH 的 rpcErrorSchema）。 */
function fail(code, message) {
  if (code === 'cancelled') return { ok: false, error: { code: 'cancelled', message, details: {} } };
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [{ message }] } } };
}

function ok(value) {
  return { ok: true, value };
}

/**
 * 注册一个定时器，返回取消函数。
 *
 * 刻意**不使用** DSH 的 timer 服务（`ctx.timeout`）：它是 `ctx.mixin('timer', …)`
 * 暴露出来的访问器，读取该属性本身就会去解析 `ctx.timer`，在未 inject 'timer' 时
 * 直接抛 `cannot get property "timer" without inject` —— `typeof` 判断挡不住，
 * 因为异常抛在**读取**阶段而不是调用阶段。
 *
 * 本插件同一时刻只挂一个「每日一次」的定时器，用原生 setTimeout 并在 bootstrap
 * effect 的清理函数里取消即可：少一个依赖，也少一类启动失败。
 */
function makeTimer() {
  return function setTimer(delayMs, callback) {
    const handle = setTimeout(callback, delayMs);
    return () => clearTimeout(handle);
  };
}

/** 下发给客户端时剥掉封面等大字段：用户选择的是文字热榜 + 统计面板。 */
function projectItem(item) {
  return {
    id: item.id,
    source: item.source,
    kind: item.kind,
    rank: item.rank,
    title: item.title,
    url: item.url,
    heat: item.heat,
    author: item.author,
    category: item.category,
    publishedAt: item.publishedAt,
    metrics: item.metrics,
  };
}

/** 把一个槽位的抓取结果整理成快照里的一格。 */
function slotRecord(result, capturedAt) {
  return {
    ok: true,
    stale: false,
    provider: result.provider,
    label: result.label,
    kind: result.kind,
    error: null,
    capturedAt,
    attempts: result.attempts,
    items: result.items.slice(0, MAX_ITEMS_PER_SLOT),
  };
}

/** 抓取失败时保留旧数据的那一格。 */
function slotFailure(previous, error, capturedAt) {
  const carried = previous?.items?.length ? previous.items : [];
  return {
    ok: false,
    stale: carried.length > 0,
    provider: previous?.provider ?? null,
    label: previous?.label ?? null,
    kind: previous?.kind ?? null,
    error: error?.message ?? String(error),
    capturedAt: previous?.capturedAt ?? null,
    lastAttemptAt: capturedAt,
    attempts: [],
    items: carried,
  };
}

export const name = NAME;
export const inject = ['webServer', 'connection'];

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  const setTimer = makeTimer();
  const log = ctx.logger?.('dsh-hotspot') ?? console;

  /** 运行期状态（history 是唯一的持久化真相）。 */
  const state = {
    history: emptyHistory(),
    ready: false,
    loading: null,
    refreshing: null,
    lastError: null,
    armTimer: null,
  };

  /**
   * 载入磁盘历史，只做一次。
   *
   * 这里刻意「原地合并」而不是 `state.history = await readHistory()`：
   * 启动时的读盘与启动补刷新是并发的，若整体替换 state.history，
   * 刷新刚写进旧对象的快照会被随后 resolve 的读盘结果覆盖掉（空数据落盘）。
   * 保持对象引用稳定 + 让 refresh() 先 await 本 Promise，就能彻底消除这个竞态。
   */
  function loadHistory() {
    if (!state.loading) {
      state.loading = (async () => {
        const loaded = await readHistory();
        state.history.version = loaded.version;
        state.history.updatedAt = loaded.updatedAt;
        state.history.nextRefreshAt = loaded.nextRefreshAt;
        state.history.lastError = loaded.lastError;
        state.history.days = loaded.days;
        state.ready = true;
        return state.history;
      })();
    }
    return state.loading;
  }

  /** 当天快照里各数据槽的容器（不存在则创建）。 */
  function ensureSnapshot(date, capturedAt) {
    const days = state.history.days;
    if (!days[date]) {
      days[date] = { date, capturedAt, durationMs: 0, sources: {} };
    }
    const snapshot = days[date];
    if (!snapshot.sources) snapshot.sources = {};
    for (const slot of SLOTS) {
      if (!snapshot.sources[slot.source]) snapshot.sources[slot.source] = {};
    }
    snapshot.capturedAt = capturedAt;
    return snapshot;
  }

  /** 执行一次完整刷新；并发调用共享同一个 Promise。 */
  function refresh(reason = 'manual') {
    if (state.refreshing) return state.refreshing;
    state.refreshing = (async () => {
      // 必须先等在途的读盘结束，否则下面的快照会写进一个即将被丢弃的对象。
      await loadHistory();
      const startedAt = Date.now();
      const date = dateKey(startedAt);
      const snapshot = ensureSnapshot(date, startedAt);

      const settled = await Promise.all(
        SLOTS.map(async ({ source, slot, providers }) => {
          try {
            const result = await runSlot(providers);
            return { source, slot, record: slotRecord(result, Date.now()) };
          } catch (error) {
            return { source, slot, record: slotFailure(snapshot.sources?.[source]?.[slot], error, Date.now()) };
          }
        }),
      );

      const failures = [];
      for (const { source, slot, record } of settled) {
        snapshot.sources[source][slot] = record;
        if (!record.ok) failures.push(`${source}.${slot}: ${record.error}`);
      }

      snapshot.durationMs = Date.now() - startedAt;
      snapshot.capturedAt = startedAt;
      snapshot.reason = reason;
      snapshot.refreshCount = (snapshot.refreshCount ?? 0) + 1;

      state.history.updatedAt = Date.now();
      state.history.nextRefreshAt = nextDailyAt(REFRESH_HOUR);
      state.history.lastError = failures.length ? failures.join(' | ') : null;
      state.lastError = state.history.lastError;
      pruneDays(state.history);

      try {
        await writeHistory(state.history);
      } catch (error) {
        log.error?.('写入历史失败：%s', error?.message ?? error);
      }

      if (failures.length) log.warn?.('部分数据源失败：%s', state.history.lastError);
      return snapshot;
    })().finally(() => {
      state.refreshing = null;
    });
    return state.refreshing;
  }

  /** 取「当前应当展示」的快照日期：优先今天，否则最近有数据的一天。 */
  function currentDate() {
    const today = dateKey();
    if (state.history.days[today]) return today;
    const dates = Object.keys(state.history.days).sort();
    return dates.length ? dates[dates.length - 1] : today;
  }

  /** 组装下发给客户端的完整负载。 */
  function buildFeed() {
    const now = Date.now();
    const date = currentDate();
    const snapshot = state.history.days[date] ?? { date, capturedAt: null, sources: {} };
    const platforms = {};
    for (const { source, slot } of SLOTS) {
      if (!platforms[source]) platforms[source] = {};
      const record = snapshot.sources?.[source]?.[slot];
      platforms[source][slot] = record
        ? {
            ok: record.ok,
            stale: record.stale === true,
            provider: record.provider,
            label: record.label,
            kind: record.kind,
            error: record.error,
            capturedAt: record.capturedAt,
            count: record.items?.length ?? 0,
            // 每个候选数据源的尝试结果：页面上出错时可直接看出是谁挂了。
            attempts: record.attempts ?? [],
            items: (record.items ?? []).map(projectItem),
          }
        : { ok: false, stale: false, provider: null, label: null, error: '尚未抓取', capturedAt: null, count: 0, attempts: [], items: [] };
    }

    return {
      meta: {
        plugin: NAME,
        refreshHour: REFRESH_HOUR,
        historyPath: historyPath(),
        historyDays: Object.keys(state.history.days).length,
        updatedAt: state.history.updatedAt,
        nextRefreshAt: state.history.nextRefreshAt ?? nextDailyAt(REFRESH_HOUR),
        sourceDate: date,
        isToday: date === dateKey(now),
        ageMs: snapshot.capturedAt ? now - snapshot.capturedAt : null,
        durationMs: snapshot.durationMs ?? null,
        stale: date !== dateKey(now) || SLOTS.some(({ source, slot }) => snapshot.sources?.[source]?.[slot]?.stale === true),
        refreshing: state.refreshing !== null,
        lastError: state.history.lastError,
        ready: state.ready,
      },
      platforms,
      stats: computeStats(state.history, date, now),
    };
  }

  // ---------------------------------------------------------------------
  // 定时刷新：每天 REFRESH_HOUR 点跑一次，跑完立刻排下一天。
  // ---------------------------------------------------------------------
  function armDaily() {
    if (typeof state.armTimer === 'function') {
      try {
        state.armTimer();
      } catch {
        /* 已经触发过的定时器重复释放是安全的 */
      }
    }
    // +5s 余量：万一定时器提前一点点触发，也不会把「下一个 6 点」算成今天而空转。
    const next = nextDailyAt(REFRESH_HOUR, Date.now() + 5000);
    state.history.nextRefreshAt = next;
    state.armTimer = setTimer(Math.max(1000, next - Date.now()), async () => {
      try {
        await refresh('scheduled');
      } catch (error) {
        log.error?.('定时刷新失败：%s', error?.message ?? error);
      } finally {
        armDaily();
      }
    });
  }

  // ---------------------------------------------------------------------
  // RPC：客户端通过 ctx.connection.rpc.call('/dsh-hotspot', endpoint, payload) 调用。
  // ---------------------------------------------------------------------
  const handler = async (endpoint, payload, signal) => {
    if (signal?.aborted) return fail('cancelled', '请求已取消');
    try {
      switch (endpoint) {
        case 'feed':
          return ok(buildFeed());
        case 'status':
          return ok({ meta: buildFeed().meta, historyPath: historyPath() });
        case 'refresh': {
          await refresh('manual');
          return ok(buildFeed());
        }
        default:
          return fail('bad-request', `未知 endpoint：${endpoint}`);
      }
    } catch (error) {
      log.error?.('RPC %s 失败：%s', endpoint, error?.message ?? error);
      return fail('bad-request', error?.message ?? String(error));
    }
  };

  // 注册 RPC 通道（路由随本插件 fiber 释放）。
  installRpcChannel(ctx, CHANNEL, handler, log);

  // ---------------------------------------------------------------------
  // 启动流程：先读盘（立刻可服务），再按需补一次抓取，最后排每日定时。
  // ---------------------------------------------------------------------
  ctx.effect(() => {
    let disposed = false;
    (async () => {
      await loadHistory();
      if (disposed) return;
      if (isSnapshotStale(state.history, REFRESH_HOUR)) {
        refresh('startup').catch((error) => log.error?.('启动刷新失败：%s', error?.message ?? error));
      }
    })().catch((error) => {
      state.ready = true;
      log.error?.('读取历史失败：%s', error?.message ?? error);
    });
    // 排定定时器失败不应该让整个插件激活失败：面板与手动刷新才是核心功能，
    // 定时只是「自动」那一层。这里兜住异常，让插件仍可用。
    try {
      armDaily();
    } catch (error) {
      log.error?.('排定每日刷新失败（插件仍可手动刷新）：%s', error?.message ?? error);
    }
    return () => {
      disposed = true;
      if (typeof state.armTimer === 'function') {
        try {
          state.armTimer();
        } catch {
          /* 释放失败不影响卸载 */
        }
      }
    };
  }, `${NAME}: bootstrap`);
}
