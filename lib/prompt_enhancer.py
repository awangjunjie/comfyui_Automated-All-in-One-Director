"""LLM prompt enhancement for Bernini task types (Ollama / Zhipu)."""

from __future__ import annotations

import json
import logging
import os
import re
import urllib.error
import urllib.request

from ..director.prompt_enhance_media import (
    _normalize_reference_tags,
    assemble_replace_rv2v_prompt,
    build_replace_source_target_directive,
    build_replace_structured_json_directive,
    build_user_image_directive,
    build_vision_attachment_banner,
    build_vision_slot_preamble,
    ensure_user_reference_tags,
    filter_vision_for_user_slots,
    is_replace_task_prompt,
    parse_user_reference_slots,
    prepare_llm_vision_images,
)
from .prompt_enhance_templates import (
    DETAILED_MIN_TOTAL_HAN,
    OUTPUT_LANGUAGE_EN,
    build_character_detail_directive,
    build_detailed_retry_suffix,
    count_han_chars,
    format_enhance_user_content,
    is_character_feature_enhance_enabled,
    normalize_output_language,
    resolve_enhance_system_prompt,
    resolve_enhance_template,
    patch_rv2v_vision_intro,
)
from .task_prompts import resolve_task_key

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.prompt_enhancer")

DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434/v1"
DEFAULT_OLLAMA_MODEL = "qwen3.5"
DEFAULT_ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4"
DEFAULT_ZHIPU_MODEL = "glm-5.2"
DEFAULT_OPENAI_COMPAT_URL = "http://127.0.0.1:8080/v1"
API_FORMAT_OLLAMA = "Ollama"
API_FORMAT_ZHIPU = "智谱 GLM"
API_FORMAT_OPENAI_COMPAT = "OpenAI Compatible"
_LEGACY_OPENAI_FORMAT = "OpenAI / vLLM"
DEFAULT_API_FORMAT = API_FORMAT_OLLAMA
OPENAI_COMPAT_MODE_STANDARD = "标准"
OPENAI_COMPAT_MODE_LLAMA_SWAP = "llama-swap"
DEFAULT_OPENAI_COMPAT_MODE = OPENAI_COMPAT_MODE_STANDARD
DEFAULT_OLLAMA_NUM_CTX = int(os.environ.get("BERNINI_PE_OLLAMA_NUM_CTX", "32768"))
MAX_OLLAMA_VISION_IMAGES = int(os.environ.get("BERNINI_PE_OLLAMA_MAX_VISION", "4"))

ZHIPU_FALLBACK_MODELS = [
    "glm-5.2",
    "glm-5.1",
    "glm-5",
    "glm-4.7",
    "glm-4.6",
    "glm-4.6v-flash",
    "glm-4.5v-flash",
    "glm-4-flash-250414",
    "glm-4v-flash",
    "glm-4-plus",
]

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def coerce_llm_url(value, default: str = DEFAULT_OLLAMA_URL) -> str:
    """Accept only http(s) URLs; reject booleans and legacy corrupted widget values."""
    if isinstance(value, str):
        url = value.strip()
        if url and _URL_RE.match(url):
            return url.rstrip("/")
    return default.rstrip("/")


def default_url_for_format(api_format: str) -> str:
    if api_format == API_FORMAT_ZHIPU:
        return DEFAULT_ZHIPU_URL
    if api_format == _LEGACY_OPENAI_FORMAT:
        return DEFAULT_OPENAI_COMPAT_URL
    if api_format == API_FORMAT_OPENAI_COMPAT:
        return DEFAULT_OPENAI_COMPAT_URL
    if api_format == API_FORMAT_OLLAMA:
        return "http://127.0.0.1:11434"
    return DEFAULT_OLLAMA_URL


def default_model_for_format(api_format: str) -> str:
    if api_format == API_FORMAT_ZHIPU:
        return DEFAULT_ZHIPU_MODEL
    return DEFAULT_OLLAMA_MODEL


def normalize_openai_compat_mode(value: str | None = None) -> str:
    mode = str(value or "").strip()
    if mode.lower() == OPENAI_COMPAT_MODE_LLAMA_SWAP:
        return OPENAI_COMPAT_MODE_LLAMA_SWAP
    return OPENAI_COMPAT_MODE_STANDARD


def ollama_native_base(url: str) -> str:
    """Base URL for Ollama native API (/api/chat, /api/tags)."""
    base = coerce_llm_url(url)
    if base.lower().endswith("/v1"):
        return base[:-3].rstrip("/")
    return base


def openai_compat_base(url: str) -> str:
    """Base URL for OpenAI-compatible API (/v1/chat/completions)."""
    base = coerce_llm_url(url)
    if base.lower().endswith("/v1"):
        return base
    return f"{base}/v1"


def openai_compat_root(url: str) -> str:
    """Server root for OpenAI-compatible services that expose side APIs."""
    base = coerce_llm_url(url, default=DEFAULT_OPENAI_COMPAT_URL)
    if base.lower().endswith("/v1"):
        return base[:-3].rstrip("/")
    return base


def zhipu_base(url: str) -> str:
    """Base URL for Zhipu GLM OpenAI-compatible API (/chat/completions, no extra /v1)."""
    base = coerce_llm_url(url, default=DEFAULT_ZHIPU_URL)
    lower = base.lower()
    # 用户若粘贴完整 endpoint，剥掉后缀以免拼成 .../chat/completions/chat/completions
    for suffix in ("/chat/completions", "/completions", "/models"):
        if lower.endswith(suffix):
            base = base[: -len(suffix)].rstrip("/")
            lower = base.lower()
            break
    if lower.endswith("/v1"):
        return base[:-3].rstrip("/")
    return base


def llm_chat_endpoint(url: str, api_format: str) -> str:
    if api_format == API_FORMAT_OLLAMA:
        return f"{ollama_native_base(url)}/api/chat"
    if api_format == API_FORMAT_ZHIPU:
        return f"{zhipu_base(url)}/chat/completions"
    return f"{openai_compat_base(url)}/chat/completions"


def llm_models_endpoint(url: str, api_format: str) -> str:
    if api_format == API_FORMAT_OLLAMA:
        return f"{ollama_native_base(url)}/api/tags"
    if api_format == API_FORMAT_ZHIPU:
        return f"{zhipu_base(url)}/models"
    return f"{openai_compat_base(url)}/models"


def infer_api_format(url: str, explicit: str = DEFAULT_API_FORMAT) -> str:
    if explicit == _LEGACY_OPENAI_FORMAT:
        explicit = API_FORMAT_OPENAI_COMPAT
    if explicit in (API_FORMAT_OLLAMA, API_FORMAT_ZHIPU, API_FORMAT_OPENAI_COMPAT):
        return explicit
    base = coerce_llm_url(url)
    if "bigmodel.cn" in base.lower():
        return API_FORMAT_ZHIPU
    return API_FORMAT_OLLAMA


def llm_unload_endpoint(url: str) -> str:
    return f"{ollama_native_base(url)}/api/generate"


