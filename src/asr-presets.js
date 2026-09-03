// asr-presets.js — 语音转写预设目录（云端 + 本地）
// 只收录能用现有引擎跑通的方案：
//   openai-compat → POST /v1/audio/transcriptions
//   whisper-cpp   → tools/whisper-cli + ggml/gguf
// 阿里云百炼 Qwen-ASR / Fun-ASR 是异步+公网 URL，协议不同，暂不内置。
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const HF_WHISPER = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** @type {Array<object>} */
export const ASR_PRESETS = [
  {
    id: 'off',
    group: 'off',
    label: '关闭语音转写',
    hint: '只采集 B 站官方/UP 字幕。多数视频没有官方字幕。',
    engine: 'off',
    model: '',
    followLlm: false,
  },
  {
    id: 'auto',
    group: 'auto',
    label: '自动（本地优先，否则用已配置的转写 API）',
    hint: '检测到 tools/ 里的 whisper-cli + 模型则走本地；否则用 asr.model + 文本模型/独立 Key 的 /v1/audio/transcriptions。DeepSeek 聊天接口不能转写。',
    engine: 'auto',
    model: '',
    followLlm: true,
  },

  // ---- 云端 ----
  {
    id: 'siliconflow-sensevoice',
    group: 'cloud',
    label: '硅基流动 · SenseVoice Small（中文首选）',
    hint: 'FunAudioLLM/SenseVoiceSmall，中文/粤语明显优于 Whisper。单文件 ≤50MB / 1 小时。若文本模型已是硅基流动，可跟随其 Key；否则请填硅基流动 Key。',
    engine: 'openai-compat',
    model: 'FunAudioLLM/SenseVoiceSmall',
    baseUrl: 'https://api.siliconflow.cn/v1',
    followLlmIf: 'siliconflow',
    timestamps: 'weak',
    chinese: 'excellent',
    needKey: true,
  },
  {
    id: 'siliconflow-telespeech',
    group: 'cloud',
    label: '硅基流动 · TeleSpeechASR',
    hint: 'TeleAI/TeleSpeechASR，同样走硅基流动 /v1/audio/transcriptions。',
    engine: 'openai-compat',
    model: 'TeleAI/TeleSpeechASR',
    baseUrl: 'https://api.siliconflow.cn/v1',
    followLlmIf: 'siliconflow',
    timestamps: 'weak',
    chinese: 'good',
    needKey: true,
  },
  {
    id: 'groq-whisper-turbo',
    group: 'cloud',
    label: 'Groq · Whisper Large V3 Turbo（快，有时间戳）',
    hint: 'https://api.groq.com/openai/v1 ，模型 whisper-large-v3-turbo。约 $0.04/小时音频，单请求约 25MB。中文可用，精度一般低于 SenseVoice。需要 Groq API Key（不要跟 DeepSeek Key 混用）。',
    engine: 'openai-compat',
    model: 'whisper-large-v3-turbo',
    baseUrl: 'https://api.groq.com/openai/v1',
    followLlm: false,
    timestamps: 'good',
    chinese: 'ok',
    needKey: true,
  },
  {
    id: 'groq-whisper-large',
    group: 'cloud',
    label: 'Groq · Whisper Large V3（更准，稍慢）',
    hint: 'whisper-large-v3，比 Turbo 贵（约 $0.11/小时），多语言更稳。需要 Groq API Key。',
    engine: 'openai-compat',
    model: 'whisper-large-v3',
    baseUrl: 'https://api.groq.com/openai/v1',
    followLlm: false,
    timestamps: 'good',
    chinese: 'ok',
    needKey: true,
  },
  {
    id: 'openai-whisper-1',
    group: 'cloud',
    label: 'OpenAI · whisper-1',
    hint: '官方 Whisper API，verbose_json 带时间戳。需要 OpenAI Key。中文不如 SenseVoice。',
    engine: 'openai-compat',
    model: 'whisper-1',
    baseUrl: 'https://api.openai.com/v1',
    followLlm: false,
    timestamps: 'good',
    chinese: 'ok',
    needKey: true,
  },
  {
    id: 'openai-gpt4o-mini',
    group: 'cloud',
    label: 'OpenAI · gpt-4o-mini-transcribe',
    hint: '比 whisper-1 新，可能没有分段时间戳（会整段落一条字幕）。需要 OpenAI Key。',
    engine: 'openai-compat',
    model: 'gpt-4o-mini-transcribe',
    baseUrl: 'https://api.openai.com/v1',
    followLlm: false,
    timestamps: 'weak',
    chinese: 'good',
    needKey: true,
  },
  {
    id: 'openai-gpt4o',
    group: 'cloud',
    label: 'OpenAI · gpt-4o-transcribe',
    hint: 'OpenAI 当前质量较高的转写模型，时间戳支持弱于 whisper-1。需要 OpenAI Key。',
    engine: 'openai-compat',
    model: 'gpt-4o-transcribe',
    baseUrl: 'https://api.openai.com/v1',
    followLlm: false,
    timestamps: 'weak',
    chinese: 'good',
    needKey: true,
  },

  // ---- 本地 ----
  {
    id: 'whisper-cpp-small',
    group: 'local',
    label: '本地 whisper.cpp · small（约 466MB，推荐起步）',
    hint: '把 whisper-cli.exe 和 ggml-small.bin 放到 tools/。中文可用但错字比 SenseVoice 多。完全离线。',
    engine: 'whisper-cpp',
    model: '',
    whisperModel: 'tools/ggml-small.bin',
    whisperFile: 'ggml-small.bin',
    downloadUrl: `${HF_WHISPER}/ggml-small.bin`,
    timestamps: 'good',
    chinese: 'ok',
    size: '466MB',
  },
  {
    id: 'whisper-cpp-small-q5',
    group: 'local',
    label: '本地 whisper.cpp · small-q5_1（约 163MB，省内存）',
    hint: '量化版 small，速度更快、体积更小，中文精度略降。文件 ggml-small-q5_1.bin。',
    engine: 'whisper-cpp',
    model: '',
    whisperModel: 'tools/ggml-small-q5_1.bin',
    whisperFile: 'ggml-small-q5_1.bin',
    downloadUrl: `${HF_WHISPER}/ggml-small-q5_1.bin`,
    timestamps: 'good',
    chinese: 'ok',
    size: '163MB',
  },
  {
    id: 'whisper-cpp-medium',
    group: 'local',
    label: '本地 whisper.cpp · medium（约 1.5GB，更准更慢）',
    hint: '中文会好一些，CPU 上一小时视频可能要很久。文件 ggml-medium.bin。',
    engine: 'whisper-cpp',
    model: '',
    whisperModel: 'tools/ggml-medium.bin',
    whisperFile: 'ggml-medium.bin',
    downloadUrl: `${HF_WHISPER}/ggml-medium.bin`,
    timestamps: 'good',
    chinese: 'ok',
    size: '1.5GB',
  },
  {
    id: 'whisper-cpp-turbo-q5',
    group: 'local',
    label: '本地 whisper.cpp · large-v3-turbo q5（约 547MB，又快又大）',
    hint: 'Whisper 大模型蒸馏版，比 full large 快很多。中文仍不如云端 SenseVoice。文件 ggml-large-v3-turbo-q5_0.bin。',
    engine: 'whisper-cpp',
    model: '',
    whisperModel: 'tools/ggml-large-v3-turbo-q5_0.bin',
    whisperFile: 'ggml-large-v3-turbo-q5_0.bin',
    downloadUrl: `${HF_WHISPER}/ggml-large-v3-turbo-q5_0.bin`,
    timestamps: 'good',
    chinese: 'ok',
    size: '547MB',
  },
  {
    id: 'local-funasr-server',
    group: 'local',
    label: '本机 FunASR / SenseVoice 服务（中文本地首选）',
    hint: '本机已部署：双击 tools/启动FunASR.bat 启动服务（127.0.0.1:8600，SenseVoiceSmall + VAD）。中文 CER 约 8%，同体积 Whisper small 约 22%；语言自动检测，中/日/英/韩/粤语混合均可。音频不离开本机。服务没开时转写会失败，可切换 whisper.cpp 预设。',
    engine: 'openai-compat',
    model: 'sensevoice',
    baseUrl: 'http://127.0.0.1:8600/v1',
    followLlm: false,
    timestamps: 'ok',
    chinese: 'excellent',
    needKey: false,
  },
  {
    id: 'local-openai-stt',
    group: 'local',
    label: '本机其他 OpenAI 兼容转写（faster-whisper / Xinference）',
    hint: '把 faster-whisper-server、Xinference 等指到 http://127.0.0.1:8000/v1 ，并填写它们要求的模型名。可在保存后改模型名。',
    engine: 'openai-compat',
    model: 'whisper-small',
    baseUrl: 'http://127.0.0.1:8000/v1',
    followLlm: false,
    timestamps: 'ok',
    chinese: 'ok',
    needKey: false,
  },
  {
    id: 'custom',
    group: 'custom',
    label: '自定义（自己填引擎 / 地址 / 模型名）',
    hint: '兼容任意 /v1/audio/transcriptions，或本机 whisper-cli。阿里云百炼 Qwen-ASR 是另一套异步接口，目前请用自定义网关或改用上面的 OpenAI 兼容服务。',
    engine: 'openai-compat',
    model: '',
    followLlm: false,
    needKey: true,
  },
];

