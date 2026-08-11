# -*- coding: utf-8 -*-
"""Cloud image generation for Image / First-Last Frame Director (Zhipu / OpenAI-compatible)."""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any

import numpy as np
import torch
from PIL import Image

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.image_gen_api")

API_FORMAT_ZHIPU = "智谱 GLM"
API_FORMAT_OPENAI = "OpenAI Compatible"
DEFAULT_API_FORMAT = API_FORMAT_ZHIPU
DEFAULT_ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4"
DEFAULT_OPENAI_URL = "http://127.0.0.1:8080/v1"
DEFAULT_ZHIPU_MODEL = "cogview-3-flash"
DEFAULT_OPENAI_MODEL = "dall-e-3"

# GLM-Image can take several minutes; downloads from CDN also stall often.
DEFAULT_API_TIMEOUT = 300
DEFAULT_DOWNLOAD_TIMEOUT = 180
DEFAULT_RETRIES = 3

# Common landscape / portrait / square presets for snap
_SIZE_PRESETS = [
    (1024, 1024),
    (1344, 768),
    (768, 1344),
    (1152, 864),
    (864, 1152),
    (1440, 720),
    (720, 1440),
    (1280, 720),
    (720, 1280),
    (1536, 1024),
    (1024, 1536),
]


def default_gen_api_fields() -> dict[str, Any]:
    return {
        "gen_backend": "local",
        "gen_api_format": DEFAULT_API_FORMAT,
        "gen_api_url": DEFAULT_ZHIPU_URL,
        "gen_api_key": "",
        "gen_api_model": DEFAULT_ZHIPU_MODEL,
    }


def normalize_gen_backend(value: str | None) -> str:
    v = str(value or "").strip().lower()
    if v in ("cloud", "api", "remote", "云端", "云端api", "云端 api"):
        return "cloud"
    return "local"


def merge_gen_api_fields(idir: dict) -> dict:
    base = default_gen_api_fields()
    if not isinstance(idir, dict):
        return base
    for k, v in base.items():
        if k not in idir or idir[k] is None:
            idir[k] = v
    idir["gen_backend"] = normalize_gen_backend(idir.get("gen_backend"))
    fmt = str(idir.get("gen_api_format") or DEFAULT_API_FORMAT).strip()
    if fmt not in (API_FORMAT_ZHIPU, API_FORMAT_OPENAI):
        fmt = DEFAULT_API_FORMAT
    idir["gen_api_format"] = fmt
    idir["gen_api_url"] = str(idir.get("gen_api_url") or "").strip() or (
        DEFAULT_ZHIPU_URL if fmt == API_FORMAT_ZHIPU else DEFAULT_OPENAI_URL
    )
    idir["gen_api_key"] = str(idir.get("gen_api_key") or "")
    idir["gen_api_model"] = str(idir.get("gen_api_model") or "").strip() or (
        DEFAULT_ZHIPU_MODEL if fmt == API_FORMAT_ZHIPU else DEFAULT_OPENAI_MODEL
    )
    return idir


def resolve_api_key(api_format: str, widget_key: str = "") -> str:
    key = (widget_key or "").strip()
    if key:
        return key
    if api_format == API_FORMAT_ZHIPU:
        return (
            os.environ.get("ZHIPU_API_KEY", "").strip()
            or os.environ.get("MINIMAX_IMAGE_API_KEY", "").strip()
        )
    return (
        os.environ.get("OPENAI_API_KEY", "").strip()
        or os.environ.get("MINIMAX_IMAGE_API_KEY", "").strip()
    )


def _images_endpoint(url: str, api_format: str) -> str:
    base = (url or "").strip().rstrip("/")
    if not base:
        base = DEFAULT_ZHIPU_URL if api_format == API_FORMAT_ZHIPU else DEFAULT_OPENAI_URL
    low = base.lower()
    if low.endswith("/images/generations"):
        return base
    if low.endswith("/v1") or low.endswith("/v4") or "paas/v4" in low:
        return f"{base}/images/generations"
    if api_format == API_FORMAT_ZHIPU:
        return f"{base}/images/generations"
    return f"{base}/v1/images/generations"