def llama_swap_unload_endpoint(url: str, model: str | None = None) -> str:
    """Endpoint for llama-swap model unload API."""
    from urllib.parse import quote

    base = openai_compat_root(url)
    if model:
        return f"{base}/api/models/unload/{quote(model, safe='')}"
    return f"{base}/api/models/unload"


def coerce_llm_model(value, default: str = DEFAULT_OLLAMA_MODEL) -> str:
    if isinstance(value, str):
        model = value.strip()
        if model and model.lower() not in ("true", "false"):
            # 官方文档偶发笔误 glm-5,2 → glm-5.2
            if re.fullmatch(r"glm-\d+,\d+(?:[a-z0-9.-]*)?", model, flags=re.IGNORECASE):
                model = model.replace(",", ".", 1)
            return model
    return default


def _zhipu_sdk_client(api_key: str):
    """Official SDK: `from zai import ZhipuAiClient`（可选依赖，未安装则返回 None）。"""
    key = (api_key or "").strip()
    if not key:
        return None
    try:
        from zai import ZhipuAiClient  # type: ignore
    except ImportError:
        try:
            from zhipuai import ZhipuAiClient  # type: ignore
        except ImportError:
            return None
    try:
        return ZhipuAiClient(api_key=key)
    except Exception as exc:
        log.debug("ZhipuAiClient init failed: %s", exc)
        return None


def _sdk_message_to_dict(message) -> dict:
    if isinstance(message, dict):
        return message
    if message is None:
        return {}
    if hasattr(message, "model_dump"):
        try:
            dumped = message.model_dump()
            if isinstance(dumped, dict):
                return dumped
        except Exception:
            pass
    return {
        "role": getattr(message, "role", None),
        "content": getattr(message, "content", None) or "",
        "reasoning_content": getattr(message, "reasoning_content", None) or "",
    }


def _zhipu_chat_via_sdk(
    *,
    api_key: str,
    model: str,
    messages: list[dict],
    max_tokens: int,
    temperature: float,
    thinking: str | None,
) -> tuple[dict | None, str | None]:
    """Call official ZhipuAiClient; returns (response_dict, error). None dict = fallback to HTTP."""
    client = _zhipu_sdk_client(api_key)
    if client is None:
        return None, None
    create_kwargs: dict = {
        "model": model,
        "messages": messages,
        "max_tokens": int(max_tokens),
        "temperature": float(temperature),
    }
    if thinking is not None and _zhipu_model_uses_thinking(model):
        think_type = str(thinking or "disabled").strip().lower()
        if think_type not in ("enabled", "disabled"):
            think_type = "disabled"
        create_kwargs["thinking"] = {"type": think_type}
    try:
        response = client.chat.completions.create(**create_kwargs)
    except Exception as exc:
        return None, f"智谱 SDK 调用失败: {type(exc).__name__}: {exc}"

    # 对齐 OpenAI/智谱 HTTP 形状，复用 _extract_llm_raw
    if isinstance(response, dict):
        return response, None
    try:
        if hasattr(response, "model_dump"):
            dumped = response.model_dump()
            if isinstance(dumped, dict):
                return dumped, None
    except Exception:
        pass
    choices = getattr(response, "choices", None) or []
    if not choices:
        return {"choices": []}, None
    choice0 = choices[0]
    message = getattr(choice0, "message", None)
    if message is None and isinstance(choice0, dict):
        message = choice0.get("message")
    return {"choices": [{"message": _sdk_message_to_dict(message)}]}, None


def zhipu_supports_vision(model: str) -> bool:
    """True for Zhipu multimodal models (glm-4v / 4.5v / 4.6v / 5v …)."""
    m = (model or "").lower().replace("_", "-")
    return bool(re.search(r"(?<=\d)(?:\.\d+)?v(?:-|$|[^a-z])", m))


def zhipu_legacy_4v_flash(model: str) -> bool:
    """glm-4v-flash: 1 image max and no Base64 per Zhipu docs."""
    m = (model or "").lower().replace("_", "-")
    if not zhipu_supports_vision(model):
        return False
    return "4v" in m and not re.search(r"4\.(?:5|6)v|5v", m)


def _prepare_zhipu_images(model: str, images: list[str]) -> tuple[list[str], str | None]:
    """Return (images_for_request, error_message)."""
    if not images:
        return [], None
    if not zhipu_supports_vision(model):
        log.info(
            "Zhipu text model %s ignores %d vision image(s); use glm-4.6v-flash for vision enhance",
            model,
            len(images),
        )
        return [], None
    if zhipu_legacy_4v_flash(model):
        return [], (
            "智谱 glm-4v-flash 不支持 Base64 图片。"
            "带参考图/视频帧扩写请改用 glm-4.6v-flash 或 glm-4.5v-flash。"
        )
    if zhipu_legacy_4v_flash(model) is False and "4v-plus" in (model or "").lower():
        return images[:5], None
    return images, None


def _format_zhipu_http_error(status: int, body: str, *, model: str) -> str:
    if status == 400 and "1210" in body and "messages.content.type" in body:
        if not zhipu_supports_vision(model):
            return (
                f"HTTP {status}: 智谱模型 {model} 为纯文本模型，不支持附带图片。"
                "带参考图/视频帧扩写请改用 glm-4.6v-flash；纯文本扩写可用 glm-4-flash-250414。"
            )
        return (
            f"HTTP {status}: 智谱消息格式错误（{body[:200]}）。"
            "请确认使用支持视觉的模型（如 glm-4.6v-flash）。"
        )
    return f"HTTP {status}: {body[:500]}"


def resolve_api_key(api_format: str, widget_key: str = "") -> str:
    key = (widget_key or "").strip()
    if key:
        return key
    if api_format == API_FORMAT_ZHIPU:
        return (
            os.environ.get("ZHIPU_API_KEY", "").strip()
            or os.environ.get("MINIMAX_PE_API_KEY", "").strip()
        )
    return ""


def llm_headers(
    api_format: str = DEFAULT_API_FORMAT,
    *,
    include_json: bool = True,
    api_key: str = "",
) -> dict[str, str]:
    headers: dict[str, str] = {}
    if include_json:
        headers["Content-Type"] = "application/json"
    if api_format != API_FORMAT_OLLAMA:
        key = resolve_api_key(api_format, api_key)
        if key:
            headers["Authorization"] = f"Bearer {key}"
    return headers


def unload_llama_swap_model_sync(
    url: str,
    model: str,
    *,
    api_key: str = "",
    timeout: int = 10,
) -> str | None:
    """Unload a llama-swap model; returns an error string on failure."""
    model = (model or "").strip()
    if not model:
        return "No model selected"
    endpoint = llama_swap_unload_endpoint(url, model)
    try:
        req = urllib.request.Request(
            endpoint,
            data=b"",
            headers=llm_headers(API_FORMAT_OPENAI_COMPAT, include_json=False, api_key=api_key),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if not (200 <= resp.status < 300):
                body = resp.read().decode("utf-8", errors="replace")
                return f"llama-swap HTTP {resp.status}: {body[:200]}"
            resp.read()
        return None
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return f"llama-swap HTTP {exc.code}: {body[:200] or exc.reason}"
    except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError) as exc:
        return f"{type(exc).__name__}: {exc} ({endpoint})"


