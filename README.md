# 🌊 DanTide · 弹潮

**本地优先的社交媒体研究助手** —— 每一条弹幕都是一朵浪，DanTide 帮你读出潮水下面的暗流。

粘贴一个 B 站（或 YouTube）链接，自动采集视频详情、评论、弹幕、字幕、音视频文件，并用 AI 生成结构化分析报告。

> 零 npm 依赖 · 纯 Node.js（≥ 20）· 数据全部保存在本机

## 它能做什么

| 能力 | 说明 |
|------|------|
| 🎯 全链路采集 | 详情 / 评论（含楼中楼）/ 弹幕（手写 protobuf 解码）/ 官方字幕 / AI 总结 / 封面 / 音视频（ffmpeg 合并 mp4） |
| 🗣 语音转写 | 没有官方字幕时自动「听写」：本机 FunASR/SenseVoice 或 whisper.cpp（CUDA 加速），中/日/英自动检测 |
| 📦 批量与合集 | UP 主 / 搜索 / 热门 / 每周必看 / 推荐流 / 历史记录；合集支持按板块 + 偏移分批，已采自动跳过；多分 P 全采 |
| 🤖 AI 分析 | 综合分析（视频+弹幕+评论交叉）、词频与时间分布、合集知识报告（知识点地图 + 出题）、关键帧定位与画面识别 |
| 🖼 图片分析 | 网页选图走视觉模型 |
| 🌐 网页与导出 | 本地 Web UI：实时日志、任务进度、取消/重采、播放器、字幕浏览；评论/弹幕导出 CSV/Excel |
| 🔌 MCP | 内置 MCP 服务器（11 个工具），可接入 AI Agent |

## 快速开始

```bash
# Windows: 双击 install.bat（自动检测 Node、建桌面快捷方式并启动）
# 或手动（目录名不影响运行，本地目录仍可为 SMR-Research-Assistant）:
cd SMR-Research-Assistant
node src/main.js
# 打开 http://127.0.0.1:39010
```

首次打开会弹出配置向导：**文本模型**（任意 OpenAI 兼容 API）→ **视觉模型**（可选）→ **B 站 Cookie**（可选但建议）。

```bash
cp config.example.json config.json   # 或直接用向导配置，运行时自动生成
```

详细功能、选项、常见问题见 **[使用手册.md](使用手册.md)**。

## 支持的输入

网页输入框（或 `--crawl`）直接粘贴：

| 输入 | 结果 |
|------|------|
| BV 号 / 视频链接 | 全链路采集；多分 P 串行全采（P1 在根目录，P2 起在 `p02/`…） |
| UP 主空间 | 按播放量/时间批量采该 UP 的视频 |
| 搜索页链接 / 关键词 | 搜索结果批量采集 |
| 热门 / 每周必看 / 推荐 / 历史 | 批量采集 |
| 合集链接 | 按板块 + 偏移 + 批量数量分批；已采自动跳过 |
| YouTube 视频 / 播放列表 / 频道 / 11 位 ID | Data API 采元数据+评论；装 yt-dlp 可下视频与字幕正文 |

## 命令行速查

```bash
node src/main.js --crawl "BV1xx411c7mD"                    # 采集单个视频
node src/main.js --crawl "合集链接" --section 导数 --limit 5 --offset 0
node src/main.js --analyze <任务Id> all                    # LLM 综合分析
node src/main.js --transcribe <任务Id> [--force]           # 语音转写补字幕
node src/main.js --report <合集任务Id> --questions 8       # 合集知识报告
node src/main.js --keyframes <任务Id> --top 5              # 关键帧分析
node src/main.js --list / --status / --delete <任务Id>
```

## 配置速览（config.json）

| 字段 | 作用 |
|------|------|
| `llm.baseUrl / apiKey / model` | 文本模型（任意 OpenAI 兼容 API） |
| `llm.reasoningEffort` | 思考强度 none/low/high/max（如 Ollama Pro） |
| `llm.vision.*` | 视觉模型（图片分析、关键帧画面识别） |
| `cookies.bilibili` | B 站 Cookie（采完整评论/字幕/AI 总结需要） |
| `asr.*` | 语音转写引擎（FunASR / whisper.cpp / 云端 API） |
| `crawl.ffmpegPath` | ffmpeg 路径（合并 mp4、提取音轨） |
| `youtube.apiKey` | YouTube Data API |

全部字段见 [config.example.json](config.example.json)；环境变量注入方式见手册 6.3。

## MCP 服务器

启动后提供 `http://127.0.0.1:39010/mcp`，带 11 个工具：`crawl_bilibili`（及 search/uploader/popular/weekly/recommend 变体）、`crawl_youtube`、`list_archives`、`get_task_data`、`analyze_task`、`transcribe_task`。鉴权用本机令牌（`Authorization: Bearer <server.localToken>` 或 `?token=`）。

## 可选外部工具

均不打包进仓库，按需放置：

| 工具 | 用途 |
|------|------|
| ffmpeg | 音视频合并为 mp4、语音转写提取音轨 |
| whisper.cpp | 本地离线转写（`tools/` 放 `whisper-cli.exe` + ggml 模型） |
| yt-dlp | YouTube 下载视频与字幕正文（`tools/yt-dlp.exe` 或 PATH） |
| FunASR/SenseVoice | 本地转写服务（见 `tools/funasr-server.py`，双击 `tools/启动FunASR.bat`） |

## 目录结构

```
src/
├── main.js            # CLI 与服务入口
├── http.js            # 本地服务（Web UI + API + SSE + MCP）
├── task.js            # 任务队列/状态/取消
├── dispatch.js        # 输入路由（B站 / YouTube）
├── llm.js / asr.js    # LLM 与语音转写客户端
└── platforms/
    ├── bilibili/      # 采集、WBI 签名、弹幕解码、下载、关键帧
    └── youtube/       # Data API 采集、yt-dlp
tools/
└── funasr-server.py   # 本地 SenseVoice 转写服务（可选）
```

## 安全说明

- 服务只监听 `127.0.0.1`，`/api` 与 `/mcp` 校验本机令牌（首次启动自动生成，写入 `config.json` 的 `server.localToken`）
- 请求带随机节奏与退避重试，请勿用于高压抓取
- 密钥/Cookie 写入本地 `config.json`（已被 .gitignore 排除），也可用环境变量注入（见手册 6.3）

## 免责声明

本项目仅供**个人学习与研究**使用。使用者需自行遵守目标平台的服务条款与当地法律法规，并对采集内容的存储与使用负责；请勿将采集的数据用于商业用途或再次分发，勿对目标服务造成压力。项目作者与贡献者不对使用者的行为承担责任。

## License

[MIT](LICENSE)