const GROUP_ORDER = { off: 0, auto: 1, cloud: 2, local: 3, custom: 4 };
const GROUP_LABEL = {
  off: '关闭',
  auto: '自动',
  cloud: '云端模型',
  local: '本地模型',
  custom: '自定义',
};

function toolsHas(file) {
  if (!file) return false;
  try { return fs.existsSync(path.join(ROOT, 'tools', file)); } catch { return false; }
}

export function getAsrPreset(id) {
  return ASR_PRESETS.find((p) => p.id === id) || null;
}

export function listAsrPresets() {
  return ASR_PRESETS.map((p) => ({
    ...p,
    groupLabel: GROUP_LABEL[p.group] || p.group,
    localReady: p.whisperFile ? toolsHas(p.whisperFile) : undefined,
  })).sort((a, b) => (GROUP_ORDER[a.group] - GROUP_ORDER[b.group]) || a.label.localeCompare(b.label, 'zh'));
}

/** 根据预设 + 当前文本模型，算出该写入 config.asr 的字段 */
export function resolvePresetFields(presetId, llm = {}) {
  const p = getAsrPreset(presetId);
  if (!p) return null;
  const llmUrl = String(llm.baseUrl || '');
  let followLlm = p.followLlm === true;
  if (p.followLlmIf === 'siliconflow') {
    followLlm = /siliconflow/i.test(llmUrl);
  }
  return {
    preset: p.id,
    enabled: p.engine !== 'off',
    engine: p.engine,
    model: p.model || '',
    baseUrl: followLlm ? '' : (p.baseUrl || ''),
    followLlm,
    whisperModel: p.whisperModel || '',
    language: 'zh',
  };
}
