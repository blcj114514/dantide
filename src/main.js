#!/usr/bin/env node
// main.js — SMR 入口
//   node src/main.js              启动本地服务（默认 http://127.0.0.1:39010）
//   node src/main.js --crawl <url|BV> [--max-danmaku N] [--no-comments] ...
//   node src/main.js --analyze <taskId> [comments|danmaku|all]
//   node src/main.js --export <taskId> [comments|danmaku] [csv|xls]
//   node src/main.js --clipboard "<文本>"  (LLM 分析文本)
//   node src/main.js --image <图片路径> [--prompt "<问题>"]  (多模态模型分析图片)
//   node src/main.js --keyframes <taskId> [--top N] [--frames N]  (弹幕定位重点→提帧→识图模型识别)
//   node src/main.js --report <合集任务Id> [--questions N]  (合集AI分析: 逐视频知识点→合并出题报告)
//   node src/main.js --transcribe <taskId> [--force]  (无官方字幕时语音转写)
//   node src/main.js --list       列出任务
//   node src/main.js --delete <taskId>  删除任务（连同整个任务目录）
//   node src/main.js --status     查看配置摘要
//   node src/main.js --vision on|off   启用/禁用识图模型（消费较高）
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeConfig, DATA_DIR, ROOT } from './config.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const hasFlag = (name) => args.includes(name);

async function runCliCrawl() {
  const { crawlInput } = await import('./dispatch.js');
  const input = args[args.indexOf('--crawl') + 1];
  if (!input) { console.error('用法: node src/main.js --crawl <B站或YouTube URL|BV号> [--max-danmaku N] [--no-comments] [--section 板块名] [--offset N] [--quality 1080p|720p|480p|360p|240p|highest|lowest]'); process.exit(1); }
  const opts = {
    danmakuCount: Number(getArg('--max-danmaku', 2000)) || 0,
    commentCount: Number(getArg('--max-comments', 1000)) || 0,
    subCommentCount: Number(getArg('--sub-comments', 20)) || 0,
    noComments: hasFlag('--no-comments'),
    noSubtitles: hasFlag('--no-subtitles'),
    noSummary: hasFlag('--no-summary'),
    noAsr: hasFlag('--no-asr'),
    section: getArg('--section', ''),
    offset: Number(getArg('--offset', 0)) || 0,
    limit: Number(getArg('--limit', '')) || undefined,
    quality: getArg('--quality', '') || undefined,
  };
  const result = await crawlInput(input, opts);
  console.log(JSON.stringify(result, null, 2));
}

