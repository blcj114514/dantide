@echo off
rem FunASR SenseVoice server on port 8600 (OpenAI-compatible /v1/audio/transcriptions)
rem DanTide starts this automatically in service mode; use this bat only for manual runs.
title FunASR SenseVoice Server (8600)
"%~dp0funasr-env\Scripts\python.exe" "%~dp0funasr-server.py"
pause
