/** Shared helpers for MiniMax H3 Director generation tasks. */

/** MiniMax H3 canvas snap (official nodes use 32). */
export const MINIMAX_CANVAS_MULTIPLE = 32;

/** ResolutionSelector aspect presets (UI labels in Chinese; ratios match official node). */
export const RESOLUTION_ASPECTS = [
    ["1:1 (方形)", 1, 1],
    ["2:3 (竖版照片)", 2, 3],
    ["3:2 (横版照片)", 3, 2],
    ["3:4 (竖版标准)", 3, 4],
    ["4:3 (标准)", 4, 3],
    ["9:16 (竖屏)", 9, 16],
    ["16:9 (宽屏)", 16, 9],
    ["21:9 (超宽)", 21, 9],
];

export const DEFAULT_ASPECT_RATIO = "16:9 (宽屏)";
/** Manual width × height (not in official ResolutionSelector). */
export const CUSTOM_ASPECT_RATIO = "自定义";
/** Official MiniMax template default: 0.4 MP → 864×480 at 16:9 (multiple=32) */
export const DEFAULT_MEGAPIXELS = 0.4;
export const MIN_MEGAPIXELS = 0.1;
export const MAX_MEGAPIXELS = 16;

/** Clamp a finished megapixel value into the allowed range. */
export function clampMegapixels(value, fallback = DEFAULT_MEGAPIXELS) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(MAX_MEGAPIXELS, Math.max(MIN_MEGAPIXELS, n));
}

/**
 * Parse megapixels from a number input while the user may still be typing.
 * Returns null for incomplete drafts ("" / "0" / "0." / ".") so UI must not coerce to default.
 */
