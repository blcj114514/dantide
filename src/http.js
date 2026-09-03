// http.js — 本地 HTTP 服务（零依赖）: 静态前端 + JSON API + SSE + MCP
'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIR, DATA_DIR, describeConfig, loadConfig } from './config.js';
import { logger } from './logger.js';
import { listTasks, readTask, readTaskMeta, enqueueCrawl, enqueueAsr, TASK_FILES, taskFilePath, readTaskJson, abortTask, markTaskCancelled, getJobTaskIds } from './task.js';
import { crawlInput } from './dispatch.js';
import { handleMcpMessage } from './mcp.js';
import { analyzeClipboard, analyzeText, analyzeImage } from './llm.js';
import { toCsv, toXlsHtml, wordFrequency, collectTexts } from './export.js';
import { denyApiRequest, safeTaskId, assertLlmBaseUrl } from './security.js';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
};

const sseClients = new Set();
// 排队中的采集提交单（jobId → {input,label,createdAt}）；开工后移除，真实任务目录接管
const pendingJobs = new Map();

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  const full = path.resolve(filePath);
  // 防目录穿越
  if (!full.startsWith(path.resolve(WEB_DIR) + path.sep) && full !== path.resolve(WEB_DIR)) {
    return json(res, 403, { error: 'Forbidden' });
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not Found'); return; }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      // 本地应用: 页面与前端资源不缓存，避免升级后浏览器仍用旧版 JS/CSS
      'Cache-Control': 'no-cache',
      'Content-Length': st.size,
    });
    fs.createReadStream(full).pipe(res);
  });
}

function serveIndex(res) {
  const fp = path.join(WEB_DIR, 'index.html');
  let html = fs.readFileSync(fp, 'utf8');
  const token = loadConfig().server.localToken || '';
  const snippet = `<script>window.__SMR_TOKEN__=${JSON.stringify(token)};</script>\n`;
  html = html.includes('</head>') ? html.replace('</head>', snippet + '</head>') : snippet + html;
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

/** 保存 LLM 分析结果到任务目录 analysis.json（供复用/导出） */
function saveAnalysis(taskId, payload) {
  try {
    const dir = path.join(DATA_DIR, taskId);
    if (!fs.existsSync(dir)) return;
    const prev = [];
    try {
      const old = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
      if (Array.isArray(old)) prev.push(...old);
      else if (old?.type) prev.push(old);
    } catch { /* ignore */ }
    prev.push({ ...payload, createdAt: new Date().toISOString() });
    fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(prev.slice(-20), null, 2), 'utf8');
  } catch { /* ignore */ }
}

