"""MiniMax H3 task_type labels and combo options (freeform Qwen prompts — no T5 system prefix)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TaskPromptSpec:
    key: str
    label: str
    system_prompt: str
    description_zh: str


TASK_PROMPT_SPECS: tuple[TaskPromptSpec, ...] = (
    TaskPromptSpec(
        "default",
        "默认通用",
        "",
        "MiniMax H3 使用 Qwen3-VL 自由提示词，无需 T5 系统前缀。",
    ),
    TaskPromptSpec(
        "t2v",
        "文生视频(Text to Video)",
        "",
        "文生音视频；默认可无首帧/参考图。"
        "可开「链式连贯」：第 1 组纯文生；从第 2 组起用上一镜末帧作首帧硬锁定，场景过渡更顺。",
    ),
    TaskPromptSpec(
        "i2v",
        "图生视频(Image to Video)",
        "",
        "参考图生音视频（ReferenceToVideo + 图片1–9 纯参考，不锁首帧）。"
        "可开「链式连贯」：上镜末帧占图片1，用户参考图剩 8 槽；第 1 组可不传首帧。"
        "需要锁首/尾帧请用 fl2v。",
    ),
    TaskPromptSpec(
        "fl2v",
        "首尾帧生视频(First-Last Frame)",
        "",
        "首帧+尾帧约束（ImageToVideo + first_frame + last_frame）。"
        "可开「链式连贯」：后续组默认用上镜末帧作首帧。",
    ),
    TaskPromptSpec(
        "fl_chain",
        "链式首尾帧(Chain Continuity)",
        "",
        "fl2v + 链式连贯常开：第 1 组用上传首帧；之后每组默认以上一组末帧作为本镜首帧，"
        "可选尾帧锁本镜结尾。",
    ),
    TaskPromptSpec(
        "r2v",
        "参考主体生视频(Reference to Video)",
        "",
        "分组参考改视频：每组可上传图片1–9、音频1–3、视频1–3；"
        "可开「链式连贯」后图片1 被首帧占用，用户参考图剩图片2–9。"
        "提示词用 <Picture N> / <Video K> / <Audio J>。",
    ),
    TaskPromptSpec(
        "v2v",
        "视频转视频(Video to Video)",
        "",
        "上传源视频后按时间轴分段编辑；每段源画面作为 <Video 1> 送入 ReferenceToVideo（无参考图槽）。",
    ),
    TaskPromptSpec(
        "rv2v",
        "参考素材改视频(Reference Video Edit)",
        "",
        "源视频时间轴编辑，可选参考图（图片1–9）与参考音频（音频1–3）；"
        "每段源画面为 <Video 1>，参考图用 <Picture N>，参考音频用 <Audio J>；无参考素材时等同 v2v。",
    ),
)

TASK_PROMPT_BY_KEY = {spec.key: spec for spec in TASK_PROMPT_SPECS}
HIDDEN_TASK_TYPE_KEYS: frozenset[str] = frozenset()


def task_type_option_label(spec: TaskPromptSpec) -> str:
    return f"{spec.key} — {spec.label}"


def task_type_combo_options() -> tuple[list[str], dict]:
    options = [
        task_type_option_label(spec)
        for spec in TASK_PROMPT_SPECS
        if spec.key not in HIDDEN_TASK_TYPE_KEYS and spec.key != "default"
    ]
    default_spec = TASK_PROMPT_BY_KEY["t2v"]
    return options, {
        "default": task_type_option_label(default_spec),
        "tooltip": (
            "MiniMax H3 支持 t2v / i2v / fl2v / fl_chain / r2v / v2v / rv2v。"
            "i2v/r2v：参考图纯参考（ReferenceToVideo + <Picture N>）；"
            "fl2v：锁首尾帧（ImageToVideo）；"
            "fl_chain / 链式连贯：上镜末帧默认接力下镜首帧（t2v/i2v/r2v/fl2v 可开关）；"
            "v2v/rv2v：源视频时间轴编辑（自动绑定 <Video 1>）。"
        ),
    }


def resolve_task_key(task_type_value: str) -> str:
    value = task_type_value.split(",[object Object]", 1)[0].strip()
    if " · " in value:
        value = value.split(" · ", 1)[0].strip()
    for sep in (" — ", " —— ", " - ", " – "):
        if sep in value:
            return value.split(sep, 1)[0].strip()
    return value


def get_task_prompt_spec(task_type_value: str) -> TaskPromptSpec:
    key = resolve_task_key(task_type_value)
    return TASK_PROMPT_BY_KEY.get(key, TASK_PROMPT_BY_KEY["default"])


def apply_task_system_prompt(task_type_value: str, positive_prompt: str) -> str:
    """H3 nodes tokenize raw user prompt — no system prefix injection."""
    del task_type_value
    return positive_prompt
