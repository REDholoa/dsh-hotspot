// 落盘：把每天的抓取结果写到 $DSH_HOME/storages/dsh-hotspot/history.json。
//
// 为什么要落盘：
//   1. 用户不看页面的时候数据也在积累，打开即有内容（不需要等一次网络往返）；
//   2. 跨天保留快照才能做「新上榜 / 掉榜 / 持续热梗 / 多日趋势」这类统计；
//   3. 所有数据源同时挂掉时，仍能展示最近一次成功的结果（标记为 stale）。
//
// 写入采用「先写临时文件再改名」，避免进程在写一半时退出留下半个 JSON。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 保留多少天的历史快照。 */
export const HISTORY_DAYS = 30;

/** 磁盘格式版本：结构不兼容变更时递增，读到旧版本直接重建。 */
const STORE_VERSION = 1;

/** 数据目录：跟随 DSH_HOME，和 DSH 其它持久化数据放在一起。 */
export function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'storages', 'dsh-hotspot');
}

/** 历史文件路径。 */
export function historyPath() {
  return path.join(dataDir(), 'history.json');
}

/** 本地时区的 YYYY-MM-DD（不能用 toISOString，那是 UTC，会跨日错位）。 */
export function dateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 空的历史骨架。 */
export function emptyHistory() {
  return {
    version: STORE_VERSION,
    updatedAt: null,
    nextRefreshAt: null,
    lastError: null,
    days: {},
  };
}

/**
 * 读历史。文件不存在 / 损坏 / 版本不符时返回空骨架，绝不让读取失败阻断插件启动。
 * @returns {Promise<ReturnType<typeof emptyHistory>>}
 */
export async function readHistory() {
  try {
    const raw = await fs.readFile(historyPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION) return emptyHistory();
    if (!parsed.days || typeof parsed.days !== 'object') parsed.days = {};
    return { ...emptyHistory(), ...parsed, version: STORE_VERSION, days: parsed.days };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // 损坏文件留一份现场，方便排查；然后从空开始，不阻断服务。
      try {
        await fs.rename(historyPath(), `${historyPath()}.corrupt-${Date.now()}`);
      } catch {
        /* 备份失败也不影响主流程 */
      }
    }
    return emptyHistory();
  }
}

/** 只保留最近 N 天的快照，返回是否发生了裁剪。 */
export function pruneDays(history, keepDays = HISTORY_DAYS) {
  const keys = Object.keys(history.days).sort();
  if (keys.length <= keepDays) return false;
  for (const key of keys.slice(0, keys.length - keepDays)) delete history.days[key];
  return true;
}

/**
 * 原子写历史。
 * 先写 .tmp 再改名：Windows 上 fs.rename 会覆盖已存在目标，失败时退回直接写。
 * @param {ReturnType<typeof emptyHistory>} history
 */
export async function writeHistory(history) {
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true });
  const target = historyPath();
  const temp = `${target}.tmp`;
  const payload = `${JSON.stringify(history, null, 2)}\n`;
  await fs.writeFile(temp, payload, 'utf8');
  try {
    await fs.rename(temp, target);
  } catch {
    await fs.writeFile(target, payload, 'utf8');
    await fs.rm(temp, { force: true });
  }
}

/**
 * 计算下一个「每天 hour 点」的毫秒时间戳（本地时区）。
 * 今天还没到点就是今天，否则是明天；用于每日定时刷新。
 * @param {number} hour 0-23
 * @param {number} [from] 基准时间戳
 */
export function nextDailyAt(hour, from = Date.now()) {
  const next = new Date(from);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= from) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/**
 * 判断某天的快照是否已经「过期」：不存在，或采集时间早于今天的目标时刻。
 * 插件启动时用它决定要不要立刻补一次抓取。
 * @param {ReturnType<typeof emptyHistory>} history
 * @param {number} hour
 */
export function isSnapshotStale(history, hour) {
  const now = Date.now();
  const today = dateKey(now);
  const snapshot = history.days[today];
  if (!snapshot) return true;
  const todayTarget = new Date(now);
  todayTarget.setHours(hour, 0, 0, 0);
  // 目标时刻还没到（例如现在是凌晨 3 点，目标 6 点）：昨天的快照仍然算最新。
  const reference = todayTarget.getTime() <= now ? todayTarget.getTime() : todayTarget.getTime() - 86400000;
  return (snapshot.capturedAt ?? 0) < reference;
}
