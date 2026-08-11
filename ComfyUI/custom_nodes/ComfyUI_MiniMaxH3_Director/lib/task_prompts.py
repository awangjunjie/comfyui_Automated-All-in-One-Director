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
        "novel",
        "小说章节(Novel Chapters)",
        "",
        "短剧向：导入小说按章节分镜，节奏紧、镜多对白密；"
        "提示词导演拆镜 + 全局人物/场景参考图库自动挂槽，"
        "底层走 ReferenceToVideo（与 r2v 同管线）；支持进度保存与续跑。",
    ),
    TaskPromptSpec(
        "film",
        "电影模式(Film Mode)",
        "",
        "电影向：独立于小说短剧；镜少而长、电影镜头语法与留白；"
        "同样支持导入章节、资产库、分镜挂图与续跑，底层走 ReferenceToVideo。",
    ),
    TaskPromptSpec(
        "m2v",
        "动作迁移(Motion Transfer)",
        "",
        "动作迁移：媒体轨上传单路动作视频（可预览/裁切/均分），参考图锁定角色外观。"
        "整局默认按视频时长生成，分镜按均分时长；秒数均可手调。"
        "提示词点名「视频1 负责动作，图片1 负责人物」，少描写动作细节。"
        "底层走 ReferenceToVideo（与 r2v 同管线）。",
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
            "MiniMax H3 支持 t2v / i2v / fl2v / fl_chain / r2v / novel / film / m2v / v2v / rv2v。"
            "i2v/r2v/novel/film：参考图纯参考（ReferenceToVideo + <Picture N>）；"
            "novel：短剧向章节流水线；film：电影向独立流水线；"
            "m2v：动作迁移（参考视频定动作 + 参考图定角色，底层同 r2v）；"
            "fl2v：锁首尾帧（ImageToVideo）；"
            "fl_chain / 链式连贯：上镜末帧默认接力下镜首帧（t2v/i2v/r2v/novel/film/fl2v 可开关）；"
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


R2V_LIKE_KEYS = frozenset({"r2v", "m2v", "novel", "film"})
NOVEL_LIKE_KEYS = frozenset({"novel", "film"})


def is_r2v_like(task_type_value: str) -> bool:
    """r2v / novel / film / m2v share the ReferenceToVideo pipeline."""
    return resolve_task_key(task_type_value) in R2V_LIKE_KEYS


def is_novel_task(task_type_value: str) -> bool:
    return resolve_task_key(task_type_value) == "novel"


def is_film_task(task_type_value: str) -> bool:
    return resolve_task_key(task_type_value) == "film"


def is_novel_like(task_type_value: str) -> bool:
    """小说短剧与电影模式共用章节流水线，但是独立任务入口。"""
    return resolve_task_key(task_type_value) in NOVEL_LIKE_KEYS


def pipeline_task_key(task_type_value: str) -> str:
    """Map product aliases to the executor pipeline key (novel/film → r2v)."""
    key = resolve_task_key(task_type_value)
    if key in NOVEL_LIKE_KEYS:
        return "r2v"
    return key


def is_motion_transfer(task_type_value: str) -> bool:
    return resolve_task_key(task_type_value) == "m2v"


def get_task_prompt_spec(task_type_value: str) -> TaskPromptSpec:
    key = resolve_task_key(task_type_value)
    return TASK_PROMPT_BY_KEY.get(key, TASK_PROMPT_BY_KEY["default"])


def apply_task_system_prompt(task_type_value: str, positive_prompt: str) -> str:
    """H3 nodes tokenize raw user prompt — no system prefix injection."""
    del task_type_value
    return positive_prompt
