/**
 * First/last-frame (fl2v) shot groups for the H3 desk workbench.
 * Each shot = { startImage (required to run), endImage (optional → i2v), durationSec }.
 * Total duration = sum of shot durations. Timeline shows one block per shot.
 */

import { api } from "../../scripts/api.js";
import {
    defaultDurationSec,
    defaultFrameCount,
    durationToMiniMaxFrames,
    FL2V_TASKS,
    MAX_GEN_FRAMES,
    minDurationSec,
    minFrameCount,
    preferredDurationSecFromFrames,
    resolveTaskKey,
    confirmHighShotOrDuration,
    DURATION_SEC_WARN_THRESHOLD,
} from "./minimax_gen_timeline.js";

/** Floor-only duration (no hard upper cap). */
function floorDurationSec(sec, fallback = defaultDurationSec("fl2v")) {
    const n = Number(sec);
    return Math.max(minDurationSec(), Number.isFinite(n) && n > 0 ? n : fallback);
}

export const FL2V_STYLES = `
.h3d-fl2v-detail-wrap{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:8px;min-height:0}
.h3d-fl2v-detail-wrap.hidden{display:none!important}
.h3d-fl2v-hint{color:var(--h3d-muted);font-size:11px;line-height:1.45;background:var(--h3d-surface);border:1px solid var(--h3d-border);border-radius:var(--h3d-radius-panel);padding:8px 10px;flex-shrink:0}
.h3d-fl2v-hint b{color:var(--h3d-accent);font-weight:600}
.h3d-fl2v-actions{
  display:flex;flex-wrap:wrap;gap:8px;align-items:center;
  padding:8px 10px;border:1px solid var(--h3d-border);background:rgba(0,0,0,.18);flex-shrink:0;
}
.h3d-fl2v-actions .h3d-meta{margin-left:auto;font-size:11px;color:var(--h3d-muted)}
.h3d-fl2v-shots{
  display:flex;flex-direction:column;flex-wrap:nowrap;gap:10px;align-items:stretch;
  max-height:min(52vh,560px);overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;
  padding-right:2px;scrollbar-gutter:stable;min-height:0;
}
.h3d-fl2v-shots::-webkit-scrollbar{width:8px}
.h3d-fl2v-shots::-webkit-scrollbar-thumb{background:#3a4458;border-radius:4px}
.h3d-fl2v-shots::-webkit-scrollbar-track{background:#161a22}
.h3d-fl2v-shot{
  width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;
  background:var(--h3d-bg);border:1px solid var(--h3d-border);border-left:3px solid var(--h3d-accent);
  border-radius:0;padding:12px 14px;cursor:default;transition:border-color .15s,opacity .15s;
}
.h3d-fl2v-shot:hover{border-color:#555}
.h3d-fl2v-shot.selected{border-color:var(--h3d-accent);background:rgba(212,146,58,.06);box-shadow:0 0 0 1px rgba(212,146,58,.28)}
.h3d-fl2v-shot.shot-dragging{opacity:.4}
.h3d-fl2v-shot.shot-drag-over{border-color:#5ec8ff;box-shadow:0 0 0 1px rgba(94,200,255,.45)}
.h3d-fl2v-shot-head{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:grab;user-select:none}
.h3d-fl2v-shot-head:active{cursor:grabbing}
.h3d-fl2v-shot-head b{color:#e8ecf4;font-size:13px;letter-spacing:.02em}
.h3d-fl2v-shot-meta{color:#93a1b5;font-size:11px}
.h3d-fl2v-shot-body{
  display:grid;grid-template-columns:minmax(0,1fr) minmax(132px,168px);
  gap:12px 14px;align-items:stretch;min-width:0;
}
.h3d-fl2v-slots{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-width:0}
.h3d-fl2v-slot-wrap{position:relative;min-width:0;display:flex;flex-direction:column;gap:6px}
.h3d-fl2v-slot-cap{display:flex;align-items:center;justify-content:space-between;gap:6px;min-height:18px}
.h3d-fl2v-slot-cap .tag{padding:2px 7px;border-radius:0;font-size:10px;font-weight:700;letter-spacing:.04em;line-height:1.3}
.h3d-fl2v-slot-cap .tag.start{background:rgba(212,146,58,.95);color:#1a140c}
.h3d-fl2v-slot-cap .tag.end{background:rgba(94,177,168,.92);color:#0c1413}
.h3d-fl2v-slot-cap em{font-style:normal;font-size:10px;color:#93a1b5}
.h3d-fl2v-slot{
  position:relative;aspect-ratio:var(--fl2v-slot-ar,16/9);min-height:110px;max-height:168px;
  border:1px dashed #555;border-radius:0;background:#0a0a0e;overflow:hidden;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
}
.h3d-fl2v-slot.has-img{border-style:solid;border-color:#555;cursor:grab}
.h3d-fl2v-slot.has-img:active{cursor:grabbing}
.h3d-fl2v-slot.drag-over{border-color:var(--h3d-accent);border-style:solid;background:#152018}
.h3d-fl2v-slot.dragging{opacity:.45}
.h3d-fl2v-slot img{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.h3d-fl2v-slot .ph{color:#7a8494;font-size:12px;text-align:center;padding:8px;line-height:1.4;pointer-events:none}
.h3d-fl2v-slot-wrap .x{
  position:absolute;right:6px;top:28px;width:26px;height:26px;padding:0;margin:0;border:0;box-sizing:border-box;
  display:none;align-items:center;justify-content:center;border-radius:0;background:rgba(0,0,0,.78);
  color:#ff8a8a;font-size:18px;font-weight:700;line-height:1;cursor:pointer;z-index:6;user-select:none;
  font-family:inherit;appearance:none;-webkit-appearance:none;
}
.h3d-fl2v-slot-wrap.has-img:hover .x,
.h3d-fl2v-slot-wrap:focus-within .x{display:flex}
@media (hover:none){.h3d-fl2v-slot-wrap.has-img .x{display:flex}}
.h3d-fl2v-slot-wrap .x:hover{background:rgba(160,30,30,.95);color:#fff}
.h3d-fl2v-shot-side{
  display:flex;flex-direction:column;gap:10px;justify-content:center;
  padding:12px;border:1px solid var(--h3d-border);background:rgba(0,0,0,.2);min-width:0;
}
.h3d-fl2v-shot-side .h3d-fl2v-shot-row{display:flex;flex-direction:column;align-items:stretch;gap:6px;color:#ddd;font-size:11px;margin:0}
.h3d-fl2v-shot-side .h3d-fl2v-shot-row span{color:#93a1b5;font-size:10px;letter-spacing:.06em}
.h3d-fl2v-shot-side .h3d-fl2v-shot-row .h3d-fl2v-dur{
  display:flex;align-items:center;gap:6px;
}
.h3d-fl2v-shot-side input{width:72px;text-align:center}
.h3d-fl2v-shot-side .h3d-fl2v-fc{font-size:11px;color:#93a1b5}
@media(max-width:720px){
  .h3d-fl2v-shot-body{grid-template-columns:1fr}
  .h3d-fl2v-slot{min-height:96px;max-height:140px}
}
.h3d-fl2v-detail{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px;flex-shrink:0}
.h3d-fl2v-detail.hidden{display:none!important}
.h3d-fl2v-detail .h3d-label{color:#888;font-size:10px;margin-top:2px}
.h3d-fl2v-detail textarea{width:100%;min-height:64px;background:#141414;border:1px solid #333;border-radius:4px;color:#eee;padding:6px;resize:vertical;font-size:11px;box-sizing:border-box;font-family:inherit;line-height:1.35}
.h3d-fl2v-detail textarea:disabled{opacity:.45;cursor:not-allowed}
.h3d-fl2v-total-wrap{display:inline-flex;align-items:center;gap:6px}
.h3d-fl2v-total-wrap.hidden{display:none!important}
.h3d-fl2v-total-wrap input:disabled{opacity:.75;cursor:default;color:#ccc}
`;

const DEFAULT_TOTAL = defaultFrameCount("fl2v");
/** Same default as the node ``negative_prompt_unused`` widget. */
export const DEFAULT_FL2V_NEGATIVE = "bad video";
function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

export function fl2vViewUrl(imageFile) {
    if (!imageFile) return "";
    const norm = String(imageFile).replace(/\\/g, "/");
    const slash = norm.lastIndexOf("/");
    const filename = slash >= 0 ? norm.slice(slash + 1) : norm;
    const subfolder = slash >= 0 ? norm.slice(0, slash) : "";
    const params = new URLSearchParams({ filename, type: "input" });
    if (subfolder) params.set("subfolder", subfolder);
    return api.apiURL(`/view?${params.toString()}`);
}

async function uploadImage(file) {
    const body = new FormData();
    body.append("image", file);
    body.append("type", "input");
    body.append("overwrite", "true");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp.ok) throw new Error((await resp.text()) || `Upload failed (${resp.status})`);
    return resp.json();
}

