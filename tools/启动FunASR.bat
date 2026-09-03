@echo off
rem 启动本地 FunASR(SenseVoice) 转写服务（OpenAI 兼容 /v1/audio/transcriptions）
rem 默认端口 8600，可用环境变量 FUNASR_PORT 覆盖
rem SMR 采集时若配置了 asr.baseUrl=http://127.0.0.1:8600/v1 会自动调用
title FunASR SenseVoice Server (8600)
"%~dp0funasr-env\Scripts\python.exe" "%~dp0funasr-server.py"
pause