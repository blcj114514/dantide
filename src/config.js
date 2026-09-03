// config.js — 配置加载/保存。优先级: 环境变量 > config.json > 默认值。
// 敏感字段（cookies/apiKey）支持环境变量注入，避免明文落盘:
//   SMR_BILI_COOKIES, SMR_LLM_API_KEY, SMR_LLM_BASE_URL, SMR_LLM_MODEL, SMR_LLM_VISION_MODEL, SMR_YOUTUBE_API_KEY
//   SMR_ASR_ENABLED, SMR_ASR_ENGINE, SMR_ASR_MODEL, SMR_ASR_BASE_URL, SMR_ASR_API_KEY, SMR_WHISPER_BIN, SMR_WHISPER_MODEL
// saveConfig 只写回磁盘上的 fileConfig，不会把环境变量注入的密钥落盘。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const LOG_DIR = path.join(ROOT, 'logs');
export const WEB_DIR = path.join(__dirname, 'web');
const CONFIG_PATH = path.join(ROOT, 'config.json');

export const DEFAULTS = {
  server: { host: '127.0.0.1', port: 39010, localToken: '' },
  cookies: { bilibili: '', douyin: '', xhs: '', zhihu: '', youtube: '' },
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
    vision: {
      baseUrl: '',
      apiKey: '',
      model: '',
    },
    visionModel: '',
    visionEnabled: true,
    maxTokens: 2000,
  },
  youtube: {
    apiKey: '',
    ytdlpPath: '',
  },
  asr: {
    enabled: true,
    preset: 'auto',
    engine: 'auto', // auto | whisper-cpp | openai-compat | off
    language: 'zh',
    followLlm: true, // asr.baseUrl/apiKey 为空时跟随文本模型
    model: '', // 如 FunAudioLLM/SenseVoiceSmall；本地 whisper.cpp 不需要
    baseUrl: '',
    apiKey: '',
    whisperBin: '',
    whisperModel: '',
    chunkSeconds: 600,
  },
  crawl: {
    ffmpegPath: '',
    bilibili: {
      danmakuCount: 2000,
      commentCount: 1000,
      subCommentCount: 20,
      baseTargetCount: 1500,
      fetchVideo: true,
      fetchAudio: true,
      preferHighQuality: false,
      quality: '1080p',
    },
    requestDelay: { base: 300, random: 400 },
  },
  web: { openBrowser: true },
};

let config = null;
/** 磁盘上的配置（不含环境变量覆盖），saveConfig 只写这个对象 */
let fileConfig = {};
let fileUnreadable = false;
let runtimeOnlyToken = '';

function readFileConfig() {
  fileUnreadable = false;
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
    fileUnreadable = true;
    console.error('[config] config.json 解析失败，使用默认配置:', e.message);
    return {};
  }
}

function persistFileConfig() {
  if (fileUnreadable) return;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(fileConfig, null, 2) + '\n', 'utf8');
}

function ensureLocalToken() {
  if (fileConfig.server?.localToken) return;
  const token = crypto.randomBytes(24).toString('hex');
  if (fileUnreadable) {
    runtimeOnlyToken = token;
    return;
  }
  if (!fileConfig.server || typeof fileConfig.server !== 'object') fileConfig.server = {};
  fileConfig.server.localToken = token;
  persistFileConfig();
}

function applyEnv(cfg) {
  const envMap = {
    SMR_BILI_COOKIES: ['cookies', 'bilibili'],
    SMR_DOUYIN_COOKIES: ['cookies', 'douyin'],
    SMR_XHS_COOKIES: ['cookies', 'xhs'],
    SMR_ZHIHU_COOKIES: ['cookies', 'zhihu'],
    SMR_YOUTUBE_COOKIES: ['cookies', 'youtube'],
    SMR_LLM_API_KEY: ['llm', 'apiKey'],
    SMR_LLM_BASE_URL: ['llm', 'baseUrl'],
    SMR_LLM_MODEL: ['llm', 'model'],
    SMR_LLM_VISION_MODEL: ['llm', 'vision', 'model'],
    SMR_LLM_VISION_BASE_URL: ['llm', 'vision', 'baseUrl'],
    SMR_LLM_VISION_API_KEY: ['llm', 'vision', 'apiKey'],
    SMR_LLM_VISION_ENABLED: ['llm', 'visionEnabled'],
    SMR_YOUTUBE_API_KEY: ['youtube', 'apiKey'],
    SMR_LOCAL_TOKEN: ['server', 'localToken'],
    SMR_ASR_ENABLED: ['asr', 'enabled'],
    SMR_ASR_ENGINE: ['asr', 'engine'],
    SMR_ASR_MODEL: ['asr', 'model'],
    SMR_ASR_BASE_URL: ['asr', 'baseUrl'],
    SMR_ASR_API_KEY: ['asr', 'apiKey'],
    SMR_WHISPER_BIN: ['asr', 'whisperBin'],
    SMR_WHISPER_MODEL: ['asr', 'whisperModel'],
  };
  for (const [env, keys] of Object.entries(envMap)) {
    if (!process.env[env]) continue;
    let val = process.env[env];
    const last = keys[keys.length - 1];
    if (last === 'visionEnabled' || last === 'enabled') val = !/^(0|false|off|no)$/i.test(val);
    setByPath(cfg, keys, val);
  }
}