function imageDims(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            resolve({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
            URL.revokeObjectURL(url);
        };
        img.onerror = () => {
            resolve({ width: 0, height: 0 });
            URL.revokeObjectURL(url);
        };
        img.src = url;
    });
}

function fl2vFps(editor) {
    return Math.max(1, Number(editor?.getFrameRate?.() || editor?.timeline?.frameRate || 24) || 24);
}

function normalizeImageRef(raw) {
    if (!raw) return null;
    if (typeof raw === "string") {
        const imageFile = raw.trim();
        return imageFile ? { imageFile, width: 0, height: 0 } : null;
    }
    const imageFile = String(raw.imageFile || raw.image_file || "").trim();
    if (!imageFile) return null;
    return {
        imageFile,
        width: parseInt(raw.width, 10) || 0,
        height: parseInt(raw.height, 10) || 0,
    };
}

export function newFl2vShot(overrides = {}) {
    const fps = 24;
    let durationSec = overrides.durationSec != null && Number.isFinite(Number(overrides.durationSec))
        ? Number(overrides.durationSec)
        : defaultDurationSec("fl2v");
    durationSec = Math.round(floorDurationSec(durationSec) * 100) / 100;
    const flRaw = overrides.fl_gen && typeof overrides.fl_gen === "object" ? overrides.fl_gen : {};
    return {
        id: overrides.id || uid(),
        durationSec,
        prompt: overrides.prompt || "",
        negativePrompt: overrides.negativePrompt || DEFAULT_FL2V_NEGATIVE,
        startImage: normalizeImageRef(overrides.startImage || overrides.start_image) || null,
        endImage: normalizeImageRef(overrides.endImage || overrides.end_image) || null,
        fl_gen: {
            gen_start: flRaw.gen_start !== false,
            gen_end: flRaw.gen_end !== false,
            start_prompt: flRaw.start_prompt || "",
            end_prompt: flRaw.end_prompt || "",
            start_refs: Array.isArray(flRaw.start_refs) ? flRaw.start_refs : [],
            end_refs: Array.isArray(flRaw.end_refs) ? flRaw.end_refs : [],
        },
    };
}

function shotFrameCount(shot, fps = 24) {
    const sec = floorDurationSec(shot?.durationSec);
    return clamp(durationToMiniMaxFrames(sec, fps), minFrameCount("fl2v"), MAX_GEN_FRAMES);
}

/** Migrate legacy flat segments/keyframes → shots[]. */
export function migrateLegacyFl2vToShots(timeline) {
    if (Array.isArray(timeline?.shots) && timeline.shots.length) {
        return timeline.shots.map((s) => newFl2vShot(s));
    }
    const raw = [...(timeline?.keyframes || timeline?.segments || [])]
        .map((s, i) => ({ s, i }))
        .sort((a, b) => {
            const as = parseInt(a.s.start, 10) || 0;
            const bs = parseInt(b.s.start, 10) || 0;
            return as - bs || a.i - b.i;
        })
        .map(({ s }) => s);
    if (!raw.length) return [];

    const n = raw.length;
    const flags = raw.map((s, i) => {
        let isStart = s.isStartFrame;
        let isEnd = s.isEndFrame;
        if (isStart === undefined && s.breakBefore !== undefined) {
            isStart = !!s.breakBefore || s.isEndFrame === false;
            isEnd = !s.breakBefore;
        }
        if (isStart === undefined) {
            const endOnlyLast = i > 0 && i === n - 1 && !s.breakBefore && s.isEndFrame !== false;
            isStart = !endOnlyLast;
        }
        if (isEnd === undefined) isEnd = i > 0 && !s.breakBefore;
        return { isStart: !!isStart, isEnd: !!isEnd };
    });

    const shots = [];
    for (let i = 0; i < raw.length; i++) {
        const s = raw[i];
        const f = flags[i];
        if (!f.isStart) continue;
        const startImage = normalizeImageRef(s.genImage || s) || normalizeImageRef(s.imageFile);
        let endImage = null;
        if (f.isEnd && startImage) {
            endImage = { ...startImage };
        } else {
            for (let j = i + 1; j < raw.length; j++) {
                if (flags[j].isStart) break;
                if (flags[j].isEnd && !flags[j].isStart) {
                    endImage = normalizeImageRef(raw[j].genImage || raw[j])
                        || normalizeImageRef(raw[j].imageFile);
                    break;
                }
            }
        }
        let durationSec = Number(s.durationSec);
        if (!(durationSec > 0)) {
            const fc = parseInt(s.frameCount ?? s.length, 10) || defaultFrameCount("fl2v");
            // Absorb end-only span for nicer migrate.
            let totalFc = Math.max(minFrameCount("fl2v"), fc);
            if (endImage && !f.isEnd) {
                for (let j = i + 1; j < raw.length; j++) {
                    if (flags[j].isStart) break;
                    if (flags[j].isEnd && !flags[j].isStart) {
                        const e = raw[j];
                        const endT = (parseInt(e.start, 10) || 0) + (parseInt(e.length ?? e.frameCount, 10) || 0);
                        const startT = parseInt(s.start, 10) || 0;
                        totalFc = Math.max(totalFc, endT - startT);
                        break;
                    }
                }
            }
            durationSec = preferredDurationSecFromFrames(totalFc, 24);
        }
        shots.push(newFl2vShot({
            id: s.id,
            durationSec,
            prompt: s.prompt || "",
            negativePrompt: s.negativePrompt || DEFAULT_FL2V_NEGATIVE,
            startImage,
            endImage,
        }));
    }
    return shots;
}

/** Flatten shots → one timeline segment per shot (for canvas / legacy fields). */
export function flattenFl2vShotsToSegments(editor) {
    const fps = fl2vFps(editor);
    const shots = editor.timeline.shots || [];
    const prevSegs = editor.timeline.segments || [];
    let cursor = 0;
    const segs = shots.map((shot, i) => {
        const fc = shotFrameCount(shot, fps);
        const startImage = shot.startImage || null;
        const endImage = shot.endImage || null;
        const prev = prevSegs[i] || {};
        const refs = Array.isArray(prev.refs) && prev.refs.length
            ? prev.refs
            : (Array.isArray(shot.refs) ? shot.refs : []);
        const seg = {
            id: shot.id || prev.id || uid(),
            start: cursor,
            length: fc,
            frameCount: fc,
            durationSec: shot.durationSec,
            prompt: shot.prompt || "",
            negativePrompt: shot.negativePrompt || DEFAULT_FL2V_NEGATIVE,
            label: shot.label || prev.label || "",
            taskType: prev.taskType || "",
            refs,
            isStartFrame: true,
            isEndFrame: !!endImage?.imageFile,
            shotIndex: i,
            genImage: {
                imageFile: startImage?.imageFile || "",
                width: startImage?.width || 0,
                height: startImage?.height || 0,
            },
            imageFile: startImage?.imageFile || "",
            endImage: endImage
                ? {
                    imageFile: endImage.imageFile || "",
                    width: endImage.width || 0,
                    height: endImage.height || 0,
                }
                : null,
        };
        cursor += fc;
        return seg;
    });
    editor.timeline.segments = segs;
    return segs;
}

/** Compat keyframes: Start + optional End-only pair per shot. */
export function flattenFl2vShotsToKeyframes(editor) {
    const fps = fl2vFps(editor);
    const shots = editor.timeline.shots || [];
    const keyframes = [];
    let cursor = 0;
    for (const shot of shots) {
        const fc = shotFrameCount(shot, fps);
        const startImage = shot.startImage;
        const endImage = shot.endImage;
        if (endImage?.imageFile) {
            const half = Math.max(minFrameCount("fl2v"), Math.floor(fc / 2));
            const eLen = Math.max(minFrameCount("fl2v"), fc - half);
            const sLen = fc - eLen;
            keyframes.push({
                id: `${shot.id || uid()}_s`,
                imageFile: startImage?.imageFile || "",
                width: startImage?.width || 0,
                height: startImage?.height || 0,
                start: cursor,
                length: sLen,
                frameCount: sLen,
                durationSec: shot.durationSec,
                prompt: shot.prompt || "",
                negativePrompt: shot.negativePrompt || DEFAULT_FL2V_NEGATIVE,
                isStartFrame: true,
                isEndFrame: false,
            });
            keyframes.push({
                id: `${shot.id || uid()}_e`,
                imageFile: endImage.imageFile || "",
                width: endImage.width || 0,
                height: endImage.height || 0,
                start: cursor + sLen,
                length: eLen,
                frameCount: eLen,
                durationSec: shot.durationSec,
                prompt: "",
                negativePrompt: shot.negativePrompt || DEFAULT_FL2V_NEGATIVE,
                isStartFrame: false,
                isEndFrame: true,
            });
        } else {
            keyframes.push({
                id: shot.id || uid(),
                imageFile: startImage?.imageFile || "",
                width: startImage?.width || 0,
                height: startImage?.height || 0,
                start: cursor,
                length: fc,
                frameCount: fc,
                durationSec: shot.durationSec,
                prompt: shot.prompt || "",
                negativePrompt: shot.negativePrompt || DEFAULT_FL2V_NEGATIVE,
                isStartFrame: true,
                isEndFrame: false,
            });
        }
        cursor += fc;
    }
    editor.timeline.keyframes = keyframes;
    return keyframes;
}

