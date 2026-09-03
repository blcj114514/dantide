# -*- coding: utf-8 -*-
# funasr-server.py — 本地 SenseVoice 转写服务（OpenAI 兼容 /v1/audio/transcriptions）
# 供 SMR asr.js 的 openai-compat 引擎调用。
# 启动: tools\funasr-env\Scripts\python.exe tools\funasr-server.py（或双击 tools\启动FunASR.bat，
#       需先在同目录建好 funasr-env 虚拟环境并安装 funasr/fastapi/uvicorn/soundfile/torch）
# 端口: 8600（可用环境变量 FUNASR_PORT 改）。首次启动会从 ModelScope 下载 SenseVoiceSmall + fsmn-vad（约 1GB）。
# 语言自动检测（中/日/英/韩/粤语混合输入均可，无需改配置）。
# 时间轴：先 VAD 切段，再逐段转写，每段返回真实起止秒数。

import os
import re
import tempfile
import time

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI()

PORT = int(os.environ.get("FUNASR_PORT", "8600"))
DEVICE = os.environ.get("FUNASR_DEVICE", "cpu")

sv_model = None
vad_model = None

TAG_RE = re.compile(r"<\|[^|]*\|>")


def load_models():
    global sv_model, vad_model
    from funasr import AutoModel
    print("[funasr-server] 正在加载 SenseVoiceSmall + fsmn-vad（首次会下载模型）…", flush=True)
    sv_model = AutoModel(
        model="iic/SenseVoiceSmall",
        device=DEVICE,
        hub="ms",
        disable_update=True,
    )
    vad_model = AutoModel(
        model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        vad_kwargs={"max_single_segment_time": 10000},
        device=DEVICE,
        hub="ms",
        disable_update=True,
    )
    print("[funasr-server] 模型加载完成", flush=True)


def clean_text(t: str) -> str:
    from funasr.utils.postprocess_utils import rich_transcription_postprocess
    return rich_transcription_postprocess(TAG_RE.sub("", t or "")).strip()


def read_audio(path: str):
    import numpy as np
    import soundfile as sf
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16000:
        import torch
        import torchaudio.functional as AF
        mono = AF.resample(torch.from_numpy(mono), sr, 16000).numpy()
        sr = 16000
    return mono, sr


def vad_segments(mono, sr):
    """返回 [(start_sec, end_sec), ...]，VAD 无结果时退回整段；超过 15s 的段定长切分。"""
    import soundfile as sf
    MAX_SPAN = 15.0
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        sf.write(tmp, mono, 16000)
        res = vad_model.generate(input=tmp, max_single_segment_time=10000)
        value = (res[0] or {}).get("value") if res else None
        segs = []
        for pair in value or []:
            try:
                b, e = float(pair[0]) / 1000.0, float(pair[1]) / 1000.0
                if e <= b:
                    continue
                # 长段定长切分（VAD 偶发长首段时保证字幕粒度）
                if e - b > MAX_SPAN:
                    n = int((e - b) // MAX_SPAN) + 1
                    step = (e - b) / n
                    for i in range(n):
                        segs.append((b + i * step, e if i == n - 1 else b + (i + 1) * step))
                else:
                    segs.append((b, e))
            except Exception:
                continue
        return segs or [(0.0, len(mono) / 16000.0)]
    finally:
        try:
            if tmp:
                os.unlink(tmp)
        except Exception:
            pass


def transcribe_to_segments(path: str):
    import numpy as np
    import soundfile as sf

    mono, sr = read_audio(path)
    spans = vad_segments(mono, sr)

    slice_files = []
    slice_spans = []
    for (b, e) in spans:
        i0 = max(0, int(b * sr))
        i1 = min(len(mono), int(e * sr) + 1)
        if i1 - i0 < sr // 20:  # <50ms 丢弃
            continue
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        sf.write(tmp, mono[i0:i1], sr)
        slice_files.append(tmp)
        slice_spans.append((b, e))

    segs = []
    try:
        if slice_files:
            results = sv_model.generate(
                input=slice_files, cache={}, language="auto",
                use_itn=True, batch_size_s=60,
            )
            if results and not isinstance(results[0], list) and len(results) == 1 and len(slice_files) > 1:
                # 某些版本单输入返回合并结果；此时退化为整段
                text = clean_text(results[0].get("text", ""))
                if text:
                    segs.append({"start": round(slice_spans[0][0], 3),
                                 "end": round(slice_spans[-1][1], 3), "text": text})
            else:
                for (b, e), r in zip(slice_spans, results or []):
                    text = clean_text((r or {}).get("text", ""))
                    if text:
                        segs.append({"start": round(b, 3), "end": round(e, 3), "text": text})
    finally:
        for t in slice_files:
            try:
                os.unlink(t)
            except Exception:
                pass

    if not segs:
        return [], ""
    full = "".join(s["text"] for s in segs).strip()
    return segs, full


@app.on_event("startup")
async def startup():
    load_models()


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": "sensevoice", "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcriptions(
    file: UploadFile = File(...),
    model_name: str = Form("", alias="model"),
    response_format: str = Form("verbose_json"),
    language: str = Form("auto"),
):
    tmp_path = None
    try:
        fd, tmp_path = tempfile.mkstemp(suffix=ext_of(file))
        os.close(fd)
        with open(tmp_path, "wb") as f:
            f.write(await file.read())
        t0 = time.time()
        segs, full = transcribe_to_segments(tmp_path)
        took = round(time.time() - t0, 2)
        print(f"[funasr-server] 转写完成 {os.path.basename(file.filename or '')} "
              f"({len(segs)} 段, {took}s)", flush=True)
        return {
            "text": full,
            "segments": [
                {"id": i, "start": s["start"], "end": s["end"], "text": s["text"]}
                for i, s in enumerate(segs)
            ],
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"error": {"message": str(e)}})
    finally:
        try:
            if tmp_path:
                os.unlink(tmp_path)
        except Exception:
            pass


def ext_of(uploadfile) -> str:
    name = uploadfile.filename or "audio.wav"
    ext = os.path.splitext(name)[1].lower()
    return ext if ext in (".wav", ".mp3", ".m4a", ".flac", ".ogg", ".mp4") else ".wav"


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")