export function loadConfig() {
  if (config) return config;
  fileConfig = readFileConfig();
  ensureLocalToken();
  config = JSON.parse(JSON.stringify(DEFAULTS));
  deepMerge(config, fileConfig);
  if (runtimeOnlyToken && !config.server.localToken) config.server.localToken = runtimeOnlyToken;
  applyEnv(config);
  if (config.llm.visionModel && !config.llm.vision.model) {
    config.llm.vision.model = config.llm.visionModel;
  }
  return config;
}

/** 只把用户/向导提交的字段写入磁盘，不把环境变量覆盖值落盘 */
export function saveConfig(next) {
  loadConfig();
  fileConfig = deepMerge(fileConfig || {}, next || {});
  persistFileConfig();
  config = null;
  return loadConfig();
}

// ---- helpers ----
function deepMerge(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = target[k] && typeof target[k] === 'object' ? deepMerge(target[k], v) : JSON.parse(JSON.stringify(v));
    } else if (v !== undefined) target[k] = v;
  }
  return target;
}
function setByPath(obj, keys, val) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = val;
}

export const SENSITIVE_FIELDS = new Set([
  'code', 'activationCode', 'machineId', 'b1', 'wbi_img_urls', 'wbiKeys',
  'token', 'localToken', 'password', 'secret', 'apiKey', 'cookie', 'cookies', 'SESSDATA', 'bili_jct',
]);

/** 脱敏: 用于日志/配置展示 */
export function redact(value, key = '') {
  if (typeof value !== 'string') return value;
  if (SENSITIVE_FIELDS.has(key) || key.includes('key') || key.includes('cookie') || key.includes('token')) {
    return value.length <= 8 ? '***' : value.slice(0, 4) + '***' + value.slice(-4);
  }
  return value;
}

export function describeConfig(cfg = loadConfig()) {
  const c = cfg;
  const v = c.llm.vision || {};
  return {
    server: {
      host: c.server.host,
      port: c.server.port,
      auth: c.server.localToken ? 'local-token' : 'none',
    },
    cookies: Object.fromEntries(Object.entries(c.cookies).map(([k, val]) => [k, val ? '已配置(' + val.length + '字符)' : '未配置'])),
    llm: {
      baseUrl: c.llm.baseUrl || '未配置',
      model: c.llm.model || '未配置',
      apiKey: c.llm.apiKey ? '已配置' : '未配置',
      vision: {
        baseUrl: v.baseUrl || '(同文本模型)',
        model: v.model || c.llm.visionModel || '(同 model)',
        apiKey: v.apiKey ? '已配置' : '(同文本模型)',
      },
      visionEnabled: c.llm.visionEnabled !== false,
    },
    youtube: { apiKey: c.youtube.apiKey ? '已配置' : '未配置', ytdlpPath: c.youtube.ytdlpPath || '' },
    asr: {
      enabled: c.asr?.enabled !== false,
      preset: c.asr?.preset || 'auto',
      engine: c.asr?.engine || 'auto',
      language: c.asr?.language || 'zh',
      model: c.asr?.model || '未配置',
      followLlm: c.asr?.followLlm !== false,
      apiKey: c.asr?.apiKey ? '已配置' : (c.asr?.followLlm !== false ? '(跟随文本模型)' : '未配置'),
    },
    crawl: c.crawl,
  };
}