export function recomputeFl2vTotals(editor) {
    const fps = fl2vFps(editor);
    const shots = editor.timeline.shots || [];
    let totalSec = 0;
    let totalFrames = 0;
    for (const shot of shots) {
        const sec = floorDurationSec(shot.durationSec);
        shot.durationSec = Math.round(sec * 100) / 100;
        const fc = shotFrameCount(shot, fps);
        totalSec += shot.durationSec;
        totalFrames += fc;
    }
    if (!shots.length) {
        totalSec = defaultDurationSec("fl2v");
        totalFrames = defaultFrameCount("fl2v");
    }
    totalSec = Math.round(totalSec * 100) / 100;
    totalFrames = Math.max(minFrameCount("fl2v"), totalFrames);
    editor.timeline.durationSec = totalSec;
    editor.timeline.totalFrames = totalFrames;
    if (editor.totalFramesWidget) editor.totalFramesWidget.value = totalFrames;
    if (editor.fl2vUi?.totalInput && editor.fl2vUi.totalInput !== document.activeElement) {
        editor.fl2vUi.totalInput.value = String(totalSec);
    }
    return { totalSec, totalFrames };
}

/** Sync segments/keyframes/totals from shots (source of truth). */
export function syncFl2vFromShots(editor) {
    if (!editor?.timeline) return [];
    if (!Array.isArray(editor.timeline.shots)) editor.timeline.shots = [];
    editor.timeline.shots = editor.timeline.shots.map((s) => newFl2vShot(s));
    flattenFl2vShotsToSegments(editor);
    flattenFl2vShotsToKeyframes(editor);
    recomputeFl2vTotals(editor);
    return editor.timeline.segments;
}

export function getFl2vSampleFrames(editor) {
    const content = getFl2vContentEndFrames(editor);
    const t = parseInt(editor?.timeline?.totalFrames, 10);
    // Prefer content span when it exceeds stored total (heals old 512 clamp).
    if (content > 0 && (!Number.isFinite(t) || t < content)) {
        return Math.max(minFrameCount("fl2v"), content);
    }
    if (Number.isFinite(t) && t > 0) {
        return Math.max(minFrameCount("fl2v"), t);
    }
    return DEFAULT_TOTAL;
}

export function getFl2vTotalFrames(editor) {
    return getFl2vSampleFrames(editor);
}

export function getFl2vContentEndFrames(editor) {
    const segs = editor?._previewSegments || editor?.timeline?.segments || [];
    let end = 0;
    for (const s of segs) {
        end = Math.max(end, (parseInt(s.start, 10) || 0) + (parseInt(s.length ?? s.frameCount, 10) || 0));
    }
    if (end > 0) return end;
    const shots = editor?.timeline?.shots || [];
    if (shots.length) {
        return shots.reduce((a, s) => a + shotFrameCount(s, fl2vFps(editor)), 0);
    }
    return 0;
}

/** Visual length = content total (sum of shots; may exceed per-shot MAX_GEN_FRAMES). */
export function getFl2vVisualFrames(editor) {
    return Math.max(
        minFrameCount("fl2v"),
        getFl2vSampleFrames(editor),
        getFl2vContentEndFrames(editor),
    );
}

export function getFl2vTotalDurationSec(editor) {
    const shots = editor?.timeline?.shots;
    if (Array.isArray(shots) && shots.length) {
        const sum = shots.reduce((a, s) => a + (Number(s.durationSec) || 0), 0);
        if (sum > 0) return Math.round(sum * 100) / 100;
    }
    const stored = Number(editor?.timeline?.durationSec);
    if (Number.isFinite(stored) && stored > 0) return Math.round(stored * 100) / 100;
    return preferredDurationSecFromFrames(getFl2vSampleFrames(editor), fl2vFps(editor));
}

/** @deprecated — totals come from shot sum; keep for callers. */
export function setFl2vTotalFrames(editor, value, { durationSec } = {}) {
    editor.timeline.totalFrames = Math.max(
        minFrameCount("fl2v"),
        parseInt(value, 10) || DEFAULT_TOTAL,
    );
    if (durationSec != null && Number.isFinite(Number(durationSec))) {
        editor.timeline.durationSec = Math.round(Number(durationSec) * 100) / 100;
    }
    if (editor.totalFramesWidget) editor.totalFramesWidget.value = editor.timeline.totalFrames;
    syncFl2vFromShots(editor);
    return editor.timeline.totalFrames;
}

/** @deprecated — edit per-shot duration instead. */
export function setFl2vTotalDurationSec(editor, seconds) {
    const shots = editor.timeline.shots || [];
    if (!shots.length) {
        editor.timeline.durationSec = Math.round(floorDurationSec(seconds) * 100) / 100;
        syncFl2vFromShots(editor);
        return editor.timeline.totalFrames;
    }
    // Proportionally scale all shots to match requested total.
    const target = floorDurationSec(seconds);
    const cur = getFl2vTotalDurationSec(editor) || 1;
    const scale = target / cur;
    for (const shot of shots) {
        shot.durationSec = Math.round(
            floorDurationSec((Number(shot.durationSec) || defaultDurationSec("fl2v")) * scale) * 100,
        ) / 100;
    }
    syncFl2vFromShots(editor);
    return editor.timeline.totalFrames;
}

export function ensureFl2vTimeline(editor) {
    const t = editor.timeline;
    t.timelineMode = "fl2v";
    // Keep 整局/分镜; only default to 分镜 when unset.
    if (t.editMode !== "global" && t.editMode !== "segment") t.editMode = "segment";
    t.video = t.video || {};
    t.video.videoFile = "";
    t.video.fileName = "";
    t.video.frameMap = [];
    t.videoClips = [];

    if (Array.isArray(t.shots) && t.shots.length) {
        t.shots = t.shots.map((s) => newFl2vShot(s));
    } else {
        t.shots = migrateLegacyFl2vToShots(t);
    }
    syncFl2vFromShots(editor);
    if (!Number.isFinite(editor.selectedIndex) || editor.selectedIndex < 0) {
        editor.selectedIndex = 0;
    }
    editor.selectedIndex = clamp(editor.selectedIndex, 0, Math.max(0, (t.shots.length || 1) - 1));
    return t;
}

/** Alias used by timeline — shots are source of truth. */
export function normalizeFl2vSegments(editor) {
    return syncFl2vFromShots(editor);
}

export function syncFl2vKeyframesMirror(editor) {
    flattenFl2vShotsToKeyframes(editor);
    recomputeFl2vTotals(editor);
    return editor.timeline.keyframes;
}

export function packFl2vSegments(editor) {
    return syncFl2vFromShots(editor);
}

export function fl2vStartIndices(editor) {
    // Every shot is runnable (index = shot / segment index).
    return (editor.timeline.shots || editor.timeline.segments || [])
        .map((_, i) => i);
}

export function fl2vSampleFrameCount(editor, segIndex) {
    const shots = editor.timeline.shots || [];
    const shot = shots[segIndex];
    if (!shot) return 0;
    return shotFrameCount(shot, fl2vFps(editor));
}

export function fl2vShotDurationSec(editor, segIndex) {
    const shot = editor.timeline.shots?.[segIndex];
    if (!shot) return 0;
    const stored = Number(shot.durationSec);
    if (Number.isFinite(stored) && stored > 0) return Math.round(stored * 100) / 100;
    return defaultDurationSec("fl2v");
}

export function setFl2vShotDurationSec(editor, shotIndex, seconds) {
    const shots = editor.timeline.shots || [];
    const shot = shots[shotIndex];
    if (!shot) return;
    shot.durationSec = Math.round(floorDurationSec(seconds) * 100) / 100;
    syncFl2vFromShots(editor);
}

/** @deprecated alias */
export function setFl2vStartDurationSec(editor, segIndex, seconds) {
    return setFl2vShotDurationSec(editor, segIndex, seconds);
}

/**
 * Ripple-trim right edge of shot `index` by frame end, update that shot's durationSec,
 * rebuild layout from shots.
 */
