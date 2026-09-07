// companion.js — FunASR 伴生进程管理
// DanTide 服务模式启动时自动拉起本地 FunASR(SenseVoice) 转写服务（tools/funasr-server.py），
// DanTide 退出时带走它（进程树）。8600 已被占用（用户手动启动/伴生已存在）则跳过。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { ROOT } from './config.js';
import { logger } from './logger.js';

const FUNASR_PORT = Number(process.env.FUNASR_PORT || 8600);
const PY = path.join(ROOT, 'tools', 'funasr-env', 'Scripts', 'python.exe');
const SERVER = path.join(ROOT, 'tools', 'funasr-server.py');

let child = null;
let managed = false; // 本次 DanTide 拉起的才负责关闭；手动启动的不动

function portInUse() {
  // 零依赖探测：临时 netstat 解析 8600 监听
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).some((l) => l.includes(`:${FUNASR_PORT}`) && /LISTEN/i.test(l));
  } catch {
    return false;
  }
}

/** 启动伴生 FunASR（已监听则跳过；环境缺件则警告跳过，不影响 DanTide 本体） */
export function startCompanionFunasr() {
  try {
    if (portInUse()) {
      logger.info('FunASR 伴生：8600 已有服务在跑，跳过拉起（可能是手动启动）', { port: FUNASR_PORT });
      return { started: false, reason: 'port-in-use' };
    }
    if (!fs.existsSync(PY) || !fs.existsSync(SERVER)) {
      logger.warn('FunASR 伴生：找不到 tools/funasr-env 或 funasr-server.py，跳过', { py: PY });
      return { started: false, reason: 'missing' };
    }
    const out = fs.openSync(path.join(ROOT, 'logs', 'funasr-companion.log'), 'a');
    const err = fs.openSync(path.join(ROOT, 'logs', 'funasr-companion.log'), 'a');
    child = spawn(PY, [SERVER], { cwd: path.join(ROOT, 'tools'), stdio: ['ignore', out, err], windowsHide: true });
    managed = true;
    logger.info('FunASR 伴生进程已拉起', { pid: child.pid, port: FUNASR_PORT, hint: '首次启动需 1-3 分钟加载模型' });
    child.on('exit', (code) => {
      if (managed) logger.info('FunASR 伴生进程退出', { code });
      managed = false;
      child = null;
    });
    return { started: true, pid: child.pid };
  } catch (e) {
    logger.warn('FunASR 伴生启动失败（不影响 DanTide）', { error: e.message });
    return { started: false, error: e.message };
  }
}

/** 停止伴生 FunASR：只杀本次 DanTide 拉起的进程树；8600 被手动启动占用时不动 */
export async function stopCompanionFunasr() {
  if (!managed || !child) return;
  const pid = child.pid;
  managed = false;
  try {
    if (process.platform === 'win32') {
      // taskkill /T 连带子进程树
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
    logger.info('FunASR 伴生进程已停止', { pid });
  } catch (e) {
    logger.warn('FunASR 伴生停止失败', { pid, error: e.message });
  }
}

/** DanTide 退出时调用（同步尽力而为，不给退出添堵） */
export function registerCompanionCleanup() {
  const cleanup = () => { try { stopCompanionFunasr(); } catch { /* ignore */ } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}