export function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    try {
      if (p.startsWith('/api') || p === '/mcp') {
        const denied = denyApiRequest(req, loadConfig());
        if (denied) return json(res, 401, { error: denied });
      }

      // ---- SSE 事件流（任务进度推送） ----
      if (p === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      // ---- MCP 端点 ----
      if (p === '/mcp') {
        if (req.method === 'POST') {
          const body = JSON.parse((await readBody(req, 1 * 1024 * 1024)) || '{}');
          const resp = await handleMcpMessage(body);
          if (!resp) { res.writeHead(204); res.end(); return; }
          return json(res, 200, resp);
        }
        // GET: SSE 入站连接（协议简化版: 直接返回欢迎事件 + 保持心跳）
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('event: endpoint\ndata: /mcp\n\n');
        const hb = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => clearInterval(hb));
        return;
      }

      // ---- API ----
      if (p.startsWith('/api/')) {
        // GET /api/status
        if (p === '/api/status' && req.method === 'GET') {
          const config = describeConfig();
          try {
            const { describeAsr } = await import('./asr.js');
            config.asr = describeAsr();
          } catch { /* ignore */ }
          return json(res, 200, { ok: true, version: '0.1.0', now: new Date().toISOString(), config });
        }
        if (p === '/api/asr/presets' && req.method === 'GET') {
          const { listAsrPresets } = await import('./asr-presets.js');
          return json(res, 200, { presets: listAsrPresets() });
        }
        // GET /api/tasks — 已落盘任务 + 排队中的提交单（排队项带取消按钮）
        if (p === '/api/tasks' && req.method === 'GET') {
          const tasks = listTasks();
          const pending = [...pendingJobs.entries()].map(([jobId, j]) => ({
            taskId: jobId, status: 'running', title: '⏳ 排队中: ' + j.label,
            url: '', type: 'pending', files: [], createdAt: j.createdAt, pending: true,
          }));
          return json(res, 200, { tasks: [...pending, ...tasks] });
        }
        // GET /api/tasks/:id
        const taskMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
        if (taskMatch && req.method === 'GET') {
          const id = safeTaskId(decodeURIComponent(taskMatch[1]));
          const t = id ? readTask(id) : null;
          if (!t) return json(res, 404, { error: '任务不存在' });
          return json(res, 200, t);
        }
        // POST /api/tasks/:id/rerun — 清空任务标记并重新采集（需要 meta 中保存的 url）
        const rerunMatch = p.match(/^\/api\/tasks\/([^/]+)\/rerun$/);
        if (rerunMatch && req.method === 'POST') {
          const id = safeTaskId(decodeURIComponent(rerunMatch[1]));
          if (!id) return json(res, 400, { error: '非法任务 ID' });
          const t = readTask(id);
          if (!t) return json(res, 404, { error: '任务不存在' });
          if (t.status === 'running') return json(res, 409, { error: '任务正在运行，不能重新采集' });
          const meta = readTaskMeta(id);
          let input = meta?.url || meta?.input;
          if (!input) {
            // 旧任务兜底: 从 bilibili_all.json 恢复视频链接
            try {
              const all = JSON.parse(fs.readFileSync(path.join(DATA_DIR, id, 'bilibili_all.json'), 'utf8'));
              input = all?.url || all?.bvid;
            } catch { /* ignore */ }
          }
          if (!input) return json(res, 400, { error: '任务缺少原始链接（meta.url 为空），无法重采' });
          const dir = path.join(DATA_DIR, id);
          for (const f of ['.task-completed', '.task-failed.json', '.task-status.json', '.task-progress.json']) {
            try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
          }
          const opts = (meta?.options && typeof meta.options === 'object') ? meta.options : {};
          enqueueCrawl(async () => {
            try {
              await crawlInput(input, opts);
            } catch (e) {
              logger.error('重新采集失败', { taskId: id, error: e.message });
            }
          }, { label: `重采 ${id}`, taskId: id });
          logger.info('重新采集已提交', { taskId: id, input });
          return json(res, 202, { accepted: true, taskId: id, message: '已提交重新采集，后台执行中' });
        }
        // DELETE /api/tasks/:id — 删除任务（连同整个任务目录）
        if (taskMatch && req.method === 'DELETE') {
          const id = safeTaskId(decodeURIComponent(taskMatch[1]));
          if (!id) return json(res, 400, { error: '非法任务 ID' });
          const t = readTask(id);
          if (!t) return json(res, 404, { error: '任务不存在' });
          if (t.status === 'running') return json(res, 409, { error: '任务正在运行，不能删除（可先点取消）' });
          const dir = path.join(DATA_DIR, id);
          // 双重保险: 确保目标在 DATA_DIR 内
          if (!dir.startsWith(path.resolve(DATA_DIR) + path.sep)) return json(res, 400, { error: '非法路径' });
          fs.rmSync(dir, { recursive: true, force: true });
          logger.info('任务已删除', { taskId: id, files: t.files?.length || 0 });
          return json(res, 200, { ok: true, taskId: id });
        }
        // POST /api/tasks/:id/cancel — 取消运行中的采集/转写；id 也可以是排队中的提交单 jobId
        const cancelMatch = p.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
        if (cancelMatch && req.method === 'POST') {
          const id = safeTaskId(decodeURIComponent(cancelMatch[1]));
          if (!id) return json(res, 400, { error: '非法任务 ID' });
          // 排队中（尚未开工）: 直接把队列里的请求作废
          if (id.startsWith('job-') && pendingJobs.has(id)) {
            pendingJobs.delete(id);
            enqueueCrawl.cancel(id);
            logger.warn('已取消排队任务', { taskId: id });
            return json(res, 200, { ok: true, taskId: id, cancelled: true, queued: true });
          }
          const t = readTask(id);
          if (!t) {
            // jobId 已开工但任务目录可能都已结束: 尽力中止其派生任务
            if (getJobTaskIds(id).length) {
              abortTask(id);
              logger.warn('已请求取消提交单（含派生任务）', { taskId: id });
              return json(res, 200, { ok: true, taskId: id, cancelled: true });
            }
            return json(res, 404, { error: '任务不存在' });
          }
          if (t.status !== 'running' && t.status !== 'stale') {
            return json(res, 409, { error: '任务未在运行' });
          }
          abortTask(id);
          markTaskCancelled(id);
          logger.warn('已请求取消任务', { taskId: id });
          return json(res, 200, { ok: true, taskId: id, cancelled: true });
        }
        // GET /api/tasks/:id/data/:file（file 可含子目录，如 keyframes/kf_1.jpg）
        const dataMatch = p.match(/^\/api\/tasks\/([^/]+)\/data\/(.+)$/);
        if (dataMatch && req.method === 'GET') {
          const id = safeTaskId(decodeURIComponent(dataMatch[1]));
          const rel = String(decodeURIComponent(dataMatch[2]));
          if (!id || !rel || rel.includes('..') || rel.includes('\\')) return json(res, 400, { error: '非法参数' });
          const file = rel.replace(/\//g, path.sep);
          const fp = path.join(DATA_DIR, id, file);
          if (!fp.startsWith(path.resolve(DATA_DIR) + path.sep) || !fs.existsSync(fp)) {
            return json(res, 404, { error: '文件不存在' });
          }
          const ext = path.extname(file).toLowerCase();
          if (ext === '.json') {
            const raw = fs.readFileSync(fp, 'utf8');
            try {
              const parsed = JSON.parse(raw);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
              return res.end(JSON.stringify(parsed));
            } catch {
              return json(res, 200, { raw: raw.slice(0, 200000) });
            }
          }
          // 非 JSON（mp4/mp3/图片等）: 直接流式发送（支持 Range，浏览器可拖进度）
          const st = fs.statSync(fp);
          const range = req.headers.range;
          if (range && /^bytes=(\d+)-(\d*)$/.test(range)) {
            const [, startS, endS] = range.match(/^bytes=(\d+)-(\d*)$/);
            const start = Number(startS);
            const end = endS ? Math.min(Number(endS), st.size - 1) : st.size - 1;
            res.writeHead(206, {
              'Content-Type': MIME[ext] || 'application/octet-stream',
              'Content-Range': `bytes ${start}-${end}/${st.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': end - start + 1,
              'Cache-Control': 'no-store',
            });
            fs.createReadStream(fp, { start, end }).pipe(res);
            return;
          }
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Accept-Ranges': 'bytes',
            'Content-Length': st.size,
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(fp).pipe(res);
          return;
        }
        // POST /api/crawl — 异步: 立即返回，后台串行队列执行（返回 jobId，排队中可取消）
        if (p === '/api/crawl' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const input = String(body.input || '').trim();
          if (!input) return json(res, 400, { error: '缺少 input' });
          const opts = body.options || {};
          const jobId = 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
          pendingJobs.set(jobId, { input, label: input.slice(0, 60), createdAt: new Date().toISOString() });
          logger.info('收到采集请求（已入队）', { jobId, input: input.slice(0, 120) });
          enqueueCrawl(async () => {
            pendingJobs.delete(jobId);
            return crawlInput(input, { ...opts, jobId });
          }, { label: input.slice(0, 80), taskId: jobId })
            .then((result) => logger.info('后台采集任务完成', { jobId, input: input.slice(0, 80), result: { taskId: result.taskId, skipped: result.skipped, stats: result.stats } }))
            .catch((e) => logger.error('后台采集任务失败', { jobId, input: input.slice(0, 80), error: e.message }));
          return json(res, 202, { accepted: true, jobId, message: '任务已提交，正在后台执行（详见实时日志与任务列表）' });
        }
        // GET /api/tasks/:id/export?type=comments|danmaku&format=csv|xls
        const exportMatch = p.match(/^\/api\/tasks\/([^/]+)\/export$/);
        if (exportMatch && req.method === 'GET') {
          const id = safeTaskId(decodeURIComponent(exportMatch[1]));
          const type = url.searchParams.get('type') || 'comments';
          const format = url.searchParams.get('format') || 'csv';
          if (!id) return json(res, 400, { error: '非法任务 ID' });
          const file = type === 'danmaku' ? TASK_FILES.danmaku : TASK_FILES.comments;
          const fp = taskFilePath(id, file);
          if (!fp) return json(res, 404, { error: type === 'danmaku' ? '任务中无弹幕' : '任务中无评论' });
          const items = JSON.parse(fs.readFileSync(fp, 'utf8'));
          const headers = type === 'danmaku'
            ? ['时间(秒)', '内容', '发送者(匿名)', '池', '发送时间']
            : ['用户', '点赞', '内容', '时间', '父评论'];
          const rows = (Array.isArray(items) ? items : []).map((i) => type === 'danmaku'
            ? [i.time, i.content, i.sender, i.pool, i.sendTime ? new Date(i.sendTime * 1000).toISOString() : '']
            : [i.user, i.like, i.content, i.ctime ? new Date(i.ctime * 1000).toISOString() : (i.publishedAt || ''), i.parent || '']);
          const title = `${id}_${type}`;
          if (format === 'xls') {
            const html = toXlsHtml(title, headers, rows);
            res.writeHead(200, {
              'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(title)}.xls`,
              'Cache-Control': 'no-store',
            });
            return res.end(html);
          }
          const csv = toCsv([headers, ...rows]);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(title)}.csv`,
            'Cache-Control': 'no-store',
          });
          return res.end(csv);
        }
        // GET /api/tasks/:id/wordcount?type=comments|danmaku&top=N
        const wcMatch = p.match(/^\/api\/tasks\/([^/]+)\/wordcount$/);
        if (wcMatch && req.method === 'GET') {
          const id = safeTaskId(decodeURIComponent(wcMatch[1]));
          const type = url.searchParams.get('type') || 'comments';
          const topN = Math.min(100, Number(url.searchParams.get('top')) || 30);
          if (!id) return json(res, 400, { error: '非法任务 ID' });
          const names = type === 'danmaku' ? TASK_FILES.danmaku : TASK_FILES.comments;
          const items = readTaskJson(id, names);
          if (!items) return json(res, 404, { error: type === 'danmaku' ? '任务中无弹幕' : '任务中无评论' });
          const words = wordFrequency(collectTexts(items), { topN });
          return json(res, 200, { type, total: Array.isArray(items) ? items.length : 0, words });
        }
        // POST /api/settings — 运行时设置（visionEnabled / 文本模型 / 视觉模型 / B站 cookies）
        if (p === '/api/settings' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const { loadConfig, saveConfig } = await import('./config.js');
          const next = {};
          let changed = false;
          if (typeof body.visionEnabled === 'boolean') {
            next.llm = { ...(next.llm || {}), visionEnabled: body.visionEnabled };
            changed = true;
          }
          // 文本模型配置（白名单）
          if (body.llm && typeof body.llm === 'object') {
            for (const f of ['baseUrl', 'apiKey', 'model']) {
              if (typeof body.llm[f] === 'string') {
                let val = body.llm[f].trim();
                if (f === 'baseUrl' && val) val = assertLlmBaseUrl(val);
                next.llm = { ...(next.llm || {}), [f]: val };
                changed = true;
              }
            }
            // 旧字段兼容（设置向导可能传 visionModel）
            if (typeof body.llm.visionModel === 'string') {
              next.llm = { ...(next.llm || {}), visionModel: body.llm.visionModel.trim() };
              changed = true;
            }
            // 视觉模型独立配置（llm.vision: {baseUrl, apiKey, model}）
            if (body.llm.vision && typeof body.llm.vision === 'object') {
              next.llm = { ...(next.llm || {}), vision: {} };
              for (const f of ['baseUrl', 'apiKey', 'model']) {
                if (typeof body.llm.vision[f] === 'string') {
                  let val = body.llm.vision[f].trim();
                  if (f === 'baseUrl' && val) val = assertLlmBaseUrl(val);
                  next.llm.vision[f] = val;
                  changed = true;
                }
              }
            }
          }
          // B站 cookies（整段字符串）
          if (body.cookies && typeof body.cookies.bilibili === 'string') {
            next.cookies = { ...(next.cookies || {}), bilibili: body.cookies.bilibili.trim() };
            changed = true;
          }
          if (body.youtube && typeof body.youtube.apiKey === 'string') {
            next.youtube = { ...(next.youtube || {}), apiKey: body.youtube.apiKey.trim() };
            changed = true;
          }
          if (body.asr && typeof body.asr === 'object') {
            next.asr = {};
            const presetId = typeof body.asr.preset === 'string' ? body.asr.preset.trim() : '';
            if (presetId && presetId !== 'custom') {
              const { resolvePresetFields } = await import('./asr-presets.js');
              const llmForPreset = {
                baseUrl: (body.llm && body.llm.baseUrl) || loadConfig().llm?.baseUrl || '',
              };
              const fields = resolvePresetFields(presetId, llmForPreset);
              if (fields) Object.assign(next.asr, fields);
            } else if (presetId === 'custom') {
              next.asr.preset = 'custom';
            }
            for (const f of ['preset', 'engine', 'model', 'language', 'baseUrl', 'apiKey', 'whisperBin', 'whisperModel']) {
              if (typeof body.asr[f] === 'string') {
                let val = body.asr[f].trim();
                if (f === 'baseUrl' && val) val = assertLlmBaseUrl(val);
                if (presetId && presetId !== 'custom' && presetId !== 'auto' && ['engine', 'model', 'baseUrl', 'whisperModel', 'preset'].includes(f)) {
                  // 非自定义预设以目录为准；Key 仍允许用户覆盖
                  if (f !== 'apiKey' && f !== 'preset') continue;
                }
                next.asr[f] = val;
                changed = true;
              }
            }
            if (typeof body.asr.enabled === 'boolean') { next.asr.enabled = body.asr.enabled; changed = true; }
            if (typeof body.asr.followLlm === 'boolean' && (!presetId || presetId === 'custom' || presetId === 'auto')) {
              next.asr.followLlm = body.asr.followLlm;
              changed = true;
            }
            if (typeof body.asr.chunkSeconds === 'number' && Number.isFinite(body.asr.chunkSeconds)) {
              next.asr.chunkSeconds = Math.min(1800, Math.max(60, body.asr.chunkSeconds));
              changed = true;
            }
            if (Object.keys(next.asr).length) changed = true;
          }
          if (!changed) return json(res, 400, { error: '无可更新的设置项' });
          saveConfig(next);
          const cfg = loadConfig();
          const textOk = !!(cfg.llm.apiKey && cfg.llm.baseUrl && cfg.llm.model);
          const v = cfg.llm.vision || {};
          const visionOk = !!(v.apiKey && v.baseUrl && v.model) || !!(cfg.llm.apiKey && cfg.llm.baseUrl && (v.model || cfg.llm.visionModel));
          logger.info('设置已更新', { textConfigured: textOk, visionConfigured: visionOk, visionEnabled: cfg.llm.visionEnabled });
          return json(res, 200, {
            ok: true, textConfigured: textOk, visionConfigured: visionOk,
            biliCookieConfigured: !!cfg.cookies.bilibili,
            youtubeConfigured: !!cfg.youtube.apiKey,
            visionEnabled: cfg.llm.visionEnabled,
            asrEnabled: cfg.asr?.enabled !== false,
          });
        }
        // POST /api/settings/test — 连接测试（真实调用模型验证连通性）
        if (p === '/api/settings/test' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const type = String(body.type || 'text');
          if (type === 'asr') {
            const { testAsrConnection } = await import('./asr.js');
            const result = await testAsrConnection();
            logger.info('转写连接测试', { ok: result.ok, probe: result.probe, model: result.model, error: result.error });
            return json(res, result.ok ? 200 : 400, result);
          }
          const { testLlmConnection } = await import('./llm.js');
          if (type !== 'text' && type !== 'vision') return json(res, 400, { error: 'type 必须为 text、vision 或 asr' });
          const result = await testLlmConnection(type);
          logger.info('模型连接测试', { type, ok: result.ok, model: result.model, latencyMs: result.latencyMs });
          return json(res, result.ok ? 200 : 400, result);
        }
        // POST /api/transcribe — 对已有任务补语音字幕 {task_id, force?}
        if (p === '/api/transcribe' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const id = safeTaskId(String(body.task_id || ''));
          if (!id) return json(res, 400, { error: '需要 task_id' });
          if (!readTask(id)) return json(res, 404, { error: '任务不存在' });
          const force = !!body.force;
          logger.info('收到语音转写请求（已入队）', { taskId: id, force });
          enqueueAsr(() => import('./asr.js').then((m) => m.transcribeTask(id, { force })), { label: 'asr:' + id, taskId: id })
            .then((result) => logger.info('语音转写完成', { taskId: id, result }))
            .catch((e) => logger.error('语音转写失败', { taskId: id, error: e.message }));
          return json(res, 202, { accepted: true, message: '转写已提交，进度见实时日志；完成后刷新「字幕」选项卡' });
        }
        // POST /api/keyframes — 关键帧分析 {task_id, top, frames}
        if (p === '/api/keyframes' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const id = safeTaskId(String(body.task_id || ''));
          if (!id) return json(res, 400, { error: '需要 task_id' });
          const { analyzeKeyframes } = await import('./platforms/bilibili/keyframes.js');
          try {
            const result = await analyzeKeyframes(id, {
              topN: Math.min(20, Number(body.top) || 5),
              framesPerMoment: Math.min(9, Number(body.frames) || 5),
            });
            return json(res, 200, result);
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }
        // POST /api/analyze — LLM 分析 {task_id, type: comments|danmaku|all} 或 {text, kind, extraPrompt}
        if (p === '/api/analyze' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          if (body.task_id) {
            const id = safeTaskId(String(body.task_id));
            const t = id ? readTask(id) : null;
            if (!t) return json(res, 404, { error: '任务不存在' });
            const type = String(body.type || 'comments');
            const { buildTaskAnalysisInput, analyzeCombined } = await import('./llm.js');
            if (type === 'all') {
              const { input, meta } = buildTaskAnalysisInput(id, 'all');
              const result = await analyzeCombined(input, { kind: '视频' });
              saveAnalysis(id, { type: 'all', meta, ...result });
              return json(res, 200, { type: 'all', meta, ...result });
            }
            if (type !== 'comments' && type !== 'danmaku') {
              return json(res, 400, { error: 'type 须为 comments / danmaku / all' });
            }
            const names = type === 'danmaku' ? TASK_FILES.danmaku : TASK_FILES.comments;
            if (!taskFilePath(id, names)) {
              return json(res, 404, { error: type === 'danmaku' ? '任务中无弹幕' : '任务中无评论' });
            }
            const { text, meta } = buildTaskAnalysisInput(id, type);
            const result = await analyzeText(text, { kind: type === 'danmaku' ? '弹幕' : '评论' });
            saveAnalysis(id, { type, total: meta.total || 0, ...result });
            return json(res, 200, result);
          }
          if (body.image) {
            const img = String(body.image || '');
            if (!/^data:image\/(png|jpe?g|webp|gif|bmp);base64,/i.test(img)) {
              return json(res, 400, { error: 'image 须为 data:image/(png|jpeg|webp|gif|bmp);base64,...' });
            }
            const prompt = String(body.prompt || body.extraPrompt || '请详细描述这张图片的内容、风格和文字信息。');
            const result = await analyzeImage(img, { prompt });
            return json(res, 200, { analysis: result });
          }
          if (body.text) {
            const result = await analyzeClipboard(String(body.text), String(body.extraPrompt || '分析正文和评论'));
            return json(res, 200, { analysis: result });
          }
          return json(res, 400, { error: '需要 task_id、text 或 image' });
        }
        // POST /api/report — 合集 AI 学习报告
        if (p === '/api/report' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)) || '{}');
          const id = safeTaskId(String(body.task_id || ''));
          if (!id) return json(res, 400, { error: '需要 task_id' });
          const { analyzeCollection } = await import('./collection-report.js');
          try {
            const result = await analyzeCollection(id, {
              questionCount: Math.min(20, Number(body.questions) || 8),
            });
            return json(res, 200, result);
          } catch (e) {
            return json(res, 400, { error: e.message });
          }
        }
        return json(res, 404, { error: 'Not Found' });
      }

      // ---- 静态前端 ----
      if (p === '/' || p === '/index.html') return serveIndex(res);
      return serveStatic(res, path.join(WEB_DIR, p.replace(/^\/+/, '')));
    } catch (e) {
      logger.error('HTTP 处理异常', { path: p, error: e.message });
      json(res, 500, { error: e.message });
    }
  });

  // 日志 → SSE 广播
  logger.onLog((entry) => {
    const payload = JSON.stringify(entry);
    for (const client of sseClients) {
      try { client.write(`data: ${payload}\n\n`); } catch { sseClients.delete(client); }
    }
  });

  return server;
}

export function startServer(port, host) {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      logger.info('HTTP 服务已启动', { host, port, auth: 'local-token' });
      resolve(server);
    });
  });
}
