// collection-report.js — 合集 AI 分析报告
// 流程: 读合集批量任务的子任务数据（字幕/AI总结）→ 逐视频 LLM 提炼知识点 → 合并生成学习报告
// 输出: data/<collectionTaskId>/collection_report.json
//   report: { overview, knowledge_map, questions(出题), learning_path, tips }
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { chat, parseJsonReply, ANALYST_PERSONA } from './llm.js';
import { subtitlePlainText } from './subtitles.js';

const fmtDur = (s) => {
  const m = Math.floor((s || 0) / 60);
  return `${Math.floor(m / 60)}时${m % 60}分`;
};

/** 从子任务目录收集分析材料（标题 + 字幕 + AI总结） */
function collectVideoMaterials(taskId, subTaskId, title) {
  const dir = path.join(DATA_DIR, subTaskId);
  const material = { taskId: subTaskId, title: title || subTaskId };
  try {
    const all = JSON.parse(fs.readFileSync(path.join(dir, 'bilibili_all.json'), 'utf8'));
    material.duration = all?.detail?.duration;
  } catch { /* ignore */ }
  try {
    const subs = JSON.parse(fs.readFileSync(path.join(dir, 'subtitles.json'), 'utf8'));
    material.subtitles = subtitlePlainText(subs, 4000);
  } catch { /* ignore */ }
  try {
    const sum = JSON.parse(fs.readFileSync(path.join(dir, 'bilibili_summary.json'), 'utf8'));
    material.aiSummary = typeof sum === 'object' && sum !== null ? JSON.stringify(sum).slice(0, 1500) : '';
  } catch { /* ignore */ }
  return material;
}

/** 逐视频提炼知识点（deepseek-v4-flash） */
async function extractVideoKnowledge(material) {
  const system = ANALYST_PERSONA + `
你现在是学科教研员（视频课程分析师）：从视频标题、字幕片段与 AI 总结中提炼可验证的知识点，只依据给定材料，不臆测。只输出 JSON。`;
  const prompt = [
    `视频《${material.title}》${material.duration ? `（时长约 ${fmtDur(material.duration)}）` : ''}`,
    material.subtitles ? `---字幕片段---\n${material.subtitles}` : '(无字幕)',
    material.aiSummary ? `---AI总结---\n${material.aiSummary}` : '(无AI总结)',
    `请输出 JSON: {"knowledge_points": ["3-5个本视频核心知识点(具体，如'均值不等式求最值'而非'不等式')"], "core_idea": "核心方法或思想(60字内)", "difficulty": 1-5数字, "key_terms": ["关键术语/公式名"]}`,
  ].filter(Boolean).join('\n');
  try {
    const reply = await chat({ system, prompt, json: true, maxTokens: 1000 });
    const p = parseJsonReply(reply);
    return {
      title: material.title,
      taskId: material.taskId,
      duration: material.duration,
      knowledge_points: Array.isArray(p.knowledge_points) ? p.knowledge_points.map(String) : [],
      core_idea: String(p.core_idea || ''),
      difficulty: Number(p.difficulty) || 3,
      key_terms: Array.isArray(p.key_terms) ? p.key_terms.map(String) : [],
    };
  } catch (e) {
    logger.warn('视频知识点提炼失败', { taskId: material.taskId, error: e.message });
    return { title: material.title, taskId: material.taskId, knowledge_points: [], error: e.message };
  }
}