def _is_openai_new_completion_model(model: str) -> bool:
    model = (model or "").strip().lower()
    return model.startswith(("gpt-5", "o1", "o3", "o4"))


def _zhipu_model_uses_thinking(model: str) -> bool:
    """GLM-5 / 4.7 / 4.6 / 4.5 系列支持 thinking 控制参数。"""
    m = (model or "").strip().lower().replace("_", "-")
    if not m.startswith("glm-"):
        return False
    return bool(re.search(r"glm-(?:5(?:\.\d+)?|4\.[567]|4-7)", m))


def _apply_openai_generation_options(
    payload: dict,
    model: str,
    *,
    max_tokens: int = 2048,
    temperature: float = 0.7,
    api_format: str = "",
    thinking: str | None = None,
) -> None:
    """Apply generation options; for 智谱 GLM also set official `thinking` field."""
    if _is_openai_new_completion_model(model):
        payload["max_completion_tokens"] = max_tokens
    else:
        payload["max_tokens"] = int(max_tokens)
        # 智谱 GLM-5.x 文档默认 temperature=1.0；其它保持调用方传入值
        payload["temperature"] = float(temperature)

    if api_format == API_FORMAT_ZHIPU and _zhipu_model_uses_thinking(model):
        # Official: thinking.type = enabled | disabled
        # 导演扩写默认关闭思考，避免 reasoning 占满 max_tokens 导致 content 为空
        think_type = (thinking or "disabled").strip().lower()
        if think_type not in ("enabled", "disabled"):
            think_type = "disabled"
        payload["thinking"] = {"type": think_type}


def _strip_think_blocks(text: str) -> str:
    """Remove Qwen/DeepSeek-style reasoning wrappers; keep text after closing tag."""
    if not text:
        return ""
    think_close = "</" + "think>"
    think_open = "<" + "think>"
    if think_close in text:
        text = text.rsplit(think_close, 1)[-1]
    text = re.sub(
        re.escape(think_open) + r".*?" + re.escape(think_close),
        "",
        text,
        flags=re.DOTALL | re.IGNORECASE,
    )
    return text.strip()


def _extract_message_text(message: dict, *, final_only: bool = False) -> str:
    if not isinstance(message, dict):
        return ""
    keys = ("content",) if final_only else ("content", "reasoning_content", "thinking")
    for key in keys:
        value = message.get(key)
        if isinstance(value, list):
            parts = []
            for item in value:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    parts.append(str(item.get("text") or item.get("content") or ""))
            value = "".join(parts)
        value = str(value or "").strip()
        if value:
            return _strip_think_blocks(value)
    return ""


def _extract_llm_raw(result: dict, api_format: str, *, final_only: bool = False) -> str:
    if not isinstance(result, dict):
        return ""
    # Nested usage-only mistake: climb if caller passed usage by accident
    if _is_usage_only_obj(result):
        return ""
    if api_format == API_FORMAT_OLLAMA:
        text = _extract_message_text(result.get("message") or {}, final_only=final_only)
        if text:
            return text
        return _strip_think_blocks(str(result.get("response") or ""))
    choices = result.get("choices") or []
    if choices:
        # Prefer last non-empty choice (some gateways append empty trailers)
        texts: list[str] = []
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            text = _extract_message_text(choice.get("message") or {}, final_only=final_only)
            if not text:
                text = _extract_message_text(choice.get("delta") or {}, final_only=final_only)
            if not text and choice.get("text"):
                text = _strip_think_blocks(str(choice.get("text") or ""))
            if text:
                texts.append(text)
        if texts:
            return texts[-1] if final_only else "\n".join(texts)
    # Some gateways put content at top level
    if result.get("output_text"):
        return _strip_think_blocks(str(result.get("output_text") or ""))
    if result.get("content") and not isinstance(result.get("content"), (list, dict)):
        return _strip_think_blocks(str(result.get("content") or ""))
    # Rare: { data: { choices: [...] } }
    data = result.get("data")
    if isinstance(data, dict) and data is not result:
        nested = _extract_llm_raw(data, api_format, final_only=final_only)
        if nested:
            return nested
    return ""


def _empty_llm_preview(result: dict) -> str:
    if not isinstance(result, dict):
        return str(result)[:240]
    usage = result.get("usage") if isinstance(result.get("usage"), dict) else None
    if _is_usage_only_obj(result):
        usage = result
    choices = result.get("choices") or []
    choice0 = choices[0] if choices and isinstance(choices[0], dict) else {}
    msg = choice0.get("message") if isinstance(choice0.get("message"), dict) else {}
    bits = [
        f"keys={list(result.keys())[:12]}",
        f"choices={len(choices)}",
        f"finish={choice0.get('finish_reason')!r}",
        f"content_len={len(str(msg.get('content') or ''))}",
        f"reasoning_len={len(str(msg.get('reasoning_content') or msg.get('thinking') or ''))}",
    ]
    if usage:
        bits.append(
            f"usage(completion={usage.get('completion_tokens')},"
            f"reasoning={(usage.get('completion_tokens_details') or {}).get('reasoning_tokens', usage.get('reasoning_tokens'))})"
        )
    return "; ".join(bits)


