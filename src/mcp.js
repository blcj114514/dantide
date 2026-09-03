// mcp.js — MCP 服务器（工具: crawl_bilibili 系列 + list_archives + get_task_data + analyze_task）
// 协议: 简易 SSE（GET /mcp → text/event-stream 接收 JSON-RPC；POST /mcp 发送响应）
'use strict';

import { crawlBilibili } from './platforms/bilibili/crawl.js';
import { listTasks, readTask, TASK_FILES, taskFilePath, readTaskJson, enqueueCrawl } from './task.js';
import { analyzeText } from './llm.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { safeTaskId } from './security.js';

/** MCP 采集走与 Web 相同的串行队列，避免与网页任务并发打 B 站 */
async function queuedCrawl(label, fn) {
  return enqueueCrawl(fn, { label: 'mcp: ' + String(label).slice(0, 60) });
}

export const MCP_TOOLS = [
  { name: 'crawl_bilibili', description: '搜集 B 站视频的评论、弹幕、字幕、AI总结等数据。传入视频 URL 或 BV 号。', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'B 站视频 URL 或 BV 号' } }, required: ['url'] } },
  { name: 'crawl_bilibili_search', description: '按关键词触发 B 站搜索结果搜集。', inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } },
  { name: 'crawl_bilibili_uploader', description: '按 UP 主 mid 触发 UP 主视频列表搜集。', inputSchema: { type: 'object', properties: { mid: { type: 'string', description: 'UP 主 mid（数字 ID）' } }, required: ['mid'] } },
  { name: 'crawl_bilibili_popular', description: '触发 B 站热门视频搜集。', inputSchema: { type: 'object', properties: {} } },
  { name: 'crawl_bilibili_weekly', description: '搜集 B 站每周必看内容。可指定期数。', inputSchema: { type: 'object', properties: { number: { type: 'number' } } } },
  { name: 'crawl_bilibili_recommend', description: '触发 B 站首页推荐流搜集（需登录 cookies）。', inputSchema: { type: 'object', properties: {} } },
  { name: 'crawl_youtube', description: '搜集 YouTube 视频信息与评论（需配置 Google API key）。', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'YouTube 视频 URL 或 ID' } }, required: ['url'] } },
  { name: 'list_archives', description: '列出归档目录中的采集任务。', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_task_data', description: '读取指定任务目录中的数据（comments/danmaku/subtitles/detail/all/summary）。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, type: { type: 'string', enum: ['comments', 'danmaku', 'subtitles', 'detail', 'all', 'summary'] } }, required: ['task_id'] } },
  { name: 'analyze_task', description: '用 LLM 分析任务数据（评论/弹幕，或 all 综合视频+弹幕+评论，需已配置 LLM）。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, type: { type: 'string', enum: ['comments', 'danmaku', 'all'] } }, required: ['task_id'] } },
  { name: 'transcribe_task', description: '对已采集任务做语音转写，补 subtitles.json（无官方字幕时）。需 ffmpeg + whisper.cpp 或 /v1/audio/transcriptions。', inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, force: { type: 'boolean', description: '覆盖已有官方字幕' } }, required: ['task_id'] } },
];

const FILES_BY_TYPE = TASK_FILES;