export function rippleFl2vRightEdge(segments, index, newEndFrame, minLen, editor = null) {
    // When editor is available, update shot duration from frame delta.
    if (editor?.timeline?.shots) {
        const shot = editor.timeline.shots[index];
        const seg = (segments || editor.timeline.segments || [])[index];
        if (shot && seg) {
            const fps = fl2vFps(editor);
            const newLen = Math.max(minLen, Math.round(newEndFrame) - (parseInt(seg.start, 10) || 0));
            // Prefer nice seconds that map near this frame count.
            const roughSec = newLen / fps;
            let best = Math.round(roughSec * 100) / 100;
            for (const cand of [
                Math.round(roughSec),
                Math.round(roughSec * 10) / 10,
                Math.round(roughSec * 100) / 100,
            ]) {
                if (cand < minDurationSec()) continue;
                if (Math.abs(durationToMiniMaxFrames(cand, fps) - newLen) <= Math.abs(durationToMiniMaxFrames(best, fps) - newLen)) {
                    best = cand;
                }
            }
            shot.durationSec = Math.round(floorDurationSec(best) * 100) / 100;
            // Preview: temporarily layout segments without full sync (drag path).
            const fps2 = fps;
            let cursor = 0;
            for (let i = 0; i < editor.timeline.shots.length; i++) {
                const s = editor.timeline.shots[i];
                const fc = i === index
                    ? Math.max(minFrameCount("fl2v"), durationToMiniMaxFrames(shot.durationSec, fps2))
                    : shotFrameCount(s, fps2);
                if (segments[i]) {
                    segments[i].start = cursor;
                    segments[i].length = fc;
                    segments[i].frameCount = fc;
                    segments[i].durationSec = s.durationSec;
                }
                cursor += fc;
            }
            return segments;
        }
    }
    // Fallback pure segment ripple (non-shot path).
    const segs = segments || [];
    const ordered = segs
        .map((seg, i) => ({ seg, i }))
        .sort((a, b) => a.seg.start - b.seg.start || a.i - b.i);
    const rank = ordered.findIndex((o) => o.i === index);
    if (rank < 0) return segs;
    const { seg } = ordered[rank];
    const oldEnd = seg.start + seg.length;
    const newLen = Math.max(minLen, Math.round(newEndFrame) - seg.start);
    const delta = (seg.start + newLen) - oldEnd;
    if (delta === 0) return segs;
    seg.length = newLen;
    seg.frameCount = newLen;
    for (let r = rank + 1; r < ordered.length; r++) {
        ordered[r].seg.start = Math.max(0, ordered[r].seg.start + delta);
    }
    return segs;
}

export function syncFl2vDurationSecAfterDrag(editor) {
    // After edge drag, shots already hold durationSec; just resync layout/totals.
    syncFl2vFromShots(editor);
}

export function addFl2vShot(editor, overrides = {}) {
    ensureFl2vTimeline(editor);
    const shot = newFl2vShot(overrides);
    editor.timeline.shots.push(shot);
    syncFl2vFromShots(editor);
    editor.selectedIndex = editor.timeline.shots.length - 1;
    return shot;
}

export function removeFl2vShot(editor, index) {
    const shots = editor.timeline.shots || [];
    const idx = clamp(parseInt(index, 10) || 0, 0, Math.max(0, shots.length - 1));
    if (!shots[idx]) return;
    shots.splice(idx, 1);
    syncFl2vFromShots(editor);
    editor.selectedIndex = clamp(idx, 0, Math.max(0, shots.length - 1));
    if (!shots.length) editor.selectedIndex = 0;
}

export function openFl2vUpload(editor) {
    addFl2vShot(editor);
    updateFl2vDetailUI(editor);
    editor.commit?.(false, { syncTimeline: true });
    editor.updateVideoNameLabel?.();
    editor.scheduleRender?.();
    editor.updateDomWidgetHeight?.();
}

export function openFl2vAddShot(editor) {
    return openFl2vUpload(editor);
}

/** @deprecated — slots handle replace */
export function openFl2vReplace() {}
/** @deprecated */
export function openFl2vInsert() {}

export function mountFl2vPanel(parent) {
    const wrap = document.createElement("div");
    wrap.className = "h3d-fl2v-detail-wrap";
    wrap.innerHTML = `
        <div class="h3d-fl2v-hint">
            <div class="h3d-section-title"><b>镜头清单</b><span>纵向列表 · 左图右参</span></div>
            ① 下方<strong>添加一组</strong>新建一镜（首帧必传，尾帧可选）；
            ② 拖时间轴改时长，总时长=各组之和；
            ③ 拖标题栏排序；④ 选中后编辑提示词。
        </div>
        <div class="h3d-fl2v-actions" data-r="fl2v-actions">
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="fl2v-add-shot-inner" title="添加一组首尾帧（首帧必传，尾帧可选）">添加一组</button>
            <button type="button" class="h3d-btn h3d-btn-danger" data-a="fl2v-del-shot-inner" title="删除当前选中的一组首尾帧">删除选中组</button>
            <span class="h3d-meta">在清单内管理分镜，不占用顶栏</span>
        </div>
        <div class="h3d-fl2v-shots" data-r="fl2v-shots"></div>
        <div class="h3d-fl2v-detail hidden" data-r="fl2v-detail">
            <span class="h3d-label">本镜提示词</span>
            <textarea data-r="fl2v-prompt" placeholder="描述这一镜的运动/变化（可选）"></textarea>
            <textarea data-r="fl2v-negative" class="hidden" hidden aria-hidden="true"></textarea>
        </div>
        <input type="file" accept="image/*" hidden data-r="fl2v-file">
    `;
    parent.appendChild(wrap);
    return {
        root: wrap,
        hint: wrap.querySelector(".h3d-fl2v-hint"),
        actions: wrap.querySelector('[data-r="fl2v-actions"]'),
        addBtn: wrap.querySelector('[data-a="fl2v-add-shot-inner"]'),
        delBtn: wrap.querySelector('[data-a="fl2v-del-shot-inner"]'),
        shotsEl: wrap.querySelector('[data-r="fl2v-shots"]'),
        detail: wrap.querySelector('[data-r="fl2v-detail"]'),
        prompt: wrap.querySelector('[data-r="fl2v-prompt"]'),
        negative: wrap.querySelector('[data-r="fl2v-negative"]'),
        totalInput: null,
        fileInput: wrap.querySelector('[data-r="fl2v-file"]'),
    };
}

export function stripFl2vPromptBody(text) {
    let out = String(text || "").trim();
    if (!out) return "";
    const wraps = [
        "完全保持首尾帧。",
        "完全保持首帧。",
        "视频开始完全按照image0的画面，不修改，视频结束完全保持image1的画面。",
        "视频开始完全按照image0的画面，不修改，视频结束完全保持image1。",
        "视频开始完全按照image0的构图，不修改，视频结束完全保持image1。",
        "视频开始完全按照image0的画面，不修改。",
        "视频开始完全按照image0的构图，不修改。",
        "视频结束完全保持image1的画面。",
        "视频结束完全保持image1。",
        "完全保持首尾帧：开头必须是image0，结尾必须是image1。",
        "完全保持首帧：开头必须是image0。",
        "再次强调：开头锁定image0，结尾锁定image1。",
        "再次强调：开头锁定image0。",
        "中间过程：",
    ];
    // Strip chain-continuity openings (runtime re-applies them)
    while (out.startsWith("【链式连贯】")) {
        const nl = out.indexOf("\n");
        if (nl < 0) { out = ""; break; }
        out = out.slice(nl + 1).trim();
    }
    let changed = true;
    while (changed && out) {
        changed = false;
        for (const w of wraps) {
            if (out.startsWith(w)) {
                out = out.slice(w.length).trim();
                changed = true;
            }
            if (out.endsWith(w)) {
                out = out.slice(0, -w.length).trim();
                changed = true;
            }
        }
    }
    return out
        .replace(/image0的构图/g, "image0的画面")
        .replace(/image1的构图/g, "image1的画面")
        .trim();
}

export function flushFl2vPromptDraft(editor) {
    const ui = editor?.fl2vUi;
    if (!ui?.prompt && !ui?.negative) return;
    const shots = editor.timeline?.shots || [];
    const idx = editor._fl2vPromptSegIndex;
    if (!Number.isFinite(idx) || idx < 0 || idx >= shots.length) return;
    const shot = shots[idx];
    if (!shot) return;
    if (ui.prompt) shot.prompt = ui.prompt.value || "";
    if (ui.negative) shot.negativePrompt = ui.negative.value || "";
}

/** Output canvas W/H for shot-slot aspect-ratio (matches 输出分辨率). */
export function getFl2vOutputSize(editor) {
    const out = editor?.timeline?.output || {};
    let w = parseInt(out.width, 10) || 0;
    let h = parseInt(out.height, 10) || 0;
    if (!(w > 0 && h > 0)) {
        w = parseInt(editor?.timeline?.width, 10) || parseInt(editor?.widthWidget?.value, 10) || 864;
        h = parseInt(editor?.timeline?.height, 10) || parseInt(editor?.heightWidget?.value, 10) || 480;
    }
    w = Math.max(1, w);
    h = Math.max(1, h);
    return { width: w, height: h };
}

