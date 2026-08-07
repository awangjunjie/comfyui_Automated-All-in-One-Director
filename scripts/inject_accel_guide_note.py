# -*- coding: utf-8 -*-
"""Inject / refresh a MarkdownNote explaining desk + acceleration usage."""

from __future__ import annotations

import json
from pathlib import Path

NOTE_TITLE = "导演台 · 使用流程"
NOTE_MARKER = "导演台使用流程"
LEGACY_TITLES = ("加速节点 · 使用流程", "加速节点使用流程")

NOTE_MD = """## 导演台使用流程

节点名：**MiniMax H3 导演台（完整版）**  
展开节点下方 **导演台** 面板即可编排。

提示词规范已对齐官方 h3-prompt-writing（中文字段输出）。

### 推荐总流程
1. 选好任务类型（t2v / fl2v / fl_chain / r2v / v2v / rv2v）与模型
2. **连续性**：填角色 / 场景 / 道具
3. **全局声景**：写风格、声景、配乐（可选）
4. **提示词导演**：选风格 Skill → 故事 → 分镜提示词
5. **参考图导演 / 首尾帧导演**：出参考图或首尾帧并注入
6. 时间线微调 → **Queue**

### ③ 提示词导演（重点）
1. 本地 GGUF 或云端 API
2. **风格 Skill**：通用 / 极简产品广告 / 3D动画短片 / 剪纸定格 / 品牌宣传 / MV歌词 / 双人游戏开场 / 纸拼贴 / 手绘+实拍
3. 故事 → 自动分镜 / N组分镜（只写分镜）→（可选）**故事→连续性/声景** → 人物场景→参考图 / 内容→首尾帧（fl2v / fl_chain）；已有简述用「按组扩写」（已完整则跳过）
4. 对白必须写清语气；全局布局每镜回扣
5. 模式：t2v→T2VA，i2v→I2VA，fl2v/fl_chain→FL2VA，r2v/v2v/rv2v→**REF2VA**（六段式）

### 任务速查
| 任务 | MODE | 输出 |
|------|------|------|
| t2v | T2VA | 三字段中文 |
| fl2v | FL2VA | 对齐句+三字段 |
| fl_chain | FL2VA | 同上；上镜末帧接力下镜首帧 |
| r2v/v2v/rv2v | REF2VA | 主体定义…六段 |

### 链式连贯（开关）
- 输出栏勾选 **链式连贯**（t2v / fl2v / i2v / r2v；`fl_chain` 常开）
- 开启后：上镜末帧 → 下镜首帧；请按顺序 Queue
- t2v：第 1 组纯文生；第 2 组起注入上镜末帧作首帧
- i2v/r2v：第 1 组可不传首帧；开启后图片1 被占用，用户参考图剩 8 槽（图片2–9）

风格 Skill 为官方 skills 精简版：https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills

---
## 加速节点
`UNET → SageAttention → TE-Speed → EasyCache → 导演台`
- Sage：`sageattn_qk_int8_pv_fp16_cuda` 或 auto；allow_compile=false
- TE-Speed：默认 0.12；0 关闭
- EasyCache：阈值 0.2；0 关闭
"""


def _is_guide_note(n: dict) -> bool:
    if n.get("type") != "MarkdownNote":
        return False
    title = str(n.get("title") or "")
    body = ""
    wv = n.get("widgets_values") or []
    if wv:
        body = str(wv[0] or "")
    if NOTE_MARKER in title or NOTE_MARKER in body or NOTE_TITLE in title:
        return True
    if any(t in title for t in LEGACY_TITLES):
        return True
    if "加速节点使用流程" in body:
        return True
    return False


def _upsert(wf: dict) -> str:
    """Return 'updated' | 'added' | 'skip'."""
    nodes = wf.get("nodes") or []
    if not isinstance(nodes, list):
        return "skip"

    existing = next((n for n in nodes if isinstance(n, dict) and _is_guide_note(n)), None)
    if existing is not None:
        existing["title"] = NOTE_TITLE
        existing["widgets_values"] = [NOTE_MD]
        existing["size"] = [400, 620]
        existing["color"] = "#223"
        existing["bgcolor"] = "#335"
        return "updated"

    anchor = next(
        (
            n
            for n in nodes
            if isinstance(n, dict)
            and n.get("type")
            in ("PathchSageAttentionKJ", "TESpeedMiniMaxH3", "EasyCache", "MiniMaxH3Director")
        ),
        None,
    )
    if not anchor:
        anchor = next(
            (n for n in nodes if isinstance(n, dict) and n.get("type") == "MarkdownNote"),
            None,
        )
    if not anchor:
        return "skip"

    used_ids = {int(n["id"]) for n in nodes if isinstance(n, dict) and n.get("id") is not None}
    note_id = max(used_ids | {0}) + 1
    pos = anchor.get("pos") or [0, 0]
    note = {
        "id": note_id,
        "type": "MarkdownNote",
        "pos": [float(pos[0]), float(pos[1]) + 220.0],
        "size": [400, 620],
        "flags": {},
        "order": int(anchor.get("order", 0)) + 1,
        "mode": 0,
        "inputs": [],
        "outputs": [],
        "title": NOTE_TITLE,
        "properties": {},
        "widgets_values": [NOTE_MD],
        "color": "#223",
        "bgcolor": "#335",
    }
    nodes.append(note)
    wf["nodes"] = nodes
    return "added"


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    paths = []
    paths.extend(sorted((root / "example_workflows").glob("完整版*.json")))
    user_wf = root.parents[1] / "user" / "default" / "workflows"
    if user_wf.is_dir():
        paths.extend(sorted(user_wf.glob("完整版*.json")))

    counts = {"updated": 0, "added": 0, "skip": 0, "fail": 0}
    for p in paths:
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"FAIL read {p.name}: {exc}")
            counts["fail"] += 1
            continue
        action = _upsert(data)
        if action in ("updated", "added"):
            p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"{action.upper():7} {p}")
        else:
            print(f"SKIP    {p.name}")
        counts[action] += 1
    print(
        f"done updated={counts['updated']} added={counts['added']} "
        f"skip={counts['skip']} fail={counts['fail']}"
    )


if __name__ == "__main__":
    main()
