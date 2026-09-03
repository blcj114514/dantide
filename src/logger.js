// logger.js — 轻量 JSON 日志（pino 风格），敏感字段自动脱敏，支持事件订阅（SSE 推送）。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, redact } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let logStream = null;
let logLevel = 'info';
const listeners = new Set();

function ensureLogFile() {
  if (logStream) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logStream = fs.createWriteStream(path.join(LOG_DIR, 'app.log'), { flags: 'a' });
  } catch { /* 日志文件失败不阻塞运行 */ }
}

function sanitize(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') out[k] = sanitize(v);
    else out[k] = redact(v, k);
  }
  return out;
}

function write(level, msg, fields = {}) {
  if (LEVELS[level] < LEVELS[logLevel]) return;
  const entry = {
    level, time: new Date().toISOString(),
    msg: String(msg), ...sanitize(fields),
  };
  const line = JSON.stringify(entry);
  ensureLogFile();
  try { logStream?.write(line + '\n'); } catch { /* ignore */ }
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
  for (const fn of listeners) {
    try { fn(entry); } catch { /* listener errors ignored */ }
  }
}

export const logger = {
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
  setLevel: (l) => { if (LEVELS[l]) logLevel = l; },
  /** 订阅日志事件（用于 SSE 推送）; 返回取消函数 */
  onLog: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
};