export async function handleToolCall(name, args = {}) {
  switch (name) {
    case 'crawl_bilibili': {
      if (!args.url) throw new Error('缺少 url 参数');
      const r = await queuedCrawl(args.url, () => crawlBilibili(args.url, {}));
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    case 'crawl_bilibili_search': {
      if (!args.keyword) throw new Error('缺少 keyword 参数');
      const url = `https://search.bilibili.com/video?keyword=${encodeURIComponent(args.keyword)}`;
      const r = await queuedCrawl('search ' + args.keyword, () => crawlBilibili(url, {}));
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    case 'crawl_bilibili_uploader': {
      if (!/^\d+$/.test(String(args.mid))) throw new Error('mid 必须是纯数字');
      const url = `https://space.bilibili.com/${args.mid}/upload/video`;
      const r = await queuedCrawl('uploader ' + args.mid, () => crawlBilibili(url, {}));
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    case 'crawl_bilibili_popular': {
      const r = await queuedCrawl('popular', () => crawlBilibili('https://www.bilibili.com/v/popular/all', {}));
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    case 'crawl_bilibili_weekly': {
      const num = args.number ? Number(args.number) : 1;
      const url = `https://www.bilibili.com/v/popular/weekly?num=${num}`;
      const r = await queuedCrawl('weekly ' + num, () => crawlBilibili(url, {}));
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    case 'crawl_bilibili_recommend': {
      const r = await queuedCrawl('recommend', () => crawlBilibili('https://www.bilibili.com/video/recommend', {}));
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    case 'crawl_youtube': {
      if (!args.url) throw new Error('缺少 url 参数');
      const { crawlYoutube } = await import('./platforms/youtube/crawl.js');
      const r = await queuedCrawl('yt ' + args.url, () => crawlYoutube(args.url, {}));
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    case 'list_archives': {
      const tasks = listTasks().slice(0, Number(args.limit) || 50);
      return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
    }
    case 'get_task_data': {
      const taskId = safeTaskId(args.task_id);
      if (!taskId) throw new Error('非法 task_id');
      const t = readTask(taskId);
      if (!t) throw new Error(`任务不存在: ${taskId}`);
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = path.join(DATA_DIR, taskId);
      const data = {};
      const names = FILES_BY_TYPE[args.type] || Object.keys(FILES_BY_TYPE).flatMap((k) => FILES_BY_TYPE[k]);
      for (const f of names) {
        const fp = path.join(dir, f);
        if (fs.existsSync(fp)) {
          try { data[f] = JSON.parse(fs.readFileSync(fp, 'utf8')); }
          catch { data[f] = fs.readFileSync(fp, 'utf8').slice(0, 20000); }
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: taskId, data }, null, 2).slice(0, 50000) }] };
    }
    case 'analyze_task': {
      const taskId = safeTaskId(args.task_id);
      if (!taskId) throw new Error('非法 task_id');
      const t = readTask(taskId);
      if (!t) throw new Error(`任务不存在: ${taskId}`);
      const type = String(args.type || 'comments');
      if (type === 'all') {
        const { buildTaskAnalysisInput, analyzeCombined } = await import('./llm.js');
        const { input, meta } = buildTaskAnalysisInput(taskId, 'all');
        const result = await analyzeCombined(input, { kind: '视频' });
        return { content: [{ type: 'text', text: JSON.stringify({ type: 'all', meta, ...result }, null, 2) }] };
      }
      const names = FILES_BY_TYPE[type];
      if (!names) throw new Error('不支持的 type（支持 comments / danmaku / all）');
      const fp = taskFilePath(taskId, names);
      if (!fp) throw new Error(type === 'danmaku' ? '任务中无弹幕' : '任务中无评论');
      const items = readTaskJson(taskId, names) || [];
      const text = (Array.isArray(items) ? items : []).map((i) => i.content || '').filter(Boolean).join('\n');
      const result = await analyzeText(text, { kind: type === 'danmaku' ? '弹幕' : '评论' });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    case 'transcribe_task': {
      const taskId = safeTaskId(args.task_id);
      if (!taskId) throw new Error('非法 task_id');
      const t = readTask(taskId);
      if (!t) throw new Error(`任务不存在: ${taskId}`);
      const { transcribeTask } = await import('./asr.js');
      const result = await transcribeTask(taskId, { force: !!args.force });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    default:
      throw new Error('未知工具: ' + name);
  }
}

/**
 * 处理一条 MCP JSON-RPC 消息
 * @returns {object} 响应
 */
export async function handleMcpMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params } = msg;
  try {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'smr-mcp', version: '0.1.0' } } };
    }
    if (method === 'notifications/initialized') return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    }
    if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const result = await handleToolCall(name, args || {});
      return { jsonrpc: '2.0', id, result };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
  } catch (e) {
    logger.error('MCP 工具调用失败', { method, error: e.message });
    return { jsonrpc: '2.0', id, error: { code: -32000, message: e.message } };
  }
}
