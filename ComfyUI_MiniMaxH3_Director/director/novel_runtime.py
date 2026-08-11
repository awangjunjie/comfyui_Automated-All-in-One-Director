"""Novel chapter pipeline: import → chapters → storyboard → global assets → r2v prepare."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import re
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

import folder_paths

log = logging.getLogger("ComfyUI-MiniMaxH3-Director.novel")

CHAPTER_RE = re.compile(
    r"(?m)^(?:\s*)(?:"
    r"第[零〇一二三四五六七八九十百千万两0-9]+章"
    r"|Chapter\s+\d+"
    r"|CHAPTER\s+\d+"
    r")[^\n]{0,80}$"
)
ACT_RE = re.compile(
    r"(?m)^(?:\s*)(?:"
    r"第[零〇一二三四五六七八九十百千万两0-9]+幕"
    r"|Act\s+\d+"
    r"|ACT\s+\d+"
    r"|ACT\s+[IVXLC]+"
    r")[^\n]{0,80}$"
)
SEGMENT_RE = re.compile(
    r"(?m)^(?:\s*)(?:"
    r"第[零〇一二三四五六七八九十百千万两0-9]+片段"
    r"|片段\s*[零〇一二三四五六七八九十百千万两0-9]+"
    r"|Segment\s+\d+"
    r"|SEG(?:MENT)?\s*\d+"
    r")[^\n]{0,80}$"
)
_SCENE_BREAK_RE = re.compile(
    r"(?m)^(?:\s*)(?:"
    r"第[零〇一二三四五六七八九十百千万两0-9]+场"
    r"|内\s*景|外\s*景"
    r"|INT\.?\s|EXT\.?\s"
    r"|【\s*场景\s*】|场景\s*[:：]"
    r")[^\n]{0,60}$"
)
_ACT_LLM_MARK = re.compile(r"<<<\s*ACT[_\s]*(\d+)\s*>>>", re.I)
_SEG_LLM_MARK = re.compile(r"<<<\s*SEG(?:MENT)?[_\s]*(\d+)\s*>>>", re.I)
# Rough screenplay density: Chinese film script chars ≈ one minute of screen time
_SCRIPT_CHARS_PER_MINUTE = 280.0
_TITLE_MINUTES_RE = re.compile(
    r"(?P<m>\d+(?:\.\d+)?)\s*分钟|(?P<m2>\d+(?:\.\d+)?)\s*min\b",
    re.I,
)
CAST_LINE_RE = re.compile(
    r"(?im)^\s*(?:出场|CAST|角色|人物|场景名?|地点|场所|LOCATION)\s*[:：]\s*(.+)$"
)
NAME_SPLIT_RE = re.compile(r"[,，、/;；|\s]+")
_LOC_LABEL_MARKERS = ("场景", "地点", "场所", "LOCATION", "Location", "location")
_PLACE_SUFFIX_RE = re.compile(
    r"(里|内|中|旁|外|前|后|边|附近|门口|角落|一角|这边|那边|之处|地方)$"
)
# MiniMax H3 dialogue blocks: <d>[中文] ……</d>
_DIALOGUE_TAG_RE = re.compile(r"<d>\s*(?:\[[^\]]*\])?\s*(.*?)\s*</d>", re.I | re.S)
# Speaker before dialogue: 角色名（说n）……<d>
_DIALOGUE_SPEAKER_RE = re.compile(
    r"(?P<name>[\u4e00-\u9fffA-Za-z0-9_·•]{1,16})\s*[（(]\s*说\s*\d+\s*[）)][^<\n]{0,40}<d>",
    re.I,
)
# Mandarin conversational rate (~chars/sec) + acting buffer for duration fit
_NOVEL_SPEECH_CHARS_PER_SEC = 3.4
_NOVEL_SPEECH_ACTING_PAD_SEC = 1.4
_FIDELITY_SHOT_MARKER = "【忠实本章】"


def estimate_dialogue_speech_units(prompt: str) -> float:
    """Speech load from <d> blocks: 1 unit ≈ 1 Chinese char; English word ≈ 2.5."""
    units = 0.0
    for m in _DIALOGUE_TAG_RE.finditer(prompt or ""):
        body = m.group(1) or ""
        units += float(len(re.findall(r"[\u4e00-\u9fff]", body)))
        units += 2.5 * float(len(re.findall(r"[A-Za-z]+", body)))
    return units


def fit_novel_shot_duration(
    prompt: str,
    proposed: float | None,
    *,
    d_min: float = 2.0,
    d_max: float = 12.0,
    default: float = 5.0,
) -> float:
    """Clamp proposed duration; bump up when dialogue needs more time than assigned."""
    try:
        base = float(proposed if proposed is not None else default)
    except (TypeError, ValueError):
        base = float(default)
    lo = max(0.5, float(d_min))
    hi = max(lo, float(d_max))
    base = max(lo, min(hi, base))
    units = estimate_dialogue_speech_units(prompt)
    if units <= 0:
        return base
    n_blocks = len(_DIALOGUE_TAG_RE.findall(prompt or ""))
    need = _NOVEL_SPEECH_ACTING_PAD_SEC + units / _NOVEL_SPEECH_CHARS_PER_SEC
    if n_blocks > 1:
        need += 0.35 * (n_blocks - 1)
    # Never shorten below LLM/story pacing; only extend for speech
    return max(lo, min(hi, max(base, need)))


def _clean_place_name(name: str) -> str:
    s = (name or "").strip()
    s = re.sub(r"^[\s「」『』\"'“”]+|[\s「」『』\"'“”。．.!！?？]+$", "", s)
    # peel soft location suffixes a few times（教室里 → 教室）
    for _ in range(3):
        nxt = _PLACE_SUFFIX_RE.sub("", s)
        if nxt == s or len(nxt) < 2:
            break
        s = nxt
    return s.strip()


def _char_ngrams(text: str, n: int = 2) -> set[str]:
    t = text or ""
    if len(t) < n:
        return {t} if t else set()
    return {t[i : i + n] for i in range(len(t) - n + 1)}


def _name_overlap_score(a: str, b: str) -> float:
    """0–1 similarity for Chinese place/character names (exact / contains / n-gram)."""
    x = _clean_place_name(a)
    y = _clean_place_name(b)
    if not x or not y:
        return 0.0
    if x == y:
        return 1.0
    if x in y or y in x:
        return 0.82 + 0.18 * (min(len(x), len(y)) / max(len(x), len(y)))
    sx, sy = set(x), set(y)
    inter = len(sx & sy)
    if inter == 0:
        return 0.0
    jaccard = inter / len(sx | sy)
    bx, by = _char_ngrams(x, 2), _char_ngrams(y, 2)
    bigram = (len(bx & by) / len(bx | by)) if bx and by else 0.0
    return max(0.0, min(1.0, 0.5 * jaccard + 0.5 * bigram))


def _best_substring_coverage(name: str, text: str) -> float:
    """Longest contiguous piece of ``name`` found in ``text`` / len(name)."""
    n = _clean_place_name(name)
    t = text or ""
    if not n or not t:
        return 0.0
    if n in t:
        return 1.0
    best = 0
    for length in range(len(n), 1, -1):
        for i in range(0, len(n) - length + 1):
            sub = n[i : i + length]
            if sub in t:
                best = max(best, length)
                break
        if best:
            break
    return best / len(n) if best else 0.0


def _asset_names(asset: dict[str, Any]) -> list[str]:
    names = [str(asset.get("name") or "").strip()]
    for a in asset.get("aliases") or []:
        s = str(a).strip()
        if s and s not in names:
            names.append(s)
    return [n for n in names if n]


def _learn_asset_alias(asset: dict[str, Any], alias: str) -> None:
    alias = _clean_place_name(alias)
    if not alias or len(alias) < 2:
        return
    canon = str(asset.get("name") or "").strip()
    if not canon or alias == canon:
        return
    # Avoid learning near-identical long descriptive phrases (>16 chars)
    if len(alias) > 16:
        return
    merged = list(asset.get("aliases") or [])
    if alias not in merged:
        merged.append(alias)
        asset["aliases"] = merged[:16]


def _score_asset_for_shot(
    asset: dict[str, Any],
    *,
    prompt: str,
    explicit_names: list[str],
) -> float:
    """How well a library asset fits this shot's 场景/出场 names + prompt body."""
    text = prompt or ""
    best = 0.0
    for n in _asset_names(asset):
        cn = _clean_place_name(n)
        if len(cn) >= 2 and cn in text:
            best = max(best, 0.92 + 0.01 * min(8, len(cn)))
        best = max(best, _best_substring_coverage(cn, text) * 0.9)
        for en in explicit_names:
            rn = _clean_place_name(en)
            best = max(
                best,
                _name_overlap_score(cn, rn),
                _best_substring_coverage(cn, rn),
                _best_substring_coverage(rn, cn) * 0.92,
            )
    return min(1.0, best)


def _asset_name_bible(project: dict[str, Any]) -> str:
    """Force storyboard LLM to use library names for 出场/场景 lines."""
    chars = [
        str(a.get("name") or "").strip()
        for a in _asset_list(project, "characters")
        if isinstance(a, dict) and str(a.get("name") or "").strip()
    ]
    scenes = [
        str(a.get("name") or "").strip()
        for a in _asset_list(project, "scenes")
        if isinstance(a, dict) and str(a.get("name") or "").strip()
    ]
    if not chars and not scenes:
        return ""
    lines = [
        "【资产库标准名称——强制】",
        "每镜「出场：」「场景：」两行必须从下列名单选用标准名（可多选，用逗号分隔），",
        "禁止另造同义名/描写性地名（如把「小学教室」写成「破旧教室一角」）。",
        "对白中的说话者姓名也必须与人物名单一致，禁止把 A 的台词分给 B。",
    ]
    if chars:
        lines.append("人物名单：" + "、".join(chars[:24]))
    if scenes:
        lines.append("场景名单：" + "、".join(scenes[:24]))
    return "\n".join(lines)


def _rewrite_cast_line_names(prompt: str, project: dict[str, Any]) -> str:
    """Rewrite 场景/出场 lines to canonical asset names when fuzzy-matchable."""
    if not (prompt or "").strip():
        return prompt or ""

    def _repl(match: re.Match[str]) -> str:
        full = match.group(0)
        label = full
        body = match.group(1) or ""
        is_loc = any(k in label for k in _LOC_LABEL_MARKERS)
        kind = "scenes" if is_loc else "characters"
        parts = [n.strip() for n in NAME_SPLIT_RE.split(body) if n.strip()]
        mapped: list[str] = []
        for raw in parts:
            asset = find_asset(project, kind, raw, require_image=False, fuzzy=True)
            if asset is None:
                # soft overlap / substring pick（破旧教室 → 小学教室）
                best_a, best_s = None, 0.0
                for item in _asset_list(project, kind):
                    if not isinstance(item, dict):
                        continue
                    sc = 0.0
                    for n in _asset_names(item):
                        cn = _clean_place_name(n)
                        rn = _clean_place_name(raw)
                        sc = max(
                            sc,
                            _name_overlap_score(cn, rn),
                            _best_substring_coverage(cn, rn),
                            _best_substring_coverage(rn, cn) * 0.92,
                        )
                    if sc > best_s:
                        best_s, best_a = sc, item
                asset = best_a if best_s >= 0.34 else None
            if asset:
                canon = str(asset.get("name") or "").strip()
                if canon:
                    _learn_asset_alias(asset, raw)
                    if canon not in mapped:
                        mapped.append(canon)
                    continue
            cleaned = _clean_place_name(raw)
            if cleaned and cleaned not in mapped:
                mapped.append(cleaned)
        if not mapped:
            return full
        # Keep original label prefix (出场：/场景：)
        prefix = full[: full.index(body)] if body and body in full else (
            "场景：" if is_loc else "出场："
        )
        return prefix + "，".join(mapped)

    return CAST_LINE_RE.sub(_repl, prompt)


def _ensure_cast_scene_lines(prompt: str, characters: list[str], locations: list[str]) -> str:
    """Guarantee 出场/场景 lines exist so bind + continuity can lock correctly."""
    text = (prompt or "").strip()
    has_cast = False
    has_scene = False
    for m in CAST_LINE_RE.finditer(text):
        label = m.group(0)
        if any(k in label for k in _LOC_LABEL_MARKERS):
            has_scene = True
        else:
            has_cast = True
    head: list[str] = []
    if not has_cast and characters:
        head.append("出场：" + "，".join(characters[:6]))
    if not has_scene and locations:
        head.append("场景：" + "，".join(locations[:2]))
    if not head:
        return text
    return "\n".join(head) + ("\n" + text if text else "")


def _align_dialogue_speakers_to_cast(prompt: str, cast_names: list[str]) -> str:
    """If dialogue speaker is close to a cast name, rewrite to canonical cast name."""
    if not prompt or not cast_names:
        return prompt or ""
    canon = [str(n).strip() for n in cast_names if str(n).strip()]
    if not canon:
        return prompt

    def _map_name(raw: str) -> str:
        rn = str(raw or "").strip()
        if not rn:
            return rn
        for c in canon:
            if rn == c or rn in c or c in rn:
                return c
        best, best_s = rn, 0.0
        for c in canon:
            sc = max(
                _name_overlap_score(_clean_place_name(c), _clean_place_name(rn)),
                _best_substring_coverage(_clean_place_name(c), _clean_place_name(rn)),
            )
            if sc > best_s:
                best_s, best = sc, c
        return best if best_s >= 0.45 else rn

    def _repl(m: re.Match[str]) -> str:
        name = m.group("name") or ""
        mapped = _map_name(name)
        if mapped == name:
            return m.group(0)
        return m.group(0).replace(name, mapped, 1)

    return _DIALOGUE_SPEAKER_RE.sub(_repl, prompt)


def _inject_fidelity_shot_lock(prompt: str) -> str:
    text = (prompt or "").strip()
    if not text or _FIDELITY_SHOT_MARKER in text:
        return text
    lock = (
        f"{_FIDELITY_SHOT_MARKER}"
        "只表演本镜已写明的情节与对白；禁止另编主线、错派说话者、擅自换地点/换装。"
    )
    return f"{lock}\n{text}"


def harden_storyboard_shot(
    prompt: str,
    project: dict[str, Any],
    *,
    characters: list[str] | None = None,
    locations: list[str] | None = None,
) -> tuple[str, list[str], list[str]]:
    """Post-process one LLM shot for cast/scene fidelity before save/bind."""
    text = _rewrite_cast_line_names(prompt or "", project)
    cast = _extract_cast_from_prompt(text, project.get("assets") or {})
    chars = _merge_name_lists(characters, cast.get("characters"))
    locs = _merge_name_lists(locations, cast.get("locations"))
    # Prefer library-canonical names when resolvable
    char_assets = _resolve_assets_by_names(project, "characters", chars, prompt=text) if chars else []
    loc_assets = _resolve_scene_assets_for_shot(project, locs, text) if locs else []
    if char_assets:
        chars = [str(a.get("name") or "") for a in char_assets if a.get("name")]
    if loc_assets:
        locs = [str(a.get("name") or "") for a in loc_assets if a.get("name")]
    text = _ensure_cast_scene_lines(text, chars, locs)
    text = _align_dialogue_speakers_to_cast(text, chars)
    text = _inject_fidelity_shot_lock(text)
    return text, chars, locs


CHAPTER_STATUSES = (
    "pending",
    "storyboarded",
    "refs_ready",
    "generating",
    "done",
    "failed",
)


def novel_projects_root() -> Path:
    root = Path(folder_paths.get_output_directory()) / "minimax_novel_projects"
    root.mkdir(parents=True, exist_ok=True)
    return root


def film_projects_root() -> Path:
    root = Path(folder_paths.get_output_directory()) / "minimax_film_projects"
    root.mkdir(parents=True, exist_ok=True)
    return root


def projects_root(product_task: str = "novel") -> Path:
    from ..lib.task_prompts import resolve_task_key

    return film_projects_root() if resolve_task_key(product_task or "") == "film" else novel_projects_root()