export function parseMegapixelsInput(raw) {
    const s = String(raw ?? "").trim();
    if (!s || s === "." || s === "-" || s === "-.") return null;
    // Trailing decimal = still typing ("0.", "1.")
    if (/^-?\d+\.$/.test(s)) return null;
    // Bare 0 is the start of "0.x"
    if (/^-?0$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    // Below minimum while typing fractions like "0.05" — wait until blur/change to clamp.
    if (n < MIN_MEGAPIXELS) return null;
    return Math.min(MAX_MEGAPIXELS, n);
}

/** Map legacy English labels → current Chinese labels. */
const ASPECT_RATIO_ALIASES = {
    "1:1 (Square)": "1:1 (方形)",
    "2:3 (Portrait Photo)": "2:3 (竖版照片)",
    "3:2 (Photo)": "3:2 (横版照片)",
    "3:4 (Portrait Standard)": "3:4 (竖版标准)",
    "4:3 (Standard)": "4:3 (标准)",
    "9:16 (Portrait Widescreen)": "9:16 (竖屏)",
    "16:9 (Widescreen)": "16:9 (宽屏)",
    "21:9 (Ultrawide)": "21:9 (超宽)",
    "自定义 (Custom)": CUSTOM_ASPECT_RATIO,
    Custom: CUSTOM_ASPECT_RATIO,
};

export function normalizeAspectRatioLabel(aspectRatio) {
    const v = String(aspectRatio || "").trim();
    if (!v) return DEFAULT_ASPECT_RATIO;
    if (ASPECT_RATIO_ALIASES[v]) return ASPECT_RATIO_ALIASES[v];
    if (RESOLUTION_ASPECTS.some(([label]) => label === v)) return v;
    if (isCustomAspectRatio(v)) return CUSTOM_ASPECT_RATIO;
    // Fallback: match by ratio prefix e.g. "16:9"
    const prefix = v.split(" ")[0];
    const byPrefix = RESOLUTION_ASPECTS.find(([label]) => label.startsWith(`${prefix} `) || label === prefix);
    return byPrefix ? byPrefix[0] : DEFAULT_ASPECT_RATIO;
}

export function isCustomAspectRatio(aspectRatio) {
    const v = String(aspectRatio || "").trim();
    return v === CUSTOM_ASPECT_RATIO || v === "Custom" || v === "自定义 (Custom)" || v.startsWith("自定义");
}

/**
 * Official MiniMax frame formula from workflow templates:
 * max(5, round(a * 24)) + (5 - (max(5, round(a * 24)) % 17)) % 17
 * where a = duration seconds.
 */
export function durationToMiniMaxFrames(seconds, fps = 24) {
    const a = Math.max(0.1, Number(seconds) || 0.1);
    const n = Math.max(5, Math.round(a * fps));
    const rem = ((5 - (n % 17)) % 17 + 17) % 17;
    return n + rem;
}

/** MiniMax H3 frame grid: snap up to 17k+5 (min 5). */
export function alignMiniMaxFrameCount(n) {
    n = Math.max(5, parseInt(n, 10) || 5);
    while (n % 17 !== 5) n += 1;
    return n;
}

/** Raw inverse: frames → seconds (may look ugly, e.g. 124 → 5.17). Prefer preferredDurationSecFromFrames for UI. */
export function framesToDurationSec(frames, fps = 24) {
    const f = Math.max(5, parseInt(frames, 10) || 5);
    return Math.round((f / fps) * 100) / 100;
}

/**
 * Migrate/display helper: pick a user-friendly seconds value that snaps to the same
 * MiniMax frame count via durationToMiniMaxFrames (prefer whole seconds, then 1 decimal).
 * Example: 124 frames → 5 (not 5.17).
 */
export function preferredDurationSecFromFrames(frames, fps = 24) {
    const f = Math.max(5, parseInt(frames, 10) || 5);
    const rough = f / Math.max(fps, 0.001);
    const intLo = Math.max(1, Math.floor(rough) - 1);
    const intHi = Math.ceil(rough) + 1;
    for (let s = intLo; s <= intHi; s++) {
        if (durationToMiniMaxFrames(s, fps) === f) return s;
    }
    const dLo = Math.max(1, Math.floor(rough * 10) - 2);
    const dHi = Math.ceil(rough * 10) + 2;
    for (let t = dLo; t <= dHi; t++) {
        const s = t / 10;
        if (durationToMiniMaxFrames(s, fps) === f) return Math.round(s * 10) / 10;
    }
    return Math.round(rough * 100) / 100;
}

/** Snap width/height to MiniMax canvas multiple (default 32). */
export function snapResolutionDim(v, multiple = MINIMAX_CANVAS_MULTIPLE) {
    const mult = Math.max(8, parseInt(multiple, 10) || MINIMAX_CANVAS_MULTIPLE);
    const n = Math.max(mult, Math.round(Number(v) || mult));
    return Math.round(n / mult) * mult;
}

/** ResolutionSelector math: aspect_ratio + megapixels + multiple → width/height. */
export function resolutionFromSelector(aspectRatio, megapixels, multiple = MINIMAX_CANVAS_MULTIPLE) {
    if (isCustomAspectRatio(aspectRatio)) {
        return null;
    }
    const label = normalizeAspectRatioLabel(aspectRatio);
    const row = RESOLUTION_ASPECTS.find(([l]) => l === label) || RESOLUTION_ASPECTS.find(([l]) => l === DEFAULT_ASPECT_RATIO);
    const [, wRatio, hRatio] = row;
    const mp = clampMegapixels(megapixels);
    const mult = Math.max(8, parseInt(multiple, 10) || MINIMAX_CANVAS_MULTIPLE);
    const totalPixels = mp * 1024 * 1024;
    const scale = Math.sqrt(totalPixels / (wRatio * hRatio));
    const width = Math.round((wRatio * scale) / mult) * mult;
    const height = Math.round((hRatio * scale) / mult) * mult;
    return { width, height, megapixels: mp, aspectRatio: row[0], multiple: mult };
}

export const IMAGE_BATCH_TASKS = new Set();
export const FL2V_TASKS = new Set(["fl2v", "fl_chain"]);
/** Tasks that support「链式连贯」toggle (prev last-frame → next first-frame / Picture 1). */
export const CHAIN_CONTINUITY_TASKS = new Set(["fl2v", "fl_chain", "i2v", "r2v", "t2v"]);
/** Blank-canvas / subject-ref batch generation (not source-video editing). */
export const VIDEO_BATCH_TASKS = new Set(["t2v", "i2v", "r2v"]);
export const PROMPT_BATCH_TASKS = new Set([...VIDEO_BATCH_TASKS, ...FL2V_TASKS]);
/** Tasks that never use source-video upload toolbar. v2v/rv2v use Bernini-style video timeline. */
export const NO_VIDEO_UPLOAD_TASKS = new Set(["t2v", "i2v", "r2v"]);

export function resolveTaskKey(taskTypeValue) {
    let value = String(taskTypeValue || "").split(",[object Object]", 1)[0].trim();
    if (value.includes(" · ")) value = value.split(" · ", 1)[0].trim();
    for (const sep of [" — ", " —— ", " - ", " – "]) {
        if (value.includes(sep)) return value.split(sep, 1)[0].trim();
    }
    return value || "t2v";
}

export function isGenTaskType(taskTypeValue) {
    const key = resolveTaskKey(taskTypeValue);
    return PROMPT_BATCH_TASKS.has(key);
}

export function isVideoBatchTask(taskKey) {
    return VIDEO_BATCH_TASKS.has(taskKey);
}

export function isImageBatchTask(taskKey) {
    return IMAGE_BATCH_TASKS.has(taskKey);
}

export function isPromptBatchTask(taskKey) {
    return PROMPT_BATCH_TASKS.has(taskKey);
}

export function getDirectorMode(taskTypeValue) {
    const key = resolveTaskKey(taskTypeValue);
    if (FL2V_TASKS.has(key)) return "fl2v";
    if (PROMPT_BATCH_TASKS.has(key)) return "prompt_batch";
    // v2v / rv2v (and any non-batch key) → source-video timeline, same as Bernini.
    return "video";
}

/** t2i/t2v=plain, i2i=source image, i2v/r2i/r2v=up to 9 reference images (pure ref; fl2v locks frames) */
export function imageBatchVariant(taskKey) {
    if (taskKey === "i2i") return "source";
    if (taskKey === "i2v" || taskKey === "r2i" || taskKey === "r2v") return "refs";
    return "plain";
}

/** t2i/r2i/t2v/r2v/i2v need fixed canvas; i2i may use long_edge. */
export function imageBatchRequiresFixedOutput(taskKey) {
    return taskKey === "t2i" || taskKey === "r2i" || taskKey === "t2v" || taskKey === "r2v" || taskKey === "i2v";
}

/** Maximum frames per diffusion segment (model / VRAM practical limit). */
export const MAX_GEN_FRAMES = 512;

/** MiniMax H3 ReferenceToVideo supports up to 9 reference images. */
export const MAX_REFERENCE_IMAGES = 9;

export function taskSupportsChainContinuity(taskKey) {
    return CHAIN_CONTINUITY_TASKS.has(resolveTaskKey(taskKey));
}

/** When chain continuity is on, Picture 1 is reserved → user may fill 8 slots (图片2–9). */
export function maxUserReferenceImages(continuityEnabled) {
    return continuityEnabled ? Math.max(1, MAX_REFERENCE_IMAGES - 1) : MAX_REFERENCE_IMAGES;
}

/** First storage index available for user refs (1 when continuity reserves slot 0). */
export function userRefStartIndex(continuityEnabled) {
    return continuityEnabled ? 1 : 0;
}

/** User-facing slot label: index 0 → 图片1. */
export function refImageLabel(index) {
    return `图片${Number(index) + 1}`;
}

/** Prompt token for MiniMax: index 0 → <Picture 1>. */
export function refImagePromptTag(index) {
    return `<Picture ${Number(index) + 1}>`;
}

/** Official MiniMaxH3ReferenceToVideo supports up to 3 standalone reference audios. */
export const MAX_REFERENCE_AUDIOS = 3;

/** User-facing slot label: index 0 → 音频1. */
export function refAudioLabel(index) {
    return `音频${Number(index) + 1}`;
}

/** Prompt token for MiniMax: index 0 → <Audio 1>. */
export function refAudioPromptTag(index) {
    return `<Audio ${Number(index) + 1}>`;
}

/** Official MiniMaxH3ReferenceToVideo supports up to 3 reference videos. */
export const MAX_REFERENCE_VIDEOS = 3;

/** User-facing slot label: index 0 → 视频1. */
export function refVideoLabel(index) {
    return `视频${Number(index) + 1}`;
}

/** Prompt token for MiniMax: index 0 → <Video 1>. */
export function refVideoPromptTag(index) {
    return `<Video ${Number(index) + 1}>`;
}

/** Tasks that never show reference-image slots (v2v = source-video edit only). */
const NO_REF_IMAGE_TASKS = new Set(["v2v", "mv2v", "ads2v", "t2v", "fl2v", "fl_chain"]);

export function taskUsesReferenceImages(taskKey) {
    if (NO_REF_IMAGE_TASKS.has(taskKey)) return false;
    // i2v/r2v batch + legacy Bernini-style ref edit keys.
    return taskKey === "i2v" || taskKey === "r2v" || taskKey === "r2i" || taskKey === "rv2v" || taskKey === "vrc2v" || taskKey === "vi2v";
}

/**
 * Whether the Studio「参考图导演」tab should be visible.
 * Pure text (t2v/t2i) hides it; source-image / ref-image / fl2v show it.
 */
export function taskUsesImageDirector(taskKey) {
    const key = resolveTaskKey(taskKey);
    if (key === "t2v" || key === "t2i") return false;
    if (key === "i2v" || key === "i2i") return true;
    if (FL2V_TASKS.has(key)) return true;
    return taskUsesReferenceImages(key);
}

/**
 * Map Director task_type → local prompt-director MODE (T2VA/I2VA/FL2VA/L2VA).
 * Used so 提示词导演 follows the active generation mode, not always 文生视频.
 */
export function directorModeFromTaskKey(taskKey) {
    const key = resolveTaskKey(taskKey);
    if (key === "fl2v" || key === "fl_chain") return "FL2VA";
    if (key === "i2v" || key === "i2i") return "I2VA";
    if (key === "r2v" || key === "r2i" || key === "rv2v" || key === "vi2v" || key === "vrc2v"
        || key === "v2v" || key === "ads2v" || key === "mv2v") {
        return "REF2VA";
    }
    // t2v / t2i / default
    return "T2VA";
}

/** Prompt-group batch tasks where 1 segment card = 1 director shot. */
export function taskUsesPromptGroups(taskKey) {
    const key = resolveTaskKey(taskKey);
    return (
        key === "t2v" || key === "i2v" || key === "r2v"
        || key === "t2i" || key === "i2i" || key === "r2i"
        || key === "fl2v" || key === "fl_chain"
    );
}

export function taskUsesReferenceVideo(taskKey) {
    // Separate ref-video slot (ads2v). v2v uses the main source timeline instead.
    return taskKey === "ads2v";
}

/** Standalone <Audio j> slots — official r2v / Director rv2v. */
export function taskUsesReferenceAudios(taskKey) {
    return taskKey === "rv2v" || taskKey === "r2v";
}

/** Default duration seconds for video batch / fl2v (→ 124 frames @ 24fps). */
export function defaultDurationSec(taskKey) {
    if (isImageBatchTask(taskKey)) return 0;
    if (isVideoBatchTask(taskKey) || FL2V_TASKS.has(taskKey)) return 5;
    return 5;
}

export function defaultFrameCount(taskKey) {
    if (isImageBatchTask(taskKey)) return 1;
    return durationToMiniMaxFrames(defaultDurationSec(taskKey), 24);
}

export function minFrameCount(taskKey) {
    if (isImageBatchTask(taskKey)) return 1;
    if (isVideoBatchTask(taskKey) || FL2V_TASKS.has(taskKey)) return 5;
    return 5;
}

export function minDurationSec() {
    return framesToDurationSec(5, 24);
}

export function maxDurationSec() {
    return framesToDurationSec(MAX_GEN_FRAMES, 24);
}

export function sumFrameCounts(segments) {
    return (segments || []).reduce(
        (s, seg) => s + Math.max(0, parseInt(seg.frameCount ?? seg.length, 10) || 0),
        0,
    );
}

export function genLayoutHint(taskKey) {
    return "";
}

export function newBatchSegment(overrides = {}) {
    const taskKey = resolveTaskKey(overrides.taskType || overrides.task_type || "");
    const isVideo = isVideoBatchTask(taskKey);
    // durationSec is the user-facing source of truth; frameCount is derived by formula.
    let durationSec = defaultDurationSec(taskKey);
    if (overrides.durationSec != null && Number.isFinite(Number(overrides.durationSec))) {
        durationSec = Number(overrides.durationSec);
    } else if (overrides.frameCount != null || overrides.length != null) {
        durationSec = preferredDurationSecFromFrames(overrides.frameCount ?? overrides.length, 24);
    }
    durationSec = Math.round(durationSec * 100) / 100;
    const fc = isVideo ? durationToMiniMaxFrames(durationSec, 24) : 1;
    return {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        start: 0,
        length: fc,
        frameCount: fc,
        durationSec: isVideo ? durationSec : undefined,
        prompt: "",
        negativePrompt: "",
        taskType: "",
        refs: [],
        refAudios: [],
        refVideos: [],
        genImage: { imageFile: "" },
        previewB64: "",
        previewFrames: [],
        previewFps: 24,
        ...overrides,
        length: fc,
        frameCount: fc,
        ...(isVideo ? { durationSec } : {}),
    };
}
