// task.js — 任务系统：任务目录 + 状态文件 + 队列 + 去重
// 任务目录: data/<taskId>/
//   状态文件: .task-status.json (running, 含 pid) / .task-completed / .task-failed.json
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export const TASK_ID_RE = /^(?:bilibili_|douyin_|xhs_|zhihu_|youtube_|search-|.*-\d+$)/;

export function sanitizeName(s) {
  return String(s || 'task')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function taskDir(taskId) {
  return path.join(DATA_DIR, taskId);
}

/** 按优先级返回任务目录里第一个存在的文件路径 */
export const TASK_FILES = {
  comments: ['bilibili_comment.json', 'youtube_comments.json'],
  danmaku: ['bilibili_danmaku.json'],
  detail: ['bilibili_detail.json', 'youtube_detail.json'],
  subtitles: ['subtitles.json', 'youtube_captions.json'],
  summary: ['bilibili_summary.json'],
  all: ['bilibili_all.json', 'youtube_all.json'],
};

export function taskFilePath(taskId, names) {
  const dir = taskDir(taskId);
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const fp = path.join(dir, name);
    if (fs.existsSync(fp)) return fp;
  }
  return '';
}

export function readTaskJson(taskId, names) {
  const fp = taskFilePath(taskId, names);
  if (!fp) return null;
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

export function taskHasFile(taskId, name) {
  return fs.existsSync(path.join(taskDir(taskId), name));
}

function inferTaskKind(files, meta, taskId) {
  if (meta?.type === 'collection' || String(taskId || '').startsWith('collection-')) return 'collection';
  const names = new Set((files || []).map((f) => f.name));
  if (names.has('youtube_detail.json') || names.has('youtube_all.json')) return 'youtube';
  return meta?.type || 'bilibili';
}

export function createTask(taskId, { title, url, type = 'crawl', options } = {}) {
  fs.mkdirSync(taskDir(taskId), { recursive: true });
  const status = {
    taskId, title: title || taskId, url: url || '', type,
    status: 'running', pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  if (options && typeof options === 'object') status.options = options;
  fs.writeFileSync(path.join(taskDir(taskId), '.task-status.json'), JSON.stringify(status, null, 2), 'utf8');
  attachTaskAbort(taskId);
  // 提交任务时生成的 jobId → 真实任务目录关联（排队任务可凭 jobId 取消/中止）
  if (options && typeof options.jobId === 'string' && options.jobId) registerJobTask(options.jobId, taskId);
  logger.info('任务已创建', { taskId, title: status.title });
  return status;
}

export function markTaskCompleted(taskId) {
  if (getTaskAbortSignal(taskId)?.aborted) {
    markTaskCancelled(taskId);
    return;
  }
  clearTaskAbort(taskId);
  const dir = taskDir(taskId);
  // 先读 meta（.task-status.json），再删状态文件
  const meta = readTaskMeta(taskId);
  try { fs.unlinkSync(path.join(dir, '.task-status.json')); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(dir, '.task-progress.json')); } catch { /* ignore */ }
  // 保留 meta（含 url），供"重新采集"使用
  if (meta) {
    fs.writeFileSync(path.join(dir, '.task-meta.json'), JSON.stringify({ ...meta, status: 'finished' }, null, 2), 'utf8');
  }
  fs.writeFileSync(path.join(dir, '.task-completed'), '', 'utf8');
  logger.info('任务完成', { taskId });
}

export function markTaskFailed(taskId, error) {
  clearTaskAbort(taskId);
  const dir = taskDir(taskId);
  // 先读 meta（.task-status.json），再删状态文件
  const meta = readTaskMeta(taskId);
  try { fs.unlinkSync(path.join(dir, '.task-status.json')); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(dir, '.task-progress.json')); } catch { /* ignore */ }
  if (meta) {
    fs.writeFileSync(path.join(dir, '.task-meta.json'), JSON.stringify({ ...meta, status: 'failed', error: String(error) }, null, 2), 'utf8');
  }
  fs.writeFileSync(path.join(dir, '.task-failed.json'), JSON.stringify({
    taskId, error: String(error), failedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  logger.error('任务失败', { taskId, error: String(error) });
}

export function markTaskCancelled(taskId, error = 'cancelled') {
  clearTaskAbort(taskId);
  const dir = taskDir(taskId);
  const meta = readTaskMeta(taskId);
  try { fs.unlinkSync(path.join(dir, '.task-status.json')); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(dir, '.task-progress.json')); } catch { /* ignore */ }
  try { fs.unlinkSync(path.join(dir, '.task-completed')); } catch { /* ignore */ }
  if (meta) {
    fs.writeFileSync(path.join(dir, '.task-meta.json'), JSON.stringify({ ...meta, status: 'cancelled', error: String(error) }, null, 2), 'utf8');
  }
  fs.writeFileSync(path.join(dir, '.task-failed.json'), JSON.stringify({
    taskId, error: String(error), cancelled: true, failedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  logger.warn('任务已取消', { taskId });
}

export class TaskCancelledError extends Error {
  constructor(message = '任务已取消') {
    super(message);
    this.name = 'TaskCancelledError';
    this.code = 'cancelled';
  }
}

export function isCancelledError(e) {
  if (!e) return false;
  if (e.name === 'TaskCancelledError' || e.code === 'cancelled') return true;
  return String(e.message || e).includes('任务已取消');
}

const abortControllers = new Map();
const jobTasks = new Map();

/** 记录 jobId → 其派生的所有任务目录（父批次 + 子视频），用于按提交单号取消 */
export function registerJobTask(jobId, taskId) {
  if (!jobTasks.has(jobId)) jobTasks.set(jobId, new Set());
  jobTasks.get(jobId).add(taskId);
}

export function getJobTaskIds(jobId) {
  return [...(jobTasks.get(jobId) || [])];
}

export function attachTaskAbort(taskId) {
  const prev = abortControllers.get(taskId);
  if (prev) {
    try { prev.abort(); } catch { /* ignore */ }
  }
  const ac = new AbortController();
  abortControllers.set(taskId, ac);
  return ac.signal;
}

export function getTaskAbortSignal(taskId) {
  return abortControllers.get(taskId)?.signal;
}

export function clearTaskAbort(taskId) {
  abortControllers.delete(taskId);
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new TaskCancelledError();
}

export function linkChildAbort(parentId, childId) {
  const parent = getTaskAbortSignal(parentId);
  if (!parent) return;
  const onAbort = () => abortTask(childId);
  if (parent.aborted) onAbort();
  else parent.addEventListener('abort', onAbort, { once: true });
}

export function abortTask(taskId) {
  enqueueCrawl.cancel?.(taskId);
  enqueueAsr.cancel?.(taskId);
  const ac = abortControllers.get(taskId);
  if (ac) {
    try { ac.abort(); } catch { /* ignore */ }
  }
  // jobId 取消: 中止该提交单号派生的所有任务（父批次 + 当前子任务）
  for (const tid of getJobTaskIds(taskId)) {
    if (tid === taskId) continue;
    const a2 = abortControllers.get(tid);
    if (a2) {
      try { a2.abort(); } catch { /* ignore */ }
    }
  }
  return true;
}

/** 读取任务 meta（.task-meta.json 优先，其次 .task-status.json） */
export function readTaskMeta(taskId) {
  const dir = taskDir(taskId);
  for (const f of ['.task-meta.json', '.task-status.json']) {
    try {
      const fp = path.join(dir, f);
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 更新任务进度（采集各阶段调用; 供 Web UI 进度条 / SSE 展示）
 * @param {string} taskId
 * @param {{stage: string, stageLabel: string, percent: number, current?: number, total?: number, message?: string}} p
 */
export function updateTaskProgress(taskId, p) {
  const dir = taskDir(taskId);
  if (!fs.existsSync(dir)) return;
  const data = { ...p, percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))), updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(path.join(dir, '.task-progress.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch { /* ignore */ }
  logger.info('采集进度', { taskId, stage: data.stage, stageLabel: data.stageLabel, percent: data.percent, current: data.current, total: data.total, message: data.message });
}

/** 去重/跳过检测: finished → 跳过; running → 跳过; 否则可执行 */
export function shouldSkipTask(taskId) {
  const dir = taskDir(taskId);
  if (!fs.existsSync(dir)) return { shouldSkip: false };
  if (fs.existsSync(path.join(dir, '.task-completed'))) return { shouldSkip: true, status: 'finished' };
  if (fs.existsSync(path.join(dir, '.task-failed.json'))) return { shouldSkip: false, status: 'failed' };
  const st = path.join(dir, '.task-status.json');
  if (fs.existsSync(st)) {
    try {
      const s = JSON.parse(fs.readFileSync(st, 'utf8'));
      if (s.pid && isProcessAlive(s.pid)) return { shouldSkip: true, status: 'running' };
    } catch { /* ignore */ }
  }
  return { shouldSkip: false, status: 'stale' };
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 读取任务信息（含文件清单） */
export function readTask(taskId) {
  const dir = taskDir(taskId);
  if (!fs.existsSync(dir)) return null;
  const files = [];
  try {
    const listDir = (rel) => {
      const abs = rel ? path.join(dir, rel) : dir;
      for (const f of fs.readdirSync(abs)) {
        if (f.startsWith('.')) continue;
        const fp = path.join(abs, f);
        const name = rel ? `${rel}/${f}` : f;
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        if (st.isDirectory()) {
          if (f === 'keyframes' || /^p\d+$/i.test(f)) listDir(name);
          else files.push({ name, size: st.size, mtime: st.mtime.toISOString() });
        } else {
          files.push({ name, size: st.size, mtime: st.mtime.toISOString() });
        }
      }
    };
    listDir('');
  } catch { /* ignore */ }
  let status = 'unknown';
  const statusPath = path.join(dir, '.task-status.json');
  const failedPath = path.join(dir, '.task-failed.json');
  let liveRunning = false;
  if (fs.existsSync(statusPath)) {
    liveRunning = true;
    try {
      const s = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      if (s.pid && !isProcessAlive(s.pid)) {
        liveRunning = false;
        status = 'stale';
      }
    } catch { /* keep running */ }
  }
  if (liveRunning) status = 'running';
  else if (status !== 'stale') {
    if (fs.existsSync(failedPath)) {
      try {
        const f = JSON.parse(fs.readFileSync(failedPath, 'utf8'));
        status = f.cancelled || f.error === 'cancelled' ? 'cancelled' : 'failed';
      } catch { status = 'failed'; }
    } else if (fs.existsSync(path.join(dir, '.task-completed'))) status = 'finished';
  }
  let meta = {};
  const metaFromFile = readTaskMeta(taskId) || {};
  const failedFile = path.join(dir, '.task-failed.json');
  if (fs.existsSync(failedFile)) {
    try { meta = { ...metaFromFile, ...JSON.parse(fs.readFileSync(failedFile, 'utf8')) }; } catch { meta = metaFromFile; }
  } else {
    meta = metaFromFile;
  }
  let progress = null;
  const pf = path.join(dir, '.task-progress.json');
  if (fs.existsSync(pf)) {
    try { progress = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch { /* ignore */ }
  }
  const st = fs.statSync(dir);
  return {
    taskId, status, title: meta.title || taskId, url: meta.url || '',
    type: inferTaskKind(files, meta, taskId),
    createdAt: st.birthtime.toISOString(), updatedAt: st.mtime.toISOString(),
    files, error: meta.error || undefined, progress,
  };
}

export function listTasks() {
  if (!fs.existsSync(DATA_DIR)) return [];
  const tasks = fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readTask(d.name))
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return tasks;
}

// ---- 串行队列（采集 / 转写分开，互不堵塞） ----
function makeQueue() {
  const queue = [];
  let running = false;
  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const item = queue.shift();
      if (item.cancelled) {
        item.reject(new TaskCancelledError());
        continue;
      }
      try { item.resolve(await item.fn()); }
      catch (e) { item.reject(e); }
    }
    running = false;
  }
  function enqueue(fn, { label = '', taskId = '' } = {}) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, label, taskId, resolve, reject, cancelled: false });
      pump();
    });
  }
  enqueue.cancel = (taskId) => {
    if (!taskId) return 0;
    let n = 0;
    for (const item of queue) {
      if (item.taskId === taskId && !item.cancelled) {
        item.cancelled = true;
        n++;
      }
    }
    return n;
  };
  return enqueue;
}

/** 采集队列（默认 enqueue 仍指向采集，兼容旧调用） */
export const enqueueCrawl = makeQueue();
export const enqueueAsr = makeQueue();
export const enqueue = enqueueCrawl;