export function applyFl2vSlotAspect(editor) {
    const ui = editor?.fl2vUi;
    if (!ui?.root) return;
    const { width, height } = getFl2vOutputSize(editor);
    ui.root.style.setProperty("--fl2v-slot-ar", `${width} / ${height}`);
}

const FL2V_SLOT_MIME = "application/x-minimax-fl2v-slot";
const FL2V_SHOT_MIME = "application/x-minimax-fl2v-shot";

/** Swap two shot groups in place (whole card: images + duration + prompts). */
export function swapFl2vShots(editor, fromIndex, toIndex) {
    const shots = editor.timeline?.shots || [];
    const a = clamp(parseInt(fromIndex, 10), 0, shots.length - 1);
    const b = clamp(parseInt(toIndex, 10), 0, shots.length - 1);
    if (!shots[a] || !shots[b] || a === b) return false;
    const tmp = shots[a];
    shots[a] = shots[b];
    shots[b] = tmp;
    syncFl2vFromShots(editor);
    editor.selectedIndex = b;
    editor.commit?.(false, { syncTimeline: true });
    updateFl2vDetailUI(editor);
    editor.updateVideoNameLabel?.();
    editor.scheduleRender?.();
    editor.updateDomWidgetHeight?.();
    return true;
}

function bindFl2vShotCardDnD(editor, cardEl, shotIndex) {
    // Only the header is draggable so slot/clear clicks are never stolen by card DnD.
    cardEl.draggable = false;
    const handle = cardEl.querySelector(".h3d-fl2v-shot-head");
    if (handle) {
        handle.draggable = true;
        handle.title = "拖动此处互换镜头位置";
        handle.style.cursor = "grab";
        handle.addEventListener("dragstart", (e) => {
            editor._fl2vShotDrag = true;
            editor._fl2vShotDragFrom = shotIndex;
            const payload = JSON.stringify({ shotIndex });
            e.dataTransfer.setData(FL2V_SHOT_MIME, payload);
            e.dataTransfer.setData("text/plain", payload);
            e.dataTransfer.effectAllowed = "move";
            try {
                e.dataTransfer.setDragImage(cardEl, 24, 16);
            } catch (_) { /* ignore */ }
            cardEl.classList.add("shot-dragging");
            e.stopPropagation();
        });
        handle.addEventListener("dragend", () => {
            cardEl.classList.remove("shot-dragging");
            editor._fl2vShotDragFrom = null;
            editor.fl2vUi?.shotsEl?.querySelectorAll(".h3d-fl2v-shot.shot-drag-over")
                .forEach((el) => el.classList.remove("shot-drag-over"));
            setTimeout(() => { editor._fl2vShotDrag = false; }, 0);
        });
    }

    cardEl.addEventListener("dragover", (e) => {
        const types = [...(e.dataTransfer?.types || [])];
        // Slot transfers take priority when hovering a slot.
        if (e.target.closest?.("[data-slot]") && types.includes(FL2V_SLOT_MIME)) return;
        if (!types.includes(FL2V_SHOT_MIME) && !types.includes("text/plain")) return;
        if (editor._fl2vSlotDrag) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        cardEl.classList.add("shot-drag-over");
    });

    cardEl.addEventListener("dragleave", (e) => {
        if (!cardEl.contains(e.relatedTarget)) {
            cardEl.classList.remove("shot-drag-over");
        }
    });

    cardEl.addEventListener("drop", (e) => {
        // Let slot drop handler win when dropping onto a slot with slot payload.
        const types = [...(e.dataTransfer?.types || [])];
        if (e.target.closest?.("[data-slot]") && types.includes(FL2V_SLOT_MIME)) return;
        if (editor._fl2vSlotDrag) return;
        e.preventDefault();
        e.stopPropagation();
        cardEl.classList.remove("shot-drag-over");
        const raw = e.dataTransfer.getData(FL2V_SHOT_MIME)
            || e.dataTransfer.getData("text/plain");
        if (!raw) return;
        try {
            const data = JSON.parse(raw);
            if (!Number.isFinite(data.shotIndex)) return;
            editor._fl2vShotDrag = true;
            swapFl2vShots(editor, data.shotIndex, shotIndex);
        } catch (_) { /* ignore */ }
    });
}

function clearFl2vShotSlot(editor, shotIndex, kind) {
    const shot = editor.timeline?.shots?.[shotIndex];
    if (!shot) return;
    // Suppress the post-clear click that can land on the rebuilt empty slot.
    editor._fl2vIgnoreSlotClickUntil = Date.now() + 500;
    if (kind === "start") shot.startImage = null;
    else shot.endImage = null;
    syncFl2vFromShots(editor);
    editor.selectedIndex = shotIndex;
    editor.commit?.(false, { syncTimeline: true });
    updateFl2vDetailUI(editor);
    editor.updateVideoNameLabel?.();
    editor.scheduleRender?.();
}

function cloneFl2vImageRef(ref) {
    if (!ref?.imageFile) return null;
    return {
        imageFile: ref.imageFile,
        width: ref.width || 0,
        height: ref.height || 0,
    };
}

function getFl2vSlotImage(shot, slot) {
    if (!shot) return null;
    return slot === "end" ? (shot.endImage || null) : (shot.startImage || null);
}

function setFl2vSlotImage(shot, slot, ref) {
    if (!shot) return;
    if (slot === "end") shot.endImage = ref;
    else shot.startImage = ref;
}

/** Same group: swap/move; cross group: copy/replace target. */
export function transferFl2vSlotImage(editor, fromShot, fromSlot, toShot, toSlot) {
    const shots = editor.timeline?.shots || [];
    const src = shots[fromShot];
    const dst = shots[toShot];
    if (!src || !dst) return false;
    if (fromShot === toShot && fromSlot === toSlot) return false;
    const srcImg = getFl2vSlotImage(src, fromSlot);
    if (!srcImg?.imageFile) return false;

    if (fromShot === toShot) {
        // 组内：互换（目标空则等于移动）
        const dstImg = getFl2vSlotImage(dst, toSlot);
        setFl2vSlotImage(src, fromSlot, cloneFl2vImageRef(dstImg));
        setFl2vSlotImage(dst, toSlot, cloneFl2vImageRef(srcImg));
    } else {
        // 组间：复制到目标（源保留）
        setFl2vSlotImage(dst, toSlot, cloneFl2vImageRef(srcImg));
    }
    syncFl2vFromShots(editor);
    editor.selectedIndex = toShot;
    editor.commit?.(false, { syncTimeline: true });
    updateFl2vDetailUI(editor);
    editor.updateVideoNameLabel?.();
    editor.scheduleRender?.();
    editor.updateDomWidgetHeight?.();
    return true;
}

function bindFl2vSlotDnD(editor, slotEl, shotIndex, slotKind) {
    const hasImg = slotEl.classList.contains("has-img");
    slotEl.draggable = hasImg;

    slotEl.addEventListener("dragstart", (e) => {
        if (!hasImg) {
            e.preventDefault();
            return;
        }
        editor._fl2vSlotDrag = true;
        editor._fl2vDragFrom = { shotIndex, slot: slotKind };
        const payload = JSON.stringify({ shotIndex, slot: slotKind });
        e.dataTransfer.setData(FL2V_SLOT_MIME, payload);
        e.dataTransfer.setData("text/plain", payload);
        // copy+move so browsers allow both dropEffects
        e.dataTransfer.effectAllowed = "copyMove";
        slotEl.classList.add("dragging");
        e.stopPropagation();
    });

    slotEl.addEventListener("dragend", () => {
        slotEl.classList.remove("dragging");
        editor._fl2vDragFrom = null;
        editor.fl2vUi?.shotsEl?.querySelectorAll(".h3d-fl2v-slot.drag-over")
            .forEach((el) => el.classList.remove("drag-over"));
        setTimeout(() => { editor._fl2vSlotDrag = false; }, 0);
    });

    slotEl.addEventListener("dragover", (e) => {
        const types = [...(e.dataTransfer?.types || [])];
        if (!types.includes(FL2V_SLOT_MIME) && !types.includes("Files") && !types.includes("text/plain")) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        const from = editor._fl2vDragFrom;
        const sameGroup = from && from.shotIndex === shotIndex;
        e.dataTransfer.dropEffect = sameGroup ? "move" : "copy";
        slotEl.classList.add("drag-over");
    });

    slotEl.addEventListener("dragleave", (e) => {
        if (!slotEl.contains(e.relatedTarget)) {
            slotEl.classList.remove("drag-over");
        }
    });

    slotEl.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        slotEl.classList.remove("drag-over");
        const raw = e.dataTransfer.getData(FL2V_SLOT_MIME)
            || e.dataTransfer.getData("text/plain");
        if (raw) {
            try {
                const data = JSON.parse(raw);
                if (Number.isFinite(data.shotIndex) && (data.slot === "start" || data.slot === "end")) {
                    editor._fl2vSlotDrag = true;
                    transferFl2vSlotImage(editor, data.shotIndex, data.slot, shotIndex, slotKind);
                    return;
                }
            } catch (_) { /* fall through */ }
        }
        const f = e.dataTransfer.files?.[0];
        if (f?.type?.startsWith("image/")) {
            editor.selectedIndex = shotIndex;
            editor._fl2vUploadMode = "slot";
            editor._fl2vSlotKind = slotKind;
            editor._fl2vSlotShotIndex = shotIndex;
            // Reuse file input path via programmatic FileList isn't portable — upload directly.
            (async () => {
                try {
                    ensureFl2vTimeline(editor);
                    const up = await uploadImage(f);
                    const dims = await imageDims(f);
                    const name = up.name || up.filename;
                    const sub = (up.subfolder || "").replace(/\\/g, "/").replace(/\/$/, "");
                    const path = sub ? `${sub}/${name}` : name;
                    const ref = { imageFile: path, width: dims.width || 0, height: dims.height || 0 };
                    const shot = editor.timeline.shots?.[shotIndex];
                    if (!shot) return;
                    setFl2vSlotImage(shot, slotKind, ref);
                    syncFl2vFromShots(editor);
                    editor.selectedIndex = shotIndex;
                    editor.commit?.(false, { syncTimeline: true });
                    updateFl2vDetailUI(editor);
                    editor.updateVideoNameLabel?.();
                    editor.scheduleRender?.();
                } catch (err) {
                    console.error("[MiniMax H3 fl2v] drop upload failed", err);
                    alert(`上传失败：${err?.message || err}`);
                }
            })();
        }
    });
}