def _project_product(data: dict[str, Any] | None) -> str:
    """Infer novel|film for a project (importMeta / settings / id prefix)."""
    from ..lib.task_prompts import resolve_task_key

    if not isinstance(data, dict):
        return "novel"
    meta = data.get("importMeta") if isinstance(data.get("importMeta"), dict) else {}
    raw = str(
        data.get("productTask")
        or meta.get("productTask")
        or meta.get("product_task")
        or ""
    )
    pt = resolve_task_key(raw)
    if pt in {"film", "novel"}:
        return pt
    settings = data.get("settings") if isinstance(data.get("settings"), dict) else {}
    mode = str(settings.get("narrativeMode") or settings.get("narrative_mode") or "").strip().lower()
    if mode in {"film", "movie", "电影", "电影模式"}:
        return "film"
    pid = str(data.get("projectId") or "")
    if pid.startswith("film_"):
        return "film"
    return "novel"


def _find_project_dir(project_id: str) -> Path | None:
    pid = (project_id or "").strip()
    if not pid or "/" in pid or "\\" in pid or ".." in pid:
        return None
    for root in (film_projects_root(), novel_projects_root()):
        cand = root / pid
        if (cand / "project.json").is_file():
            return cand
    return None


def project_dir(project_id: str, *, product_task: str | None = None, project: dict | None = None) -> Path:
    pid = (project_id or "").strip()
    if not pid or "/" in pid or "\\" in pid or ".." in pid:
        raise ValueError("无效的 projectId")
    found = _find_project_dir(pid)
    if found is not None:
        return found
    product = product_task
    if not product and isinstance(project, dict):
        product = _project_product(project)
    if not product:
        product = "film" if pid.startswith("film_") else "novel"
    return projects_root(product) / pid


def stage_project_assets_to_input(project: dict[str, Any]) -> dict[str, Any]:
    """Ensure character/scene images and film audio/video assets are staged under Comfy input."""
    pid = str(project.get("projectId") or "").strip()
    if not pid:
        return {"staged": 0, "assets": project.get("assets")}
    count = 0
    for kind in ASSET_KINDS:
        for item in _asset_list(project, kind):
            if not isinstance(item, dict):
                continue
            src = ""
            if kind in ("characters", "scenes"):
                abs_file = str(item.get("imageFile") or "").strip()
                rel = str(item.get("imagePath") or "").strip()
                if abs_file and Path(abs_file).is_file():
                    src = abs_file
                elif rel:
                    cand = project_dir(pid) / rel
                    if cand.is_file():
                        src = str(cand)
                        item["imageFile"] = src
            else:
                abs_file = str(item.get("mediaFile") or item.get("audioFile") or item.get("videoFile") or "").strip()
                rel = str(item.get("mediaPath") or "").strip()
                if abs_file and Path(abs_file).is_file():
                    src = abs_file
                elif rel:
                    cand = project_dir(pid) / rel
                    if cand.is_file():
                        src = str(cand)
                        item["mediaFile"] = src
                if not src:
                    # Already on Comfy input
                    inp = str(item.get("inputFile") or "").strip().replace("\\", "/")
                    if inp and not _is_absolute_fs_path(inp):
                        cand = Path(folder_paths.get_input_directory()) / Path(inp)
                        if cand.is_file():
                            item.setdefault("inputFile", inp)
                            continue
            if not src:
                continue
            staged = stage_image_to_input(pid, src, stem=str(item.get("name") or Path(src).stem))
            if staged and item.get("inputFile") != staged:
                item["inputFile"] = staged
                if kind == "audios":
                    item["audioFile"] = staged
                elif kind == "videos":
                    item["videoFile"] = staged
                count += 1
            elif staged:
                item.setdefault("inputFile", staged)
    if count:
        save_project(project)
    return {"staged": count, "assets": project.get("assets")}


def resolve_project_asset_file(project_id: str, rel_path: str = "", input_file: str = "") -> Path | None:
    """Resolve a safe readable image path inside novel project or staged input."""
    pid = (project_id or "").strip()
    if input_file:
        rel = str(input_file).replace("\\", "/").lstrip("/")
        if ".." in rel.split("/"):
            return None
        cand = Path(folder_paths.get_input_directory()) / Path(rel)
        if cand.is_file():
            return cand
    if not pid:
        return None
    rel = str(rel_path or "").replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    root = project_dir(pid).resolve()
    cand = (root / Path(rel)).resolve()
    try:
        cand.relative_to(root)
    except Exception:
        return None
    return cand if cand.is_file() else None


def _is_absolute_fs_path(path: str) -> bool:
    norm = (path or "").replace("\\", "/")
    if not norm:
        return False
    if re.match(r"^[A-Za-z]:/", norm):
        return True
    return norm.startswith("/")


def stage_image_to_input(project_id: str, src: str | Path, *, stem: str = "") -> str:
    """Copy an asset image into Comfy ``input/minimax_novel/<projectId>/`` for UI preview + Queue.

    Returns input-relative path (forward slashes), or \"\" if source missing.
    """
    pid = (project_id or "").strip()
    path = Path(str(src or "").strip())
    if not pid or not path.is_file():
        return ""
    rel_dir = Path("minimax_novel") / pid
    dest_dir = Path(folder_paths.get_input_directory()) / rel_dir
    dest_dir.mkdir(parents=True, exist_ok=True)
    suffix = path.suffix or ".png"
    name = f"{_slug(stem or path.stem)}{suffix}"
    dest = dest_dir / name
    try:
        if (not dest.is_file()) or dest.stat().st_mtime < path.stat().st_mtime:
            dest.write_bytes(path.read_bytes())
    except OSError as exc:
        log.warning("stage novel image failed %s -> %s: %s", path, dest, exc)
        return ""
    return str((rel_dir / name).as_posix())


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def _slug(text: str, fallback: str = "item") -> str:
    raw = (text or "").strip()
    if not raw:
        return fallback
    safe = re.sub(r"[^\w\u4e00-\u9fff\-]+", "_", raw, flags=re.UNICODE).strip("_")
    if not safe:
        safe = hashlib.md5(raw.encode("utf-8")).hexdigest()[:10]
    return safe[:48]


def _read_json(path: Path, default: Any = None) -> Any:
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        log.warning("novel json read failed %s: %s", path, exc)
        return default


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def default_novel_settings() -> dict[str, Any]:
    return {
        # short_drama | film
        "narrativeMode": "short_drama",
        "maxShotsPerChapter": 8,
        "defaultDurationSec": 5.0,
        "autoConcatChapter": True,
        "reviewBeforeQueue": False,
        "shotMin": 2,
        "shotMax": 8,
        "durationMin": 2.0,
        "durationMax": 12.0,
        # film long-form: shots per Queue batch (not per LLM call)
        "genBatchSize": 4,
        # film: max screen minutes per 片段 when splitting an act
        "segmentMaxMinutes": 5.0,
    }


def narrative_mode_presets(mode: str) -> dict[str, Any]:
    """Recommended shot/duration defaults for 短剧 / 电影."""
    from .skill_presets import normalize_novel_narrative_mode

    if normalize_novel_narrative_mode(mode) == "film":
        return {
            "narrativeMode": "film",
            # 每幕/片段 LLM 分镜建议
            "shotMin": 4,
            "shotMax": 12,
            "maxShotsPerChapter": 120,
            "durationMin": 4.0,
            "durationMax": 30.0,
            "defaultDurationSec": 8.0,
            "genBatchSize": 4,
            "segmentMaxMinutes": 5.0,
        }
    return {
        "narrativeMode": "short_drama",
        "shotMin": 2,
        "shotMax": 8,
        "maxShotsPerChapter": 8,
        "durationMin": 2.0,
        "durationMax": 12.0,
        "defaultDurationSec": 5.0,
        "genBatchSize": 8,
        "segmentMaxMinutes": 5.0,
    }


ASSET_KINDS = ("characters", "scenes", "audios", "videos")
ASSET_KIND_ALIASES = {
    "character": "characters",
    "characters": "characters",
    "char": "characters",
    "人物": "characters",
    "scene": "scenes",
    "scenes": "scenes",
    "场景": "scenes",
    "audio": "audios",
    "audios": "audios",
    "sound": "audios",
    "音频": "audios",
    "video": "videos",
    "videos": "videos",
    "motion": "videos",
    "motions": "videos",
    "动作": "videos",
    "动作视频": "videos",
}


def _normalize_asset_kind(kind: str) -> str:
    raw = str(kind or "").strip()
    key = ASSET_KIND_ALIASES.get(raw) or ASSET_KIND_ALIASES.get(raw.lower())
    return key if key in ASSET_KINDS else "characters"


def _empty_assets() -> dict[str, list]:
    return {k: [] for k in ASSET_KINDS}


def default_novel_state() -> dict[str, Any]:
    return {
        "projectId": "",
        "title": "",
        "importMeta": {},
        "chapters": [],
        "currentChapterId": "",
        "history": [],
        "assets": _empty_assets(),
        "settings": default_novel_settings(),
        "updatedAt": "",
    }


def ensure_novel_state(timeline: dict | None) -> dict[str, Any]:
    tl = timeline if isinstance(timeline, dict) else {}
    novel = tl.get("novel")
    if not isinstance(novel, dict):
        novel = default_novel_state()
        tl["novel"] = novel
    novel.setdefault("projectId", "")
    novel.setdefault("title", "")
    novel.setdefault("importMeta", {})
    novel.setdefault("chapters", [])
    novel.setdefault("currentChapterId", "")
    novel.setdefault("history", [])
    assets = novel.get("assets")
    if not isinstance(assets, dict):
        assets = _empty_assets()
        novel["assets"] = assets
    for k in ASSET_KINDS:
        assets.setdefault(k, [])
    settings = novel.get("settings")
    if not isinstance(settings, dict):
        settings = default_novel_settings()
        novel["settings"] = settings
    else:
        for k, v in default_novel_settings().items():
            settings.setdefault(k, v)
    return novel


def load_project(project_id: str, *, stage_assets: bool = False) -> dict[str, Any]:
    path = project_dir(project_id) / "project.json"
    data = _read_json(path)
    if not isinstance(data, dict):
        raise FileNotFoundError(f"项目不存在: {project_id}")
    # Ensure productTask is persisted for history filtering
    product = _project_product(data)
    data["productTask"] = product
    meta = data.get("importMeta") if isinstance(data.get("importMeta"), dict) else {}
    if not meta.get("productTask"):
        meta = dict(meta)
        meta["productTask"] = product
        data["importMeta"] = meta
    if stage_assets:
        try:
            stage_project_assets_to_input(data)
            data = _read_json(path) or data
        except Exception as exc:
            log.warning("stage assets on load failed: %s", exc)
    return data


def save_project(project: dict[str, Any]) -> dict[str, Any]:
    pid = str(project.get("projectId") or "").strip()
    if not pid:
        raise ValueError("projectId 为空")
    product = _project_product(project)
    project["productTask"] = product
    meta = project.get("importMeta") if isinstance(project.get("importMeta"), dict) else {}
    meta = dict(meta)
    meta["productTask"] = product
    project["importMeta"] = meta
    project["updatedAt"] = _now_iso()
    # Prefer existing location; new projects go to product-specific root
    root = project_dir(pid, product_task=product, project=project)
    root.mkdir(parents=True, exist_ok=True)
    (root / "source").mkdir(exist_ok=True)
    for kind in ASSET_KINDS:
        (root / "assets" / kind).mkdir(parents=True, exist_ok=True)
    (root / "chapters").mkdir(exist_ok=True)
    _write_json(root / "project.json", project)
    _write_json(root / "assets" / "assets.json", project.get("assets") or {})
    return project


def list_projects(product_task: str = "novel") -> list[dict[str, Any]]:
    """List history projects for one product only (novel | film). Separate disk roots."""
    from ..lib.task_prompts import resolve_task_key

    want = "film" if resolve_task_key(product_task or "") == "film" else "novel"
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    roots = [projects_root(want)]
    # Legacy: early film imports may still live under novel root
    if want == "film":
        roots.append(novel_projects_root())
    for root in roots:
        if not root.is_dir():
            continue
        try:
            dirs = sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            continue
        for d in dirs:
            if not d.is_dir():
                continue
            data = _read_json(d / "project.json")
            if not isinstance(data, dict):
                continue
            if _project_product(data) != want:
                continue
            pid = str(data.get("projectId") or d.name)
            if pid in seen:
                continue
            seen.add(pid)
            chapters = data.get("chapters") or []
            done = sum(1 for c in chapters if isinstance(c, dict) and c.get("status") == "done")
            shot_count = 0
            shot_done = 0
            for c in chapters:
                if not isinstance(c, dict):
                    continue
                try:
                    shot_count += int(c.get("shotCount") or 0)
                except (TypeError, ValueError):
                    pass
                try:
                    shot_done += int(c.get("shotDoneCount") or 0)
                except (TypeError, ValueError):
                    pass
            out.append(
                {
                    "projectId": pid,
                    "title": data.get("title") or d.name,
                    "updatedAt": data.get("updatedAt") or "",
                    "chapterCount": len(chapters),
                    "doneCount": done,
                    "shotCount": shot_count,
                    "shotDoneCount": shot_done,
                    "currentChapterId": data.get("currentChapterId") or "",
                    "productTask": want,
                }
            )
    out.sort(key=lambda x: str(x.get("updatedAt") or ""), reverse=True)
    return out


def delete_project(project_id: str) -> bool:
    import shutil

    root = project_dir(project_id)
    if not root.is_dir():
        return False
    shutil.rmtree(root, ignore_errors=True)
    return True


def _strip_html(text: str) -> str:
    text = re.sub(r"(?is)<script[^>]*>.*?</script>", "", text)
    text = re.sub(r"(?is)<style[^>]*>.*?</style>", "", text)
    text = re.sub(r"(?is)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</p\s*>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", "", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", '"')
    )
    return text