def _sanitize_enhanced_prompt(text: str) -> str:
    """Normalize reference tags and strip internal 'slot' wording from LLM output."""
    t = (text or "").strip()
    if not t:
        return t
    t = re.sub(r"@image(\d)(?!\d)", r"image\1", t, flags=re.IGNORECASE)
    t = re.sub(r"reference\s+image(\d)(?!\d)", r"image\1", t, flags=re.IGNORECASE)
    t = re.sub(r"参考\s*slot\s*", "参考图 ", t, flags=re.IGNORECASE)
    t = re.sub(r"\bslot\s*image(\d)\b", r"image\1", t, flags=re.IGNORECASE)
    t = re.sub(r"image(\d)\s*slot\b", r"image\1", t, flags=re.IGNORECASE)
    t = re.sub(r"\bslot\b", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s{2,}", " ", t)
    return _normalize_reference_tags(t)


def _normalize_llm_json_text(text: str) -> str:
    """Normalize extracted *prompt text* (not raw API JSON wire bytes)."""
    if not text:
        return ""
    t = text.replace("\ufeff", "")
    for src, dst in (
        ("\u201c", '"'),
        ("\u201d", '"'),
        ("\u2018", "'"),
        ("\u2019", "'"),
    ):
        t = t.replace(src, dst)
    return t


def _prepare_llm_api_body_text(text: str) -> str:
    """Prepare raw HTTP body for JSON parse. Do NOT rewrite quotes inside strings.

    Chinese model output often contains “ ”；rewriting those to ASCII \" before
    json.loads breaks the wire JSON (premature string termination).
    """
    if not text:
        return ""
    return text.replace("\ufeff", "").replace("\x00", "").strip()


def _body_looks_like_sse(text: str) -> bool:
    s = (text or "").lstrip()
    if not s:
        return False
    if s.lower().startswith("data:"):
        return True
    # At least two line-leading data: events
    n = 0
    for line in text.splitlines():
        if line.strip().lower().startswith("data:"):
            n += 1
            if n >= 2:
                return True
    return False


def _unescape_json_string_fragment(frag: str) -> str:
    """Unescape a JSON string body that may be truncated (no closing quote)."""
    if not frag:
        return ""
    # If complete enough, prefer json.loads
    try:
        return json.loads(f'"{frag}"')
    except json.JSONDecodeError:
        pass
    out: list[str] = []
    i = 0
    n = len(frag)
    while i < n:
        ch = frag[i]
        if ch != "\\" or i + 1 >= n:
            out.append(ch)
            i += 1
            continue
        nxt = frag[i + 1]
        if nxt == "n":
            out.append("\n"); i += 2
        elif nxt == "r":
            out.append("\r"); i += 2
        elif nxt == "t":
            out.append("\t"); i += 2
        elif nxt == '"':
            out.append('"'); i += 2
        elif nxt == "\\":
            out.append("\\"); i += 2
        elif nxt == "/":
            out.append("/"); i += 2
        elif nxt == "u" and i + 5 < n:
            hexpart = frag[i + 2 : i + 6]
            try:
                out.append(chr(int(hexpart, 16)))
                i += 6
            except ValueError:
                out.append(ch)
                i += 1
        else:
            out.append(nxt)
            i += 2
    return "".join(out)


def _recover_chat_content_from_broken_json(text: str) -> dict | None:
    """Best-effort extract choices[0].message.content from truncated/broken JSON."""
    if not text or '"content"' not in text:
        return None
    # Prefer the message.content near choices (avoid matching other content fields)
    patterns = (
        r'"message"\s*:\s*\{[^{}]*?"content"\s*:\s*"',
        r'"delta"\s*:\s*\{[^{}]*?"content"\s*:\s*"',
        r'"content"\s*:\s*"',
    )
    start = -1
    for pat in patterns:
        m = re.search(pat, text)
        if m:
            start = m.end()
            break
    if start < 0:
        return None
    # Scan JSON string until unescaped " or end (truncated)
    chars: list[str] = []
    i = start
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            # count preceding backslashes
            bs = 0
            j = i - 1
            while j >= start and text[j] == "\\":
                bs += 1
                j -= 1
            if bs % 2 == 0:
                break  # closing quote
            chars.append(ch)
            i += 1
            continue
        chars.append(ch)
        i += 1
    content = _unescape_json_string_fragment("".join(chars)).strip()
    if not content:
        return None
    reasoning = ""
    rm = re.search(r'"reasoning_content"\s*:\s*"', text)
    if rm:
        rstart = rm.end()
        rchars: list[str] = []
        i = rstart
        while i < n:
            ch = text[i]
            if ch == '"':
                bs = 0
                j = i - 1
                while j >= rstart and text[j] == "\\":
                    bs += 1
                    j -= 1
                if bs % 2 == 0:
                    break
                rchars.append(ch)
                i += 1
                continue
            rchars.append(ch)
            i += 1
        reasoning = _unescape_json_string_fragment("".join(rchars)).strip()
    message: dict = {"role": "assistant", "content": content}
    if reasoning:
        message["reasoning_content"] = reasoning
    return {"choices": [{"message": message, "finish_reason": "stop"}], "_recovered": True}


def _is_usage_only_obj(obj: dict) -> bool:
    """True for a bare usage blob (no chat payload)."""
    if not isinstance(obj, dict) or not obj:
        return False
    if obj.get("choices") or obj.get("message") or obj.get("response"):
        return False
    if obj.get("content") and not isinstance(obj.get("content"), (list, dict)):
        return False
    keys = set(obj.keys())
    usage_keys = {
        "completion_tokens", "prompt_tokens", "total_tokens",
        "completion_tokens_details", "prompt_tokens_details",
        "reasoning_tokens", "cached_tokens", "knowledge_tokens",
    }
    return bool(keys & usage_keys) and keys <= (usage_keys | {"usage"})


def _chat_result_score(obj: dict) -> int:
    """Higher = more likely the real chat completion payload."""
    if not isinstance(obj, dict):
        return -1
    if _is_usage_only_obj(obj):
        return 0
    score = 1
    if obj.get("choices"):
        score += 10
        choice0 = (obj.get("choices") or [{}])[0] or {}
        msg = choice0.get("message") or choice0.get("delta") or {}
        if isinstance(msg, dict):
            if msg.get("content"):
                score += 20
            if msg.get("reasoning_content") or msg.get("thinking"):
                score += 5
        if choice0.get("text"):
            score += 10
    if obj.get("message") or obj.get("response"):
        score += 8
    if obj.get("output_text"):
        score += 8
    return score


def _merge_stream_choice_objs(objs: list[dict]) -> dict | None:
    """Merge OpenAI/Zhipu SSE stream chunks into one chat-completion-shaped dict."""
    contents: list[str] = []
    reasonings: list[str] = []
    role = "assistant"
    finish_reason = None
    usage = None
    model = None
    for obj in objs:
        if not isinstance(obj, dict):
            continue
        if obj.get("model"):
            model = obj.get("model")
        if isinstance(obj.get("usage"), dict):
            usage = obj.get("usage")
        elif _is_usage_only_obj(obj):
            usage = obj
        for choice in obj.get("choices") or []:
            if not isinstance(choice, dict):
                continue
            finish_reason = choice.get("finish_reason") or finish_reason
            delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else None
            message = choice.get("message") if isinstance(choice.get("message"), dict) else None
            src = delta or message or {}
            if src.get("role"):
                role = str(src.get("role") or role)
            c = src.get("content")
            if isinstance(c, list):
                c = "".join(
                    (i if isinstance(i, str) else str((i or {}).get("text") or (i or {}).get("content") or ""))
                    for i in c
                )
            if c:
                contents.append(str(c))
            r = src.get("reasoning_content") or src.get("thinking")
            if r:
                reasonings.append(str(r))
            if choice.get("text"):
                contents.append(str(choice.get("text") or ""))
    if not contents and not reasonings:
        return None
    message: dict = {"role": role, "content": "".join(contents)}
    if reasonings:
        message["reasoning_content"] = "".join(reasonings)
    out: dict = {"choices": [{"message": message, "finish_reason": finish_reason or "stop"}]}
    if model:
        out["model"] = model
    if usage:
        out["usage"] = usage
    return out


def parse_llm_api_response_body(raw: bytes | str) -> dict:
    """Parse LLM HTTP body that may be plain JSON, NDJSON, or SSE data lines.

    Some OpenAI-compatible / gateway proxies return extra trailing bytes or
    stream-style payloads even when stream=false — strict json.loads then fails.
    Prefer chat payloads with choices over trailing usage-only blobs.
    """
    if isinstance(raw, (bytes, bytearray)):
        text = bytes(raw).decode("utf-8", errors="replace")
    else:
        text = str(raw or "")
    text = _prepare_llm_api_body_text(text)
    if not text:
        raise json.JSONDecodeError("Empty LLM response body", text, 0)

    original = text

    # Only rewrite when the body itself is SSE — never because "data:" appears inside content
    if _body_looks_like_sse(text):
        lines = []
        for line in text.splitlines():
            s = line.strip()
            if not s or s == "[DONE]":
                continue
            if s.lower().startswith("data:"):
                s = s[5:].strip()
            if s and s != "[DONE]":
                lines.append(s)
        if lines:
            text = "\n".join(lines).strip() or text

    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            if _is_usage_only_obj(obj):
                raise json.JSONDecodeError("usage-only root", text, 0)
            return obj
        raise json.JSONDecodeError("LLM response JSON root is not an object", text, 0)
    except json.JSONDecodeError:
        pass

    # Trailing junk after one valid object
    try:
        obj, _end = json.JSONDecoder().raw_decode(text.lstrip())
        if isinstance(obj, dict) and not _is_usage_only_obj(obj):
            return obj
    except json.JSONDecodeError:
        pass

    # NDJSON / concatenated objects / stream chunks
    decoder = json.JSONDecoder()
    idx = 0
    objs: list[dict] = []
    n = len(text)
    while idx < n:
        while idx < n and text[idx].isspace():
            idx += 1
        if idx >= n:
            break
        try:
            obj, end = decoder.raw_decode(text, idx)
        except json.JSONDecodeError:
            nxt = text.find("{", idx + 1)
            if nxt < 0:
                break
            idx = nxt
            continue
        if isinstance(obj, dict):
            objs.append(obj)
        idx = end

    if objs:
        merged = _merge_stream_choice_objs(objs)
        if merged is not None:
            return merged
        best = max(objs, key=_chat_result_score)
        if _chat_result_score(best) > 0:
            return best

    # Truncated / quote-broken JSON: pull message.content directly
    recovered = _recover_chat_content_from_broken_json(text) or _recover_chat_content_from_broken_json(original)
    if recovered is not None:
        return recovered

    preview = original[:180].replace("\n", "\\n")
    raise json.JSONDecodeError(
        f"Cannot parse LLM API JSON (preview={preview!r})",
        original,
        0,
    )


def _decode_json_string_body(body: str) -> str:
    try:
        return json.loads(f'"{body}"')
    except json.JSONDecodeError:
        return (
            body.replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace('\\"', '"')
            .replace("\\\\", "\\")
        )


def _extract_rewritten_text_field(text: str) -> str | None:
    """Extract rewritten_text value with escape-aware scan (tolerates broken JSON)."""
    text = _normalize_llm_json_text(text)
    key_match = re.search(r'"rewritten_text"\s*:\s*"', text, re.IGNORECASE)
    if not key_match:
        return None

    i = key_match.end()
    chunks: list[str] = []
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            if i + 1 < len(text):
                chunks.append(text[i : i + 2])
                i += 2
                continue
            chunks.append(ch)
            i += 1
            continue
        if ch == '"':
            body = "".join(chunks)
            return _decode_json_string_body(body).strip() if body.strip() else None
        chunks.append(ch)
        i += 1

    body = "".join(chunks)
    body = re.sub(r"\s*\}\s*$", "", body).strip()
    if body:
        return _decode_json_string_body(body).strip()

    greedy = re.search(
        r'"rewritten_text"\s*:\s*"(.*)"\s*\}\s*$',
        text,
        re.DOTALL | re.IGNORECASE,
    )
    if greedy and greedy.group(1).strip():
        return _decode_json_string_body(greedy.group(1)).strip()
    return None


def _parse_plain_plus_json_suffix(text: str) -> str | None:
    """When LLM returns plain prompt then a JSON blob, keep the plain part."""
    parts = re.split(r'\n\s*(?=\{\s*"rewritten_text")', text, maxsplit=1, flags=re.IGNORECASE)
    if len(parts) != 2:
        return None
    plain, json_part = parts[0].strip(), parts[1].strip()
    if not plain:
        return None
    from_json = _extract_rewritten_text_field(json_part)
    if from_json and len(plain) >= max(40, int(len(from_json) * 0.4)):
        return plain
    return from_json or plain


def _parse_enhanced_text(raw: str) -> str:
    text = _normalize_llm_json_text(_strip_think_blocks((raw or "").strip()))
    if not text:
        return ""

    mixed = _parse_plain_plus_json_suffix(text)
    if mixed:
        return _sanitize_enhanced_prompt(mixed)

    candidates: list[str] = []
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
    if fence:
        candidates.append(fence.group(1).strip())
    candidates.append(text)

    for block in candidates:
        if not block or "rewritten_text" not in block.lower():
            continue
        extracted = _extract_rewritten_text_field(block)
        if extracted:
            return _sanitize_enhanced_prompt(extracted)
        for payload in (block,):
            obj_match = re.search(r"\{.*\}", payload, re.DOTALL)
            if not obj_match:
                continue
            try:
                parsed = json.loads(obj_match.group(0))
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                rewritten = parsed.get("rewritten_text")
                if isinstance(rewritten, str) and rewritten.strip():
                    return _sanitize_enhanced_prompt(rewritten.strip())

    if not text.lstrip().startswith("{") or "rewritten_text" not in text.lower():
        return _sanitize_enhanced_prompt(text)

    extracted = _extract_rewritten_text_field(text)
    if extracted:
        return _sanitize_enhanced_prompt(extracted)
    return _sanitize_enhanced_prompt(text)


def _parse_replace_structured(raw: str) -> dict | None:
    """Parse split-field replace JSON (frame_subject + imageN_target)."""
    text = _normalize_llm_json_text(_strip_think_blocks((raw or "").strip()))
    if not text:
        return None
    candidates: list[str] = []
    fence = re.search(r"```(?:json)?\s*(.*?)\s*```", text, re.DOTALL | re.IGNORECASE)
    if fence:
        candidates.append(fence.group(1).strip())
    candidates.append(text)
    for block in candidates:
        obj_match = re.search(r"\{.*\}", block, re.DOTALL)
        if not obj_match:
            continue
        try:
            parsed = json.loads(obj_match.group(0))
        except json.JSONDecodeError:
            continue
        if not isinstance(parsed, dict):
            continue
        frame = str(parsed.get("frame_subject") or parsed.get("frame_appearance") or "").strip()
        if not frame:
            continue
        has_target = any(
            str(parsed.get(f"image{i}_target") or "").strip()
            for i in range(5)
        ) or str(parsed.get("reference_target") or parsed.get("image0_target") or "").strip()
        if has_target:
            return parsed
    return None


def _build_user_message(
    formatted_prompt: str,
    images_b64: list[str] | None,
    *,
    api_format: str,
    model: str = "",
) -> dict:
    images = [img for img in (images_b64 or []) if img]

    if api_format == API_FORMAT_ZHIPU:
        images, _ = _prepare_zhipu_images(model, images)

    if not images:
        return {"role": "user", "content": formatted_prompt}

    if api_format == API_FORMAT_OLLAMA:
        clean = []
        for img in images:
            if img.startswith("data:"):
                img = img.split(",", 1)[-1]
            clean.append(img)
        return {"role": "user", "content": formatted_prompt, "images": clean}

    content: list[dict] = []
    for img in images:
        prefix = img if img.startswith("data:") else f"data:image/jpeg;base64,{img}"
        content.append({"type": "image_url", "image_url": {"url": prefix}})
    content.append({"type": "text", "text": formatted_prompt})
    return {"role": "user", "content": content}


def _is_ollama_context_error(body: str) -> bool:
    b = (body or "").lower()
    return "exceed_context_size" in b or "exceeds the available context" in b


def _ollama_vision_plan(attempt: int) -> tuple[int, int, int]:
    """Return (num_ctx, max_images, max_side) for retry attempt index."""
    if attempt <= 0:
        return DEFAULT_OLLAMA_NUM_CTX, MAX_OLLAMA_VISION_IMAGES, 512
    if attempt == 1:
        return max(DEFAULT_OLLAMA_NUM_CTX, 65536), 3, 384
    return max(DEFAULT_OLLAMA_NUM_CTX, 65536), 2, 320


def enhance_prompt_sync(
    *,
    task_type: str,
    user_prompt: str,
    url: str = DEFAULT_OLLAMA_URL,
    model: str = DEFAULT_OLLAMA_MODEL,
    api_format: str = DEFAULT_API_FORMAT,
    openai_compat_mode: str = DEFAULT_OPENAI_COMPAT_MODE,
    api_key: str = "",
    images_b64: list[str] | None = None,
    image_num: int | None = None,
    custom_template: str = "",
    output_language: str = OUTPUT_LANGUAGE_EN,
    character_feature_enhance: bool | str | None = None,
    character_detail_level: str | None = None,
    vision_source_count: int | None = None,
    ref_slots: list[int] | None = None,
    vision_ref_video_count: int = 0,
    unload_after: bool = False,
    timeout: int = 120,
) -> tuple[str | None, str | None]:
    """Rewrite `user_prompt` for `task_type`; returns (text, error_message)."""
    prompt = (user_prompt or "").strip()
    if not prompt or not (model or "").strip():
        return None, "Empty prompt or model"

    base_url = coerce_llm_url(url, default=default_url_for_format(api_format))
    api_format = infer_api_format(base_url, api_format)
    openai_compat_mode = normalize_openai_compat_mode(openai_compat_mode)
    endpoint = llm_chat_endpoint(base_url, api_format)

    if api_format == API_FORMAT_ZHIPU and not resolve_api_key(api_format, api_key):
        return None, "智谱 API Key 未配置（请在面板填写或设置环境变量）"

    src_count = vision_source_count if vision_source_count is not None else 0
    slots = list(ref_slots or [])
    user_slots = parse_user_reference_slots(prompt)
    replace_task = is_replace_task_prompt(prompt)
    vision_images = list(images_b64 or [])

    if vision_images and user_slots and slots:
        vision_images, slots, src_count = filter_vision_for_user_slots(
            vision_images, src_count, slots, user_slots
        )

    directive_slots = list(user_slots)
    if replace_task and not directive_slots and slots:
        directive_slots = list(slots)

    if api_format == API_FORMAT_ZHIPU and vision_images:
        _, zhipu_img_err = _prepare_zhipu_images(model, vision_images)
        if zhipu_img_err:
            return None, zhipu_img_err

    task_key = resolve_task_key(task_type)
    use_replace_structured = (
        replace_task
        and src_count > 0
        and bool(directive_slots)
        and task_key in ("rv2v", "vrc2v")
        and bool(vision_images)
        and not (custom_template or "").strip()
    )
    feature_enhance = is_character_feature_enhance_enabled(
        character_feature_enhance,
        character_detail_level=character_detail_level,
    )
    template = resolve_enhance_template(
        task_key,
        custom_template=custom_template,
        output_language=output_language,
    )
    if (
        task_key in ("rv2v", "vrc2v")
        and vision_images
        and (src_count > 0 or slots)
        and not (custom_template or "").strip()
    ):
        template = patch_rv2v_vision_intro(
            template,
            source_count=src_count,
            ref_slots=slots,
            ref_images_first=False,
            output_language=output_language,
        )
    ref_count = image_num if image_num is not None else max(1, len(vision_images or images_b64 or []))
    if directive_slots and slots:
        ref_count = len(slots) if slots else ref_count
    formatted = format_enhance_user_content(
        template,
        user_prompt=prompt,
        image_num=ref_count,
    )

    preamble = ""
    if vision_images and (src_count > 0 or slots):
        preamble += build_vision_attachment_banner(
            source_count=src_count,
            ref_slots=slots,
            ref_video_count=vision_ref_video_count,
            output_language=output_language,
        )
    detail_directive = build_character_detail_directive(
        feature_enhance,
        output_language=output_language,
        task_key=task_key,
    )
    if detail_directive:
        preamble += detail_directive
    if use_replace_structured:
        preamble += build_replace_structured_json_directive(
            directive_slots,
            output_language=output_language,
            character_feature_enhance=feature_enhance,
        )
    elif replace_task and src_count > 0 and directive_slots:
        preamble += build_replace_source_target_directive(
            directive_slots,
            source_count=src_count,
            output_language=output_language,
        )
    if directive_slots and not use_replace_structured:
        preamble += build_user_image_directive(
            directive_slots,
            output_language,
            character_feature_enhance=feature_enhance,
        )
    if vision_images and (src_count > 0 or slots):
        preamble += build_vision_slot_preamble(
            source_count=src_count,
            ref_slots=slots,
            ref_video_count=vision_ref_video_count,
            ref_images_first=False,
            output_language=output_language,
        )
    if preamble:
        formatted = preamble + formatted

    detailed_mode = feature_enhance and bool(detail_directive)
    if detailed_mode:
        log.info(
            "Prompt enhance character feature enhance (%s): min_han=%d",
            task_key,
            DETAILED_MIN_TOTAL_HAN,
        )

    if api_format == API_FORMAT_OLLAMA and "qwen" in model.lower() and not detailed_mode:
        formatted = f"{formatted}\n/no_think"

    system_prompt = resolve_enhance_system_prompt(
        task_key,
        custom_template=custom_template,
        output_language=output_language,
    )
    if normalize_output_language(output_language) == "zh":
        if replace_task and src_count > 0 and slots:
            system_prompt += (
                " 替换任务：「将视频中…」只写源视频 frame 附件里待替换对象的现行外观；"
                "「imageN 中的…」只写参考图 imageN 附件里的目标外观；二者禁止对调。"
            )
        elif directive_slots or feature_enhance:
            system_prompt += (
                " 扩写正文须为简体中文；保留 image0、image1、frame0 等英文编号。"
                "若用户指定 @imageN：「将视频中…」只写 frame 待替换对象；"
                "「imageN 中的…」只写参考图目标外观；禁止对调混用。"
            )
        if detailed_mode:
            system_prompt += (
                f" 角色特征增强已开启：imageN 外观须逐条可对照参考图，总汉字≥{DETAILED_MIN_TOTAL_HAN}；"
                "参考图是什么风格写什么风格，禁止文学臆造。"
            )
    elif detailed_mode:
        system_prompt += (
            " Character feature enhance: long character appearance from reference image is required."
        )

    def _run_chat(
        vision_images: list[str] | None,
        *,
        num_ctx: int,
        prompt_text: str,
        temperature: float = 0.7,
        num_predict: int | None = None,
    ) -> tuple[dict | None, str | None]:
        if api_format == API_FORMAT_OLLAMA and "qwen" in model.lower():
            user_content = f"{prompt_text}\n/no_think"
        else:
            user_content = prompt_text
        if api_format == API_FORMAT_OLLAMA:
            options: dict = {"temperature": temperature, "num_ctx": num_ctx}
            if num_predict is not None:
                options["num_predict"] = num_predict
            payload: dict = {
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    _build_user_message(user_content, vision_images, api_format=api_format, model=model),
                ],
                "stream": False,
                "think": False,
                "options": options,
            }
            if unload_after:
                payload["keep_alive"] = 0
        else:
            payload = {
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    _build_user_message(user_content, vision_images, api_format=api_format, model=model),
                ],
                "stream": False,
            }
            _apply_openai_generation_options(
                payload,
                model,
                max_tokens=num_predict or (4096 if detailed_mode else 2048),
                temperature=temperature,
                api_format=api_format,
                thinking="disabled",
            )
        try:
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload).encode("utf-8"),
                headers=llm_headers(api_format, include_json=True, api_key=api_key),
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return parse_llm_api_response_body(resp.read()), None
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:500]
            if api_format == API_FORMAT_ZHIPU:
                msg = _format_zhipu_http_error(exc.code, body, model=model)
            else:
                msg = f"HTTP {exc.code} {endpoint}: {body or exc.reason}"
            return None, msg
        except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError, json.JSONDecodeError, KeyError) as exc:
            return None, f"{type(exc).__name__}: {exc} ({endpoint})"

    def _invoke_llm(
        prompt_text: str,
        *,
        temperature: float = 0.7,
        num_predict: int | None = None,
    ) -> tuple[dict | None, str | None]:
        if api_format == API_FORMAT_OLLAMA and vision_images:
            last: tuple[dict | None, str | None] = (None, None)
            for attempt in range(3):
                num_ctx, max_images, max_side = _ollama_vision_plan(attempt)
                vision = prepare_llm_vision_images(
                    list(vision_images),
                    max_images=max_images,
                    max_side=max_side,
                )
                last = _run_chat(
                    vision,
                    num_ctx=num_ctx,
                    prompt_text=prompt_text,
                    temperature=temperature,
                    num_predict=num_predict,
                )
                if last[0] is not None:
                    return last
                if not last[1] or not _is_ollama_context_error(last[1]):
                    return last
                log.warning(
                    "Ollama context exceeded (attempt %d/3), retry num_ctx=%d max_images=%d",
                    attempt + 1,
                    num_ctx,
                    max_images,
                )
            if last[1] and _is_ollama_context_error(last[1]):
                return None, (
                    f"{last[1]} "
                    f"（已自动放大 num_ctx 并压缩 Vision 图片仍不足；"
                    f"可设环境变量 BERNINI_PE_OLLAMA_NUM_CTX=65536，"
                    f"或减少参考图/源视频帧，或换更小 Vision 模型）"
                )
            return last
        num_ctx = DEFAULT_OLLAMA_NUM_CTX if api_format == API_FORMAT_OLLAMA else 0
        vision = vision_images
        if api_format == API_FORMAT_OLLAMA and vision:
            vision = prepare_llm_vision_images(list(vision))
        return _run_chat(
            vision,
            num_ctx=num_ctx or DEFAULT_OLLAMA_NUM_CTX,
            prompt_text=prompt_text,
            temperature=temperature,
            num_predict=num_predict,
        )

    chat_prompt = formatted
    last_err: str | None = None
    last_han = 0
    max_passes = 3 if detailed_mode else (2 if use_replace_structured else 1)
    num_predict = 4096 if (detailed_mode or use_replace_structured) else None
    for enhance_pass in range(max_passes):
        pass_temperature = 0.7 if enhance_pass == 0 else min(0.85 + enhance_pass * 0.05, 0.95)
        result, last_err = _invoke_llm(
            chat_prompt,
            temperature=pass_temperature,
            num_predict=num_predict,
        )
        if result is None:
            log.warning("Prompt enhance failed (%s): %s", task_key, last_err)
            return None, last_err

        if isinstance(result, dict) and result.get("error"):
            err = result["error"]
            err_msg = err.get("message") if isinstance(err, dict) else str(err)
            return None, f"LLM API error: {err_msg}"

        raw = _extract_llm_raw(result, api_format)
        parsed = ""
        if use_replace_structured:
            structured = _parse_replace_structured(raw)
            if structured:
                parsed = assemble_replace_rv2v_prompt(
                    structured,
                    directive_slots,
                    output_language=output_language,
                )
                if parsed:
                    log.info("Prompt enhance: assembled replace prompt from structured JSON")
        if not parsed:
            parsed = _parse_enhanced_text(raw)
        if not parsed:
            log.warning(
                "Prompt enhance empty parse (%s, %s): raw_len=%d keys=%s structured=%s",
                task_key,
                model,
                len(raw or ""),
                list(result.keys()) if isinstance(result, dict) else type(result).__name__,
                use_replace_structured,
            )
            if use_replace_structured and enhance_pass + 1 < max_passes:
                chat_prompt = (
                    formatted
                    + "\n\n【错误】必须返回 JSON，含 frame_subject 与 image"
                    f"{directive_slots[0]}_target，禁止 rewritten_text。"
                    "frame_subject 只写 frame 图；imageN_target 只写 imageN 图，禁止对调。"
                )
                continue
            if not (raw or "").strip():
                hint = (
                    "LLM 返回内容为空。"
                    "若使用 qwen3 等思考模型，请升级 Ollama 或换用 glm-4-flash / qwen2.5 等非思考模型。"
                )
                return None, hint
            return None, f"LLM 返回无法解析（前 120 字）：{(raw or '')[:120]}"

        parsed = ensure_user_reference_tags(parsed, user_slots or directive_slots)
        han = count_han_chars(parsed)
        last_han = han
        if detailed_mode:
            log.info("Prompt enhance result (%s pass %d): %d han", task_key, enhance_pass + 1, han)

        if detailed_mode and han < DETAILED_MIN_TOTAL_HAN and enhance_pass + 1 < max_passes:
            log.warning(
                "Detailed enhance too short (%d < %d han), retrying (pass %d/%d)",
                han,
                DETAILED_MIN_TOTAL_HAN,
                enhance_pass + 1,
                max_passes,
            )
            chat_prompt = formatted + build_detailed_retry_suffix(
                current_han=han,
                output_language=output_language,
            )
            continue

        if detailed_mode and han < DETAILED_MIN_TOTAL_HAN:
            log.warning(
                "Detailed enhance still below target (%d < %d han)",
                han,
                DETAILED_MIN_TOTAL_HAN,
            )
        if (
            unload_after
            and api_format == API_FORMAT_OPENAI_COMPAT
            and openai_compat_mode == OPENAI_COMPAT_MODE_LLAMA_SWAP
        ):
            unload_err = unload_llama_swap_model_sync(
                base_url,
                model,
                api_key=api_key,
                timeout=min(max(timeout, 1), 10),
            )
            if unload_err:
                log.warning("llama-swap unload failed after enhance: %s", unload_err)
        return parsed, None

    return None, last_err or f"LLM enhance failed (last {last_han} han)"