function renderFl2vShotCards(editor) {
    const ui = editor.fl2vUi;
    if (!ui?.shotsEl) return;
    applyFl2vSlotAspect(editor);
    const shots = editor.timeline.shots || [];
    const sel = editor.selectedIndex;
    const taskKey = resolveTaskKey(editor.timeline?.global?.taskType || editor.getTaskKey?.() || "");
    const contOn = editor.timeline?.output?.continuityEnabled === true
        || editor.timeline?.output?.continuity_enabled === true;
    const isChain = taskKey === "fl_chain" || contOn;
    ui.shotsEl.innerHTML = "";
    const globalScope = (editor.timeline?.editMode || "global") === "global";
    const visibleShots = globalScope
        ? shots.slice(0, 1).map((shot, i) => ({ shot, i: 0 }))
        : shots.map((shot, i) => ({ shot, i }));
    if (ui.actions) ui.actions.classList.toggle("hidden", globalScope);
    visibleShots.forEach(({ shot, i }) => {
        const card = document.createElement("div");
        card.className = `h3d-fl2v-shot${i === sel || globalScope ? " selected" : ""}`;
        card.dataset.shotIndex = String(i);
        if (globalScope) card.classList.add("h3d-fl2v-shot-single");
        const startUrl = shot.startImage?.imageFile ? fl2vViewUrl(shot.startImage.imageFile) : "";
        const endUrl = shot.endImage?.imageFile ? fl2vViewUrl(shot.endImage.imageFile) : "";
        const fc = shotFrameCount(shot, fl2vFps(editor));
        const chainRelay = isChain && i > 0;
        const startTitle = chainRelay
            ? "首帧可选：留空即可；运行时自动用上一组生成视频的末帧作为本镜首帧"
            : "上传首帧（必传）；可拖到其它图位";
        const startHint = chainRelay ? "可选 · 接力" : "必传";
        const startPh = chainRelay ? "点击上传首帧<br>（可留空接力）" : "点击上传首帧";
        const metaLabel = shot.endImage?.imageFile || shot.endImage?.imageB64
            ? "首尾帧"
            : (chainRelay ? "链式接力" : "图生视频");
        card.innerHTML = `
            <div class="h3d-fl2v-shot-head">
                <b>${globalScope ? "整局成片" : `镜 ${i + 1}`}</b>
                <span class="h3d-fl2v-shot-meta">${metaLabel} · ${fc} 帧</span>
            </div>
            <div class="h3d-fl2v-shot-body">
              <div class="h3d-fl2v-slots">
                <div class="h3d-fl2v-slot-wrap${startUrl ? " has-img" : ""}">
                    <div class="h3d-fl2v-slot-cap"><span class="tag start">首帧</span><em>${startHint}</em></div>
                    <div class="h3d-fl2v-slot${startUrl ? " has-img" : ""}" data-slot="start" title="${startTitle}">
                        ${startUrl ? `<img src="${startUrl}" alt="">` : `<span class="ph">${startPh}</span>`}
                    </div>
                    ${startUrl ? `<button type="button" class="x" data-clear="start" title="清除" draggable="false">×</button>` : ""}
                </div>
                <div class="h3d-fl2v-slot-wrap${endUrl ? " has-img" : ""}">
                    <div class="h3d-fl2v-slot-cap"><span class="tag end">尾帧</span><em>可选</em></div>
                    <div class="h3d-fl2v-slot${endUrl ? " has-img" : ""}" data-slot="end" title="上传尾帧（可选）；可拖到其它图位">
                        ${endUrl ? `<img src="${endUrl}" alt="">` : '<span class="ph">点击上传尾帧<br>（可留空）</span>'}
                    </div>
                    ${endUrl ? `<button type="button" class="x" data-clear="end" title="清除" draggable="false">×</button>` : ""}
                </div>
              </div>
              <aside class="h3d-fl2v-shot-side">
                <label class="h3d-fl2v-shot-row" title="本镜时长（秒）">
                  <span>本镜时长</span>
                  <span class="h3d-fl2v-dur">
                    <input type="number" class="h3d-num" data-r="shot-sec" min="${minDurationSec()}" step="0.1" value="${shot.durationSec}" title="超过 ${DURATION_SEC_WARN_THRESHOLD}s 会提示确认">
                    秒
                  </span>
                </label>
                <div class="h3d-fl2v-fc">${fc} 帧 · FPS 随时间线</div>
              </aside>
            </div>
        `;
        card.addEventListener("click", (e) => {
            if (e.target.closest("[data-slot], [data-clear], input, .h3d-fl2v-slot-wrap")) return;
            if (editor._fl2vShotDrag || editor._fl2vSlotDrag) return;
            if (editor.selectedIndex !== i) flushFl2vPromptDraft(editor);
            editor.selectedIndex = i;
            updateFl2vDetailUI(editor);
            editor.scheduleRender?.();
        });
        bindFl2vShotCardDnD(editor, card, i);
        card.querySelectorAll("[data-slot]").forEach((slot) => {
            const kind = slot.dataset.slot;
            bindFl2vSlotDnD(editor, slot, i, kind);
            slot.addEventListener("click", (e) => {
                if (Date.now() < (editor._fl2vIgnoreSlotClickUntil || 0)) return;
                if (editor._fl2vSlotDrag) return;
                e.stopPropagation();
                if (editor.selectedIndex !== i) flushFl2vPromptDraft(editor);
                editor.selectedIndex = i;
                editor._fl2vUploadMode = "slot";
                editor._fl2vSlotKind = kind;
                editor._fl2vSlotShotIndex = i;
                const input = ui.fileInput;
                if (!input) return;
                input.multiple = false;
                input.click();
            });
        });
        card.querySelectorAll("[data-clear]").forEach((btn) => {
            // Clear on pointerdown: click is unreliable next to HTML5 drag sources.
            btn.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                clearFl2vShotSlot(editor, i, btn.dataset.clear);
            });
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });
        const secInput = card.querySelector('[data-r="shot-sec"]');
        secInput?.addEventListener("click", (e) => e.stopPropagation());
        secInput?.addEventListener("keydown", (e) => e.stopPropagation());
        const applySec = () => {
            let sec = parseFloat(secInput?.value);
            if (!Number.isFinite(sec)) sec = defaultDurationSec("fl2v");
            sec = floorDurationSec(sec);
            if (sec > DURATION_SEC_WARN_THRESHOLD) {
                if (!confirmHighShotOrDuration({ durationSec: sec })) {
                    const prev = Number(editor.timeline.shots?.[i]?.durationSec);
                    if (secInput) {
                        secInput.value = String(
                            Number.isFinite(prev) ? prev : defaultDurationSec("fl2v"),
                        );
                    }
                    return;
                }
            }
            setFl2vShotDurationSec(editor, i, sec);
            editor.commit?.(false, { syncTimeline: true });
            updateFl2vDetailUI(editor);
            editor.updateVideoNameLabel?.();
            editor.scheduleRender?.();
            editor.updateDomWidgetHeight?.();
        };
        secInput?.addEventListener("change", applySec);
        ui.shotsEl.appendChild(card);
    });
}