/** 合并生成合集学习报告（知识点地图 + 出题 + 学习建议） */
async function mergeCollectionReport(collectionInfo, videoExtracts, { questionCount = 8 } = {}) {
  const system = ANALYST_PERSONA + `
你现在是课程研发负责人：基于多个视频的知识点提炼结果，整合出完整的合集学习报告。只输出 JSON。`;
  const extractsText = videoExtracts.map((v) => (
    `《${v.title}》难度${v.difficulty || 3}/5\n知识点: ${(v.knowledge_points || []).join('、') || '(无)'}\n核心: ${v.core_idea || ''}`
  )).join('\n\n');
  const prompt = [
    `合集《${collectionInfo.title}》（本次分析 ${videoExtracts.length} 个视频）的各视频知识点提炼如下:`,
    '---数据开始---',
    extractsText.slice(0, 30000),
    '---数据结束---',
    `请输出 JSON:`,
    `{"overview": "合集整体内容概述与知识脉络(150字内)", "knowledge_map": [{"topic": "知识主题", "points": ["该主题下2-4个具体知识点"], "videos": ["对应视频标题1-2个"]}], "questions": [{"type": "选择题|填空题|解答题", "question": "题目(自拟，覆盖以上知识点，符合中国高考风格，含具体数值)", "answer": "答案", "explanation": "解析(说明所用知识点)"}], "learning_path": ["3-5条按顺序的学习建议(如'先学A再学B')"], "tips": ["2-3条学习提醒(常见错误/易混点)"]}`,
    `要求: questions 共 ${questionCount} 道，难度覆盖 2-5 档，答案必须正确且解析引用具体知识点；knowledge_map 的 topic 按知识板块组织。`,
  ].join('\n');
  const reply = await chat({ system, prompt, json: true, maxTokens: 4000 });
  return parseJsonReply(reply);
}

/**
 * 合集 AI 分析报告主流程
 * @param {string} collectionTaskId 合集批量任务 ID
 * @param {{maxVideos?: number, questionCount?: number}} opts
 */
export async function analyzeCollection(collectionTaskId, { maxVideos = 30, questionCount = 8 } = {}) {
  const dir = path.join(DATA_DIR, collectionTaskId);
  const allFp = path.join(dir, 'bilibili_all.json');
  if (!fs.existsSync(allFp)) throw new Error('任务不是合集任务（无 bilibili_all.json 或缺少合集信息）');
  const all = JSON.parse(fs.readFileSync(allFp, 'utf8'));
  if (all.type !== 'collection') throw new Error('该任务不是合集任务');

  const collectionInfo = all.collection || { title: `合集 ${all.sid}` };
  const done = (all.results || []).filter((r) => !r.failed && r.taskId);

  // 收集材料（优先有字幕/总结的视频）
  const materials = [];
  for (const r of done) {
    const m = collectVideoMaterials(collectionTaskId, r.taskId, r.title);
    if (m.subtitles || m.aiSummary) materials.push(m);
  }
  if (!materials.length) {
    throw new Error('子任务中无字幕/AI总结数据，无法分析（请确认采集时未跳过字幕和AI总结）');
  }
  logger.info('合集报告: 收集视频材料', { total: done.length, withContent: materials.length, analyzeUpTo: maxVideos });

  // 逐视频提炼（分批控制）
  const extracts = [];
  for (const [i, m] of materials.slice(0, maxVideos).entries()) {
    logger.info(`提炼知识点 ${i + 1}/${Math.min(materials.length, maxVideos)}`, { title: m.title.slice(0, 30) });
    const ex = await extractVideoKnowledge(m);
    extracts.push(ex);
  }
  const valid = extracts.filter((e) => (e.knowledge_points || []).length);
  if (!valid.length) throw new Error('所有视频知识点提炼失败，请检查 LLM 配置');

  // 合并报告
  logger.info('合并生成合集报告…', { videos: valid.length });
  const report = await mergeCollectionReport(collectionInfo, valid, { questionCount });

  const payload = {
    taskId: collectionTaskId,
    collection: { title: collectionInfo.title, sid: all.sid, total: collectionInfo.total },
    generatedAt: new Date().toISOString(),
    analyzedVideos: valid.map((v) => ({
      title: v.title, taskId: v.taskId, duration: v.duration,
      difficulty: v.difficulty, knowledge_points: v.knowledge_points, core_idea: v.core_idea,
    })),
    report,
  };
  const reportFile = path.join(dir, 'collection_report.json');
  fs.writeFileSync(reportFile, JSON.stringify(payload, null, 2), 'utf8');
  logger.info('合集报告完成', { taskId: collectionTaskId, videos: valid.length, questions: report.questions?.length || 0 });
  return { taskId: collectionTaskId, analyzedVideos: valid, report, reportFile };
}