def snap_size(width: int, height: int) -> tuple[int, int]:
    """Snap to nearest preset; keep aspect roughly."""
    w = max(512, min(2048, int(width or 1024)))
    h = max(512, min(2048, int(height or 1024)))
    # align 16
    w = (w // 16) * 16
    h = (h // 16) * 16
    target_ar = w / max(1, h)
    best = min(_SIZE_PRESETS, key=lambda wh: abs(wh[0] / wh[1] - target_ar) + abs(wh[0] - w) * 0.001)
    # Prefer exact custom if within API limits
    if 512 <= w <= 2048 and 512 <= h <= 2048 and (w * h) <= (1 << 21):
        return w, h
    return best


def _pil_to_tensor(img: Image.Image) -> torch.Tensor:
    rgb = img.convert("RGB")
    arr = np.asarray(rgb).astype(np.float32) / 255.0
    return torch.from_numpy(arr).unsqueeze(0)


def _is_timeout(exc: BaseException) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    name = type(exc).__name__.lower()
    msg = str(exc).lower()
    return "timeout" in name or "timed out" in msg or "time out" in msg


def _download_image(url: str, *, timeout: int = DEFAULT_DOWNLOAD_TIMEOUT, retries: int = DEFAULT_RETRIES) -> Image.Image:
    last_exc: BaseException | None = None
    attempts = max(1, int(retries))
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, method="GET", headers={"User-Agent": "ComfyUI-MiniMaxH3-Director/1.0"})
            with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
                data = resp.read()
            return Image.open(io.BytesIO(data))
        except Exception as exc:
            last_exc = exc
            if i + 1 >= attempts or not _is_timeout(exc):
                break
            wait = min(8.0, 1.5 * (i + 1))
            log.warning(
                "Image download timed out (%d/%d), retry in %.1fs: %s",
                i + 1, attempts, wait, url[:120],
            )
            time.sleep(wait)
    assert last_exc is not None
    raise last_exc


def _decode_b64_image(b64: str) -> Image.Image:
    raw = b64
    if "," in raw and raw.strip().lower().startswith("data:"):
        raw = raw.split(",", 1)[1]
    data = base64.b64decode(raw)
    return Image.open(io.BytesIO(data))


def generate_still_via_api(
    *,
    prompt: str,
    api_format: str = DEFAULT_API_FORMAT,
    api_url: str = "",
    api_key: str = "",
    model: str = "",
    width: int = 1024,
    height: int = 576,
    timeout: int = DEFAULT_API_TIMEOUT,
    download_timeout: int | None = None,
    retries: int = DEFAULT_RETRIES,
) -> torch.Tensor:
    """Call cloud images/generations; return IMAGE tensor [1,H,W,3]."""
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("参考图提示词为空，无法生图")

    fmt = str(api_format or DEFAULT_API_FORMAT).strip()
    if fmt not in (API_FORMAT_ZHIPU, API_FORMAT_OPENAI):
        fmt = DEFAULT_API_FORMAT
    key = resolve_api_key(fmt, api_key)
    if not key:
        raise ValueError(
            "云端生图需要 API Key（面板填写，或环境变量 ZHIPU_API_KEY / OPENAI_API_KEY）"
        )

    model = (model or "").strip() or (
        DEFAULT_ZHIPU_MODEL if fmt == API_FORMAT_ZHIPU else DEFAULT_OPENAI_MODEL
    )
    w, h = snap_size(width, height)
    size = f"{w}x{h}"
    endpoint = _images_endpoint(api_url, fmt)
    api_timeout = max(60, int(timeout or DEFAULT_API_TIMEOUT))
    dl_timeout = max(60, int(download_timeout if download_timeout is not None else DEFAULT_DOWNLOAD_TIMEOUT))
    attempts = max(1, int(retries))

    payload: dict[str, Any] = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": 1,
    }
    if fmt == API_FORMAT_ZHIPU:
        payload["watermark_enabled"] = False

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
    }
    log.info(
        "Cloud still gen → %s model=%s size=%s timeout=%ds download=%ds",
        endpoint, model, size, api_timeout, dl_timeout,
    )

    result: dict[str, Any] | None = None
    last_exc: BaseException | None = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=api_timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"云端生图 HTTP {exc.code}: {body or exc.reason}") from exc
        except Exception as exc:
            last_exc = exc
            if i + 1 >= attempts or not _is_timeout(exc):
                raise RuntimeError(
                    f"云端生图失败（生成请求超时/网络错误，已重试 {i + 1}/{attempts}）："
                    f"{type(exc).__name__}: {exc}"
                ) from exc
            wait = min(12.0, 2.0 * (i + 1))
            log.warning("Cloud gen POST timed out (%d/%d), retry in %.1fs", i + 1, attempts, wait)
            time.sleep(wait)
    if result is None:
        assert last_exc is not None
        raise RuntimeError(f"云端生图失败: {type(last_exc).__name__}: {last_exc}") from last_exc

    if isinstance(result, dict) and result.get("error"):
        err = result["error"]
        msg = err.get("message") if isinstance(err, dict) else str(err)
        raise RuntimeError(f"云端生图 API 错误: {msg}")

    data = result.get("data") if isinstance(result, dict) else None
    if not isinstance(data, list) or not data:
        raise RuntimeError(f"云端生图返回无 data：{str(result)[:200]}")

    item = data[0] if isinstance(data[0], dict) else {}
    img: Image.Image | None = None
    if item.get("b64_json"):
        img = _decode_b64_image(str(item["b64_json"]))
    elif item.get("url"):
        try:
            img = _download_image(str(item["url"]), timeout=dl_timeout, retries=attempts)
        except Exception as exc:
            raise RuntimeError(
                f"云端生图已返回 URL，但下载图片超时/失败（可再点②重试，已成功的图会保留）："
                f"{type(exc).__name__}: {exc}"
            ) from exc
    else:
        raise RuntimeError(f"云端生图条目缺少 url/b64_json：{item}")

    return _pil_to_tensor(img)