export function updateFl2vDetailUI(editor) {
    const ui = editor.fl2vUi;
    if (!ui) return;
    if (!editor.isFl2vMode?.()) {
        ui.detail?.classList.add("hidden");
        return;
    }
    const taskKey = resolveTaskKey(editor.timeline?.global?.taskType || editor.getTaskKey?.() || "");
    const contOn = editor.timeline?.output?.continuityEnabled === true
        || editor.timeline?.output?.continuity_enabled === true;
    const isChain = taskKey === "fl_chain" || contOn;
    if (ui.hint) {
        const globalScope = (editor.timeline?.editMode || "global") === "global";
        if (globalScope) {
            ui.hint.innerHTML = `<b>整局模式 · 单视频</b>：
            功能与分镜一致，但只编辑 / 生成<strong>第 1 镜成片</strong>。
            上传<strong>首帧</strong>（必传）与<strong>尾帧</strong>（可选）；改本镜时长后 Queue。
            需要多镜时切到顶栏<strong>分镜模式</strong>。`;
        } else {
            ui.hint.innerHTML = isChain
                ? `<b>链式连贯已开启</b>${taskKey === "fl_chain" ? "（fl_chain）" : ""}：
                ① 第 1 组<strong>必须上传首帧</strong>；后续组首帧可选（运行时默认用<strong>上一组生成视频的末帧</strong>接力）；
                ② 每组尾帧可选（有则锁本镜结尾）；拖缘调时长，总时长=各组之和；
                ③ 按顺序 Queue，场景过渡更连贯。勿对中间镜单独「选择运行」跳过，否则接力会断。
                ④ 可在输出栏关闭「链式连贯」恢复每组独立首帧。`
                : `<b>怎么用</b>：
                ① 点<strong>添加一组</strong>创建一镜；每组有<strong>首帧</strong>（必传）和<strong>尾帧</strong>（可选，空=图生视频）；
                ② 拖时间轴右边界改本镜时长；<strong>总时长 = 各组之和</strong>；
                ③ 需要分镜连贯时，打开输出栏<strong>链式连贯</strong>：上镜末帧→下镜首帧；
                ④ 拖镜卡片<strong>标题栏</strong>可互换组位置；选中一组后可编辑提示词。`;
        }
    }
    if (ui.totalInput && ui.totalInput !== document.activeElement) {
        ui.totalInput.value = String(getFl2vTotalDurationSec(editor));
        ui.totalInput.disabled = true;
        ui.totalInput.title = "总时长 = 各组之和（只读，请改各镜时长）";
    }
    renderFl2vShotCards(editor);
    updateFl2vToolbarBtns(editor);

    const shots = editor.timeline.shots || [];
    const idx = editor.selectedIndex;
    const shot = shots[idx];
    if (!shot) {
        flushFl2vPromptDraft(editor);
        editor._fl2vPromptSegIndex = null;
        ui.detail?.classList.add("hidden");
        return;
    }
    ui.detail?.classList.remove("hidden");
    const prevIdx = editor._fl2vPromptSegIndex;
    const selectionChanged = prevIdx !== idx;
    if (selectionChanged) flushFl2vPromptDraft(editor);
    editor._fl2vPromptSegIndex = idx;
    if (ui.prompt) {
        ui.prompt.disabled = false;
        if (selectionChanged || ui.prompt !== document.activeElement) {
            ui.prompt.value = shot.prompt || "";
        }
    }
    if (ui.negative) {
        ui.negative.disabled = false;
        if (selectionChanged || ui.negative !== document.activeElement) {
            ui.negative.value = shot.negativePrompt || DEFAULT_FL2V_NEGATIVE;
        }
    }
}

export function bindFl2vEvents(editor) {
    const ui = editor.fl2vUi;
    if (!ui) return;

    ui.addBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        openFl2vUpload(editor);
    });
    ui.delBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        editor.deleteSelectedSegment?.();
    });

    // Total is read-only (sum of shots); ignore edits.
    ui.totalInput?.addEventListener("keydown", (e) => e.stopPropagation());

    const promptTargetShot = () => {
        const shots = editor.timeline.shots || [];
        const idx = Number.isFinite(editor._fl2vPromptSegIndex)
            ? editor._fl2vPromptSegIndex
            : editor.selectedIndex;
        return shots[idx] || null;
    };
    const bindPromptField = (el, field) => {
        if (!el) return;
        el.addEventListener("change", () => {
            const shot = promptTargetShot();
            if (!shot) return;
            shot[field] = el.value || "";
            syncFl2vFromShots(editor);
            editor.commit(false, { syncTimeline: true });
            editor.scheduleRender();
        });
        el.addEventListener("input", () => {
            const shot = promptTargetShot();
            if (!shot) return;
            shot[field] = el.value || "";
            editor.scheduleRender();
        });
        el.addEventListener("focus", () => {
            if (!Number.isFinite(editor._fl2vPromptSegIndex)) {
                editor._fl2vPromptSegIndex = editor.selectedIndex;
            }
        });
    };
    bindPromptField(ui.prompt, "prompt");
    bindPromptField(ui.negative, "negativePrompt");

    ui.fileInput?.addEventListener("change", async () => {
        const files = [...(ui.fileInput.files || [])];
        const mode = editor._fl2vUploadMode || "slot";
        const slotKind = editor._fl2vSlotKind || "start";
        const shotIndex = editor._fl2vSlotShotIndex ?? editor.selectedIndex;
        editor._fl2vUploadMode = "slot";
        editor._fl2vSlotKind = null;
        editor._fl2vSlotShotIndex = null;
        if (ui.fileInput) ui.fileInput.multiple = false;
        if (!files.length) return;
        ensureFl2vTimeline(editor);
        try {
            const file = files[0];
            const up = await uploadImage(file);
            const dims = await imageDims(file);
            const name = up.name || up.filename;
            const sub = (up.subfolder || "").replace(/\\/g, "/").replace(/\/$/, "");
            const path = sub ? `${sub}/${name}` : name;
            const ref = { imageFile: path, width: dims.width || 0, height: dims.height || 0 };
            let shots = editor.timeline.shots || [];
            if (mode === "slot") {
                let shot = shots[shotIndex];
                if (!shot) {
                    addFl2vShot(editor);
                    shots = editor.timeline.shots;
                    editor.selectedIndex = shots.length - 1;
                    shot = shots[editor.selectedIndex];
                }
                if (slotKind === "end") shot.endImage = ref;
                else shot.startImage = ref;
                editor.selectedIndex = shotIndex < shots.length ? shotIndex : shots.length - 1;
            } else {
                addFl2vShot(editor, { startImage: ref });
            }
            syncFl2vFromShots(editor);
            editor.commit(false, { syncTimeline: true });
            updateFl2vDetailUI(editor);
            editor.updateVideoNameLabel?.();
            editor.scheduleRender();
            editor.updateDomWidgetHeight?.();
        } catch (err) {
            console.error("[MiniMax H3 fl2v] upload failed", err);
            alert(`上传失败：${err?.message || err}`);
        } finally {
            ui.fileInput.value = "";
        }
    });
}

/**
 * Draw shot block: start image full width; with end → left/right halves 50/50.
 */
export function drawFl2vSegmentThumbnails(editor, ctx, seg, startX, pxWidth, y0, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(startX, y0 + 1, pxWidth, h - 2);
    ctx.clip();
    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(startX, y0 + 1, pxWidth, h - 2);

    const imageFile = seg.genImage?.imageFile || seg.imageFile || "";
    if (!imageFile) {
        ctx.fillStyle = "#666";
        ctx.font = "12px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("未上传首帧", startX + pxWidth / 2, y0 + h / 2);
        ctx.restore();
        return;
    }

    const drawImg = (img, x, w, y, hh) => {
        if (!img?.naturalWidth || w <= 0.5) return;
        const natW = img.naturalWidth;
        const natH = Math.max(1, img.naturalHeight);
        const aspect = natW / natH;
        const tileH = Math.max(1, hh);
        const tileW = tileH * aspect;
        const endX = x + w;
        for (let px = x; px < endX - 0.5; px += tileW) {
            const remain = endX - px;
            if (remain >= tileW - 0.5) {
                ctx.drawImage(img, 0, 0, natW, natH, px, y, tileW, tileH);
            } else {
                const srcW = Math.max(1, (remain / tileW) * natW);
                ctx.drawImage(img, 0, 0, srcW, natH, px, y, remain, tileH);
            }
        }
    };

    const ensureThumb = (file) => {
        const key = `fl2v:${file}`;
        let cached = editor._thumbCache.get(key);
        if (cached?.naturalWidth) return cached;
        if (!editor._thumbPending.has(key)) {
            editor._thumbPending.add(key);
            const el = new Image();
            el.crossOrigin = "anonymous";
            el.onload = () => {
                editor._thumbCache.set(key, el);
                editor._thumbPending.delete(key);
                editor.scheduleRender();
            };
            el.onerror = () => editor._thumbPending.delete(key);
            el.src = fl2vViewUrl(file);
        }
        return null;
    };

    const img = ensureThumb(imageFile);
    if (!img) {
        ctx.restore();
        return;
    }

    const endFile = seg.endImage?.imageFile || "";
    const trackH = Math.max(1, h - 2);
    const drawY = y0 + 1;
    // 首尾帧：占位左右各一半
    const split = !!endFile && pxWidth > 24;
    const halfW = split ? pxWidth / 2 : pxWidth;
    const mainW = halfW;
    const endW = split ? pxWidth - halfW : 0;
    drawImg(img, startX, mainW, drawY, trackH);

    if (split) {
        const endImg = ensureThumb(endFile);
        const ex = startX + mainW;
        if (endImg) {
            drawImg(endImg, ex, endW, drawY, trackH);
        }
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ex + 0.5, drawY);
        ctx.lineTo(ex + 0.5, drawY + trackH);
        ctx.stroke();
    }

    const badgeY = y0 + 6;
    ctx.font = "bold 9px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(212,146,58,0.92)";
    ctx.fillRect(startX + 4, badgeY, 38, 14);
    ctx.fillStyle = "#111";
    ctx.fillText("START", startX + 8, badgeY + 7);
    if (endFile) {
        const endBadgeX = startX + mainW + 4;
        ctx.fillStyle = "rgba(240,160,48,0.92)";
        ctx.fillRect(endBadgeX, badgeY, 30, 14);
        ctx.fillStyle = "#111";
        ctx.fillText("END", endBadgeX + 5, badgeY + 7);
    }

    ctx.restore();
}

