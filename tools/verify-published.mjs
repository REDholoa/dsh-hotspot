// 发布产物验证：确认「别人实际装到的东西」是完整可用的。
//
//   node tools/verify-published.mjs                  # ① 发布前自检（无需网络安装）
//   node tools/verify-published.mjs <已安装的包目录>   # ② 验证真正装下来的副本
//   node tools/verify-published.mjs --offline        # 跳过真实抓取那一段
//
// 为什么需要它：tools/smoke.mjs 跑的是**工作副本**，而成品交付要经过 npm 的
// `files` 打包白名单 —— 白名单漏掉一个运行时必需的模块，本地测试全绿、
// 用户装上却直接崩。这类问题只有本脚本能发现（本插件就真的漏过 tools/）。
//
// 模式 ① 不需要安装：它按 npm 的 `files` 语义算出「哪些文件会进包」，
// 再断言运行时必需的文件一个都不少。模式 ② 更硬：逐个检查磁盘上的真实文件。
//
// 两种模式都会把 DSH_HOME 指向临时目录，绝不碰你真实的热点缓存。

import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const targetArg = args.find((a) => !a.startsWith('--'));

/** 有路径参数 → 模式 ②（验证已安装副本）；否则 → 模式 ①（发布前自检）。 */
const installedMode = targetArg !== undefined;
const pkgDir = installedMode ? path.resolve(targetArg) : repoRoot;

if (installedMode && !existsSync(pkgDir)) {
  console.error(`包目录不存在: ${pkgDir}`);
  process.exit(2);
}