async function runCliAnalyze() {
  const { analyzeText, analyzeCombined, buildTaskAnalysisInput } = await import('./llm.js');
  const { readTask } = await import('./task.js');
  const taskId = args[args.indexOf('--analyze') + 1];
  const type = args[args.indexOf('--analyze') + 2] || 'comments';
  if (!taskId) { console.error('用法: node src/main.js --analyze <taskId> [comments|danmaku|all]'); process.exit(1); }
  const t = readTask(taskId);
  if (!t) { console.error('任务不存在:', taskId); process.exit(1); }
  if (type === 'all') {
    const { input, meta } = buildTaskAnalysisInput(taskId, 'all');
    console.log(`正在综合分析（评论${meta.comments}条 / 弹幕${meta.danmaku}条 / 字幕${meta.subtitles ? '✓' : '✗'} / AI总结${meta.aiSummary ? '✓' : '✗'}）…`);
    const result = await analyzeCombined(input, { kind: '视频' });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const { TASK_FILES, taskFilePath } = await import('./task.js');
  const names = type === 'danmaku' ? TASK_FILES.danmaku : TASK_FILES.comments;
  if (!taskFilePath(taskId, names)) { console.error(type === 'danmaku' ? '任务中无弹幕' : '任务中无评论'); process.exit(1); }
  const { text, meta } = buildTaskAnalysisInput(taskId, type);
  console.log(`正在分析 ${meta.total || 0} 条${type === 'danmaku' ? '弹幕' : '评论'}…`);
  const result = await analyzeText(text, { kind: type === 'danmaku' ? '弹幕' : '评论' });
  console.log(JSON.stringify(result, null, 2));
}

async function runCliExport() {
  const { toCsv, toXlsHtml } = await import('./export.js');
  const { readTask, TASK_FILES, taskFilePath, readTaskJson } = await import('./task.js');
  const taskId = args[args.indexOf('--export') + 1];
  const type = args[args.indexOf('--export') + 2] || 'comments';
  const format = args[args.indexOf('--export') + 3] || 'csv';
  if (!taskId) { console.error('用法: node src/main.js --export <taskId> [comments|danmaku] [csv|xls]'); process.exit(1); }
  const t = readTask(taskId);
  if (!t) { console.error('任务不存在:', taskId); process.exit(1); }
  const names = type === 'danmaku' ? TASK_FILES.danmaku : TASK_FILES.comments;
  const fp = taskFilePath(taskId, names);
  if (!fp) { console.error(type === 'danmaku' ? '任务中无弹幕' : '任务中无评论'); process.exit(1); }
  const items = readTaskJson(taskId, names) || [];
  const headers = type === 'danmaku'
    ? ['时间(秒)', '内容', '发送者(匿名)', '池', '发送时间']
    : ['用户', '点赞', '内容', '时间', '父评论'];
  const rows = (items || []).map((i) => type === 'danmaku'
    ? [i.time, i.content, i.sender, i.pool, i.sendTime ? new Date(i.sendTime * 1000).toISOString() : '']
    : [i.user, i.like, i.content, i.ctime ? new Date(i.ctime * 1000).toISOString() : (i.publishedAt || ''), i.parent || '']);
  const out = format === 'xls' ? toXlsHtml(`${taskId}_${type}`, headers, rows) : toCsv([headers, ...rows]);
  const dest = path.join(ROOT, `${taskId}_${type}.${format}`);
  fs.writeFileSync(dest, out, 'utf8');
  console.log('已导出:', dest, `(${(items || []).length} 条)`);
}

async function runCliClipboard() {
  const { analyzeClipboard } = await import('./llm.js');
  const idx = args.indexOf('--clipboard');
  let text = args[idx + 1];
  if (!text && !process.stdin.isTTY) {
    text = fs.readFileSync(0, 'utf8'); // 支持管道输入: echo "..." | node main.js --clipboard
  }
  if (!text) { console.error('用法: node src/main.js --clipboard "<文本>" 或管道输入'); process.exit(1); }
  console.log('正在分析…');
  const result = await analyzeClipboard(text);
  console.log(result);
}

async function runCliImage() {
  const { analyzeImage } = await import('./llm.js');
  const fp = path.resolve(args[args.indexOf('--image') + 1]);
  if (!fp || !fs.existsSync(fp)) { console.error('用法: node src/main.js --image <图片路径> [--prompt "<问题>"]'); process.exit(1); }
  const ext = path.extname(fp).toLowerCase().replace('.', '') || 'png';
  if (!['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'].includes(ext)) {
    console.error(`不支持的图片格式: ${ext}（支持 png/jpg/jpeg/webp/gif/bmp）`);
    process.exit(1);
  }
  const prompt = getArg('--prompt', '请详细描述这张图片的内容、风格和文字信息。');
  const b64 = fs.readFileSync(fp).toString('base64');
  console.log(`正在分析图片 ${fp} (${(fs.statSync(fp).size / 1024).toFixed(1)} KB)…`);
  const result = await analyzeImage(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}`, { prompt });
  console.log(result);
}

async function runCliKeyframes() {
  const { analyzeKeyframes } = await import('./platforms/bilibili/keyframes.js');
  const taskId = args[args.indexOf('--keyframes') + 1];
  if (!taskId) { console.error('用法: node src/main.js --keyframes <taskId> [--top N] [--frames N]'); process.exit(1); }
  const topN = Number(getArg('--top', 5)) || 5;
  const frames = Number(getArg('--frames', 5)) || 5;
  console.log(`正在定位关键时间点（top ${topN}，每点 ${frames} 帧）…`);
  const result = await analyzeKeyframes(taskId, { topN, framesPerMoment: frames });
  console.log(`定位方式: ${result.locator === 'llm' ? '阶段1 deepseek-v4-flash 语义分析' : '关键词规则(LLM兜底)'}`);
  for (const m of result.moments) {
    console.log(`\n===== ${m.timeLabel}（得分 ${m.score}）=====`);
    if (m.reason) console.log('定位依据:', m.reason);
    console.log('相关弹幕:', (m.danmaku || []).map((h) => h.content).slice(0, 3).join(' / '));
    if (m.analysis) {
      console.log('画面:', m.analysis.description);
      if (m.analysis.on_screen_text?.length) console.log('画面文字:', m.analysis.on_screen_text.join('、'));
      console.log('为何值得截图:', m.analysis.why_key);
    } else {
      console.log('(视觉识别未执行: 识图模型已禁用，可运行 --vision on 启用)');
    }
    console.log('帧文件:', m.frames.join(', '));
  }
  console.log('\n结果已保存:', result.keyframesFile);
}

async function runCliVision() {
  const { loadConfig, saveConfig } = await import('./config.js');
  const val = String(args[args.indexOf('--vision') + 1] || '').toLowerCase();
  if (!['on', 'off', '1', '0', 'true', 'false'].includes(val)) {
    console.error('用法: node src/main.js --vision on|off');
    process.exit(1);
  }
  const enabled = ['on', '1', 'true'].includes(val);
  saveConfig({ llm: { visionEnabled: enabled } });
  console.log(enabled ? '✅ 视觉分析已启用（识图模型将参与关键帧/图片识别）' : '⛔ 视觉分析已禁用（不再调用识图模型，节省消费）');
}

async function runCliDelete() {
  const { readTask, taskDir } = await import('./task.js');
  const taskId = args[args.indexOf('--delete') + 1];
  if (!taskId) { console.error('用法: node src/main.js --delete <taskId>'); process.exit(1); }
  const t = readTask(taskId);
  if (!t) { console.error('任务不存在:', taskId); process.exit(1); }
  if (t.status === 'running') { console.error('任务正在运行，不能删除'); process.exit(1); }
  const fs = await import('node:fs');
  fs.rmSync(taskDir(taskId), { recursive: true, force: true });
  console.log(`已删除任务「${t.title}」（${t.files?.length || 0} 个文件）`);
}

async function runCliReport() {
  const { analyzeCollection } = await import('./collection-report.js');
  const taskId = args[args.indexOf('--report') + 1];
  if (!taskId) { console.error('用法: node src/main.js --report <合集任务Id> [--questions N]'); process.exit(1); }
  console.log(`正在分析合集任务（逐视频提炼知识点 → 合并出题）…`);
  const { analyzedVideos, report, reportFile } = await analyzeCollection(taskId, {
    questionCount: Number(getArg('--questions', 8)) || 8,
  });
  console.log(`\n已分析 ${analyzedVideos.length} 个视频:`);
  for (const v of analyzedVideos) {
    console.log(`  [难度${v.difficulty}/5] ${v.title.slice(0, 40)} — ${(v.knowledge_points || []).slice(0, 3).join('、')}`);
  }
  console.log(`\n===== 合集报告 =====`);
  console.log('概述:', report.overview);
  console.log('\n知识点地图:');
  for (const k of report.knowledge_map || []) {
    console.log(`  • ${k.topic}: ${(k.points || []).join('、')}（${(k.videos || []).join(' / ')}）`);
  }
  console.log(`\n出题（${(report.questions || []).length} 道）:`);
  for (const q of report.questions || []) {
    console.log(`  [${q.type}] ${q.question}`);
    console.log(`    答案: ${q.answer}`);
    console.log(`    解析: ${q.explanation}`);
  }
  console.log('\n学习路径:');
  for (const p of report.learning_path || []) console.log(`  ${p}`);
  if (report.tips?.length) {
    console.log('\n提醒:');
    for (const t of report.tips) console.log(`  ${t}`);
  }
  console.log('\n报告已保存:', reportFile);
}

async function runCliTranscribe() {
  const { transcribeTask } = await import('./asr.js');
  const { readTask } = await import('./task.js');
  const taskId = args[args.indexOf('--transcribe') + 1];
  if (!taskId) { console.error('用法: node src/main.js --transcribe <taskId> [--force]'); process.exit(1); }
  const t = readTask(taskId);
  if (!t) { console.error('任务不存在:', taskId); process.exit(1); }
  console.log('正在语音转写字幕…');
  const result = await transcribeTask(taskId, { force: hasFlag('--force') });
  console.log(JSON.stringify(result, null, 2));
}

async function runCliList() {
  const { listTasks } = await import('./task.js');
  const tasks = listTasks();
  console.log(`共 ${tasks.length} 个任务:`);
  for (const t of tasks) {
    console.log(`  [${t.status}] ${t.title}  (${t.files.length} 文件, ${t.createdAt})`);
  }
}

async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (hasFlag('--status')) {
    const d = describeConfig();
    try {
      const { describeAsr } = await import('./asr.js');
      d.asr = describeAsr();
    } catch { /* ignore */ }
    console.log(JSON.stringify(d, null, 2));
    return;
  }
  if (hasFlag('--crawl')) return runCliCrawl();
  if (hasFlag('--analyze')) return runCliAnalyze();
  if (hasFlag('--export')) return runCliExport();
  if (hasFlag('--clipboard')) return runCliClipboard();
  if (hasFlag('--image')) return runCliImage();
  if (hasFlag('--keyframes')) return runCliKeyframes();
  if (hasFlag('--report')) return runCliReport();
  if (hasFlag('--transcribe')) return runCliTranscribe();
  if (hasFlag('--vision')) return runCliVision();
  if (hasFlag('--delete')) return runCliDelete();
  if (hasFlag('--list')) return runCliList();

  // 服务模式
  const { startServer } = await import('./http.js');
  const { host, port } = cfg.server;
  await startServer(port, host);
  const url = `http://${host}:${port}`;
  logger.info('==================================================');
  logger.info('SMR 已就绪', { url });
  logger.info(`Web UI: ${url}`);
  logger.info(`MCP: ${url}/mcp?token=<config.json server.localToken>`);
  logger.info('本机访问令牌已写入 config.json 的 server.localToken（页面自动携带）');
  logger.info('==================================================');
  if (cfg.web.openBrowser) {
    try {
      const { spawn } = await import('node:child_process');
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } catch { /* ignore */ }
  }
}

main().catch((e) => {
  logger.error('启动失败', { error: e.message, stack: e.stack });
  process.exit(1);
});
