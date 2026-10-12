/**
 * dsh-hotspot · Web 客户端半边（纯 JavaScript，无需构建）
 *
 * 手写 DSH 的客户端模块包装格式，而不是像其它插件那样用 esbuild 打包：
 *   window.__ModuleLoader__.load({ id, factory }) —— factory 拿到 require()，
 *   react 由 DSH 客户端模块系统提供（不是全局变量）。
 * 因此本文件里没有 JSX，全部用 React.createElement；改完保存即热重载。
 *
 * 页面形态：侧边栏一个「热点」图标 → 打开独立主面板，五个页签：
 *   概览 / 梗榜 / 热点榜 / 原始榜 / 统计。
 *
 * 布局要点（曾经踩过的坑）：外层必须是 flex 纵向 + overflow:hidden，
 * 真正的滚动容器是中间那一层（flex:1 + min-height:0 + overflow-y:auto）。
 * 只给外层写 padding 而不建滚动层，内容会被父容器裁掉、页面无法滚动。
 */

window.__ModuleLoader__.load({
  id: 'dsh-hotspot',
  factory: (require) => {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useState } = React;
    const h = React.createElement;

    /** RPC 通道与侧边栏面板 id —— 通道必须与 Host 半边一致。 */
    const CHANNEL = '/dsh-hotspot';
    const PANEL_ID = 'hotspot';
    const PLUGIN_NAME = 'dsh-hotspot';

    /** 面板打开时的轮询间隔：只是拉取 Host 已缓存的数据，开销极小。 */
    const POLL_MS = 5 * 60 * 1000;

    const COLOR_BILI = '#fb7299';
    const COLOR_DOUYIN = '#22d3ee';
    const COLOR_MEME = '#8b5cf6';
    const COLOR_NEWS = '#f59e0b';
    const COLOR_ACCENT = 'var(--dsw-alias-brand-primary, #4f6ef7)';

    /** 条目类型的中文名。 */
    const KIND_LABEL = { video: '视频', keyword: '热搜', hot: '热榜' };

    // -----------------------------------------------------------------------
    // 样式：跟随 DSH 主题变量，明暗模式自动适配
    // -----------------------------------------------------------------------
    const CSS = `
.dh-root { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column;
  overflow: hidden; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); }
.dh-headwrap { flex: none; box-sizing: border-box; width: 100%; max-width: 1120px; margin: 0 auto; padding: 18px 24px 0; }
.dh-tabwrap { flex: none; box-sizing: border-box; width: 100%; max-width: 1120px; margin: 0 auto; padding: 0 24px; }
.dh-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; }
.dh-scrollinner { box-sizing: border-box; width: 100%; max-width: 1120px; margin: 0 auto; padding: 16px 24px 56px; }
.dh-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dh-title { font-size: 18px; font-weight: 600; letter-spacing: .2px; display: flex; align-items: center; gap: 8px; }
.dh-sub { margin-top: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dh-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; background: var(--dsw-alias-state-success-primary, #16a34a); }
.dh-dot.warn { background: var(--dsw-alias-state-warn-primary, #d97706); }
.dh-dot.bad { background: var(--dsw-alias-state-error-primary, #dc2626); }
.dh-btn { font: inherit; font-size: 12px; height: 30px; padding: 0 14px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, inherit); display: inline-flex; align-items: center; gap: 6px; }
.dh-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.dh-btn:disabled { opacity: .55; cursor: default; }
.dh-btn.primary { border-color: transparent; background: var(--dsw-alias-brand-primary, #4f6ef7); color: #fff; }
.dh-tabs { display: flex; gap: 2px; margin: 18px 0 0; border-bottom: 1px solid var(--dsw-alias-border-l1, #eceff3);
  overflow-x: auto; scrollbar-width: none; }
.dh-tabs::-webkit-scrollbar { display: none; }
.dh-tab { font: inherit; font-size: 13px; padding: 7px 14px; cursor: pointer; border: none; background: none; white-space: nowrap;
  color: var(--dsw-alias-label-secondary, #6b7280); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.dh-tab:hover { color: var(--dsw-alias-label-primary, inherit); }
.dh-tab.on { color: var(--dsw-alias-brand-primary, #4f6ef7); border-bottom-color: var(--dsw-alias-brand-primary, #4f6ef7); font-weight: 500; }
.dh-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); }
.dh-grid.wide { grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); }
.dh-col { display: grid; gap: 12px; }
.dh-card { border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); border-radius: 12px; padding: 14px 16px;
  background: var(--dsw-alias-bg-layer-1, #fff); min-width: 0; }
.dh-card > h3 { font-size: 13px; font-weight: 600; margin: 0 0 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.dh-card > h3 small { font-weight: 400; font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); }
.dh-stats { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.dh-stat { border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); border-radius: 12px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1, #fff); }
.dh-stat b { display: block; font-size: 22px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }
.dh-stat span { font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); }
.dh-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; min-width: 0; }
.dh-rank { flex: none; width: 20px; text-align: right; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, #9ca3af); }
.dh-rank.top { color: var(--dsw-alias-brand-primary, #4f6ef7); font-weight: 600; }
.dh-caret { flex: none; width: 11px; font-size: 9px; color: var(--dsw-alias-label-tertiary, #9ca3af); }
.dh-link { flex: 1 1 auto; min-width: 0; color: inherit; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dh-link:hover { color: var(--dsw-alias-brand-primary, #4f6ef7); }
.dh-heat { flex: none; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #6b7280); }
.dh-term { flex: 0 1 auto; min-width: 0; max-width: 42%; font-weight: 600; font-size: 13.5px; letter-spacing: .2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dh-tag { flex: none; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 5px; white-space: nowrap;
  background: var(--dsw-alias-bg-layer-2, #f3f4f6); color: var(--dsw-alias-label-secondary, #6b7280); }
.dh-tag.bili { background: rgba(251,114,153,.14); color: #e0507e; }
.dh-tag.douyin { background: rgba(34,211,238,.16); color: #0891b2; }
.dh-tag.meme { background: rgba(139,92,246,.14); color: #7c3aed; }
.dh-tag.news { background: rgba(245,158,11,.16); color: #b45309; }
.dh-tag.hot { background: rgba(220,38,38,.12); color: #dc2626; }
.dh-tag.new { background: rgba(217,119,6,.14); color: #d97706; }
.dh-bar { height: 5px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, #f3f4f6); overflow: hidden; margin-top: 3px; }
.dh-bar > i { display: block; height: 100%; border-radius: 3px; }
.dh-item { padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, #f1f3f6); }
.dh-item:last-child { border-bottom: none; }
.dh-click { cursor: pointer; }
.dh-click:hover .dh-link { color: var(--dsw-alias-brand-primary, #4f6ef7); }
.dh-members { margin: 4px 0 6px 19px; padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l1, #eceff3); }
.dh-member { display: flex; align-items: center; gap: 8px; padding: 3px 0; min-width: 0; }
.dh-member .dh-link { color: var(--dsw-alias-label-secondary, #6b7280); }
.dh-member .dh-link:hover { color: var(--dsw-alias-brand-primary, #4f6ef7); }
.dh-member-tag { flex: none; font-size: 10px; color: var(--dsw-alias-label-tertiary, #9ca3af); }
.dh-more { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); padding: 3px 0 3px 19px; }
.dh-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary, #9ca3af); }
.dh-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dh-chip { font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-bg-layer-2, #f3f4f6); border: 1px solid var(--dsw-alias-border-l1, #eceff3); color: inherit; }
.dh-chip:hover { border-color: var(--dsw-alias-border-l2, #e5e7eb); }
.dh-chip.on { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f6ef7) 14%, transparent);
  border-color: var(--dsw-alias-brand-primary, #4f6ef7); color: var(--dsw-alias-brand-primary, #4f6ef7); font-weight: 500; }
.dh-chip small { color: var(--dsw-alias-label-tertiary, #9ca3af); margin-left: 5px; font-size: 10px; }
.dh-chip.on small { color: inherit; opacity: .75; }
.dh-legend { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dh-legend-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.dh-swatch { width: 9px; height: 9px; border-radius: 2px; flex: none; }
.dh-legend-row .n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #6b7280); }
.dh-legend-row .v { font-variant-numeric: tabular-nums; }
.dh-donut-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.dh-seg { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, #e5e7eb); border-radius: 999px; padding: 2px; background: var(--dsw-alias-bg-layer-2, #f3f4f6); }
.dh-seg button { font: inherit; font-size: 12px; border: none; background: none; cursor: pointer; padding: 3px 12px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary, #6b7280); white-space: nowrap; }
.dh-seg button.on { background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-primary, inherit); font-weight: 500; }
.dh-warn { margin-top: 12px; border: 1px solid var(--dsw-alias-state-warn-primary, #d97706); border-radius: 10px;
  padding: 9px 12px; font-size: 12px; color: var(--dsw-alias-state-warn-primary, #d97706); word-break: break-all; }
.dh-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9ca3af); margin-top: 8px; line-height: 1.7; }
.dh-split { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
@media (max-width: 620px) { .dh-split { grid-template-columns: 1fr; } }
`;

    /**
     * 注入样式表。
     * 注意：即使已存在同 id 的元素也要重写 textContent —— 客户端插件热重载时
     * 「已存在就直接 return」会导致 CSS 改动永远不生效（JS 换了、样式还是旧的）。
     */
    function installStyles() {
      let element = document.getElementById('dsh-hotspot-style');
      if (!element) {
        element = document.createElement('style');
        element.id = 'dsh-hotspot-style';
        document.head.appendChild(element);
      }
      element.textContent = CSS;
      return () => {
        try {
          element.remove();
        } catch {
          /* 忽略 */
        }
      };
    }

    // -----------------------------------------------------------------------
    // 格式化
    // -----------------------------------------------------------------------
    function formatHeat(value) {
      const n = Number(value) || 0;
      if (n >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 1 : 2)}亿`;
      if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)}万`;
      return String(Math.round(n));
    }

    function formatAge(ms) {
      if (ms == null) return '尚未更新';
      if (ms < 60000) return '刚刚更新';
      if (ms < 3600000) return `${Math.floor(ms / 60000)} 分钟前更新`;
      if (ms < 86400000) return `${Math.floor(ms / 3600000)} 小时前更新`;
      return `${Math.floor(ms / 86400000)} 天前更新`;
    }

    function formatClock(timestamp) {
      if (!timestamp) return '—';
      const date = new Date(timestamp);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    /** 空的分组骨架，用于 Host 还没升级时的降级展示。 */
    function emptyGroup(label) {
      return {
        label,
        totals: { items: 0, clusters: 0, heat: 0, bili: 0, douyin: 0 },
        clusters: [],
        hiddenClusters: 0,
        subCategories: [],
      };
    }

    /** 空的流传榜骨架。 */
    function emptySpread() {
      return {
        rows: [],
        hidden: 0,
        totals: { phrases: 0, memes: 0, days: 0, bili: 0, douyin: 0, memeTerms: 0, newsTerms: 0 },
        subCategories: [],
      };
    }

    /**
     * 归一化 feed，补齐缺失字段。
     *
     * 为什么需要：客户端半边是**热重载**的（改完立刻生效），Host 半边却必须重启宿主进程。
     * 所以「新版客户端 + 旧版 Host」这个中间状态是真实存在的。
     * 这时如果直接读 stats.groups.meme 会抛错、整页白屏；
     * 归一化之后降级成空分组，并在页面上明确提示需要重启 Host。
     */
    function normalizeFeed(raw) {
      if (!raw || typeof raw !== 'object') return raw;
      const stats = raw.stats ?? {};
      const groups = stats.groups ?? {};
      const groupingMissing = !stats.groups;
      return {
        ...raw,
        __groupingMissing: groupingMissing,
        platforms: raw.platforms ?? {},
        stats: {
          ...stats,
          windowDays: stats.windowDays ?? 14,
          totals: stats.totals ?? { all: 0, bili: 0, douyin: 0, biliVideo: 0, biliKeyword: 0, douyinHot: 0, heat: 0 },
          groups: {
            meme: groups.meme ?? emptyGroup('梗'),
            news: groups.news ?? emptyGroup('热点'),
          },
          memeSpread: stats.memeSpread ?? emptySpread(),
          byGroup: stats.byGroup ?? [],
          bySource: stats.bySource ?? [],
          heatBands: stats.heatBands ?? [],
          byCategory: stats.byCategory ?? [],
          heatTop: stats.heatTop ?? [],
          wordFreq: stats.wordFreq ?? [],
          persistentKeywords: stats.persistentKeywords ?? [],
          crossPlatform: stats.crossPlatform ?? [],
          trend: stats.trend ?? [],
          diff: stats.diff ?? { baseDate: null, newEntries: [], droppedEntries: [], stayed: 0 },
        },
      };
    }

    // -----------------------------------------------------------------------
    // 基础展示组件
    // -----------------------------------------------------------------------
    function Empty({ text = '暂无数据' }) {
      return h('div', { className: 'dh-empty' }, text);
    }

    /** 侧边栏图标：一根上升的折线 + 箭头。 */
    function HotspotIcon({ size = 18 }) {
      const s = typeof size === 'number' ? size : 18;
      return h(
        'svg',
        { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 17.5 9 11l4 4 8-8.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M15.5 6.5H21v5.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    /** 来源标签。 */
    function SourceTag({ source, count }) {
      return h(
        'span',
        { className: `dh-tag ${source === 'douyin' ? 'douyin' : 'bili'}` },
        `${source === 'douyin' ? '抖音' : 'B站'}${count > 1 ? count : ''}`,
      );
    }

    /**
     * 榜单一行：一个「话题」，可能由多条不同平台的条目聚合而成。
     * 点开可以看到这条综合热度由哪几条构成（即细分条目）。
     */
    function ClusterRow({ cluster, rank, maxHeat, color }) {
      const [open, setOpen] = useState(false);
      const ratio = maxHeat > 0 ? Math.max(0.03, Math.min(1, cluster.aggregateHeat / maxHeat)) : 0;
      const expandable = cluster.itemCount > 1;

      const toggle = () => {
        if (expandable) setOpen((value) => !value);
      };

      return h(
        'div',
        { className: 'dh-item' },
        h(
          'div',
          {
            className: `dh-row${expandable ? ' dh-click' : ''}`,
            onClick: expandable ? toggle : undefined,
            onKeyDown: expandable
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggle();
                  }
                }
              : undefined,
            role: expandable ? 'button' : undefined,
            tabIndex: expandable ? 0 : undefined,
            title: expandable ? '点击展开：这条综合热度由哪些条目构成' : undefined,
          },
          h('span', { className: `dh-rank${rank <= 3 ? ' top' : ''}` }, rank),
          h('span', { className: 'dh-caret' }, expandable ? (open ? '▼' : '▶') : ''),
          h(
            'a',
            {
              className: 'dh-link',
              href: cluster.url,
              target: '_blank',
              rel: 'noreferrer',
              title: cluster.topic,
              onClick: (event) => event.stopPropagation(),
            },
            cluster.topic,
          ),
          cluster.sub ? h('span', { className: 'dh-tag' }, cluster.sub) : null,
          h(SourceTag, { source: 'bili', count: cluster.platforms.bili }),
          h(SourceTag, { source: 'douyin', count: cluster.platforms.douyin }),
          h('span', { className: 'dh-heat' }, `${cluster.itemCount} 条 · ${formatHeat(cluster.aggregateHeat)}`),
        ),
        h('div', { className: 'dh-bar' }, h('i', { style: { width: `${ratio * 100}%`, background: color } })),
        open
          ? h(
              'div',
              { className: 'dh-members' },
              cluster.members.map((member, index) =>
                h(
                  'div',
                  { key: `${member.title}-${index}`, className: 'dh-member' },
                  h(SourceTag, { source: member.source }),
                  h('span', { className: 'dh-member-tag' }, KIND_LABEL[member.kind] ?? member.kind),
                  h('a', { className: 'dh-link', href: member.url, target: '_blank', rel: 'noreferrer', title: member.title }, member.title),
                  h('span', { className: 'dh-heat' }, `#${member.rank} · ${formatHeat(member.heat)}`),
                ),
              ),
              cluster.hiddenMembers > 0 ? h('div', { className: 'dh-more' }, `还有 ${cluster.hiddenMembers} 条未展示`) : null,
            )
          : null,
      );
    }

    /** 一个分组（梗 / 热点）的排行榜卡片。 */
    function GroupBoard({ group, color, filter = null }) {
      const clusters = filter ? group.clusters.filter((cluster) => cluster.sub === filter) : group.clusters;
      const maxHeat = clusters.reduce((max, cluster) => Math.max(max, cluster.aggregateHeat), 0);
      return h(
        'div',
        { className: 'dh-card' },
        h(
          'h3',
          null,
          h('span', null, `${group.label}榜${filter ? ` · ${filter}` : ''}`),
          h('small', null, `${clusters.length} 个话题 · 按综合热度排序`),
        ),
        clusters.length
          ? clusters.map((cluster, index) => h(ClusterRow, { key: `${cluster.topic}-${index}`, cluster, rank: index + 1, maxHeat, color }))
          : h(Empty, { text: filter ? '该细分下暂无数据' : '暂无数据' }),
        group.hiddenClusters > 0 && !filter ? h('div', { className: 'dh-more' }, `另有 ${group.hiddenClusters} 个话题未展示`) : null,
      );
    }

    /** 横向条形榜（来源 / 分档 / 分区 / 高频词 / 细分构成）。 */
    function BarCard({ title, note, entries, color, unit = '', limit = 12 }) {
      const shown = entries.slice(0, limit);
      const max = shown.reduce((m, e) => Math.max(m, e.value), 0) || 1;
      return h(
        'div',
        { className: 'dh-card' },
        h('h3', null, h('span', null, title), note ? h('small', null, note) : null),
        shown.length
          ? shown.map((entry, index) =>
              h(
                'div',
                { key: `${entry.label}-${index}`, className: 'dh-item' },
                h(
                  'div',
                  { className: 'dh-row' },
                  h('span', { className: 'dh-link', title: entry.label }, entry.label),
                  entry.sub ? h('span', { className: 'dh-tag' }, entry.sub) : null,
                  h('span', { className: 'dh-heat' }, `${formatHeat(entry.value)}${unit}`),
                ),
                h('div', { className: 'dh-bar' }, h('i', { style: { width: `${(entry.value / max) * 100}%`, background: color } })),
              ),
            )
          : h(Empty),
      );
    }

    /** 环形图（纯 SVG）。 */
    function Donut({ entries, size = 132, thickness = 16 }) {
      const total = entries.reduce((sum, entry) => sum + entry.count, 0);
      if (!total) return h(Empty);
      const radius = (size - thickness) / 2;
      const center = size / 2;
      const circumference = 2 * Math.PI * radius;
      let offset = 0;
      const arcs = entries.map((entry) => {
        const dash = (entry.count / total) * circumference;
        const arc = { ...entry, dash, offset };
        offset += dash;
        return arc;
      });
      return h(
        'svg',
        { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img' },
        h('circle', { cx: center, cy: center, r: radius, fill: 'none', stroke: 'var(--dsw-alias-bg-layer-2, #f3f4f6)', strokeWidth: thickness }),
        arcs.map((arc) =>
          h('circle', {
            key: arc.name,
            cx: center,
            cy: center,
            r: radius,
            fill: 'none',
            stroke: arc.color,
            strokeWidth: thickness,
            strokeDasharray: `${arc.dash} ${circumference - arc.dash}`,
            strokeDashoffset: -arc.offset,
            transform: `rotate(-90 ${center} ${center})`,
          }),
        ),
        h('text', { x: center, y: center - 2, textAnchor: 'middle', fontSize: 20, fontWeight: 600, fill: 'var(--dsw-alias-label-primary, currentColor)' }, String(total)),
        h('text', { x: center, y: center + 15, textAnchor: 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-tertiary, #9ca3af)' }, '条'),
      );
    }

    /** 多序列折线图（纯 SVG，viewBox 自适应宽度）。 */
    function LineChart({ labels, series, height = 150 }) {
      const width = 620;
      const padLeft = 34;
      const padRight = 10;
      const padTop = 10;
      const padBottom = 22;
      const innerWidth = width - padLeft - padRight;
      const innerHeight = height - padTop - padBottom;
      const max = Math.max(1, ...series.flatMap((s) => s.values));
      const count = labels.length;
      const xOf = (index) => (count <= 1 ? padLeft + innerWidth / 2 : padLeft + (index * innerWidth) / (count - 1));
      const yOf = (value) => padTop + innerHeight - (value / max) * innerHeight;

      const gridLines = [0, 0.5, 1].map((ratio) =>
        h('line', {
          key: `grid-${ratio}`,
          x1: padLeft,
          x2: width - padRight,
          y1: padTop + innerHeight * (1 - ratio),
          y2: padTop + innerHeight * (1 - ratio),
          stroke: 'var(--dsw-alias-border-l1, #eceff3)',
          strokeWidth: 1,
        }),
      );
      const yLabels = [0, 0.5, 1].map((ratio) =>
        h(
          'text',
          { key: `ylabel-${ratio}`, x: padLeft - 6, y: padTop + innerHeight * (1 - ratio) + 3, textAnchor: 'end', fontSize: 9, fill: 'var(--dsw-alias-label-tertiary, #9ca3af)' },
          String(Math.round(max * ratio)),
        ),
      );
      const tickIndexes = count <= 1 ? [0] : [0, Math.floor((count - 1) / 2), count - 1];
      const xLabels = [...new Set(tickIndexes)].map((index) =>
        h(
          'text',
          {
            key: `xlabel-${index}`,
            x: xOf(index),
            y: height - 6,
            textAnchor: index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle',
            fontSize: 9,
            fill: 'var(--dsw-alias-label-tertiary, #9ca3af)',
          },
          labels[index]?.slice(5) ?? '',
        ),
      );

      return h(
        'svg',
        { viewBox: `0 0 ${width} ${height}`, style: { width: '100%', height: 'auto', display: 'block' }, role: 'img' },
        gridLines,
        yLabels,
        series.map((s) =>
          h('polyline', {
            key: `line-${s.name}`,
            fill: 'none',
            stroke: s.color,
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            points: s.values.map((value, index) => `${xOf(index)},${yOf(value)}`).join(' '),
          }),
        ),
        series.map((s) =>
          s.values.map((value, index) => h('circle', { key: `dot-${s.name}-${index}`, cx: xOf(index), cy: yOf(value), r: 2.4, fill: s.color })),
        ),
        xLabels,
      );
    }

    /** 图例。 */
    function Legend({ entries }) {
      const total = entries.reduce((sum, entry) => sum + entry.count, 0) || 1;
      return h(
        'div',
        { className: 'dh-legend' },
        entries.map((entry) =>
          h(
            'div',
            { key: entry.name, className: 'dh-legend-row' },
            h('span', { className: 'dh-swatch', style: { background: entry.color } }),
            h('span', { className: 'n' }, entry.name),
            h('span', { className: 'v' }, `${entry.count}（${Math.round((entry.count / total) * 100)}%）`),
          ),
        ),
      );
    }

    /** 细分筛选条：点一个细分只看该类，再点取消。 */
    function SubChips({ group, active, onPick }) {
      if (!group.subCategories.length) return null;
      return h(
        'div',
        { className: 'dh-chips' },
        h(
          'button',
          { type: 'button', className: `dh-chip${active === null ? ' on' : ''}`, onClick: () => onPick(null) },
          '全部',
          h('small', null, group.totals.items),
        ),
        group.subCategories.map((entry) =>
          h(
            'button',
            {
              key: entry.name,
              type: 'button',
              className: `dh-chip${active === entry.name ? ' on' : ''}`,
              onClick: () => onPick(active === entry.name ? null : entry.name),
              title: `${entry.clusters} 个话题 / ${entry.items} 条 / 合计热度 ${formatHeat(entry.heat)}`,
            },
            entry.name,
            h('small', null, entry.items),
          ),
        ),
      );
    }

    /**
     * 流传榜一行：一个被反复复用的**词**。
     * 排序依据是流传度分（复用条目数 / 出现天数 / 平台覆盖），**与热度无关**。
     */
    function SpreadRow({ row, rank, maxSpread, color }) {
      const [open, setOpen] = useState(false);
      const ratio = maxSpread > 0 ? Math.max(0.04, Math.min(1, row.spread / maxSpread)) : 0;
      const expandable = row.members.length > 0;

      const toggle = () => {
        if (expandable) setOpen((value) => !value);
      };

      return h(
        'div',
        { className: 'dh-item' },
        h(
          'div',
          {
            className: `dh-row${expandable ? ' dh-click' : ''}`,
            onClick: expandable ? toggle : undefined,
            onKeyDown: expandable
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggle();
                  }
                }
              : undefined,
            role: expandable ? 'button' : undefined,
            tabIndex: expandable ? 0 : undefined,
            title: expandable ? '点击展开：这个词被哪些条目用到' : undefined,
          },
          h('span', { className: `dh-rank${rank <= 3 ? ' top' : ''}` }, rank),
          h('span', { className: 'dh-caret' }, expandable ? (open ? '▼' : '▶') : ''),
          h('span', { className: 'dh-term', title: row.term }, row.term),
          row.sub ? h('span', { className: 'dh-tag' }, row.sub) : null,
          row.group === 'news' ? h('span', { className: 'dh-tag news' }, '热点') : h('span', { className: 'dh-tag meme' }, '梗'),
          h(SourceTag, { source: 'bili', count: row.members.filter((m) => m.source !== 'douyin').length }),
          h(SourceTag, { source: 'douyin', count: row.members.filter((m) => m.source === 'douyin').length }),
          h('span', { className: 'dh-heat' }, `${row.usageCount} 条 · 流传度 ${row.spread}`),
        ),
        h('div', { className: 'dh-bar' }, h('i', { style: { width: `${ratio * 100}%`, background: color } })),
        h(
          'div',
          { className: 'dh-hint', style: { marginTop: 2, fontSize: 10 } },
          `${row.usageCount} 条用到 · 出现 ${row.days} 天 · 覆盖 ${row.platforms} 个平台`,
        ),
        open
          ? h(
              'div',
              { className: 'dh-members' },
              row.members.map((member, index) =>
                h(
                  'div',
                  { key: `${member.title}-${index}`, className: 'dh-member' },
                  h(SourceTag, { source: member.source }),
                  h('span', { className: 'dh-member-tag' }, KIND_LABEL[member.kind] ?? member.kind),
                  h('a', { className: 'dh-link', href: member.url, target: '_blank', rel: 'noreferrer', title: member.title }, member.title),
                  h('span', { className: 'dh-heat' }, `#${member.rank}`),
                ),
              ),
              row.hiddenMembers > 0 ? h('div', { className: 'dh-more' }, `还有 ${row.hiddenMembers} 条未展示`) : null,
            )
          : null,
      );
    }

    /**
     * 流传榜页签：按「被多少人反复用」排名，而不是按热度。
     * 只统计**热搜词/热榜条目**这类短语，视频内容不参与。
     */
    function SpreadTab({ feed }) {
      const [scope, setScope] = useState('all');
      const [sub, setSub] = useState(null);
      const spread = feed.stats.memeSpread;

      const inScope = spread.rows.filter((row) => scope === 'all' || row.group === scope);
      const rows = sub ? inScope.filter((row) => row.sub === sub) : inScope;
      const maxSpread = rows.reduce((max, row) => Math.max(max, row.spread), 0);

      // 细分构成按当前范围重算，避免数字对不上
      const subMap = new Map();
      for (const row of inScope) {
        const entry = subMap.get(row.sub) ?? { name: row.sub, count: 0 };
        entry.count += 1;
        subMap.set(row.sub, entry);
      }
      const subs = [...subMap.values()].sort((a, b) => b.count - a.count);

      const scopes = [
        { id: 'all', label: `全部 ${spread.totals.memes}` },
        { id: 'meme', label: `仅梗 ${spread.totals.memeTerms}` },
        { id: 'news', label: `仅热点 ${spread.totals.newsTerms}` },
      ];

      return h(
        'div',
        { className: 'dh-col' },
        h(
          'div',
          { className: 'dh-stats' },
          h('div', { className: 'dh-stat' }, h('b', null, String(spread.totals.phrases)), h('span', null, '参与统计的短语条目')),
          h('div', { className: 'dh-stat' }, h('b', null, String(spread.totals.memes)), h('span', null, `被反复复用的词 · 统计 ${spread.totals.days} 天`)),
          h('div', { className: 'dh-stat' }, h('b', { style: { color: COLOR_MEME } }, String(spread.totals.memeTerms)), h('span', null, `其中梗类词 · 热点类 ${spread.totals.newsTerms}`)),
          h('div', { className: 'dh-stat' }, h('b', null, formatHeat(spread.rows[0]?.spread ?? 0)), h('span', null, '榜首流传度分')),
        ),
        h(
          'div',
          { className: 'dh-card' },
          h(
            'h3',
            null,
            h('span', null, '流传榜'),
            h(
              'div',
              { className: 'dh-seg' },
              scopes.map((entry) =>
                h('button', { key: entry.id, type: 'button', className: scope === entry.id ? 'on' : '', onClick: () => { setScope(entry.id); setSub(null); } }, entry.label),
              ),
            ),
          ),
          h(SubChips, {
            group: { totals: { items: inScope.length }, subCategories: subs.map((entry) => ({ name: entry.name, items: entry.count, clusters: entry.count, heat: 0 })) },
            active: sub,
            onPick: setSub,
          }),
          rows.length
            ? rows.map((row, index) => h(SpreadRow, { key: row.term, row, rank: index + 1, maxSpread, color: scope === 'news' ? COLOR_NEWS : COLOR_MEME }))
            : h(Empty, { text: '当前范围内还没有被反复复用的词' }),
          spread.hidden > 0 && !sub ? h('div', { className: 'dh-more' }, `另有 ${spread.hidden} 个词未展示`) : null,
        ),
        h(
          'div',
          { className: 'dh-hint' },
          '这个榜不看热度，只看**被反复使用**的程度：一个词被越多条不同的热搜词/热榜条目用上、',
          '跨天出现得越多、覆盖的平台越多，排名越前。',
          '视频内容不参与统计（视频是作品，不是被复用的表达）；只出现过一次且没跨天的词也不会进榜。',
          `统计范围：B站热搜 ${spread.totals.bili} 条 + 抖音热榜 ${spread.totals.douyin} 条。`,
          spread.totals.days <= 1 ? ' 目前只有 1 天快照，等 06:00 累积几天后「出现天数」这一项才会开始起作用。' : '',
        ),
      );
    }

    // -----------------------------------------------------------------------
    // 各页签内容
    // -----------------------------------------------------------------------
    function OverviewTab({ feed, onOpenTab }) {
      const { stats } = feed;
      const meme = stats.groups.meme;
      const news = stats.groups.news;
      const spread = stats.memeSpread;
      const crossPlatform = stats.crossPlatform ?? [];
      const newEntries = stats.diff.newEntries ?? [];

      return h(
        'div',
        { className: 'dh-col' },
        h(
          'div',
          { className: 'dh-stats' },
          h('div', { className: 'dh-stat' }, h('b', { style: { color: COLOR_MEME } }, String(spread.totals.memes)), h('span', null, `流传榜词条 · 参与统计 ${spread.totals.phrases} 条短语`)),
          h('div', { className: 'dh-stat' }, h('b', { style: { color: COLOR_NEWS } }, String(news.totals.clusters)), h('span', null, `热点话题 · ${news.totals.items} 条条目`)),
          h('div', { className: 'dh-stat' }, h('b', { style: { color: COLOR_MEME } }, String(meme.totals.items)), h('span', null, `梗类短语条目 · 热点类 ${news.totals.items}`)),
          h('div', { className: 'dh-stat' }, h('b', null, String(crossPlatform.length)), h('span', null, '跨平台共现词')),
        ),
        h(
          'div',
          { className: 'dh-grid wide' },
          h(
            'div',
            { className: 'dh-card' },
            h(
              'h3',
              null,
              h('span', null, '流传榜 Top 8'),
              h('button', { type: 'button', className: 'dh-btn', onClick: () => onOpenTab('spread') }, '查看全部'),
            ),
            spread.rows.length
              ? spread.rows
                  .slice(0, 8)
                  .map((row, index) =>
                    h(SpreadRow, { key: row.term, row, rank: index + 1, maxSpread: spread.rows[0]?.spread ?? 0, color: COLOR_MEME }),
                  )
              : h(Empty),
          ),
          h(
            'div',
            { className: 'dh-card' },
            h(
              'h3',
              null,
              h('span', null, '热点榜 Top 8'),
              h('button', { type: 'button', className: 'dh-btn', onClick: () => onOpenTab('news') }, '查看全部'),
            ),
            news.clusters.length
              ? news.clusters
                  .slice(0, 8)
                  .map((cluster, index) =>
                    h(ClusterRow, { key: `${cluster.topic}-${index}`, cluster, rank: index + 1, maxHeat: news.clusters[0]?.aggregateHeat ?? 0, color: COLOR_NEWS }),
                  )
              : h(Empty),
          ),
        ),
        h(
          'div',
          { className: 'dh-card' },
          h('h3', null, h('span', null, '跨平台共现词'), h('small', null, 'B站与抖音同时出现，通常意味着已经破圈')),
          crossPlatform.length
            ? h(
                'div',
                { className: 'dh-chips' },
                crossPlatform.map((entry) =>
                  h(
                    'span',
                    { key: entry.term, className: 'dh-chip', title: `B站：${entry.biliSample}\n抖音：${entry.douyinSample}` },
                    entry.term,
                    h('small', null, `B${entry.biliCount}/抖${entry.douyinCount}`),
                  ),
                ),
              )
            : h(Empty, { text: '今天两个平台没有明显重叠的话题' }),
        ),
        newEntries.length
          ? h(
              'div',
              { className: 'dh-card' },
              h('h3', null, h('span', null, '今日新上榜'), h('small', null, stats.diff.baseDate ? `对比 ${stats.diff.baseDate}` : '首次采集')),
              h(
                'div',
                { className: 'dh-split' },
                newEntries.slice(0, 10).map((item, index) =>
                  h(
                    'div',
                    { key: `${item.title}-${index}`, className: 'dh-row' },
                    h(SourceTag, { source: item.source }),
                    h('span', { className: 'dh-member-tag' }, KIND_LABEL[item.kind] ?? item.kind),
                    h('a', { className: 'dh-link', href: item.url, target: '_blank', rel: 'noreferrer', title: item.title }, item.title),
                    h('span', { className: 'dh-heat' }, formatHeat(item.heat)),
                  ),
                ),
              ),
            )
          : null,
      );
    }

    /** 梗榜 / 热点榜页签。 */
    function GroupTab({ feed, groupKey }) {
      const [filter, setFilter] = useState(null);
      const group = feed.stats.groups[groupKey];
      const color = groupKey === 'meme' ? COLOR_MEME : COLOR_NEWS;

      return h(
        'div',
        { className: 'dh-col' },
        h(
          'div',
          { className: 'dh-stats' },
          h('div', { className: 'dh-stat' }, h('b', null, String(group.totals.items)), h('span', null, '条目数')),
          h('div', { className: 'dh-stat' }, h('b', null, String(group.totals.clusters)), h('span', null, '聚合后的话题数')),
          h('div', { className: 'dh-stat' }, h('b', { style: { color: COLOR_BILI } }, String(group.totals.bili)), h('span', null, `B站条目 · 抖音 ${group.totals.douyin}`)),
          h('div', { className: 'dh-stat' }, h('b', null, formatHeat(group.clusters[0]?.aggregateHeat ?? 0)), h('span', null, '榜首综合热度')),
        ),
        h(
          'div',
          { className: 'dh-card' },
          h('h3', null, h('span', null, '细分'), h('small', null, '点击筛选；数字为该细分的条目数')),
          h(SubChips, { group, active: filter, onPick: setFilter }),
        ),
        h(GroupBoard, { group, color, filter }),
        h(
          'div',
          { className: 'dh-hint' },
          '「综合热度」= 同一话题下所有条目热度之和。B站热度是播放量、抖音是热度值，量纲不同，求和只是并排叠加；',
          '点任意一行可展开，看到这条热度由哪几条构成。',
        ),
      );
    }

    /** 原始榜：不做聚合，按平台原样展示。 */
    function RawTab({ feed }) {
      const [view, setView] = useState('bili-keywords');
      const biliKeywords = feed.platforms.bili?.keywords;
      const biliVideos = feed.platforms.bili?.videos;
      const douyin = feed.platforms.douyin?.hot;

      const record = view === 'bili-keywords' ? biliKeywords : view === 'bili-videos' ? biliVideos : douyin;
      const items = record?.items ?? [];
      const maxHeat = items.reduce((max, item) => Math.max(max, item.heat), 0);

      return h(
        'div',
        { className: 'dh-col' },
        record?.error && !record.count ? h('div', { className: 'dh-warn' }, `数据源全部失败：${record.error}`) : null,
        h(
          'div',
          { className: 'dh-card' },
          h(
            'h3',
            null,
            h('span', null, '原始榜'),
            h(
              'div',
              { className: 'dh-seg' },
              h('button', { type: 'button', className: view === 'bili-keywords' ? 'on' : '', onClick: () => setView('bili-keywords') }, `B站热搜 ${biliKeywords?.count ?? 0}`),
              h('button', { type: 'button', className: view === 'bili-videos' ? 'on' : '', onClick: () => setView('bili-videos') }, `B站排行 ${biliVideos?.count ?? 0}`),
              h('button', { type: 'button', className: view === 'douyin' ? 'on' : '', onClick: () => setView('douyin') }, `抖音热榜 ${douyin?.count ?? 0}`),
            ),
          ),
          items.length
            ? items.map((item) =>
                h(
                  'div',
                  { key: item.id, className: 'dh-item' },
                  h(
                    'div',
                    { className: 'dh-row' },
                    h('span', { className: `dh-rank${item.rank <= 3 ? ' top' : ''}` }, item.rank),
                    h('a', { className: 'dh-link', href: item.url, target: '_blank', rel: 'noreferrer', title: item.title }, item.title),
                    item.category && item.category !== '热搜' ? h('span', { className: 'dh-tag' }, item.category) : null,
                    h('span', { className: 'dh-heat' }, formatHeat(item.heat)),
                  ),
                  h(
                    'div',
                    { className: 'dh-bar' },
                    h('i', {
                      style: {
                        width: `${maxHeat > 0 ? Math.max(2, (item.heat / maxHeat) * 100) : 0}%`,
                        background: item.source === 'douyin' ? COLOR_DOUYIN : COLOR_BILI,
                      },
                    }),
                  ),
                ),
              )
            : h(Empty),
        ),
        h('div', { className: 'dh-hint' }, `数据源：${record?.label ?? '未知'}${record?.stale ? '（本次抓取失败，展示的是上一次成功的数据）' : ''}`),
      );
    }

    function StatsTab({ feed }) {
      const { stats } = feed;
      const news = stats.groups.news;
      const trendLabels = stats.trend.map((point) => point.date);
      const trendSeries = [
        { name: 'B站', color: COLOR_BILI, values: stats.trend.map((point) => point.bili) },
        { name: '抖音', color: COLOR_DOUYIN, values: stats.trend.map((point) => point.douyin) },
      ];
      const groupSeries = [
        { name: '梗', color: COLOR_MEME, values: stats.trend.map((point) => point.meme) },
        { name: '热点', color: COLOR_NEWS, values: stats.trend.map((point) => point.news) },
      ];
      const diff = stats.diff;

      return h(
        'div',
        { className: 'dh-col' },
        h(
          'div',
          { className: 'dh-grid' },
          h(
            'div',
            { className: 'dh-card' },
            h('h3', null, h('span', null, '梗 / 热点构成'), h('small', null, `${stats.totals.all} 条`)),
            h('div', { className: 'dh-donut-wrap' }, h(Donut, { entries: stats.byGroup }), h(Legend, { entries: stats.byGroup })),
          ),
          h(BarCard, {
            title: '流传榜 · 细分构成',
            note: `${stats.memeSpread.totals.memes} 个词条`,
            entries: stats.memeSpread.subCategories.map((entry) => ({ label: entry.name, value: entry.clusters, sub: `覆盖 ${entry.items} 条` })),
            color: COLOR_MEME,
            unit: ' 词',
            limit: 10,
          }),
          h(BarCard, {
            title: '热点 · 细分构成',
            note: `${news.totals.clusters} 个话题`,
            entries: news.subCategories.map((entry) => ({ label: entry.name, value: entry.items, sub: `${entry.clusters} 话题` })),
            color: COLOR_NEWS,
            unit: ' 条',
            limit: 10,
          }),
        ),
        h(
          'div',
          { className: 'dh-card' },
          h('h3', null, h('span', null, `近 ${stats.windowDays} 天条目数趋势`), h('small', null, '每天 06:00 采集一次')),
          stats.trend.length > 1
            ? h(
                'div',
                null,
                h(LineChart, { labels: trendLabels, series: groupSeries }),
                h(Legend, {
                  entries: [
                    { name: '梗', count: groupSeries[0].values.at(-1) ?? 0, color: COLOR_MEME },
                    { name: '热点', count: groupSeries[1].values.at(-1) ?? 0, color: COLOR_NEWS },
                  ],
                }),
                h('div', { className: 'dh-hint', style: { marginTop: 14 } }, '按来源拆分：'),
                h(LineChart, { labels: trendLabels, series: trendSeries }),
              )
            : h(Empty, { text: '趋势图需要至少两天的数据，明天 06:00 之后就能看到曲线了' }),
        ),
        h(
          'div',
          { className: 'dh-grid wide' },
          h(BarCard, {
            title: '来源构成',
            note: '原始条目',
            entries: stats.bySource.map((entry) => ({ label: entry.name, value: entry.count })),
            color: COLOR_ACCENT,
            unit: ' 条',
            limit: 6,
          }),
          h(BarCard, {
            title: '热度分档',
            note: '按条目热度归入区间',
            entries: stats.heatBands.map((band) => ({ label: band.name, value: band.count })),
            color: COLOR_ACCENT,
            unit: ' 条',
            limit: 6,
          }),
          h(BarCard, {
            title: 'B站分区分布',
            note: 'Top 10',
            entries: stats.byCategory.map((entry) => ({ label: entry.name, value: entry.count })),
            color: COLOR_BILI,
            unit: ' 条',
            limit: 10,
          }),
          h(BarCard, {
            title: '标题高频词',
            note: '3–4 字 n-gram 词频（启发式）',
            entries: stats.wordFreq.map((entry) => ({ label: entry.word, value: entry.count })),
            color: '#0ea5e9',
            unit: ' 次',
            limit: 14,
          }),
        ),
        h(
          'div',
          { className: 'dh-grid wide' },
          h(
            'div',
            { className: 'dh-card' },
            h('h3', null, h('span', null, '持续热梗'), h('small', null, `近 ${stats.windowDays} 天出现 ≥2 天`)),
            stats.persistentKeywords.length
              ? stats.persistentKeywords.map((entry, index) =>
                  h(
                    'div',
                    { key: `${entry.keyword}-${index}`, className: 'dh-item' },
                    h(
                      'div',
                      { className: 'dh-row' },
                      h(SourceTag, { source: entry.source }),
                      h('span', { className: 'dh-link', title: entry.keyword }, entry.keyword),
                      h('span', { className: 'dh-tag' }, `${entry.days} 天`),
                      h('span', { className: 'dh-heat' }, `最高 #${entry.bestRank}`),
                    ),
                  ),
                )
              : h(Empty, { text: '还需要更多天的数据才能识别持续热梗' }),
          ),
          h(
            'div',
            { className: 'dh-card' },
            h('h3', null, h('span', null, '与上一份快照对比'), h('small', null, diff.baseDate ? `基准 ${diff.baseDate} · 留存 ${diff.stayed} 条` : '暂无上一份快照')),
            h(
              'div',
              { className: 'dh-split' },
              h(
                'div',
                null,
                h('div', { className: 'dh-hint', style: { marginTop: 0, marginBottom: 6 } }, `新上榜 ${diff.newEntries.length} 条`),
                diff.newEntries.length
                  ? diff.newEntries.slice(0, 10).map((item, index) =>
                      h(
                        'div',
                        { key: `new-${index}`, className: 'dh-row' },
                        h('a', { className: 'dh-link', href: item.url, target: '_blank', rel: 'noreferrer', title: item.title }, item.title),
                        h('span', { className: 'dh-heat' }, formatHeat(item.heat)),
                      ),
                    )
                  : h(Empty, { text: '无' }),
              ),
              h(
                'div',
                null,
                h('div', { className: 'dh-hint', style: { marginTop: 0, marginBottom: 6 } }, `掉榜 ${diff.droppedEntries.length} 条`),
                diff.droppedEntries.length
                  ? diff.droppedEntries.slice(0, 10).map((item, index) =>
                      h(
                        'div',
                        { key: `drop-${index}`, className: 'dh-row' },
                        h('a', { className: 'dh-link', href: item.url, target: '_blank', rel: 'noreferrer', title: item.title }, item.title),
                        h('span', { className: 'dh-heat' }, formatHeat(item.heat)),
                      ),
                    )
                  : h(Empty, { text: '无' }),
              ),
            ),
          ),
        ),
      );
    }

    // -----------------------------------------------------------------------
    // 主面板
    // -----------------------------------------------------------------------
    const TABS = [
      { id: 'overview', label: '概览' },
      { id: 'spread', label: '流传榜' },
      { id: 'news', label: '热点榜' },
      { id: 'raw', label: '原始榜' },
      { id: 'stats', label: '统计' },
    ];

    function Panel({ rpcCall }) {
      const [feed, setFeed] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [refreshing, setRefreshing] = useState(false);
      const [tab, setTab] = useState('overview');

      const load = useCallback(
        async (endpoint) => {
          const result = await rpcCall(endpoint, {});
          if (!result?.ok) throw new Error(result?.error?.message ?? 'RPC 调用失败');
          return normalizeFeed(result.value);
        },
        [rpcCall],
      );

      // 首次加载
      useEffect(() => {
        let alive = true;
        load('feed')
          .then((value) => {
            if (alive) {
              setFeed(value);
              setError(null);
            }
          })
          .catch((err) => {
            if (alive) setError(err?.message ?? String(err));
          })
          .finally(() => {
            if (alive) setLoading(false);
          });
        return () => {
          alive = false;
        };
      }, [load]);

      // 面板打开期间轻量轮询；Host 侧只读缓存，不会触发抓取。
      useEffect(() => {
        let alive = true;
        const timer = setInterval(() => {
          load('feed')
            .then((value) => {
              if (alive) setFeed(value);
            })
            .catch(() => {
              /* 轮询失败静默，避免频繁弹错 */
            });
        }, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [load]);

      const onRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
          const value = await load('refresh');
          setFeed(value);
          setError(null);
        } catch (err) {
          setError(err?.message ?? String(err));
        } finally {
          setRefreshing(false);
        }
      }, [load]);

      const meta = feed?.meta;
      const statusClass = error ? 'bad' : meta?.stale || meta?.lastError ? 'warn' : '';

      const body = useMemo(() => {
        if (!feed) return null;
        if (tab === 'overview') return h(OverviewTab, { feed, onOpenTab: setTab });
        if (tab === 'spread') return h(SpreadTab, { feed });
        if (tab === 'news') return h(GroupTab, { feed, groupKey: 'news' });
        if (tab === 'raw') return h(RawTab, { feed });
        return h(StatsTab, { feed });
      }, [feed, tab]);

      return h(
        'div',
        { className: 'dh-root' },
        // 固定区：标题栏 + 警告 + 页签（不随内容滚动）
        h(
          'div',
          { className: 'dh-headwrap' },
          h(
            'div',
            { className: 'dh-head' },
            h(
              'div',
              null,
              h('div', { className: 'dh-title' }, h(HotspotIcon, { size: 20 }), '热点雷达'),
              h(
                'div',
                { className: 'dh-sub' },
                h('span', null, h('span', { className: `dh-dot ${statusClass}` }), ' '),
                meta
                  ? h(
                      'span',
                      null,
                      `${meta.sourceDate}${meta.isToday ? '（今日）' : '（历史）'} · ${formatAge(meta.ageMs)} · 下次自动更新 ${formatClock(meta.nextRefreshAt)}`,
                    )
                  : h('span', null, loading ? '加载中…' : '暂无数据'),
                meta?.durationMs != null ? h('span', null, `耗时 ${meta.durationMs}ms`) : null,
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center' } },
              meta?.refreshing || refreshing ? h('span', { className: 'dh-sub' }, '抓取中…') : null,
              h('button', { className: 'dh-btn primary', type: 'button', onClick: onRefresh, disabled: refreshing }, refreshing ? '刷新中…' : '立即刷新'),
            ),
          ),
          error ? h('div', { className: 'dh-warn' }, `加载失败：${error}`) : null,
          feed?.__groupingMissing
            ? h(
                'div',
                { className: 'dh-warn' },
                'Host 半边仍是旧版本（返回的数据里没有梗/热点分组）。客户端已热重载、Host 没有 —— ',
                '请从托盘完全退出 DSH 后重新打开，Host 代码才会重新加载。',
              )
            : null,
          meta?.lastError && !error ? h('div', { className: 'dh-warn' }, `部分数据源异常（已回退到可用来源或上一次成功结果）：${meta.lastError}`) : null,
        ),
        h(
          'div',
          { className: 'dh-tabwrap' },
          h(
            'div',
            { className: 'dh-tabs' },
            TABS.map((entry) =>
              h('button', { key: entry.id, type: 'button', className: `dh-tab${tab === entry.id ? ' on' : ''}`, onClick: () => setTab(entry.id) }, entry.label),
            ),
          ),
        ),
        // 滚动区：只有这一层滚动，内容再长也能看全
        h(
          'div',
          { className: 'dh-scroll' },
          h(
            'div',
            { className: 'dh-scrollinner' },
            loading && !feed ? h(Empty, { text: '正在加载热点数据…' }) : body,
            feed
              ? h(
                  'div',
                  { className: 'dh-hint' },
                  `每日 ${String(meta?.refreshHour ?? 6).padStart(2, '0')}:00 自动更新一次 · 数据落盘于 ${meta?.historyPath ?? '—'} · 已保留 ${meta?.historyDays ?? 0} 天快照`,
                )
              : null,
          ),
        ),
      );
    }

    // -----------------------------------------------------------------------
    // 插件入口
    // -----------------------------------------------------------------------
    const name = PLUGIN_NAME;
    const inject = ['slots', 'connection'];

    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-hotspot: styles');

      const rpcCall = (endpoint, payload, signal) => ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal);

      const main = () => h(Panel, { rpcCall });

      // 主面板：由侧边栏条目的 id 作为 key 选中
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, main));

      // 侧边栏图标
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '热点' }, (props) =>
          h(HotspotIcon, { size: typeof props?.size === 'number' ? props.size : 18 }),
        ),
      );
    }

    return { name, inject, apply };
  },
});