def llm_chat_text_sync(
    *,
    system_prompt: str,
    user_prompt: str,
    url: str = DEFAULT_OLLAMA_URL,
    model: str = DEFAULT_OLLAMA_MODEL,
    api_format: str = DEFAULT_API_FORMAT,
    api_key: str = "",
    max_tokens: int = 2048,
    temperature: float = 0.6,
    timeout: int = 300,
    thinking: str | None = None,
) -> tuple[str | None, str | None]:
    """Plain text chat (no vision / enhance templates). Returns (text, error).

    For 智谱 GLM-5.x，请求体对齐官方 chat/completions：
    messages + thinking + max_tokens + temperature + stream=false。
    导演扩写默认 thinking=disabled，避免思考过程占满输出额度。
    """
    system = (system_prompt or "").strip()
    user = (user_prompt or "").strip()
    model = coerce_llm_model(model)
    if not user or not model:
        return None, "Empty prompt or model"
    if not system:
        return None, "Empty system prompt"

    base_url = coerce_llm_url(url, default=default_url_for_format(api_format))
    api_format = infer_api_format(base_url, api_format)
    endpoint = llm_chat_endpoint(base_url, api_format)

    if api_format == API_FORMAT_ZHIPU and not resolve_api_key(api_format, api_key):
        return None, "智谱 API Key 未配置（请在面板填写或设置环境变量 ZHIPU_API_KEY）"

    # 智谱思考模型：默认关思考；若开启则抬高 max_tokens 给 reasoning+正文留空间
    think_mode = thinking
    if api_format == API_FORMAT_ZHIPU and _zhipu_model_uses_thinking(model):
        think_mode = (thinking or "disabled").strip().lower() or "disabled"
        if think_mode == "enabled" and int(max_tokens) < 8192:
            max_tokens = 8192

    user_content = user
    if api_format == API_FORMAT_OLLAMA and "qwen" in model.lower():
        user_content = f"{user}\n/no_think"

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_content},
    ]

    # 智谱：若已安装官方 SDK（zai / zhipuai），优先走与文档一致的 ZhipuAiClient
    if api_format == API_FORMAT_ZHIPU:
        sdk_result, sdk_err = _zhipu_chat_via_sdk(
            api_key=resolve_api_key(api_format, api_key),
            model=model,
            messages=messages,
            max_tokens=int(max_tokens),
            temperature=float(temperature),
            thinking=think_mode,
        )
        if sdk_err:
            return None, sdk_err
        if sdk_result is not None:
            result = sdk_result
            raw = _extract_llm_raw(result, api_format, final_only=True)
            text = _strip_think_blocks(raw or "").strip()
            if not text:
                raw = _extract_llm_raw(result, api_format, final_only=False)
                text = _strip_think_blocks(raw or "").strip()
            if not text:
                preview = _empty_llm_preview(result)
                return None, f"LLM 返回内容为空（{preview}）"
            return text, None

    if api_format == API_FORMAT_OLLAMA:
        payload: dict = {
            "model": model,
            "messages": messages,
            "stream": False,
            "think": False,
            "options": {
                "temperature": float(temperature),
                "num_ctx": DEFAULT_OLLAMA_NUM_CTX,
                "num_predict": int(max_tokens),
            },
        }
    else:
        # 对齐智谱官方示例：model / messages / stream / max_tokens / temperature [/ thinking]
        payload = {
            "model": model,
            "messages": messages,
            "stream": False,
        }
        _apply_openai_generation_options(
            payload,
            model,
            max_tokens=int(max_tokens),
            temperature=float(temperature),
            api_format=api_format,
            thinking=think_mode,
        )

    try:
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers=llm_headers(api_format, include_json=True, api_key=api_key),
        )
        with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
            result = parse_llm_api_response_body(resp.read())
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        if api_format == API_FORMAT_ZHIPU:
            return None, _format_zhipu_http_error(exc.code, body, model=model)
        return None, f"HTTP {exc.code} {endpoint}: {body or exc.reason}"
    except (urllib.error.URLError, TimeoutError, ConnectionResetError, OSError, json.JSONDecodeError) as exc:
        return None, f"{type(exc).__name__}: {exc} ({endpoint})"

    if isinstance(result, dict) and result.get("error"):
        err = result["error"]
        err_msg = err.get("message") if isinstance(err, dict) else str(err)
        return None, f"LLM API error: {err_msg}"

    # 只要最终正文，不要把 reasoning_content 当成提示词
    raw = _extract_llm_raw(result, api_format, final_only=True)
    text = _strip_think_blocks(raw or "").strip()
    if not text:
        # 若关了思考仍无 content，再兜底看 reasoning（少数网关把答案放错字段）
        raw = _extract_llm_raw(result, api_format, final_only=False)
        text = _strip_think_blocks(raw or "").strip()
    if not text:
        preview = _empty_llm_preview(result)
        return None, f"LLM 返回内容为空（{preview}）"
    return text, None