def _normalize_novel_text(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\ufeff", "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def decode_import_payload(
    *,
    text: str = "",
    filename: str = "",
    file_b64: str = "",
) -> tuple[str, str]:
    """Return (plain_text, source_kind)."""
    name = (filename or "").strip().lower()
    raw_b64 = (file_b64 or "").strip()
    if raw_b64:
        if "," in raw_b64 and raw_b64.lower().startswith("data:"):
            raw_b64 = raw_b64.split(",", 1)[1]
        data = base64.b64decode(raw_b64)
        if name.endswith(".txt") or (not name and b"\x00" not in data[:200]):
            try:
                return _normalize_novel_text(data.decode("utf-8")), "txt"
            except UnicodeDecodeError:
                return _normalize_novel_text(data.decode("gb18030", errors="ignore")), "txt"
        if name.endswith(".epub") or data[:2] == b"PK":
            if name.endswith(".docx"):
                return _normalize_novel_text(_docx_to_text(data)), "docx"
            if name.endswith(".epub") or b"mimetype" in data[:200] or b"META-INF" in data[:4096]:
                # Ambiguous zip: prefer extension
                if name.endswith(".docx"):
                    return _normalize_novel_text(_docx_to_text(data)), "docx"
                if name.endswith(".epub"):
                    return _normalize_novel_text(_epub_to_text(data)), "epub"
            if name.endswith(".docx"):
                return _normalize_novel_text(_docx_to_text(data)), "docx"
            # sniff
            try:
                with zipfile.ZipFile(__import__("io").BytesIO(data)) as zf:
                    names = set(zf.namelist())
                    if "word/document.xml" in names:
                        return _normalize_novel_text(_docx_to_text(data)), "docx"
                    if "META-INF/container.xml" in names or "mimetype" in names:
                        return _normalize_novel_text(_epub_to_text(data)), "epub"
            except zipfile.BadZipFile:
                pass
            return _normalize_novel_text(data.decode("utf-8", errors="ignore")), "bin"
        if name.endswith(".docx"):
            return _normalize_novel_text(_docx_to_text(data)), "docx"
        if name.endswith(".epub"):
            return _normalize_novel_text(_epub_to_text(data)), "epub"
    pasted = _normalize_novel_text(text)
    if not pasted:
        raise ValueError("请粘贴小说文本或上传 txt/epub/docx 文件")
    return pasted, "paste"


def _docx_to_text(data: bytes) -> str:
    import io

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        xml = zf.read("word/document.xml")
    root = ET.fromstring(xml)
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    parts: list[str] = []
    for p in root.findall(".//w:p", ns):
        texts = [t.text or "" for t in p.findall(".//w:t", ns)]
        line = "".join(texts).strip()
        if line:
            parts.append(line)
    return "\n".join(parts)


def _epub_to_text(data: bytes) -> str:
    import io

    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        names = zf.namelist()
        # Prefer spine order via container → opf
        ordered: list[str] = []
        try:
            container = zf.read("META-INF/container.xml")
            croot = ET.fromstring(container)
            rootfile = None
            for el in croot.iter():
                if el.tag.endswith("rootfile"):
                    rootfile = el.attrib.get("full-path")
                    break
            if rootfile:
                opf = zf.read(rootfile)
                oroot = ET.fromstring(opf)
                id_to_href: dict[str, str] = {}
                for el in oroot.iter():
                    if el.tag.endswith("item"):
                        iid = el.attrib.get("id")
                        href = el.attrib.get("href")
                        if iid and href:
                            id_to_href[iid] = href
                manifest_dir = str(Path(rootfile).parent).replace("\\", "/")
                if manifest_dir == ".":
                    manifest_dir = ""
                for el in oroot.iter():
                    if el.tag.endswith("itemref"):
                        idref = el.attrib.get("idref")
                        href = id_to_href.get(idref or "")
                        if not href:
                            continue
                        full = f"{manifest_dir}/{href}".lstrip("/") if manifest_dir else href
                        ordered.append(full)
        except Exception as exc:
            log.warning("epub spine parse failed: %s", exc)
        if not ordered:
            ordered = [
                n
                for n in names
                if n.lower().endswith((".xhtml", ".html", ".htm")) and "meta-inf" not in n.lower()
            ]
        chunks: list[str] = []
        for name in ordered:
            try:
                raw = zf.read(name)
            except KeyError:
                continue
            try:
                html = raw.decode("utf-8")
            except UnicodeDecodeError:
                html = raw.decode("utf-8", errors="ignore")
            chunks.append(_strip_html(html))
        return "\n\n".join(chunks)


def split_chapters(text: str, *, title_hint: str = "") -> list[dict[str, Any]]:
    text = _normalize_novel_text(text)
    if not text:
        raise ValueError("小说正文为空")
    matches = list(CHAPTER_RE.finditer(text))
    chapters: list[dict[str, Any]] = []
    if matches:
        for i, m in enumerate(matches):
            start = m.start()
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            block = text[start:end].strip()
            title_line = m.group(0).strip()
            body = text[m.end() : end].strip()
            chapters.append(_make_chapter(i, title_line, body or block))
        return chapters

    # Fallback: blank-line blocks of decent size
    blocks = [b.strip() for b in re.split(r"\n\s*\n", text) if b.strip()]
    long_blocks = [b for b in blocks if len(b) >= 400]
    if len(long_blocks) >= 2:
        for i, b in enumerate(long_blocks):
            first = b.split("\n", 1)[0].strip()[:40]
            chapters.append(_make_chapter(i, first or f"第{i + 1}段", b))
        return chapters

    title = (title_hint or "全文").strip() or "全文"
    chapters.append(_make_chapter(0, title, text))
    return chapters


def split_acts(text: str, *, title_hint: str = "") -> list[dict[str, Any]]:
    """Split film script by「第×幕」/ ACT N markers. No marker → single act container."""
    text = _normalize_novel_text(text)
    if not text:
        raise ValueError("电影剧本为空")
    matches = list(ACT_RE.finditer(text))
    acts: list[dict[str, Any]] = []
    if matches:
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
            block = text[m.start() : end].strip()
            title_line = m.group(0).strip()
            body = text[m.end() : end].strip()
            ch = _make_chapter(i, title_line, body or block, unit="act")
            acts.append(ch)
        return acts

    title = (title_hint or "第一幕").strip() or "第一幕"
    return [_make_chapter(0, title, text, unit="act")]


def _make_chapter(
    index: int,
    title: str,
    body: str,
    *,
    unit: str = "chapter",
) -> dict[str, Any]:
    cid = f"ch{index + 1:03d}_{uuid.uuid4().hex[:6]}"
    u = str(unit or "").strip().lower()
    if u == "segment":
        default_title = f"片段{index + 1}"
        narrative_unit = "segment"
    elif u == "act":
        default_title = f"第{index + 1}幕"
        narrative_unit = "act"
    else:
        default_title = f"第{index + 1}章"
        narrative_unit = "chapter"
    return {
        "id": cid,
        "index": index,
        "title": (title or default_title).strip(),
        "text": body.strip(),
        "status": "pending",
        "shotCount": 0,
        "shots": [],
        "globalPrompt": "",
        "outputPath": "",
        "error": "",
        "narrativeUnit": narrative_unit,
        "updatedAt": _now_iso(),
    }


def import_novel(
    *,
    text: str = "",
    filename: str = "",
    file_b64: str = "",
    title: str = "",
    project_id: str = "",
    product_task: str = "",
    split_chapters_flag: bool | None = None,
) -> dict[str, Any]:
    plain, kind = decode_import_payload(text=text, filename=filename, file_b64=file_b64)
    stem = Path(filename).stem if filename else ""
    from ..lib.task_prompts import resolve_task_key

    pt = resolve_task_key(product_task or "")
    is_film = pt == "film"
    default_title = "未命名电影剧本" if is_film else "未命名小说"
    proj_title = (title or stem or default_title).strip()[:120]
    pid = (project_id or "").strip() or (
        f"{'film' if is_film else 'novel'}_{time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    )
    # Film: split by「幕」markers (not「章」). Novel: split by chapter markers unless overridden.
    if is_film:
        if split_chapters_flag is False:
            chapters = [_make_chapter(0, (proj_title or "第一幕").strip() or "第一幕", plain, unit="act")]
            do_split = False
        else:
            chapters = split_acts(plain, title_hint=proj_title)
            do_split = len(chapters) > 1
    else:
        do_split = bool(split_chapters_flag) if split_chapters_flag is not None else True
        if do_split:
            chapters = split_chapters(plain, title_hint=proj_title)
        else:
            chapters = [_make_chapter(0, proj_title or "全文", plain)]
    project = default_novel_state()
    settings = default_novel_settings()
    if is_film:
        settings.update(narrative_mode_presets("film"))
    needs_llm_acts = bool(is_film and len(chapters) <= 1 and len(plain) >= 800)
    if is_film:
        detail = f"{kind} · {len(chapters)} 幕 · {len(plain)} 字"
        if needs_llm_acts:
            detail += "（无幕标记，可智能切幕）"
    else:
        detail = (
            f"{kind} · {len(chapters)} 章 · {len(plain)} 字"
            if do_split
            else f"{kind} · 单段 · {len(plain)} 字"
        )
    project.update(
        {
            "projectId": pid,
            "title": proj_title,
            "productTask": "film" if is_film else "novel",
            "importMeta": {
                "kind": kind,
                "filename": filename or "",
                "charCount": len(plain),
                "importedAt": _now_iso(),
                "productTask": "film" if is_film else "novel",
                "splitChapters": do_split if not is_film else False,
                "splitActs": bool(is_film and len(chapters) > 1),
                "needsLlmActSplit": needs_llm_acts,
                "actCount": len(chapters) if is_film else 0,
            },
            "chapters": chapters,
            "currentChapterId": chapters[0]["id"] if chapters else "",
            "history": [
                {
                    "at": _now_iso(),
                    "action": "import",
                    "detail": detail,
                }
            ],
            "assets": _empty_assets(),
            "settings": settings,
        }
    )
    root = project_dir(pid, product_task="film" if is_film else "novel", project=project)
    (root / "source").mkdir(parents=True, exist_ok=True)
    src_name = "script.txt" if is_film else ("novel.txt" if do_split else "novel.txt")
    (root / "source" / src_name).write_text(plain, encoding="utf-8")
    if is_film:
        (root / "source" / "novel.txt").write_text(plain, encoding="utf-8")
    save_project(project)
    return project


def _parse_llm_acts(raw: str, full_text: str) -> list[dict[str, Any]]:
    """Parse <<<ACT_n>>> blocks from LLM; fall back to JSON list."""
    text = (raw or "").strip()
    if not text:
        return []
    from .local_director_runtime import _strip_wrappers

    text = _strip_wrappers(text)
    marks = list(_ACT_LLM_MARK.finditer(text))
    acts: list[dict[str, Any]] = []
    if marks:
        for i, m in enumerate(marks):
            start = m.end()
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            block = text[start:end].strip()
            title = f"第{i + 1}幕"
            body = block
            tm = re.match(r"(?im)^\s*TITLE\s*[:：]\s*(.+)$", block)
            if tm:
                title = tm.group(1).strip()[:80] or title
                body = block[tm.end() :].strip()
            if body:
                acts.append(_make_chapter(i, title, body, unit="act"))
        if len(acts) >= 2:
            return acts

    # JSON: {"acts":[{"title":"...","text":"..."}]}
    try:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            data = json.loads(m.group(0))
            raw_acts = data.get("acts") if isinstance(data, dict) else data
            if isinstance(raw_acts, list):
                for i, item in enumerate(raw_acts):
                    if not isinstance(item, dict):
                        continue
                    title = str(item.get("title") or f"第{i + 1}幕").strip()[:80]
                    body = str(item.get("text") or item.get("body") or "").strip()
                    if body:
                        acts.append(_make_chapter(i, title, body, unit="act"))
                if len(acts) >= 2:
                    return acts
    except Exception:
        pass

    # Character-offset ranges into original script
    try:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            data = json.loads(m.group(0))
            ranges = data.get("ranges") if isinstance(data, dict) else None
            if isinstance(ranges, list) and len(ranges) >= 2:
                n = len(full_text)
                for i, item in enumerate(ranges):
                    if not isinstance(item, dict):
                        continue
                    a = max(0, min(n, int(item.get("start") or 0)))
                    b = max(a, min(n, int(item.get("end") or n)))
                    body = full_text[a:b].strip()
                    title = str(item.get("title") or f"第{i + 1}幕").strip()[:80]
                    if body:
                        acts.append(_make_chapter(i, title, body, unit="act"))
                if len(acts) >= 2:
                    return acts
    except Exception:
        pass
    return acts


def split_acts_via_llm(
    project: dict[str, Any],
    *,
    model: str,
    backend: str = "local",
    force: bool = False,
    **llm_kwargs,
) -> dict[str, Any]:
    """LLM-split a film project that still has a single act / no 幕 markers."""
    from .local_director_runtime import _run_director_llm
    from .skill_presets import normalize_novel_narrative_mode

    settings = project.get("settings") or {}
    if normalize_novel_narrative_mode(settings.get("narrativeMode")) != "film":
        raise ValueError("智能切幕仅用于电影模式")
    if not (model or "").strip():
        raise ValueError("请选择提示词导演模型")

    chapters = [c for c in (project.get("chapters") or []) if isinstance(c, dict)]
    if len(chapters) > 1 and not force:
        raise ValueError(f"项目已有 {len(chapters)} 幕，无需再切（可 force=true 强制重切）")

    pid = str(project.get("projectId") or "")
    root = project_dir(pid, product_task="film", project=project)
    full_text = ""
    for name in ("script.txt", "novel.txt"):
        p = root / "source" / name
        if p.is_file():
            full_text = p.read_text(encoding="utf-8").strip()
            if full_text:
                break
    if not full_text and chapters:
        full_text = str(chapters[0].get("text") or "").strip()
    full_text = _normalize_novel_text(full_text)
    if len(full_text) < 200:
        raise ValueError("剧本过短，无法智能切幕")

    # Prefer marker split if user added markers after import
    marked = split_acts(full_text, title_hint=str(project.get("title") or ""))
    if len(marked) >= 2:
        acts = marked
    else:
        system = (
            "你是电影编剧助理。将完整电影剧本按叙事幕（act）切分。"
            "每幕应是可独立生成的一段连贯视频（开端/发展/高潮/收束等），通常 2～8 幕。"
            "禁止改写正文：只切分，正文须为原文连续摘录。"
            "输出格式（严格）：\n"
            "<<<ACT_1>>>\nTITLE: 第一幕 · 简短标题\n（该幕原文）\n"
            "<<<ACT_2>>>\nTITLE: 第二幕 · 简短标题\n（该幕原文）\n"
            "…\n"
            "不要输出其它解释。"
        )
        # Cap context for smaller models
        brief = full_text if len(full_text) <= 24000 else (
            full_text[:12000] + "\n\n…（中间省略）…\n\n" + full_text[-10000:]
        )
        user_msg = f"请将下列电影剧本切成多幕：\n\n{brief}"
        kw = dict(llm_kwargs)
        kw.setdefault("max_tokens", 8192)
        kw.setdefault("temperature", 0.3)
        allow = (
            "llm_url", "api_format", "api_key", "max_tokens", "temperature",
            "timeout_seconds", "thinking", "mmproj", "top_p", "top_k",
            "repeat_penalty", "ctx_size", "memory_mode", "n_gpu_layers",
            "n_cpu_moe_layers", "seed", "reasoning",
        )
        raw = _run_director_llm(
            backend=backend,
            model=model,
            user_msg=user_msg,
            system_prompt=system,
            **{k: kw[k] for k in allow if k in kw},
        )
        acts = _parse_llm_acts(raw or "", full_text)
        if len(acts) < 2:
            preview = (raw or "")[:400].replace("\n", "\\n")
            raise RuntimeError(f"智能切幕失败：未解析到≥2 幕。输出预览: {preview}")

    project["chapters"] = acts
    project["currentChapterId"] = acts[0]["id"]
    meta = project.get("importMeta") if isinstance(project.get("importMeta"), dict) else {}
    meta = dict(meta)
    meta["splitActs"] = True
    meta["needsLlmActSplit"] = False
    meta["actCount"] = len(acts)
    meta["actSplitAt"] = _now_iso()
    project["importMeta"] = meta
    append_history(project, "split_acts", f"切为 {len(acts)} 幕")
    save_project(project)
    return {
        "project": project,
        "actCount": len(acts),
        "chapters": [chapter_summary(c) for c in acts],
        "novel": timeline_novel_patch(project),
    }


def estimate_script_minutes(text: str, *, title_hint: str = "") -> float:
    """Estimate screen minutes from script length (and optional『N分钟』in title)."""
    body = _normalize_novel_text(text or "")
    chars = float(len(re.sub(r"\s+", "", body)))
    by_chars = chars / max(1.0, _SCRIPT_CHARS_PER_MINUTE) if chars else 0.0
    hinted = 0.0
    m = _TITLE_MINUTES_RE.search(title_hint or "")
    if m:
        try:
            hinted = float(m.group("m") or m.group("m2") or 0)
        except (TypeError, ValueError):
            hinted = 0.0
    if hinted > 0 and by_chars > 0:
        # Prefer title hint when present; blend lightly with char estimate
        return max(0.5, 0.75 * hinted + 0.25 * by_chars)
    if hinted > 0:
        return max(0.5, hinted)
    return max(0.5, by_chars) if by_chars > 0 else 0.5


def _split_blocks_for_segments(text: str) -> list[str]:
    text = _normalize_novel_text(text)
    if not text:
        return []
    # Prefer explicit 片段 markers inside the act
    marks = list(SEGMENT_RE.finditer(text))
    if len(marks) >= 2:
        blocks: list[str] = []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            body = text[m.end() : end].strip() or text[m.start() : end].strip()
            if body:
                blocks.append(body)
        if blocks:
            return blocks
    # Scene / blank-line atoms
    scene_marks = list(_SCENE_BREAK_RE.finditer(text))
    if len(scene_marks) >= 2:
        atoms: list[str] = []
        # preamble before first scene
        head = text[: scene_marks[0].start()].strip()
        if head:
            atoms.append(head)
        for i, m in enumerate(scene_marks):
            end = scene_marks[i + 1].start() if i + 1 < len(scene_marks) else len(text)
            block = text[m.start() : end].strip()
            if block:
                atoms.append(block)
        return atoms or [text]
    paras = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
    return paras if paras else [text]


def split_text_into_segments(
    text: str,
    *,
    max_minutes: float = 5.0,
    title_hint: str = "",
    parent_title: str = "",
    start_index: int = 0,
) -> list[dict[str, Any]]:
    """Pack act text into segment chapters targeting ≤ max_minutes each."""
    max_minutes = max(1.0, float(max_minutes or 5.0))
    atoms = _split_blocks_for_segments(text)
    if not atoms:
        raise ValueError("幕正文为空，无法切片段")
    # If already under budget, keep single segment wrapper
    total_est = estimate_script_minutes(text, title_hint=title_hint or parent_title)
    parent = (parent_title or title_hint or "本幕").strip()
    if total_est <= max_minutes * 1.15 and len(atoms) <= 1:
        ch = _make_chapter(start_index, f"{parent} · 片段1", text, unit="segment")
        ch["estimatedMinutes"] = round(total_est, 1)
        ch["segmentIndex"] = 0
        ch["parentActTitle"] = parent
        return [ch]

    max_chars = max(400, int(max_minutes * _SCRIPT_CHARS_PER_MINUTE))
    bins: list[list[str]] = []
    cur: list[str] = []
    cur_len = 0
    for atom in atoms:
        a_len = len(re.sub(r"\s+", "", atom))
        if cur and cur_len + a_len > max_chars:
            bins.append(cur)
            cur = [atom]
            cur_len = a_len
        else:
            cur.append(atom)
            cur_len += a_len
    if cur:
        bins.append(cur)
    if len(bins) < 2 and total_est > max_minutes * 1.2:
        # Force slice by character budget
        plain = _normalize_novel_text(text)
        bins = []
        i = 0
        while i < len(plain):
            bins.append([plain[i : i + max_chars]])
            i += max_chars

    segs: list[dict[str, Any]] = []
    n = max(1, len(bins))
    for i, parts in enumerate(bins):
        body = "\n\n".join(parts).strip()
        if not body:
            continue
        est = estimate_script_minutes(body)
        title = f"{parent} · 片段{i + 1}/{n}"
        ch = _make_chapter(start_index + len(segs), title, body, unit="segment")
        ch["estimatedMinutes"] = round(est, 1)
        ch["segmentIndex"] = len(segs)
        ch["segmentCount"] = n
        ch["parentActTitle"] = parent
        ch["maxMinutes"] = float(max_minutes)
        segs.append(ch)
    if not segs:
        raise ValueError("切片段失败：未得到有效正文")
    # Fix segmentCount after filter
    for i, ch in enumerate(segs):
        ch["segmentIndex"] = i
        ch["segmentCount"] = len(segs)
        ch["title"] = f"{parent} · 片段{i + 1}/{len(segs)}"
        ch["index"] = start_index + i
    return segs


def _parse_llm_segments(raw: str, full_text: str, *, parent_title: str, max_minutes: float) -> list[dict[str, Any]]:
    text = (raw or "").strip()
    if not text:
        return []
    from .local_director_runtime import _strip_wrappers

    text = _strip_wrappers(text)
    marks = list(_SEG_LLM_MARK.finditer(text))
    segs: list[dict[str, Any]] = []
    parent = (parent_title or "本幕").strip()
    if marks:
        for i, m in enumerate(marks):
            start = m.end()
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            block = text[start:end].strip()
            title = f"{parent} · 片段{i + 1}"
            body = block
            tm = re.match(r"(?im)^\s*TITLE\s*[:：]\s*(.+)$", block)
            if tm:
                title = tm.group(1).strip()[:100] or title
                body = block[tm.end() :].strip()
            if body:
                ch = _make_chapter(i, title, body, unit="segment")
                ch["estimatedMinutes"] = round(estimate_script_minutes(body), 1)
                ch["segmentIndex"] = i
                ch["parentActTitle"] = parent
                ch["maxMinutes"] = float(max_minutes)
                segs.append(ch)
        if len(segs) >= 2:
            for i, ch in enumerate(segs):
                ch["segmentCount"] = len(segs)
                ch["segmentIndex"] = i
            return segs
    try:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            data = json.loads(m.group(0))
            raw_segs = data.get("segments") if isinstance(data, dict) else data
            if isinstance(raw_segs, list):
                for i, item in enumerate(raw_segs):
                    if not isinstance(item, dict):
                        continue
                    body = str(item.get("text") or item.get("body") or "").strip()
                    if not body:
                        continue
                    title = str(item.get("title") or f"{parent} · 片段{i + 1}").strip()[:100]
                    ch = _make_chapter(i, title, body, unit="segment")
                    ch["estimatedMinutes"] = round(estimate_script_minutes(body), 1)
                    ch["segmentIndex"] = i
                    ch["parentActTitle"] = parent
                    ch["maxMinutes"] = float(max_minutes)
                    segs.append(ch)
                if len(segs) >= 2:
                    for i, ch in enumerate(segs):
                        ch["segmentCount"] = len(segs)
                    return segs
    except Exception:
        pass
    return segs


def split_act_into_segments(
    project: dict[str, Any],
    chapter_id: str,
    *,
    max_minutes: float | None = None,
    model: str = "",
    backend: str = "local",
    use_llm: bool = True,
    **llm_kwargs,
) -> dict[str, Any]:
    """Replace one film act (or long unit) with multiple segment chapters."""
    from .skill_presets import normalize_novel_narrative_mode

    settings = project.setdefault("settings", default_novel_settings())
    if not isinstance(settings, dict):
        settings = default_novel_settings()
        project["settings"] = settings
    if normalize_novel_narrative_mode(settings.get("narrativeMode")) != "film":
        raise ValueError("幕片段分割仅用于电影模式")

    try:
        lim = float(max_minutes if max_minutes is not None else settings.get("segmentMaxMinutes") or 5.0)
    except (TypeError, ValueError):
        lim = 5.0
    lim = max(1.0, min(60.0, lim))
    settings["segmentMaxMinutes"] = lim

    ch = get_chapter(project, chapter_id)
    body = str(ch.get("text") or "").strip()
    if len(body) < 80:
        raise ValueError("本幕正文过短，无需切片段")
    parent_title = str(ch.get("title") or "本幕").strip()
    parent_id = str(ch.get("id") or "")
    est = estimate_script_minutes(body, title_hint=parent_title)
    if est <= lim * 1.1 and str(ch.get("narrativeUnit") or "") == "segment":
        raise ValueError(f"本单元约 {est:.1f} 分钟，已≤最大片段 {lim:g} 分钟，无需再切")

    segs: list[dict[str, Any]] = []
    # Explicit 片段 markers inside act
    if len(list(SEGMENT_RE.finditer(body))) >= 2:
        segs = split_text_into_segments(
            body, max_minutes=lim, parent_title=parent_title, title_hint=parent_title
        )
    elif use_llm and (model or "").strip() and est > lim * 1.25:
        from .local_director_runtime import _run_director_llm

        system = (
            f"你是电影剪辑助理。将「一幕」剧本切成多个「片段」，每片段屏幕时间尽量不超过 {lim:g} 分钟。"
            "禁止改写正文：只切分，正文须为原文连续摘录。"
            "在叙事停顿/场次转换处切开，保持每片段情节完整。"
            "输出格式（严格）：\n"
            f"<<<SEG_1>>>\nTITLE: {parent_title} · 片段1 · 短标题\n（该片段原文）\n"
            f"<<<SEG_2>>>\nTITLE: {parent_title} · 片段2 · 短标题\n（该片段原文）\n"
            "…\n不要输出其它解释。"
        )
        brief = body if len(body) <= 20000 else (body[:10000] + "\n\n…（中间省略）…\n\n" + body[-8000:])
        user_msg = (
            f"幕标题：{parent_title}\n估算时长约 {est:.1f} 分钟\n"
            f"请切成若干片段（每片 ≤ {lim:g} 分钟）：\n\n{brief}"
        )
        kw = dict(llm_kwargs)
        kw.setdefault("max_tokens", 8192)
        kw.setdefault("temperature", 0.25)
        allow = (
            "llm_url", "api_format", "api_key", "max_tokens", "temperature",
            "timeout_seconds", "thinking", "mmproj", "top_p", "top_k",
            "repeat_penalty", "ctx_size", "memory_mode", "n_gpu_layers",
            "n_cpu_moe_layers", "seed", "reasoning",
        )
        raw = _run_director_llm(
            backend=backend,
            model=model,
            user_msg=user_msg,
            system_prompt=system,
            **{k: kw[k] for k in allow if k in kw},
        )
        segs = _parse_llm_segments(raw or "", body, parent_title=parent_title, max_minutes=lim)
        if len(segs) < 2:
            segs = []

    if len(segs) < 2:
        segs = split_text_into_segments(
            body, max_minutes=lim, parent_title=parent_title, title_hint=parent_title
        )
    if len(segs) < 2:
        raise RuntimeError(
            f"切片段失败：估算 {est:.1f} 分钟，目标 ≤{lim:g} 分钟，但仍无法拆出多段。"
            "可调小「片段最大分钟」后重试。"
        )

    for i, s in enumerate(segs):
        s["parentActId"] = parent_id
        s["parentActTitle"] = parent_title
        s["narrativeUnit"] = "segment"
        s["maxMinutes"] = lim
        s["segmentIndex"] = i
        s["segmentCount"] = len(segs)

    chapters = [c for c in (project.get("chapters") or []) if isinstance(c, dict)]
    idx = next((i for i, c in enumerate(chapters) if c.get("id") == parent_id), -1)
    if idx < 0:
        raise KeyError(f"章节不存在: {chapter_id}")
    # Reindex global chapter list
    new_chapters = chapters[:idx] + segs + chapters[idx + 1 :]
    for i, c in enumerate(new_chapters):
        c["index"] = i
    project["chapters"] = new_chapters
    project["currentChapterId"] = segs[0]["id"]
    meta = project.get("importMeta") if isinstance(project.get("importMeta"), dict) else {}
    meta = dict(meta)
    meta["splitSegments"] = True
    meta["segmentMaxMinutes"] = lim
    project["importMeta"] = meta
    append_history(
        project,
        "split_segments",
        f"「{parent_title}」→ {len(segs)} 片段（≤{lim:g} 分钟/片，原约 {est:.1f} 分钟）",
    )
    save_project(project)
    return {
        "project": project,
        "segmentCount": len(segs),
        "maxMinutes": lim,
        "estimatedMinutes": round(est, 1),
        "parentActTitle": parent_title,
        "chapters": [chapter_summary(c) for c in segs],
        "novel": timeline_novel_patch(project),
    }


def append_history(project: dict[str, Any], action: str, detail: str = "") -> None:
    hist = project.setdefault("history", [])
    if not isinstance(hist, list):
        hist = []
        project["history"] = hist
    hist.append({"at": _now_iso(), "action": action, "detail": detail or ""})
    if len(hist) > 200:
        del hist[:-200]


def get_chapter(project: dict[str, Any], chapter_id: str) -> dict[str, Any]:
    cid = (chapter_id or "").strip()
    for ch in project.get("chapters") or []:
        if isinstance(ch, dict) and ch.get("id") == cid:
            return ch
    raise KeyError(f"章节不存在: {chapter_id}")


def clear_global_prompt_cache(
    project_id: str,
    *,
    chapter_id: str = "",
    clear_all_chapters: bool = True,
) -> dict[str, Any]:
    """Clear sticky chapter globalPrompt (project + shots.json) for a fresh creative run."""
    project = load_project(project_id, stage_assets=False)
    chapters = [c for c in (project.get("chapters") or []) if isinstance(c, dict)]
    targets: list[dict[str, Any]]
    cid = (chapter_id or "").strip()
    if clear_all_chapters or not cid:
        targets = chapters
    else:
        targets = [get_chapter(project, cid)]
    cleared = 0
    for ch in targets:
        ch["globalPrompt"] = ""
        cleared += 1
        try:
            cdir = _chapter_dir(str(project.get("projectId") or project_id), ch)
            shots_path = cdir / "shots.json"
            if shots_path.is_file():
                try:
                    data = _read_json(shots_path) or {}
                except Exception:
                    data = {}
                if not isinstance(data, dict):
                    data = {}
                data["globalPrompt"] = ""
                if "shots" not in data:
                    data["shots"] = list(ch.get("shots") or [])
                _write_json(shots_path, data)
        except Exception:
            log.exception("clear globalPrompt shots.json failed for %s", ch.get("id"))
    append_history(
        project,
        "clear_global_cache",
        f"已清除 {cleared} 章全局提示词缓存",
    )
    save_project(project)
    return {
        "project": project,
        "clearedChapters": cleared,
        "novel": timeline_novel_patch(project),
    }


def first_incomplete_chapter(project: dict[str, Any]) -> dict[str, Any] | None:
    for ch in project.get("chapters") or []:
        if isinstance(ch, dict) and ch.get("status") != "done":
            return ch
    return None


def _chapter_dir(project_id: str, chapter: dict[str, Any]) -> Path:
    idx = int(chapter.get("index") or 0) + 1
    d = project_dir(project_id) / "chapters" / f"{idx:03d}_{_slug(chapter.get('title') or chapter.get('id'))}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "clips").mkdir(exist_ok=True)
    return d


def _safe_video_stem(title: str) -> str:
    """Filesystem-safe stem that keeps Chinese chapter titles readable."""
    s = (title or "").strip()
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", s)
    s = re.sub(r"\s+", " ", s).strip(" .")
    return (s or "chapter")[:100]


def _resolve_comfy_media_path(
    *,
    source_path: str = "",
    filename: str = "",
    subfolder: str = "",
    file_type: str = "output",
) -> Path | None:
    if source_path:
        p = Path(str(source_path).strip())
        if p.is_file():
            return p.resolve()
    name = (filename or "").strip().replace("\\", "/")
    if not name:
        return None
    typ = (file_type or "output").strip().lower() or "output"
    try:
        base = Path(folder_paths.get_directory_by_type(typ) or folder_paths.get_output_directory())
    except Exception:
        base = Path(folder_paths.get_output_directory())
    sub = (subfolder or "").strip().replace("\\", "/").lstrip("/")
    cand = (base / sub / Path(name).name) if sub else (base / Path(name).name)
    if cand.is_file():
        return cand.resolve()
    # basename fallback under output root
    alt = base / Path(name).name
    if alt.is_file():
        return alt.resolve()
    return None


def find_newest_output_video(*, since_ts: float | None = None) -> Path | None:
    """Pick newest video under Comfy output/ (optionally only files modified after since_ts)."""
    try:
        root = Path(folder_paths.get_output_directory())
    except Exception:
        return None
    if not root.is_dir():
        return None
    best: Path | None = None
    best_mtime = -1.0
    exts = {".mp4", ".webm", ".mov", ".mkv"}
    try:
        for p in root.rglob("*"):
            if not p.is_file() or p.suffix.lower() not in exts:
                continue
            try:
                mtime = p.stat().st_mtime
            except OSError:
                continue
            if since_ts is not None and mtime + 0.05 < float(since_ts):
                continue
            if mtime >= best_mtime:
                best_mtime = mtime
                best = p
    except Exception as exc:
        log.warning("scan output videos failed: %s", exc)
        return None
    return best


def save_chapter_output_video(
    project_id: str,
    chapter_id: str,
    *,
    source_path: str = "",
    filename: str = "",
    subfolder: str = "",
    file_type: str = "output",
    since_ts: float | None = None,
    mark_done: bool = True,
) -> dict[str, Any]:
    """Copy a generated video into the chapter folder, named after the chapter title."""
    import shutil

    project = load_project(project_id)
    ch = get_chapter(project, chapter_id)
    src = _resolve_comfy_media_path(
        source_path=source_path,
        filename=filename,
        subfolder=subfolder,
        file_type=file_type,
    )
    if src is None:
        src = find_newest_output_video(since_ts=since_ts)
    if src is None or not src.is_file():
        raise FileNotFoundError(
            "未找到成片视频。请确认工作流末尾已接 CreateVideo→SaveVideo（或 Video Combine）并成功写出文件。"
        )

    cdir = _chapter_dir(project_id, ch)
    stem = _safe_video_stem(str(ch.get("title") or ch.get("id") or "chapter"))
    ext = src.suffix.lower() if src.suffix else ".mp4"
    if ext not in {".mp4", ".webm", ".mov", ".mkv", ".gif"}:
        ext = ".mp4"
    dest = cdir / f"{stem}{ext}"
    shutil.copy2(src, dest)
    rel = dest.relative_to(project_dir(project_id)).as_posix()
    if mark_done:
        result = update_chapter_progress(
            project_id,
            chapter_id,
            status="done",
            output_path=rel,
        )
        project = result["project"]
        ch = result["chapter"]
    else:
        ch["outputPath"] = rel
        ch["updatedAt"] = _now_iso()
        save_project(project)
    append_history(project, "save_video", f"{ch.get('title')} → {rel}")
    save_project(project)
    return {
        "chapter": ch,
        "project": project,
        "outputPath": rel,
        "absolutePath": str(dest),
        "sourcePath": str(src),
        "chapterDir": str(cdir),
    }


def _truncate_chapter_text(text: str, limit: int = 6000) -> str:
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 20] + "\n…（后文已截断）"


def storyboard_chapter(
    project: dict[str, Any],
    chapter_id: str,
    *,
    model: str,
    backend: str = "local",
    continuity: str = "",
    desk_style: str = "",
    desk_soundscape: str = "",
    desk_music: str = "",
    skill_id: str | None = None,
    append: bool = False,
    **llm_kwargs,
) -> dict[str, Any]:
    from .film_resume import (
        FILM_CHAPTER_SHOT_CAP,
        clamp_duration_range,
        clamp_shot_range,
        count_shot_progress,
        ensure_shot_fields,
        hydrate_chapter_shots,
        refresh_chapter_status_from_shots,
    )
    from .local_director_runtime import expand_story_auto
    from .skill_presets import normalize_novel_narrative_mode, resolve_novel_skill_id

    ch = get_chapter(project, chapter_id)
    settings = project.get("settings") or default_novel_settings()
    narrative_mode = normalize_novel_narrative_mode(settings.get("narrativeMode"))
    # Per-batch LLM range (≤16). Film chapter total grows via append.
    shot_min, shot_max = clamp_shot_range(
        int(settings.get("shotMin") or 2),
        int(settings.get("shotMax") or settings.get("maxShotsPerChapter") or 8),
    )
    existing = hydrate_chapter_shots(project, ch) if append else []
    if append and narrative_mode != "film":
        # 短剧仍允许追加，但提示走电影长片工作流更合适
        pass
    if append and len(existing) >= FILM_CHAPTER_SHOT_CAP:
        raise ValueError(f"本章分镜已达上限 {FILM_CHAPTER_SHOT_CAP}，请拆成新章节继续")
    brief = _truncate_chapter_text(ch.get("text") or "")
    if not brief:
        raise ValueError("章节正文为空")

    sid = resolve_novel_skill_id(
        skill_id if skill_id is not None else llm_kwargs.pop("skill_id", None),
        narrative_mode=narrative_mode,
    )
    llm_kwargs.pop("skill_id", None)
    prompts_dir = Path(__file__).resolve().parent.parent / "prompts"
    sys_name = "h3_novel_film_system.txt" if narrative_mode == "film" else "h3_novel_chapter_system.txt"
    novel_sys_path = prompts_dir / sys_name
    novel_system = ""
    if novel_sys_path.is_file():
        novel_system = novel_sys_path.read_text(encoding="utf-8").strip()
    # Spatial / action emphasis + force library scene/character names
    bible = _asset_name_bible(project)
    if narrative_mode == "film":
        unit_label = "本片段" if str(ch.get("narrativeUnit") or "") == "segment" else "本幕"
        brief_for_llm = (
            f"{brief}\n\n"
            f"【电影硬约束 · {unit_label}】忠实{unit_label}原文情节与关键对白，禁止另编主线/错派角色。"
            "用电影镜头语法分镜：大远景/全景建立→中景关系→近景情绪；"
            "运镜要有动机；单镜可更长，对白克制，留白给表演与声景。"
            f"必须写清人物站位与相对方位，以及主动作起势→过程→落点（动作须来自{unit_label}）。"
            "对白必须用 <d>[中文] ……</d>，说话者=「出场」角色，口型声线一致；关键台词优先原文；画外音嘴唇闭合。"
            "duration 覆盖对白与呼吸（约 3～4 字/秒），偏好更长单镜；相邻镜承接上一镜收束；"
            "同场景背景连续，换场改「场景：」名。"
            f"{unit_label}一次分完本段情节（勿跨到下一段）；段与段之间靠内容/人物/场景一致承接，不要求像素级接尾帧。"
        )
        # Cross-unit content continuity: previous chapter/segment title + last few shot prompts
        prev_act = None
        for c in project.get("chapters") or []:
            if not isinstance(c, dict):
                continue
            if c.get("id") == ch.get("id"):
                break
            prev_act = c
        if prev_act is not None:
            prev_bits = [
                f"前段标题：{prev_act.get('title') or prev_act.get('id')}",
                f"前段摘要：{(str(prev_act.get('text') or '')[:400]).strip()}",
            ]
            try:
                prev_shots = hydrate_chapter_shots(project, prev_act) or list(prev_act.get("shots") or [])
            except Exception:
                prev_shots = list(prev_act.get("shots") or [])
            for s in (prev_shots or [])[-3:]:
                if not isinstance(s, dict):
                    continue
                idx = int(s.get("index") or 0) + 1
                prev_bits.append(
                    f"- 前段末镜{idx}：{(str(s.get('prompt') or '')[:240]).strip()}"
                )
            brief_for_llm = (
                f"{brief_for_llm}\n\n"
                "【跨段内容连贯】承接前段人物关系/场景气质/未决冲突，保持定妆与场景名一致；"
                "本段首镜不要假设能硬锁前段末帧，用内容与参考图自然开场。\n"
                + "\n".join(prev_bits)
            )
    else:
        brief_for_llm = (
            f"{brief}\n\n"
            "【小说短剧硬约束】忠实本章原文：还原关键情节与对白归属，禁止另编主线、偷换冲突、张冠李戴。"
            "分镜时加重人物站位与相对方位（左中右、前景中景远景、谁在谁身侧/对面），"
            "以及本镜主动作的起势→过程→落点（动作须来自本章）；禁止只写抽象情节。"
            "对白必须用 <d>[中文] ……</d>，说话者写清角色名+（说n）+语气，且必须是本镜「出场」中的角色；"
            "关键台词优先沿用原文措辞；口型与声线跟该角色一致，禁止错人配音；画外音须写明嘴唇完全闭合。"
            "每镜 duration 必须覆盖本镜全部对白自然说完所需时间（中文约 3～4 字/秒，含起落与停顿），"
            "勿把长对白塞进过短时长，也勿用空镜把短对白拖成冗长静默；动作节拍与对白起落同步。"
            "相邻镜必须承接：后镜开场站位/姿态续接前镜收束，禁止每镜重起幅；同场景背景连续，换场改「场景：」名。"
            "按时间顺序覆盖本章要点，勿跳过关键冲突。"
        )
    if append and existing:
        prev_bits = []
        for s in existing[-3:]:
            if not isinstance(s, dict):
                continue
            idx = int(s.get("index") or 0) + 1
            prev_bits.append(
                f"- 已有镜{idx}：{(str(s.get('prompt') or '')[:280]).strip()}"
            )
        brief_for_llm = (
            f"{brief_for_llm}\n\n"
            f"【追加分镜 · 第 {len(existing) + 1} 镜起】已有 {len(existing)} 镜，请从本章尚未覆盖的情节继续，"
            f"本批输出 {shot_min}～{shot_max} 个新镜，禁止重复已有镜内容。"
            "开场站位/姿态必须承接上一镜收束；换场则改「场景：」名。\n"
            + ("\n".join(prev_bits) if prev_bits else "")
        )
    if bible:
        brief_for_llm = f"{brief_for_llm}\n\n{bible}"
    continuity_for_llm = continuity or ""
    if bible:
        continuity_for_llm = (continuity_for_llm + "\n\n" + bible).strip()

    d_min, d_max = clamp_duration_range(
        float(settings.get("durationMin") or (4.0 if narrative_mode == "film" else 2.0)),
        float(settings.get("durationMax") or (30.0 if narrative_mode == "film" else 12.0)),
        narrative_mode=narrative_mode,
    )
    d_hint = float(settings.get("defaultDurationSec") or (8.0 if narrative_mode == "film" else 5.0))
    d_hint = max(d_min, min(d_max, d_hint))

    # Always refresh look vs any sticky medium tags: skill / desk.style are authority
    force_style = bool(
        llm_kwargs.pop("force_style_refresh", None)
        or (desk_style or "").strip()
        or (sid and str(sid).lower() not in ("", "none"))
    )
    result = expand_story_auto(
        model=model,
        brief=brief_for_llm,
        shot_min=shot_min,
        shot_max=shot_max,
        duration_min=d_min,
        duration_max=d_max,
        duration_hint=d_hint,
        mode="REF2VA",
        continuity=continuity_for_llm,
        global_prompt="",
        desk_style=desk_style,
        desk_soundscape=desk_soundscape,
        desk_music=desk_music,
        backend=backend,
        skill_id=sid,
        system_prompt=novel_system or None,
        force_style_refresh=force_style,
        **llm_kwargs,
    )
    shots_raw = result.get("shots") or []
    shots: list[dict[str, Any]] = []
    for i, s in enumerate(shots_raw):
        if not isinstance(s, dict):
            continue
        prompt = str(s.get("prompt") or "").strip()
        if not prompt:
            continue
        # Normalize + harden cast/dialogue/fidelity before save
        prompt, cast_chars, cast_locs = harden_storyboard_shot(prompt, project)
        cast = {"characters": cast_chars, "locations": cast_locs}
        # expand_story_auto writes "duration"; older paths may use durationSec
        raw_dur = s.get("durationSec")
        if raw_dur is None:
            raw_dur = s.get("duration")
        dur = fit_novel_shot_duration(
            prompt,
            raw_dur,
            d_min=d_min,
            d_max=d_max,
            default=d_hint,
        )
        shots.append(
            {
                "index": i,
                "label": str(s.get("label") or f"分镜{i + 1}"),
                "prompt": prompt,
                "durationSec": dur,
                "characters": cast["characters"],
                "locations": cast["locations"],
                "refs": [],
                "status": "pending",
                "outputFile": "",
                "tailFrameFile": "",
                "error": "",
            }
        )
    if not shots:
        raise RuntimeError("章节分镜失败：未解析到有效分镜")

    if append and existing:
        base = len(existing)
        for j, s in enumerate(shots):
            s["index"] = base + j
            s["label"] = str(s.get("label") or f"分镜{s['index'] + 1}")
            ensure_shot_fields(s, s["index"])
        merged = list(existing) + shots
        if len(merged) > FILM_CHAPTER_SHOT_CAP:
            raise ValueError(f"追加后超过本章上限 {FILM_CHAPTER_SHOT_CAP} 镜")
        shots = merged
        # Prefer freshly generated global (style/skill may have changed); keep old only if empty
        new_gp = str(result.get("global_prompt") or result.get("globalPrompt") or "").strip()
        if new_gp:
            ch["globalPrompt"] = new_gp
        elif desk_style:
            try:
                from .local_director_runtime import reconcile_prompt_with_desk_style

                ch["globalPrompt"] = reconcile_prompt_with_desk_style(
                    str(ch.get("globalPrompt") or ""), desk_style
                )
            except Exception:
                pass
    else:
        for i, s in enumerate(shots):
            s["index"] = i
            ensure_shot_fields(s, i)
        ch["globalPrompt"] = str(result.get("global_prompt") or result.get("globalPrompt") or "")
        if desk_style and ch["globalPrompt"]:
            try:
                from .local_director_runtime import reconcile_prompt_with_desk_style

                ch["globalPrompt"] = reconcile_prompt_with_desk_style(
                    ch["globalPrompt"], desk_style
                )
            except Exception:
                pass

    ch["shots"] = shots
    ch["shotCount"] = len(shots)
    refresh_chapter_status_from_shots(ch)
    if ch.get("status") in {"pending", ""}:
        ch["status"] = "storyboarded"
    ch["error"] = ""
    ch["updatedAt"] = _now_iso()
    project["currentChapterId"] = ch["id"]
    mode_label = "电影" if narrative_mode == "film" else "短剧"
    action = "storyboard_append" if append else "storyboard"
    prog = count_shot_progress(shots)
    append_history(
        project,
        action,
        f"{ch.get('title')} · {'追加' if append else '重写'} "
        f"+{len(shots) - (len(existing) if append else 0)} 镜 → 共 {len(shots)} 镜"
        f"（完成 {prog['shotDoneCount']} · {mode_label}）",
    )
    cdir = _chapter_dir(str(project["projectId"]), ch)
    _write_json(
        cdir / "shots.json",
        {"globalPrompt": ch["globalPrompt"], "shots": shots, "narrativeMode": narrative_mode},
    )
    save_project(project)
    return {
        "chapter": ch,
        "shots": shots,
        "shotCount": len(shots),
        "appended": bool(append),
        "globalPrompt": ch["globalPrompt"],
        "narrativeMode": narrative_mode,
        **prog,
    }


def _extract_cast_from_prompt(prompt: str, assets: dict[str, Any]) -> dict[str, list[str]]:
    chars: list[str] = []
    locs: list[str] = []
    text = prompt or ""
    for m in CAST_LINE_RE.finditer(text):
        label = m.group(0)
        names = [n.strip() for n in NAME_SPLIT_RE.split(m.group(1) or "") if n.strip()]
        # Strip trailing punctuation / decorative quotes
        names = [re.sub(r"^[\s「」『』\"'“”]+|[\s「」『』\"'“”。．.]+$", "", n) for n in names]
        names = [n for n in names if n]
        is_loc = any(k in label for k in _LOC_LABEL_MARKERS)
        target = locs if is_loc else chars
        for n in names:
            if n not in target:
                target.append(n)

    def _collect(kind: str, into: list[str]) -> None:
        hits: list[tuple[int, str]] = []
        for item in assets.get(kind) or []:
            if not isinstance(item, dict):
                continue
            canonical = str(item.get("name") or "").strip()
            aliases = [str(a).strip() for a in (item.get("aliases") or []) if str(a).strip()]
            for n in [canonical] + aliases:
                if len(n) < 2:
                    continue
                if n in text:
                    hits.append((len(n), canonical or n))
                    break
        # Longer names first to reduce short false positives
        hits.sort(key=lambda x: -x[0])
        for _, name in hits:
            if name and name not in into:
                into.append(name)

    _collect("characters", chars)
    _collect("scenes", locs)
    return {"characters": chars[:8], "locations": locs[:6]}


def _asset_list(project: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    assets = project.setdefault("assets", _empty_assets())
    if not isinstance(assets, dict):
        assets = _empty_assets()
        project["assets"] = assets
    key = _normalize_asset_kind(kind)
    for k in ASSET_KINDS:
        assets.setdefault(k, [])
    lst = assets.setdefault(key, [])
    if not isinstance(lst, list):
        lst = []
        assets[key] = lst
    return lst


def _asset_has_image(asset: dict[str, Any] | None) -> bool:
    if not isinstance(asset, dict):
        return False
    return bool(
        str(asset.get("inputFile") or "").strip()
        or str(asset.get("imageFile") or "").strip()
        or str(asset.get("imagePath") or "").strip()
    )


def find_asset(
    project: dict[str, Any],
    kind: str,
    name: str,
    *,
    require_image: bool = False,
    fuzzy: bool = True,
) -> dict[str, Any] | None:
    """Exact name/alias match first; fuzzy uses Chinese overlap for 场景名漂移."""
    needle = _clean_place_name(name)
    if not needle:
        return None
    exact: list[dict[str, Any]] = []
    fuzzy_hits: list[tuple[float, dict[str, Any]]] = []
    for item in _asset_list(project, kind):
        if not isinstance(item, dict):
            continue
        names = _asset_names(item)
        matched = False
        for n in names:
            if n == needle or _clean_place_name(n) == needle:
                exact.append(item)
                matched = True
                break
        if matched or not fuzzy:
            continue
        best = 0.0
        for n in names:
            cn = _clean_place_name(n)
            best = max(best, _name_overlap_score(cn, needle))
            best = max(best, _best_substring_coverage(cn, needle))
            best = max(best, _best_substring_coverage(needle, cn) * 0.92)
            if cn in needle or needle in cn:
                best = max(best, 0.8)
        if best >= 0.34:
            fuzzy_hits.append((best, item))
    fuzzy_hits.sort(key=lambda x: -x[0])
    pool: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for item in exact + [h[1] for h in fuzzy_hits]:
        iid = str(item.get("id") or id(item))
        if iid in seen_ids:
            continue
        seen_ids.add(iid)
        pool.append(item)
    if require_image:
        imaged = [i for i in pool if _asset_has_image(i)]
        if imaged:
            return imaged[0]
        return None
    return pool[0] if pool else None


def _merge_name_lists(*lists: Any) -> list[str]:
    out: list[str] = []
    for lst in lists:
        for n in _normalize_name_list(lst):
            cleaned = _clean_place_name(n) or n
            if cleaned and cleaned not in out:
                out.append(cleaned)
    return out


def _pick_assets_for_shot(
    project: dict[str, Any],
    kind: str,
    names: list[str],
    *,
    prompt: str = "",
    min_score: float = 0.42,
    max_n: int = 3,
) -> list[dict[str, Any]]:
    """Rank library assets for this shot; keep those above ``min_score``."""
    explicit = _merge_name_lists(names)
    scored: list[tuple[float, dict[str, Any]]] = []
    for item in _asset_list(project, kind):
        if not isinstance(item, dict) or not _asset_has_image(item):
            continue
        sc = _score_asset_for_shot(item, prompt=prompt, explicit_names=explicit)
        if sc >= min_score:
            scored.append((sc, item))
    scored.sort(key=lambda x: -x[0])
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for sc, asset in scored[: max(1, max_n)]:
        key = str(asset.get("id") or asset.get("name") or id(asset))
        if key in seen:
            continue
        seen.add(key)
        # Learn aliases from explicit names that matched this asset
        for en in explicit:
            if _name_overlap_score(str(asset.get("name") or ""), en) >= 0.42 or any(
                _name_overlap_score(a, en) >= 0.42 for a in _asset_names(asset)
            ):
                _learn_asset_alias(asset, en)
        out.append(asset)
    return out


def _resolve_assets_by_names(
    project: dict[str, Any],
    kind: str,
    names: list[str],
    *,
    prompt: str = "",
) -> list[dict[str, Any]]:
    """Map free-form names → library assets that have images (overlap-aware)."""
    max_n = 6 if kind == "characters" else 1
    min_score = 0.50 if kind == "scenes" else 0.50
    # Scenes: do NOT score against the whole multimodal body (causes 串台).
    # Characters may still use prompt body hits for appearance names.
    score_prompt = "" if kind == "scenes" else prompt
    return _pick_assets_for_shot(
        project,
        kind,
        names,
        prompt=score_prompt,
        min_score=min_score,
        max_n=max_n,
    )


def _extract_scene_line_names(prompt: str) -> list[str]:
    """Only names from explicit 场景/地点 lines (not body prose)."""
    names: list[str] = []
    for m in CAST_LINE_RE.finditer(prompt or ""):
        label = m.group(0)
        if not any(k in label for k in _LOC_LABEL_MARKERS):
            continue
        for n in NAME_SPLIT_RE.split(m.group(1) or ""):
            cleaned = _clean_place_name(n)
            if cleaned and cleaned not in names:
                names.append(cleaned)
    return names


def _resolve_scene_assets_for_shot(
    project: dict[str, Any],
    loc_names: list[str],
    prompt: str,
) -> list[dict[str, Any]]:
    """Pick at most one scene asset from explicit 场景： names — avoid whole-prompt guess."""
    explicit = _merge_name_lists(loc_names, _extract_scene_line_names(prompt))
    out: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _add(asset: dict[str, Any] | None, alias: str = "") -> None:
        if not asset or not _asset_has_image(asset):
            return
        key = str(asset.get("id") or asset.get("name") or id(asset))
        if key in seen:
            return
        seen.add(key)
        if alias:
            _learn_asset_alias(asset, alias)
        out.append(asset)

    for name in explicit:
        _add(find_asset(project, "scenes", name, require_image=True, fuzzy=True), name)
        if out:
            break

    if out:
        return out[:1]

    # Soft match only against the joined 场景： names, never the full shot prose
    if explicit:
        joined = "，".join(explicit)
        soft = _pick_assets_for_shot(
            project,
            "scenes",
            explicit,
            prompt=joined,
            min_score=0.45,
            max_n=1,
        )
        return soft[:1]
    return []


def upsert_asset(
    project: dict[str, Any],
    *,
    kind: str,
    name: str,
    prompt: str = "",
    aliases: list[str] | None = None,
    image_path: str = "",
    image_b64: str = "",
    media_path: str = "",
    media_b64: str = "",
    filename: str = "",
    bind_character: str = "",
) -> dict[str, Any]:
    kind_key = _normalize_asset_kind(kind)
    lst = _asset_list(project, kind_key)
    item = find_asset(project, kind_key, name, fuzzy=False) if kind_key in ("audios", "videos") else find_asset(
        project, kind_key, name
    )
    if item is None:
        item = {
            "id": f"{kind_key[:4]}_{uuid.uuid4().hex[:8]}",
            "name": (name or "").strip() or "未命名",
            "aliases": [],
            "prompt": "",
            "imageFile": "",
            "imagePath": "",
            "mediaFile": "",
            "mediaPath": "",
            "audioFile": "",
            "videoFile": "",
            "inputFile": "",
            "bindCharacter": "",
        }
        lst.append(item)
    if aliases:
        merged = list(item.get("aliases") or [])
        for a in aliases:
            a = str(a).strip()
            if a and a not in merged and a != item.get("name"):
                merged.append(a)
        item["aliases"] = merged[:12]
    if prompt:
        item["prompt"] = prompt.strip()
    if bind_character:
        item["bindCharacter"] = str(bind_character).strip()[:80]

    rel_path = ""
    if kind_key in ("characters", "scenes"):
        if image_b64:
            rel_path = _save_asset_image(project, kind_key, item, image_b64)
        elif image_path:
            src = Path(image_path)
            if src.is_file():
                rel_path = _copy_asset_image(project, kind_key, item, src)
        if rel_path:
            item["imagePath"] = rel_path
            abs_path = project_dir(str(project["projectId"])) / rel_path
            item["imageFile"] = str(abs_path)
            staged = stage_image_to_input(
                str(project.get("projectId") or ""),
                abs_path,
                stem=str(item.get("name") or abs_path.stem),
            )
            if staged:
                item["inputFile"] = staged
    else:
        from ..lib.video_io import assert_ref_media_duration

        src_path: Path | None = None
        if media_b64:
            rel_path = _save_asset_media(project, kind_key, item, media_b64, filename=filename)
            src_path = project_dir(str(project["projectId"])) / rel_path
            try:
                assert_ref_media_duration(
                    str(src_path),
                    kind="音频" if kind_key == "audios" else "动作视频",
                )
            except Exception:
                try:
                    if src_path.is_file():
                        src_path.unlink()
                except Exception:
                    pass
                raise
        elif media_path:
            # Prefer Comfy input-relative path from chunk/upload
            cand = _resolve_input_media(media_path)
            if cand is not None:
                # Validate before copying into the project library
                assert_ref_media_duration(
                    str(cand),
                    kind="音频" if kind_key == "audios" else "动作视频",
                )
                rel_path = _copy_asset_media(project, kind_key, item, cand)
                src_path = project_dir(str(project["projectId"])) / rel_path
            else:
                src = Path(str(media_path).strip())
                if src.is_file():
                    assert_ref_media_duration(
                        str(src),
                        kind="音频" if kind_key == "audios" else "动作视频",
                    )
                    rel_path = _copy_asset_media(project, kind_key, item, src)
                    src_path = project_dir(str(project["projectId"])) / rel_path
        if rel_path and src_path is not None and src_path.is_file():
            item["mediaPath"] = rel_path
            item["mediaFile"] = str(src_path)
            try:
                from ..lib.video_io import probe_media_duration_sec

                dur = probe_media_duration_sec(str(src_path))
                if dur is not None:
                    item["durationSec"] = round(float(dur), 3)
            except Exception:
                pass
            staged = stage_image_to_input(
                str(project.get("projectId") or ""),
                src_path,
                stem=str(item.get("name") or src_path.stem),
            )
            if staged:
                item["inputFile"] = staged
                if kind_key == "audios":
                    item["audioFile"] = staged
                else:
                    item["videoFile"] = staged
    save_project(project)
    return item


def delete_asset(
    project: dict[str, Any],
    *,
    kind: str,
    asset_id: str = "",
    name: str = "",
    delete_files: bool = True,
) -> dict[str, Any]:
    """Remove a character/scene/audio/video from the global asset library."""
    kind_key = _normalize_asset_kind(kind)
    lst = _asset_list(project, kind_key)
    aid = str(asset_id or "").strip()
    needle = str(name or "").strip()
    removed: dict[str, Any] | None = None
    keep: list[dict[str, Any]] = []
    for item in lst:
        if not isinstance(item, dict):
            continue
        hit = False
        if aid and str(item.get("id") or "") == aid:
            hit = True
        elif needle and (
            str(item.get("name") or "").strip() == needle
            or needle in [str(a).strip() for a in (item.get("aliases") or [])]
        ):
            hit = True
        if hit and removed is None:
            removed = item
            continue
        keep.append(item)
    if removed is None:
        raise KeyError(f"资产不存在: {aid or needle or '(空)'}")
    assets = project.setdefault("assets", _empty_assets())
    assets[kind_key] = keep

    if delete_files:
        pid = str(project.get("projectId") or "")
        for key in ("imagePath", "mediaPath"):
            rel = str(removed.get(key) or "").strip()
            if pid and rel:
                try:
                    p = project_dir(pid) / rel
                    if p.is_file():
                        p.unlink()
                except Exception as exc:
                    log.warning("delete asset file failed %s: %s", rel, exc)
        for key in ("imageFile", "mediaFile", "audioFile", "videoFile"):
            abs_path = str(removed.get(key) or "").strip()
            if abs_path and _is_absolute_fs_path(abs_path):
                try:
                    ap = Path(abs_path)
                    if ap.is_file() and pid and str(project_dir(pid).resolve()) in str(ap.resolve()):
                        ap.unlink()
                except Exception:
                    pass
        inp = str(removed.get("inputFile") or "").strip().replace("\\", "/")
        if inp and not _is_absolute_fs_path(inp):
            try:
                cand = Path(folder_paths.get_input_directory()) / Path(inp)
                if cand.is_file():
                    cand.unlink()
            except Exception as exc:
                log.warning("delete staged input failed %s: %s", inp, exc)

    kind_label = {
        "characters": "人物",
        "scenes": "场景",
        "audios": "音频",
        "videos": "动作视频",
    }.get(kind_key, kind_key)
    append_history(
        project,
        "delete_asset",
        f"删除{kind_label}：{removed.get('name') or aid or needle}",
    )
    save_project(project)
    return {"removed": removed, "kind": kind_key, "assets": project.get("assets")}


def _resolve_input_media(media_path: str) -> Path | None:
    rel = str(media_path or "").replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    cand = Path(folder_paths.get_input_directory()) / Path(rel)
    return cand if cand.is_file() else None


def _save_asset_media(
    project: dict[str, Any],
    kind_key: str,
    item: dict[str, Any],
    media_b64: str,
    *,
    filename: str = "",
) -> str:
    raw = media_b64.strip()
    if "," in raw and raw.lower().startswith("data:"):
        raw = raw.split(",", 1)[1]
    data = base64.b64decode(raw)
    suffix = Path(filename or "").suffix or (".mp3" if kind_key == "audios" else ".mp4")
    rel = f"assets/{kind_key}/{_slug(item.get('name') or item.get('id'))}{suffix}"
    dest = project_dir(str(project["projectId"])) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return rel.replace("\\", "/")


def _copy_asset_media(project: dict[str, Any], kind_key: str, item: dict[str, Any], src: Path) -> str:
    suffix = src.suffix or (".mp3" if kind_key == "audios" else ".mp4")
    rel = f"assets/{kind_key}/{_slug(item.get('name') or item.get('id'))}{suffix}"
    dest = project_dir(str(project["projectId"])) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(src.read_bytes())
    return rel.replace("\\", "/")


def _save_asset_image(project: dict[str, Any], kind_key: str, item: dict[str, Any], image_b64: str) -> str:
    raw = image_b64.strip()
    if "," in raw and raw.lower().startswith("data:"):
        raw = raw.split(",", 1)[1]
    data = base64.b64decode(raw)
    rel = f"assets/{kind_key}/{_slug(item.get('name') or item.get('id'))}.png"
    dest = project_dir(str(project["projectId"])) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return rel.replace("\\", "/")


def _copy_asset_image(project: dict[str, Any], kind_key: str, item: dict[str, Any], src: Path) -> str:
    rel = f"assets/{kind_key}/{_slug(item.get('name') or item.get('id'))}{src.suffix or '.png'}"
    dest = project_dir(str(project["projectId"])) / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(src.read_bytes())
    return rel.replace("\\", "/")


def merge_extracted_assets(project: dict[str, Any], extract_result: dict[str, Any]) -> dict[str, Any]:
    """Merge extract_assets / asset_prompts into persistent novel asset library (no image yet)."""
    prompts = extract_result.get("asset_prompts") or extract_result.get("assets") or {}
    chars = prompts.get("characters") if isinstance(prompts, dict) else None
    scenes = prompts.get("scenes") if isinstance(prompts, dict) else None
    # Also accept flat lists
    if chars is None:
        chars = extract_result.get("characters") or []
    if scenes is None:
        scenes = extract_result.get("scenes") or []
    added = {"characters": 0, "scenes": 0}
    for c in chars or []:
        if isinstance(c, str):
            name, prompt = c, ""
        elif isinstance(c, dict):
            name = str(c.get("name") or c.get("label") or "").strip()
            prompt = str(c.get("prompt") or c.get("image_prompt") or "").strip()
        else:
            continue
        if not name:
            continue
        existed = find_asset(project, "characters", name)
        upsert_asset(project, kind="characters", name=name, prompt=prompt)
        if existed is None:
            added["characters"] += 1
    for s in scenes or []:
        if isinstance(s, str):
            name, prompt = s, ""
        elif isinstance(s, dict):
            name = str(s.get("name") or s.get("label") or "").strip()
            prompt = str(s.get("prompt") or s.get("image_prompt") or "").strip()
        else:
            continue
        if not name:
            continue
        existed = find_asset(project, "scenes", name)
        upsert_asset(project, kind="scenes", name=name, prompt=prompt)
        if existed is None:
            added["scenes"] += 1
    append_history(
        project,
        "extract_assets",
        f"+人物{added['characters']} +场景{added['scenes']}",
    )
    save_project(project)
    return {"added": added, "assets": project.get("assets")}


def sync_assets_from_timeline(project: dict[str, Any], timeline: dict[str, Any]) -> dict[str, Any]:
    """Pull generated guide_refs / asset_prompts images into novel asset library."""
    idir = timeline.get("image_director") if isinstance(timeline, dict) else {}
    if not isinstance(idir, dict):
        idir = {}
    asset_prompts = idir.get("asset_prompts") or {}
    if isinstance(asset_prompts, dict):
        merge_extracted_assets(project, {"asset_prompts": asset_prompts})
    guide_refs = idir.get("guide_refs") or []
    synced = 0
    for ref in guide_refs:
        if not isinstance(ref, dict):
            continue
        role = str(ref.get("role") or "").lower()
        label = str(ref.get("label") or ref.get("name") or "").strip()
        image_file = str(ref.get("imageFile") or ref.get("file") or "").strip()
        if not label or not image_file:
            continue
        kind = "characters" if role in {"character", "char", "人物"} else "scenes"
        if role in {"scene", "location", "场景"}:
            kind = "scenes"
        path = Path(image_file)
        if not path.is_file():
            # try under input/output
            for base in (
                Path(folder_paths.get_input_directory()),
                Path(folder_paths.get_output_directory()),
            ):
                cand = base / image_file
                if cand.is_file():
                    path = cand
                    break
        if path.is_file():
            upsert_asset(project, kind=kind, name=label, image_path=str(path))
            synced += 1
    append_history(project, "sync_assets", f"同步参考图 {synced} 张")
    save_project(project)
    return {"synced": synced, "assets": project.get("assets")}


def _resolve_asset_input_path(project: dict[str, Any], asset: dict[str, Any]) -> str:
    """Return input-relative path for UI preview + Queue (never absolute FS paths)."""
    inp = str(asset.get("inputFile") or "").strip().replace("\\", "/")
    if inp and not _is_absolute_fs_path(inp):
        cand = Path(folder_paths.get_input_directory()) / Path(inp)
        if cand.is_file():
            return inp
    src = ""
    p = str(asset.get("imageFile") or "").strip()
    if p and Path(p).is_file():
        src = p
    else:
        rel = str(asset.get("imagePath") or "").strip()
        if rel:
            full = project_dir(str(project["projectId"])) / rel
            if full.is_file():
                src = str(full)
                asset["imageFile"] = src
    if not src:
        return inp if inp and not _is_absolute_fs_path(inp) else ""
    staged = stage_image_to_input(
        str(project.get("projectId") or ""),
        src,
        stem=str(asset.get("name") or Path(src).stem),
    )
    if staged:
        asset["inputFile"] = staged
        return staged
    return ""


def _normalize_name_list(names: Any) -> list[str]:
    out: list[str] = []
    if not isinstance(names, list):
        return out
    for n in names:
        s = str(n or "").strip()
        if s and s not in out:
            out.append(s)
    return out


def bind_chapter_refs(project: dict[str, Any], chapter_id: str) -> dict[str, Any]:
    """Attach only cast-matched character/scene images to each shot (dense Picture 1–N).

    Scene refs are reserved (not crowded out by characters). Names resolve with fuzzy
    match so「教室」can bind to asset「小学教室」.
    """
    ch = get_chapter(project, chapter_id)
    shots = ch.get("shots") or []
    if not shots:
        raise ValueError("请先完成本章分镜")
    # Ensure assets are staged so shot refs use Comfy input-relative paths (UI /view).
    stage_project_assets_to_input(project)
    has_any = any(
        _asset_has_image(a)
        for kind in ("characters", "scenes")
        for a in _asset_list(project, kind)
    )
    if not has_any:
        raise ValueError("全局参考图库为空：请先提取/上传人物与场景参考图")

    max_refs = 9
    bound_shots = 0
    bound_refs = 0
    bound_scene_refs = 0

    for shot in shots:
        if not isinstance(shot, dict):
            continue
        prompt = str(shot.get("prompt") or "")
        # Align 场景/出场 lines to library names before matching
        prompt = _rewrite_cast_line_names(prompt, project)
        cast = _extract_cast_from_prompt(prompt, project.get("assets") or {})
        # Merge storyboard cast + prompt lines + asset-name hits (do not let stale
        # unmatched names block library hits).
        char_names = _merge_name_lists(shot.get("characters"), cast.get("characters"))
        loc_names = _merge_name_lists(shot.get("locations"), cast.get("locations"))
        char_assets = _resolve_assets_by_names(
            project, "characters", char_names, prompt=prompt
        )
        # Scenes: only from「场景：」/locations — never fuzzy whole-prompt (prevents 串台)
        loc_assets = _resolve_scene_assets_for_shot(project, loc_names, prompt)

        shot["characters"] = [str(a.get("name") or "") for a in char_assets if a.get("name")]
        shot["locations"] = [str(a.get("name") or "") for a in loc_assets if a.get("name")]
        # Keep rewritten cast lines in stored prompt
        shot["prompt"] = prompt

        packed: list[dict[str, Any]] = []
        seen_paths: set[str] = set()

        def _push(asset: dict[str, Any] | None, role: str) -> bool:
            nonlocal packed
            if not asset or len(packed) >= max_refs:
                return False
            path = _resolve_asset_input_path(project, asset)
            if not path or path in seen_paths:
                return False
            seen_paths.add(path)
            name = str(asset.get("name") or "")
            idx = len(packed)
            packed.append(
                {
                    "index": idx,
                    "slot": idx,
                    "imageFile": path,
                    "label": name,
                    "role": role,
                    "roleLabel": name or ("人物" if role == "character" else "场景"),
                }
            )
            return True

        # One primary scene slot reserved; characters fill the rest
        scene_budget = min(1, len(loc_assets), max_refs)
        char_budget = min(len(char_assets), max_refs - scene_budget)
        for asset in char_assets[:char_budget]:
            _push(asset, "character")
        for asset in loc_assets[:scene_budget]:
            if _push(asset, "scene"):
                bound_scene_refs += 1

        shot["refs"] = packed
        # Stronger scene lock line in stored prompt for UI + generation
        prompt_locked = _ensure_picture_tags(prompt, packed)
        if loc_assets and packed:
            scene_ref = next((r for r in packed if r.get("role") == "scene"), None)
            if scene_ref is not None:
                pic_n = int(scene_ref.get("index", 0)) + 1
                lock = (
                    f"【场景锁定】本镜环境以 <Picture {pic_n}>（{scene_ref.get('label') or '场景'}）为准，"
                    "背景与空间不得漂到其它地点。"
                )
                if "【场景锁定】" not in prompt_locked:
                    prompt_locked = f"{lock}\n{prompt_locked}"
        shot["prompt"] = prompt_locked
        if packed:
            bound_shots += 1
            bound_refs += len(packed)

    ch["shots"] = shots
    ch["status"] = "refs_ready"
    ch["error"] = ""
    ch["updatedAt"] = _now_iso()
    append_history(
        project,
        "bind_refs",
        f"{ch.get('title')} · 按镜挂接 {bound_shots}/{len(shots)} 镜 · "
        f"{bound_refs} 张参考（含场景 {bound_scene_refs}）",
    )
    cdir = _chapter_dir(str(project["projectId"]), ch)
    _write_json(cdir / "shots.json", {"globalPrompt": ch.get("globalPrompt"), "shots": shots})
    save_project(project)
    return {
        "chapter": ch,
        "shotCount": len(shots),
        "boundShots": bound_shots,
        "boundRefs": bound_refs,
        "boundSceneRefs": bound_scene_refs,
    }


def _film_media_input_path(asset: dict[str, Any] | None) -> str:
    if not isinstance(asset, dict):
        return ""
    for key in ("inputFile", "audioFile", "videoFile", "mediaFile"):
        val = str(asset.get(key) or "").strip().replace("\\", "/")
        if not val or _is_absolute_fs_path(val):
            continue
        cand = Path(folder_paths.get_input_directory()) / Path(val)
        if cand.is_file():
            return val
    return ""


def _film_clip_fields(item: dict[str, Any] | None) -> dict[str, float]:
    """Per-shot source clip window (seconds). endSec<=0 means 'to end / gen length'."""
    if not isinstance(item, dict):
        return {"startSec": 0.0, "endSec": 0.0}
    try:
        start = max(0.0, float(item.get("startSec") if item.get("startSec") is not None else item.get("start_sec") or 0))
    except (TypeError, ValueError):
        start = 0.0
    try:
        end_raw = item.get("endSec") if item.get("endSec") is not None else item.get("end_sec")
        end = float(end_raw) if end_raw not in (None, "") else 0.0
    except (TypeError, ValueError):
        end = 0.0
    if end < 0:
        end = 0.0
    if end > 0 and end <= start:
        end = 0.0
    return {"startSec": start, "endSec": end}


def _film_lookup_asset(project: dict[str, Any], kind: str, item: dict[str, Any]) -> dict[str, Any] | None:
    aid = str(item.get("assetId") or item.get("id") or "").strip()
    path_hint = _film_media_input_path(item) if item else ""
    label = str(item.get("label") or item.get("name") or "").strip()
    for a in _asset_list(project, kind):
        if not isinstance(a, dict):
            continue
        if aid and str(a.get("id") or "") == aid:
            return a
        ap = _film_media_input_path(a)
        if path_hint and ap and ap == path_hint:
            return a
        if label and str(a.get("name") or "").strip() == label and ap:
            return a
    return None


def _normalize_film_shot_audios(
    project: dict[str, Any],
    shot: dict[str, Any],
    ui_seg: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Per-shot audio only — never auto-inject the whole library onto every shot."""
    raw = []
    if isinstance(ui_seg, dict) and isinstance(ui_seg.get("refAudios"), list):
        raw = ui_seg.get("refAudios") or []
    elif isinstance(shot.get("refAudios"), list):
        raw = shot.get("refAudios") or []
    elif isinstance(shot.get("ref_audios"), list):
        raw = shot.get("ref_audios") or []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        asset = _film_lookup_asset(project, "audios", item)
        path = _film_media_input_path(asset or item)
        if not path:
            continue
        clip = _film_clip_fields(item)
        idx = len(out)
        try:
            slot = int(item.get("index", item.get("slot", idx)))
        except (TypeError, ValueError):
            slot = idx
        out.append(
            {
                "index": max(0, min(2, slot if 0 <= slot < 3 else idx)),
                "assetId": str((asset or {}).get("id") or item.get("assetId") or ""),
                "audioFile": path,
                "fileName": Path(path).name,
                "type": "input",
                "subfolder": "",
                "label": str(item.get("label") or (asset or {}).get("name") or ""),
                "startSec": clip["startSec"],
                "endSec": clip["endSec"],
            }
        )
        if len(out) >= 3:
            break
    # Re-index densely 0..n-1
    for i, e in enumerate(out):
        e["index"] = i
    shot["refAudios"] = out
    return out


def _normalize_film_shot_videos(
    project: dict[str, Any],
    shot: dict[str, Any],
    ui_seg: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Per-shot motion/reference videos with optional source clip window."""
    raw = []
    if isinstance(ui_seg, dict) and isinstance(ui_seg.get("refVideos"), list):
        raw = ui_seg.get("refVideos") or []
    elif isinstance(shot.get("refVideos"), list):
        raw = shot.get("refVideos") or []
    elif isinstance(shot.get("ref_videos"), list):
        raw = shot.get("ref_videos") or []
    out: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        asset = _film_lookup_asset(project, "videos", item)
        path = _film_media_input_path(asset or item)
        if not path:
            continue
        clip = _film_clip_fields(item)
        idx = len(out)
        try:
            slot = int(item.get("index", item.get("slot", idx)))
        except (TypeError, ValueError):
            slot = idx
        out.append(
            {
                "index": max(0, min(2, slot if 0 <= slot < 3 else idx)),
                "assetId": str((asset or {}).get("id") or item.get("assetId") or ""),
                "videoFile": path,
                "fileName": Path(path).name,
                "type": "input",
                "subfolder": "",
                "label": str(item.get("label") or (asset or {}).get("name") or ""),
                "bindCharacter": str(
                    item.get("bindCharacter")
                    or (asset or {}).get("bindCharacter")
                    or ""
                ),
                "startSec": clip["startSec"],
                "endSec": clip["endSec"],
            }
        )
        if len(out) >= 3:
            break
    for i, e in enumerate(out):
        e["index"] = i
    shot["refVideos"] = out
    return out


def _ensure_picture_tags(prompt: str, refs: list[dict[str, Any]]) -> str:
    prompt = (prompt or "").strip()
    # Drop stale 参考： / 主体绑定： prefix from a previous bind
    lines = prompt.split("\n")
    while lines and (
        lines[0].startswith("参考：")
        or lines[0].startswith("主体绑定：")
        or lines[0].startswith(_FIDELITY_SHOT_MARKER)
    ):
        # keep fidelity marker — re-inject later if stripped
        if lines[0].startswith(_FIDELITY_SHOT_MARKER):
            break
        lines = lines[1:]
        prompt = "\n".join(lines).strip()
    present = set(re.findall(r"<Picture\s+(\d+)\s*>", prompt, flags=re.I))
    tags: list[str] = []
    bind_bits: list[str] = []
    for ref in refs:
        if not isinstance(ref, dict) or not ref.get("imageFile"):
            continue
        try:
            i = int(ref.get("index", ref.get("slot")))
        except (TypeError, ValueError):
            continue
        if i < 0:
            continue
        n = str(i + 1)
        label = str(ref.get("label") or "").strip()
        role = str(ref.get("role") or "")
        hint = label or ("人物" if role == "character" else "场景" if role == "scene" else "")
        tag = f"<Picture {n}>（{hint}）" if hint else f"<Picture {n}>"
        if n not in present:
            tags.append(tag)
        if hint:
            kind = "场景" if role == "scene" else "人物"
            bind_bits.append(f"{kind}「{hint}」= <Picture {n}>")
    head: list[str] = []
    if bind_bits:
        head.append("主体绑定：" + "；".join(bind_bits) + "。开口说话者必须对应其人物图。")
    if tags:
        head.append("参考：" + " ".join(tags))
    if not head:
        return _inject_fidelity_shot_lock(prompt)
    merged = "\n".join(head) + ("\n" + prompt if prompt else "")
    return _inject_fidelity_shot_lock(merged)


def prepare_chapter_timeline(
    project: dict[str, Any],
    chapter_id: str,
    timeline: dict | None = None,
    *,
    product_task: str | None = None,
    resume: bool = True,
    batch_limit: int | None = None,
) -> dict[str, Any]:
    """Build timeline segments/global refs for Queue (novel short-drama or film).

    Default (batch_limit=0): load whole chapter/act; resume skips already-done shots.
    batch_limit>0: optional partial batch (film mega-act fallback).
    Act opening shot clears inherited tailFrameFile (no cross-act hard lock).
    """
    from ..lib.task_prompts import resolve_task_key
    from .film_resume import (
        count_shot_progress,
        ensure_shot_fields,
        hydrate_chapter_shots,
        normalize_shot_status,
        refresh_chapter_status_from_shots,
    )
    from .skill_presets import normalize_novel_narrative_mode

    stage_project_assets_to_input(project)
    ch = get_chapter(project, chapter_id)
    shots = hydrate_chapter_shots(project, ch)
    if not shots:
        shots = ch.get("shots") or []
    if not shots:
        raise ValueError("请先完成本章分镜")
    # Always re-bind per-shot cast refs so library dump / stale absolute paths are healed
    try:
        bind_chapter_refs(project, chapter_id)
        ch = get_chapter(project, chapter_id)
        shots = hydrate_chapter_shots(project, ch) or (ch.get("shots") or [])
    except ValueError:
        # allow storyboard-only prepare without refs
        pass

    settings = project.get("settings") or default_novel_settings()
    if not isinstance(settings, dict):
        settings = default_novel_settings()
        project["settings"] = settings
    pt = resolve_task_key(product_task or "")
    if pt not in {"novel", "film"}:
        pt = "film" if normalize_novel_narrative_mode(settings.get("narrativeMode")) == "film" else "novel"
    # Force narrative mode from product task (film / novel are separate entries)
    want_mode = "film" if pt == "film" else "short_drama"
    if normalize_novel_narrative_mode(settings.get("narrativeMode")) != want_mode:
        settings.update(narrative_mode_presets(want_mode))
        project["settings"] = settings

    for i, s in enumerate(shots):
        if isinstance(s, dict):
            ensure_shot_fields(s, i)

    # Which shots to generate this Queue
    pending_idxs = [
        i
        for i, s in enumerate(shots)
        if isinstance(s, dict) and normalize_shot_status(s.get("status")) != "done"
    ]
    try:
        lim = int(batch_limit if batch_limit is not None else 0)
    except (TypeError, ValueError):
        lim = 0
    # Film = per-act (like short-drama chapter): load whole act unless explicit batch_limit > 0
    if resume and lim > 0:
        selected_idxs = set(pending_idxs[: max(1, min(16, lim))])
    else:
        selected_idxs = set(range(len(shots))) if not resume else set(pending_idxs)

    tl = dict(timeline) if isinstance(timeline, dict) else {}
    # Compact novel for timeline widget — full chapter text/shots stay on disk only.
    tl["novel"] = timeline_novel_patch(project)
    tl.setdefault("global", {})
    if isinstance(tl["global"], dict):
        tl["global"]["taskType"] = pt
        gp = ch.get("globalPrompt") or tl["global"].get("prompt") or ""
        desk_style = ""
        try:
            desk_style = str((tl.get("desk") or {}).get("style") or "").strip()
        except Exception:
            desk_style = ""
        if desk_style and gp:
            try:
                from .local_director_runtime import reconcile_prompt_with_desk_style

                gp = reconcile_prompt_with_desk_style(str(gp), desk_style)
                ch["globalPrompt"] = gp
            except Exception:
                pass
        tl["global"]["prompt"] = gp
        # Novel/film: refs live on each shot — do not dump whole library into global strip
        tl["global"]["refs"] = []
    # Multi-shot: default 链式连贯 ON
    tl.setdefault("output", {})
    if isinstance(tl["output"], dict):
        out = tl["output"]
        if out.get("continuityEnabled") is False or out.get("continuity_enabled") is False:
            out["continuityEnabled"] = False
        else:
            out["continuityEnabled"] = True
        out.pop("continuity_enabled", None)
        # Explicit partial batch only: export selected segments
        if resume and lim > 0 and len(selected_idxs) < len(shots):
            out["exportMode"] = "segments"
            out["runScope"] = "selected"
        # 电影模式：默认横屏电影感画幅（用户已自定义则不覆盖）
        if pt == "film":
            if not out.get("aspectRatio") and not out.get("aspect_ratio"):
                out["aspectRatio"] = "16:9"
            try:
                w = int(out.get("width") or 0)
                h = int(out.get("height") or 0)
            except (TypeError, ValueError):
                w, h = 0, 0
            if w <= 0 or h <= 0 or (w < h):
                out["mode"] = "fixed"
                out["width"] = int(out.get("width") or 864)
                out["height"] = int(out.get("height") or 480)
                out["longEdge"] = max(int(out.get("width") or 864), int(out.get("height") or 480))
    # Select-run batch so continuity can still resolve prev via tailFrameFile
    if selected_idxs and len(selected_idxs) < len(shots):
        tl["runSelectEnabled"] = True
        tl["run_select_enabled"] = True
        tl["runSelection"] = sorted(selected_idxs)
        tl["run_selection"] = sorted(selected_idxs)
    else:
        tl["runSelectEnabled"] = False
        tl["run_select_enabled"] = False
        tl.pop("runSelection", None)
        tl.pop("run_selection", None)
    segments: list[dict[str, Any]] = []
    pid = str(project.get("projectId") or "")
    input_root = Path(folder_paths.get_input_directory()).resolve()
    cdir = _chapter_dir(pid, ch)

    def _to_input_rel(raw_path: str, label: str, slot: int) -> str:
        raw_path = (raw_path or "").strip()
        if not raw_path:
            return ""
        norm = raw_path.replace("\\", "/")
        # Already an input-relative path (e.g. minimax_novel/<pid>/foo.png)
        if not _is_absolute_fs_path(norm):
            cand = Path(folder_paths.get_input_directory()) / Path(norm)
            if cand.is_file():
                return norm
        src = Path(raw_path)
        if not src.is_file():
            # Never hand absolute FS paths to the frontend /view API
            return "" if _is_absolute_fs_path(norm) else norm
        try:
            rel = src.resolve().relative_to(input_root)
            return rel.as_posix()
        except Exception:
            pass
        return stage_image_to_input(pid, src, stem=label or f"slot{slot + 1}_{src.stem}")

    def _shot_ref_at(refs: list, i: int) -> dict[str, Any]:
        """Resolve shot ref for slot i (supports indexed or positional arrays)."""
        if not isinstance(refs, list):
            return {}
        for r in refs:
            if not isinstance(r, dict):
                continue
            idx = r.get("index", r.get("slot"))
            if idx is not None:
                try:
                    if int(idx) == i:
                        return r
                except (TypeError, ValueError):
                    pass
        if i < len(refs) and isinstance(refs[i], dict):
            # Positional fallback only when entries lack index/slot
            if refs[i].get("index") is None and refs[i].get("slot") is None:
                return refs[i]
        return {}

    for shot in shots:
        if not isinstance(shot, dict):
            continue
        refs = shot.get("refs") or []
        # Sparse indexed refs for 分镜清单 /view + Queue (must include index)
        norm_refs: list[dict[str, Any]] = []
        for i in range(9):
            r = _shot_ref_at(refs, i)
            raw_path = str(r.get("imageFile") or r.get("inputFile") or "").strip()
            if not raw_path:
                rel_hint = str(r.get("imagePath") or "").strip()
                if rel_hint:
                    cand = project_dir(pid) / rel_hint
                    if cand.is_file():
                        raw_path = str(cand)
            staged = _to_input_rel(raw_path, str(r.get("label") or ""), i)
            if not staged:
                continue
            role = str(r.get("role") or ("character" if i < 4 else "scene"))
            label = str(r.get("label") or "")
            entry = {
                "index": i,
                "slot": i,
                "imageFile": staged,
                "label": label,
                "role": role,
                "roleLabel": label or ("人物" if role == "character" else "场景" if role == "scene" else ""),
            }
            norm_refs.append(entry)
        prompt = str(shot.get("prompt") or "").strip()
        shot_i = int(shot.get("index") if shot.get("index") is not None else len(segments))
        # Prefer UI hand-tuned duration from timeline.segments (novelShotIndex / position)
        ui_dur = None
        ui_manual = False
        ui_prompt = None
        segs_in = [s for s in (tl.get("segments") or []) if isinstance(s, dict)]
        ui_seg = None
        for cand in segs_in:
            nsi = cand.get("novelShotIndex")
            if nsi is not None:
                try:
                    if int(nsi) == shot_i:
                        ui_seg = cand
                        break
                except (TypeError, ValueError):
                    continue
        if ui_seg is None and 0 <= shot_i < len(segs_in):
            cand = segs_in[shot_i]
            cid = str(cand.get("novelChapterId") or "")
            if not cid or cid == str(ch.get("id") or ""):
                ui_seg = cand
        if ui_seg is not None:
            raw_ui = ui_seg.get("durationSec")
            if raw_ui is None:
                raw_ui = ui_seg.get("duration")
            try:
                if raw_ui is not None and str(raw_ui).strip() != "":
                    ui_dur = float(raw_ui)
                    ui_manual = bool(ui_seg.get("durationManual") or ui_seg.get("duration_manual"))
            except (TypeError, ValueError):
                ui_dur = None
            up = str(ui_seg.get("prompt") or "").strip()
            if up:
                ui_prompt = up
        if ui_prompt:
            prompt = ui_prompt
            shot["prompt"] = prompt
        try:
            d_min = float(settings.get("durationMin") or 2.0)
            d_max = float(settings.get("durationMax") or 12.0)
            default = float(settings.get("defaultDurationSec") or 5.0)
            if ui_dur is not None:
                # UI / hand-tuned seconds: only clamp — do NOT re-fit by dialogue length
                dur = max(d_min, min(d_max, float(ui_dur)))
                if ui_manual:
                    shot["durationManual"] = True
            else:
                raw_dur = shot.get("durationSec")
                if raw_dur is None:
                    raw_dur = shot.get("duration")
                if shot.get("durationManual"):
                    try:
                        dur = max(d_min, min(d_max, float(raw_dur if raw_dur is not None else default)))
                    except (TypeError, ValueError):
                        dur = default
                else:
                    dur = fit_novel_shot_duration(
                        prompt,
                        raw_dur,
                        d_min=d_min,
                        d_max=d_max,
                        default=default,
                    )
        except (TypeError, ValueError):
            dur = float(settings.get("defaultDurationSec") or 5.0)
        try:
            shot["durationSec"] = dur
        except Exception:
            pass
        ensure_shot_fields(shot, shot_i)
        st = normalize_shot_status(shot.get("status"))
        run_sel = shot_i in selected_idxs
        # Act/chapter boundary: first shot never inherits another unit's tail
        act_boundary = shot_i == 0
        # Resolve persisted tail for continuity within this act only (never cross-act)
        tail_rel = str(shot.get("tailFrameFile") or "").strip().replace("\\", "/")
        tail_abs = ""
        if act_boundary:
            # Do not feed previous act's last frame into this act's opening shot
            tail_rel = ""
            try:
                shot["tailFrameFile"] = ""
            except Exception:
                pass
        elif tail_rel:
            cand = cdir / tail_rel
            if cand.is_file():
                # Ensure path stays under this chapter dir (block cross-act absolute leaks)
                try:
                    cand.resolve().relative_to(cdir.resolve())
                    tail_abs = str(cand)
                except Exception:
                    tail_rel = ""
                    tail_abs = ""
            elif Path(tail_rel).is_file():
                try:
                    Path(tail_rel).resolve().relative_to(cdir.resolve())
                    tail_abs = tail_rel
                except Exception:
                    tail_rel = ""
                    tail_abs = ""
            else:
                tail_rel = ""
        ref_audios: list[dict[str, Any]] = []
        ref_videos: list[dict[str, Any]] = []
        seg_task = pt
        if pt == "film":
            # Per-shot only — no global BGM / motion auto-inject on every shot
            ref_audios = _normalize_film_shot_audios(project, shot, ui_seg)
            ref_videos = _normalize_film_shot_videos(project, shot, ui_seg)
            # Keep taskType=film so storyboard prompts are preserved; videos are r2v-style refs
            seg_task = "film"
        segments.append(
            {
                "id": f"{ch['id']}_shot{shot_i + 1}",
                "label": shot.get("label") or f"分镜{len(segments) + 1}",
                "prompt": prompt,
                "durationSec": dur,
                "durationManual": bool(shot.get("durationManual") or ui_manual),
                "runSelected": bool(run_sel),
                "run_selected": bool(run_sel),
                "refs": norm_refs,
                "refAudios": ref_audios,
                "refVideos": ref_videos,
                "taskType": seg_task,
                "novelChapterId": ch["id"],
                "novelShotIndex": shot_i,
                "novelShotStatus": st,
                "tailFrameFile": tail_abs or tail_rel,
                "actBoundary": bool(act_boundary),
                "act_boundary": bool(act_boundary),
                "characters": list(shot.get("characters") or []),
                "locations": list(shot.get("locations") or []),
            }
        )
    tl["segments"] = segments
    # guide_refs: unique assets actually used by this chapter's shots
    idir = tl.setdefault("image_director", {})
    if not isinstance(idir, dict):
        idir = {}
        tl["image_director"] = idir
    guide = []
    seen_guide: set[str] = set()
    for seg in segments:
        for r in seg.get("refs") or []:
            if not isinstance(r, dict):
                continue
            path = str(r.get("imageFile") or "")
            if not path or path in seen_guide:
                continue
            seen_guide.add(path)
            guide.append(
                {
                    "role": r.get("role") or "character",
                    "label": r.get("label") or path,
                    "imageFile": path,
                }
            )
    idir["guide_refs"] = guide

    ch["status"] = "generating"
    ch["error"] = ""
    ch["updatedAt"] = _now_iso()
    project["currentChapterId"] = ch["id"]
    refresh_chapter_status_from_shots(ch)
    # keep generating while batch in progress
    if selected_idxs:
        ch["status"] = "generating"
    mode_tag = "电影" if pt == "film" else "短剧"
    prog = count_shot_progress(shots)
    append_history(
        project,
        "prepare",
        f"{ch.get('title')} · {mode_tag} · 本批 Queue {len(selected_idxs)}/"
        f"{prog['shotCount']} 镜（已完成 {prog['shotDoneCount']}）",
    )
    # Persist hand-tuned durations / prompts back to shots.json
    try:
        ch["shots"] = shots
        _write_json(cdir / "shots.json", {"globalPrompt": ch.get("globalPrompt"), "shots": shots})
    except Exception as exc:
        log.warning("persist prepared shots failed: %s", exc)
    save_project(project)
    # Refresh compact novel AFTER status write so UI/timeline keep 生成中
    tl["novel"] = timeline_novel_patch(project)
    return {
        "timeline": tl,
        "chapter": chapter_summary(ch),
        "segmentCount": len(segments),
        "selectedCount": len(selected_idxs),
        "pendingCount": prog["shotPendingCount"],
        "doneCount": prog["shotDoneCount"],
        "taskType": pt,
        "novel": timeline_novel_patch(project),
        **prog,
    }


def update_chapter_progress(
    project_id: str,
    chapter_id: str,
    *,
    status: str,
    output_path: str = "",
    error: str = "",
) -> dict[str, Any]:
    project = load_project(project_id)
    ch = get_chapter(project, chapter_id)
    if status not in CHAPTER_STATUSES:
        raise ValueError(f"无效状态: {status}")
    ch["status"] = status
    if output_path:
        ch["outputPath"] = output_path
    ch["error"] = error or ""
    ch["updatedAt"] = _now_iso()
    if status == "done":
        nxt = first_incomplete_chapter(project)
        project["currentChapterId"] = nxt["id"] if nxt else ch["id"]
    else:
        project["currentChapterId"] = ch["id"]
    append_history(project, "progress", f"{ch.get('title')} → {status}")
    save_project(project)
    return {"project": project, "chapter": ch}


def chapter_summary(ch: dict[str, Any] | None) -> dict[str, Any]:
    """Lightweight chapter row for timeline UI (disk keeps full text/shots)."""
    from .film_resume import count_shot_progress

    if not isinstance(ch, dict):
        return {}
    shots = ch.get("shots") if isinstance(ch.get("shots"), list) else []
    prog = count_shot_progress(shots)
    shot_count = ch.get("shotCount")
    try:
        shot_count = int(shot_count) if shot_count is not None else prog["shotCount"]
    except (TypeError, ValueError):
        shot_count = prog["shotCount"]
    return {
        "id": ch.get("id") or "",
        "index": ch.get("index") if ch.get("index") is not None else 0,
        "title": ch.get("title") or "",
        "status": ch.get("status") or "pending",
        "shotCount": max(0, shot_count),
        "shotDoneCount": prog["shotDoneCount"],
        "shotPendingCount": prog["shotPendingCount"],
        "updatedAt": ch.get("updatedAt") or "",
        "outputPath": ch.get("outputPath") or "",
        "error": ch.get("error") or "",
        "narrativeUnit": ch.get("narrativeUnit") or "",
        "parentActTitle": ch.get("parentActTitle") or "",
        "parentActId": ch.get("parentActId") or "",
        "segmentIndex": ch.get("segmentIndex"),
        "segmentCount": ch.get("segmentCount"),
        "estimatedMinutes": ch.get("estimatedMinutes"),
        "maxMinutes": ch.get("maxMinutes"),
    }


def _slim_asset(asset: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(asset, dict):
        return {}
    return {
        "id": asset.get("id") or "",
        "name": asset.get("name") or "",
        "aliases": list(asset.get("aliases") or []) if isinstance(asset.get("aliases"), list) else [],
        "imageFile": asset.get("imageFile") or "",
        "inputFile": asset.get("inputFile") or "",
        "imagePath": asset.get("imagePath") or "",
        "mediaFile": asset.get("mediaFile") or "",
        "mediaPath": asset.get("mediaPath") or "",
        "audioFile": asset.get("audioFile") or "",
        "videoFile": asset.get("videoFile") or "",
        "bindCharacter": asset.get("bindCharacter") or "",
    }


def timeline_novel_patch(project: dict[str, Any]) -> dict[str, Any]:
    """Compact novel state for Comfy timeline widget (status/history survive reopen)."""
    from .film_resume import hydrate_chapter_shots

    chapters_raw = project.get("chapters") or []
    chapters = []
    for c in chapters_raw:
        if not isinstance(c, dict):
            continue
        try:
            hydrate_chapter_shots(project, c)
        except Exception:
            pass
        chapters.append(chapter_summary(c))
    hist = project.get("history") if isinstance(project.get("history"), list) else []
    assets = project.get("assets") if isinstance(project.get("assets"), dict) else {}
    return {
        "projectId": project.get("projectId") or "",
        "title": project.get("title") or "",
        "productTask": _project_product(project),
        "importMeta": project.get("importMeta") if isinstance(project.get("importMeta"), dict) else {},
        "chapters": chapters,
        "currentChapterId": project.get("currentChapterId") or "",
        "history": hist[-40:],
        "assets": {
            "characters": [
                _slim_asset(a) for a in (assets.get("characters") or []) if isinstance(a, dict)
            ],
            "scenes": [
                _slim_asset(a) for a in (assets.get("scenes") or []) if isinstance(a, dict)
            ],
            "audios": [
                _slim_asset(a) for a in (assets.get("audios") or []) if isinstance(a, dict)
            ],
            "videos": [
                _slim_asset(a) for a in (assets.get("videos") or []) if isinstance(a, dict)
            ],
        },
        "settings": project.get("settings") or default_novel_settings(),
        "updatedAt": project.get("updatedAt") or "",
    }


def mark_chapter_done_from_timeline(timeline: dict[str, Any], output_path: str = "") -> dict[str, Any] | None:
    novel = timeline.get("novel") if isinstance(timeline, dict) else None
    if not isinstance(novel, dict):
        return None
    pid = str(novel.get("projectId") or "").strip()
    cid = str(novel.get("currentChapterId") or "").strip()
    if not pid or not cid:
        return None
    try:
        return update_chapter_progress(pid, cid, status="done", output_path=output_path)
    except Exception as exc:
        log.warning("novel progress mark failed: %s", exc)
        return None