export function getFl2vUiHeight(editor) {
    const n = editor.timeline?.shots?.length || 0;
    const rows = Math.max(1, Math.ceil(n / 3));
    return 420 + rows * 150 + 80;
}

export function buildFl2vPayloadFields(editor) {
    ensureFl2vTimeline(editor);
    syncFl2vFromShots(editor);
    const total = getFl2vSampleFrames(editor);
    const shots = (editor.timeline.shots || []).map((s) => {
        const fg = s?.fl_gen && typeof s.fl_gen === "object" ? s.fl_gen : {};
        return {
            id: s.id,
            durationSec: s.durationSec,
            prompt: s.prompt || "",
            negativePrompt: s.negativePrompt || DEFAULT_FL2V_NEGATIVE,
            label: s.label || "",
            startImage: s.startImage
                ? {
                    imageFile: s.startImage.imageFile || "",
                    width: s.startImage.width || 0,
                    height: s.startImage.height || 0,
                }
                : null,
            endImage: s.endImage
                ? {
                    imageFile: s.endImage.imageFile || "",
                    width: s.endImage.width || 0,
                    height: s.endImage.height || 0,
                }
                : null,
            // Keep first/last director plan (prompts, refs, gen toggles) across Queue
            fl_gen: {
                gen_start: fg.gen_start !== false,
                gen_end: fg.gen_end !== false,
                start_prompt: fg.start_prompt || "",
                end_prompt: fg.end_prompt || "",
                start_refs: Array.isArray(fg.start_refs) ? fg.start_refs : [],
                end_refs: Array.isArray(fg.end_refs) ? fg.end_refs : [],
            },
        };
    });
    return {
        timelineMode: "fl2v",
        editMode: editor.timeline?.editMode === "global" ? "global" : "segment",
        shots,
        keyframes: editor.timeline.keyframes || [],
        segments: (editor.timeline.segments || []).map((s) => ({
            id: s.id,
            start: s.start,
            length: s.length,
            frameCount: s.length,
            durationSec: s.durationSec,
            prompt: s.prompt || "",
            negativePrompt: s.negativePrompt || DEFAULT_FL2V_NEGATIVE,
            label: s.label || "",
            isStartFrame: true,
            isEndFrame: !!s.endImage?.imageFile,
            genImage: {
                imageFile: s.genImage?.imageFile || s.imageFile || "",
                width: s.genImage?.width || 0,
                height: s.genImage?.height || 0,
            },
            imageFile: s.genImage?.imageFile || s.imageFile || "",
            endImage: s.endImage || null,
            taskType: s.taskType || "",
            refs: Array.isArray(s.refs) ? s.refs : [],
        })),
        totalFrames: total,
        durationSec: getFl2vTotalDurationSec(editor),
    };
}

export function isFl2vTaskValue(taskTypeValue) {
    return FL2V_TASKS.has(resolveTaskKey(taskTypeValue));
}

export function setFl2vToolbar(editor, enabled) {
    const disable = [
        editor.btnVideoAppend,
        editor.root?.querySelector('[data-a="split"]'),
        editor.root?.querySelector('[data-a="smart-split"]'),
        editor.root?.querySelector('[data-a="equal"]'),
        // Keep 整局/分镜 switch available for fl2v single-vs-multi shot workflows.
    ];
    for (const btn of disable) {
        if (!btn) continue;
        btn.disabled = enabled;
        btn.classList.toggle("h3d-disabled", enabled);
        btn.classList.toggle("hidden", enabled);
    }
    if (editor.equalCountInput) {
        editor.equalCountInput.disabled = enabled;
        editor.equalCountInput.classList.toggle("hidden", enabled);
    }
    // fl2v: hide outer material/edit shot controls — add/delete live inside 镜头清单.
    if (editor.btnVideo) {
        editor.btnVideo.classList.toggle("hidden", enabled);
        editor.btnVideo.disabled = enabled;
    }
    const outerDel = editor.root?.querySelector('.h3d-toolbar-wrap [data-a="del"]')
        || editor.root?.querySelector('[data-a="del"]');
    if (outerDel) {
        if (enabled) {
            outerDel.classList.add("hidden");
            outerDel.disabled = true;
            outerDel.classList.add("h3d-disabled");
        } else {
            outerDel.classList.remove("hidden", "h3d-disabled");
            outerDel.disabled = false;
            outerDel.textContent = "删除片段";
            outerDel.title = "删除选中片段并裁剪视频，时间轴自动衔接";
        }
    }
    for (const sel of ['[data-a="fl2v-insert-before"]', '[data-a="fl2v-insert-after"]', '[data-a="fl2v-replace"]']) {
        const btn = editor.root?.querySelector(sel);
        if (btn) {
            btn.classList.add("hidden");
            btn.disabled = true;
        }
    }
    // Keep legacy outer add hidden; inner panel owns add/delete.
    const outerAdd = editor.root?.querySelector('.h3d-toolbar-wrap [data-a="fl2v-add-shot"]')
        || editor.root?.querySelector('[data-a="fl2v-add-shot"]');
    if (outerAdd) {
        outerAdd.classList.add("hidden");
        outerAdd.disabled = true;
    }
    updateFl2vToolbarBtns(editor);
}

function _toolGroupHasVisibleControls(group) {
    if (!group) return false;
    return !!group.querySelector("button:not(.hidden), input:not(.hidden), select:not(.hidden), label:not(.hidden)");
}

export function updateFl2vToolbarBtns(editor) {
    const outerAdd = editor?.root?.querySelector?.('.h3d-toolbar-wrap [data-a="fl2v-add-shot"]')
        || editor?.root?.querySelector?.('[data-a="fl2v-add-shot"]');
    if (outerAdd) {
        outerAdd.classList.add("hidden");
        outerAdd.disabled = true;
    }
    const ui = editor?.fl2vUi;
    const show = !!editor?.isFl2vMode?.();
    ui?.actions?.classList.toggle("hidden", !show);
    if (ui?.addBtn) {
        ui.addBtn.disabled = !show;
        ui.addBtn.classList.toggle("h3d-disabled", !show);
    }
    if (ui?.delBtn) {
        ui.delBtn.disabled = !show;
        ui.delBtn.classList.toggle("h3d-disabled", !show);
    }
    // Hide empty outer 素材/剪辑 shells once shot controls moved into the list.
    const toolbar = editor?.root?.querySelector?.(".h3d-toolbar-wrap");
    if (toolbar) {
        for (const group of toolbar.querySelectorAll(".h3d-tool-group")) {
            const label = group.querySelector(".h3d-tool-label")?.textContent?.trim() || "";
            if (label !== "素材" && label !== "剪辑") continue;
            group.classList.toggle("hidden", show || !_toolGroupHasVisibleControls(group));
        }
    }
}

/** @deprecated */
export function updateFl2vReplaceBtn(editor) {
    updateFl2vToolbarBtns(editor);
}
/** @deprecated */
export function updateFl2vInsertBtns(editor) {
    updateFl2vToolbarBtns(editor);
}

/** Stubs for removed both-role seam API (timeline may still import briefly). */
export function isFl2vBothRole() {
    return false;
}
export function getFl2vSeamRatio() {
    return 0.5;
}