async def list_llm_models(
    url: str,
    api_format: str = DEFAULT_API_FORMAT,
    *,
    api_key: str = "",
) -> tuple[list[str], str | None]:
    """Return (model_ids, error_message)."""
    import aiohttp

    base = coerce_llm_url(url, default=default_url_for_format(api_format))
    api_format = infer_api_format(base, api_format)
    try:
        async with aiohttp.ClientSession() as session:
            endpoint = llm_models_endpoint(base, api_format)
            if api_format == API_FORMAT_OLLAMA:
                async with session.get(
                    endpoint,
                    timeout=aiohttp.ClientTimeout(total=10),
                ) as resp:
                    if resp.status != 200:
                        text = await resp.text()
                        return [], f"Ollama HTTP {resp.status}: {text[:200]}"
                    raw_text = await resp.text()
                    try:
                        data = parse_llm_api_response_body(raw_text)
                    except json.JSONDecodeError as exc:
                        return [], f"Ollama JSON 解析失败: {exc}"
                models = sorted(m.get("name", "") for m in data.get("models", []) if m.get("name"))
                return models, None

            if api_format == API_FORMAT_ZHIPU and not resolve_api_key(api_format, api_key):
                return list(ZHIPU_FALLBACK_MODELS), None

            async with session.get(
                endpoint,
                headers=llm_headers(api_format, include_json=False, api_key=api_key),
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    if api_format == API_FORMAT_ZHIPU:
                        return list(ZHIPU_FALLBACK_MODELS), None
                    return [], f"HTTP {resp.status}: {text[:200]}"
                raw_text = await resp.text()
                try:
                    data = parse_llm_api_response_body(raw_text)
                except json.JSONDecodeError as exc:
                    if api_format == API_FORMAT_ZHIPU:
                        return list(ZHIPU_FALLBACK_MODELS), None
                    return [], f"模型列表 JSON 解析失败: {exc}"
            models = sorted(m.get("id", "") for m in data.get("data", []) if m.get("id"))
            if not models and api_format == API_FORMAT_ZHIPU:
                return list(ZHIPU_FALLBACK_MODELS), None
            return models, None
    except Exception as exc:
        if api_format == API_FORMAT_ZHIPU:
            return list(ZHIPU_FALLBACK_MODELS), None
        return [], f"{type(exc).__name__}: {exc}"