// 隔离 DSH_HOME，避免污染真实数据。
// 额外挂一个 exit 兜底：任何提前退出（导入失败、未捕获异常）都别把临时目录留下。
const tempHome = mkdtempSync(path.join(tmpdir(), 'dsh-hotspot-verify-'));
process.env.DSH_HOME = tempHome;
process.on('exit', () => {
  try {
    rmSync(tempHome, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

let failures = 0;
function check(label, ok, detail = '') {
  console.log(ok ? `  ✓ ${label}` : `  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
function info(label) {
  console.log(`  · ${label}`);
}

console.log(`模式      : ${installedMode ? '② 验证已安装副本' : '① 发布前自检（模拟 npm 打包白名单）'}`);
console.log(`包目录    : ${pkgDir}`);
console.log(`临时 DSH_HOME: ${tempHome}`);
if (offline) console.log('（--offline：跳过真实抓取）');
console.log('');

// ---------------------------------------------------------------------------
// 运行时必需的文件：进了包才算发布成功
// 开发用文件：不进包是正常的（npm 只打包 files 白名单），仅作提示
// ---------------------------------------------------------------------------
const RUNTIME_FILES = [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  'lib/index.js',
  'lib/sources.js',
  'lib/classify.js',
  'lib/stats.js',
  'lib/text.js',
  'lib/store.js',
  'lib/http.js',
  'lib/rpc-channel.js',
  'client/client.js',
];
const DEV_FILES = ['tools/smoke.mjs', 'tools/client-check.mjs', 'tools/verify-published.mjs'];

/**
 * 按 npm 的 `files` 语义判断一个相对路径是否会进包。
 * 本包的 files 条目很简单（目录名 + 单个文件名），所以：
 *   · 条目是目录 → 该目录下所有文件都进包；
 *   · 条目是文件 → 精确匹配；
 *   · package.json / README* / LICENSE* / main 指向的文件 → npm 总是包含，与 files 无关。
 */
function isPacked(rel, files) {
  const posix = rel.split(path.sep).join('/');
  const base = posix.split('/').pop();
  if (base === 'package.json') return true;
  if (/^readme(\..*)?$/i.test(base)) return true;
  if (/^licen[cs]e(\..*)?$/i.test(base)) return true;
  for (const entry of files) {
    const clean = String(entry).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!clean) continue;
    if (posix === clean) return true;
    if (posix.startsWith(`${clean}/`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. 打包白名单（模式 ① 的核心）
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const filesField = Array.isArray(pkg.files) ? pkg.files : [];

if (!installedMode) {
  console.log('【1】打包白名单自检（npm files 语义）');
  const missing = RUNTIME_FILES.filter((rel) => !isPacked(rel, filesField));
  check('所有运行时必需文件都在 files 白名单内', missing.length === 0, missing.length ? `会被漏掉: ${missing.join(', ')}` : '');
  const devPacked = DEV_FILES.filter((rel) => isPacked(rel, filesField));
  info(`files 白名单: ${JSON.stringify(filesField)}`);
  info(devPacked.length ? `注意：以下开发文件也会进包 → ${devPacked.join(', ')}` : 'tools/ 不进包（符合预期：测试随仓库分发，消费者不需要）');
  info(`预期打包文件数: ${RUNTIME_FILES.length} 个运行时文件`);
} else {
  console.log('【1】文件完整性（逐个检查磁盘上的真实文件）');
  for (const rel of RUNTIME_FILES) {
    const abs = path.join(pkgDir, rel);
    check(rel, existsSync(abs) && statSync(abs).isFile());
  }
  const unexpected = RUNTIME_FILES.filter((rel) => !isPacked(rel, filesField));
  if (unexpected.length) info(`（这些文件虽然存在，但不在 files 白名单里: ${unexpected.join(', ')}）`);
  const hasTools = existsSync(path.join(pkgDir, 'tools'));
  info(`附带 tools/ 测试: ${hasTools ? '是' : '否'}（npm/pnpm 按 files 打包 git 依赖，缺 tools/ 属正常）`);
  if (hasTools) info(`  tools/: ${readdirSync(path.join(pkgDir, 'tools')).join(', ')}`);
}

// ---------------------------------------------------------------------------
// 2. package.json 契约
// ---------------------------------------------------------------------------
console.log('\n【2】package.json 契约');
const repoUrl = String(pkg.repository?.url ?? '');
check('name 合法', pkg.name === 'dsh-hotspot', String(pkg.name));
check('version 存在', typeof pkg.version === 'string' && pkg.version.length > 0, String(pkg.version));
check('main 指向 lib/index.js', pkg.main === 'lib/index.js', String(pkg.main));
check('license 已声明', typeof pkg.license === 'string' && pkg.license.length > 0, String(pkg.license));
check('repository 已声明', repoUrl.length > 0, repoUrl || '（缺失）');
check('dsh.bundle.patch 指向 ./cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml', String(pkg.dsh?.bundle?.patch));
check('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform));
check('dsh.client.inject 非空', Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, JSON.stringify(pkg.dsh?.client?.inject));
check('exports["./client"] 指向 client/client.js', pkg.exports?.['./client'] === './client/client.js', String(pkg.exports?.['./client']));
info(`版本 ${pkg.version} / 运行期依赖 ${JSON.stringify(pkg.dependencies ?? {})}`);

// ---------------------------------------------------------------------------
// 3. Host 半边模块契约
// ---------------------------------------------------------------------------
console.log('\n【3】Host 半边');
let host = null;
try {
  host = await import(pathToFileURL(path.join(pkgDir, 'lib/index.js')).href);
  check('lib/index.js 与它的全部依赖都能解析', true);
} catch (error) {
  // 这正是本脚本要抓的场景：漏提交/漏打包某个 lib 模块时，
  // import 会直接失败。这里给一条干净的诊断，而不是甩一段堆栈。
  check('lib/index.js 与它的全部依赖都能解析', false, error.message);
  rmSync(tempHome, { recursive: true, force: true });
  console.log(`\n❌ 发布产物验证失败：${failures} 项（入口无法导入，后续检查无从进行）`);
  process.exit(1);
}
check('导出 name = dsh-hotspot', host.name === 'dsh-hotspot', String(host.name));
check('导出 inject 数组', Array.isArray(host.inject), JSON.stringify(host.inject));
check('导出 apply 函数', typeof host.apply === 'function');

// 严格 ctx 桩：读未 inject 的服务必须抛错（与真实 Cordis 行为一致）
const routes = [];
const effects = [];
let forcedRejection;
const SERVICES = {
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => {
        const i = routes.indexOf(route);
        if (i >= 0) routes.splice(i, 1);
      };
    },
  },
  connection: { requestRejection: () => forcedRejection },
  timer: {
    timeout: (callback, delay) => {
      const handle = setTimeout(callback, delay);
      return () => clearTimeout(handle);
    },
  },
};
const MIXIN_SOURCES = { timeout: 'timer', interval: 'timer', throttle: 'timer', debounce: 'timer' };
const injected = new Set(host.inject);
const coreProps = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  effect: (callback) => {
    effects.push(callback());
    return () => {};
  },
  get: (name) => (injected.has(name) ? SERVICES[name] : undefined),
};
const ctx = new Proxy(coreProps, {
  get(target, prop) {
    if (typeof prop === 'symbol' || Object.hasOwn(target, prop)) return Reflect.get(target, prop);
    const required = MIXIN_SOURCES[prop] ?? prop;
    if (!SERVICES[required]) throw new Error(`cannot get property "${prop}" without inject`);
    if (!injected.has(required)) throw new Error(`cannot get property "${required}" without inject`);
    return SERVICES[required];
  },
});

let activated = true;
try {
  host.apply(ctx);
} catch (error) {
  activated = false;
  check('apply() 在严格 inject 下不抛错', false, error.message);
}
if (activated) check('apply() 在严格 inject 下不抛错', true);
check('注册了 1 条 RPC 路由', routes.length === 1, `实际 ${routes.length}`);
check(
  '路由为 prefix /dsh-hotspot',
  routes[0]?.kind === 'prefix' && routes[0]?.path === '/dsh-hotspot',
  JSON.stringify(routes[0] && { kind: routes[0].kind, path: routes[0].path }),
);

// ---------------------------------------------------------------------------
// 4. 线上协议（+ 可选的真实抓取）
// ---------------------------------------------------------------------------
console.log('\n【4】线上协议');
const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  const route = routes.find((r) => (r.kind === 'prefix' ? pathname.startsWith(r.path) : pathname === r.path));
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

async function rpc(endpoint, payload = {}, options = {}) {
  const response = await fetch(`${base}/dsh-hotspot/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': options.contentType ?? 'application/json' },
    body: JSON.stringify({ rpcId: 'verify-1', method: options.method ?? endpoint, payload }),
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

const wrongType = await rpc('feed', {}, { contentType: 'text/plain' });
check('content-type 非 JSON → 415', wrongType.status === 415, `实际 ${wrongType.status}`);

const mismatch = await rpc('feed', {}, { method: 'status' });
check('method 与 endpoint 不符 → gateway/bad-request', mismatch.body?.result?.error?.code === 'gateway/bad-request', JSON.stringify(mismatch.body?.result?.error));

forcedRejection = 401;
const rejected = await fetch(`${base}/dsh-hotspot/feed`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{"rpcId":"x","method":"feed"}',
});
check('信任栅栏拒绝 → 401', rejected.status === 401, `实际 ${rejected.status}`);
forcedRejection = undefined;

if (offline) {
  console.log('\n【5】真实抓取 — 已跳过（--offline）');
} else {
  console.log('\n【5】真实抓取');
  const started = Date.now();
  const refreshed = await rpc('refresh');
  info(`refresh 耗时 ${Date.now() - started}ms`);
  check('refresh 返回 ok', refreshed.body?.result?.ok === true, JSON.stringify(refreshed.body?.result?.error));

  const value = refreshed.body?.result?.value;
  if (!value) {
    check('refresh 返回了 value', false);
  } else {
    const { meta, platforms, stats } = value;
    for (const [source, slots] of Object.entries(platforms)) {
      for (const [slot, record] of Object.entries(slots)) {
        check(`${source}.${slot} 抓取成功（${record.count} 条）`, record.ok && record.count > 0, record.error ?? '');
      }
    }
    check('stats.groups 存在（梗/热点分组）', stats?.groups?.meme !== undefined && stats?.groups?.news !== undefined);
    check('stats.memeSpread 存在（流传榜）', stats?.memeSpread !== undefined && Array.isArray(stats.memeSpread.rows));
    check('流传榜不含视频条目', (stats?.memeSpread?.rows ?? []).every((row) => row.members.every((m) => m.kind !== 'video')));
    check('下次刷新时刻落在 06:00', new Date(meta.nextRefreshAt).getHours() === 6, new Date(meta.nextRefreshAt).toLocaleString('zh-CN'));
    info(`条目 ${stats?.totals?.all} / 流传榜词条 ${stats?.memeSpread?.totals?.memes} / 热点话题 ${stats?.groups?.news?.totals?.clusters}`);
  }
}

await new Promise((resolve) => server.close(resolve));

// ---------------------------------------------------------------------------
// 6. Client 半边模块契约
// ---------------------------------------------------------------------------
/**
 * 校验 Client 半边：模块契约 + 插槽注册。
 * 抽成函数是为了在 client/client.js 缺失时干净跳过，而不是抛一段堆栈。
 */
function verifyClient(entryDir) {
  const clientPath = path.join(entryDir, 'client/client.js');
  if (!existsSync(clientPath)) {
    check('client/client.js 存在', false, 'Client 半边缺失，本段检查跳过');
    return;
  }
  check('client/client.js 存在', true);

  const clientSource = readFileSync(clientPath, 'utf8');
  let spec = null;
  const runClient = new Function('window', 'document', clientSource);
  runClient(
    { __ModuleLoader__: { load: (value) => { spec = value; } } },
    {
      head: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => ({ set textContent(_v) {}, remove: () => {} }),
    },
  );
  check('调用 window.__ModuleLoader__.load', spec !== null);
  if (spec === null) return;
  check('模块 id = dsh-hotspot', spec.id === 'dsh-hotspot', String(spec.id));
  check('factory 是函数', typeof spec.factory === 'function');
  if (typeof spec.factory !== 'function') return;

  const registered = [];
  const clientExports = spec.factory((name) => {
    if (name !== 'react') throw new Error(`unexpected require(${name})`);
    return {
      createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }),
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useMemo: (factory) => factory(),
      useCallback: (factory) => factory,
      useRef: (value) => ({ current: value }),
    };
  });
  check(
    '导出 name / inject / apply',
    clientExports.name === 'dsh-hotspot' && Array.isArray(clientExports.inject) && typeof clientExports.apply === 'function',
  );

  clientExports.apply({
    effect: (callback) => {
      callback();
      return () => {};
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
    connection: { rpc: { call: async () => ({ ok: true, value: null }) } },
  });
  const main = registered.find((entry) => entry.options.name === 'main');
  const sidebar = registered.find((entry) => entry.options.name === 'sidebar.panellist');
  check('注册 main 面板 (key=hotspot)', main?.options.key === 'hotspot', String(main?.options.key));
  check('注册 sidebar.panellist (id=hotspot)', sidebar?.options.id === 'hotspot', String(sidebar?.options.id));
  check('sidebar.panellist 提供 label', typeof sidebar?.options.label === 'function' && typeof sidebar.options.label() === 'string');
}

console.log('\n【6】Client 半边');
verifyClient(pkgDir);

// ---------------------------------------------------------------------------
// 收尾
// ---------------------------------------------------------------------------
for (const dispose of effects) {
  if (typeof dispose === 'function') {
    try {
      await dispose();
    } catch {
      /* 忽略释放期错误 */
    }
  }
}
check('RPC 路由随 effect 释放', routes.length === 0, `剩余 ${routes.length}`);

rmSync(tempHome, { recursive: true, force: true });

console.log(failures === 0 ? '\n✅ 发布产物验证全部通过' : `\n❌ 发布产物验证失败：${failures} 项`);
process.exitCode = failures === 0 ? 0 : 1;
