import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    CUSTOM_ASPECT_RATIO,
    DEFAULT_ASPECT_RATIO,
    DEFAULT_MEGAPIXELS,
    defaultFrameCount,
    framesToDurationSec,
    genLayoutHint,
    getDirectorMode,
    imageBatchRequiresFixedOutput,
    isCustomAspectRatio,
    isPromptBatchTask,
    isVideoBatchTask,
    MAX_GEN_FRAMES,
    MAX_REFERENCE_AUDIOS,
    MAX_REFERENCE_IMAGES,
    MINIMAX_CANVAS_MULTIPLE,
    minFrameCount,
    newBatchSegment,
    NO_VIDEO_UPLOAD_TASKS,
    normalizeAspectRatioLabel,
    parseMegapixelsInput,
    clampMegapixels,
    refAudioLabel,
    refImageLabel,
    RESOLUTION_ASPECTS,
    resolutionFromSelector,
    resolveTaskKey,
    snapResolutionDim,
    sumFrameCounts,
    taskSupportsChainContinuity,
    taskUsesReferenceAudios,
    taskUsesReferenceImages,
    taskUsesReferenceVideo,
} from "./minimax_gen_timeline.js";
import {
    IMAGE_BATCH_STYLES,
    addImageBatchGroup,
    bindImageBatchEvents,
    deleteImageBatchGroup,
    ensureImageBatchTimeline,
    getImageBatchUiHeight,
    migrateRefsForChainContinuity,
    mountImageBatchPanel,
    normalizeImageBatchSegments,
    renderImageBatchGroups,
    setImageBatchPreview,
    setR2vToolbar,
    setToolbarDisabledForBatch,
    updateR2vToolbarBtns,
    wireBatchRunSelectControls,
} from "./minimax_image_batch.js";
import {
    FL2V_STYLES,
    bindFl2vEvents,
    buildFl2vPayloadFields,
    drawFl2vSegmentThumbnails,
    ensureFl2vTimeline,
    fl2vStartIndices,
    getFl2vTotalDurationSec,
    getFl2vSampleFrames,
    getFl2vVisualFrames,
    getFl2vUiHeight,
    removeFl2vShot,
    rippleFl2vRightEdge,
    mountFl2vPanel,
    normalizeFl2vSegments,
    openFl2vUpload,
    setFl2vToolbar,
    flushFl2vPromptDraft,
    syncFl2vDurationSecAfterDrag,
    syncFl2vFromShots,
    updateFl2vDetailUI,
    updateFl2vToolbarBtns,
} from "./minimax_fl2v.js";
import { mountPromptImageMentions } from "./minimax_prompt_mentions.js";
import {
    mountStudioDesk,
    normalizeParsedTimeline,
    repairDirectorStudioWidgets,
    updateImageDirectorVisibility,
    syncLocalDirectorForTask,
} from "./minimax_studio_desk.js";

const RULER_H = 24;
const SEG_LABEL_H = 20;
const TRACK_H = 160;
const TRACK_Y = RULER_H + SEG_LABEL_H;
const STAGE_PREVIEW_H = 220;
const MIN_SEG = 4;
const HANDLE_PX = 14;
/** Canvas-drawn run-select checkbox (not a DOM control). */
const RUN_CHECK_SIZE = 14;
const RUN_CHECK_HIT_PAD_X = 8;
const RUN_CHECK_HIT_PAD_Y = 4;
const THUMB_MAX_W = 168;
const THUMB_JPEG_Q = 0.55;
const TIMELINE_SYNC_DEBOUNCE_MS = 500;
const MAX_THUMBS_PER_SEGMENT = 20;
const THUMB_PREFETCH_BATCH = 6;
const DIRECTOR_MIN_WIDTH = 900;
const COMFY_UPLOAD_SOFT_LIMIT = 95 * 1024 * 1024;
const MINIMAX_CHUNK_SIZE = 8 * 1024 * 1024;

/** Segment continuity is opt-in; default off unless explicitly true in output. */
function isContinuityEnabled(output) {
    if (!output) return false;
    return output.continuityEnabled === true || output.continuity_enabled === true;
}

function normalizeAudioMode(value) {
    const raw = String(value || "generate").trim().toLowerCase();
    if (raw === "source" || raw === "original" || raw === "passthrough") return "source";
    if (raw === "mute" || raw === "silent" || raw === "silence") return "mute";
    return "generate";
}

function normalizeOutputContinuity(output = {}) {
    const rawOverlap = output.continuityOverlapFrames ?? output.continuity_overlap_frames ?? 9;
    return {
        ...output,
        continuityEnabled: isContinuityEnabled(output),
        continuityOverlapFrames: Math.max(1, Math.min(81, parseInt(rawOverlap, 10) || 9)),
        audioMode: normalizeAudioMode(output.audioMode ?? output.audio_mode),
    };
}

function stripTimelineContinuityRootFields(timeline) {
    if (!timeline || typeof timeline !== "object") return;
    delete timeline.continuityEnabled;
    delete timeline.continuity_enabled;
    delete timeline.continuityOverlapFrames;
    delete timeline.continuity_overlap_frames;
}

/** Drop ephemeral UI-only fields so they never persist in timeline_data. */
function stripTimelineEphemeralFields(timeline) {
    if (!timeline || typeof timeline !== "object") return;
    delete timeline.videoWorkspace;
    delete timeline.batchWorkspace;
}

const HIDDEN_WIDGETS = [
    "timeline_data", "total_frames", "width", "height", "ref_max_size",
    "task_type", "global_prompt", "frame_rate", "cfg",
    // seed stays visible under 采样设置 (with control_after_generate)
];

const DIRECTOR_WIDGET_LABELS = {
    seed: "种子 seed",
    clear_vram_between_segments: "段间清理显存",
    export_source_images: "输出原片对比 source_images",
    local_director_enable: "提示词导演（Queue 时扩写）",
    local_director_brief: "创意简述",
    local_director_model: "本地导演模型 GGUF",
    local_director_mode: "提示词导演模式",
    local_director_skill: "风格 Skill",
    local_director_max_tokens: "提示词导演 max_tokens",
    local_director_temperature: "提示词导演 temperature",
    image_director_enable: "参考图导演",
    image_director_auto_inject: "参考图自动注入图片1",
    ref_gen_enable: "Queue 时生成参考图",
    ref_gen_only: "仅生成参考图（跳过视频）",
    ref_gen_steps: "参考图 steps",
    ref_gen_cfg: "参考图 CFG",
    global_ref_image: "全局参考图输入",
    ref_gen_model: "参考图生成 MODEL",
    ref_gen_clip: "参考图生成 CLIP",
    ref_gen_vae: "参考图生成 VAE",
};

function applyDirectorWidgetLabels(node) {
    for (const w of node.widgets || []) {
        const label = DIRECTOR_WIDGET_LABELS[w.name];
        if (label) w.label = label;
    }
}

function drawGroupHeader(ctx, node, widget_width, y, H, label) {
    const margin = 10;
    const barH = Math.max(18, H - 4);
    ctx.fillStyle = "#2e2e2e";
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(margin, y + 2, widget_width - margin * 2, barH, 4);
    } else {
        ctx.rect(margin, y + 2, widget_width - margin * 2, barH);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d8dce8";
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(label, margin + 10, y + 2 + barH / 2);
}

function makeGroupHeaderWidget(inputName, inputData) {
    const opts = inputData?.[1] || {};
    const label = opts.default || opts.label || inputName;
    const el = document.createElement("div");
    el.className = "bd-widget-group";
    el.textContent = label;
    el.style.cssText = [
        "width:100%;box-sizing:border-box;margin:8px 0 4px;padding:6px 10px",
        "border:1px solid #555;border-left:3px solid #7a9cff;border-radius:4px",
        "color:#d8dce8;font-size:11px;font-weight:600;letter-spacing:.02em",
        "background:linear-gradient(180deg,#2e2e2e 0%,#242424 100%)",
        "pointer-events:none;user-select:none",
    ].join(";");
    return {
        name: inputName,
        type: "BDGROUP",
        value: label,
        label: "",
        element: el,
        options: opts,
        _bdGroupHeader: true,
        draw(ctx, node, widget_width, y, H) {
            drawGroupHeader(ctx, node, widget_width, y, H, label);
        },
        computeSize(width) {
            return [width, 26];
        },
        mouse() {
            return false;
        },
    };
}

const STYLES = `
.mmx-host{width:100%;box-sizing:border-box;display:block}
.bd-wrap{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#e0e0e0;font-size:11px;display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;position:relative;min-height:var(--comfy-widget-min-height,0px)}
.bd-main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:6px;width:100%}
.bd-modal-overlay{position:absolute;inset:0;z-index:200;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;border-radius:6px}
.bd-modal{background:#1e1e1e;border:1px solid #333;border-radius:6px;padding:12px;width:100%;max-width:460px;max-height:calc(100% - 8px);display:flex;flex-direction:column;gap:10px;box-shadow:0 10px 28px rgba(0,0,0,.5)}
.bd-modal-title{color:#e0e0e0;font-size:12px;font-weight:600;line-height:1.35}
.bd-modal-body{color:#aaa;font-size:11px;line-height:1.5;white-space:pre-wrap}
.bd-modal-body.hidden{display:none}
.bd-modal-list{flex:1;min-height:140px;max-height:240px;overflow:auto;background:#181818;border:1px solid #333;border-radius:6px;padding:4px;display:flex;flex-direction:column;gap:2px}
.bd-modal-list.hidden{display:none}
.bd-modal-item{padding:7px 8px;border-radius:4px;cursor:pointer;color:#ccc;font-size:11px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:1px solid transparent}
.bd-modal-item:hover{background:#252525;color:#eee}
.bd-modal-item.selected{background:#2a2a2a;border-color:#4fff8f;color:#fff}
.bd-modal-actions{display:flex;gap:8px;justify-content:flex-end;flex-shrink:0}
.bd-toolbar-wrap{display:flex;flex-direction:column;gap:4px;width:100%}
.bd-toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;width:100%}
.bd-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:1;min-width:0}
.bd-smart-split-msg{width:100%;box-sizing:border-box;font-size:11px;line-height:1.4;color:#f66;padding:0 2px;min-height:0}
.bd-smart-split-msg.hidden{display:none!important}
.bd-smart-split-msg.ok{color:#8c8}
.bd-stage{width:100%;box-sizing:border-box;background:#0c0c0c;border:1px solid #222;border-bottom:none;border-radius:6px 6px 0 0;overflow:hidden;position:relative;min-height:120px;max-height:280px;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center}
.bd-stage.hidden{display:none!important}
.bd-stage-video,.bd-stage-img{width:100%;height:100%;max-height:280px;object-fit:contain;background:#000;display:block}
.bd-stage-img.hidden,.bd-stage-video.hidden{display:none!important}
.bd-stage-empty{color:#555;font-size:11px;pointer-events:none}
.bd-stage-badge{position:absolute;left:8px;bottom:8px;padding:2px 7px;border-radius:3px;background:rgba(0,0,0,.65);color:#ccc;font-size:10px;line-height:1.4;cursor:pointer;user-select:none}
.bd-stage-badge:hover{color:#fff;background:rgba(0,0,0,.8)}
.bd-frame-jump{display:inline-flex;align-items:center;gap:4px;color:#ddd;font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums}
.bd-frame-jump .bd-frame-input{width:64px;background:#181818;border:1px solid #444;border-radius:4px;color:#eee;padding:4px 4px;font-size:11px;text-align:center;-moz-appearance:textfield}
.bd-frame-jump .bd-frame-input:focus{border-color:#4fff8f;outline:none}
.bd-frame-jump .bd-frame-input::-webkit-outer-spin-button,.bd-frame-jump .bd-frame-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.bd-frame-jump .bd-frame-total{color:#888;min-width:2.5em}
.bd-controls{width:100%;box-sizing:border-box;background:#151515;border:1px solid #222;border-radius:0 0 6px 6px;padding:8px 10px;margin-top:0;flex-shrink:0}
.bd-stage.hidden+.bd-controls{border-radius:6px;border-color:#333;background:#1e1e1e}
.bd-viewport{width:100%;min-width:100%;overflow-x:auto;border-radius:6px;border:1px solid #111;background:#2a2a2a;box-sizing:border-box;flex-shrink:0}
.bd-canvas{display:block;width:100%;min-width:100%;cursor:pointer;box-sizing:border-box;flex-shrink:0;object-fit:fill}
.bd-canvas.bd-grab{cursor:grab}
.bd-canvas.bd-grabbing{cursor:grabbing}
.bd-output{width:100%;box-sizing:border-box;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;background:#1e1e1e;border:1px solid #333;border-radius:6px}
.bd-split{display:block;width:100%;box-sizing:border-box}
.bd-player{display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%}
.bd-btn{background:#222;color:#e0e0e0;border:1px solid #111;border-radius:4px;padding:6px 12px;font-size:11px;cursor:pointer}
.bd-btn:hover{background:#333;border-color:#555}
.bd-btn-danger:hover{background:#4a1515;border-color:#c44;color:#faa}
.bd-split-edit-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;width:100%;box-sizing:border-box;padding:6px 10px;margin:0 0 4px;background:#241818;border:1px solid #633;border-radius:6px}
.bd-split-edit-bar.hidden{display:none!important}
.bd-split-edit-bar .bd-split-edit-hint{flex:1;min-width:140px;font-size:11px;line-height:1.35;color:#f88}
.bd-btn-del-split{background:#3a2020;border-color:#e66;color:#f88}
.bd-btn-del-split:hover{background:#4a1515;border-color:#f88;color:#fcc}
.bd-btn-sm{padding:3px 8px;font-size:10px}
.bd-btn-run-select.active{background:#1a3a2a;color:#4fff8f;border-color:#4fff8f}
.bd-run-select-bar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:10px;color:#aaa}
.bd-run-select-all-wrap{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#aaa;cursor:pointer;user-select:none;margin-left:2px}
.bd-run-select-all-wrap.hidden{display:none!important}
.bd-run-select-all-wrap input{width:14px;height:14px;margin:0;cursor:pointer;accent-color:#4fff8f}
.bd-run-select-bar.hidden{display:none!important}
.bd-batch-run-check{margin-right:6px;width:14px;height:14px;cursor:pointer;accent-color:#4fff8f;flex-shrink:0}
.bd-btn-primary{background:#1a3a2a;border-color:#4fff8f;color:#4fff8f}
.bd-mode{display:flex;border:1px solid #333;border-radius:4px;overflow:hidden}
.bd-mode button{border:none;background:#222;color:#aaa;padding:6px 12px;font-size:11px;cursor:pointer}
.bd-mode button.active{background:#333;color:#fff}
.bd-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bd-bounds,.bd-timecode{color:#aaa;font-size:11px}
.bd-timecode{color:#fff;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.bd-player .bd-timecode{min-width:88px;font-size:11px;color:#ddd}
.bd-icon-btn{background:#2a2a2a;border:1px solid #444;color:#eee;cursor:pointer;padding:6px 10px;border-radius:4px}
.bd-icon-btn.active{background:#1a3a2a;color:#4fff8f;border-color:#4fff8f;box-shadow:0 0 0 1px rgba(79,255,143,.35)}
.bd-seek{flex:1;min-width:120px;height:6px}
.bd-panel{width:100%;box-sizing:border-box;background:#222;border:1px solid #111;border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px}
.bd-prompt-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(110px,38%);gap:8px;align-items:stretch}
.bd-prompt-col{display:flex;flex-direction:column;gap:5px;min-width:0}
.bd-prompt-col .bd-label,.bd-refs-col .bd-label{color:#888;font-size:10px;line-height:1.2;flex-shrink:0}
.bd-prompt{width:100%;min-height:96px;background:#181818;border:1px solid #333;border-radius:6px;color:#eee;padding:8px;resize:vertical;font-size:12px;box-sizing:border-box;font-family:inherit;line-height:1.35;flex:1}
.bd-prompt-negative{display:none!important}
.bd-refs-col{display:flex;flex-direction:column;gap:4px;min-width:0;height:100%}
.bd-refs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:4px;width:100%;flex:1;align-content:start}
.bd-ref{position:relative;width:100%;aspect-ratio:1;min-width:0;max-height:64px;border:1px dashed #555;border-radius:4px;background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;font-size:9px;color:#666;transition:border-color .15s,background .15s}
.bd-ref.has-img{cursor:grab;border-style:solid}
.bd-ref.has-img:active{cursor:grabbing}
.bd-ref:hover{border-color:#7a9cff;background:#1a1a1a}
.bd-ref .bd-ref-tag{position:absolute;inset:auto 0 3px 0;text-align:center;font-size:9px;color:#777;pointer-events:none;line-height:1}
.bd-ref.has-img .bd-ref-tag{display:none}
.bd-select{background:#181818;border:1px solid #333;border-radius:4px;color:#eee;padding:4px 6px;font-size:11px;max-width:240px}
.bd-ref img{width:100%;height:100%;object-fit:cover}
.bd-ref .x{position:absolute;top:1px;right:3px;color:#f88;font-size:12px;line-height:1;display:none}
.bd-ref:hover .x{display:block}
.bd-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.bd-meta{color:#888;font-size:10px}
.bd-video-tag{color:#4fff8f;font-size:10px}
.bd-num{width:42px;background:#181818;border:1px solid #333;border-radius:4px;color:#eee;padding:5px 4px;font-size:11px;text-align:center;-moz-appearance:textfield}
.bd-num::-webkit-outer-spin-button,.bd-num::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.bd-output label{color:#888;font-size:10px;white-space:nowrap}
.bd-output .bd-out-fixed{display:flex;gap:4px;align-items:center}
.bd-output .bd-out-fixed.hidden{display:none}
.bd-run-status{width:100%;box-sizing:border-box;padding:8px 10px;background:#151515;border:1px solid #333;border-radius:6px;display:flex;flex-direction:column;gap:5px;margin-top:auto;flex-shrink:0}
.bd-run-status.idle .bd-run-title{color:#888}
.bd-run-status.active .bd-run-title{color:#4fff8f}
.bd-run-status.done .bd-run-title{color:#7a9cff}
.bd-run-status.error .bd-run-title{color:#f88}
.bd-run-title{font-size:11px;font-weight:600;line-height:1.35}
.bd-run-detail{color:#999;font-size:10px;line-height:1.4}
.bd-run-bars{display:flex;flex-direction:column;gap:3px}
.bd-run-bar{height:5px;background:#2a2a2a;border-radius:3px;overflow:hidden}
.bd-run-bar-fill{height:100%;background:linear-gradient(90deg,#2a6b4a,#4fff8f);border-radius:3px;transition:width .15s ease}
.bd-run-bar-sub .bd-run-bar-fill{background:linear-gradient(90deg,#3a5080,#7a9cff)}
.hidden{display:none!important}
.bd-controls.hidden{display:none!important}
.bd-gen-src{width:100%;min-height:72px;max-height:100px;border:1px dashed #555;border-radius:4px;background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;color:#666;font-size:10px;margin-top:4px;position:relative;box-sizing:border-box}
.bd-gen-src.has-img{border-style:solid;border-color:#444}
.bd-gen-src img{width:100%;height:100%;object-fit:contain;background:#000}
.bd-gen-src .x{position:absolute;top:1px;right:3px;color:#f88;font-size:12px;line-height:1;display:none;cursor:pointer;z-index:2}
.bd-gen-src.has-img:hover .x{display:block}
.bd-gen-src.has-video{padding:0;cursor:default;align-items:stretch;justify-content:flex-start;flex-direction:column}
.bd-gen-src.has-video .bd-ref-video-preview{width:100%;flex:1;min-height:100px;max-height:220px;object-fit:contain;background:#000;display:block;border-radius:3px}
.bd-gen-src .bd-ref-replace{position:absolute;bottom:4px;left:4px;z-index:3;background:rgba(0,0,0,.72);color:#ccc;border:1px solid #555;border-radius:3px;padding:2px 7px;font-size:9px;cursor:pointer;line-height:1.4}
.bd-gen-src .bd-ref-replace:hover{color:#fff;border-color:#888}
.bd-gen-src.has-video .x{display:block;z-index:3}
.bd-ref-video-col{display:flex;flex-direction:column;gap:4px;min-width:0;width:100%;flex:1}
.bd-ref-video-col .bd-gen-src{min-height:140px;max-height:none;flex:1}
.bd-ref-video-name{word-break:break-all;line-height:1.3}
.bd-ref-audios-wrap{display:flex;flex-direction:column;gap:4px;margin-top:6px;width:100%}
.bd-ref-audios{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;width:100%}
.bd-ref-audio{position:relative;min-height:52px;border:1px dashed #555;border-radius:4px;background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;padding:6px 4px;box-sizing:border-box;font-size:9px;color:#666;text-align:center;line-height:1.25}
.bd-ref-audio.has-audio{border-style:solid;border-color:#4a6a4a;color:#cfe;background:#152015}
.bd-ref-audio:hover{border-color:#7a9cff;background:#1a1a1a}
.bd-ref-audio.has-audio:hover{background:#1a2a1a}
.bd-ref-audio .bd-ref-audio-name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9ad;font-size:9px;padding:0 2px}
.bd-ref-audio .x{position:absolute;top:1px;right:3px;color:#f88;font-size:12px;line-height:1;display:none}
.bd-ref-audio:hover .x{display:block}
.bd-continuous-ref{display:flex;align-items:center;gap:6px;font-size:10px;color:#aaa;user-select:none;margin-left:8px}
.bd-continuous-ref label{display:flex;align-items:center;gap:4px;cursor:pointer}
.bd-continuous-ref input[type="checkbox"]{width:14px;height:14px;margin:0;cursor:pointer;accent-color:#4fff8f}
.bd-gen-fc-row{display:flex;align-items:center;gap:6px;margin-top:6px}
${IMAGE_BATCH_STYLES}
${FL2V_STYLES}
@media(max-width:768px){
.bd-prompt-layout{grid-template-columns:1fr}
.bd-ref{max-height:64px}
}
`;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function snapDim(v, stride = 32) {
    return Math.max(stride, Math.round(v / stride) * stride);
}

function resolveOutputDimensions(sourceW, sourceH, output, fallback = {}) {
    const mode = String(output?.mode || "long_edge").toLowerCase();
    const stride = 32;
    if (mode === "fixed") {
        const w = snapDim(+(output?.width ?? fallback.width ?? 864), stride);
        const h = snapDim(+(output?.height ?? fallback.height ?? 480), stride);
        return { mode: "fixed", width: w, height: h, refMaxSize: Math.max(w, h) };
    }
    const longEdge = Math.max(stride, +(output?.longEdge ?? output?.long_edge ?? fallback.refMaxSize ?? 848));
    const sw = sourceW || 0;
    const sh = sourceH || 0;
    if (!sw || !sh) {
        const w = snapDim(+(fallback.width ?? 864), stride);
        const h = snapDim(+(fallback.height ?? 480), stride);
        return { mode: "long_edge", width: w, height: h, refMaxSize: longEdge };
    }
    if (Math.max(sw, sh) <= longEdge) {
        return { mode: "long_edge", width: snapDim(sw, stride), height: snapDim(sh, stride), refMaxSize: longEdge };
    }
    const scale = longEdge / Math.max(sw, sh);
    return {
        mode: "long_edge",
        width: snapDim(Math.round(sw * scale), stride),
        height: snapDim(Math.round(sh * scale), stride),
        refMaxSize: longEdge,
    };
}

/** Upload a file to ComfyUI input/ (videos use the same endpoint as images). */
function isUploadSizeError(err) {
    const msg = String(err?.message || err);
    return /body size|413|max_upload|too large|104857600/i.test(msg);
}

function formatUploadError(err) {
    const msg = String(err?.message || err);
    if (isUploadSizeError(err)) {
        return "文件超过 ComfyUI 默认上传限制（100MB）。已尝试分块上传；若仍失败，请手动复制视频到 ComfyUI/input/ 后刷新，或启动时加参数 --max-upload-size 2048";
    }
    return msg;
}

function formatProbeFps(value) {
    const fps = Math.round(Number(value) * 100) / 100;
    if (Number.isInteger(fps)) return String(fps);
    return fps.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function coerceTimelineFps(value, fallback = 24) {
    const fps = Number(value);
    if (!Number.isFinite(fps) || fps <= 0) return coerceTimelineFps(fallback, 24);
    return Math.round(clamp(fps, 1, 240) * 100) / 100;
}

async function uploadToInput(file) {
    const body = new FormData();
    body.append("image", file);
    body.append("type", "input");
    body.append("overwrite", "true");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `Upload failed (${resp.status})`);
    }
    return resp.json();
}

async function uploadVideoChunked(file, onProgress) {
    const uploadId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / MINIMAX_CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
        const start = i * MINIMAX_CHUNK_SIZE;
        const end = Math.min(start + MINIMAX_CHUNK_SIZE, file.size);
        const body = new FormData();
        body.append("upload_id", uploadId);
        body.append("chunk_index", String(i));
        body.append("total_chunks", String(totalChunks));
        body.append("filename", file.name);
        body.append("chunk", file.slice(start, end), `${file.name}.part`);
        const resp = await api.fetchApi("/minimax/director/upload_chunk", { method: "POST", body });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(text || `分块上传失败 (${resp.status})`);
        }
        onProgress?.((i + 1) / totalChunks, i + 1, totalChunks);
        const data = await resp.json();
        if (data.name) return data;
    }
    throw new Error("分块上传未完成");
}

async function uploadToInputSmart(file, onProgress) {
    if (file.size <= COMFY_UPLOAD_SOFT_LIMIT) {
        try {
            return await uploadToInput(file);
        } catch (err) {
            if (!isUploadSizeError(err)) throw err;
        }
    }
    return uploadVideoChunked(file, onProgress);
}

function videoRelativePath(upload) {
    const name = upload.name || upload.filename;
    const sub = (upload.subfolder || "").replace(/\\/g, "/").replace(/\/$/, "");
    return sub ? `${sub}/${name}` : name;
}

function inputViewUrl(relativePath, type = "input") {
    const norm = String(relativePath || "").replace(/\\/g, "/");
    const slash = norm.lastIndexOf("/");
    const filename = slash >= 0 ? norm.slice(slash + 1) : norm;
    const subfolder = slash >= 0 ? norm.slice(0, slash) : "";
    const params = new URLSearchParams({ filename, type });
    if (subfolder) params.set("subfolder", subfolder);
    return api.apiURL(`/view?${params.toString()}`);
}

function refViewUrl(imageFile) {
    return inputViewUrl(imageFile, "input");
}

function deletedSourceRanges(video) {
    return video?.deletedSourceRanges || video?.deleted_source_ranges || [];
}

function logicalToSourceFrame(logical, video) {
    const map = video?.frameMap;
    if (map?.length) {
        return normalizeFrameMapEntry(map[clamp(logical, 0, map.length - 1)]).frame;
    }
    let src = logical;
    for (const [start, end] of [...deletedSourceRanges(video)].sort((a, b) => a[0] - b[0])) {
        if (src >= start) src += end - start;
        else break;
    }
    return src;
}

/** Inverse of logicalToSourceFrame for sparse deletes; -1 if source is in a deleted gap. */
function sourceToLogicalFrame(srcFrame, video) {
    const map = video?.frameMap;
    if (map?.length) {
        let best = -1;
        for (let i = 0; i < map.length; i++) {
            const e = normalizeFrameMapEntry(map[i]);
            if (e.frame === srcFrame) return i;
            if (e.frame < srcFrame) best = i;
            else if (best < 0) return -1; // before first kept
        }
        return best;
    }
    let logical = srcFrame;
    for (const [start, end] of [...deletedSourceRanges(video)].sort((a, b) => a[0] - b[0])) {
        if (srcFrame >= end) logical -= (end - start);
        else if (srcFrame >= start) return -1;
        else break;
    }
    return Math.max(0, logical);
}

function buildIdentityFrameMap(count) {
    return Array.from({ length: count }, (_, i) => i);
}

function normalizeFrameMapEntry(entry, defaultClip = 0) {
    if (entry == null) return { clip: defaultClip, frame: 0 };
    if (typeof entry === "number") return { clip: defaultClip, frame: entry };
    return {
        clip: entry.clip ?? entry.videoClip ?? defaultClip,
        frame: entry.frame ?? 0,
    };
}

function buildClipFrameMap(clipIndex, count) {
    return Array.from({ length: count }, (_, i) => ({ clip: clipIndex, frame: i }));
}

const CLIP_SEGMENT_COLORS = ["rgba(255,200,50,0.9)", "rgba(102,170,255,0.9)", "rgba(79,255,143,0.9)", "rgba(255,102,170,0.9)"];

/** Side-by-side when desk open and workbench wide enough for two columns. */
function isWorkbenchSideBySide(editor) {
    const wb = editor?.workbench;
    const desk = editor?.studioDesk;
    if (!wb || !desk?.classList?.contains("open")) return false;
    const w = wb.clientWidth || wb.offsetWidth || 0;
    // Two columns need ~260+260+gap; prefer width check over offsetTop (avoids layout races)
    return w >= 620;
}

/** Shared column height used by left batch list + right desk. */
function getWorkbenchColumnHeight(editor) {
    if (editor?.getDirectorMode?.() === "prompt_batch") {
        return Math.max(520, getImageBatchUiHeight(editor));
    }
    if (editor?.getDirectorMode?.() === "fl2v") {
        return Math.max(480, getFl2vUiHeight(editor));
    }
    let h = (editor?.canvasHeight || RULER_H + SEG_LABEL_H + TRACK_H) + 280;
    if (
        editor?.hasVideo?.()
        && !editor?.isImageBatch?.()
        && !editor?.isGenMode?.()
        && !editor?.isFl2vMode?.()
    ) {
        h += STAGE_PREVIEW_H + 10;
    }
    return Math.max(480, h);
}

function getDirectorUiHeight(editor) {
    const deskOpen = !!editor?.studioDesk?.classList?.contains("open");
    const sideBySide = isWorkbenchSideBySide(editor);
    const colH = getWorkbenchColumnHeight(editor);
    // Outside workbench: toolbar ≈40–70, run-status ≈56, gaps
    const chrome = 130;

    if (sideBySide) {
        return colH + chrome;
    }
    // Stacked: column + desk body budget
    const stackedDeskExtra = deskOpen ? 300 : 0;
    return colH + chrome + stackedDeskExtra;
}

function hookTaskTypeWidget(node) {
    const tw = node.widgets?.find((w) => w.name === "task_type");
    if (!tw || tw._berniniTaskHooked) return;
    tw._berniniTaskHooked = true;
    const orig = tw.callback;
    tw.callback = function (...args) {
        const r = orig?.apply(this, args);
        const ed = node._minimaxEditor;
        if (ed?.globalTask) ed.globalTask.value = tw.value;
        ed?.onTaskTypeChanged?.(tw.value);
        return r;
    };
}

function syncDirectorNodeSize(node, editor) {
    if (editor?.isPlaying) return;
    if (!node?.computeSize) return;
    if (editor) editor.updateDomWidgetHeight?.();
    const sz = node.computeSize();
    node.setSize([node.size[0], sz[1]]);
    node.setDirtyCanvas?.(true, true);
}

function ensureDirectorDomWidgetWidth(node) {
    const widget = node?._minimaxDomWidget;
    const fullW = node?.size?.[0];
    if (!widget || !fullW) return false;
    if (widget.width === fullW) return false;
    widget.width = fullW;
    return true;
}

function moveDirectorDomWidgetToEnd(node) {
    const widget = node?._minimaxDomWidget;
    if (!widget || !node?.widgets?.length) return;
    const idx = node.widgets.indexOf(widget);
    if (idx === -1 || idx === node.widgets.length - 1) return;
    node.widgets.splice(idx, 1);
    node.widgets.push(widget);
}

const PERF_WIDGET_ORDER = ["bd_grp_perf", "clear_vram_between_segments", "export_source_images"];

function moveDirectorPerfWidgetsBeforeTimeline(node) {
    const dom = node?._minimaxDomWidget;
    if (!node?.widgets?.length) return;

    const perfWidgets = PERF_WIDGET_ORDER
        .map((name) => node.widgets.find((w) => w.name === name))
        .filter(Boolean);
    if (!perfWidgets.length) return;

    for (const w of perfWidgets) {
        const idx = node.widgets.indexOf(w);
        if (idx !== -1) node.widgets.splice(idx, 1);
    }

    const insertAt = dom ? node.widgets.indexOf(dom) : -1;
    const at = insertAt === -1 ? node.widgets.length : insertAt;
    node.widgets.splice(at, 0, ...perfWidgets);
}

function finalizeDirectorWidgetOrder(node) {
    moveDirectorPerfWidgetsBeforeTimeline(node);
    moveDirectorDomWidgetToEnd(node);
}

function bindDirectorDomWidgetSizing(node, widget, getEditor) {
    const minHeight = () => getDirectorUiHeight(getEditor?.());
    widget.computeSize = (width) => [width, minHeight()];
    widget.computeLayoutSize = () => ({
        minHeight: minHeight(),
        minWidth: DIRECTOR_MIN_WIDTH,
    });
    if (widget.options) {
        widget.options.getMinHeight = minHeight;
    }
    const el = widget.element;
    if (el) el.style.minHeight = `${minHeight()}px`;
}

function initDirectorEditor(node) {
    // Must not share Bernini's `_directorDomWidget` — their loadedGraphNode mounts on that key.
    if (!isMiniMaxH3DirectorNode(node)) return null;
    if (node._minimaxEditor) return node._minimaxEditor;
    const container = node._minimaxDomWidget?.element;
    if (!container) return null;
    try {
        hookTaskTypeWidget(node);
        node._minimaxEditor = new MiniMaxH3DirectorEditor(node, container, node._minimaxDomWidget);
        ensureDirectorDomWidgetWidth(node);
        bindDirectorDomWidgetSizing(node, node._minimaxDomWidget, () => node._minimaxEditor);
        syncDirectorNodeSize(node, node._minimaxEditor);
        return node._minimaxEditor;
    } catch (err) {
        console.error("[MiniMax H3Director] UI init failed:", err);
        return null;
    }
}

function patchDirectorDomWidgetLayout() {
    const canvas = app.canvas;
    if (!canvas || canvas._minimaxDirectorLayoutPatch) return;
    canvas._minimaxDirectorLayoutPatch = true;
    const prev = canvas.onDrawForeground;
    canvas.onDrawForeground = function (ctx) {
        const graph = app.graph ?? canvas.graph;
        for (const node of graph?._nodes ?? graph?.nodes ?? []) {
            if (node._minimaxEditor?.isPlaying) continue;
            ensureDirectorDomWidgetWidth(node);
        }
        return prev?.apply(this, arguments);
    };
}

function stopDomEvent(e) {
    e.stopPropagation();
}

function hideWidget(w) {
    if (!w) return;
    // Group headers in HIDDEN_WIDGETS duplicate timeline panel sections — hide them too.
    if (w._bdGroupHeader && !HIDDEN_WIDGETS.includes(w.name)) return;
    w.hidden = true;
    if (!w.options) w.options = {};
    w.options.hidden = true;
    w.computeSize = () => [0, 0];
    if (w.element) w.element.style.display = "none";
}

function parseTimeline(raw, totalFrames, fps) {
    const total = totalFrames || 124;
    const base = {
        version: 4,
        editMode: "global",
        totalFrames: total,
        frameRate: coerceTimelineFps(fps || 24),
        video: {
            fileName: "",
            videoFile: "",
            subfolder: "",
            type: "input",
            frames: [],
            frameMap: [],
        },
        videoClips: [],
        global: { taskType: "", prompt: "", refs: [], refAudios: [], referenceVideo: {}, continuousReference: false },
        output: {
            mode: "fixed",
            aspectRatio: DEFAULT_ASPECT_RATIO,
            megapixels: DEFAULT_MEGAPIXELS,
            multiple: MINIMAX_CANVAS_MULTIPLE,
            longEdge: 864, width: 864, height: 480,
            maxExportFrames: 0, exportMode: "all",
            audioMode: "generate",
            continuityEnabled: false, continuityOverlapFrames: 9,
        },
        runSelectEnabled: false,
        runSelection: [],
        segments: [{ id: uid(), start: 0, length: total, prompt: "", taskType: "", refs: [], refAudios: [], referenceVideo: {}, label: "", camera: "小幅度缓慢推近", transition: "cut", retake: false, retake_note: "", run_selected: true }],
        continuity: { characters: "", locations: "", props: "", inject: true },
        desk: {
            style: "写实，电影感，景深层次清晰，光影克制",
            soundscape: "",
            music: "",
            image_director_note: "",
            text_director: { enabled: false, scope: "none", backend: "local", brief: "", llm_api_format: "Ollama", llm_url: "http://127.0.0.1:11434", llm_model: "qwen3.5", llm_api_key: "" },
        },
        run_scope: "all",
    };
    if (!raw?.trim()) return base;
    try {
        const data = JSON.parse(raw);
        data.version = data.version || 4;
        data.editMode = data.editMode || "global";
        data.frameRate = coerceTimelineFps(data.frameRate ?? fps ?? 24);
        data.video = data.video || { fileName: "", frames: [] };
        if (!data.video.videoFile && data.video.fileName) {
            data.video.videoFile = data.video.fileName;
        }
        data.video.type = data.video.type || "input";
        data.video.subfolder = data.video.subfolder || "";
        data.video.frames = data.video.frames || [];
        data.global = data.global || { refs: [], refAudios: [], referenceVideo: {}, continuousReference: false };
        data.global.refs = data.global.refs || [];
        data.global.refAudios = data.global.refAudios || data.global.ref_audios || [];
        data.global.referenceVideo = data.global.referenceVideo || data.global.reference_video || {};
        data.global.continuousReference = !!data.global.continuousReference || !!data.global.continuous_reference;
        const legacyRef = data.referenceVideo || data.reference_video;
        if (legacyRef && (legacyRef.videoFile || legacyRef.fileName)
            && !(data.global.referenceVideo.videoFile || data.global.referenceVideo.fileName)) {
            data.global.referenceVideo = { ...legacyRef };
        }
        delete data.referenceVideo;
        delete data.reference_video;
        data.output = normalizeOutputContinuity({
            mode: data.output?.mode || "long_edge",
            // Keep ResolutionSelector fields across reload (were previously dropped → always 16:9).
            aspectRatio: data.output?.aspectRatio != null
                ? normalizeAspectRatioLabel(data.output.aspectRatio)
                : undefined,
            megapixels: data.output?.megapixels ?? data.output?.megaPixels ?? undefined,
            multiple: data.output?.multiple ?? MINIMAX_CANVAS_MULTIPLE,
            longEdge: data.output?.longEdge ?? data.output?.long_edge ?? data.refMaxSize ?? 848,
            width: data.output?.width ?? data.width ?? 864,
            height: data.output?.height ?? data.height ?? 480,
            maxExportFrames: data.output?.maxExportFrames ?? data.output?.max_export_frames ?? 0,
            exportMode: data.output?.exportMode ?? data.output?.export_mode ?? "all",
            audioMode: normalizeAudioMode(data.output?.audioMode ?? data.output?.audio_mode),
            continuityEnabled: data.output?.continuityEnabled ?? data.output?.continuity_enabled,
            continuityOverlapFrames: data.output?.continuityOverlapFrames ?? data.output?.continuity_overlap_frames,
        });
        // Infer aspectRatio from saved width/height when older payloads omitted the label.
        if (!data.output.aspectRatio && data.output.width > 0 && data.output.height > 0) {
            const rw = data.output.width;
            const rh = data.output.height;
            const match = RESOLUTION_ASPECTS.find(([, aw, ah]) => Math.abs(rw / rh - aw / ah) < 0.02);
            data.output.aspectRatio = match ? match[0] : CUSTOM_ASPECT_RATIO;
        }
        if (!data.output.aspectRatio) data.output.aspectRatio = DEFAULT_ASPECT_RATIO;
        if (data.output.megapixels == null) data.output.megapixels = DEFAULT_MEGAPIXELS;
        stripTimelineContinuityRootFields(data);
        stripTimelineEphemeralFields(data);
        const legacyFrames = data.video.frames?.length || 0;
        if (!data.video.frameMap?.length) {
            const n = data.totalFrames || data.video.sourceFrameCount || legacyFrames || total;
            data.totalFrames = n;
            data.video.sourceFrameCount = data.video.sourceFrameCount || n;
            data.video.deletedSourceRanges = data.video.deletedSourceRanges || [];
            data.video.frameMap = [];
        }
        if (!data.segments?.length) {
            const n = data.totalFrames || data.video.sourceFrameCount || legacyFrames || total;
            data.segments = [{ id: uid(), start: 0, length: Math.max(MIN_SEG, n), prompt: "", taskType: "", refs: [], refAudios: [], referenceVideo: {} }];
        }
        for (const seg of data.segments) {
            if (!seg.id) seg.id = uid();
            if (seg.length == null && seg.end != null) seg.length = seg.end - seg.start;
            if (seg.frameCount == null && seg.length != null) seg.frameCount = seg.length;
            seg.refs = seg.refs || [];
            seg.refAudios = seg.refAudios || seg.ref_audios || [];
            seg.referenceVideo = seg.referenceVideo || seg.reference_video || {};
            seg.genImage = seg.genImage || { imageFile: seg.imageFile || "" };
            seg.negativePrompt = seg.negativePrompt ?? "";
        }
        data.gen = data.gen || { defaultFrameCount: 124 };
        if (data.global) {
            data.global.genImage = data.global.genImage || { imageFile: data.global.imageFile || "" };
        }
        data.runSelectEnabled = !!data.runSelectEnabled;
        data.runSelection = Array.isArray(data.runSelection) ? data.runSelection.map((i) => parseInt(i, 10)).filter((i) => i >= 0) : [];
        normalizeParsedTimeline(data);
        if (data.timelineMode === "fl2v" || ["fl2v", "fl_chain"].includes(resolveTaskKey(data.global?.taskType || ""))) {
            data.timelineMode = "fl2v";
            data.editMode = "segment";
            data.keyframes = Array.isArray(data.keyframes) ? data.keyframes : [];
            data.shots = Array.isArray(data.shots) ? data.shots : [];
            const stored = parseInt(data.totalFrames, 10);
            const farthest = Math.max(
                0,
                ...(data.segments || []).map((s) => (parseInt(s.start, 10) || 0) + (parseInt(s.length ?? s.frameCount, 10) || 0)),
                ...(data.keyframes || []).map((k) => (parseInt(k.start, 10) || 0) + (parseInt(k.frameCount ?? k.length, 10) || 0)),
            );
            data.totalFrames = (Number.isFinite(stored) && stored > 0)
                ? stored
                : Math.max(farthest, total, 240);
            return data;
        }
        if (data.timelineMode === "image_batch" || data.timelineMode === "prompt_batch") {
            data.timelineMode = "prompt_batch";
            data.editMode = "segment";
            data.totalFrames = sumFrameCounts(data.segments) || data.totalFrames || total;
            return data;
        }
        if (data.timelineMode === "gen_blank" || data.timelineMode === "gen_image") {
            const gkey = resolveTaskKey(data.global?.taskType || "");
            if (isPromptBatchTask(gkey)) {
                data.timelineMode = "prompt_batch";
                data.editMode = "segment";
            }
            data.totalFrames = sumFrameCounts(data.segments) || data.totalFrames || total;
            return data;
        }
        if (!data.videoClips?.length && data.video?.videoFile) {
            data.videoClips = [{
                id: data.video.id || uid(),
                fileName: data.video.fileName || "",
                videoFile: data.video.videoFile || data.video.fileName || "",
                subfolder: data.video.subfolder || "",
                type: data.video.type || "input",
                width: data.video.width || 0,
                height: data.video.height || 0,
                duration: data.video.duration || 0,
                nativeFps: data.video.nativeFps || data.video.native_fps || 0,
                nativeFrameCount: data.video.nativeFrameCount || data.video.native_frame_count || 0,
                sourceFrameCount: data.video.sourceFrameCount || data.video.frameMap?.length || 0,
                storageWidth: data.video.storageWidth,
                storageHeight: data.video.storageHeight,
            }];
        }
        data.videoClips = data.videoClips || [];
        data.totalFrames = data.totalFrames || data.video.sourceFrameCount || data.video.frameMap?.length || total;
        return data;
    } catch {
        return base;
    }
}

class MiniMaxH3DirectorEditor {
    constructor(node, container, domWidget) {
        this.node = node;
        this.container = container;
        this.domWidget = domWidget;
        this.zoom = 1;
        this.selectedIndex = 0;
        /** @type {number|null} Selected editable split-point frame (logical). */
        this.selectedSplitFrame = null;
        this.currentFrame = 0;
        this.isPlaying = false;
        this.isLooping = false;
        this._playRaf = null;
        this._drag = null;
        this._previewSegments = null;
        this._edgeSnapshot = null;
        this._isHovering = false;
        this._thumbCache = new Map();
        this._thumbPending = new Set();
        this._seekChain = Promise.resolve();
        this._legacyFrames = [];
        this._storageWidth = 0;
        this._storageHeight = 0;
        this._previewVideo = null;
        this._previewVideos = new Map();
        this._thumbCanvas = null;
        this._syncTimer = null;
        this._resizeRaf = null;
        this._renderPending = false;
        this._lastSeekUiMs = 0;
        this._playCanvasWidth = 0;
        this._pauseSettling = false;
        this._runHighlightSeg = -1;
        this._modalEl = null;
        this._modalKeyHandler = null;
        this._drawWidth = 0;
        this._reorderDropRank = -1;
        this._reorderFromRank = -1;
        this.canvasHeight = RULER_H + SEG_LABEL_H + TRACK_H;
        this._stageClipIndex = -1;
        this._stageSyncMs = 0;
        this._playHandoff = false;

        for (const w of node.widgets || []) {
            if (HIDDEN_WIDGETS.includes(w.name)) hideWidget(w);
        }

        this.timelineWidget = this.widget("timeline_data");
        this.totalFramesWidget = this.widget("total_frames");
        this.frameRateWidget = this.widget("frame_rate");
        this.taskTypeWidget = this.widget("task_type");
        this.globalPromptWidget = this.widget("global_prompt");
        this.negativePromptWidget = null;
        this.widthWidget = this.widget("width");
        this.heightWidget = this.widget("height");
        this.refMaxWidget = this.widget("ref_max_size");
        // Ensure Queue / graphToPrompt always serializes the live editor state
        // (exportMode, segments, …), not a stale timeline_data widget value.
        if (this.timelineWidget && !this.timelineWidget._minimaxSerializePatched) {
            const editor = this;
            const prevSerialize = this.timelineWidget.serializeValue?.bind(this.timelineWidget);
            this.timelineWidget.serializeValue = async (node, index) => {
                editor.flushTimelineSync?.();
                if (prevSerialize) return prevSerialize(node, index);
                return editor.timelineWidget?.value ?? "";
            };
            this.timelineWidget._minimaxSerializePatched = true;
        }

        const initTotal = Math.max(0, parseInt(this.totalFramesWidget?.value || 124, 10));
        const initFps = coerceTimelineFps(this.frameRateWidget?.value || 24);
        this.timeline = parseTimeline(this.timelineWidget?.value, initTotal, initFps);
        this.buildDOM();
        this.bindEvents();
        this._directorMode = getDirectorMode(this.taskTypeWidget?.value);
        if (this._directorMode === "video") {
            this.restoreVideoFromTimeline();
        } else if (this._directorMode === "prompt_batch" || this._directorMode === "image_batch") {
            ensureImageBatchTimeline(this);
        } else {
            this.ensureGenTimeline();
        }
        this.applyTaskLayout(this._directorMode);

        this.updateDomWidgetHeight();
        this.applyZoomWidth();
        this.syncFromWidgets();
        this.updateModeUI();
        this.updateSelectionUI();
        this.commit(true, { syncTimeline: false });
        this._observeViewportResize();
        this.scheduleRender();
    }

    _observeViewportResize() {
        if (!this.viewport || typeof ResizeObserver === "undefined") return;
        this._resizeObserver?.disconnect();
        this._resizeObserver = new ResizeObserver(() => {
            if (this.isPlaying) return;
            this.scheduleRender();
        });
        this._resizeObserver.observe(this.viewport);
    }

    _capturePlayCanvasWidth() {
        const w = this.viewport?.clientWidth
            || this.container?.offsetWidth
            || this.node?.size?.[0]
            || DIRECTOR_MIN_WIDTH;
        if (w > 0) this._playCanvasWidth = w;
        return this._playCanvasWidth;
    }

    _lockPlayLayout() {
        this._capturePlayCanvasWidth();
    }

    _resetLayoutStyles() {
        if (this.isPlaying) return;
        for (const el of [this.container, this.root, this.viewport]) {
            if (!el) continue;
            el.style.removeProperty("width");
            el.style.removeProperty("min-width");
            el.style.removeProperty("max-width");
        }
        this._playCanvasWidth = 0;
        this.applyZoomWidth();
    }

    _releasePlayLayoutLock() {
        this._resetLayoutStyles();
    }

    updateDomWidgetHeight() {
        const syncWorkbench = () => {
            const wb = this.workbench;
            const desk = this.studioDesk;
            if (!wb) return;
            // Clear leftover inline locks from older layout code
            if (desk) {
                desk.style.height = "";
                desk.style.maxHeight = "";
                desk.style.minHeight = "";
            }
            const side = isWorkbenchSideBySide(this);
            wb.classList.toggle("is-side", side);
            if (side) {
                const colH = getWorkbenchColumnHeight(this);
                wb.style.setProperty("--bd-workbench-h", `${colH}px`);
                wb.style.height = `${colH}px`;
                wb.style.maxHeight = `${colH}px`;
            } else {
                wb.style.removeProperty("--bd-workbench-h");
                wb.style.height = "";
                wb.style.maxHeight = "";
            }
        };
        const apply = () => {
            syncWorkbench();
            const h = getDirectorUiHeight(this);
            this.container?.style.setProperty("--comfy-widget-min-height", String(h));
            if (this.container) this.container.style.minHeight = `${h}px`;
            if (this.domWidget) {
                this.domWidget.computeSize = (width) => [width, h];
                if (this.domWidget.options) {
                    this.domWidget.options.getMinHeight = () => getDirectorUiHeight(this);
                }
            }
        };
        apply();
        if (this._deskHeightRaf) cancelAnimationFrame(this._deskHeightRaf);
        this._deskHeightRaf = requestAnimationFrame(() => {
            this._deskHeightRaf = null;
            apply();
            const node = this.node;
            if (node?.computeSize && node?.setSize) {
                const sz = node.computeSize();
                if (Array.isArray(sz) && sz[1] > 0 && node.size?.[1] !== sz[1]) {
                    node.setSize([node.size[0], sz[1]]);
                }
            }
        });
    }

    scheduleRender() {
        if (this._renderPending) return;
        this._renderPending = true;
        this._resizeRaf = requestAnimationFrame(() => {
            this._renderPending = false;
            if (this.isPlaying) this.renderTimelineOnly();
            else this.render();
        });
    }

    buildTimelinePayload() {
        if (this.isFl2vMode()) {
            const fl = buildFl2vPayloadFields(this);
            const outMode = this.timeline.output?.mode || "long_edge";
            const exportMode = (this.outExportMode?.value === "segments"
                || this.timeline.output?.exportMode === "segments")
                ? "segments"
                : "all";
            const output = {
                ...(this.timeline.output || {}),
                mode: outMode,
                exportMode,
            };
            const body = { ...this.timeline };
            stripTimelineContinuityRootFields(body);
            stripTimelineEphemeralFields(body);
            return {
                ...body,
                version: 5,
                ...fl,
                frameRate: this.getFrameRate(),
                global: {
                    ...(this.timeline.global || {}),
                    taskType: this.globalTask?.value || this.taskTypeWidget?.value || "",
                    prompt: this.timeline.global?.prompt || "",
                },
                output,
                ...this._runSelectionPayload(),
            };
        }
        if (this.isImageBatch()) {
            const taskKey = this.getTaskKey();
            const i2iSrc = (taskKey === "i2i" || taskKey === "i2v") ? this.getI2iSourceDimensions() : null;
            const outMode = imageBatchRequiresFixedOutput(taskKey)
                ? "fixed"
                : (this.timeline.output?.mode || "long_edge");
            const output = normalizeOutputContinuity({
                ...this.timeline.output,
                mode: outMode,
            });
            if (!isVideoBatchTask(taskKey)) {
                output.exportMode = "all";
            } else {
                output.exportMode = (this.outExportMode?.value === "segments"
                    || this.timeline.output?.exportMode === "segments")
                    ? "segments"
                    : "all";
            }
            if (i2iSrc?.width > 0 && i2iSrc?.height > 0) {
                output.sourceWidth = i2iSrc.width;
                output.sourceHeight = i2iSrc.height;
            }
            const batchBody = { ...this.timeline };
            stripTimelineContinuityRootFields(batchBody);
            stripTimelineEphemeralFields(batchBody);
            return {
                ...batchBody,
                version: 5,
                timelineMode: "prompt_batch",
                editMode: "segment",
                totalFrames: sumFrameCounts(this.timeline.segments),
                frameRate: this.getFrameRate(),
                width: this.timeline.output?.width,
                height: this.timeline.output?.height,
                global: {
                    ...this.timeline.global,
                    taskType: this.globalTask?.value || this.taskTypeWidget?.value || "",
                    prompt: this.timeline.global?.prompt || "",
                    ...(i2iSrc?.width > 0 ? { sourceWidth: i2iSrc.width, sourceHeight: i2iSrc.height } : {}),
                },
                output,
                segments: this.timeline.segments.map((s) => ({
                    id: s.id,
                    start: s.start,
                    length: s.frameCount ?? s.length ?? 1,
                    frameCount: s.frameCount ?? s.length ?? 1,
                    durationSec: s.durationSec,
                    prompt: s.prompt || "",
                    negativePrompt: s.negativePrompt || "",
                    taskType: s.taskType || "",
                    label: s.label || "",
                    camera: s.camera || "",
                    transition: s.transition || "cut",
                    retake: !!s.retake,
                    retake_note: s.retake_note || "",
                    refs: s.refs || [],
                    refAudios: s.refAudios || [],
                    refVideos: s.refVideos || [],
                    genImage: s.genImage || { imageFile: "" },
                })),
                ...this._runSelectionPayload(),
            };
        }
        if (this.isGenMode()) {
            const mode = this.getDirectorMode();
            const genBody = { ...this.timeline };
            stripTimelineContinuityRootFields(genBody);
            stripTimelineEphemeralFields(genBody);
            return {
                ...genBody,
                version: 5,
                timelineMode: mode,
                totalFrames: sumFrameCounts(this.timeline.segments),
                frameRate: this.getFrameRate(),
                width: this.timeline.output?.width,
                height: this.timeline.output?.height,
                refMaxSize: this.timeline.output?.longEdge,
                global: {
                    ...this.timeline.global,
                    taskType: this.globalTask?.value || this.taskTypeWidget?.value || "",
                    prompt: this.timeline.global?.prompt || "",
                },
                output: normalizeOutputContinuity({ ...this.timeline.output }),
                segments: this.timeline.segments.map((s) => ({
                    ...s,
                    frameCount: s.frameCount ?? s.length,
                })),
                ...this._runSelectionPayload(),
            };
        }
        const video = { ...(this.timeline.video || {}) };
        const frameMap = video.frameMap?.length ? video.frameMap : [];
        const src = this.getSourceDimensions();
        const resolved = resolveOutputDimensions(src.width, src.height, this.timeline.output || {}, {
            refMaxSize: this.refMaxWidget?.value,
        });
        const storageW = resolved.width || video.storageWidth || this._storageWidth;
        const storageH = resolved.height || video.storageHeight || this._storageHeight;
        const clips = this.getVideoClips().map((c) => ({
            ...c,
            storageWidth: storageW,
            storageHeight: storageH,
        }));
        const { referenceVideo: _legacyRefVideo, reference_video: _legacyRefVideo2, ...timelineBody } = this.timeline;
        stripTimelineContinuityRootFields(timelineBody);
        stripTimelineEphemeralFields(timelineBody);
        const clipSourceTotal = clips.reduce(
            (s, c) => s + (parseInt(c.sourceFrameCount, 10) || 0),
            0,
        );
        const sourceFrameCount = parseInt(video.sourceFrameCount, 10)
            || clipSourceTotal
            || (frameMap.length ? 0 : this.getTotalFrames());
        return {
            ...timelineBody,
            version: 4,
            timelineMode: "video",
            totalFrames: this.getTotalFrames(),
            frameRate: this.getFrameRate(),
            videoClips: clips,
            global: {
                ...(this.timeline.global || {}),
                taskType: this.globalTask?.value || this.taskTypeWidget?.value || "",
                prompt: this.timeline.global?.prompt || "",
                referenceVideo: this.timeline.global?.referenceVideo || {},
                continuousReference: !!this.timeline.global?.continuousReference,
            },
            segments: (this.timeline.segments || []).map((s) => ({
                ...s,
                referenceVideo: s.referenceVideo || {},
            })),
            video: {
                ...video,
                frameMap,
                sourceFrameCount,
                deletedSourceRanges: frameMap.length ? [] : (video.deletedSourceRanges || []),
                frames: this._legacyFrames.length ? this._legacyFrames : [],
                storageWidth: storageW,
                storageHeight: storageH,
            },
            output: normalizeOutputContinuity({ ...this.timeline.output }),
            ...this._runSelectionPayload(),
        };
    }

    flushTimelineSync() {
        clearTimeout(this._syncTimer);
        this._syncTimer = null;
        this.harvestBatchPrompts?.();
        this._writeTimelineWidget();
    }

    scheduleTimelineSync() {
        clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => {
            this.harvestBatchPrompts?.();
            this._writeTimelineWidget();
        }, TIMELINE_SYNC_DEBOUNCE_MS);
    }

    /** Pull latest prompt text from batch cards into timeline.segments (before Queue). */
    harvestBatchPrompts() {
        if (!this.isImageBatch?.() || !this.batchList) return;
        const cards = this.batchList.querySelectorAll(".bd-batch-card");
        cards.forEach((card, i) => {
            const seg = this.timeline.segments?.[i];
            if (!seg) return;
            const ta = card.querySelector('textarea[data-f="prompt"]');
            if (ta) seg.prompt = ta.value;
        });
    }

    _writeTimelineWidget() {
        if (!this.timelineWidget) return;
        this.harvestBatchPrompts?.();
        this.syncFromWidgets();
        this.timelineWidget.value = JSON.stringify(this.buildTimelinePayload());
        this.node.setDirtyCanvas(true, false);
    }

    _markNodeDirtyLight() {
        this.node.setDirtyCanvas(true, false);
    }

    buildDOM() {
        this.root = document.createElement("div");
        this.root.className = "bd-wrap";
        this.root.innerHTML = `<style>${STYLES}</style>`;

        const toolbarWrap = document.createElement("div");
        toolbarWrap.className = "bd-toolbar-wrap";
        toolbarWrap.innerHTML = `
            <div class="bd-toolbar">
                <div class="bd-actions">
                    <button type="button" class="bd-btn bd-btn-primary hidden" data-a="r2v-add-group" title="添加一组参考素材（图片 / 音频 / 视频）">添加素材组</button>
                    <button type="button" class="bd-btn bd-btn-primary" data-a="video">上传视频</button>
                    <button type="button" class="bd-btn bd-btn-primary hidden" data-a="fl2v-add-shot" title="添加一组首尾帧（首帧必传，尾帧可选）">添加一组</button>
                    <button type="button" class="bd-btn" data-a="video-append" title="上传并追加到时间轴末尾，作为独立片段">追加视频</button>
                    <button type="button" class="bd-btn" data-a="split">+ 分割</button>
                    <input type="number" class="bd-num" data-r="equal-n" min="2" max="64" value="2" title="均分段数">
                    <button type="button" class="bd-btn" data-a="equal">均分</button>
                    <button type="button" class="bd-btn" data-a="smart-split" title="使用 PySceneDetect 按分镜自动分割（需 pip install scenedetect）">智能分割</button>
                    <button type="button" class="bd-btn" data-a="run-select-toggle" title="开启后只采样勾选的片段；未勾选段不进采样（全部导出时用缓存或源画面填充）。关闭时运行全部">选择运行</button>
                    <label class="bd-run-select-all-wrap hidden" data-r="run-select-all-wrap" title="勾选=全选，取消=全部不选；仍可在各片段上单独勾选">
                        <input type="checkbox" data-r="run-select-all-cb">
                        <span>全选</span>
                    </label>
                    <button type="button" class="bd-btn bd-btn-danger" data-a="del" title="删除选中片段并裁剪视频，时间轴自动衔接">删除片段</button>
                    <div class="bd-mode">
                        <button type="button" data-a="mode-global" class="active">全局模式</button>
                        <button type="button" data-a="mode-segment">分段模式</button>
                    </div>
                    <select class="bd-select" data-r="global-task" title="task_type"></select>
                    <span class="bd-video-tag" data-r="video-name">未上传视频</span>
                </div>
                <div class="bd-right">
                    <div class="bd-bounds" data-r="bounds">Start: 0.00 | End: -</div>
                    <div class="bd-timecode" data-r="timecode">0.00s</div>
                </div>
            </div>
            <div class="bd-smart-split-msg hidden" data-r="smart-split-msg" role="status"></div>`;
        this.root.appendChild(toolbarWrap);
        this.smartSplitMsgEl = toolbarWrap.querySelector('[data-r="smart-split-msg"]');

        this.mainBody = document.createElement("div");
        this.mainBody.className = "bd-main";
        this.root.appendChild(this.mainBody);

        const stage = document.createElement("div");
        stage.className = "bd-stage hidden";
        stage.setAttribute("data-r", "video-stage");
        stage.innerHTML = `
            <video class="bd-stage-video hidden" data-r="stage-video" muted playsinline preload="auto"></video>
            <img class="bd-stage-img hidden" data-r="stage-img" alt="">
            <div class="bd-stage-empty" data-r="stage-empty">上传视频后可在此预览播放</div>
            <div class="bd-stage-badge hidden" data-r="stage-badge"></div>`;
        this.mainBody.appendChild(stage);

        // Playback bar sits between video stage and timeline edit area.
        const controls = document.createElement("div");
        controls.className = "bd-controls";
        controls.innerHTML = `
            <div class="bd-player">
                <button type="button" class="bd-icon-btn" data-a="play" title="播放 / 暂停">▶</button>
                <button type="button" class="bd-icon-btn" data-a="loop" title="循环播放：开启后预览播放到末尾会自动从头开始">⟳</button>
                <button type="button" class="bd-icon-btn" data-a="frame-prev" title="上一帧 (←)">‹</button>
                <button type="button" class="bd-icon-btn" data-a="frame-next" title="下一帧 (→)">›</button>
                <span class="bd-frame-jump" title="输入帧号后回车定位（从 1 开始）">
                    <span>帧</span>
                    <input type="number" class="bd-frame-input" data-r="frame-input" min="1" step="1" value="1">
                    <span>/</span>
                    <span class="bd-frame-total" data-r="frame-total">0</span>
                </span>
                <div class="bd-timecode" data-r="player-timecode">0.00 / 0.00</div>
                <input type="range" class="bd-seek" data-r="seek" min="0" value="0" step="1">
                <div class="bd-zoom bd-row">
                    <button type="button" class="bd-icon-btn" data-a="zoom-out">−</button>
                    <input type="range" data-r="zoom" min="1" max="10" step="0.25" value="1" style="width:80px">
                    <button type="button" class="bd-icon-btn" data-a="zoom-in">+</button>
                </div>
            </div>`;
        this.mainBody.appendChild(controls);

        // Appears above the timeline when a split point is selected.
        const splitEditBar = document.createElement("div");
        splitEditBar.className = "bd-split-edit-bar hidden";
        splitEditBar.setAttribute("data-r", "split-edit-bar");
        splitEditBar.innerHTML = `
            <span class="bd-split-edit-hint" data-r="split-edit-hint">已选中分割点</span>
            <button type="button" class="bd-btn bd-btn-del-split" data-a="del-split" title="删除选中分割点（合并相邻两段）">删除分割点</button>`;
        this.mainBody.appendChild(splitEditBar);
        this.splitEditBarEl = splitEditBar;
        this.splitEditHintEl = splitEditBar.querySelector('[data-r="split-edit-hint"]');

        this.viewport = document.createElement("div");
        this.viewport.className = "bd-viewport";
        this.canvas = document.createElement("canvas");
        this.canvas.className = "bd-canvas";
        this.viewport.appendChild(this.canvas);
        this.mainBody.appendChild(this.viewport);
        this.ctx = this.canvas.getContext("2d");

        const outputBar = document.createElement("div");
        outputBar.className = "bd-output";
        outputBar.innerHTML = `
            <span class="bd-fl2v-total-wrap hidden" data-r="fl2v-total-wrap" title="总时长 = 各组时长之和（只读）">
                <label>总时长（秒）</label>
                <input type="number" class="bd-num" data-r="fl2v-total" min="1" max="99999" step="0.1" value="5" style="width:64px" disabled title="总时长 = 各组之和，请在镜卡片或时间轴上改各镜时长">
            </span>
            <label>输出分辨率</label>
            <select class="bd-select" data-r="out-aspect" title="宽高比（同官方 ResolutionSelector）；选「自定义」可直接设宽高" style="max-width:200px">
                ${RESOLUTION_ASPECTS.map(([label]) => `<option value="${label}"${label === DEFAULT_ASPECT_RATIO ? " selected" : ""}>${label}</option>`).join("")}
                <option value="${CUSTOM_ASPECT_RATIO}">${CUSTOM_ASPECT_RATIO}</option>
            </select>
            <span class="bd-out-mp-wrap" data-r="out-mp-wrap" title="百万像素 · 同 ResolutionSelector.megapixels；1.0 MP ≈ 1024×1024">
                <label>百万像素</label>
                <input type="number" class="bd-num" data-r="out-mp" min="0.1" max="16" step="0.1" value="${DEFAULT_MEGAPIXELS}" style="width:56px">
            </span>
            <span class="bd-out-long hidden" data-r="out-long-wrap">
                <label>最长边</label>
                <input type="number" class="bd-num" data-r="out-long" min="32" max="8192" step="1" value="864" style="width:56px" title="缩放上限（可填 848 等任意值）；实际宽高再对齐到 32">
            </span>
            <span class="bd-out-fixed hidden" data-r="out-fixed-wrap" title="自定义宽高（对齐到 32 的倍数）">
                <label>宽</label>
                <input type="number" class="bd-num" data-r="out-w" min="32" max="8192" step="32" value="864" style="width:56px">
                <label>高</label>
                <input type="number" class="bd-num" data-r="out-h" min="32" max="8192" step="32" value="480" style="width:56px">
            </span>
            <select class="bd-select hidden" data-r="out-mode" title="输出缩放模式（视频编辑用）">
                <option value="long_edge">最长边缩放</option>
                <option value="fixed">固定宽高</option>
            </select>
            <label title="上传后默认跟源视频 FPS；修改时会保持真实时长不变并重算帧数（例：30→24fps 时 275 帧→约 220 帧，时长仍约 9.2s）">FPS</label>
            <input type="number" class="bd-num" data-r="timeline-fps" min="1" max="240" step="0.01" value="24" style="width:64px" title="时间线/导出 FPS">
            <span class="bd-out-audio-wrap hidden" data-r="out-audio-wrap" title="v2v / rv2v 声音：生成模型音频、沿用源视频原声，或静音">
                <label>声音</label>
                <select class="bd-select" data-r="out-audio-mode" style="max-width:120px">
                    <option value="generate">生成声音</option>
                    <option value="source">使用原声</option>
                    <option value="mute">静音</option>
                </select>
            </span>
            <span class="bd-meta" data-r="out-preview">—</span>
            <span class="bd-meta hidden" data-r="out-hint"></span>
            <label title="全部导出：合并为一个视频；分段导出：每组/每镜单独输出（images 为列表）。接 CreateVideo→SaveVideo 或 Video Combine 时会各存一个文件">导出方式</label>
            <select class="bd-select" data-r="out-export-mode" title="输出方式">
                <option value="all">全部导出</option>
                <option value="segments">分段导出</option>
            </select>
            <span class="hidden" data-r="out-max-frames-wrap" hidden aria-hidden="true">
                <label>最大帧数</label>
                <input type="number" class="bd-num" data-r="out-max-frames" min="0" max="999999" step="1" value="0" style="width:64px">
            </span>
            <span class="bd-continuous-ref hidden" data-r="segment-continuity-wrap" hidden aria-hidden="true"
                  title="开启后：上一分镜末帧默认作为下一分镜首帧（i2v/r2v 占用图片1，用户参考图剩 8 槽）">
                <label><input type="checkbox" data-r="segment-continuity-cb">链式连贯</label>
                <span class="bd-meta hidden" data-r="segment-continuity-overlap-label" hidden aria-hidden="true">参考帧数</span>
                <input type="number" class="bd-num hidden" data-r="segment-continuity-overlap" min="1" max="81" step="4" value="9" style="width:48px" hidden aria-hidden="true">
            </span>`;
        this.mainBody.appendChild(outputBar);

        const bottom = document.createElement("div");
        bottom.className = "bd-split";
        bottom.innerHTML = `
            <div class="bd-panel" data-r="global-panel">
                <b>全局提示词 & 参考图 (图片1–9)</b>
                <div class="bd-prompt-layout">
                    <div class="bd-prompt-col">
                        <span class="bd-label">提示词</span>
                        <textarea class="bd-prompt" data-r="global-prompt" placeholder="提示词（MiniMax H3 无反向提示词；最多约 7000 字符）— 输入 @ 选择参考图/音频"></textarea>
                        <textarea class="bd-prompt bd-prompt-negative hidden" data-r="global-negative" hidden aria-hidden="true"></textarea>
                    </div>
                    <div class="bd-refs-col" data-r="global-refs-col">
                        <div data-r="global-refs-images-wrap">
                            <span class="bd-label" data-r="global-refs-label">参考图 (图片1–9)</span>
                            <div class="bd-refs" data-r="global-refs"></div>
                        </div>
                        <div class="bd-ref-audios-wrap hidden" data-r="global-ref-audios-wrap">
                            <span class="bd-label">参考音频 (音频1–3)</span>
                            <div class="bd-ref-audios" data-r="global-ref-audios"></div>
                        </div>
                        <div class="bd-ref-video-col hidden" data-r="global-ref-video-col">
                            <span class="bd-label">参考视频（植入内容）</span>
                            <div class="bd-gen-src" data-r="global-ref-video" title="上传要植入的参考视频">点击上传参考视频</div>
                            <span class="bd-meta bd-ref-video-name" data-r="global-ref-video-name"></span>
                            <label class="bd-continuous-ref hidden" data-r="continuous-ref-wrap" title="勾选后，各片段的参考视频从与源片段时间轴相同的帧位置开始（如第2段从第30帧起，参考视频也从第30帧起）；未勾选时每段均从参考视频第1帧开始">
                                <input type="checkbox" data-r="continuous-ref-cb">
                                <span>连续参考</span>
                            </label>
                        </div>
                        <div class="bd-gen-src hidden" data-r="gen-global-img" title="上传源图片">点击上传源图片</div>
                    </div>
                </div>
                <div class="bd-gen-fc-row hidden" data-r="gen-global-fc-row">
                    <span class="bd-label">默认片段帧数</span>
                    <input type="number" class="bd-num" data-r="gen-default-fc" min="1" max="${MAX_GEN_FRAMES}" value="124" style="width:72px">
                </div>
            </div>
            <div class="bd-panel" data-r="segment-panel" style="display:none">
                <b data-r="seg-label">片段 1</b>
                <div class="bd-meta" data-r="seg-info"></div>
                <div class="bd-prompt-layout">
                    <div class="bd-prompt-col">
                        <span class="bd-label">提示词</span>
                        <textarea class="bd-prompt" data-r="seg-prompt" placeholder="该片段提示词（MiniMax H3 无反向提示词）— 输入 @ 选择参考图/音频"></textarea>
                        <textarea class="bd-prompt bd-prompt-negative hidden" data-r="seg-negative" hidden aria-hidden="true"></textarea>
                    </div>
                    <div class="bd-refs-col" data-r="seg-refs-col">
                        <div data-r="seg-refs-images-wrap">
                            <span class="bd-label" data-r="seg-refs-label">片段参考图 (图片1–9)</span>
                            <div class="bd-refs" data-r="seg-refs"></div>
                        </div>
                        <div class="bd-ref-audios-wrap hidden" data-r="seg-ref-audios-wrap">
                            <span class="bd-label">片段参考音频 (音频1–3)</span>
                            <div class="bd-ref-audios" data-r="seg-ref-audios"></div>
                        </div>
                        <div class="bd-ref-video-col hidden" data-r="seg-ref-video-col">
                            <span class="bd-label">片段参考视频（植入内容）</span>
                            <div class="bd-gen-src" data-r="seg-ref-video" title="上传要植入的参考视频">点击上传参考视频</div>
                            <span class="bd-meta bd-ref-video-name" data-r="seg-ref-video-name"></span>
                        </div>
                        <div class="bd-gen-src hidden" data-r="gen-seg-img" title="上传片段源图片">点击上传源图片</div>
                    </div>
                </div>
                <div class="bd-gen-fc-row hidden" data-r="gen-seg-fc-row">
                    <span class="bd-label">片段帧数</span>
                    <input type="number" class="bd-num" data-r="gen-seg-fc" min="1" max="${MAX_GEN_FRAMES}" value="124" style="width:72px">
                </div>
            </div>`;
        this.mainBody.appendChild(bottom);

        const batchUi = mountImageBatchPanel(this.mainBody);
        this.batchPanel = batchUi.panel;
        this.batchList = batchUi.list;
        this.batchHint = batchUi.hint;
        this.batchI2vNotice = batchUi.i2vNotice;
        this.batchGlobalRefsWrap = batchUi.globalRefsWrap;
        this.batchGlobalRefsGrid = batchUi.globalRefsGrid;
        this.batchAddBtn = batchUi.addBtn;
        wireBatchRunSelectControls(this, batchUi);

        this.fl2vUi = mountFl2vPanel(this.mainBody);
        this.fl2vTotalWrap = this.root.querySelector('[data-r="fl2v-total-wrap"]');
        if (this.fl2vUi) {
            this.fl2vUi.totalInput = this.root.querySelector('[data-r="fl2v-total"]');
        }
        bindFl2vEvents(this);

        const runStatus = document.createElement("div");
        runStatus.className = "bd-run-status idle";
        runStatus.dataset.r = "run-status";
        runStatus.innerHTML = `
            <div class="bd-run-title" data-r="run-title">运行状态：待命</div>
            <div class="bd-run-detail" data-r="run-detail">队列执行时将显示当前片段与阶段进度</div>
            <div class="bd-run-select-bar hidden" data-r="run-select-bar">
                <span data-r="run-select-summary">将运行全部片段</span>
            </div>
            <div class="bd-run-bars">
                <div class="bd-run-bar" title="整体进度"><div class="bd-run-bar-fill" data-r="run-overall" style="width:0%"></div></div>
                <div class="bd-run-bar bd-run-bar-sub" title="当前阶段"><div class="bd-run-bar-fill" data-r="run-phase" style="width:0%"></div></div>
            </div>`;
        this.root.appendChild(runStatus);

        this.container.appendChild(this.root);

        this._previewVideo = document.createElement("video");
        this._previewVideo.crossOrigin = "anonymous";
        this._previewVideo.muted = true;
        this._previewVideo.playsInline = true;
        this._previewVideo.preload = "auto";
        this._previewVideo.style.cssText = "position:fixed;width:0;height:0;opacity:0;pointer-events:none";
        document.body.appendChild(this._previewVideo);

        this._thumbCanvas = document.createElement("canvas");
        this._thumbCtx = this._thumbCanvas.getContext("2d", { alpha: false });

        this.videoNameEl = this.root.querySelector('[data-r="video-name"]');
        this.equalCountInput = this.root.querySelector('[data-r="equal-n"]');
        this.boundsEl = this.root.querySelector('[data-r="bounds"]');
        this.timecodeEl = this.root.querySelector('[data-r="timecode"]');
        this.playerTimecodeEl = this.root.querySelector('[data-r="player-timecode"]');
        this.frameInputEl = this.root.querySelector('[data-r="frame-input"]');
        this.frameTotalEl = this.root.querySelector('[data-r="frame-total"]');
        this.seekBar = this.root.querySelector('[data-r="seek"]');
        this.zoomSlider = this.root.querySelector('[data-r="zoom"]');
        this.stageEl = this.root.querySelector('[data-r="video-stage"]');
        this.stageVideo = this.root.querySelector('[data-r="stage-video"]');
        this.stageImg = this.root.querySelector('[data-r="stage-img"]');
        this.stageEmpty = this.root.querySelector('[data-r="stage-empty"]');
        this.stageBadge = this.root.querySelector('[data-r="stage-badge"]');
        if (this.stageVideo) {
            this.stageVideo.crossOrigin = "anonymous";
            this.stageVideo.muted = true;
            this.stageVideo.playsInline = true;
        }
        this.globalTask = this.root.querySelector('[data-r="global-task"]');
        this.globalPanel = this.root.querySelector('[data-r="global-panel"]');
        this.globalPanelTitle = this.globalPanel?.querySelector("b");
        this.segmentPanel = this.root.querySelector('[data-r="segment-panel"]');
        this.globalPrompt = this.root.querySelector('[data-r="global-prompt"]');
        this.globalNegative = this.root.querySelector('[data-r="global-negative"]');
        this.globalRefsBox = this.root.querySelector('[data-r="global-refs"]');
        this.globalRefsImagesWrap = this.root.querySelector('[data-r="global-refs-images-wrap"]');
        this.segRefsImagesWrap = this.root.querySelector('[data-r="seg-refs-images-wrap"]');
        this.globalRefAudiosWrap = this.root.querySelector('[data-r="global-ref-audios-wrap"]');
        this.globalRefAudiosBox = this.root.querySelector('[data-r="global-ref-audios"]');
        this.segRefAudiosWrap = this.root.querySelector('[data-r="seg-ref-audios-wrap"]');
        this.segRefAudiosBox = this.root.querySelector('[data-r="seg-ref-audios"]');
        this.segLabel = this.root.querySelector('[data-r="seg-label"]');
        this.segInfo = this.root.querySelector('[data-r="seg-info"]');
        this.segPrompt = this.root.querySelector('[data-r="seg-prompt"]');
        this.segNegative = this.root.querySelector('[data-r="seg-negative"]');
        this.segRefsBox = this.root.querySelector('[data-r="seg-refs"]');
        this.globalRefsCol = this.root.querySelector('[data-r="global-refs-col"]');
        this.segRefsCol = this.root.querySelector('[data-r="seg-refs-col"]');
        this.globalRefVideoCol = this.root.querySelector('[data-r="global-ref-video-col"]');
        this.globalRefVideo = this.root.querySelector('[data-r="global-ref-video"]');
        this.globalRefVideoNameEl = this.root.querySelector('[data-r="global-ref-video-name"]');
        this.segRefVideoCol = this.root.querySelector('[data-r="seg-ref-video-col"]');
        this.segRefVideo = this.root.querySelector('[data-r="seg-ref-video"]');
        this.segRefVideoNameEl = this.root.querySelector('[data-r="seg-ref-video-name"]');
        this.continuousRefWrap = this.root.querySelector('[data-r="continuous-ref-wrap"]');
        this.continuousRefCb = this.root.querySelector('[data-r="continuous-ref-cb"]');
        this.genGlobalImg = this.root.querySelector('[data-r="gen-global-img"]');
        this.genSegImg = this.root.querySelector('[data-r="gen-seg-img"]');
        this.genGlobalFcRow = this.root.querySelector('[data-r="gen-global-fc-row"]');
        this.genSegFcRow = this.root.querySelector('[data-r="gen-seg-fc-row"]');
        this.genDefaultFc = this.root.querySelector('[data-r="gen-default-fc"]');
        this.genSegFc = this.root.querySelector('[data-r="gen-seg-fc"]');
        this.controlsBar = this.root.querySelector(".bd-controls");
        this.btnVideo = this.root.querySelector('[data-a="video"]');
        this.btnFl2vAddShot = this.root.querySelector('[data-a="fl2v-add-shot"]');
        this.btnVideoAppend = this.root.querySelector('[data-a="video-append"]');
        this.outHint = this.root.querySelector('[data-r="out-hint"]');
        this.outMode = this.root.querySelector('[data-r="out-mode"]');
        this.outAspect = this.root.querySelector('[data-r="out-aspect"]');
        this.outMpWrap = this.root.querySelector('[data-r="out-mp-wrap"]');
        this.outMp = this.root.querySelector('[data-r="out-mp"]');
        this.outLongWrap = this.root.querySelector('[data-r="out-long-wrap"]');
        this.outFixedWrap = this.root.querySelector('[data-r="out-fixed-wrap"]');
        this.outLong = this.root.querySelector('[data-r="out-long"]');
        this.outW = this.root.querySelector('[data-r="out-w"]');
        this.outH = this.root.querySelector('[data-r="out-h"]');
        this.fpsInput = this.root.querySelector('[data-r="timeline-fps"]');
        this.outAudioWrap = this.root.querySelector('[data-r="out-audio-wrap"]');
        this.outAudioMode = this.root.querySelector('[data-r="out-audio-mode"]');
        this.outMaxFrames = this.root.querySelector('[data-r="out-max-frames"]');
        this.outExportMode = this.root.querySelector('[data-r="out-export-mode"]');
        this.segmentContinuityWrap = this.root.querySelector('[data-r="segment-continuity-wrap"]');
        this.segmentContinuityCb = this.root.querySelector('[data-r="segment-continuity-cb"]');
        this.segmentContinuityOverlap = this.root.querySelector('[data-r="segment-continuity-overlap"]');
        this.outPreview = this.root.querySelector('[data-r="out-preview"]');
        this.runStatusEl = this.root.querySelector('[data-r="run-status"]');
        this.runTitleEl = this.root.querySelector('[data-r="run-title"]');
        this.runDetailEl = this.root.querySelector('[data-r="run-detail"]');
        this.runOverallEl = this.root.querySelector('[data-r="run-overall"]');
        this.runPhaseEl = this.root.querySelector('[data-r="run-phase"]');
        this.runSelectBar = this.root.querySelector('[data-r="run-select-bar"]');
        this.runSelectSummary = this.root.querySelector('[data-r="run-select-summary"]');
        this.btnRunSelectToggle = this.root.querySelector('[data-a="run-select-toggle"]');
        this.runSelectAllWrap = this.root.querySelector('[data-r="run-select-all-wrap"]');
        this.runSelectAllCb = this.root.querySelector('[data-r="run-select-all-cb"]');

        this.populateTaskSelect(this.globalTask, this.taskTypeWidget?.value);
        this.syncNegativeFromWidget();
        this.syncOutputUIFromTimeline();
        bindImageBatchEvents(this);
        try {
            mountStudioDesk(this);
        } catch (err) {
            console.warn("[MiniMaxH3Director] studio desk mount failed:", err);
        }
    }

    renderImageBatchGroups() {
        renderImageBatchGroups(this);
    }

    normalizeImageBatchSegments() {
        normalizeImageBatchSegments(this);
    }

    syncNegativeFromWidget() {
        const v = this.negativePromptWidget?.value ?? "";
        if (this.globalNegative) this.globalNegative.value = v;
        if (this.segNegative) this.segNegative.value = v;
    }

    bindEvents() {
        const bind = (sel, fn) => {
            const el = this.root.querySelector(sel);
            if (!el) return;
            el.onclick = (e) => { stopDomEvent(e); fn(); };
        };
        bind('[data-a="video"]', () => this.pickVideoFile());
        bind('[data-a="fl2v-add-shot"]', () => openFl2vUpload(this));
        bind('[data-a="r2v-add-group"]', () => addImageBatchGroup(this));
        bind('[data-a="video-append"]', () => this.pickAppendVideoFile());
        bind('[data-a="split"]', () => this.splitAtFrame(this.currentFrame));
        bind('[data-a="equal"]', () => this.equalSplit());
        bind('[data-a="smart-split"]', () => { void this.smartSplit(); });
        bind('[data-a="del-split"]', () => this.deleteSelectedSplitPoint());
        bind('[data-a="run-select-toggle"]', () => this.toggleRunSelectMode());
        bind('[data-a="del"]', () => this.deleteSelectedSegment());
        bind('[data-a="mode-global"]', () => this.setEditMode("global"));
        bind('[data-a="mode-segment"]', () => this.setEditMode("segment"));
        bind('[data-a="play"]', () => this.togglePlay());
        bind('[data-a="loop"]', () => this.toggleLoop());
        bind('[data-a="frame-prev"]', () => this.stepFrame(-1));
        bind('[data-a="frame-next"]', () => this.stepFrame(1));
        bind('[data-a="zoom-in"]', () => this.adjustZoom(0.5));
        bind('[data-a="zoom-out"]', () => this.adjustZoom(-0.5));

        this.seekBar.oninput = () => {
            this.seekToFrame(+this.seekBar.value, { fromUi: true });
        };
        if (this.frameInputEl) {
            const applyFrameInput = () => {
                const total = this.getTotalFrames();
                if (total < 1) return;
                const raw = parseInt(this.frameInputEl.value, 10);
                if (!Number.isFinite(raw)) {
                    this.frameInputEl.value = String(this.currentFrame + 1);
                    return;
                }
                // UI is 1-based; internal currentFrame is 0-based.
                this.seekToFrame(raw - 1, { fromUi: true });
            };
            this.frameInputEl.addEventListener("keydown", (e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                    e.preventDefault();
                    applyFrameInput();
                    this.frameInputEl.blur();
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    this.frameInputEl.value = String(this.currentFrame + 1);
                    this.frameInputEl.blur();
                }
            });
            this.frameInputEl.addEventListener("change", applyFrameInput);
            this.frameInputEl.addEventListener("focus", () => {
                if (this.isPlaying) this._stopPlay();
                this.frameInputEl.select();
            });
        }
        if (this.stageBadge) {
            this.stageBadge.title = "点击输入精确帧号";
            this.stageBadge.addEventListener("click", (e) => {
                e.stopPropagation();
                if (this.isPlaying) this._stopPlay();
                this.frameInputEl?.focus();
                this.frameInputEl?.select();
            });
        }
        this.zoomSlider.oninput = () => { this.zoom = +this.zoomSlider.value; this.applyZoomWidth(); this.scheduleRender(); };
        if (this.runSelectAllCb) {
            this.runSelectAllCb.onchange = (e) => {
                stopDomEvent(e);
                if (!this.isRunSelectEnabled()) return;
                this.setRunSelectionAll(this.runSelectAllCb.checked);
            };
        }
        this.globalTask.onchange = () => this.onGlobalField("taskType", this.globalTask.value);
        this.globalPrompt.oninput = () => this.onGlobalField("prompt", this.globalPrompt.value);
        if (this.continuousRefCb) {
            this.continuousRefCb.onchange = () => {
                this.timeline.global = this.timeline.global || { refs: [], referenceVideo: {} };
                this.timeline.global.continuousReference = !!this.continuousRefCb.checked;
                this.scheduleTimelineSync();
            };
        }
        this.segPrompt.oninput = () => this.onSegField("prompt", this.segPrompt.value);
        this.globalNegative.oninput = () => this.onNegativePrompt(this.globalNegative.value);
        this.segNegative.oninput = () => this.onNegativePrompt(this.segNegative.value);

        mountPromptImageMentions(this);

        this.outMode.onchange = () => this.onOutputField("mode", this.outMode.value);
        if (this.outAspect) {
            this.outAspect.onchange = () => this.onOutputField("aspectRatio", this.outAspect.value);
        }
        if (this.outMp) {
            // Do not coerce incomplete drafts ("0", "0.") — that snaps back to 0.4 mid-typing.
            const applyMp = ({ force = false } = {}) => {
                const parsed = parseMegapixelsInput(this.outMp.value);
                if (parsed == null) {
                    if (!force) return;
                    const restored = clampMegapixels(
                        this.timeline.output?.megapixels ?? DEFAULT_MEGAPIXELS,
                    );
                    this.outMp.value = String(restored);
                    this.onOutputField("megapixels", restored);
                    return;
                }
                this.onOutputField("megapixels", parsed);
            };
            this.outMp.onchange = () => applyMp({ force: true });
            this.outMp.onblur = () => applyMp({ force: true });
            this.outMp.oninput = () => {
                clearTimeout(this._mpInputTimer);
                this._mpInputTimer = setTimeout(() => applyMp({ force: false }), 280);
            };
            this.outMp.addEventListener("keydown", (e) => e.stopPropagation());
        }
        this.outLong.onchange = () => this.onOutputField("longEdge", +this.outLong.value);
        this.outW.onchange = () => this.onOutputField("width", +this.outW.value);
        this.outH.onchange = () => this.onOutputField("height", +this.outH.value);
        this.fpsInput.onchange = () => this.onFrameRateChanged(this.fpsInput.value);
        this.fpsInput.oninput = () => {
            clearTimeout(this._fpsInputTimer);
            this._fpsInputTimer = setTimeout(() => this.onFrameRateChanged(this.fpsInput.value), 350);
        };
        this.outMaxFrames.onchange = () => this.onOutputField("maxExportFrames", +this.outMaxFrames.value);
        this.outExportMode.onchange = () => this.onOutputField("exportMode", this.outExportMode.value);
        if (this.outAudioMode) {
            this.outAudioMode.onchange = () => this.onOutputField("audioMode", this.outAudioMode.value);
        }
        if (this.segmentContinuityCb) {
            this.segmentContinuityCb.onchange = () => {
                const on = !!this.segmentContinuityCb.checked;
                if (!this.timeline.output) this.timeline.output = {};
                this.timeline.output.continuityEnabled = on;
                migrateRefsForChainContinuity(this, on);
                this.updateSegmentContinuityUI();
                if (this.isImageBatch?.()) renderImageBatchGroups(this);
                if (this.isFl2vMode?.()) updateFl2vDetailUI(this);
                this.commit();
                this.flushTimelineSync();
            };
        }
        if (this.segmentContinuityOverlap) {
            const applyOverlap = () => this.onOutputField("continuityOverlapFrames", +this.segmentContinuityOverlap.value);
            this.segmentContinuityOverlap.onchange = applyOverlap;
            this.segmentContinuityOverlap.oninput = applyOverlap;
            this.segmentContinuityOverlap.addEventListener("keydown", (e) => e.stopPropagation());
            this.segmentContinuityOverlap.addEventListener("keyup", (e) => e.stopPropagation());
        }

        this.genGlobalImg?.addEventListener("click", (e) => { stopDomEvent(e); this.pickGenSrcImage(true); });
        this.genSegImg?.addEventListener("click", (e) => { stopDomEvent(e); this.pickGenSrcImage(false); });
        this.genDefaultFc?.addEventListener("change", () => this.onGenDefaultFcChange());
        this.genSegFc?.addEventListener("change", () => this.onGenSegFcChange());

        this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
        this.canvas.addEventListener("dblclick", (e) => {
            if (this.isFl2vMode()) {
                stopDomEvent(e);
                e.preventDefault();
                const { x, y } = this.getMousePos(e);
                const hit = this.hitTest(x, y);
                if (hit?.type === "segment" || hit?.type === "edge") {
                    const idx = hit.index ?? this.selectedIndex;
                    if (idx !== this.selectedIndex) flushFl2vPromptDraft(this);
                    this.selectedIndex = idx;
                    this.updateSelectionUI();
                    updateFl2vDetailUI(this);
                    this._fl2vUploadMode = "slot";
                    this._fl2vSlotKind = "start";
                    this._fl2vSlotShotIndex = idx;
                    this.fl2vUi?.fileInput?.click();
                }
                return;
            }
            this.addSplitAtMouse(e);
        });
        this.canvas.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            if (this.isFl2vMode()) return;
            this.addSplitAtMouse(e);
        });
        this._onMouseMove = (e) => this.onMouseMove(e);
        this._onMouseUp = () => this.onMouseUp();
        this._onCanvasHover = (e) => {
            if (this._drag || this.isPlaying) return;
            const { x, y } = this.getMousePos(e);
            const hit = this.hitTest(x, y);
            this.canvas.classList.remove("bd-grab");
            if (hit?.type === "run-check" || hit?.type === "split") {
                this.canvas.style.cursor = "pointer";
            } else if (hit?.type === "edge") {
                // Edge drag is always horizontal (change start/length); keep ↔ cursor.
                this.canvas.style.cursor = "ew-resize";
                this.canvas.title = this.isFl2vMode()
                    ? "拖动：调整本镜时长（后面各组跟着移）"
                    : "";
            } else if (hit?.type === "segment" && (this.isFl2vMode() || this.isR2vBatch() || this.timeline.segments.length >= 2)) {
                this.canvas.classList.add("bd-grab");
                this.canvas.style.cursor = "";
                this.canvas.title = this.isFl2vMode()
                    ? "拖动：与其它镜交换位置（双击替换首帧）"
                    : (this.isR2vBatch() ? "拖动：调整素材组顺序" : "拖动：调整片段顺序");
            } else {
                this.canvas.style.cursor = "";
                this.canvas.title = "";
            }
        };
        window.addEventListener("mousemove", this._onMouseMove);
        window.addEventListener("mouseup", this._onMouseUp);
        this.canvas.addEventListener("mousemove", this._onCanvasHover);
        this.canvas.addEventListener("mouseleave", () => {
            this.canvas.classList.remove("bd-grab");
            this.canvas.style.cursor = "";
            this.canvas.title = "";
        });

        this.root.addEventListener("mouseenter", () => { this._isHovering = true; });
        this.root.addEventListener("mouseleave", () => { this._isHovering = false; });
        this._onKeyDown = (e) => {
            if (!this._isHovering) return;
            const tag = document.activeElement?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
            if ((e.key === "Delete" || e.key === "Backspace") && this.timeline.segments.length >= 1) {
                // Split points only delete via the toolbar button; Delete removes segments.
                if (this.selectedSplitFrame != null) {
                    e.preventDefault();
                    return;
                }
                this.deleteSelectedSegment();
                e.preventDefault();
            } else if (e.code === "Space") {
                this.togglePlay(); e.preventDefault();
            } else if (e.key === "ArrowLeft") {
                this.stepFrame(e.shiftKey ? -10 : -1);
                e.preventDefault();
            } else if (e.key === "ArrowRight") {
                this.stepFrame(e.shiftKey ? 10 : 1);
                e.preventDefault();
            }
        };
        window.addEventListener("keydown", this._onKeyDown, true);

        this.root.addEventListener("dragover", (e) => e.preventDefault());
        this.root.addEventListener("drop", (e) => {
            e.preventDefault();
            // Slot-to-slot moves are handled on .bd-ref; don't also treat as new upload.
            const types = [...(e.dataTransfer?.types || [])];
            if (types.includes("application/x-minimax-ref-slot")) return;
            if (types.includes("application/x-minimax-fl2v-slot")) return;
            if (types.includes("application/x-minimax-fl2v-shot")) return;
            if (e.target.closest?.(".bd-ref, .bd-batch-ref, .bd-fl2v-slot, .bd-fl2v-shot")) return;
            const f = e.dataTransfer.files?.[0];
            if (f?.type.startsWith("video/")) this.loadVideoFile(f);
            else if (f?.type.startsWith("image/")) {
                if (this.isImageBatch?.() && e.target.closest?.(".bd-batch-ref")) return;
                if (this.isImageBatch?.()) return;
                this.addRefFromFile(f, this.getRefTarget());
            }
        });
    }

    destroy() {
        clearTimeout(this._syncTimer);
        cancelAnimationFrame(this._resizeRaf);
        cancelAnimationFrame(this._playRaf);
        this._resizeObserver?.disconnect();
        this._closeBdModal();
        this._previewVideo?.remove();
        this._previewVideo = null;
        window.removeEventListener("mousemove", this._onMouseMove);
        window.removeEventListener("mouseup", this._onMouseUp);
        this.canvas?.removeEventListener("mousemove", this._onCanvasHover);
        this.canvas?.classList.remove("bd-grab", "bd-grabbing");
        window.removeEventListener("keydown", this._onKeyDown, true);
    }

    widget(name) { return this.node.widgets?.find((w) => w.name === name); }

    hasVideo() {
        const v = this.timeline?.video || {};
        return !!(this.getVideoClips().length || v.videoFile || this._legacyFrames.length || v.frames?.length);
    }

    getVideoClips() {
        if (this.timeline.videoClips?.length) return this.timeline.videoClips;
        const v = this.timeline?.video || {};
        if (v.videoFile || v.fileName) {
            return [{
                id: v.id || "c0",
                fileName: v.fileName || "",
                videoFile: v.videoFile || v.fileName || "",
                subfolder: v.subfolder || "",
                type: v.type || "input",
                width: v.width || 0,
                height: v.height || 0,
                duration: v.duration || 0,
                nativeFps: v.nativeFps || v.native_fps || 0,
                nativeFrameCount: v.nativeFrameCount || v.native_frame_count || 0,
                sourceFrameCount: v.sourceFrameCount || this.getFrameMap().length,
                storageWidth: v.storageWidth,
                storageHeight: v.storageHeight,
            }];
        }
        return [];
    }

    _ensureVideoClipsArray() {
        if (!this.timeline.videoClips?.length) {
            const v = this.timeline?.video || {};
            if (v.videoFile || v.fileName) {
                this.timeline.videoClips = [{
                    id: v.id || uid(),
                    fileName: v.fileName || "",
                    videoFile: v.videoFile || v.fileName || "",
                    subfolder: v.subfolder || "",
                    type: v.type || "input",
                    width: v.width || 0,
                    height: v.height || 0,
                    duration: v.duration || 0,
                    nativeFps: v.nativeFps || v.native_fps || 0,
                    nativeFrameCount: v.nativeFrameCount || v.native_frame_count || 0,
                    sourceFrameCount: v.sourceFrameCount || this.getFrameMap().length,
                    storageWidth: v.storageWidth,
                    storageHeight: v.storageHeight,
                }];
            } else {
                this.timeline.videoClips = [];
            }
        }
    }

    getClipViewUrl(clipIndex) {
        const clip = this.getVideoClips()[clipIndex];
        if (!clip?.videoFile) return "";
        return inputViewUrl(clip.videoFile, clip.type || "input");
    }

    getRefVideoTarget() {
        if (this.isGlobalMode()) {
            this.timeline.global = this.timeline.global || { refs: [], referenceVideo: {} };
            if (!this.timeline.global.referenceVideo) this.timeline.global.referenceVideo = {};
            return this.timeline.global;
        }
        const seg = this.timeline.segments[this.selectedIndex];
        if (seg) {
            if (!seg.referenceVideo) seg.referenceVideo = {};
            return seg;
        }
        this.timeline.global = this.timeline.global || { refs: [], referenceVideo: {} };
        return this.timeline.global;
    }

    getReferenceVideoViewUrl(ref) {
        const block = ref || {};
        const file = block.videoFile || block.fileName;
        if (!file) return "";
        return inputViewUrl(file, block.type || "input");
    }

    _stopRefVideoPreviews(onlyEls = null) {
        const targets = onlyEls || [this.globalRefVideo, this.segRefVideo];
        for (const el of targets) {
            const v = el?.querySelector("video");
            if (v) {
                v.pause();
                v.removeAttribute("src");
                v.load();
            }
        }
    }

    getTaskKey() {
        return resolveTaskKey(
            this.globalTask?.value
            || this.timeline.global?.taskType
            || this.taskTypeWidget?.value,
        );
    }

    getRunnableSegmentCount() {
        if (this.isFl2vMode()) return fl2vStartIndices(this).length;
        return this.timeline.segments?.length || 0;
    }

    supportsRunSelect() {
        const n = this.getRunnableSegmentCount();
        if (n < 2) return false;
        const mode = this.getDirectorMode();
        if (mode === "video") return true;
        if (mode === "fl2v") return true;
        if (this.isImageBatch()) return isPromptBatchTask(this.getTaskKey());
        return false;
    }

    getRunProgressSegmentTotal() {
        const n = this.getRunnableSegmentCount();
        if (!this.isRunSelectEnabled() || n < 2) return Math.max(n, 1);
        const count = (this.timeline.runSelection || []).length;
        return count > 0 ? count : Math.max(n, 1);
    }

    isRunSelectEnabled() {
        return !!this.timeline.runSelectEnabled;
    }

    normalizeRunSelection() {
        if (!this.isRunSelectEnabled()) return;
        if (this.isFl2vMode()) {
            const valid = new Set(fl2vStartIndices(this));
            this.timeline.runSelection = [...new Set(
                (this.timeline.runSelection || []).filter((i) => valid.has(i)),
            )].sort((a, b) => a - b);
            return;
        }
        const n = this.getRunnableSegmentCount();
        if (n < 1) return;
        this.timeline.runSelection = [...new Set(
            (this.timeline.runSelection || []).filter((i) => i >= 0 && i < n),
        )].sort((a, b) => a - b);
    }

    isSegmentRunEnabled(index) {
        if (!this.isRunSelectEnabled()) return true;
        return (this.timeline.runSelection || []).includes(index);
    }

    toggleSegmentRun(index) {
        if (!this.isRunSelectEnabled()) return;
        if (this.isFl2vMode()) {
            if (!this.timeline.segments?.[index]?.isStartFrame) return;
        } else {
            const n = this.getRunnableSegmentCount();
            if (index < 0 || index >= n) return;
        }
        const sel = new Set(this.timeline.runSelection || []);
        if (sel.has(index)) sel.delete(index);
        else sel.add(index);
        this.timeline.runSelection = [...sel].sort((a, b) => a - b);
        this.updateRunSelectUI();
        this.commit(false, { syncTimeline: true });
        if (this.isImageBatch()) this.renderImageBatchGroups();
        else this.scheduleRender();
    }

    toggleRunSelectMode() {
        if (!this.supportsRunSelect()) return;
        this.timeline.runSelectEnabled = !this.timeline.runSelectEnabled;
        if (this.timeline.runSelectEnabled) {
            if (!(this.timeline.runSelection || []).length) {
                if (this.isFl2vMode()) {
                    this.timeline.runSelection = fl2vStartIndices(this);
                } else {
                    const n = this.getRunnableSegmentCount();
                    this.timeline.runSelection = Array.from({ length: n }, (_, i) => i);
                }
            } else {
                this.normalizeRunSelection();
            }
        }
        this.updateRunSelectUI();
        this.commit(false, { syncTimeline: true });
        if (this.isImageBatch()) this.renderImageBatchGroups();
        else this.scheduleRender();
    }

    setRunSelectionAll(on) {
        if (!this.isRunSelectEnabled()) return;
        if (this.isFl2vMode()) {
            this.timeline.runSelection = on ? fl2vStartIndices(this) : [];
            this.updateRunSelectUI();
            this.commit(false, { syncTimeline: true });
            this.scheduleRender();
            return;
        }
        const n = this.getRunnableSegmentCount();
        this.timeline.runSelection = on ? Array.from({ length: n }, (_, i) => i) : [];
        this.updateRunSelectUI();
        this.commit(false, { syncTimeline: true });
        if (this.isImageBatch()) this.renderImageBatchGroups();
        else this.scheduleRender();
    }

    updateRunSelectUI() {
        const n = this.getRunnableSegmentCount();
        const canRunSelect = this.supportsRunSelect();
        const enabled = this.isRunSelectEnabled() && canRunSelect;
        // r2v uses timeline checkboxes (fl2v-style); other batch tasks use the card bar.
        const useBatchBar = this.isImageBatch() && canRunSelect && !this.isR2vBatch();
        this.btnRunSelectToggle?.classList.toggle("active", enabled);
        this.btnRunSelectToggle?.classList.toggle("bd-btn-run-select", true);
        this.btnRunSelectToggle?.classList.toggle("hidden", !canRunSelect || useBatchBar);
        this.batchRunSelectBtn?.classList.toggle("active", enabled);
        this.batchRunSelectBtn?.classList.toggle("hidden", !useBatchBar);
        this.runSelectAllWrap?.classList.toggle("hidden", !enabled || useBatchBar);
        this.batchRunSelectAllWrap?.classList.toggle("hidden", !enabled || !useBatchBar);
        // Keep the chip hidden while a run is active — otherwise commit/sync
        // re-shows it on top of the green progress title.
        const running = !!this.runStatusEl?.classList.contains("active");
        this.runSelectBar?.classList.toggle("hidden", !enabled || running);
        if (!canRunSelect) return;
        this.normalizeRunSelection();
        const count = (this.timeline.runSelection || []).length;
        const syncAllCb = (cb) => {
            if (!cb) return;
            cb.checked = count >= n && n > 0;
            cb.indeterminate = count > 0 && count < n;
        };
        syncAllCb(this.runSelectAllCb);
        syncAllCb(this.batchRunSelectAllCb);
        const label = this.isImageBatch() ? "组" : "段";
        if (!this.runSelectSummary) return;
        if (!count) {
            this.runSelectSummary.textContent = `未勾选任何${label}（无法运行）`;
            this.runSelectSummary.style.color = "#f88";
        } else if (count >= n) {
            this.runSelectSummary.textContent = `将运行全部 ${n} ${label}`;
            this.runSelectSummary.style.color = "#aaa";
        } else {
            const nums = (this.timeline.runSelection || []).map((i) => i + 1).join(", ");
            const exportHint = this.timeline.output?.exportMode === "segments"
                ? "· 仅导出勾选段"
                : "· 未勾选段用缓存/源画面填充，不采样";
            this.runSelectSummary.textContent = count === 1
                ? `将采样 1 ${label}（#${nums}）${exportHint}`
                : `将采样 ${count} ${label}（#${nums}）${exportHint}`;
            this.runSelectSummary.style.color = "#4fff8f";
        }
    }

    /** Drop live run-select flags (mode switch). Stashed workspaces keep their own copy. */
    _clearLiveRunSelection() {
        this.timeline.runSelectEnabled = false;
        this.timeline.runSelection = [];
    }

    _runSelectionPayload() {
        // Never leak video-mode「选择运行」into i2v/batch (or vice versa).
        if (!this.supportsRunSelect() || !this.timeline.runSelectEnabled) {
            return { runSelectEnabled: false, runSelection: [] };
        }
        this.normalizeRunSelection();
        return {
            runSelectEnabled: true,
            runSelection: [...(this.timeline.runSelection || [])],
        };
    }

    getDirectorMode() {
        return getDirectorMode(this.globalTask?.value || this.taskTypeWidget?.value);
    }

    isGenMode() {
        const mode = this.getDirectorMode();
        return mode !== "video" && mode !== "prompt_batch" && mode !== "fl2v";
    }

    isImageBatch() {
        const mode = this.getDirectorMode();
        return mode === "prompt_batch" || mode === "image_batch";
    }

    isGenBlank() {
        return this.getDirectorMode() === "gen_blank";
    }

    isGenImage() {
        return this.getDirectorMode() === "gen_image";
    }

    isFl2vMode() {
        return this.getDirectorMode() === "fl2v";
    }

    isR2vBatch() {
        return this.isImageBatch() && this.getTaskKey() === "r2v";
    }

    _syncR2vCardSelection() {
        if (!this.isR2vBatch() || !this.batchList) return;
        const runSelectOn = this.isRunSelectEnabled() && this.supportsRunSelect();
        const cards = this.batchList.querySelectorAll(".bd-batch-card");
        cards.forEach((el, i) => {
            const runOn = !runSelectOn || this.isSegmentRunEnabled(i);
            el.classList.toggle("selected", i === this.selectedIndex);
            el.classList.toggle("run-on", runSelectOn && runOn);
            el.classList.toggle("run-skipped", runSelectOn && !runOn);
            const cb = el.querySelector(".bd-batch-run-check");
            if (cb) cb.checked = runOn;
        });
        cards[this.selectedIndex]?.scrollIntoView?.({ block: "nearest" });
    }

    onTaskTypeChanged(value) {
        this.onGlobalField("taskType", value);
    }

    /** Snapshot v2v/rv2v workspace before switching to t2i / batch / gen modes. */
    _stashVideoWorkspace() {
        const video = this.timeline.video || {};
        const clips = this.timeline.videoClips || [];
        const hasVid = !!(
            clips.length
            || video.videoFile
            || video.fileName
            || this._legacyFrames?.length
            || video.frames?.length
        );
        const segs = this.timeline.segments || [];
        if (!hasVid && !segs.length) return;

        this.timeline.videoWorkspace = {
            segments: JSON.parse(JSON.stringify(segs)),
            selectedIndex: this.selectedIndex,
            currentFrame: this.currentFrame,
            editMode: this.timeline.editMode || "global",
            runSelectEnabled: !!this.timeline.runSelectEnabled,
            runSelection: Array.isArray(this.timeline.runSelection)
                ? [...this.timeline.runSelection]
                : undefined,
            video: JSON.parse(JSON.stringify(video)),
            videoClips: JSON.parse(JSON.stringify(clips)),
            totalFrames: this.timeline.totalFrames ?? this.getTotalFrames(),
            frameRate: this.timeline.frameRate ?? this.getFrameRate(),
            legacyFrames: this._legacyFrames?.length ? [...this._legacyFrames] : [],
            storageWidth: this._storageWidth || 0,
            storageHeight: this._storageHeight || 0,
        };
    }

    /** Restore v2v/rv2v workspace after returning from t2i / batch / gen. */
    _restoreVideoWorkspace() {
        const ws = this.timeline.videoWorkspace;
        if (!ws || typeof ws !== "object") {
            this.normalizeSegments();
            this.restoreVideoFromTimeline();
            this.updateStageVisibility();
            return false;
        }

        if (ws.video && typeof ws.video === "object") {
            this.timeline.video = JSON.parse(JSON.stringify(ws.video));
        }
        if (Array.isArray(ws.videoClips)) {
            this.timeline.videoClips = JSON.parse(JSON.stringify(ws.videoClips));
        }
        if (Array.isArray(ws.segments) && ws.segments.length) {
            this.timeline.segments = JSON.parse(JSON.stringify(ws.segments));
        }
        if (ws.totalFrames != null) this.timeline.totalFrames = ws.totalFrames;
        if (ws.frameRate != null) this.timeline.frameRate = ws.frameRate;
        if (ws.editMode) this.timeline.editMode = ws.editMode;
        if (ws.runSelectEnabled != null) this.timeline.runSelectEnabled = !!ws.runSelectEnabled;
        if (Array.isArray(ws.runSelection)) this.timeline.runSelection = [...ws.runSelection];

        this.selectedIndex = clamp(
            ws.selectedIndex ?? 0,
            0,
            Math.max(0, (this.timeline.segments?.length || 1) - 1),
        );
        this.currentFrame = Math.max(0, ws.currentFrame ?? 0);
        if (Array.isArray(ws.legacyFrames) && ws.legacyFrames.length) {
            this._legacyFrames = [...ws.legacyFrames];
        }
        if (ws.storageWidth) this._storageWidth = ws.storageWidth;
        if (ws.storageHeight) this._storageHeight = ws.storageHeight;

        this.normalizeSegments();
        this.restoreVideoFromTimeline();
        const total = this.getTotalFrames();
        this.currentFrame = clamp(this.currentFrame, 0, Math.max(0, total - 1));
        if (this.seekBar) {
            this.seekBar.max = Math.max(0, total - 1);
            this.seekBar.value = this.currentFrame;
        }
        if (this.totalFramesWidget) this.totalFramesWidget.value = total;
        this.updateVideoNameLabel();
        this.updateStageVisibility();
        // Live state is now in timeline.*; drop the snapshot so later edits
        // cannot be overwritten by a stale workspace on the next mode switch.
        this.timeline.videoWorkspace = null;
        return true;
    }

    /** Snapshot prompt-batch (r2v/r2i/…) groups before switching to video / gen. */
    _stashBatchWorkspace() {
        const segs = this.timeline.segments || [];
        if (!segs.length) return;
        // Only stash when current segments look like batch groups (have prompt/refs/fc).
        this.timeline.batchWorkspace = {
            segments: JSON.parse(JSON.stringify(segs)),
            selectedIndex: this.selectedIndex,
            editMode: this.timeline.editMode || "segment",
            runSelectEnabled: !!this.timeline.runSelectEnabled,
            runSelection: Array.isArray(this.timeline.runSelection)
                ? [...this.timeline.runSelection]
                : undefined,
            output: this.timeline.output
                ? JSON.parse(JSON.stringify(this.timeline.output))
                : undefined,
        };
    }

    /** Restore prompt-batch groups after returning from rv2v / video / gen. */
    _restoreBatchWorkspace() {
        const ws = this.timeline.batchWorkspace;
        if (!ws || typeof ws !== "object" || !Array.isArray(ws.segments) || !ws.segments.length) {
            return false;
        }
        this.timeline.segments = JSON.parse(JSON.stringify(ws.segments));
        if (ws.editMode) this.timeline.editMode = ws.editMode;
        if (ws.runSelectEnabled != null) this.timeline.runSelectEnabled = !!ws.runSelectEnabled;
        if (Array.isArray(ws.runSelection)) this.timeline.runSelection = [...ws.runSelection];
        if (ws.output && typeof ws.output === "object") {
            this.timeline.output = { ...(this.timeline.output || {}), ...JSON.parse(JSON.stringify(ws.output)) };
        }
        this.selectedIndex = clamp(
            ws.selectedIndex ?? 0,
            0,
            Math.max(0, this.timeline.segments.length - 1),
        );
        // Drop snapshot after restore so later batch edits are not clobbered by a stale stash.
        this.timeline.batchWorkspace = null;
        return true;
    }

    ensureGenTimeline() {
        const key = this.getTaskKey();
        this.timeline.gen = this.timeline.gen || {};
        const defFc = defaultFrameCount(key);
        if (!this.timeline.segments?.length || !sumFrameCounts(this.timeline.segments)) {
            this.timeline.segments = [{
                id: uid(), start: 0, length: defFc, frameCount: defFc,
                prompt: "", taskType: "", refs: [], genImage: { imageFile: "" },
            }];
        }
        for (const seg of this.timeline.segments) {
            if (seg.frameCount == null) seg.frameCount = seg.length ?? defFc;
            seg.genImage = seg.genImage || { imageFile: seg.imageFile || "" };
        }
        this.timeline.global = this.timeline.global || { refs: [] };
        this.timeline.global.genImage = this.timeline.global.genImage || { imageFile: "" };
        if (this.isGenBlank()) {
            this.timeline.output = this.timeline.output || {};
            this.timeline.output.mode = "fixed";
        }
        this.normalizeGenSegments();
    }

    normalizeGenSegments() {
        const key = this.getTaskKey();
        const minFc = minFrameCount(key);
        let start = 0;
        const fixed = [];
        for (const seg of [...this.timeline.segments]) {
            let fc = clamp(parseInt(seg.frameCount ?? seg.length, 10) || defaultFrameCount(key), minFc, MAX_GEN_FRAMES);
            fixed.push({
                ...seg,
                start,
                length: fc,
                frameCount: fc,
                refs: seg.refs || [],
                genImage: seg.genImage || { imageFile: "" },
            });
            start += fc;
        }
        if (!fixed.length) {
            const fc = defaultFrameCount(key);
            fixed.push({
                id: uid(), start: 0, length: fc, frameCount: fc,
                prompt: "", taskType: "", refs: [], genImage: { imageFile: "" },
            });
        }
        this.timeline.segments = fixed;
        this.timeline.totalFrames = start || fixed[0].frameCount;
        this.selectedIndex = clamp(this.selectedIndex, 0, fixed.length - 1);
    }

    updateReferenceImageVisibility({ hideTimeline = false, seg = null } = {}) {
        const globalKey = this.getTaskKey();
        const idirOn = !!this.timeline?.image_director?.enabled;
        const showGlobalRefs = !hideTimeline && (taskUsesReferenceImages(globalKey) || idirOn);
        const showGlobalRefAudios = !hideTimeline && taskUsesReferenceAudios(globalKey);
        const showGlobalRefVideo = !hideTimeline && taskUsesReferenceVideo(globalKey);

        this.globalRefsCol?.classList.toggle(
            "hidden",
            !showGlobalRefs && !showGlobalRefVideo && !showGlobalRefAudios,
        );
        this.globalRefsImagesWrap?.classList.toggle("hidden", !showGlobalRefs);
        this.globalRefAudiosWrap?.classList.toggle("hidden", !showGlobalRefAudios);
        this.globalRefVideoCol?.classList.toggle("hidden", !showGlobalRefVideo);
        if (this.globalPanelTitle) {
            if (showGlobalRefVideo) {
                this.globalPanelTitle.textContent = "全局提示词 & 参考视频";
            } else if (showGlobalRefs || showGlobalRefAudios) {
                this.globalPanelTitle.textContent = showGlobalRefAudios
                    ? "全局提示词 & 参考素材 (图片 / 音频)"
                    : "全局提示词 & 参考图 (图片1–9)";
            } else {
                this.globalPanelTitle.textContent = "全局提示词";
            }
        }

        const segKey = resolveTaskKey(
            seg?.taskType || this.timeline.global?.taskType || this.globalTask?.value || globalKey,
        );
        const showSegRefs = !hideTimeline && (taskUsesReferenceImages(segKey) || idirOn);
        const showSegRefAudios = !hideTimeline && taskUsesReferenceAudios(segKey);
        const showSegRefVideo = !hideTimeline && taskUsesReferenceVideo(segKey);
        this.segRefsCol?.classList.toggle(
            "hidden",
            !showSegRefs && !showSegRefVideo && !showSegRefAudios,
        );
        this.segRefsImagesWrap?.classList.toggle("hidden", !showSegRefs);
        this.segRefAudiosWrap?.classList.toggle("hidden", !showSegRefAudios);
        this.segRefVideoCol?.classList.toggle("hidden", !showSegRefVideo);
        const showContinuousRef = !hideTimeline
            && this.isGlobalMode()
            && showGlobalRefVideo
            && globalKey === "ads2v";
        this.continuousRefWrap?.classList.toggle("hidden", !showContinuousRef);
        if (this.continuousRefCb) {
            this.continuousRefCb.checked = !!this.timeline.global?.continuousReference;
        }
        if (showGlobalRefVideo || showSegRefVideo) this.renderRefVideoSlot();
        if (showGlobalRefAudios || showSegRefAudios) this.renderRefAudioSlots();
    }

    _stashFl2vWorkspace() {
        const shots = this.timeline.shots || [];
        const segs = this.timeline.segments || [];
        const keys = this.timeline.keyframes || [];
        if (!shots.length && !segs.length && !keys.length) return;
        this.timeline.fl2vWorkspace = {
            shots: JSON.parse(JSON.stringify(shots)),
            segments: JSON.parse(JSON.stringify(segs)),
            keyframes: JSON.parse(JSON.stringify(keys)),
            durationSec: this.timeline.durationSec,
            totalFrames: this.timeline.totalFrames,
            selectedIndex: this.selectedIndex,
            runSelectEnabled: !!this.timeline.runSelectEnabled,
            runSelection: Array.isArray(this.timeline.runSelection)
                ? [...this.timeline.runSelection]
                : [],
            output: this.timeline.output
                ? JSON.parse(JSON.stringify(this.timeline.output))
                : undefined,
        };
    }

    _restoreFl2vWorkspace() {
        const ws = this.timeline.fl2vWorkspace;
        if (!ws) return false;
        const hasShots = Array.isArray(ws.shots) && ws.shots.length;
        const hasSegs = Array.isArray(ws.segments) && ws.segments.length;
        const hasKeys = Array.isArray(ws.keyframes) && ws.keyframes.length;
        if (!hasShots && !hasSegs && !hasKeys) return false;
        if (hasShots) this.timeline.shots = JSON.parse(JSON.stringify(ws.shots));
        if (hasSegs) this.timeline.segments = JSON.parse(JSON.stringify(ws.segments));
        if (hasKeys) this.timeline.keyframes = JSON.parse(JSON.stringify(ws.keyframes));
        if (ws.durationSec != null) this.timeline.durationSec = ws.durationSec;
        if (ws.totalFrames != null) this.timeline.totalFrames = ws.totalFrames;
        if (ws.selectedIndex != null) this.selectedIndex = ws.selectedIndex;
        if (ws.runSelectEnabled != null) this.timeline.runSelectEnabled = !!ws.runSelectEnabled;
        if (Array.isArray(ws.runSelection)) this.timeline.runSelection = [...ws.runSelection];
        if (ws.output && typeof ws.output === "object") {
            this.timeline.output = { ...(this.timeline.output || {}), ...JSON.parse(JSON.stringify(ws.output)) };
        }
        this.timeline.fl2vWorkspace = null;
        return true;
    }

    applyTaskLayout(prevMode) {
        const mode = this.getDirectorMode();
        const prev = prevMode || "video";
        const wasBatch = prev === "prompt_batch" || prev === "image_batch";
        const isBatch = mode === "prompt_batch";
        const wasFl2v = prev === "fl2v";
        const isFl2v = mode === "fl2v";
        const wasGen = prev !== "video" && prev !== "prompt_batch" && prev !== "image_batch" && prev !== "fl2v";
        const isGen = mode !== "video" && mode !== "prompt_batch" && mode !== "fl2v";

        if (this.isPlaying) this._stopPlay();

        if (isFl2v) {
            if (prev === "video") {
                this._stashVideoWorkspace();
                this._clearLiveRunSelection();
            } else if (wasBatch) {
                this._stashBatchWorkspace();
                this._clearLiveRunSelection();
            }
            if (!this._restoreFl2vWorkspace()) {
                ensureFl2vTimeline(this);
                this._clearLiveRunSelection();
            } else {
                ensureFl2vTimeline(this);
            }
        } else if (isBatch) {
            if (!wasBatch) {
                if (wasFl2v) {
                    this._stashFl2vWorkspace();
                    this._clearLiveRunSelection();
                }
                // Keep v2v/rv2v video + segments so switching back can restore them.
                // Run-select is per workspace: stash video's, then clear live so i2v/batch
                // does not inherit「选择运行」from rv2v.
                if (prev === "video") {
                    this._stashVideoWorkspace();
                    this._clearLiveRunSelection();
                }
                // Prefer restoring the previous r2v/r2i/i2v batch (prompts + its own run-select).
                if (!this._restoreBatchWorkspace()) {
                    const keep = this.timeline.global?.prompt
                        || this.timeline.segments?.[0]?.prompt
                        || "";
                    const keepRefs = Array.isArray(this.timeline.global?.refs) && this.timeline.global.refs.length
                        ? JSON.parse(JSON.stringify(this.timeline.global.refs))
                        : [];
                    this.timeline.segments = [newBatchSegment({
                        prompt: keep,
                        negativePrompt: this.negativePromptWidget?.value || "bad video",
                        refs: keepRefs,
                    })];
                    this._clearLiveRunSelection();
                }
            }
            ensureImageBatchTimeline(this);
        } else if (isGen) {
            if (wasBatch) {
                this._stashBatchWorkspace();
                this._clearLiveRunSelection();
            }
            if (wasFl2v) {
                this._stashFl2vWorkspace();
                this._clearLiveRunSelection();
            }
            if (!wasGen && !wasBatch && !wasFl2v) {
                if (prev === "video") {
                    this._stashVideoWorkspace();
                    this._clearLiveRunSelection();
                }
                const key = this.getTaskKey();
                const defFc = defaultFrameCount(key);
                const keepPrompt = this.timeline.global?.prompt || "";
                this.timeline.segments = [{
                    id: uid(),
                    start: 0,
                    length: defFc,
                    frameCount: defFc,
                    prompt: keepPrompt,
                    taskType: "",
                    refs: [],
                    genImage: { imageFile: "" },
                }];
            }
            this.ensureGenTimeline();
        } else if (prev !== "video") {
            // Leaving batch/gen/fl2v for video — stash before video restore.
            if (wasBatch) {
                this._stashBatchWorkspace();
                this._clearLiveRunSelection();
            }
            if (wasFl2v) {
                this._stashFl2vWorkspace();
                this._clearLiveRunSelection();
            }
            this.timeline.timelineMode = "video";
            // Prefer restoring the stashed v2v/rv2v session (segments + thumbs + run-select).
            if (!this._restoreVideoWorkspace()) {
                this.normalizeSegments();
                this._clearLiveRunSelection();
            }
        }
        this.timeline.timelineMode = mode;
        this._directorMode = mode;

        const taskKey = this.getTaskKey();
        const isR2v = isBatch && taskKey === "r2v";
        // fl2v / r2v use the main timeline track; other batch + gen hide it.
        const hideTimeline = (isBatch && !isR2v) || isGen;
        const hideVideoUpload = hideTimeline || NO_VIDEO_UPLOAD_TASKS.has(taskKey) || isR2v;
        const showBatchExport = (isBatch && isVideoBatchTask(taskKey)) || isFl2v;
        // t2v / i2v / r2v: never show source-video upload (fl2v keeps "上传图片").
        this.btnVideo?.classList.toggle("hidden", (hideVideoUpload && !isFl2v) || isR2v);
        this.btnVideoAppend?.classList.toggle("hidden", hideVideoUpload || isFl2v || isR2v);
        this.controlsBar?.classList.toggle("hidden", !isFl2v && !isR2v && (hideTimeline || isBatch));
        this.boundsEl?.classList.toggle("hidden", !isFl2v && !isR2v && (hideTimeline || isBatch));
        this.timecodeEl?.classList.toggle("hidden", !isFl2v && !isR2v && (hideTimeline || isBatch));
        this.viewport?.classList.toggle("hidden", isBatch && !isR2v);
        this.updateStageVisibility();
        this.root.querySelector(".bd-split")?.classList.toggle("hidden", isBatch || isFl2v);
        this.batchPanel?.classList.toggle("hidden", !isBatch);
        this.fl2vUi?.root?.classList.toggle("hidden", !isFl2v);
        this.fl2vTotalWrap?.classList.toggle("hidden", !isFl2v);
        if (isFl2v) {
            setR2vToolbar(this, false);
            setFl2vToolbar(this, true);
            setToolbarDisabledForBatch(this, false);
            // Re-apply fl2v-specific disables after clearing batch disables.
            setFl2vToolbar(this, true);
        } else if (isR2v) {
            setFl2vToolbar(this, false);
            setToolbarDisabledForBatch(this, false);
            setR2vToolbar(this, true);
            if (this.btnVideo) this.btnVideo.textContent = "上传视频";
            updateFl2vToolbarBtns(this);
        } else {
            setFl2vToolbar(this, false);
            setR2vToolbar(this, false);
            setToolbarDisabledForBatch(this, isBatch);
            if (this.btnVideo) this.btnVideo.textContent = "上传视频";
            const del = this.root?.querySelector('[data-a="del"]');
            if (del) del.textContent = "删除片段";
            updateFl2vToolbarBtns(this);
            updateR2vToolbarBtns(this);
        }

        // Side ref panels stay hidden for all batch modes (refs live in cards).
        this.updateReferenceImageVisibility({ hideTimeline: isBatch || isGen });

        const showGenImg = mode === "gen_image";
        this.genGlobalImg?.classList.toggle("hidden", !showGenImg || !this.isGlobalMode());
        this.genSegImg?.classList.toggle("hidden", !showGenImg || this.isGlobalMode());
        this.genGlobalFcRow?.classList.toggle("hidden", !isGen || !this.isGlobalMode());
        this.genSegFcRow?.classList.toggle("hidden", !isGen || this.isGlobalMode());

        if (isBatch || isGen || isFl2v || NO_VIDEO_UPLOAD_TASKS.has(taskKey)) {
            this.timeline.output = this.timeline.output || {};
            this.timeline.output.mode = "fixed";
            if (isBatch && !isVideoBatchTask(taskKey)) this.timeline.output.exportMode = "all";
            if (!this.timeline.output.aspectRatio) this.timeline.output.aspectRatio = DEFAULT_ASPECT_RATIO;
            else this.timeline.output.aspectRatio = normalizeAspectRatioLabel(this.timeline.output.aspectRatio);
            if (this.timeline.output.megapixels == null) this.timeline.output.megapixels = DEFAULT_MEGAPIXELS;
            if (this.timeline.output.multiple == null) this.timeline.output.multiple = MINIMAX_CANVAS_MULTIPLE;
            if (isCustomAspectRatio(this.timeline.output.aspectRatio)) {
                this.applyCustomResolution();
            } else {
                this.applyResolutionSelector();
            }
            this.updateOutputModeUI();
        } else if (this.outMode) {
            this.outMode.disabled = false;
            this.updateOutputModeUI();
        }

        if (this.outHint) {
            const isVideoEdit = taskKey === "v2v" || taskKey === "rv2v";
            const showHint = isGen || isBatch || isFl2v || isVideoEdit;
            this.outHint.classList.toggle("hidden", !showHint);
            this.outHint.textContent = showHint ? genLayoutHint(this.getTaskKey()) : "";
        }
        const isVideoEditTask = taskKey === "v2v" || taskKey === "rv2v";
        this.outAudioWrap?.classList.toggle("hidden", !isVideoEditTask);
        if (this.outExportMode) {
            this.outExportMode.disabled = (isBatch || isFl2v) && !showBatchExport;
            this.outExportMode.classList.toggle("hidden", (isBatch || isFl2v) && !showBatchExport);
            this.outExportMode.previousElementSibling?.classList.toggle("hidden", (isBatch || isFl2v) && !showBatchExport);
        }
        if (this.outMaxFrames) {
            this.outMaxFrames.disabled = (isBatch || isFl2v) && !showBatchExport;
            this.outMaxFrames.classList.toggle("hidden", (isBatch || isFl2v) && !showBatchExport);
            this.outMaxFrames.previousElementSibling?.classList.toggle("hidden", (isBatch || isFl2v) && !showBatchExport);
        }

        if ((isGen || isBatch || isFl2v) && prev === "video") {
            this.currentFrame = 0;
        }
        this.updateSegmentContinuityUI();
        this.updateVideoNameLabel();
        if (isFl2v) {
            this.timeline.editMode = "segment";
            ensureFl2vTimeline(this);
            this.updateSelectionUI();
            updateFl2vDetailUI(this);
            this.updateVideoNameLabel();
        } else if (isBatch) {
            this.timeline.editMode = "segment";
            this.renderImageBatchGroups();
            if (isR2v) {
                this.updateSelectionUI();
                this._syncR2vCardSelection();
            }
        } else {
            this.updateModeUI();
            this.updateSelectionUI();
        }
        // t2v/t2i: hide 参考图导演; i2v/r2v/fl2v: show
        updateImageDirectorVisibility(this);
        syncLocalDirectorForTask(this);
        this.updateDomWidgetHeight();
        this.syncOutputUIFromTimeline();
        this.seekBar.max = Math.max(0, this.getTotalFrames() - 1);
        if (!isBatch || isR2v) this.scheduleRender();
        this.scheduleTimelineSync();
        this.updateRunSelectUI();
    }

    renderGenSrcSlot(el, imageFile, label) {
        if (!el) return;
        el.classList.toggle("has-img", !!imageFile);
        if (imageFile) {
            el.innerHTML = `<img src="${refViewUrl(imageFile)}" alt="">`;
        } else {
            el.textContent = label;
        }
    }

    _paintRefVideoSlot(el, nameEl, refBlock) {
        if (!el) return;
        const ref = refBlock || {};
        const has = !!(ref.videoFile || ref.fileName);
        el.classList.toggle("has-img", false);
        el.classList.toggle("has-video", has);
        if (nameEl) {
            if (has) {
                const dur = ref.duration > 0 ? ` · ${ref.duration.toFixed(2)}s` : "";
                const fps = ref.nativeFps > 0 ? ` · ${Math.round(ref.nativeFps)}fps` : "";
                const dim = ref.width && ref.height ? ` · ${ref.width}×${ref.height}` : "";
                nameEl.textContent = `${ref.fileName || ref.videoFile || ""}${dim}${dur}${fps}`;
            } else {
                nameEl.textContent = "";
            }
        }
        if (!has) {
            el.innerHTML = "";
            el.textContent = "点击上传参考视频";
            el.onclick = () => this.pickReferenceVideoFile();
            return;
        }
        const viewUrl = this.getReferenceVideoViewUrl(ref);
        el.innerHTML = `
            <video class="bd-ref-video-preview" muted playsinline preload="metadata" controls></video>
            <button type="button" class="bd-ref-replace" title="更换参考视频">更换</button>
            <span class="x" title="移除参考视频">×</span>`;
        el.onclick = null;
        const video = el.querySelector("video");
        if (video && viewUrl) {
            video.src = viewUrl;
            video.addEventListener("click", (e) => e.stopPropagation());
            video.addEventListener("dblclick", (e) => {
                e.stopPropagation();
                if (video.paused) video.play().catch(() => {});
                else video.pause();
            });
        }
        const replaceBtn = el.querySelector(".bd-ref-replace");
        if (replaceBtn) {
            replaceBtn.onclick = (e) => {
                e.stopPropagation();
                this.pickReferenceVideoFile();
            };
        }
        const removeBtn = el.querySelector(".x");
        if (removeBtn) {
            removeBtn.onclick = (e) => {
                e.stopPropagation();
                this.clearReferenceVideo();
            };
        }
    }

    renderRefVideoSlot() {
        if (this.isGlobalMode()) {
            this._stopRefVideoPreviews([this.segRefVideo]);
            this._paintRefVideoSlot(
                this.globalRefVideo,
                this.globalRefVideoNameEl,
                this.timeline.global?.referenceVideo || {},
            );
        } else {
            this._stopRefVideoPreviews([this.globalRefVideo]);
            const seg = this.timeline.segments[this.selectedIndex];
            this._paintRefVideoSlot(this.segRefVideo, this.segRefVideoNameEl, seg?.referenceVideo || {});
        }
    }

    _activeRefVideoTaskKey() {
        if (this.isGlobalMode()) return this.getTaskKey();
        const seg = this.timeline.segments[this.selectedIndex];
        return resolveTaskKey(seg?.taskType || this.timeline.global?.taskType || this.getTaskKey());
    }

    pickReferenceVideoFile() {
        if (!taskUsesReferenceVideo(this._activeRefVideoTaskKey())) return;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "video/*";
        input.onchange = () => {
            if (input.files?.[0]) this.loadReferenceVideoFile(input.files[0]);
        };
        input.click();
    }

    clearReferenceVideo() {
        const target = this.getRefVideoTarget();
        this._stopRefVideoPreviews();
        target.referenceVideo = {};
        this.renderRefVideoSlot();
        this.commit();
    }

    async loadReferenceVideoFile(file) {
        const slotEl = this.isGlobalMode() ? this.globalRefVideo : this.segRefVideo;
        const nameEl = this.isGlobalMode() ? this.globalRefVideoNameEl : this.segRefVideoNameEl;
        const status = `上传中: ${file.name}…`;
        if (slotEl) {
            slotEl.classList.remove("has-img", "has-video");
            slotEl.textContent = status;
        }
        if (nameEl) nameEl.textContent = status;
        try {
            const uploaded = await uploadToInputSmart(file, (frac, cur, total) => {
                const pct = Math.round(frac * 100);
                const mode = file.size > COMFY_UPLOAD_SOFT_LIMIT ? "分块" : "上传";
                if (nameEl) nameEl.textContent = `${mode}参考视频: ${file.name} (${cur}/${total}, ${pct}%)…`;
            });
            const relPath = videoRelativePath(uploaded);
            const prep = await this._prepareVideoFrames({
                fileName: file.name,
                relPath,
                subfolder: uploaded.subfolder || "",
                type: uploaded.type || "input",
                statusPrefix: "解析参考视频",
                syncNativeFps: false,
            });
            this.getRefVideoTarget().referenceVideo = this._buildClipRecord(prep);
            this.renderRefVideoSlot();
            this.commit(false, { syncTimeline: true });
        } catch (err) {
            console.error("[MiniMax H3Director] reference video load failed:", err);
            if (nameEl) nameEl.textContent = `参考视频加载失败: ${formatUploadError(err)}`;
            this.renderRefVideoSlot();
        }
    }

    pickGenSrcImage(isGlobal) {
        if (!this.isGenImage()) return;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.onchange = async () => {
            const file = input.files?.[0];
            if (!file) return;
            try {
                const uploaded = await uploadToInput(file);
                const relPath = videoRelativePath(uploaded);
                if (isGlobal) {
                    this.timeline.global = this.timeline.global || { refs: [] };
                    this.timeline.global.genImage = { imageFile: relPath };
                } else {
                    const seg = this.timeline.segments[this.selectedIndex];
                    if (seg) {
                        seg.genImage = { imageFile: relPath };
                        seg.imageFile = relPath;
                    }
                }
                this.commit();
            } catch (err) {
                console.error("[MiniMax H3Director] gen image upload failed:", err);
            }
        };
        input.click();
    }

    onGenDefaultFcChange() {
        const fc = clamp(parseInt(this.genDefaultFc?.value, 10) || 1, minFrameCount(this.getTaskKey()), MAX_GEN_FRAMES);
        if (this.genDefaultFc) this.genDefaultFc.value = fc;
        this.timeline.gen = this.timeline.gen || {};
        this.timeline.gen.defaultFrameCount = fc;
        if (this.timeline.segments.length === 1) {
            this.timeline.segments[0].frameCount = fc;
            this.timeline.segments[0].length = fc;
        }
        this.commit();
    }

    onGenSegFcChange() {
        const seg = this.timeline.segments[this.selectedIndex];
        if (!seg) return;
        const minFc = minFrameCount(this.getTaskKey());
        seg.frameCount = clamp(parseInt(this.genSegFc?.value, 10) || minFc, minFc, MAX_GEN_FRAMES);
        if (this.genSegFc) this.genSegFc.value = seg.frameCount;
        this.commit();
    }

    genSplitAtFrame(frame) {
        const total = this.getTotalFrames();
        const minFc = minFrameCount(this.getTaskKey());
        if (frame <= minFc || frame >= total - minFc) return;
        const newSegs = [];
        let cursor = 0;
        for (const seg of this.timeline.segments) {
            const fc = seg.frameCount ?? seg.length;
            const end = cursor + fc;
            if (frame > cursor && frame < end) {
                const left = frame - cursor;
                const right = end - frame;
                newSegs.push({ ...seg, frameCount: left, length: left });
                newSegs.push({
                    id: uid(), start: frame, frameCount: right, length: right,
                    prompt: "", taskType: "", refs: [], genImage: { imageFile: "" },
                });
            } else {
                newSegs.push({ ...seg });
            }
            cursor = end;
        }
        this.timeline.segments = newSegs;
        this.commit();
    }

    genEqualSplit() {
        const n = parseInt(this.equalCountInput?.value || "2", 10);
        if (!n || n < 2) return;
        const total = this.getTotalFrames();
        const minFc = minFrameCount(this.getTaskKey());
        const count = clamp(n, 2, Math.max(2, Math.floor(total / minFc)));
        const base = Math.floor(total / count);
        let rem = total - base * count;
        this.timeline.segments = Array.from({ length: count }, () => {
            const fc = base + (rem > 0 ? 1 : 0);
            if (rem > 0) rem -= 1;
            return {
                id: uid(), frameCount: fc, length: fc, prompt: "", taskType: "", refs: [],
                genImage: { imageFile: "" },
            };
        });
        this.commit();
    }

    genDeleteSelectedSegment() {
        if (this.timeline.segments.length <= 1) return;
        this.timeline.segments.splice(this.selectedIndex, 1);
        this.selectedIndex = clamp(this.selectedIndex, 0, this.timeline.segments.length - 1);
        this.commit();
    }

    updateVideoNameLabel() {
        if (this.isFl2vMode()) {
            const shots = this.timeline.shots || [];
            const n = shots.length;
            const total = this.getTotalFrames();
            const withEnd = shots.filter((s) => s.endImage?.imageFile).length;
            const withStart = shots.filter((s) => s.startImage?.imageFile).length;
            if (!n) {
                this.videoNameEl.textContent = `未添加组 · ${getFl2vTotalDurationSec(this)}s (${total}f)`;
            } else {
                this.videoNameEl.textContent = `${n} 组 · ${withStart} 首帧 · ${withEnd} 尾帧 · ${getFl2vTotalDurationSec(this)}s (${total}f)`;
            }
            return;
        }
        if (this.isImageBatch()) {
            const n = this.timeline.segments?.length || 0;
            const key = this.getTaskKey();
            if (isVideoBatchTask(key)) {
                const total = this.getTotalFrames();
                const segs = this.timeline.segments || [];
                const sec = Math.round(segs.reduce((s, seg) => {
                    const v = Number(seg.durationSec);
                    return s + (Number.isFinite(v) ? v : 0);
                }, 0) * 100) / 100;
                this.videoNameEl.textContent = total
                    ? `${key} · ${n} 组提示词 · ${sec || framesToDurationSec(total, this.getFrameRate())}s (${total}f)`
                    : `${key} · ${n} 组提示词 · 视频输出`;
            } else {
                this.videoNameEl.textContent = `${key} · ${n} 组提示词 · 单帧输出`;
            }
            return;
        }
        if (this.isGenMode()) {
            const total = this.getTotalFrames();
            const key = this.getTaskKey();
            if (this.isGenBlank()) {
                this.videoNameEl.textContent = total ? `空白画布 · ${total}f` : "空白画布 · 请设置片段帧数";
            } else {
                this.videoNameEl.textContent = total ? `${key} · ${total}f` : `${key} · 请上传源图片`;
            }
            return;
        }
        const clips = this.getVideoClips();
        const total = this.getTotalFrames();
        if (!clips.length || !total) {
            this.videoNameEl.textContent = "未上传视频";
            return;
        }
        if (clips.length === 1) {
            const c = clips[0];
            const dim = c.storageWidth && c.storageHeight
                ? ` · ${c.storageWidth}×${c.storageHeight}`
                : (this._storageWidth && this._storageHeight ? ` · ${this._storageWidth}×${this._storageHeight}` : "");
            const nativeHint = c.nativeFps > 0 ? ` · 源${formatProbeFps(c.nativeFps)}fps` : "";
            const tlFps = this.getFrameRate();
            const dur = this.getTimelineDurationSec().toFixed(2);
            this.videoNameEl.textContent = `${c.fileName || c.videoFile} (${total}f · 时间轴${formatProbeFps(tlFps)}fps · ${dur}s${nativeHint}${dim})`;
            return;
        }
        const tlFps = this.getFrameRate();
        const dur = this.getTimelineDurationSec().toFixed(2);
        this.videoNameEl.textContent = `${clips.length} 段视频 · 共 ${total} 帧 · 时间轴${formatProbeFps(tlFps)}fps · ${dur}s`;
    }

    getFrameMapEntry(logicalFrame) {
        const map = this.getFrameMap();
        if (map.length) return normalizeFrameMapEntry(map[clamp(logicalFrame, 0, map.length - 1)]);
        return { clip: 0, frame: logicalToSourceFrame(logicalFrame, this.timeline.video || {}) };
    }

    getSegmentClipIndex(seg) {
        return this.getFrameMapEntry(seg.start).clip;
    }

    getClipBoundaries() {
        const map = this.getFrameMap();
        const boundaries = [];
        for (let i = 1; i < map.length; i++) {
            const a = normalizeFrameMapEntry(map[i - 1]);
            const b = normalizeFrameMapEntry(map[i]);
            if (b.clip !== a.clip) boundaries.push(i);
        }
        return boundaries;
    }

    _segmentMetaAtFrame(frame) {
        const segs = [...this.timeline.segments].sort((a, b) => a.start - b.start);
        for (const seg of segs) {
            if (frame >= seg.start && frame < seg.start + seg.length) {
                return {
                    prompt: seg.prompt || "",
                    taskType: seg.taskType || "",
                    refs: seg.refs ? JSON.parse(JSON.stringify(seg.refs)) : [],
                };
            }
        }
        const last = segs[segs.length - 1];
        if (last) {
            return {
                prompt: last.prompt || "",
                taskType: last.taskType || "",
                refs: last.refs ? JSON.parse(JSON.stringify(last.refs)) : [],
            };
        }
        return { prompt: "", taskType: "", refs: [] };
    }

    _buildSegmentsFromSplitPoints(points, forcedPoints = null) {
        const forced = new Set(forcedPoints || []);
        forced.add(0);
        const sorted = [...new Set(points)].sort((a, b) => a - b);
        forced.add(sorted[sorted.length - 1]);
        const newSegs = [];
        for (let i = 0; i < sorted.length - 1; i++) {
            const start = sorted[i];
            const length = sorted[i + 1] - start;
            const endsForced = forced.has(sorted[i + 1]);
            const startsForced = forced.has(start);
            if (length < MIN_SEG && !endsForced && !startsForced) continue;
            if (length < 1) continue;
            const meta = this._segmentMetaAtFrame(start);
            newSegs.push({
                id: uid(),
                start,
                length,
                prompt: meta.prompt,
                taskType: meta.taskType,
                refs: meta.refs,
            });
        }
        if (!newSegs.length) return null;
        let cursor = 0;
        return newSegs.map((seg) => {
            const s = { ...seg, start: cursor, length: seg.length };
            cursor += s.length;
            return s;
        });
    }

    _getReorderInsertFrame(dropRank, fromRank) {
        const ordered = [...this.timeline.segments].sort((a, b) => a.start - b.start);
        const lengths = ordered.map((s) => s.length);
        const without = lengths.filter((_, i) => i !== fromRank);
        let frame = 0;
        for (let i = 0; i < dropRank && i < without.length; i++) frame += without[i];
        return frame;
    }

    _orderedSegmentsWithRank() {
        return [...this.timeline.segments]
            .map((seg, arrayIndex) => ({ seg, arrayIndex }))
            .sort((a, b) => a.seg.start - b.seg.start)
            .map((item, visualRank) => ({ ...item, visualRank }));
    }

    _visualRankFromArrayIndex(arrayIndex) {
        const ordered = this._orderedSegmentsWithRank();
        return ordered.find((o) => o.arrayIndex === arrayIndex)?.visualRank ?? arrayIndex;
    }

    _computeReorderDropRank(frame, fromRank) {
        const ordered = this._orderedSegmentsWithRank();
        if (!ordered.length) return fromRank;

        // fl2v: swap slots — drop target = the clip currently under the pointer.
        if (this.isFl2vMode()) {
            for (const item of ordered) {
                const lo = item.seg.start;
                const hi = item.seg.start + item.seg.length;
                if (frame >= lo && frame < hi) return item.visualRank;
            }
            // In a gap / past the end: snap to nearest clip by center distance.
            let best = fromRank;
            let bestDist = Infinity;
            for (const item of ordered) {
                const mid = item.seg.start + item.seg.length / 2;
                const d = Math.abs(frame - mid);
                if (d < bestDist) {
                    bestDist = d;
                    best = item.visualRank;
                }
            }
            return best;
        }

        // Video / gen: insert-before semantics (skip the dragged clip).
        for (const item of ordered) {
            if (item.visualRank === fromRank) continue;
            const mid = item.seg.start + item.seg.length / 2;
            if (frame < mid) return item.visualRank;
        }
        return ordered.length - 1;
    }

    reorderSegmentsByRank(fromRank, toRank) {
        const ordered = [...this.timeline.segments]
            .map((seg) => ({ seg }))
            .sort((a, b) => a.seg.start - b.seg.start);
        if (fromRank < 0 || fromRank >= ordered.length) return;
        if (toRank < 0 || toRank >= ordered.length) return;
        if (fromRank === toRank) return;

        // fl2v: reorder shots[] (source of truth), then rebuild segments.
        if (this.isFl2vMode()) {
            const shots = [...(this.timeline.shots || [])];
            if (fromRank < 0 || fromRank >= shots.length) return;
            if (toRank < 0 || toRank >= shots.length) return;
            const [moved] = shots.splice(fromRank, 1);
            let insertRank = toRank;
            if (insertRank > fromRank) insertRank -= 1;
            shots.splice(insertRank, 0, moved);
            this.timeline.shots = shots;
            syncFl2vFromShots(this);
            this.selectedIndex = insertRank;
            updateFl2vDetailUI(this);
            this.updateVideoNameLabel();
            return;
        }
        // r2v: move whole groups (duration + refs) then renumber starts.
        if (this.isR2vBatch()) {
            const metas = ordered.map((o) => ({
                ...o.seg,
                refs: o.seg.refs ? JSON.parse(JSON.stringify(o.seg.refs)) : [],
                refAudios: o.seg.refAudios ? JSON.parse(JSON.stringify(o.seg.refAudios)) : [],
                refVideos: o.seg.refVideos ? JSON.parse(JSON.stringify(o.seg.refVideos)) : [],
            }));
            const [mMeta] = metas.splice(fromRank, 1);
            let insertRank = toRank;
            if (insertRank > fromRank) insertRank -= 1;
            metas.splice(insertRank, 0, mMeta);
            this.timeline.segments = metas;
            normalizeImageBatchSegments(this);
            this.selectedIndex = insertRank;
            this.updateVideoNameLabel();
            return;
        }
        // gen: no video frameMap — reorder by segment metadata only.
        if (this.isGenMode()) {
            const metas = ordered.map((o) => ({
                ...o.seg,
                refs: o.seg.refs ? JSON.parse(JSON.stringify(o.seg.refs)) : [],
            }));
            const slots = ordered.map((o) => ({
                start: o.seg.start,
                length: o.seg.length || o.seg.frameCount || minFrameCount(this.getTaskKey()),
            }));
            const [mMeta] = metas.splice(fromRank, 1);
            let insertRank = toRank;
            if (insertRank > fromRank) insertRank -= 1;
            metas.splice(insertRank, 0, mMeta);
            for (let i = 0; i < metas.length; i++) {
                const slot = slots[i] || slots[slots.length - 1];
                metas[i].start = slot.start;
                metas[i].length = slot.length;
                metas[i].frameCount = slot.length;
            }
            this.timeline.segments = metas;
            this.normalizeGenSegments();
            this.selectedIndex = insertRank;
            this.updateVideoNameLabel();
            return;
        }

        if (!this.getFrameMap().length && this.getTotalFrames() > 0) {
            this.materializeFrameMap();
        }
        const map = [...this.getFrameMap()];
        const slices = ordered.map((o) => map.slice(o.seg.start, o.seg.start + o.seg.length));
        const metas = ordered.map((o) => ({
            ...o.seg,
            refs: o.seg.refs ? JSON.parse(JSON.stringify(o.seg.refs)) : [],
        }));

        const [mSlice] = slices.splice(fromRank, 1);
        const [mMeta] = metas.splice(fromRank, 1);
        let insertRank = toRank;
        if (insertRank > fromRank) insertRank -= 1;
        slices.splice(insertRank, 0, mSlice);
        metas.splice(insertRank, 0, mMeta);

        const newMap = slices.flat();
        let start = 0;
        const newSegs = metas.map((seg, idx) => {
            const s = { ...seg, start, length: slices[idx].length };
            start += s.length;
            return s;
        });

        this.setFrameMap(newMap);
        this.timeline.segments = newSegs;
        this._syncPrimaryVideoFromClips(newMap);
        this._thumbCache.clear();
        this._thumbPending.clear();
        this.selectedIndex = insertRank;
        this._prefetchSegmentThumbs(0, Math.min(newMap.length, THUMB_PREFETCH_BATCH * 4));
    }

    materializeFrameMap() {
        const total = this.getTotalFrames();
        const video = this.timeline.video || {};
        if (video.frameMap?.length === total) return;
        const map = [];
        for (let i = 0; i < total; i++) map.push(this.getFrameMapEntry(i));
        video.frameMap = map;
        video.deletedSourceRanges = [];
        this.timeline.video = video;
        this.timeline.totalFrames = total;
    }

    getFrameMap() {
        const v = this.timeline?.video || {};
        if (v.frameMap?.length) return v.frameMap;
        if (this._legacyFrames.length) return buildIdentityFrameMap(this._legacyFrames.length);
        if (v.frames?.length) return buildIdentityFrameMap(v.frames.length);
        return [];
    }

    setFrameMap(map) {
        this.timeline.video = this.timeline.video || {};
        this.timeline.video.frameMap = map;
        if (map.length) {
            this.timeline.totalFrames = map.length;
            this.timeline.video.deletedSourceRanges = [];
        }
    }

    setSparseVideoFrames(totalFrames) {
        this.timeline.video = this.timeline.video || {};
        this.timeline.video.frameMap = [];
        this.timeline.video.sourceFrameCount = totalFrames;
        this.timeline.video.deletedSourceRanges = [];
        this.timeline.totalFrames = totalFrames;
    }

    logicalToSourceFrame(logical) {
        return logicalToSourceFrame(logical, this.timeline.video || {});
    }

    getTotalFrames() {
        // fl2v: visual canvas may be longer than the sampling window (overflow = dashed).
        if (this.isFl2vMode()) return getFl2vVisualFrames(this);
        if (this.isImageBatch() || this.isGenMode()) {
            return sumFrameCounts(this._previewSegments || this.timeline.segments);
        }
        const mapLen = this.timeline?.video?.frameMap?.length || 0;
        if (mapLen > 0) return mapLen;
        // Sparse deletes: sourceFrameCount − ranges beats a stale totalFrames.
        const src = parseInt(this.timeline?.video?.sourceFrameCount || 0, 10);
        if (src > 0) {
            const removed = deletedSourceRanges(this.timeline.video).reduce((s, [a, b]) => s + (b - a), 0);
            return Math.max(0, src - removed);
        }
        const total = Math.max(0, parseInt(this.timeline?.totalFrames || this.totalFramesWidget?.value || 0, 10));
        if (total > 0) return total;
        if (!this.hasVideo()) return 0;
        return 0;
    }

    getMaxExportFrames() {
        const n = parseInt(this.timeline.output?.maxExportFrames ?? 0, 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    getExportFrameTotal() {
        const total = this.getTotalFrames();
        const cap = this.getMaxExportFrames();
        return cap > 0 ? Math.min(total, cap) : total;
    }

    getFrameRate() {
        return coerceTimelineFps(this.fpsInput?.value ?? this.frameRateWidget?.value ?? this.timeline.frameRate ?? 24);
    }

    syncFrameRateUI(value = null) {
        const fps = coerceTimelineFps(value ?? this.fpsInput?.value ?? this.frameRateWidget?.value ?? this.timeline.frameRate ?? 24);
        this.timeline.frameRate = fps;
        if (this.frameRateWidget) this.frameRateWidget.value = fps;
        if (this.fpsInput) this.fpsInput.value = fps;
        return fps;
    }

    _clipFrameCountAtFps(clip, fps, fallback = 0) {
        const nativeFps = Number(clip?.nativeFps || 0);
        const nativeCount = Number(clip?.nativeFrameCount || 0);
        if (nativeFps > 0 && nativeCount > 0) {
            return Math.max(1, Math.round((nativeCount / nativeFps) * fps));
        }
        const duration = Number(clip?.duration || 0);
        if (duration > 0) return Math.max(1, Math.round(duration * fps));
        return Math.max(1, Math.round(fallback || Number(clip?.sourceFrameCount || 0) || 1));
    }

    _timelineFrameCountAtFps(fps, oldFps = null, oldTotal = null) {
        const nextFps = coerceTimelineFps(fps);
        const prevTotal = Number(oldTotal ?? this.getTotalFrames() ?? 0);
        const prevFps = coerceTimelineFps(oldFps ?? this.timeline.frameRate ?? this.frameRateWidget?.value ?? 24);
        // When user changes timeline FPS, preserve wall-clock duration: T = N/fps → N' = T * fps'.
        if (prevTotal > 0 && oldFps != null && Math.abs(prevFps - nextFps) >= 0.001) {
            return Math.max(1, Math.round(prevTotal * nextFps / prevFps));
        }
        const clips = this.getVideoClips();
        if (clips.length && clips.some((c) => Number(c.duration || 0) > 0 || Number(c.nativeFrameCount || 0) > 0)) {
            return clips.reduce((sum, clip) => sum + this._clipFrameCountAtFps(clip, nextFps), 0);
        }
        if (prevTotal > 0) {
            return Math.max(1, Math.round(prevTotal * nextFps / Math.max(prevFps, 0.001)));
        }
        return 1;
    }

    _rescaleSegmentsForTotal(oldTotal, newTotal) {
        if (!oldTotal || !newTotal || !this.timeline.segments?.length) {
            this._setSingleSegment(newTotal);
            return;
        }
        const ordered = [...this.timeline.segments].sort((a, b) => a.start - b.start);
        let cursor = 0;
        this.timeline.segments = ordered.map((seg, idx) => {
            const rawStart = idx === 0 ? 0 : Math.round((seg.start / oldTotal) * newTotal);
            const rawEnd = idx === ordered.length - 1
                ? newTotal
                : Math.round(((seg.start + seg.length) / oldTotal) * newTotal);
            const start = clamp(rawStart, cursor, newTotal);
            const end = clamp(rawEnd, start + 1, newTotal);
            cursor = end;
            return {
                ...seg,
                start,
                length: Math.max(1, end - start),
                frameCount: Math.max(1, end - start),
            };
        });
    }

    _syncClipFrameCountsForFps(fps, oldFps = null) {
        const clips = this.getVideoClips();
        if (!clips.length) return;
        const prevFps = coerceTimelineFps(oldFps ?? this.timeline.frameRate ?? 24);
        this.timeline.videoClips = clips.map((clip) => {
            const fallback = Number(clip.sourceFrameCount || 0) * fps / Math.max(prevFps, 0.001);
            return { ...clip, sourceFrameCount: this._clipFrameCountAtFps(clip, fps, fallback) };
        });
    }

    _resampleFrameMapForFps(oldFps, newFps, newTotal) {
        const oldTotal = this.getTotalFrames();
        if (!oldTotal || !newTotal) return [];
        const oldEntries = Array.from({ length: oldTotal }, (_, i) => this.getFrameMapEntry(i));
        const clips = this.getVideoClips();
        const map = [];
        for (let i = 0; i < newTotal; i++) {
            const oldLogical = clamp(Math.round((i / newFps) * oldFps), 0, oldTotal - 1);
            const entry = normalizeFrameMapEntry(oldEntries[oldLogical]);
            const clip = clips[entry.clip] || clips[0] || {};
            const maxFrame = this._clipFrameCountAtFps(clip, newFps) - 1;
            const sourceTime = Number(entry.frame || 0) / Math.max(oldFps, 0.001);
            map.push({
                clip: entry.clip,
                frame: clamp(Math.round(sourceTime * newFps), 0, Math.max(0, maxFrame)),
            });
        }
        return map;
    }

    _resampleTimelineForFrameRate(oldFps, newFps) {
        if (this.isImageBatch() || this.isGenMode() || !this.hasVideo()) return;
        const oldTotal = this.getTotalFrames();
        const newTotal = this._timelineFrameCountAtFps(newFps, oldFps, oldTotal);
        const hasExplicitMap = this.getFrameMap().length > 0;
        const hasSparseDeletes = deletedSourceRanges(this.timeline.video || {}).length > 0;

        if (hasExplicitMap || hasSparseDeletes || this.getVideoClips().length > 1) {
            const newMap = this._resampleFrameMapForFps(oldFps, newFps, newTotal);
            this.setFrameMap(newMap);
            this._syncClipFrameCountsForFps(newFps, oldFps);
            this._syncPrimaryVideoFromClips(newMap);
        } else {
            this._syncClipFrameCountsForFps(newFps, oldFps);
            this.setSparseVideoFrames(newTotal);
            this._syncPrimaryVideoFromClips([]);
        }

        this._rescaleSegmentsForTotal(oldTotal, newTotal);
        this.currentFrame = clamp(Math.round((this.currentFrame / Math.max(oldTotal, 1)) * newTotal), 0, Math.max(0, newTotal - 1));
        if (this.totalFramesWidget) this.totalFramesWidget.value = newTotal;
        if (this.seekBar) {
            this.seekBar.max = Math.max(0, newTotal - 1);
            this.seekBar.value = this.currentFrame;
        }
        this._thumbCache.clear();
        this._thumbPending.clear();
    }

    onFrameRateChanged(value) {
        const oldFps = coerceTimelineFps(this.timeline.frameRate ?? this.frameRateWidget?.value ?? 24);
        const newFps = this.syncFrameRateUI(value);
        if (Math.abs(oldFps - newFps) < 0.001) {
            this.commit(false, { syncTimeline: true });
            return;
        }
        this._resampleTimelineForFrameRate(oldFps, newFps);
        this.updateVideoNameLabel();
        this.updateOutputPreview();
        this.scheduleRender();
        this.commit(false, { syncTimeline: true });
    }

    getTimelineDurationSec() {
        if (this.isFl2vMode()) return getFl2vTotalDurationSec(this);
        const total = this.getTotalFrames();
        const fps = this.getFrameRate();
        return total / Math.max(fps, 0.001);
    }

    isGlobalMode() { return (this.timeline.editMode || "global") === "global"; }

    setEditMode(mode) {
        this.timeline.editMode = mode;
        this.root.querySelector('[data-a="mode-global"]').classList.toggle("active", mode === "global");
        this.root.querySelector('[data-a="mode-segment"]').classList.toggle("active", mode === "segment");
        this.updateModeUI();
        this.commit();
    }

    updateModeUI() {
        const global = this.isGlobalMode();
        this.globalPanel.style.display = global ? "flex" : "none";
        this.segmentPanel.style.display = global ? "none" : "flex";
        this.updateReferenceImageVisibility({
            hideTimeline: this.isImageBatch() || this.isGenMode(),
            seg: global ? null : this.timeline.segments[this.selectedIndex],
        });
        if (!global) this.updateSelectionUI();
        else if (taskUsesReferenceVideo(this.getTaskKey())) this.renderRefVideoSlot();
    }

    getRefTarget() {
        if (this.isGlobalMode()) return this.timeline.global;
        const seg = this.timeline.segments[this.selectedIndex];
        return seg || this.timeline.global;
    }

    getDisplayPrompt(seg) {
        if (this.isGlobalMode()) return this.timeline.global?.prompt || "";
        return seg?.prompt || "";
    }

    populateTaskSelect(el, selected) {
        if (!el) return;
        const opts = this.taskTypeWidget?.options?.values || [];
        el.innerHTML = "";
        for (const v of opts) {
            const o = document.createElement("option");
            o.value = v; o.textContent = v;
            el.appendChild(o);
        }
        if (selected) el.value = selected;
    }

    getI2iSourceDimensions() {
        for (const seg of this.timeline.segments || []) {
            const gi = seg.genImage || {};
            const w = +(gi.width || 0);
            const h = +(gi.height || 0);
            if (w > 0 && h > 0) return { width: w, height: h };
        }
        const out = this.timeline.output || {};
        if (+(out.sourceWidth || 0) > 0 && +(out.sourceHeight || 0) > 0) {
            return { width: +out.sourceWidth, height: +out.sourceHeight };
        }
        return { width: 0, height: 0 };
    }

    getSourceDimensions() {
        const clips = this.getVideoClips?.() || [];
        const video = clips[0] || this.timeline.video || {};
        if (+(video.width || 0) > 0 && +(video.height || 0) > 0) {
            return { width: +video.width, height: +video.height };
        }
        return {
            width: this.timeline.width || this.widthWidget?.value || 864,
            height: this.timeline.height || this.heightWidget?.value || 480,
        };
    }

    _refreshVideoStorageDimensions(resolved) {
        if (!resolved?.width || !resolved?.height) return;
        this._storageWidth = resolved.width;
        this._storageHeight = resolved.height;
        if (this.timeline.video) {
            this.timeline.video.storageWidth = resolved.width;
            this.timeline.video.storageHeight = resolved.height;
        }
        for (const clip of this.getVideoClips()) {
            clip.storageWidth = resolved.width;
            clip.storageHeight = resolved.height;
        }
    }

    syncOutputUIFromTimeline() {
        const out = this.timeline.output || {
            mode: "fixed",
            aspectRatio: DEFAULT_ASPECT_RATIO,
            megapixels: DEFAULT_MEGAPIXELS,
            multiple: MINIMAX_CANVAS_MULTIPLE,
            longEdge: 864, width: 864, height: 480,
            maxExportFrames: 0, exportMode: "all",
            audioMode: "generate",
            continuityEnabled: false, continuityOverlapFrames: 9,
        };
        // Prefer ResolutionSelector fields; backfill from width/height when missing.
        // Custom keeps explicit width/height and does not recompute from megapixels.
        if (!isCustomAspectRatio(out.aspectRatio) && (out.aspectRatio == null || out.megapixels == null)) {
            const resolved = resolutionFromSelector(
                out.aspectRatio || DEFAULT_ASPECT_RATIO,
                out.megapixels ?? DEFAULT_MEGAPIXELS,
                out.multiple ?? MINIMAX_CANVAS_MULTIPLE,
            );
            if (resolved) {
                out.aspectRatio = resolved.aspectRatio;
                out.megapixels = resolved.megapixels;
                out.multiple = resolved.multiple;
                if (out.width == null) out.width = resolved.width;
                if (out.height == null) out.height = resolved.height;
                this.timeline.output = { ...out };
            }
        }
        if (this.outMode) this.outMode.value = out.mode || "fixed";
        if (this.outAspect) {
            const ar = isCustomAspectRatio(out.aspectRatio)
                ? CUSTOM_ASPECT_RATIO
                : normalizeAspectRatioLabel(out.aspectRatio || DEFAULT_ASPECT_RATIO);
            this.outAspect.value = ar;
            if (out.aspectRatio !== ar) {
                out.aspectRatio = ar;
                this.timeline.output = { ...out };
            }
        }
        if (this.outMp) this.outMp.value = String(out.megapixels ?? DEFAULT_MEGAPIXELS);
        if (this.outLong) this.outLong.value = String(out.longEdge ?? 864);
        if (this.outW) this.outW.value = String(out.width ?? 864);
        if (this.outH) this.outH.value = String(out.height ?? 480);
        if (this.outMaxFrames) this.outMaxFrames.value = String(out.maxExportFrames ?? 0);
        if (this.outExportMode) this.outExportMode.value = out.exportMode === "segments" ? "segments" : "all";
        if (this.outAudioMode) {
            const am = normalizeAudioMode(out.audioMode);
            this.outAudioMode.value = am;
            if (out.audioMode !== am) {
                out.audioMode = am;
                this.timeline.output = { ...out };
            }
        }
        if (this.segmentContinuityCb) this.segmentContinuityCb.checked = isContinuityEnabled(out);
        if (this.segmentContinuityOverlap) {
            this.segmentContinuityOverlap.value = String(out.continuityOverlapFrames ?? 9);
        }
        this.syncFrameRateUI(this.timeline.frameRate);
        this.updateOutputModeUI();
        this.updateSegmentContinuityUI();
        this.updateOutputPreview();
    }

    updateSegmentContinuityUI() {
        const key = resolveTaskKey(this.getTaskKey?.() || this.taskTypeWidget?.value || "");
        const support = taskSupportsChainContinuity(key);
        const wrap = this.segmentContinuityWrap;
        if (wrap) {
            wrap.classList.toggle("hidden", !support);
            wrap.hidden = !support;
            wrap.setAttribute("aria-hidden", support ? "false" : "true");
        }
        // Overlap / SCAIL controls stay hidden — MiniMax uses single-frame handoff.
        if (this.segmentContinuityOverlap) {
            this.segmentContinuityOverlap.classList.add("hidden");
            this.segmentContinuityOverlap.hidden = true;
        }
        const overlapLabel = this.root?.querySelector?.('[data-r="segment-continuity-overlap-label"]');
        if (overlapLabel) {
            overlapLabel.classList.add("hidden");
            overlapLabel.hidden = true;
        }
        if (!support) return;
        if (!this.timeline.output) this.timeline.output = {};
        // fl_chain is the always-on preset of the same feature.
        if (key === "fl_chain") {
            this.timeline.output.continuityEnabled = true;
            if (this.segmentContinuityCb) {
                this.segmentContinuityCb.checked = true;
                this.segmentContinuityCb.disabled = true;
                this.segmentContinuityCb.title = "fl_chain 任务固定开启链式连贯";
            }
        } else if (this.segmentContinuityCb) {
            this.segmentContinuityCb.disabled = false;
            this.segmentContinuityCb.title = "";
            this.segmentContinuityCb.checked = isContinuityEnabled(this.timeline.output);
        }
    }

    /** Apply ResolutionSelector → fixed width/height on timeline + node widgets. */
    applyResolutionSelector(aspectRatio = null, megapixels = null) {
        const out = this.timeline.output || {};
        const ar = aspectRatio ?? out.aspectRatio ?? this.outAspect?.value ?? DEFAULT_ASPECT_RATIO;
        if (isCustomAspectRatio(ar)) {
            return this.applyCustomResolution(out.width, out.height);
        }
        const resolved = resolutionFromSelector(
            ar,
            megapixels ?? out.megapixels ?? this.outMp?.value ?? DEFAULT_MEGAPIXELS,
            out.multiple ?? MINIMAX_CANVAS_MULTIPLE,
        );
        if (!resolved) {
            return this.applyCustomResolution(out.width, out.height);
        }
        this.timeline.output = {
            ...out,
            mode: "fixed",
            aspectRatio: resolved.aspectRatio,
            megapixels: resolved.megapixels,
            multiple: resolved.multiple,
            width: resolved.width,
            height: resolved.height,
            longEdge: Math.max(resolved.width, resolved.height),
        };
        if (this.widthWidget) this.widthWidget.value = resolved.width;
        if (this.heightWidget) this.heightWidget.value = resolved.height;
        if (this.refMaxWidget) this.refMaxWidget.value = Math.max(resolved.width, resolved.height);
        if (this.outW) this.outW.value = String(resolved.width);
        if (this.outH) this.outH.value = String(resolved.height);
        if (this.outAspect) this.outAspect.value = resolved.aspectRatio;
        // Keep the in-progress typed text while the field is focused.
        if (this.outMp && document.activeElement !== this.outMp) {
            this.outMp.value = String(resolved.megapixels);
        }
        return resolved;
    }

    /** Apply explicit custom width × height (snapped to canvas multiple). */
    applyCustomResolution(width = null, height = null) {
        const out = this.timeline.output || {};
        const mult = out.multiple ?? MINIMAX_CANVAS_MULTIPLE;
        const w = snapResolutionDim(width ?? out.width ?? this.outW?.value ?? this.widthWidget?.value ?? 864, mult);
        const h = snapResolutionDim(height ?? out.height ?? this.outH?.value ?? this.heightWidget?.value ?? 480, mult);
        this.timeline.output = {
            ...out,
            mode: "fixed",
            aspectRatio: CUSTOM_ASPECT_RATIO,
            megapixels: out.megapixels ?? DEFAULT_MEGAPIXELS,
            multiple: mult,
            width: w,
            height: h,
            longEdge: Math.max(w, h),
        };
        if (this.widthWidget) this.widthWidget.value = w;
        if (this.heightWidget) this.heightWidget.value = h;
        if (this.refMaxWidget) this.refMaxWidget.value = Math.max(w, h);
        if (this.outW) this.outW.value = String(w);
        if (this.outH) this.outH.value = String(h);
        if (this.outAspect) this.outAspect.value = CUSTOM_ASPECT_RATIO;
        if (this.outMp) this.outMp.value = String(this.timeline.output.megapixels);
        return {
            width: w,
            height: h,
            megapixels: this.timeline.output.megapixels,
            aspectRatio: CUSTOM_ASPECT_RATIO,
            multiple: mult,
        };
    }

    updateOutputModeUI() {
        const taskKey = this.getTaskKey();
        const useSelector = this.isImageBatch() || this.isGenMode() || this.isFl2vMode()
            || NO_VIDEO_UPLOAD_TASKS.has(taskKey);
        // Gen / batch / fl2v: aspect + megapixels, or Custom width/height.
        // Video edit (v2v): long_edge / fixed — must toggle .hidden (CSS uses !important).
        if (this.outAspect) this.outAspect.classList.toggle("hidden", !useSelector);
        if (this.outMode) this.outMode.classList.toggle("hidden", useSelector);
        if (this.outLongWrap) this.outLongWrap.style.display = "";
        if (useSelector) {
            const custom = isCustomAspectRatio(this.timeline.output?.aspectRatio ?? this.outAspect?.value);
            if (this.outMpWrap) this.outMpWrap.classList.toggle("hidden", custom);
            if (this.outLongWrap) this.outLongWrap.classList.add("hidden");
            if (this.outFixedWrap) this.outFixedWrap.classList.toggle("hidden", !custom);
            if (custom) this.applyCustomResolution();
            else this.applyResolutionSelector();
            return;
        }
        if (this.outMpWrap) this.outMpWrap.classList.add("hidden");
        const mode = this.timeline.output?.mode || "long_edge";
        const isFixed = mode === "fixed";
        if (this.outLongWrap) this.outLongWrap.classList.toggle("hidden", isFixed);
        if (this.outFixedWrap) this.outFixedWrap.classList.toggle("hidden", !isFixed);
    }

    updateOutputPreview() {
        if (!this.outPreview) return;
        if (this.isImageBatch() && (this.getTaskKey() === "i2i" || this.getTaskKey() === "i2v")) {
            const out = this.timeline.output || {};
            if ((out.mode || "long_edge") === "long_edge") {
                const src = this.getI2iSourceDimensions();
                const resolved = resolveOutputDimensions(src.width, src.height, out, {
                    refMaxSize: this.refMaxWidget?.value,
                });
                const note = src.width > 0 ? "" : " · 上传源图后按最长边计算";
                this.outPreview.textContent = `→ ${resolved.width}×${resolved.height}${note}${this._exportPreviewSuffix()}`;
            } else {
                const w = snapDim(+(out.width ?? this.outW?.value ?? 864));
                const h = snapDim(+(out.height ?? this.outH?.value ?? 480));
                this.outPreview.textContent = `→ ${w}×${h}${this._exportPreviewSuffix()}`;
            }
            return;
        }
        if (this.isGenBlank() || this.isImageBatch() || this.isFl2vMode()) {
            const out = this.timeline.output || {};
            if (isCustomAspectRatio(out.aspectRatio)) {
                const w = snapResolutionDim(out.width ?? this.outW?.value ?? 864, out.multiple ?? MINIMAX_CANVAS_MULTIPLE);
                const h = snapResolutionDim(out.height ?? this.outH?.value ?? 480, out.multiple ?? MINIMAX_CANVAS_MULTIPLE);
                this.outPreview.textContent = `→ ${w}×${h} · 自定义${this._exportPreviewSuffix()}`;
                return;
            }
            const resolved = resolutionFromSelector(
                out.aspectRatio || DEFAULT_ASPECT_RATIO,
                out.megapixels ?? DEFAULT_MEGAPIXELS,
                out.multiple ?? MINIMAX_CANVAS_MULTIPLE,
            );
            if (!resolved) {
                const w = snapResolutionDim(out.width ?? 864);
                const h = snapResolutionDim(out.height ?? 480);
                this.outPreview.textContent = `→ ${w}×${h}${this._exportPreviewSuffix()}`;
                return;
            }
            const w = resolved.width;
            const h = resolved.height;
            const ar = resolved.aspectRatio.split(" ")[0];
            this.outPreview.textContent = `→ ${w}×${h} · ${ar} · ${resolved.megapixels}MP${this._exportPreviewSuffix()}`;
            return;
        }
        const src = this.getSourceDimensions();
        const resolved = resolveOutputDimensions(src.width, src.height, this.timeline.output, {
            width: this.widthWidget?.value,
            height: this.heightWidget?.value,
            refMaxSize: this.refMaxWidget?.value,
        });
        this.outPreview.textContent = `→ ${resolved.width}×${resolved.height}${this._exportPreviewSuffix()}`;
    }

    _exportPreviewSuffix() {
        const cap = this.getMaxExportFrames();
        const exportMode = this.timeline.output?.exportMode === "segments" ? " · 分段导出" : "";
        const dur = this.getTimelineDurationSec().toFixed(2);
        const fps = formatProbeFps(this.getFrameRate());
        const timeHint = ` · ${dur}s @ ${fps}fps`;
        if (cap <= 0) return `${timeHint}${exportMode}`;
        const total = this.getTotalFrames();
        const exportTotal = this.getExportFrameTotal();
        if (exportTotal >= total) return `${timeHint} · 导出 ${exportTotal} 帧${exportMode}`;
        return `${timeHint} · 导出 ${exportTotal}/${total} 帧${exportMode}`;
    }

    onOutputField(key, value) {
        this.timeline.output = this.timeline.output || {
            mode: "fixed",
            aspectRatio: DEFAULT_ASPECT_RATIO,
            megapixels: DEFAULT_MEGAPIXELS,
            multiple: MINIMAX_CANVAS_MULTIPLE,
            longEdge: 864, width: 864, height: 480,
            maxExportFrames: 0, exportMode: "all",
            audioMode: "generate",
            continuityEnabled: false, continuityOverlapFrames: 9,
        };
        if (key === "aspectRatio") {
            if (isCustomAspectRatio(value)) {
                // Keep current computed size when entering custom mode.
                this.applyCustomResolution(
                    this.timeline.output.width ?? this.outW?.value,
                    this.timeline.output.height ?? this.outH?.value,
                );
            } else {
                this.applyResolutionSelector(value, null);
            }
        } else if (key === "megapixels") {
            const mp = clampMegapixels(value);
            if (!isCustomAspectRatio(this.timeline.output.aspectRatio)) {
                this.applyResolutionSelector(null, mp);
            } else {
                this.timeline.output.megapixels = mp;
            }
        } else if (key === "mode") {
            this.timeline.output.mode = value;
        } else if (key === "longEdge") {
            // Long-edge is a size budget, not a canvas dim — do not snap to 32
            // (848 would become 864). Final W/H still snap via resolveOutputDimensions.
            const n = Math.round(Number(value) || 864);
            this.timeline.output.longEdge = Math.max(32, n);
        } else if (key === "width") {
            const useSelector = this.isImageBatch() || this.isGenMode() || this.isFl2vMode()
                || NO_VIDEO_UPLOAD_TASKS.has(this.getTaskKey());
            if (useSelector) {
                this.applyCustomResolution(value, this.timeline.output.height ?? this.outH?.value);
            } else {
                this.timeline.output.width = snapDim(value || 864);
            }
        } else if (key === "height") {
            const useSelector = this.isImageBatch() || this.isGenMode() || this.isFl2vMode()
                || NO_VIDEO_UPLOAD_TASKS.has(this.getTaskKey());
            if (useSelector) {
                this.applyCustomResolution(this.timeline.output.width ?? this.outW?.value, value);
            } else {
                this.timeline.output.height = snapDim(value || 480);
            }
        } else if (key === "maxExportFrames") {
            const n = parseInt(value, 10);
            this.timeline.output.maxExportFrames = Number.isFinite(n) && n > 0 ? n : 0;
        } else if (key === "exportMode") {
            this.timeline.output.exportMode = value === "segments" ? "segments" : "all";
        } else if (key === "audioMode") {
            this.timeline.output.audioMode = normalizeAudioMode(value);
        } else if (key === "continuityEnabled") {
            this.timeline.output.continuityEnabled = !!value;
        } else if (key === "continuityOverlapFrames") {
            const n = parseInt(value, 10);
            this.timeline.output.continuityOverlapFrames = Number.isFinite(n)
                ? Math.max(1, Math.min(81, n))
                : 9;
        }
        this.syncOutputUIFromTimeline();
        if (this.isFl2vMode()) updateFl2vDetailUI(this);
        this.commit();
        this.flushTimelineSync();
    }

    syncOutputToWidgets() {
        if (this.isImageBatch() && (this.getTaskKey() === "i2i" || this.getTaskKey() === "i2v")) {
            const out = this.timeline.output || {};
            const mode = (out.mode || "long_edge").toLowerCase();
            if (mode === "long_edge") {
                const src = this.getI2iSourceDimensions();
                const resolved = resolveOutputDimensions(src.width, src.height, out, {
                    width: this.widthWidget?.value,
                    height: this.heightWidget?.value,
                    refMaxSize: this.refMaxWidget?.value,
                });
                this.timeline.output = {
                    ...out,
                    mode: "long_edge",
                    longEdge: out.longEdge ?? resolved.refMaxSize,
                    width: resolved.width,
                    height: resolved.height,
                };
                if (this.widthWidget) this.widthWidget.value = resolved.width;
                if (this.heightWidget) this.heightWidget.value = resolved.height;
                if (this.refMaxWidget) this.refMaxWidget.value = resolved.refMaxSize;
                this.timeline.width = resolved.width;
                this.timeline.height = resolved.height;
                this.timeline.refMaxSize = resolved.refMaxSize;
            } else {
                const w = snapDim(+(out.width ?? this.widthWidget?.value ?? 864));
                const h = snapDim(+(out.height ?? this.heightWidget?.value ?? 480));
                this.timeline.output = { ...out, mode: "fixed", width: w, height: h };
                if (this.widthWidget) this.widthWidget.value = w;
                if (this.heightWidget) this.heightWidget.value = h;
                this.timeline.width = w;
                this.timeline.height = h;
            }
            this.updateOutputPreview();
            return;
        }
        if (this.isGenBlank() || this.isImageBatch() || this.isFl2vMode()) {
            const out = this.timeline.output || {};
            const resolved = isCustomAspectRatio(out.aspectRatio)
                ? this.applyCustomResolution(out.width, out.height)
                : this.applyResolutionSelector();
            this.timeline.width = resolved.width;
            this.timeline.height = resolved.height;
            this.timeline.refMaxSize = Math.max(resolved.width, resolved.height);
            this.updateOutputPreview();
            return;
        }
        const src = this.getSourceDimensions();
        const prevOut = this.timeline.output || {};
        const resolved = resolveOutputDimensions(src.width, src.height, prevOut, {
            width: this.timeline.width,
            height: this.timeline.height,
            refMaxSize: this.timeline.refMaxSize,
        });
        // Preserve audioMode / aspect / megapixels etc. — do not rebuild a bare object.
        this.timeline.output = {
            ...prevOut,
            mode: resolved.mode,
            longEdge: prevOut.longEdge ?? resolved.refMaxSize,
            width: resolved.width,
            height: resolved.height,
            maxExportFrames: prevOut.maxExportFrames ?? 0,
            exportMode: prevOut.exportMode ?? "all",
            audioMode: normalizeAudioMode(prevOut.audioMode),
            continuityEnabled: isContinuityEnabled(prevOut),
            continuityOverlapFrames: Math.max(1, Math.min(81,
                parseInt(prevOut.continuityOverlapFrames ?? 9, 10) || 9)),
        };
        if (this.widthWidget) this.widthWidget.value = resolved.width;
        if (this.heightWidget) this.heightWidget.value = resolved.height;
        if (this.refMaxWidget) this.refMaxWidget.value = resolved.refMaxSize;
        this.timeline.width = resolved.width;
        this.timeline.height = resolved.height;
        this.timeline.refMaxSize = resolved.refMaxSize;
        this._refreshVideoStorageDimensions(resolved);
        this.updateOutputPreview();
    }

    syncFromWidgets() {
        this.harvestBatchPrompts?.();
        this.timeline.global = this.timeline.global || { refs: [], referenceVideo: {}, continuousReference: false };
        this.timeline.global.taskType = this.globalTask?.value || this.taskTypeWidget?.value || "";
        // In prompt-group (batch) mode the per-group textareas are the source of truth.
        // Do not let a stale global textarea wipe timeline.global.prompt unless it actually changed
        // and we're not in batch — still sync global for story context, but never copy it onto groups.
        if (this.isImageBatch?.()) {
            // Keep whatever is in memory / story field; only update from textarea if user can see it
            const fromUi = this.globalPrompt?.value;
            if (fromUi != null && this.globalPanel && this.globalPanel.style.display !== "none") {
                this.timeline.global.prompt = fromUi;
            }
        } else {
            this.timeline.global.prompt = this.globalPrompt?.value ?? this.globalPromptWidget?.value ?? "";
        }
        if (this.continuousRefCb) {
            this.timeline.global.continuousReference = !!this.continuousRefCb.checked;
        }
        // fl2v: totalFrames stores the sampling window (总时长), not visual overflow length.
        this.timeline.totalFrames = this.isFl2vMode()
            ? getFl2vSampleFrames(this)
            : this.getTotalFrames();
        this.timeline.frameRate = this.getFrameRate();
        this.timeline.output = this.timeline.output || {
            mode: "long_edge", longEdge: 864, width: 864, height: 480,
            maxExportFrames: 0, exportMode: "all",
            audioMode: "generate",
            continuityEnabled: false, continuityOverlapFrames: 9,
        };
        if (this.timeline.output.audioMode == null) {
            this.timeline.output.audioMode = "generate";
        }
        if (this.segmentContinuityCb) {
            this.timeline.output.continuityEnabled = !!this.segmentContinuityCb.checked;
        }
        if (this.segmentContinuityOverlap) {
            const n = parseInt(this.segmentContinuityOverlap.value, 10);
            this.timeline.output.continuityOverlapFrames = Number.isFinite(n)
                ? Math.max(1, Math.min(81, n))
                : (this.timeline.output.continuityOverlapFrames ?? 9);
        }
        // Keep exportMode aligned with the visible select (source of truth for Queue).
        if (this.outExportMode && !this.outExportMode.classList.contains("hidden") && !this.outExportMode.disabled) {
            this.timeline.output.exportMode = this.outExportMode.value === "segments" ? "segments" : "all";
        }
        this.syncOutputToWidgets();
    }

    commit(skipRender = false, { syncTimeline = true } = {}) {
        this.syncFromWidgets();
        this.normalizeSegments();
        if (this.isRunSelectEnabled()) this.normalizeRunSelection();
        this.updateRunSelectUI();
        if (this.taskTypeWidget) this.taskTypeWidget.value = this.timeline.global.taskType;
        if (this.globalPromptWidget) this.globalPromptWidget.value = this.timeline.global.prompt;
        if (this.negativePromptWidget) {
            const neg = this.globalNegative?.value ?? this.segNegative?.value ?? this.negativePromptWidget.value ?? "";
            this.negativePromptWidget.value = neg;
        }
        if (this.totalFramesWidget) {
            this.totalFramesWidget.value = Math.max(
                0,
                this.isFl2vMode() ? getFl2vSampleFrames(this) : this.getTotalFrames(),
            );
        }
        this.seekBar.max = Math.max(0, this.getTotalFrames() - 1);
        if (syncTimeline) this.scheduleTimelineSync();
        if (!skipRender) this.scheduleRender();
        if (this.isGlobalMode() && taskUsesReferenceImages(this.getTaskKey())) {
            this.renderRefSlots(this.timeline.global.refs, this.globalRefsBox, true);
        } else if (this.isImageBatch()) this.renderImageBatchGroups();
        else this.updateSelectionUI();
    }

    normalizeSegments() {
        if (this.isImageBatch()) {
            this.normalizeImageBatchSegments();
            return;
        }
        if (this.isFl2vMode()) {
            normalizeFl2vSegments(this);
            const n = this.timeline.segments?.length || 0;
            this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, n - 1));
            return;
        }
        if (this.isGenMode()) {
            this.normalizeGenSegments();
            return;
        }
        const total = this.getTotalFrames();
        let segs = [...this.timeline.segments].sort((a, b) => a.start - b.start);
        if (!total) {
            this.timeline.segments = [];
            this.timeline.totalFrames = 0;
            return;
        }
        if (!segs.length) segs = [{ id: uid(), start: 0, length: total, prompt: "", taskType: "", refs: [], referenceVideo: {} }];
        const fixed = [];
        let cursor = 0;
        for (const seg of segs) {
            const start = clamp(seg.start, cursor, total);
            let length = Math.max(MIN_SEG, seg.length ?? (total - start));
            if (start + length > total) length = total - start;
            if (length < MIN_SEG) continue;
            fixed.push({ ...seg, start, length, refs: seg.refs || [] });
            cursor = start + length;
        }
        if (fixed.length && cursor < total) fixed[fixed.length - 1].length += total - cursor;
        this.timeline.segments = fixed;
        this.timeline.totalFrames = total;
        this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, fixed.length - 1));
        this.updateSegmentContinuityUI();
    }

    getVideoViewUrl() {
        return this.getClipViewUrl(0);
    }

    getSourceFrameIndex(logicalFrame) {
        return this.getFrameMapEntry(logicalFrame).frame;
    }

    _getPreviewVideoForClip(clipIndex) {
        const url = this.getClipViewUrl(clipIndex);
        if (!this._previewVideos) this._previewVideos = new Map();
        if (clipIndex === 0 && this._previewVideo && !this._previewVideos.has(0)) {
            if (url) this._previewVideo.src = url;
            this._previewVideos.set(0, this._previewVideo);
        }
        if (!url) return this._previewVideos.get(clipIndex) || (clipIndex === 0 ? this._previewVideo : null);
        let v = this._previewVideos.get(clipIndex);
        if (!v) {
            v = document.createElement("video");
            v.crossOrigin = "anonymous";
            v.muted = true;
            v.playsInline = true;
            v.preload = "auto";
            v.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none";
            document.body.appendChild(v);
            v.src = url;
            this._previewVideos.set(clipIndex, v);
        } else if (url && v.src !== url && !String(v.src).includes(encodeURIComponent(url.split("/").pop()?.split("?")[0] || ""))) {
            v.src = url;
        }
        return v;
    }

    _restorePreviewVideos() {
        const clips = this.getVideoClips();
        if (!clips.length) return;
        for (let i = 0; i < clips.length; i++) this._getPreviewVideoForClip(i);
        this._previewVideo = this._previewVideos.get(0) || this._previewVideo;
    }

    _clearPreviewVideos(removeExtra = true) {
        if (!this._previewVideos) return;
        for (const [idx, v] of this._previewVideos.entries()) {
            v.pause();
            if (idx === 0 && v === this._previewVideo) {
                v.removeAttribute("src");
                v.load();
                continue;
            }
            if (removeExtra) {
                v.removeAttribute("src");
                v.load();
                v.remove();
            }
        }
        const keep = this._previewVideo;
        this._previewVideos.clear();
        if (keep) this._previewVideos.set(0, keep);
    }

    async _seekPreviewVideo(timeSec, clipIndex = 0) {
        this._seekChain = this._seekChain.then(() => new Promise((resolve) => {
            const v = this._getPreviewVideoForClip(clipIndex);
            if (!v?.src) { resolve(); return; }
            const target = Math.max(0, timeSec);
            const onSeeked = () => {
                v.removeEventListener("seeked", onSeeked);
                resolve();
            };
            v.addEventListener("seeked", onSeeked);
            try {
                v.currentTime = target;
            } catch {
                onSeeked();
                return;
            }
            if (Math.abs(v.currentTime - target) < 0.02 && v.readyState >= 2) {
                onSeeked();
            }
        }));
        return this._seekChain;
    }

    updateStageVisibility() {
        if (!this.stageEl) return;
        const show = this.hasVideo()
            && !this.isImageBatch()
            && !this.isGenMode()
            && !this.isFl2vMode();
        this.stageEl.classList.toggle("hidden", !show);
        if (!show) {
            if (this.stageVideo) {
                this.stageVideo.pause();
                this.stageVideo.classList.add("hidden");
            }
            this.stageImg?.classList.add("hidden");
            this.stageEmpty?.classList.remove("hidden");
            this.stageBadge?.classList.add("hidden");
            this._stageClipIndex = -1;
        } else {
            this._syncStagePreview(this.currentFrame, { force: true });
        }
        this.updateDomWidgetHeight();
        syncDirectorNodeSize(this.node, this);
    }

    _updateStageBadge(logicalFrame) {
        if (!this.stageBadge) return;
        const total = this.getTotalFrames();
        const frame = clamp(logicalFrame | 0, 0, Math.max(0, total - 1));
        const clips = this.getVideoClips();
        const entry = this.getFrameMapEntry(frame);
        const clipHint = clips.length > 1 ? ` · 片${entry.clip + 1}` : "";
        this.stageBadge.textContent = `帧 ${frame + 1}/${total}${clipHint}`;
        this.stageBadge.classList.remove("hidden");
    }

    _logicalRangeForClip(clipIndex) {
        const map = this.getFrameMap();
        let start = -1;
        let end = -1;
        for (let i = 0; i < map.length; i++) {
            const e = normalizeFrameMapEntry(map[i]);
            if (e.clip !== clipIndex) {
                if (start >= 0) break;
                continue;
            }
            if (start < 0) start = i;
            end = i + 1;
        }
        if (start < 0) return { start: 0, end: this.getTotalFrames() };
        return { start, end };
    }

    _logicalFromStageTime(clipIndex, timeSec) {
        const fps = Math.max(0.001, this.getFrameRate());
        const srcFrame = Math.max(0, Math.round(Number(timeSec) * fps));
        const map = this.getFrameMap();
        if (!map.length) {
            const logical = sourceToLogicalFrame(srcFrame, this.timeline.video || {});
            if (logical < 0) return -1; // source lands in a deleted gap
            return clamp(logical, 0, Math.max(0, this.getTotalFrames() - 1));
        }
        let first = -1;
        let best = -1;
        for (let i = 0; i < map.length; i++) {
            const e = normalizeFrameMapEntry(map[i]);
            if (e.clip !== clipIndex) continue;
            if (first < 0) first = i;
            if (e.frame === srcFrame) return i;
            if (e.frame <= srcFrame) best = i;
        }
        if (best >= 0) return best;
        if (first >= 0) return first;
        return 0;
    }

    /** Next logical index whose source frame is strictly after srcFrame (same clip). */
    _nextLogicalAfterSourceFrame(clipIndex, srcFrame) {
        const map = this.getFrameMap();
        if (!map.length) {
            // Sparse: walk forward until source maps to a kept logical frame.
            const total = this.getTotalFrames();
            const startLogical = sourceToLogicalFrame(srcFrame, this.timeline.video || {});
            const from = startLogical < 0 ? 0 : startLogical;
            for (let i = from; i < total; i++) {
                if (this.logicalToSourceFrame(i) > srcFrame) return i;
            }
            return -1;
        }
        for (let i = 0; i < map.length; i++) {
            const e = normalizeFrameMapEntry(map[i]);
            if (e.clip === clipIndex && e.frame > srcFrame) return i;
        }
        return -1;
    }

    _syncStagePreview(logicalFrame, { force = false } = {}) {
        if (!this.stageEl || this.stageEl.classList.contains("hidden")) return;
        if (!this.hasVideo()) {
            this.stageEmpty?.classList.remove("hidden");
            this.stageVideo?.classList.add("hidden");
            this.stageImg?.classList.add("hidden");
            return;
        }

        // During native playback, do not seek every tick (that causes stutter).
        // Only refresh the badge; playhead is driven from video.currentTime.
        if (this.isPlaying && !force && !this._legacyFrames.length) {
            this._updateStageBadge(logicalFrame);
            return;
        }

        const frame = clamp(logicalFrame | 0, 0, Math.max(0, this.getTotalFrames() - 1));
        const fps = Math.max(0.001, this.getFrameRate());

        if (this._legacyFrames.length) {
            const dataUrl = this._legacyFrames[frame];
            if (this.stageVideo) {
                this.stageVideo.pause();
                this.stageVideo.classList.add("hidden");
            }
            if (this.stageImg && dataUrl) {
                this.stageImg.src = dataUrl;
                this.stageImg.classList.remove("hidden");
                this.stageEmpty?.classList.add("hidden");
            }
            this._updateStageBadge(frame);
            return;
        }

        const entry = this.getFrameMapEntry(frame);
        const url = this.getClipViewUrl(entry.clip);
        const v = this.stageVideo;
        if (!v || !url) {
            this.stageEmpty?.classList.remove("hidden");
            return;
        }

        this.stageImg?.classList.add("hidden");
        this.stageEmpty?.classList.add("hidden");
        v.classList.remove("hidden");

        let sameSrc = false;
        if (v.src && url) {
            try {
                sameSrc = new URL(v.src, location.href).href === new URL(url, location.href).href;
            } catch {
                sameSrc = v.src === url;
            }
        }
        // Must reload when the file changes even if clip index stays 0 (replace upload).
        if (this._stageClipIndex !== entry.clip || !sameSrc) {
            this._stageClipIndex = entry.clip;
            if (!sameSrc) {
                v.pause();
                v.src = url;
                v.load();
            }
        }

        const target = Math.max(0, entry.frame / fps);
        if (force || Math.abs(v.currentTime - target) > 0.035) {
            try {
                v.currentTime = target;
            } catch {
                /* ignore seek races while loading */
            }
        }
        if (this.isPlaying && force) {
            v.play().catch(() => {});
        }
        this._updateStageBadge(frame);
    }

    async _ensureStageReadyForFrame(logicalFrame) {
        this._syncStagePreview(logicalFrame, { force: true });
        const v = this.stageVideo;
        if (!v || this._legacyFrames.length) return false;
        if (v.readyState >= 2) return true;
        await new Promise((resolve) => {
            const done = () => {
                v.removeEventListener("loadeddata", done);
                v.removeEventListener("canplay", done);
                resolve();
            };
            v.addEventListener("loadeddata", done);
            v.addEventListener("canplay", done);
            setTimeout(done, 800);
        });
        return true;
    }

    _queueThumbPrefetch(logicalFrame) {
        if (this.isPlaying) return;
        if (this._thumbCache.has(logicalFrame) || this._thumbPending.has(logicalFrame)) return;
        if (!this.hasVideo() && !this._legacyFrames.length) return;
        this._thumbPending.add(logicalFrame);
        this._fetchThumb(logicalFrame).then((img) => {
            this._thumbPending.delete(logicalFrame);
            if (img) this._thumbCache.set(logicalFrame, img);
            this.scheduleRender();
        });
    }

    async _fetchThumb(logicalFrame) {
        if (this._legacyFrames.length) {
            const dataUrl = this._legacyFrames[logicalFrame];
            if (!dataUrl) return null;
            return this._decodeThumb(dataUrl);
        }
        const entry = this.getFrameMapEntry(logicalFrame);
        const v = this._getPreviewVideoForClip(entry.clip);
        if (!v?.src || !v.videoWidth) return null;
        const t = Math.max(0, entry.frame / this.getFrameRate());
        await this._seekPreviewVideo(t, entry.clip);
        const ratio = v.videoWidth > THUMB_MAX_W ? THUMB_MAX_W / v.videoWidth : 1;
        const tw = Math.max(1, Math.round(v.videoWidth * ratio));
        const th = Math.max(1, Math.round(v.videoHeight * ratio));
        this._thumbCanvas.width = tw;
        this._thumbCanvas.height = th;
        this._thumbCtx.drawImage(v, 0, 0, tw, th);
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = this._thumbCanvas.toDataURL("image/jpeg", THUMB_JPEG_Q);
        });
    }

    _clearVideoState() {
        this._thumbCache.clear();
        this._thumbPending.clear();
        this._legacyFrames = [];
        this.timeline.videoClips = [];
        this.timeline.videoWorkspace = null;
        // Wipe video identity BEFORE visibility sync — otherwise hasVideo() stays
        // true via the old videoFile and stage reloads the previous clip.
        this.timeline.video = {
            fileName: "",
            videoFile: "",
            subfolder: "",
            type: "input",
            frames: [],
            frameMap: [],
            deletedSourceRanges: [],
            sourceFrameCount: 0,
            width: 0,
            height: 0,
        };
        this.timeline.totalFrames = 0;
        this._storageWidth = 0;
        this._storageHeight = 0;
        this._clearPreviewVideos(true);
        if (this._previewVideo) {
            this._previewVideo.pause();
            this._previewVideo.removeAttribute("src");
            this._previewVideo.load();
        }
        if (this.stageVideo) {
            this.stageVideo.pause();
            this.stageVideo.removeAttribute("src");
            this.stageVideo.load();
            this.stageVideo.classList.add("hidden");
        }
        this.stageImg?.classList.add("hidden");
        if (this.stageImg) this.stageImg.removeAttribute("src");
        this.stageEmpty?.classList.remove("hidden");
        this.stageBadge?.classList.add("hidden");
        this._stageClipIndex = -1;
        this.updateStageVisibility();
    }

    _resetTimelineForReplaceUpload() {
        this._clearVideoState();
        this.timeline.segments = [];
        this.selectedIndex = 0;
        this.currentFrame = 0;
        if (this.seekBar) {
            this.seekBar.value = 0;
            this.seekBar.max = 0;
        }
    }

    _setSingleSegment(totalFrames) {
        const total = Math.max(0, totalFrames);
        this.timeline.segments = total > 0
            ? [{ id: uid(), start: 0, length: total, prompt: "", taskType: "", refs: [], referenceVideo: {} }]
            : [];
        this.selectedIndex = 0;
        this.currentFrame = 0;
        if (this.seekBar) {
            this.seekBar.max = Math.max(0, total - 1);
            this.seekBar.value = 0;
        }
    }

    restoreVideoFromTimeline() {
        const video = this.timeline.video || {};
        this._storageWidth = video.storageWidth || 0;
        this._storageHeight = video.storageHeight || 0;

        const legacy = video.frames || [];
        if (legacy.length && !video.videoFile) {
            this._legacyFrames = legacy;
            this.setFrameMap(buildIdentityFrameMap(legacy.length));
            this.videoNameEl.textContent = `${video.fileName || "视频"} (${legacy.length}f · 旧版内嵌)`;
            this._prefetchSegmentThumbs(0, legacy.length);
            this.updateStageVisibility();
            return;
        }

        if (!video.videoFile) {
            this._clearVideoState();
            return;
        }

        this._restorePreviewVideos();
        const n = this.getTotalFrames();
        this._prefetchSegmentThumbs(0, Math.min(n, THUMB_PREFETCH_BATCH * 4));
        this.updateVideoNameLabel();
        if (taskUsesReferenceVideo(this.getTaskKey()) && this.getReferenceVideoViewUrl(this.timeline.global?.referenceVideo)) {
            this.renderRefVideoSlot();
        }
        this.updateStageVisibility();
    }

    _prefetchSegmentThumbs(from, to) {
        for (let f = from; f < to; f++) this._queueThumbPrefetch(f);
    }

    _decodeThumb(dataUrl) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                if (!img.naturalWidth || img.naturalWidth <= THUMB_MAX_W) {
                    resolve(img);
                    return;
                }
                const ratio = THUMB_MAX_W / img.naturalWidth;
                const w = THUMB_MAX_W;
                const h = Math.max(1, Math.round(img.naturalHeight * ratio));
                const c = document.createElement("canvas");
                c.width = w;
                c.height = h;
                c.getContext("2d").drawImage(img, 0, 0, w, h);
                const thumb = new Image();
                thumb.onload = () => resolve(thumb);
                thumb.onerror = () => resolve(img);
                thumb.src = c.toDataURL("image/jpeg", THUMB_JPEG_Q);
            };
            img.onerror = () => resolve(null);
            img.src = dataUrl.startsWith("data:") ? dataUrl : `data:image/jpeg;base64,${dataUrl}`;
        });
    }

    pickVideoFile() {
        if (this.isFl2vMode()) {
            openFl2vUpload(this);
            return;
        }
        const input = document.createElement("input");
        input.type = "file"; input.accept = "video/*";
        input.onchange = () => { if (input.files?.[0]) this.loadVideoFile(input.files[0]); };
        input.click();
    }

    pickAppendVideoFile() {
        if (!this.hasVideo()) {
            this.showBdMessage(
                "追加视频",
                "请先上传第一个视频，再使用「追加视频」。"
            );
            return;
        }
        const input = document.createElement("input");
        input.type = "file"; input.accept = "video/*";
        input.onchange = () => { if (input.files?.[0]) this.appendVideoFile(input.files[0]); };
        input.click();
    }

    async appendVideoFile(file) {
        const btn = this.root.querySelector('[data-a="video-append"]');
        if (btn) { btn.disabled = true; btn.textContent = "上传中…"; }
        this.videoNameEl.textContent = `追加中: ${file.name}…`;
        try {
            const uploaded = await uploadToInputSmart(file, (frac, cur, total) => {
                const pct = Math.round(frac * 100);
                const mode = file.size > COMFY_UPLOAD_SOFT_LIMIT ? "分块" : "上传";
                this.videoNameEl.textContent = `追加${mode}: ${file.name} (${cur}/${total}, ${pct}%)…`;
            });
            const relPath = videoRelativePath(uploaded);
            await this._applyAppendedVideo({
                fileName: file.name,
                relPath,
                subfolder: uploaded.subfolder || "",
                type: uploaded.type || "input",
                statusPrefix: "解析",
            });
        } catch (err) {
            console.error("[MiniMax H3Director] append video failed:", err);
            this.videoNameEl.textContent = `追加失败: ${formatUploadError(err)}`;
            this.updateVideoNameLabel();
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "追加视频"; }
        }
    }

    async loadVideoFile(file) {
        const btn = this.root.querySelector('[data-a="video"]');
        if (btn) { btn.disabled = true; btn.textContent = "上传中…"; }
        this.videoNameEl.textContent = `上传中: ${file.name}…`;
        try {
            this._resetTimelineForReplaceUpload();
            const uploaded = await uploadToInputSmart(file, (frac, cur, total) => {
                const pct = Math.round(frac * 100);
                const mode = file.size > COMFY_UPLOAD_SOFT_LIMIT ? "分块" : "上传";
                this.videoNameEl.textContent = `${mode}中: ${file.name} (${cur}/${total}, ${pct}%)…`;
            });
            const relPath = videoRelativePath(uploaded);
            await this._applyLoadedVideo({
                fileName: file.name,
                relPath,
                subfolder: uploaded.subfolder || "",
                type: uploaded.type || "input",
                statusPrefix: "解析",
            });
        } catch (err) {
            console.error("[MiniMax H3Director] video load failed:", err);
            this.videoNameEl.textContent = `加载失败: ${formatUploadError(err)}`;
            this._resetTimelineForReplaceUpload();
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = "上传视频"; }
        }
    }

    _closeBdModal() {
        if (this._modalKeyHandler) {
            window.removeEventListener("keydown", this._modalKeyHandler, true);
            this._modalKeyHandler = null;
        }
        if (this._modalEl) {
            this._modalEl.remove();
            this._modalEl = null;
        }
    }

    showBdMessage(title, message) {
        return this.showBdDialog({ title, message, confirmText: "确定", cancelText: null });
    }

    showBdDialog({ title, message, items, confirmText = "确定", cancelText = "取消" }) {
        return new Promise((resolve) => {
            this._closeBdModal();

            const overlay = document.createElement("div");
            overlay.className = "bd-modal-overlay";
            const panel = document.createElement("div");
            panel.className = "bd-modal";
            panel.innerHTML = `
                <div class="bd-modal-title"></div>
                <div class="bd-modal-body hidden"></div>
                <div class="bd-modal-list hidden"></div>
                <div class="bd-modal-actions"></div>`;

            panel.querySelector(".bd-modal-title").textContent = title || "";

            const bodyEl = panel.querySelector(".bd-modal-body");
            const listEl = panel.querySelector(".bd-modal-list");
            const actionsEl = panel.querySelector(".bd-modal-actions");

            let selectedValue = items?.length ? items[0].value : null;

            const finish = (val) => {
                this._closeBdModal();
                resolve(val);
            };

            if (message) {
                bodyEl.textContent = message;
                bodyEl.classList.remove("hidden");
            }

            if (items?.length) {
                listEl.classList.remove("hidden");
                for (const item of items) {
                    const row = document.createElement("div");
                    row.className = "bd-modal-item";
                    row.textContent = item.label ?? item.value;
                    row.title = item.label ?? item.value;
                    row.dataset.value = item.value;
                    if (item.value === selectedValue) row.classList.add("selected");
                    row.onclick = () => {
                        selectedValue = item.value;
                        for (const el of listEl.querySelectorAll(".bd-modal-item")) {
                            el.classList.toggle("selected", el === row);
                        }
                    };
                    row.ondblclick = () => finish(item.value);
                    listEl.appendChild(row);
                }
            }

            if (cancelText) {
                const cancelBtn = document.createElement("button");
                cancelBtn.type = "button";
                cancelBtn.className = "bd-btn";
                cancelBtn.textContent = cancelText;
                cancelBtn.onclick = () => finish(null);
                actionsEl.appendChild(cancelBtn);
            }

            const okBtn = document.createElement("button");
            okBtn.type = "button";
            okBtn.className = "bd-btn bd-btn-primary";
            okBtn.textContent = confirmText;
            okBtn.onclick = () => finish(items?.length ? selectedValue : true);
            actionsEl.appendChild(okBtn);

            overlay.onclick = (e) => {
                if (e.target === overlay && cancelText) finish(null);
            };
            panel.onclick = (e) => e.stopPropagation();

            this._modalKeyHandler = (e) => {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(cancelText ? null : true);
                } else if (e.key === "Enter" && items?.length) {
                    e.preventDefault();
                    finish(selectedValue);
                }
            };
            window.addEventListener("keydown", this._modalKeyHandler, true);

            overlay.appendChild(panel);
            this.root.appendChild(overlay);
            this._modalEl = overlay;
            okBtn.focus();
        });
    }

    async _prepareVideoFrames({ fileName, relPath, subfolder, type, statusPrefix, syncNativeFps = true }) {
        this.videoNameEl.textContent = `${statusPrefix}: ${fileName}…`;
        const viewUrl = inputViewUrl(relPath, type || "input");

        let serverProbe = null;
        try {
            serverProbe = await this.probeVideoFile(relPath, subfolder, type);
        } catch (err) {
            console.warn("[MiniMax H3Director] video probe failed, using browser estimate:", err);
        }
        const browserMeta = await this.probeVideoMetadata(viewUrl);
        const nativeFps = Number(serverProbe?.native_fps || 0);
        const nativeFrameCount = Number(serverProbe?.frame_count || 0);
        const meta = {
            width: Number(serverProbe?.width || browserMeta.width || 0),
            height: Number(serverProbe?.height || browserMeta.height || 0),
            duration: Number(serverProbe?.duration ?? browserMeta.duration ?? 0),
            nativeFps,
            nativeFrameCount,
            probeMethod: serverProbe?.probe_method || "browser_estimate",
        };

        if (syncNativeFps && nativeFps > 0) {
            this.syncFrameRateUI(nativeFps);
        }

        const fps = this.getFrameRate();
        const totalFrames = Math.max(
            1,
            Math.round(meta.duration * fps) || nativeFrameCount,
        );

        const store = resolveOutputDimensions(meta.width, meta.height, this.timeline.output || { mode: "long_edge", longEdge: 864 }, {
            refMaxSize: this.refMaxWidget?.value,
        });

        return { fileName, relPath, subfolder, type, meta, totalFrames, store, viewUrl };
    }

    async probeVideoFile(relPath, subfolder = "", type = "input") {
        const resp = await api.fetchApi("/minimax/director/probe_video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoFile: relPath, subfolder, type: type || "input" }),
        });
        if (!resp.ok) {
            throw new Error(await resp.text());
        }
        return resp.json();
    }

    _buildClipRecord({ fileName, relPath, subfolder, type, meta, totalFrames, store }) {
        return {
            id: uid(),
            fileName,
            videoFile: relPath,
            subfolder: subfolder || "",
            type: type || "input",
            width: meta.width,
            height: meta.height,
            duration: meta.duration,
            nativeFps: meta.nativeFps || null,
            nativeFrameCount: meta.nativeFrameCount || null,
            sourceFrameCount: totalFrames,
            storageWidth: store.width,
            storageHeight: store.height,
        };
    }

    _syncPrimaryVideoFromClips(frameMap) {
        const clips = this.getVideoClips();
        const primary = clips[0] || {};
        const prev = this.timeline.video || {};
        const map = Array.isArray(frameMap) ? frameMap : (prev.frameMap || []);
        this.timeline.video = {
            ...prev,
            ...primary,
            // Keep path/type from the clip record, but never drop timeline edits.
            fileName: primary.fileName || prev.fileName || "",
            videoFile: primary.videoFile || prev.videoFile || "",
            subfolder: primary.subfolder ?? prev.subfolder ?? "",
            type: primary.type || prev.type || "input",
            frames: prev.frames || [],
            frameMap: map,
            // Explicit map already encodes deletes; sparse mode keeps ranges.
            deletedSourceRanges: map.length ? [] : (prev.deletedSourceRanges || []),
            sourceFrameCount: prev.sourceFrameCount || primary.sourceFrameCount || map.length || 0,
        };
        if (map.length) this.timeline.totalFrames = map.length;
    }

    async _applyLoadedVideo({ fileName, relPath, subfolder, type, statusPrefix }) {
        const prep = await this._prepareVideoFrames({ fileName, relPath, subfolder, type, statusPrefix });
        const { totalFrames, store, viewUrl } = prep;

        this._storageWidth = store.width;
        this._storageHeight = store.height;
        const clip = this._buildClipRecord(prep);

        this.timeline.videoClips = [clip];
        this.setSparseVideoFrames(totalFrames);
        this._syncPrimaryVideoFromClips([]);
        this._setSingleSegment(totalFrames);

        this._clearPreviewVideos(true);
        this._previewVideo = this._getPreviewVideoForClip(0);
        if (this._previewVideo && viewUrl) this._previewVideo.src = viewUrl;

        // Force stage to drop any previous media before binding the new clip.
        this._stageClipIndex = -1;
        if (this.stageVideo) {
            this.stageVideo.pause();
            this.stageVideo.removeAttribute("src");
            this.stageVideo.load();
        }
        this.currentFrame = 0;

        if (this.totalFramesWidget) this.totalFramesWidget.value = totalFrames;
        this.syncOutputUIFromTimeline();
        this.updateVideoNameLabel();
        this._prefetchSegmentThumbs(0, Math.min(totalFrames, THUMB_PREFETCH_BATCH * 4));
        this.updateStageVisibility();
        this._syncStagePreview(0, { force: true });
        this.commit(false, { syncTimeline: true });
    }

    async _applyAppendedVideo({ fileName, relPath, subfolder, type, statusPrefix }) {
        const prep = await this._prepareVideoFrames({
            fileName, relPath, subfolder, type, statusPrefix,
            syncNativeFps: false,
        });
        const { totalFrames, store } = prep;

        this._ensureVideoClipsArray();
        const clipIndex = this.timeline.videoClips.length;
        const clip = this._buildClipRecord(prep);
        this.timeline.videoClips.push(clip);

        const prevTotal = this.getTotalFrames();
        if (!this.getFrameMap().length && prevTotal > 0) {
            this.materializeFrameMap();
        }
        const newEntries = buildClipFrameMap(clipIndex, totalFrames);
        const map = [...this.getFrameMap(), ...newEntries];
        this.setFrameMap(map);
        this.timeline.totalFrames = map.length;
        this._syncPrimaryVideoFromClips(map);

        this._getPreviewVideoForClip(clipIndex);

        this.timeline.segments.push({
            id: uid(),
            start: prevTotal,
            length: totalFrames,
            prompt: "",
            taskType: "",
            refs: [],
            referenceVideo: {},
            videoClipId: clip.id,
        });

        if (this.totalFramesWidget) this.totalFramesWidget.value = map.length;
        this.selectedIndex = this.timeline.segments.length - 1;
        this.currentFrame = prevTotal;
        if (this.seekBar) {
            this.seekBar.max = Math.max(0, map.length - 1);
            this.seekBar.value = this.currentFrame;
        }

        this.normalizeSegments();
        this.syncOutputUIFromTimeline();
        this.updateVideoNameLabel();
        this._prefetchSegmentThumbs(prevTotal, Math.min(prevTotal + totalFrames, prevTotal + THUMB_PREFETCH_BATCH * 4));
        this.updateStageVisibility();
        this.commit(false, { syncTimeline: true });
    }

    async probeVideoMetadata(url) {
        const video = document.createElement("video");
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        await new Promise((res, rej) => {
            video.onloadedmetadata = () => res();
            video.onerror = () => rej(new Error("无法读取视频元数据"));
        });
        return {
            width: video.videoWidth || 0,
            height: video.videoHeight || 0,
            duration: video.duration || 0,
        };
    }

    onNodeResize() {
        if (this.isPlaying || this._pauseSettling) return;
        this._resetLayoutStyles();
        this.applyZoomWidth();
        this.scheduleRender();
    }

    applyZoomWidth() {
        if (!this.canvas) return;
        if (this.zoom <= 1) {
            this.canvas.style.width = "100%";
            return;
        }
        const base = this.viewport?.clientWidth || 960;
        this.canvas.style.width = `${Math.max(base, base * this.zoom)}px`;
    }

    adjustZoom(delta) {
        this.zoom = clamp(this.zoom + delta, 1, 10);
        this.zoomSlider.value = this.zoom;
        this.applyZoomWidth();
        this.scheduleRender();
    }

    frameToX(frame, width) { return (frame / Math.max(1, this.getTotalFrames())) * width; }
    xToFrame(x, width) { return clamp(Math.round((x / width) * this.getTotalFrames()), 0, this.getTotalFrames()); }

    getLayoutWidth() {
        return this._drawWidth
            || this.canvas?.getBoundingClientRect().width
            || this.canvas?.offsetWidth
            || this.viewport?.clientWidth
            || 0;
    }

    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        const layoutW = this.getLayoutWidth();
        const layoutH = this.canvasHeight || (RULER_H + SEG_LABEL_H + TRACK_H);
        const scaleX = rect.width > 0 ? layoutW / rect.width : 1;
        const scaleY = rect.height > 0 ? layoutH / rect.height : 1;
        return {
            x: (e.clientX - rect.left) * scaleX,
            y: (e.clientY - rect.top) * scaleY,
        };
    }

    /** Shared draw + hit geometry for per-segment run checkboxes (segment top-left). */
    _runCheckGeometry(seg, width) {
        const x0 = this.frameToX(seg.start, width);
        const size = RUN_CHECK_SIZE;
        const boxX = x0 + 5;
        const boxY = TRACK_Y + 5;
        return {
            boxX,
            boxY,
            size,
            hitX0: boxX - RUN_CHECK_HIT_PAD_X,
            hitY0: boxY - RUN_CHECK_HIT_PAD_Y,
            hitX1: boxX + size + RUN_CHECK_HIT_PAD_X,
            hitY1: boxY + size + RUN_CHECK_HIT_PAD_Y,
        };
    }

    /** Draw fl2v edge grips; joints are split (top=prev yellow, bottom=next cyan). */
    _drawFl2vEdgeHandles(segs, index, x0, x1, width) {
        const ordered = (segs || [])
            .map((seg, i) => ({ seg, i }))
            .sort((a, b) => a.seg.start - b.seg.start || a.i - b.i);
        const rank = ordered.findIndex((o) => o.i === index);
        if (rank < 0) return;
        const prev = rank > 0 ? ordered[rank - 1] : null;
        const next = rank < ordered.length - 1 ? ordered[rank + 1] : null;
        const prevX1 = prev
            ? this.frameToX(prev.seg.start + prev.seg.length, width)
            : null;
        const nextX0 = next ? this.frameToX(next.seg.start, width) : null;
        const jointLeft = prev != null && Math.abs(prevX1 - x0) <= 2;
        const jointRight = next != null && Math.abs(nextX0 - x1) <= 2;
        const mid = TRACK_Y + TRACK_H / 2;
        const half = Math.max(10, TRACK_H / 2 - 6);

        if (!jointLeft) {
            this.ctx.fillStyle = "#ffcc00";
            this.ctx.fillRect(x0 - 2, mid - 12, 4, 24);
        }
        if (jointRight) {
            // Draw once on the left segment of the joint.
            this.ctx.fillStyle = "#ffcc00";
            this.ctx.fillRect(x1 - 2, TRACK_Y + 4, 4, half);
            this.ctx.fillStyle = "#5ec8ff";
            this.ctx.fillRect(x1 - 2, mid + 2, 4, half);
            this.ctx.fillStyle = "rgba(255,255,255,0.85)";
            this.ctx.fillRect(x1 - 3, mid - 1, 6, 2);
        } else {
            this.ctx.fillStyle = "#ffcc00";
            this.ctx.fillRect(x1 - 2, mid - 12, 4, 24);
        }
    }

    /**
     * fl2v edge handles: top half → previous clip's right edge;
     * bottom half → next clip's left edge.
     */
    _hitTestFl2vEdge(x, y, width, segs) {
        const ordered = (segs || [])
            .map((seg, index) => ({ seg, index }))
            .sort((a, b) => a.seg.start - b.seg.start || a.index - b.index);
        if (!ordered.length) return null;
        const trackMid = TRACK_Y + TRACK_H / 2;
        const preferNext = y >= trackMid;
        let best = null;
        let bestDist = HANDLE_PX + 1;

        for (let r = 0; r < ordered.length; r++) {
            const { seg, index } = ordered[r];
            const x0 = this.frameToX(seg.start, width);
            const x1 = this.frameToX(seg.start + seg.length, width);
            const prev = r > 0 ? ordered[r - 1] : null;
            const next = r < ordered.length - 1 ? ordered[r + 1] : null;
            const prevX1 = prev
                ? this.frameToX(prev.seg.start + prev.seg.length, width)
                : null;
            const nextX0 = next ? this.frameToX(next.seg.start, width) : null;
            const jointLeft = prev != null && Math.abs(prevX1 - x0) <= 2;
            const jointRight = next != null && Math.abs(nextX0 - x1) <= 2;

            const d0 = Math.abs(x - x0);
            if (d0 <= HANDLE_PX && d0 < bestDist) {
                if (jointLeft) {
                    best = preferNext
                        ? { type: "edge", index, edge: "left" }
                        : { type: "edge", index: prev.index, edge: "right" };
                } else {
                    best = { type: "edge", index, edge: "left" };
                }
                bestDist = d0;
            }
            const d1 = Math.abs(x - x1);
            if (d1 <= HANDLE_PX && d1 < bestDist) {
                if (jointRight) {
                    best = preferNext
                        ? { type: "edge", index: next.index, edge: "left" }
                        : { type: "edge", index, edge: "right" };
                } else {
                    best = { type: "edge", index, edge: "right" };
                }
                bestDist = d1;
            }
        }
        return best;
    }

    hitTest(x, y) {
        const width = this.getLayoutWidth();
        if (!width) return null;
        const segs = this._previewSegments || this.timeline.segments;
        const phx = this.frameToX(this.currentFrame, width);
        const trackBottom = TRACK_Y + TRACK_H;

        if (y <= RULER_H) {
            if (Math.abs(x - phx) <= HANDLE_PX) return { type: "playhead" };
            return { type: "ruler" };
        }

        // Checkbox corner wins over generic segment hit (same toggle action either way
        // in run-select mode; keeps hit type accurate for cursor / future hooks).
        if (this.isRunSelectEnabled() && this.getRunnableSegmentCount() >= 2 && y >= TRACK_Y && y <= trackBottom) {
            for (let i = segs.length - 1; i >= 0; i--) {
                if (this.isFl2vMode() && !segs[i]?.isStartFrame) continue;
                const g = this._runCheckGeometry(segs[i], width);
                if (x >= g.hitX0 && x <= g.hitX1 && y >= g.hitY0 && y <= g.hitY1) {
                    return { type: "run-check", index: i };
                }
            }
        }

        // Split markers: label band + full track height, before segment/edge hits.
        // (Previously label band returned null, so diamond clicks never registered.)
        if (y >= RULER_H && y <= trackBottom) {
            const hitPad = Math.max(HANDLE_PX, 12);
            let best = null;
            let bestDist = hitPad + 1;
            for (const frame of this.getEditableSplitFrames()) {
                const sx = this.frameToX(frame, width);
                const dist = Math.abs(x - sx);
                if (dist <= hitPad && dist < bestDist) {
                    bestDist = dist;
                    best = { type: "split", frame };
                }
            }
            if (best) return best;
        }

        if (y < TRACK_Y) return null;

        // Edge handles first so fl2v/gen can drag-extend duration (repeat thumbs).
        if (y >= TRACK_Y && y <= trackBottom) {
            if (this.isFl2vMode()) {
                const flHit = this._hitTestFl2vEdge(x, y, width, segs);
                if (flHit) return flHit;
            } else {
                for (let i = 0; i < segs.length; i++) {
                    const seg = segs[i];
                    const x0 = this.frameToX(seg.start, width);
                    const x1 = this.frameToX(seg.start + seg.length, width);
                    if (Math.abs(x - x0) <= HANDLE_PX) return { type: "edge", index: i, edge: "left" };
                    if (Math.abs(x - x1) <= HANDLE_PX) return { type: "edge", index: i, edge: "right" };
                }
            }
        }

        for (let i = segs.length - 1; i >= 0; i--) {
            const seg = segs[i];
            const x0 = this.frameToX(seg.start, width);
            const x1 = this.frameToX(seg.start + seg.length, width);
            const isLast = i === segs.length - 1;
            const insideX = isLast ? (x >= x0 && x <= x1) : (x >= x0 && x < x1);
            if (insideX && y >= TRACK_Y && y <= trackBottom) {
                return { type: "segment", index: i };
            }
        }

        if (Math.abs(x - phx) <= HANDLE_PX) return { type: "playhead" };
        return null;
    }

    onMouseDown(e) {
        if (e.button !== 0) return;
        // Keep LiteGraph / node drag from eating timeline clicks.
        stopDomEvent(e);
        e.preventDefault();
        const { x, y } = this.getMousePos(e);
        const hit = this.hitTest(x, y);
        if (!hit) {
            if (
                this.isFl2vMode()
                && !(this.timeline.segments || []).length
                && y >= TRACK_Y
                && y <= TRACK_Y + TRACK_H
            ) {
                openFl2vUpload(this);
            } else if (
                this.isR2vBatch()
                && !(this.timeline.segments || []).length
                && y >= TRACK_Y
                && y <= TRACK_Y + TRACK_H
            ) {
                addImageBatchGroup(this);
            }
            return;
        }
        const width = this.getLayoutWidth();
        if (hit.type === "playhead" || hit.type === "ruler") {
            this.currentFrame = this.xToFrame(x, width);
            this._drag = { kind: "playhead" };
            this.clearSplitSelection();
        } else if (hit.type === "run-check") {
            this.toggleSegmentRun(hit.index);
            this._drag = null;
        } else if (hit.type === "split") {
            this.selectSplitFrame(hit.frame);
            this._drag = null;
        } else if (hit.type === "segment") {
            if (this.isFl2vMode() && hit.index !== this.selectedIndex) {
                flushFl2vPromptDraft(this);
            }
            this.selectedIndex = hit.index;
            this.clearSplitSelection();
            this.updateSelectionUI();
            if (this.isFl2vMode() || this.isR2vBatch() || this.timeline.segments.length >= 2) {
                // Drag body to reorder / swap clip positions; edges still resize.
                this._drag = {
                    kind: "segment-pending",
                    index: hit.index,
                    x0: x,
                    y0: y,
                    fromRank: this._visualRankFromArrayIndex(hit.index),
                };
            } else {
                this._drag = { kind: "segment" };
            }
        } else if (hit.type === "edge") {
            if (this.isFl2vMode() && hit.index !== this.selectedIndex) {
                flushFl2vPromptDraft(this);
            }
            this.selectedIndex = hit.index;
            this.clearSplitSelection();
            this.updateSelectionUI();
            this._drag = { kind: "edge", index: hit.index, edge: hit.edge };
            this._edgeSnapshot = JSON.parse(JSON.stringify(this.timeline.segments));
        }
        this.scheduleRender();
    }

    onMouseMove(e) {
        if (!this._drag) return;
        const { x, y } = this.getMousePos(e);
        const width = this.getLayoutWidth();
        const frame = this.xToFrame(x, width);

        if (this._drag.kind === "segment-pending") {
            if (Math.hypot(x - this._drag.x0, y - this._drag.y0) > 6) {
                this._drag = {
                    kind: "reorder",
                    fromRank: this._drag.fromRank,
                    index: this._drag.index,
                    pointerX: x,
                    pointerY: y,
                    originX: this._drag.x0,
                    originY: this._drag.y0,
                };
                this._reorderFromRank = this._drag.fromRank;
                this._reorderDropRank = this._drag.fromRank;
                this.canvas.classList.add("bd-grabbing");
                this.canvas.style.cursor = "grabbing";
            }
            return;
        }

        if (this._drag.kind === "playhead") {
            this.currentFrame = frame;
        } else if (this._drag.kind === "reorder") {
            this._drag.pointerX = x;
            this._drag.pointerY = y;
            this._reorderDropRank = this._computeReorderDropRank(frame, this._drag.fromRank);
            this.scheduleRender();
            return;
        } else if (this._drag.kind === "fl2v-move") {
            // Block-move: this clip + all later clips shift together (LTX ripple).
            const snap = this._edgeSnapshot || this.timeline.segments;
            const segs = snap.map((s) => ({ ...s }));
            const i = this._drag.index;
            const seg = segs[i];
            if (!seg) return;
            const width = this.getLayoutWidth();
            const frame0 = this.xToFrame(this._drag.x0, width);
            let delta = frame - frame0;
            const ordered = segs
                .map((s, idx) => ({ s, idx }))
                .sort((a, b) => a.s.start - b.s.start || a.idx - b.idx);
            const rank = ordered.findIndex((o) => o.s.id === seg.id);
            if (rank < 0) return;
            const prev = rank > 0 ? ordered[rank - 1].s : null;
            const minStart = prev ? prev.start + prev.length : 0;
            const desired = this._drag.start0 + delta;
            const clampedStart = Math.max(minStart, desired);
            delta = clampedStart - this._drag.start0;
            for (let r = rank; r < ordered.length; r++) {
                const orig = snap.find((x) => x.id === ordered[r].s.id) || ordered[r].s;
                ordered[r].s.start = Math.max(0, (parseInt(orig.start, 10) || 0) + delta);
                ordered[r].s.length = Math.max(minFrameCount("fl2v"), parseInt(orig.length, 10) || minFrameCount("fl2v"));
                ordered[r].s.frameCount = ordered[r].s.length;
            }
            this._previewSegments = segs;
        } else if (this._drag.kind === "edge") {
            const segs = this._edgeSnapshot.map((s) => ({ ...s }));
            const i = this._drag.index;
            const seg = segs[i];
            const isFl2v = this.isFl2vMode();
            const isGen = this.isGenMode();
            const isR2v = this.isR2vBatch();
            const minLen = (isFl2v || isGen || isR2v) ? minFrameCount(this.getTaskKey()) : MIN_SEG;
            if (isFl2v) {
                // LTX-style ripple: resize this clip's right edge and shift ALL later clips.
                // Left edge of a non-first clip = ripple the previous clip's right edge.
                // May extend past the sampling window (dashed overflow, not sampled).
                const ordered = [...segs]
                    .map((s, idx) => ({ s, idx }))
                    .sort((a, b) => a.s.start - b.s.start || a.idx - b.idx);
                const rank = ordered.findIndex((o) => o.s.id === seg.id);
                if (this._drag.edge === "right") {
                    const newEnd = Math.max(seg.start + minLen, frame);
                    rippleFl2vRightEdge(segs, i, newEnd, minLen, this);
                } else if (this._drag.edge === "left") {
                    if (rank > 0) {
                        const prevIdx = ordered[rank - 1].idx;
                        const prev = ordered[rank - 1].s;
                        const newEnd = Math.max(prev.start + minLen, frame);
                        rippleFl2vRightEdge(segs, prevIdx, newEnd, minLen, this);
                    }
                    // First clip's left edge stays at 0 (no negative timeline).
                }
            } else if (this._drag.edge === "left") {
                const prev = segs[i - 1];
                const minStart = prev ? prev.start + minLen : 0;
                const maxStart = seg.start + seg.length - minLen;
                seg.start = clamp(frame, minStart, maxStart);
                seg.length = (this._edgeSnapshot[i].start + this._edgeSnapshot[i].length) - seg.start;
                if (isGen || isR2v) seg.frameCount = seg.length;
                if (prev) {
                    prev.length = seg.start - prev.start;
                    if (isGen || isR2v) prev.frameCount = prev.length;
                }
            } else {
                const next = segs[i + 1];
                const minEnd = seg.start + minLen;
                let maxEnd;
                if (next) {
                    maxEnd = this._edgeSnapshot[i + 1].start + this._edgeSnapshot[i + 1].length;
                    if (isGen || isR2v) maxEnd -= minLen;
                } else if (isGen || isR2v) {
                    maxEnd = seg.start + MAX_GEN_FRAMES;
                } else {
                    maxEnd = this.getTotalFrames();
                }
                const end = clamp(frame, minEnd, maxEnd);
                seg.length = end - seg.start;
                if (isGen || isR2v) seg.frameCount = seg.length;
                if (next) {
                    next.start = end;
                    next.length = (this._edgeSnapshot[i + 1].start + this._edgeSnapshot[i + 1].length) - end;
                    if (isGen || isR2v) next.frameCount = next.length;
                }
            }
            this._previewSegments = segs;
        }
        this.scheduleRender();
    }

    onMouseUp() {
        if (
            (this._drag?.kind === "edge" || this._drag?.kind === "fl2v-move")
            && this._previewSegments
        ) {
            const preview = this._previewSegments;
            this._previewSegments = null;
            if (this.isFl2vMode()) {
                // Shot durations already updated during drag; rebuild layout from shots.
                syncFl2vDurationSecAfterDrag(this);
                updateFl2vDetailUI(this);
                this.updateVideoNameLabel();
            } else if (this.isR2vBatch()) {
                this.timeline.segments = preview;
                for (const seg of this.timeline.segments) {
                    const fc = Math.max(1, parseInt(seg.frameCount ?? seg.length, 10) || 1);
                    seg.frameCount = fc;
                    seg.length = fc;
                    seg.durationSec = Math.round(framesToDurationSec(fc, 24) * 100) / 100;
                }
                normalizeImageBatchSegments(this);
                this.renderImageBatchGroups();
                this.updateVideoNameLabel();
            } else {
                this.timeline.segments = preview;
            }
            this.commit();
        } else if (this._drag?.kind === "reorder") {
            const toRank = this._reorderDropRank;
            if (toRank >= 0 && toRank !== this._drag.fromRank) {
                this.reorderSegmentsByRank(this._drag.fromRank, toRank);
                this.commit(false, { syncTimeline: true });
                if (this.isFl2vMode()) {
                    updateFl2vDetailUI(this);
                    this.updateVideoNameLabel();
                } else if (this.isR2vBatch()) {
                    this.renderImageBatchGroups();
                    this.updateVideoNameLabel();
                }
            }
            this._reorderDropRank = -1;
            this._reorderFromRank = -1;
            this.canvas.classList.remove("bd-grabbing");
            this.canvas.style.cursor = "";
        } else if (this._drag) {
            this.seekBar.value = this.currentFrame;
            this.scheduleRender();
        }
        this._drag = null;
        this._edgeSnapshot = null;
    }

    addSplitAtMouse(e) {
        const { x } = this.getMousePos(e);
        this.splitAtFrame(this.xToFrame(x, this.getLayoutWidth()));
    }

    splitAtFrame(frame) {
        if (this.isGenMode()) {
            this.genSplitAtFrame(frame);
            return;
        }
        const total = this.getTotalFrames();
        if (frame <= MIN_SEG || frame >= total - MIN_SEG) return;
        const newSegs = [];
        for (const seg of [...this.timeline.segments].sort((a, b) => a.start - b.start)) {
            const end = seg.start + seg.length;
            if (frame > seg.start && frame < end) {
                newSegs.push({ ...seg, length: frame - seg.start });
                newSegs.push({ id: uid(), start: frame, length: end - frame, prompt: "", taskType: "", refs: [], referenceVideo: {} });
            } else newSegs.push({ ...seg });
        }
        this.timeline.segments = newSegs;
        this.selectedSplitFrame = null;
        this.commit();
        this.updateSplitPointUI();
    }

    equalSplit() {
        if (this.isGenMode()) {
            this.genEqualSplit();
            return;
        }
        const n = parseInt(this.equalCountInput?.value || "2", 10);
        if (!n || n < 2) return;
        const total = this.getTotalFrames();
        if (total < MIN_SEG * 2) return;
        const maxSeg = Math.floor(total / MIN_SEG);
        const count = clamp(n, 2, Math.max(2, maxSeg || 2));
        if (this.equalCountInput) this.equalCountInput.value = String(count);

        const points = new Set([0, total]);
        const clipBounds = this.getClipBoundaries();
        for (const b of clipBounds) {
            if (b > 0 && b < total) points.add(b);
        }
        for (let i = 1; i < count; i++) {
            const p = Math.round((i * total) / count);
            if (p > 0 && p < total) points.add(p);
        }

        const forced = new Set([0, total, ...clipBounds]);
        const newSegs = this._buildSegmentsFromSplitPoints([...points], forced);
        if (!newSegs?.length) return;
        this.timeline.segments = newSegs;
        this.selectedSplitFrame = null;
        this.commit();
        this.updateSplitPointUI();
    }

    /** Logical ranges for each video clip on the timeline. */
    getClipLogicalRanges() {
        const clips = this.getVideoClips();
        const total = this.getTotalFrames();
        if (!clips.length) return [];
        const map = this.getFrameMap();
        if (map.length) {
            const ranges = clips.map((clip, clipIndex) => ({
                clip,
                clipIndex,
                start: total,
                end: 0,
            }));
            for (let i = 0; i < map.length; i++) {
                const entry = normalizeFrameMapEntry(map[i]);
                const r = ranges[entry.clip];
                if (!r) continue;
                if (i < r.start) r.start = i;
                if (i + 1 > r.end) r.end = i + 1;
            }
            return ranges.filter((r) => r.end > r.start);
        }
        if (clips.length === 1) {
            return [{ clip: clips[0], clipIndex: 0, start: 0, end: total }];
        }
        let cursor = 0;
        return clips.map((clip, clipIndex) => {
            const len = Math.max(0, parseInt(clip.sourceFrameCount, 10) || 0);
            const start = cursor;
            const end = Math.min(total, cursor + len);
            cursor = end;
            return { clip, clipIndex, start, end };
        }).filter((r) => r.end > r.start);
    }

    /** Interior segment boundaries that can be selected/deleted (not clip seams). */
    getEditableSplitFrames() {
        if (this.isFl2vMode() || this.isGenMode() || this.isImageBatch()) return [];
        const total = this.getTotalFrames();
        if (total < MIN_SEG * 2) return [];
        const forced = new Set([0, total, ...this.getClipBoundaries()]);
        const segs = this._previewSegments || this.timeline.segments || [];
        const points = [];
        for (const seg of segs) {
            const start = Math.max(0, parseInt(seg.start, 10) || 0);
            if (start > 0 && start < total && !forced.has(start)) points.push(start);
        }
        return [...new Set(points)].sort((a, b) => a - b);
    }

    selectSplitFrame(frame) {
        const editable = this.getEditableSplitFrames();
        const n = Number(frame);
        if (!Number.isFinite(n) || !editable.includes(n)) {
            this.selectedSplitFrame = null;
        } else {
            // Toggle off if clicking the same selected split again.
            this.selectedSplitFrame = this.selectedSplitFrame === n ? null : n;
            if (this.selectedSplitFrame != null) {
                const segs = this.timeline.segments || [];
                const idx = segs.findIndex((s) => (parseInt(s.start, 10) || 0) === n);
                if (idx >= 0) this.selectedIndex = idx;
            }
        }
        this.updateSplitPointUI();
        this.updateSelectionUI();
        this.scheduleRender();
    }

    clearSplitSelection() {
        if (this.selectedSplitFrame == null) return;
        this.selectedSplitFrame = null;
        this.updateSplitPointUI();
        this.scheduleRender();
    }

    updateSplitPointUI() {
        const bar = this.splitEditBarEl || this.root?.querySelector('[data-r="split-edit-bar"]');
        const hint = this.splitEditHintEl || this.root?.querySelector('[data-r="split-edit-hint"]');
        const btn = this.root?.querySelector('[data-a="del-split"]');
        if (this.isImageBatch() || this.isGenMode()) {
            bar?.classList.add("hidden");
            return;
        }
        const has = this.selectedSplitFrame != null
            && this.getEditableSplitFrames().includes(this.selectedSplitFrame);
        if (bar) bar.classList.toggle("hidden", !has);
        if (hint && has) {
            hint.textContent = `已选中分割点（帧 ${this.selectedSplitFrame}）。点击右侧按钮删除并合并相邻段。`;
        }
        if (btn) {
            btn.disabled = !has;
            btn.title = has
                ? `删除选中分割点（帧 ${this.selectedSplitFrame}），合并相邻两段`
                : "先点击青色分割点选中";
        }
        if (has && this.boundsEl) {
            this.boundsEl.textContent = `已选中分割点: 帧 ${this.selectedSplitFrame}`;
        }
    }

    deleteSelectedSplitPoint() {
        if (this.isGenMode() || this.isImageBatch()) return;
        const frame = this.selectedSplitFrame;
        if (frame == null) return;
        if (!this.getEditableSplitFrames().includes(frame)) {
            this.clearSplitSelection();
            return;
        }
        const segs = [...(this.timeline.segments || [])].sort((a, b) => a.start - b.start);
        const rightIdx = segs.findIndex((s) => (parseInt(s.start, 10) || 0) === frame);
        if (rightIdx <= 0) {
            this.clearSplitSelection();
            return;
        }
        const left = segs[rightIdx - 1];
        const right = segs[rightIdx];
        left.length = (parseInt(left.length, 10) || 0) + (parseInt(right.length, 10) || 0);
        segs.splice(rightIdx, 1);
        this.timeline.segments = segs;
        this.selectedSplitFrame = null;
        this.selectedIndex = Math.max(0, rightIdx - 1);
        this.commit();
        this.updateSelectionUI();
        this.updateSplitPointUI();
        this.setSmartSplitMessage("");
        this.scheduleRender();
    }

    setSmartSplitMessage(text, { ok = false } = {}) {
        const el = this.smartSplitMsgEl || this.root?.querySelector('[data-r="smart-split-msg"]');
        if (!el) return;
        const msg = String(text || "").trim();
        if (!msg) {
            el.textContent = "";
            el.classList.add("hidden");
            el.classList.remove("ok");
            return;
        }
        el.textContent = msg;
        el.classList.toggle("ok", !!ok);
        el.classList.remove("hidden");
    }

    async smartSplit() {
        if (this.isGenMode() || this.isImageBatch()) return;
        if (!this.hasVideo()) {
            this.setSmartSplitMessage("请先上传视频后再使用智能分割。");
            return;
        }
        const total = this.getTotalFrames();
        if (total < MIN_SEG * 2) {
            this.setSmartSplitMessage("视频太短，无法智能分割。");
            return;
        }
        const ranges = this.getClipLogicalRanges();
        if (!ranges.length) {
            this.setSmartSplitMessage("未找到可用的视频素材。");
            return;
        }
        const btn = this.root?.querySelector('[data-a="smart-split"]');
        const prevLabel = btn?.textContent;
        if (btn) {
            btn.disabled = true;
            btn.textContent = "分析中…";
        }
        this.setSmartSplitMessage("正在分析分镜…");
        try {
            const clips = ranges.map((r) => ({
                videoFile: r.clip.videoFile || r.clip.fileName,
                subfolder: r.clip.subfolder || "",
                type: r.clip.type || "input",
                logicalStart: r.start,
                logicalEnd: r.end,
                nativeFps: r.clip.nativeFps || r.clip.native_fps || null,
            }));
            const resp = await api.fetchApi("/minimax/director/detect_shots", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    clips,
                    frameRate: this.getFrameRate(),
                    totalFrames: total,
                    sensitivity: "medium",
                    minShotFrames: Math.max(MIN_SEG, 12),
                }),
            });
            if (!resp.ok) {
                throw new Error((await resp.text()) || `HTTP ${resp.status}`);
            }
            const data = await resp.json();
            const cutFrames = Array.isArray(data.cutFrames) ? data.cutFrames.map((n) => parseInt(n, 10) || 0) : [];
            const points = new Set([0, total, ...cutFrames.filter((f) => f > 0 && f < total)]);
            const clipBounds = this.getClipBoundaries();
            for (const b of clipBounds) {
                if (b > 0 && b < total) points.add(b);
            }
            const forced = new Set([0, total, ...clipBounds]);
            const newSegs = this._buildSegmentsFromSplitPoints([...points], forced);
            if (!newSegs?.length) {
                this.setSmartSplitMessage("智能分割未生成有效片段。");
                return;
            }
            this.timeline.segments = newSegs;
            this.selectedIndex = 0;
            this.selectedSplitFrame = null;
            this.commit();
            this.updateSelectionUI();
            this.updateSplitPointUI();
            const shotCount = data.shotCount ?? Math.max(0, newSegs.length);
            const warn = Array.isArray(data.warnings) && data.warnings.length
                ? ` ${data.warnings[0]}`
                : "";
            this.setSmartSplitMessage(
                `完成：约 ${shotCount} 个镜头 → ${newSegs.length} 段。您也可以根据自己的需要，选择分割点进行删除，或者手动增加分割点。${warn}`,
                { ok: !warn },
            );
        } catch (err) {
            console.error("[MiniMax H3 Director] smartSplit failed", err);
            this.setSmartSplitMessage(`智能分割失败：${err?.message || err}`);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = prevLabel || "智能分割";
            }
        }
    }

    deleteSelectedSegment() {
        if (this.isGenMode()) {
            this.genDeleteSelectedSegment();
            return;
        }
        if (this.isR2vBatch()) {
            deleteImageBatchGroup(this, this.selectedIndex);
            this.currentFrame = clamp(this.currentFrame, 0, Math.max(0, this.getTotalFrames() - 1));
            if (this.seekBar) {
                this.seekBar.max = Math.max(0, this.getTotalFrames() - 1);
                this.seekBar.value = this.currentFrame;
            }
            this.updateVideoNameLabel();
            this.updateDomWidgetHeight();
            this.scheduleRender();
            return;
        }
        if (this.isImageBatch()) {
            this.genDeleteSelectedSegment();
            return;
        }
        if (this.isFl2vMode()) {
            const idx = this.selectedIndex;
            const shots = this.timeline.shots || [];
            if (!shots[idx] && !(this.timeline.segments || [])[idx]) return;
            removeFl2vShot(this, idx);
            this.currentFrame = clamp(this.currentFrame, 0, Math.max(0, this.getTotalFrames() - 1));
            if (this.seekBar) {
                this.seekBar.max = Math.max(0, this.getTotalFrames() - 1);
                this.seekBar.value = this.currentFrame;
            }
            this.commit(false, { syncTimeline: true });
            updateFl2vDetailUI(this);
            this.updateVideoNameLabel();
            this.updateDomWidgetHeight();
            return;
        }
        const idx = this.selectedIndex;
        const seg = this.timeline.segments[idx];
        if (!seg) return;

        const start = Math.max(0, parseInt(seg.start, 10) || 0);
        const len = Math.max(0, parseInt(seg.length, 10) || 0);
        this.selectedSplitFrame = null;

        // Remove segment UI entry first, then cut matching frames from the
        // logical timeline so preview / export no longer include that range.
        this.timeline.segments.splice(idx, 1);

        let total = this.getTotalFrames();
        let map = [];
        if (len > 0 && total > 0) {
            // Sparse uploads start with an empty frameMap; materialize so we can
            // splice out the deleted range from the source-frame mapping.
            if (!this.getFrameMap().length) this.materializeFrameMap();
            map = [...this.getFrameMap()];
            if (map.length) {
                const from = clamp(start, 0, map.length);
                const count = clamp(len, 0, map.length - from);
                if (count > 0) map.splice(from, count);
                this.setFrameMap(map);
                this._syncPrimaryVideoFromClips(map);
                total = map.length;
            } else {
                // Fallback: record deleted source ranges (kept across sync).
                const video = this.timeline.video || {};
                video.deletedSourceRanges = video.deletedSourceRanges || [];
                const srcStart = this.logicalToSourceFrame(start);
                video.deletedSourceRanges.push([srcStart, srcStart + len]);
                video.deletedSourceRanges.sort((a, b) => a[0] - b[0]);
                this.timeline.video = video;
                total = this.getTotalFrames();
                this.timeline.totalFrames = total;
                this._syncPrimaryVideoFromClips([]);
            }
        }

        this._thumbCache.clear();
        this._thumbPending.clear();
        // Invalidate stashed workspace — it still contains the deleted range.
        this.timeline.videoWorkspace = null;

        if (this.totalFramesWidget) this.totalFramesWidget.value = total;

        this.compactSegmentsAfterDelete();

        this.selectedIndex = clamp(idx, 0, Math.max(0, this.timeline.segments.length - 1));
        this.currentFrame = clamp(this.currentFrame, 0, Math.max(0, total - 1));
        if (this.seekBar) {
            this.seekBar.max = Math.max(0, total - 1);
            this.seekBar.value = this.currentFrame;
        }

        if (!total) {
            this.videoNameEl.textContent = "未上传视频";
            this.timeline.videoClips = [];
            this.timeline.video = {
                fileName: "",
                videoFile: "",
                subfolder: "",
                type: "input",
                frames: [],
                frameMap: [],
                width: 0,
                height: 0,
            };
            this._clearVideoState();
        } else {
            this.updateVideoNameLabel();
            this._prefetchSegmentThumbs(0, Math.min(total, THUMB_PREFETCH_BATCH * 4));
            this._syncStagePreview(this.currentFrame, { force: true });
            this.updateStageVisibility();
        }

        this.commit(false, { syncTimeline: true });
    }

    compactSegmentsAfterDelete() {
        const total = this.getTotalFrames();
        if (total <= 0) {
            this.timeline.segments = [];
            return;
        }
        const segs = [...this.timeline.segments].sort((a, b) => a.start - b.start);
        if (!segs.length) {
            this.timeline.segments = [{ id: uid(), start: 0, length: total, prompt: "", taskType: "", refs: [], referenceVideo: {} }];
            return;
        }
        let cursor = 0;
        const fixed = [];
        for (const seg of segs) {
            let length = seg.length ?? MIN_SEG;
            if (cursor + length > total) length = total - cursor;
            if (length < MIN_SEG) {
                if (fixed.length) fixed[fixed.length - 1].length += length;
                cursor += length;
                continue;
            }
            fixed.push({ ...seg, start: cursor, length, refs: seg.refs || [] });
            cursor += length;
        }
        if (!fixed.length) {
            this.timeline.segments = [{ id: uid(), start: 0, length: total, prompt: "", taskType: "", refs: [], referenceVideo: {} }];
        } else if (cursor < total) {
            fixed[fixed.length - 1].length += total - cursor;
        }
        this.timeline.segments = fixed;
    }

    getFrameImage(frameIndex) {
        return this._thumbCache.get(frameIndex) || null;
    }

    drawSegmentThumbnails(ctx, seg, startX, pxWidth, y0, h) {
        if (this.isFl2vMode()) {
            drawFl2vSegmentThumbnails(this, ctx, seg, startX, pxWidth, y0, h);
            return;
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(startX, y0 + 1, pxWidth, h - 2);
        ctx.clip();

        if (this.isR2vBatch()) {
            ctx.fillStyle = "#0d0d0d";
            ctx.fillRect(startX, y0 + 1, pxWidth, h - 2);
            const refs = [...(seg.refs || [])].sort(
                (a, b) => Number(a.index ?? a.slot ?? 0) - Number(b.index ?? b.slot ?? 0),
            );
            const imgFile = refs.find((r) => r?.imageFile)?.imageFile || "";
            const previewB64 = seg.previewB64 || (Array.isArray(seg.previewFrames) ? seg.previewFrames[0] : "");
            const cacheKey = imgFile ? `r2v:${imgFile}` : (previewB64 ? `r2v-prev:${seg.id || startX}` : "");
            const drawCached = (img) => {
                if (!img?.naturalWidth && !img?.width) return false;
                const natW = img.naturalWidth || img.width;
                const natH = Math.max(1, img.naturalHeight || img.height);
                const ratio = natW / natH;
                let dw = pxWidth - 4;
                let dh = dw / ratio;
                if (dh > h - 4) {
                    dh = h - 4;
                    dw = dh * ratio;
                }
                ctx.drawImage(img, startX + (pxWidth - dw) / 2, y0 + (h - dh) / 2, dw, dh);
                return true;
            };
            if (cacheKey) {
                let img = this._thumbCache.get(cacheKey);
                if (!drawCached(img) && !this._thumbPending.has(cacheKey)) {
                    this._thumbPending.add(cacheKey);
                    const el = new Image();
                    el.crossOrigin = "anonymous";
                    el.onload = () => {
                        this._thumbCache.set(cacheKey, el);
                        this._thumbPending.delete(cacheKey);
                        this.scheduleRender();
                    };
                    el.onerror = () => this._thumbPending.delete(cacheKey);
                    el.src = imgFile
                        ? refViewUrl(imgFile)
                        : (String(previewB64).startsWith("data:") ? previewB64 : `data:image/png;base64,${previewB64}`);
                }
            } else {
                ctx.fillStyle = "#666";
                ctx.font = "12px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("上传图片1", startX + pxWidth / 2, y0 + h / 2);
            }
            ctx.restore();
            return;
        }

        if (this.isGenBlank()) {
            ctx.fillStyle = "#0d0d0d";
            ctx.fillRect(startX, y0 + 1, pxWidth, h - 2);
            ctx.strokeStyle = "#333";
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(startX + 2, y0 + 4, pxWidth - 4, h - 8);
            ctx.setLineDash([]);
            ctx.fillStyle = "#888";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const fc = seg.frameCount ?? seg.length;
            ctx.fillText(`${fc}f`, startX + pxWidth / 2, y0 + h / 2 - 6);
            ctx.fillStyle = "#555";
            ctx.font = "10px sans-serif";
            ctx.fillText("空白画布", startX + pxWidth / 2, y0 + h / 2 + 8);
            ctx.restore();
            return;
        }

        if (this.isGenImage()) {
            const imgFile = this.isGlobalMode()
                ? this.timeline.global?.genImage?.imageFile
                : (seg.genImage?.imageFile || "");
            ctx.fillStyle = "#111";
            ctx.fillRect(startX, y0 + 1, pxWidth, h - 2);
            if (imgFile) {
                const cacheKey = `gen:${imgFile}`;
                let img = this._thumbCache.get(cacheKey);
                if (img?.naturalWidth) {
                    const ratio = img.naturalWidth / img.naturalHeight;
                    let dw = pxWidth - 4, dh = dw / ratio;
                    if (dh > h - 4) { dh = h - 4; dw = dh * ratio; }
                    ctx.drawImage(img, startX + (pxWidth - dw) / 2, y0 + (h - dh) / 2, dw, dh);
                } else if (!this._thumbPending.has(cacheKey)) {
                    this._thumbPending.add(cacheKey);
                    const el = new Image();
                    el.crossOrigin = "anonymous";
                    el.onload = () => {
                        this._thumbCache.set(cacheKey, el);
                        this._thumbPending.delete(cacheKey);
                        this.scheduleRender();
                    };
                    el.onerror = () => this._thumbPending.delete(cacheKey);
                    el.src = refViewUrl(imgFile);
                }
            } else {
                ctx.fillStyle = "#666";
                ctx.font = "12px sans-serif";
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                ctx.fillText("点击上传源图片", startX + pxWidth / 2, y0 + h / 2);
            }
            ctx.restore();
            return;
        }

        ctx.fillStyle = "#000";
        ctx.fillRect(startX, y0 + 1, pxWidth, h - 2);
        if (!this.hasVideo()) {
            ctx.fillStyle = "#666";
            ctx.font = "12px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(
                this.isFl2vMode() ? "点击「添加一组」" : "点击「上传视频」",
                startX + pxWidth / 2,
                y0 + h / 2,
            );
            ctx.restore();
            return;
        }
        const thumbW = Math.max(32, pxWidth / Math.max(1, Math.min(MAX_THUMBS_PER_SEGMENT, Math.ceil(seg.length / 4))));
        const step = Math.max(1, Math.floor(seg.length / Math.max(1, Math.ceil(pxWidth / thumbW))));
        let drawn = 0;
        for (let f = seg.start; f < seg.start + seg.length && drawn < MAX_THUMBS_PER_SEGMENT; f += step, drawn++) {
            this._queueThumbPrefetch(f);
            const img = this.getFrameImage(f);
            const tx = startX + ((f - seg.start) / seg.length) * pxWidth;
            if (img?.naturalWidth) {
                const ratio = img.naturalWidth / img.naturalHeight;
                let dw = thumbW, dh = thumbW / ratio;
                if (dh > h - 2) { dh = h - 2; dw = dh * ratio; }
                ctx.drawImage(img, tx, y0 + (h - dh) / 2, dw, dh);
            } else {
                ctx.fillStyle = "#333";
                ctx.fillRect(tx, y0 + 2, Math.max(8, thumbW * 0.6), h - 4);
            }
        }
        ctx.restore();
    }

    _drawSegmentRunCheck(x, y, enabled) {
        const ctx = this.ctx;
        const s = RUN_CHECK_SIZE;
        ctx.save();
        // Opaque plate so the control never blends into timeline chrome.
        ctx.fillStyle = "#0e0e0e";
        ctx.fillRect(x - 1, y - 1, s + 2, s + 2);
        ctx.fillStyle = enabled ? "#1a3a2a" : "#1c1c1c";
        ctx.strokeStyle = enabled ? "#4fff8f" : "#888";
        ctx.lineWidth = 1;
        ctx.fillRect(x, y, s, s);
        ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
        if (enabled) {
            ctx.fillStyle = "#4fff8f";
            ctx.font = "11px sans-serif";
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            ctx.fillText("✓", x + 2, y + 11);
        }
        ctx.restore();
    }

    _drawReorderInsertMarker(ix) {
        const ctx = this.ctx;
        const y0 = TRACK_Y;
        const y1 = TRACK_Y + TRACK_H;
        ctx.save();
        ctx.strokeStyle = "#4fff8f";
        ctx.fillStyle = "#4fff8f";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(ix, y0);
        ctx.lineTo(ix, y1);
        ctx.stroke();
        // Triangles at top/bottom
        const t = 7;
        ctx.beginPath();
        ctx.moveTo(ix, y0);
        ctx.lineTo(ix - t, y0 - t);
        ctx.lineTo(ix + t, y0 - t);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(ix, y1);
        ctx.lineTo(ix - t, y1 + t);
        ctx.lineTo(ix + t, y1 + t);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    /** Floating ghost card that follows the pointer while reordering clips. */
    _drawReorderGhost(width, segs, fromRank) {
        if (fromRank < 0 || this._drag?.pointerX == null) return;
        const ordered = this._orderedSegmentsWithRank();
        const item = ordered.find((o) => o.visualRank === fromRank);
        if (!item?.seg) return;
        const seg = item.seg;
        const srcW = Math.max(48, this.frameToX(seg.start + seg.length, width) - this.frameToX(seg.start, width));
        const gw = Math.min(140, Math.max(72, srcW * 0.55));
        const gh = TRACK_H * 0.78;
        const gx = this._drag.pointerX - gw / 2;
        const gy = clamp(this._drag.pointerY - gh / 2, TRACK_Y - 8, TRACK_Y + TRACK_H - gh + 8);
        const ctx = this.ctx;
        ctx.save();
        // Drop shadow
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(gx + 4, gy + 5, gw, gh);
        ctx.globalAlpha = 0.95;
        this.drawSegmentThumbnails(ctx, seg, gx, gw, gy, gh);
        ctx.strokeStyle = "#4fff8f";
        ctx.lineWidth = 2.5;
        ctx.strokeRect(gx + 0.5, gy + 0.5, gw - 1, gh - 1);
        ctx.fillStyle = "rgba(20,40,28,0.9)";
        ctx.fillRect(gx + 4, gy + 4, 44, 16);
        ctx.fillStyle = "#4fff8f";
        ctx.font = "bold 10px sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("拖动中", gx + 8, gy + 12);
        ctx.restore();
    }

    drawPromptOverlay(ctx, seg, startX, pxWidth, y0, h) {
        const prompt = this.getDisplayPrompt(seg);
        if (!prompt || pxWidth < 24) return;
        const overlayH = Math.round(h * 0.22);
        const overlayY = y0 + h - overlayH;
        ctx.save();
        ctx.beginPath();
        ctx.rect(startX, overlayY, pxWidth, overlayH);
        ctx.clip();
        ctx.fillStyle = "rgba(0,0,0,0.65)";
        ctx.fillRect(startX, overlayY, pxWidth, overlayH);
        ctx.font = `${Math.min(11, overlayH * 0.55)}px sans-serif`;
        ctx.fillStyle = "#e0e3ed";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        let label = prompt;
        const maxW = pxWidth - 10;
        if (ctx.measureText(label).width > maxW) {
            while (label.length > 0 && ctx.measureText(label + "…").width > maxW) label = label.slice(0, -1);
            label += "…";
        }
        ctx.fillText(label, startX + pxWidth / 2, overlayY + overlayH / 2);
        ctx.restore();
    }

    render() {
        if (this.isPlaying) {
            this.renderTimelineOnly();
            return;
        }
        const width = this.canvas?.getBoundingClientRect().width || this.canvas?.offsetWidth || 0;
        if (!width) return;
        this._drawWidth = width;
        this._drawTimelineCanvas(width);
        this._updateTimelineDom();
        this._syncStagePreview(this.currentFrame);
    }

    renderTimelineOnly() {
        const width = this._playCanvasWidth
            || this.viewport?.clientWidth
            || this.canvas?.getBoundingClientRect().width
            || this.canvas?.offsetWidth
            || this.node?.size?.[0]
            || 0;
        if (!width) return;
        this._drawWidth = width;
        this._drawTimelineCanvas(width);
        this._syncStagePreview(this.currentFrame);
    }

    _drawTimelineCanvas(width) {
        const height = this.canvasHeight;
        const dpr = window.devicePixelRatio || 1;
        const bw = Math.round(width * dpr);
        const bh = Math.round(height * dpr);
        // Keep bitmap ↔ CSS aspect in lockstep. During run, flex layout can
        // squash the canvas box; mismatched CSS height makes thumbs look stretched.
        if (this.canvas.width !== bw || this.canvas.height !== bh) {
            this.canvas.width = bw;
            this.canvas.height = bh;
        }
        this.canvas.style.height = `${height}px`;
        this.canvas.style.maxHeight = `${height}px`;
        this.canvas.style.minHeight = `${height}px`;
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.ctx.clearRect(0, 0, width, height);

        const total = this.getTotalFrames();
        const fps = this.getFrameRate();
        const segs = this._previewSegments || this.timeline.segments;

        this.ctx.fillStyle = "#252525";
        this.ctx.fillRect(0, 0, width, RULER_H);
        this.ctx.fillStyle = "#888";
        this.ctx.font = "10px sans-serif";
        const fl2vSampleN = this.isFl2vMode() ? getFl2vSampleFrames(this) : total;
        // fl2v: ruler labels follow 总时长 (sampling window); overflow past it is dashed.
        const durationSec = this.isFl2vMode()
            ? getFl2vTotalDurationSec(this)
            : total / Math.max(fps, 0.001);
        const formatRulerSec = (sec) => {
            const n = Math.max(0, Number(sec) || 0);
            return (Math.round(n * 10) / 10).toFixed(1);
        };
        const stepSec = Math.max(1, durationSec / 10);
        // Leave a gap near the end so the duration label does not collide with the last tick.
        const endGuard = Math.min(0.6, stepSec * 0.45);
        for (let s = 0; s < durationSec - 1e-6; s += stepSec) {
            if (durationSec - s < endGuard) continue;
            const f = this.isFl2vMode()
                ? Math.min(fl2vSampleN, Math.round((s / Math.max(durationSec, 0.001)) * fl2vSampleN))
                : Math.min(total - 1, Math.round(s * fps));
            const x = this.frameToX(f, width);
            this.ctx.fillRect(x, RULER_H - 6, 1, 6);
            this.ctx.fillText(formatRulerSec(s), x + 2, 11);
        }
        if (fl2vSampleN > 0) {
            const sampleX = this.frameToX(fl2vSampleN, width);
            this.ctx.fillStyle = "#aaa";
            this.ctx.fillRect(sampleX, RULER_H - 8, 1, 8);
            const endLabel = formatRulerSec(durationSec);
            const textW = this.ctx.measureText(endLabel).width;
            this.ctx.fillText(endLabel, Math.max(2, sampleX - textW - 4), 11);
        }
        // Sample-window end marker on ruler (overflow hatch drawn after segments).
        if (this.isFl2vMode() && total > fl2vSampleN) {
            const ox = this.frameToX(fl2vSampleN, width);
            this.ctx.save();
            this.ctx.strokeStyle = "rgba(180,180,180,0.75)";
            this.ctx.lineWidth = 1.5;
            this.ctx.setLineDash([6, 5]);
            this.ctx.beginPath();
            this.ctx.moveTo(ox + 0.5, 0);
            this.ctx.lineTo(ox + 0.5, RULER_H + SEG_LABEL_H);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle = "#999";
            this.ctx.font = "10px sans-serif";
            this.ctx.textAlign = "left";
            if (width - ox > 64) {
                this.ctx.fillText("超出·不采样", ox + 6, RULER_H - 3);
            }
            this.ctx.restore();
        }

        // Frame-range labels above each segment (1-based inclusive, e.g. 1-10).
        this.ctx.fillStyle = "#1a1a1a";
        this.ctx.fillRect(0, RULER_H, width, SEG_LABEL_H);
        this.ctx.font = "10px sans-serif";
        this.ctx.textBaseline = "middle";
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            const x0 = this.frameToX(seg.start, width);
            const x1 = this.frameToX(seg.start + seg.length, width);
            const pxW = Math.max(0, x1 - x0);
            if (pxW < 8 || seg.length <= 0) continue;
            const a = seg.start + 1;
            const b = seg.start + seg.length;
            const rangeText = `${a}-${b}`;
            this.ctx.fillStyle = i === this.selectedIndex ? "#eee" : "#9a9a9a";
            let draw = rangeText;
            if (this.ctx.measureText(draw).width > pxW - 6) {
                while (draw.length > 1 && this.ctx.measureText(`${draw}…`).width > pxW - 6) {
                    draw = draw.slice(0, -1);
                }
                draw = draw.length < rangeText.length ? `${draw}…` : draw;
            }
            this.ctx.fillText(draw, x0 + 4, RULER_H + SEG_LABEL_H / 2);
        }

        this.ctx.fillStyle = "#111";
        this.ctx.fillRect(0, TRACK_Y, width, TRACK_H);

        if (!segs.length && (this.isFl2vMode() || this.isR2vBatch())) {
            this.ctx.fillStyle = "#666";
            this.ctx.font = "12px sans-serif";
            this.ctx.textAlign = "center";
            this.ctx.textBaseline = "middle";
            this.ctx.fillText(
                this.isR2vBatch() ? "点击「添加素材组」" : "点击「添加一组」",
                width / 2,
                TRACK_Y + TRACK_H / 2,
            );
        }

        const clipBounds = this.getClipBoundaries();
        if (clipBounds.length) {
            this.ctx.strokeStyle = "rgba(102,170,255,0.55)";
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([5, 4]);
            for (const b of clipBounds) {
                const bx = this.frameToX(b, width);
                this.ctx.beginPath();
                this.ctx.moveTo(bx, TRACK_Y);
                this.ctx.lineTo(bx, TRACK_Y + TRACK_H);
                this.ctx.stroke();
            }
            this.ctx.setLineDash([]);
        }

        const reordering = this._drag?.kind === "reorder";
        const dragFromRank = reordering ? this._drag.fromRank : -1;
        const dropRank = reordering ? this._reorderDropRank : -1;

        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            const x0 = this.frameToX(seg.start, width);
            const x1 = this.frameToX(seg.start + seg.length, width);
            const pxW = x1 - x0;
            const sel = i === this.selectedIndex;
            const running = i === this._runHighlightSeg;
            const runOn = this.isSegmentRunEnabled(i);
            const fl2vStart = !this.isFl2vMode() || !!seg.isStartFrame;
            const visualRank = this._visualRankFromArrayIndex(i);
            const isDragSource = reordering && visualRank === dragFromRank;
            const isDropTarget = reordering && dropRank >= 0 && visualRank === dropRank && dropRank !== dragFromRank;
            if (this.isRunSelectEnabled() && this.getRunnableSegmentCount() >= 2 && fl2vStart && !runOn) {
                this.ctx.globalAlpha = 0.32;
            } else if (isDragSource) {
                this.ctx.globalAlpha = 0.28;
            } else if (reordering && !isDropTarget) {
                this.ctx.globalAlpha = 0.55;
            } else if (this.isFl2vMode() && !seg.isStartFrame) {
                this.ctx.globalAlpha = 0.72;
            }
            this.drawSegmentThumbnails(this.ctx, seg, x0, pxW, TRACK_Y, TRACK_H);
            if (!this.isFl2vMode() || seg.isStartFrame) {
                this.drawPromptOverlay(this.ctx, seg, x0, pxW, TRACK_Y, TRACK_H);
            }
            const clipIdx = this.getSegmentClipIndex(seg);
            const clipColor = CLIP_SEGMENT_COLORS[clipIdx % CLIP_SEGMENT_COLORS.length];
            if (isDropTarget) {
                this.ctx.fillStyle = "rgba(79,255,143,0.14)";
                this.ctx.fillRect(x0, TRACK_Y, pxW, TRACK_H);
                this.ctx.strokeStyle = "#4fff8f";
                this.ctx.lineWidth = 3;
                this.ctx.setLineDash([7, 4]);
                this.ctx.strokeRect(x0 + 1, TRACK_Y + 1, pxW - 2, TRACK_H - 2);
                this.ctx.setLineDash([]);
                this.ctx.fillStyle = "rgba(20,40,28,0.92)";
                const label = this.isFl2vMode() ? "交换到此处" : "插入到此处";
                this.ctx.font = "bold 11px sans-serif";
                const tw = this.ctx.measureText(label).width + 12;
                this.ctx.fillRect(x0 + (pxW - tw) / 2, TRACK_Y + 8, tw, 18);
                this.ctx.fillStyle = "#4fff8f";
                this.ctx.textAlign = "center";
                this.ctx.textBaseline = "middle";
                this.ctx.fillText(label, x0 + pxW / 2, TRACK_Y + 17);
            } else {
                this.ctx.strokeStyle = running ? "#4fff8f" : sel ? "#fff" : clipColor;
                this.ctx.lineWidth = running ? 3 : sel ? 2.5 : 1.5;
                this.ctx.strokeRect(x0 + 0.5, TRACK_Y + 0.5, pxW - 1, TRACK_H - 1);
            }
            if (this.isFl2vMode()) {
                // Hatch the portion past the sampling window (不计入采样).
                const sampleN = getFl2vSampleFrames(this);
                const segEnd = seg.start + seg.length;
                if (segEnd > sampleN && seg.start < segEnd) {
                    const ox0 = this.frameToX(Math.max(seg.start, sampleN), width);
                    const ox1 = this.frameToX(segEnd, width);
                    if (ox1 > ox0 + 1) {
                        this.ctx.save();
                        this.ctx.beginPath();
                        this.ctx.rect(ox0, TRACK_Y + 1, ox1 - ox0, TRACK_H - 2);
                        this.ctx.clip();
                        this.ctx.fillStyle = "rgba(0,0,0,0.45)";
                        this.ctx.fillRect(ox0, TRACK_Y + 1, ox1 - ox0, TRACK_H - 2);
                        this.ctx.strokeStyle = "rgba(200,200,200,0.55)";
                        this.ctx.lineWidth = 1;
                        this.ctx.setLineDash([5, 4]);
                        this.ctx.strokeRect(ox0 + 0.5, TRACK_Y + 1.5, Math.max(0, ox1 - ox0 - 1), TRACK_H - 3);
                        this.ctx.setLineDash([]);
                        this.ctx.restore();
                    }
                }
                this._drawFl2vEdgeHandles(segs, i, x0, x1, width);
            } else {
                this.ctx.fillStyle = "#ffcc00";
                this.ctx.fillRect(x0 - 2, TRACK_Y + TRACK_H / 2 - 12, 4, 24);
                this.ctx.fillRect(x1 - 2, TRACK_Y + TRACK_H / 2 - 12, 4, 24);
            }
            this.ctx.globalAlpha = 1;
            // Checkbox on top-left; drawn last so it stays clear on dimmed segments.
            if (
                this.isRunSelectEnabled()
                && this.getRunnableSegmentCount() >= 2
                && pxW >= RUN_CHECK_SIZE + 8
                && (!this.isFl2vMode() || seg.isStartFrame)
            ) {
                const g = this._runCheckGeometry(seg, width);
                this._drawSegmentRunCheck(g.boxX, g.boxY, runOn);
            }
        }

        // fl2v: dashed overlay for the region past the sampling window.
        if (this.isFl2vMode()) {
            const sampleN = getFl2vSampleFrames(this);
            if (total > sampleN) {
                const ox = this.frameToX(sampleN, width);
                this.ctx.save();
                this.ctx.strokeStyle = "rgba(180,180,180,0.7)";
                this.ctx.lineWidth = 1.5;
                this.ctx.setLineDash([6, 5]);
                this.ctx.beginPath();
                this.ctx.moveTo(ox + 0.5, TRACK_Y);
                this.ctx.lineTo(ox + 0.5, TRACK_Y + TRACK_H);
                this.ctx.stroke();
                this.ctx.strokeRect(ox + 1, TRACK_Y + 1, Math.max(0, width - ox - 2), TRACK_H - 2);
                this.ctx.setLineDash([]);
                this.ctx.restore();
            }
        }

        if (reordering) {
            this._drawReorderGhost(width, segs, dragFromRank);
            if (dropRank >= 0 && dropRank !== dragFromRank && !this.isFl2vMode()) {
                const insertFrame = this._getReorderInsertFrame(dropRank, dragFromRank);
                const ix = this.frameToX(insertFrame, width);
                this._drawReorderInsertMarker(ix);
            }
        }

        // Editable split-point markers: click = select only; delete via toolbar button.
        const splitFrames = this.getEditableSplitFrames();
        if (splitFrames.length) {
            for (const frame of splitFrames) {
                const sx = this.frameToX(frame, width);
                const selected = this.selectedSplitFrame === frame;
                this.ctx.strokeStyle = selected ? "#ffe066" : "rgba(80, 220, 255, 0.95)";
                this.ctx.fillStyle = selected ? "#ffe066" : "rgba(80, 220, 255, 0.9)";
                this.ctx.lineWidth = selected ? 3.5 : 2;
                this.ctx.beginPath();
                this.ctx.moveTo(sx, RULER_H + 2);
                this.ctx.lineTo(sx, TRACK_Y + TRACK_H - 2);
                this.ctx.stroke();
                const cy = RULER_H + SEG_LABEL_H / 2;
                const r = selected ? 8 : 6;
                this.ctx.beginPath();
                this.ctx.moveTo(sx, cy - r);
                this.ctx.lineTo(sx + r, cy);
                this.ctx.lineTo(sx, cy + r);
                this.ctx.lineTo(sx - r, cy);
                this.ctx.closePath();
                this.ctx.fill();
                if (selected) {
                    this.ctx.strokeStyle = "#fff";
                    this.ctx.lineWidth = 1.5;
                    this.ctx.stroke();
                    // Halo so selection is obvious on dense timelines.
                    this.ctx.strokeStyle = "rgba(255, 224, 102, 0.55)";
                    this.ctx.lineWidth = 6;
                    this.ctx.beginPath();
                    this.ctx.moveTo(sx, TRACK_Y);
                    this.ctx.lineTo(sx, TRACK_Y + TRACK_H);
                    this.ctx.stroke();
                }
            }
        }

        const phx = this.frameToX(this.currentFrame, width);
        this.ctx.strokeStyle = "#ff4444";
        this.ctx.lineWidth = 2;
        this.ctx.beginPath();
        this.ctx.moveTo(phx, 0);
        this.ctx.lineTo(phx, height);
        this.ctx.stroke();

        const exportCap = this.getMaxExportFrames();
        const exportTotal = this.getExportFrameTotal();
        if (exportCap > 0 && exportTotal < total) {
            const capX = this.frameToX(exportTotal, width);
            this.ctx.fillStyle = "rgba(0,0,0,0.35)";
            this.ctx.fillRect(capX, TRACK_Y, width - capX, TRACK_H);
            this.ctx.strokeStyle = "#66aaff";
            this.ctx.lineWidth = 2;
            this.ctx.setLineDash([4, 3]);
            this.ctx.beginPath();
            this.ctx.moveTo(capX, 0);
            this.ctx.lineTo(capX, height);
            this.ctx.stroke();
            this.ctx.setLineDash([]);
            this.ctx.fillStyle = "#66aaff";
            this.ctx.font = "10px sans-serif";
            this.ctx.fillText(`导出 ${exportTotal}`, capX + 4, TRACK_Y + 12);
        }
    }

    _updateTimelineDom({ skipSeek = false } = {}) {
        const segs = this._previewSegments || this.timeline.segments;
        const totalFrames = Math.max(0, this.getTotalFrames());
        const cur = this.formatTime(this.currentFrame);
        const total = this.formatTime(totalFrames);
        if (this.timecodeEl) this.timecodeEl.textContent = `${cur}s`;
        if (this.playerTimecodeEl) this.playerTimecodeEl.textContent = `${cur} / ${total}`;
        if (this.frameTotalEl) this.frameTotalEl.textContent = String(totalFrames);
        if (this.frameInputEl) {
            this.frameInputEl.max = String(Math.max(1, totalFrames));
            // Don't overwrite while the user is typing a target frame.
            if (document.activeElement !== this.frameInputEl) {
                this.frameInputEl.value = String(totalFrames > 0 ? this.currentFrame + 1 : 1);
            }
        }
        if (!skipSeek && this.seekBar && +this.seekBar.value !== this.currentFrame) {
            this.seekBar.value = this.currentFrame;
        }
        if (this.seekBar) this.seekBar.max = Math.max(0, totalFrames - 1);
        if (this.selectedSplitFrame != null && this.getEditableSplitFrames().includes(this.selectedSplitFrame)) {
            if (this.boundsEl) {
                this.boundsEl.textContent = `分割点: 帧 ${this.selectedSplitFrame} · 可删除合并相邻段`;
            }
        } else {
            const seg = segs[this.selectedIndex];
            if (seg && this.boundsEl) {
                this.boundsEl.textContent = `Start: ${this.formatTime(seg.start)} | End: ${this.formatTime(seg.start + seg.length)}`;
            }
        }
        this.updateSplitPointUI();
    }

    /** Jump to an exact 0-based logical frame; syncs seek bar, preview, playhead. */
    seekToFrame(frame, { fromUi = false } = {}) {
        const total = this.getTotalFrames();
        if (total < 1) return;
        if (this.isPlaying) this._stopPlay();
        const next = clamp(Math.round(Number(frame) || 0), 0, total - 1);
        this.currentFrame = next;
        if (this.seekBar) {
            this.seekBar.max = Math.max(0, total - 1);
            this.seekBar.value = next;
        }
        this._syncStagePreview(next, { force: true });
        this._updateTimelineDom({ skipSeek: true });
        // Select the segment that contains this frame for editing context.
        const segs = this.timeline.segments || [];
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (next >= s.start && next < s.start + s.length) {
                if (this.selectedIndex !== i) {
                    this.selectedIndex = i;
                    this.updateSelectionUI();
                }
                break;
            }
        }
        this.scheduleRender();
        if (fromUi) this._queueThumbPrefetch?.(next);
    }

    stepFrame(delta) {
        const total = this.getTotalFrames();
        if (total < 1) return;
        this.seekToFrame(this.currentFrame + (Number(delta) || 0), { fromUi: true });
    }

    formatTime(frames) { return (frames / this.getFrameRate()).toFixed(2); }

    updateSelectionUI() {
        this.timeline.global = this.timeline.global || { taskType: "", prompt: "", refs: [] };
        if (this.globalTask) this.globalTask.value = this.timeline.global.taskType || "";
        if (this.globalPrompt) this.globalPrompt.value = this.timeline.global.prompt || "";
        this.syncNegativeFromWidget();
        updateFl2vToolbarBtns(this);
        updateR2vToolbarBtns(this);
        if (this.isFl2vMode()) updateFl2vDetailUI(this);
        if (this.isR2vBatch()) this._syncR2vCardSelection();

        const hideTimeline = this.isImageBatch() || this.isGenMode();
        const seg = this.isGlobalMode() ? null : this.timeline.segments[this.selectedIndex];
        this.updateReferenceImageVisibility({ hideTimeline, seg: seg || null });

        const idirOn = !!this.timeline?.image_director?.enabled;
        if (this.isGlobalMode() && (taskUsesReferenceImages(this.getTaskKey()) || idirOn)) {
            this.renderRefSlots(this.timeline.global.refs, this.globalRefsBox, true);
        }
        if (this.isGlobalMode() && taskUsesReferenceAudios(this.getTaskKey())) {
            this.renderRefAudioSlots();
        }
        const refVideoKey = this.isGlobalMode()
            ? this.getTaskKey()
            : resolveTaskKey(seg?.taskType || this.timeline.global?.taskType || this.getTaskKey());
        if (taskUsesReferenceVideo(refVideoKey)) {
            this.renderRefVideoSlot();
        }
        if (this.isGenImage() && this.isGlobalMode()) {
            this.renderGenSrcSlot(
                this.genGlobalImg,
                this.timeline.global?.genImage?.imageFile,
                "点击上传源图片",
            );
        }
        if (this.isGenMode() && this.isGlobalMode()) {
            const defFc = this.timeline.gen?.defaultFrameCount ?? defaultFrameCount(this.getTaskKey());
            if (this.genDefaultFc) this.genDefaultFc.value = defFc;
        }

        if (this.isGlobalMode()) return;

        if (!seg) return;
        const fps = this.getFrameRate();
        const segKey = resolveTaskKey(seg.taskType || this.timeline.global?.taskType || this.getTaskKey());
        this.segLabel.textContent = `片段 ${this.selectedIndex + 1}`;
        let info;
        if (this.isGenMode()) {
            const fc = seg.frameCount ?? seg.length;
            info = `${fc} 帧`;
            if (this.isGenImage()) info += seg.genImage?.imageFile ? " · 已上传图片" : " · 未上传图片";
        } else {
            info = `帧 ${seg.start}–${seg.start + seg.length} (${seg.length}f) · ${(seg.length / fps).toFixed(2)}s`;
            const clips = this.getVideoClips();
            if (clips.length > 1) {
                const clip = clips[this.getSegmentClipIndex(seg)];
                const clipName = clip?.fileName || clip?.videoFile || `视频 ${this.getSegmentClipIndex(seg) + 1}`;
                info += ` · ${clipName}`;
            }
            if (taskUsesReferenceVideo(segKey)) {
                info += seg.referenceVideo?.videoFile || seg.referenceVideo?.fileName
                    ? " · 已上传参考视频"
                    : " · 未上传参考视频";
            }
        }
        this.segInfo.textContent = info;
        this.segPrompt.value = seg.prompt || "";
        if (taskUsesReferenceImages(segKey) || idirOn) {
            this.renderRefSlots(seg.refs, this.segRefsBox, false);
        }
        if (taskUsesReferenceAudios(segKey)) {
            this.renderRefAudioSlots();
        }
        if (this.isGenImage() && !this.isGlobalMode()) {
            this.renderGenSrcSlot(this.genSegImg, seg.genImage?.imageFile, "点击上传片段源图片");
        }
        if (this.isGenMode() && !this.isGlobalMode()) {
            const fc = seg.frameCount ?? seg.length ?? defaultFrameCount(this.getTaskKey());
            if (this.genSegFc) this.genSegFc.value = fc;
        }
        if (this.isFl2vMode()) updateFl2vDetailUI(this);
    }

    renderRefSlots(refs, box, isGlobal) {
        box.innerHTML = "";
        const target = isGlobal
            ? this.timeline.global
            : this.timeline.segments[this.selectedIndex];
        for (let i = 0; i < MAX_REFERENCE_IMAGES; i++) {
            const el = document.createElement("div");
            el.className = "bd-ref";
            el.dataset.refSlot = String(i);
            el.dataset.refScope = isGlobal ? "global" : "seg";
            const label = refImageLabel(i);
            el.title = `${label} — 点击上传；拖到其他格可移动`;
            const ref = (refs || []).find((r) => Number(r.index ?? r.slot) === i);
            const tag = document.createElement("span");
            tag.className = "bd-ref-tag";
            tag.textContent = label;
            el.appendChild(tag);
            if (ref?.imageFile) {
                el.classList.add("has-img");
                const img = document.createElement("img");
                img.src = refViewUrl(ref.imageFile);
                img.draggable = false;
                el.appendChild(img);
                const x = document.createElement("span");
                x.className = "x";
                x.textContent = "×";
                x.onclick = (e) => {
                    e.stopPropagation();
                    this.removeRef(target, i);
                };
                el.appendChild(x);
            } else if (ref?.imageB64) {
                el.classList.add("has-img");
                const img = document.createElement("img");
                img.src = ref.imageB64.startsWith("data:") ? ref.imageB64 : `data:image/png;base64,${ref.imageB64}`;
                img.draggable = false;
                el.appendChild(img);
                const x = document.createElement("span");
                x.className = "x";
                x.textContent = "×";
                x.onclick = (e) => {
                    e.stopPropagation();
                    this.removeRef(target, i);
                };
                el.appendChild(x);
            }
            this._bindRefSlotDnD(el, target, i, isGlobal);
            el.onclick = () => {
                if (this._refDragMoved) {
                    this._refDragMoved = false;
                    return;
                }
                this.pickRef(target, i, isGlobal);
            };
            box.appendChild(el);
        }
    }

    _bindRefSlotDnD(el, target, slotIndex, isGlobal) {
        const hasImg = el.classList.contains("has-img");
        el.draggable = hasImg;
        el.addEventListener("dragstart", (e) => {
            if (!hasImg) {
                e.preventDefault();
                return;
            }
            this._refDragMoved = false;
            const payload = JSON.stringify({
                scope: isGlobal ? "global" : "seg",
                segIndex: isGlobal ? -1 : this.selectedIndex,
                from: slotIndex,
            });
            e.dataTransfer.setData("application/x-minimax-ref-slot", payload);
            e.dataTransfer.setData("text/plain", payload);
            e.dataTransfer.effectAllowed = "move";
        });
        el.addEventListener("dragend", () => {
            // click may fire after dragend; keep suppress for one tick
            setTimeout(() => { this._refDragMoved = false; }, 0);
        });
        el.addEventListener("dragover", (e) => {
            const types = e.dataTransfer?.types || [];
            if (![...types].includes("application/x-minimax-ref-slot") && ![...types].includes("Files")) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = [...types].includes("application/x-minimax-ref-slot")
                ? "move"
                : "copy";
        });
        el.addEventListener("drop", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const raw = e.dataTransfer.getData("application/x-minimax-ref-slot")
                || e.dataTransfer.getData("text/plain");
            if (raw) {
                try {
                    const data = JSON.parse(raw);
                    const scope = isGlobal ? "global" : "seg";
                    if (data.scope !== scope) return;
                    if (!isGlobal && data.segIndex !== this.selectedIndex) return;
                    this._refDragMoved = true;
                    this.moveRefSlot(target, Number(data.from), slotIndex, isGlobal);
                    return;
                } catch (_) { /* fall through to file drop */ }
            }
            const f = e.dataTransfer.files?.[0];
            if (f?.type?.startsWith("image/")) {
                this.addRefFromFile(f, target, slotIndex, isGlobal);
            }
        });
    }

    moveRefSlot(target, fromIndex, toIndex, isGlobal) {
        if (!target || fromIndex === toIndex) return;
        const refs = [...(target.refs || [])];
        const fromRef = refs.find((r) => Number(r.index ?? r.slot) === fromIndex);
        if (!fromRef) return;
        const toRef = refs.find((r) => Number(r.index ?? r.slot) === toIndex);
        target.refs = refs.filter((r) => {
            const idx = Number(r.index ?? r.slot);
            return idx !== fromIndex && idx !== toIndex;
        });
        target.refs.push({ ...fromRef, index: toIndex, slot: undefined });
        if (toRef) {
            target.refs.push({ ...toRef, index: fromIndex, slot: undefined });
        }
        if (isGlobal) this.timeline.global = target;
        this.commit();
    }

    removeRef(target, index) {
        target.refs = (target.refs || []).filter((r) => Number(r.index ?? r.slot) !== index);
        this.commit();
    }

    renderRefAudioSlots() {
        const isGlobal = this.isGlobalMode();
        const box = isGlobal ? this.globalRefAudiosBox : this.segRefAudiosBox;
        if (!box) return;
        const target = isGlobal
            ? (this.timeline.global = this.timeline.global || { refs: [], refAudios: [] })
            : this.timeline.segments[this.selectedIndex];
        if (!target) return;
        target.refAudios = target.refAudios || [];
        box.innerHTML = "";
        for (let i = 0; i < MAX_REFERENCE_AUDIOS; i++) {
            const el = document.createElement("div");
            el.className = "bd-ref-audio";
            el.dataset.audioSlot = String(i);
            const label = refAudioLabel(i);
            const ref = (target.refAudios || []).find((r) => Number(r.index ?? r.slot) === i);
            const file = ref?.audioFile || ref?.fileName || "";
            el.title = file
                ? `${label}: ${file} — 点击更换；× 清除`
                : `${label} — 点击上传参考音频（wav/mp3/flac…）`;
            if (file) {
                el.classList.add("has-audio");
                const tag = document.createElement("span");
                tag.textContent = label;
                el.appendChild(tag);
                const name = document.createElement("span");
                name.className = "bd-ref-audio-name";
                name.textContent = file.split("/").pop() || file;
                el.appendChild(name);
                const x = document.createElement("span");
                x.className = "x";
                x.textContent = "×";
                x.onclick = (e) => {
                    e.stopPropagation();
                    this.removeRefAudio(target, i);
                };
                el.appendChild(x);
            } else {
                el.textContent = `${label}\n上传`;
            }
            el.onclick = () => this.pickRefAudio(target, i);
            box.appendChild(el);
        }
    }

    removeRefAudio(target, index) {
        if (!target) return;
        target.refAudios = (target.refAudios || []).filter((r) => Number(r.index ?? r.slot) !== index);
        this.commit();
        this.renderRefAudioSlots();
    }

    pickRefAudio(target, index) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac";
        input.onchange = () => {
            const file = input.files?.[0];
            if (file) this.addRefAudioFromFile(file, target, index);
        };
        input.click();
    }

    async addRefAudioFromFile(file, target, slotIndex = null) {
        if (!target || !file) return;
        target.refAudios = target.refAudios || [];
        let index = slotIndex;
        if (index == null) {
            index = Array.from({ length: MAX_REFERENCE_AUDIOS }, (_, i) => i)
                .find((i) => !target.refAudios.some((r) => Number(r.index ?? r.slot) === i));
            if (index == null) return;
        }
        try {
            const uploaded = await uploadToInput(file);
            const relPath = videoRelativePath(uploaded);
            target.refAudios = target.refAudios.filter((r) => Number(r.index ?? r.slot) !== index);
            target.refAudios.push({
                index,
                audioFile: relPath,
                fileName: uploaded?.name || file.name,
                type: "input",
                subfolder: uploaded?.subfolder || "",
            });
            this.commit();
            this.renderRefAudioSlots();
        } catch (err) {
            console.error("[MiniMax H3Director] ref audio upload failed:", err);
            alert(`参考音频上传失败：${err?.message || err}`);
        }
    }

    pickRef(target, index, isGlobal) {
        const input = document.createElement("input");
        input.type = "file"; input.accept = "image/*";
        input.onchange = () => {
            const file = input.files?.[0];
            if (file) this.addRefFromFile(file, target, index, isGlobal);
        };
        input.click();
    }

    async addRefFromFile(file, target, slotIndex = null, isGlobal = null) {
        target.refs = target.refs || [];
        let index = slotIndex;
        if (index == null) {
            index = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => i)
                .find((i) => !target.refs.some((r) => Number(r.index ?? r.slot) === i));
            if (index == null) return;
        }
        try {
            const uploaded = await uploadToInput(file);
            const relPath = videoRelativePath(uploaded);
            target.refs = target.refs.filter((r) => Number(r.index ?? r.slot) !== index);
            target.refs.push({ index, imageFile: relPath, imageB64: "" });
            if (isGlobal) this.timeline.global = target;
            this.commit();
        } catch (err) {
            console.error("[MiniMax H3Director] ref upload failed:", err);
        }
    }

    onGlobalField(field, value) {
        this.timeline.global = this.timeline.global || { refs: [] };
        if (field === "taskType") {
            const prevTaskKey = resolveTaskKey(
                this.timeline.global?.taskType || this.globalTask?.value || this.taskTypeWidget?.value || "",
            );
            this.timeline.global[field] = value;
            const prevMode = this._directorMode || "video";
            if (this.globalTask && this.globalTask.value !== value) this.globalTask.value = value;
            if (this.taskTypeWidget) this.taskTypeWidget.value = value;
            if (prevTaskKey === "ads2v" && resolveTaskKey(value) !== "ads2v") {
                this._stopRefVideoPreviews();
            }
            this.applyTaskLayout(prevMode);
        } else {
            this.timeline.global[field] = value;
        }
        if (field === "prompt" && this.globalPromptWidget) this.globalPromptWidget.value = value;
        this.scheduleTimelineSync();
        this.scheduleRender();
    }

    onSegField(field, value) {
        const seg = this.timeline.segments[this.selectedIndex];
        if (!seg) return;
        seg[field] = value;
        this.scheduleTimelineSync();
        this.scheduleRender();
    }

    onNegativePrompt(value) {
        if (this.negativePromptWidget) this.negativePromptWidget.value = value;
        if (this.globalNegative && this.globalNegative.value !== value) this.globalNegative.value = value;
        if (this.segNegative && this.segNegative.value !== value) this.segNegative.value = value;
        this._markNodeDirtyLight();
    }

    toggleLoop() {
        this.isLooping = !this.isLooping;
        const btn = this.root.querySelector('[data-a="loop"]');
        btn.classList.toggle("active", this.isLooping);
        btn.title = this.isLooping
            ? "循环播放：已开启（播放到末尾后从头开始）"
            : "循环播放：已关闭（播放到末尾后停止）";
    }

    setRunProgress(detail) {
        if (!this.runStatusEl) return;
        const timelineTotal = this.timeline?.segments?.length || 0;
        const runTotal = Math.max(detail.segment_total || this.getRunProgressSegmentTotal(), 1);
        const runSeg = Math.max(1, detail.segment || 1);
        const timelineSeg = detail.timeline_segment ?? runSeg;
        const partialRun = !!detail.partial_run
            || (this.isRunSelectEnabled?.() && runTotal < timelineTotal);
        const phaseLabel = detail.phase_label || detail.phase || "运行中";
        const overallPct = detail.overall_max > 0
            ? Math.round((100 * detail.overall_value) / detail.overall_max)
            : 0;
        const phasePct = detail.phase_max > 0
            ? Math.round((100 * detail.phase_value) / detail.phase_max)
            : 0;
        const remain = Math.max(0, runTotal - runSeg);

        if (detail.phase === "finish") {
            this.runStatusEl.className = "bd-run-status done";
            this.runTitleEl.textContent = "运行状态：全部完成";
            this.runDetailEl.textContent = runTotal
                ? (this.isImageBatch()
                    ? (isVideoBatchTask(this.getTaskKey())
                        ? `共生成 ${runTotal} 组视频`
                        : `共生成 ${runTotal} 张图片`)
                    : (partialRun
                        ? `共处理 ${runTotal} 个选中片段`
                        : `共处理 ${runTotal} 个片段`))
                : "处理完成";
            this.runOverallEl.style.width = "100%";
            this.runPhaseEl.style.width = "100%";
            this._runHighlightSeg = -1;
            this.updateRunSelectUI();
            if (this.isImageBatch()) this.renderImageBatchGroups();
            else this.scheduleRender();
            return;
        }

        this.runStatusEl.className = "bd-run-status active";
        // Hide the pre-run "将运行 N 段" chip while progress is live — it sits
        // under the title in the same green accent and reads as a layout glitch.
        this.runSelectBar?.classList.add("hidden");
        this._runHighlightSeg = timelineSeg - 1;
        let title;
        if (detail.phase === "plan") {
            title = runTotal > 1 ? `共 ${runTotal} 段 · ${phaseLabel}` : phaseLabel;
        } else if (this.isImageBatch()) {
            title = `第 ${runSeg}/${runTotal} 组 · ${phaseLabel}`;
        } else if (partialRun) {
            title = `段 #${timelineSeg}（${runSeg}/${runTotal}）· ${phaseLabel}`;
        } else {
            title = `段 ${runSeg}/${runTotal} · ${phaseLabel}`;
        }
        if (phasePct > 0 && detail.phase !== "plan") {
            title += ` · ${phasePct}%`;
        }
        this.runTitleEl.textContent = title;
        const parts = [];
        if (detail.frames_label) parts.push(detail.frames_label);
        if (detail.task_key) parts.push(detail.task_key);
        parts.push(`整体 ${overallPct}%`);
        if (runTotal > 1) {
            parts.push(this.isImageBatch() ? `还剩 ${remain} 组` : `还剩 ${remain} 段`);
        }
        if (partialRun && timelineTotal > runTotal) {
            parts.push(`时间轴共 ${timelineTotal} 段`);
        }
        this.runDetailEl.textContent = parts.join(" · ");
        this.runOverallEl.style.width = `${overallPct}%`;
        this.runPhaseEl.style.width = `${phasePct}%`;
        // Progress text can grow the status bar — resize host so the timeline
        // canvas is not flex-squashed (fl2v repeat thumbs look stretched).
        syncDirectorNodeSize(this.node, this);
        if (this.isImageBatch()) this.renderImageBatchGroups();
        else this.scheduleRender();
    }

    clearRunProgress(title, detail) {
        if (!this.runStatusEl) return;
        this.runStatusEl.className = "bd-run-status idle";
        this.runTitleEl.textContent = title || "运行状态：待命";
        this.runDetailEl.textContent = detail || "队列执行时将显示当前片段与阶段进度";
        this.runOverallEl.style.width = "0%";
        this.runPhaseEl.style.width = "0%";
        this._runHighlightSeg = -1;
        this.updateRunSelectUI();
        if (this.isImageBatch()) this.renderImageBatchGroups();
        else this.scheduleRender();
    }

    setRunError(message) {
        if (!this.runStatusEl) return;
        this.runStatusEl.className = "bd-run-status error";
        this.runTitleEl.textContent = "运行状态：出错";
        this.runDetailEl.textContent = message || "执行中断，请查看终端日志";
        if (this.runOverallEl) this.runOverallEl.style.width = "0%";
        if (this.runPhaseEl) this.runPhaseEl.style.width = "0%";
        this._runHighlightSeg = -1;
        this.updateRunSelectUI();
        this.scheduleRender();
    }

    _stopPlay() {
        this.isPlaying = false;
        this._playHandoff = false;
        this._nativePlayFailed = false;
        this._pauseSettling = true;
        cancelAnimationFrame(this._playRaf);
        this._playRaf = null;
        this.stageVideo?.pause();
        this.root.querySelector('[data-a="play"]').textContent = "▶";
        this._resizeObserver?.disconnect();

        const w = this._playCanvasWidth;
        this._releasePlayLayoutLock();

        if (w) this._drawTimelineCanvas(w);
        this._updateTimelineDom({ skipSeek: true });
        this._syncStagePreview(this.currentFrame, { force: true });

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (+this.seekBar.value !== this.currentFrame) {
                    this.seekBar.value = this.currentFrame;
                }
                this._observeViewportResize();
                const drawW = this.viewport?.clientWidth || w;
                if (drawW) this._drawTimelineCanvas(drawW);
                this._syncStagePreview(this.currentFrame, { force: true });
                this._pauseSettling = false;
            });
        });
    }

    async _beginNativePlay() {
        const total = this.getTotalFrames();
        if (total < 1) return;
        if (this.currentFrame >= total) this.currentFrame = 0;
        await this._ensureStageReadyForFrame(this.currentFrame);
        if (!this.isPlaying) return;
        const v = this.stageVideo;
        if (!v) return;
        try {
            await v.play();
        } catch {
            // Native play blocked/failed — keep isPlaying but drive via frame clock.
            this._nativePlayFailed = true;
        }
    }

    async _advanceNativePlayToNextClipOrEnd() {
        if (this._playHandoff || !this.isPlaying) return;
        this._playHandoff = true;
        try {
            const total = this.getTotalFrames();
            const range = this._logicalRangeForClip(this._stageClipIndex);
            const next = range.end < total ? range.end : -1;
            if (next >= 0) {
                this.currentFrame = next;
                await this._beginNativePlay();
                return;
            }
            if (this.isLooping) {
                this.currentFrame = 0;
                await this._beginNativePlay();
                return;
            }
            this.currentFrame = Math.max(0, total - 1);
            this._stopPlay();
        } finally {
            this._playHandoff = false;
        }
    }

    togglePlay() {
        if (this.isPlaying) {
            this._stopPlay();
            return;
        }
        const total = this.getTotalFrames();
        if (total < 1) return;

        this.isPlaying = true;
        this._nativePlayFailed = false;
        this.root.querySelector('[data-a="play"]').textContent = "⏸";
        this._lockPlayLayout();
        this._resizeObserver?.disconnect();

        if (this.currentFrame >= total) this.currentFrame = 0;
        this.renderTimelineOnly();
        this._updateTimelineDom();

        const useNative = !this._legacyFrames.length && !!this.stageVideo;
        if (useNative) {
            this._beginNativePlay();
        } else {
            this._syncStagePreview(this.currentFrame, { force: true });
        }

        const tick = () => {
            if (!this.isPlaying) return;
            const fps = Math.max(0.001, this.getFrameRate());

            if (useNative && this.stageVideo && !this._nativePlayFailed) {
                const v = this.stageVideo;
                const clipIndex = this._stageClipIndex >= 0 ? this._stageClipIndex : 0;
                const range = this._logicalRangeForClip(clipIndex);
                const lastLogical = Math.max(range.start, range.end - 1);
                const lastTime = this.getFrameMapEntry(lastLogical).frame / fps;
                const atMappedEnd = v.currentTime >= Math.max(0, lastTime - 0.04);
                const hasTimelineEdits = !!(
                    this.getFrameMap().length
                    || deletedSourceRanges(this.timeline.video || {}).length
                );
                // With deletes, file duration still includes removed tails — trust mapped end.
                const atMediaEnd = !hasTimelineEdits && (
                    v.ended || (v.duration > 0 && v.currentTime >= v.duration - 0.04)
                );

                if ((atMappedEnd || atMediaEnd) && !v.seeking && !this._playHandoff) {
                    this.currentFrame = lastLogical;
                    this.renderTimelineOnly();
                    this._updateTimelineDom();
                    this._advanceNativePlayToNextClipOrEnd();
                    if (this.isPlaying) this._playRaf = requestAnimationFrame(tick);
                    return;
                }

                if (!v.paused) {
                    const srcFrame = Math.max(0, Math.round(v.currentTime * fps));
                    let logical = this._logicalFromStageTime(clipIndex, v.currentTime);
                    const jumpToKept = () => {
                        const nextLogical = this._nextLogicalAfterSourceFrame(clipIndex, srcFrame);
                        if (nextLogical >= 0) {
                            const nextSrc = this.getFrameMapEntry(nextLogical).frame;
                            try { v.currentTime = nextSrc / fps; } catch { /* seek race */ }
                            return nextLogical;
                        }
                        return -1;
                    };
                    // Sparse deleted gap, or mid/leading gap vs mapped source.
                    if (logical < 0) {
                        const next = jumpToKept();
                        if (next < 0) {
                            this.currentFrame = lastLogical;
                            this.renderTimelineOnly();
                            this._updateTimelineDom();
                            this._advanceNativePlayToNextClipOrEnd();
                            if (this.isPlaying) this._playRaf = requestAnimationFrame(tick);
                            return;
                        }
                        logical = next;
                    } else {
                        const mapped = this.getFrameMapEntry(logical);
                        if (mapped.clip === clipIndex && mapped.frame !== srcFrame) {
                            // leading gap (mapped > src) or mid gap (mapped < src)
                            if (mapped.frame > srcFrame || mapped.frame < srcFrame) {
                                const next = mapped.frame > srcFrame ? logical : jumpToKept();
                                if (next < 0) {
                                    this.currentFrame = clamp(logical, 0, total - 1);
                                    this.renderTimelineOnly();
                                    this._updateTimelineDom();
                                    this._advanceNativePlayToNextClipOrEnd();
                                    if (this.isPlaying) this._playRaf = requestAnimationFrame(tick);
                                    return;
                                }
                                if (mapped.frame > srcFrame) {
                                    try { v.currentTime = mapped.frame / fps; } catch { /* seek race */ }
                                }
                                logical = next;
                            }
                        }
                    }
                    this.currentFrame = clamp(logical, 0, total - 1);
                    this.renderTimelineOnly();
                    const now = performance.now();
                    if (now - this._lastSeekUiMs > 66) {
                        this._updateTimelineDom();
                        this._lastSeekUiMs = now;
                    }
                }
            } else {
                // Legacy embedded frames (or native play unavailable): step by logical frame.
                this.currentFrame += 1;
                if (this.currentFrame >= total) {
                    if (this.isLooping) this.currentFrame = 0;
                    else {
                        this.currentFrame = total - 1;
                        this._stopPlay();
                        return;
                    }
                }
                this.renderTimelineOnly();
                this._syncStagePreview(this.currentFrame, { force: true });
                const now = performance.now();
                if (now - this._lastSeekUiMs > 80) {
                    this._updateTimelineDom();
                    this._lastSeekUiMs = now;
                }
            }
            this._playRaf = requestAnimationFrame(tick);
        };
        this._playRaf = requestAnimationFrame(tick);
    }
}

function findDirectorNode(nodeId) {
    const id = String(nodeId);
    const graph = app.graph ?? app.canvas?.graph;
    for (const node of graph?._nodes ?? graph?.nodes ?? []) {
        if (String(node.id) === id) return node;
    }
    return null;
}

function clearAllDirectorRunStatus() {
    const graph = app.graph ?? app.canvas?.graph;
    for (const node of graph?._nodes ?? graph?.nodes ?? []) {
        node._minimaxEditor?.clearRunProgress?.();
    }
}

/** Old workflows may still list removed output slots (e.g. segment_images). */
function isMiniMaxH3DirectorNode(node) {
    const cls = node?.comfyClass || node?.type || "";
    return cls === "MiniMaxH3Director" || cls === "ComfyMiniMaxH3Director";
}

function isDirectorNodeDef(nodeType, nodeData) {
    const cls = nodeType?.comfyClass || nodeData?.name || "";
    return cls === "MiniMaxH3Director" || cls === "ComfyMiniMaxH3Director";
}

function stripDeprecatedDirectorOutputs(node) {
    if (!isMiniMaxH3DirectorNode(node) || !node.outputs?.length) return;
    const stale = new Set(["segment_images"]);
    for (let i = node.outputs.length - 1; i >= 0; i--) {
        if (stale.has(node.outputs[i]?.name)) {
            node.removeOutput(i);
        }
    }
}

/** Reorder legacy output links after slot layout changes. */
function migrateDirectorOutputLinks(node) {
    if (!isMiniMaxH3DirectorNode(node)) return;
    const graph = app.graph ?? app.canvas?.graph;
    const links = graph?.links;
    if (!links?.length) return;
    const outputs = node.outputs || [];
    const byName = Object.fromEntries(
        outputs.map((o, i) => [o?.name, i]).filter(([n]) => !!n)
    );

    for (const link of links) {
        if (!link || String(link.origin_id) !== String(node.id)) continue;
        const target = graph.getNodeById?.(link.target_id);
        const input = target?.inputs?.[link.target_slot];
        const inputType = (input?.type || "").toUpperCase();

        // Old layouts had report at slot 1 or 3 as STRING.
        if (inputType === "STRING" && byName.report != null && link.origin_slot !== byName.report) {
            link.origin_slot = byName.report;
            continue;
        }
        // Old layouts had fps last (slot 5) as FLOAT.
        if (inputType === "FLOAT" && byName.fps != null && link.origin_slot !== byName.fps) {
            link.origin_slot = byName.fps;
            continue;
        }
        // Old layouts had frame_count at slot 2 as INT.
        if (inputType === "INT" && byName.frame_count != null && link.origin_slot !== byName.frame_count) {
            link.origin_slot = byName.frame_count;
        }
    }
}

function normalizeDirectorOutputs(node) {
    stripDeprecatedDirectorOutputs(node);
    migrateDirectorOutputLinks(node);
}

app.registerExtension({
    name: "ComfyUI.MiniMaxH3DirectorPlugin",
    async setup() {
        const flushDirectors = () => {
            const graph = app.graph ?? app.canvas?.graph;
            for (const node of graph?._nodes ?? graph?.nodes ?? []) {
                if (isMiniMaxH3DirectorNode(node)) repairDirectorStudioWidgets(node);
                node._minimaxEditor?.flushTimelineSync?.();
            }
        };
        if (app.queuePrompt && !app.queuePrompt._minimaxPatched) {
            const orig = app.queuePrompt.bind(app);
            app.queuePrompt = function (...args) {
                flushDirectors();
                clearAllDirectorRunStatus();
                return orig(...args);
            };
            app.queuePrompt._minimaxPatched = true;
        }
        // Some frontends build the prompt via graphToPrompt without going through queuePrompt first.
        if (app.graphToPrompt && !app.graphToPrompt._minimaxPatched) {
            const origGtp = app.graphToPrompt.bind(app);
            app.graphToPrompt = function (...args) {
                flushDirectors();
                return origGtp(...args);
            };
            app.graphToPrompt._minimaxPatched = true;
        }

        api.addEventListener("minimax_director_progress", ({ detail }) => {
            findDirectorNode(detail?.node_id)?._minimaxEditor?.setRunProgress?.(detail);
        });

        api.addEventListener("minimax_director_preview", ({ detail }) => {
            const editor = findDirectorNode(detail?.node_id)?._minimaxEditor;
            if (!editor?.isImageBatch?.()) return;
            setImageBatchPreview(
                editor,
                detail?.segment_index ?? 0,
                detail?.image_b64 || "",
                { frames: detail?.frames, fps: detail?.fps },
            );
            editor.renderImageBatchGroups?.();
        });

        // Reference Image Director: sync generated refs into timeline 图片1 slots
        api.addEventListener("minimax_director_refs", ({ detail }) => {
            const node = findDirectorNode(detail?.node_id);
            const editor = node?._minimaxEditor;
            if (!editor?.timeline) return;
            editor.timeline.global = editor.timeline.global || {};
            if (Array.isArray(detail.global_refs)) {
                editor.timeline.global.refs = detail.global_refs;
            }
            if (detail.global_prompt) {
                editor.timeline.global.prompt = detail.global_prompt;
                if (editor.globalPrompt) editor.globalPrompt.value = detail.global_prompt;
                if (editor.globalPromptWidget) editor.globalPromptWidget.value = detail.global_prompt;
            }
            if (Array.isArray(detail.segments)) {
                const segs = editor.timeline.segments || [];
                detail.segments.forEach((s, i) => {
                    if (!segs[i]) return;
                    if (Array.isArray(s.refs)) segs[i].refs = s.refs;
                    if (s.prompt) segs[i].prompt = s.prompt;
                    if (s.genImage?.imageFile) {
                        segs[i].genImage = { ...(segs[i].genImage || {}), ...s.genImage };
                        segs[i].imageFile = s.genImage.imageFile;
                    }
                    if (s.endImage?.imageFile) {
                        segs[i].endImage = { ...(segs[i].endImage || {}), ...s.endImage };
                    }
                    // Mirror Picture-1 into genImage for legacy UI only (i2v no longer locks first frame)
                    const ref0 = (segs[i].refs || []).find((r) => Number(r?.index ?? r?.slot) === 0 && r?.imageFile);
                    if (ref0?.imageFile) {
                        segs[i].genImage = { ...(segs[i].genImage || {}), imageFile: ref0.imageFile };
                        segs[i].imageFile = ref0.imageFile;
                    }
                });
            }
            // Only apply fl2v shot sync when payload/editor is actually fl2v.
            // Empty shots:[] from prompt_batch must NOT call syncFl2vFromShots —
            // that replaces timeline.segments with [] and wipes 提示词组.
            const flMode = detail.timelineMode === "fl2v"
                || editor.isFl2vMode?.()
                || editor.timeline.timelineMode === "fl2v";
            if (flMode && Array.isArray(detail.shots) && detail.shots.length > 0) {
                editor.timeline.shots = detail.shots;
                if (!editor.timeline.timelineMode) editor.timeline.timelineMode = "fl2v";
                syncFl2vFromShots(editor);
                updateFl2vDetailUI(editor);
                setFl2vToolbar(editor);
            }
            const gRef0 = (editor.timeline.global.refs || []).find((r) => Number(r?.index ?? r?.slot) === 0 && r?.imageFile);
            if (gRef0?.imageFile) {
                editor.timeline.global.genImage = {
                    ...(editor.timeline.global.genImage || {}),
                    imageFile: gRef0.imageFile,
                };
                editor.timeline.global.imageFile = gRef0.imageFile;
            }
            if (detail.image_director && typeof detail.image_director === "object") {
                editor.timeline.image_director = {
                    ...(editor.timeline.image_director || {}),
                    ...detail.image_director,
                };
            }

            // Refresh visible UIs first so harvestBatchPrompts won't pull stale textarea text
            editor.renderRefSlots?.(editor.timeline.global.refs, editor.globalRefsBox, true);
            editor.renderImageBatchGroups?.();
            editor.refreshIdirDirectorUI?.();
            editor.updateSelectionUI?.();
            editor.scheduleRender?.();

            // Persist into timeline_data widget (avoid commit→syncFromWidgets races)
            editor.flushTimelineSync?.();

            const previewFiles = Array.isArray(detail.preview_files) ? detail.preview_files : [];
            const labels = previewFiles.map((_, i) => {
                if (detail.timelineMode === "fl2v" || Array.isArray(detail.shots)) {
                    return i % 2 === 0 ? `首帧${Math.floor(i / 2) + 1}` : `尾帧${Math.floor(i / 2) + 1}`;
                }
                return i === 0 ? "全局" : `分镜${i}`;
            });
            editor.renderIdirPreview?.(previewFiles, labels);

            // After stills-only run: flip widgets so next Queue does full video with existing refs
            if (detail.stills_only || detail.image_director?.stills_only_done) {
                const wOnly = node.widgets?.find((w) => w.name === "ref_gen_only");
                const wGen = node.widgets?.find((w) => w.name === "ref_gen_enable");
                if (wOnly) {
                    wOnly.value = false;
                    // Set value only — avoid callback side-effects re-entering studio toggles
                }
                if (wGen) {
                    wGen.value = false;
                }
                if (editor.timeline.image_director) {
                    editor.timeline.image_director.generate_on_queue = false;
                    editor.timeline.image_director.stills_only_done = true;
                }
                editor.flushTimelineSync?.();
            }

            if (editor.studioDesk) {
                const st = editor.studioDesk.querySelector?.('[data-r="idir-status"]');
                if (st) {
                    const n = previewFiles.length || (
                        (detail.global_refs || []).filter((r) => r?.imageFile).length
                        + (detail.segments || []).reduce(
                            (a, s) => a + (s.refs || []).filter((r) => r?.imageFile).length,
                            0,
                        )
                    );
                    st.textContent = detail.stills_only || detail.image_director?.stills_only_done
                        ? `仅生图完成：已注入并预览 ${n} 张。可点「③ 确认图 → 准备出片」后 Queue 完整工作流`
                        : `已自动生图并注入时间线参考槽（${n} 张）`;
                    st.classList.add("ok");
                    st.classList.remove("err");
                }
                // Sync desk prompt textareas with backend-updated prompts
                const gp = editor.studioDesk.querySelector?.('[data-r="idir-global-prompt"]');
                if (gp && editor.timeline.image_director?.global_ref_prompt) {
                    gp.value = editor.timeline.image_director.global_ref_prompt;
                }
                const sp = editor.studioDesk.querySelector?.('[data-r="idir-shot-prompts"]');
                if (sp && editor.timeline.image_director?.shot_image_prompts) {
                    sp.value = editor.timeline.image_director.shot_image_prompts;
                }
            }
        });

        api.addEventListener("executing", ({ detail }) => {
            if (detail == null) return;
            const node = findDirectorNode(detail);
            const editor = node?._minimaxEditor;
            if (!editor) return;
            editor.flushTimelineSync?.();
            if (editor.isImageBatch?.()) {
                for (const seg of editor.timeline.segments || []) {
                    seg.previewB64 = "";
                    seg.previewFrames = [];
                }
                editor.renderImageBatchGroups?.();
            }
            const segTotal = editor.getRunProgressSegmentTotal?.() ?? (editor.timeline?.segments?.length || 1);
            const timelineTotal = editor.timeline?.segments?.length || segTotal;
            editor.setRunProgress({
                node_id: detail,
                segment: 1,
                segment_total: segTotal,
                timeline_segment: 1,
                timeline_segment_total: timelineTotal,
                partial_run: editor.isRunSelectEnabled?.() && segTotal < timelineTotal,
                phase: "plan",
                phase_label: "解析时间轴 / 加载视频",
                phase_value: 0,
                phase_max: 1,
                overall_value: 0,
                overall_max: Math.max(1, segTotal * 6),
                remaining_segments: Math.max(0, segTotal - 1),
            });
        });

        api.addEventListener("execution_error", ({ detail }) => {
            const node = findDirectorNode(detail?.node_id);
            if (node?._minimaxEditor) {
                node._minimaxEditor.setRunError(detail?.exception_message || "执行出错");
            }
        });

        patchDirectorDomWidgetLayout();
        setTimeout(patchDirectorDomWidgetLayout, 500);
    },
    async loadedGraphNode(node) {
        if (!isMiniMaxH3DirectorNode(node)) return;
        normalizeDirectorOutputs(node);
        repairDirectorStudioWidgets(node);
        if (!node._minimaxDomWidget) return;
        finalizeDirectorWidgetOrder(node);
        ensureDirectorDomWidgetWidth(node);
        bindDirectorDomWidgetSizing(node, node._minimaxDomWidget, () => node._minimaxEditor);
        initDirectorEditor(node);
        // Repair again after widget reorder / late combo options
        setTimeout(() => repairDirectorStudioWidgets(node), 0);
        setTimeout(() => repairDirectorStudioWidgets(node), 300);
        node._minimaxEditor?.scheduleRender?.();
    },
    async getCustomWidgets() {
        return {
            BDGROUP(node, inputName, inputData) {
                const w = makeGroupHeaderWidget(inputName, inputData);
                if (!node.widgets) node.widgets = [];
                node.widgets.push(w);
                return w;
            },
        };
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!isDirectorNodeDef(nodeType, nodeData)) return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated?.apply(this, arguments);
            normalizeDirectorOutputs(this);
            applyDirectorWidgetLabels(this);
            this.size = [1000, 680];

            // Idempotent: avoid a second DOM stack if onNodeCreated is wrapped twice.
            if (this._minimaxDomWidget?.element) {
                setTimeout(() => {
                    finalizeDirectorWidgetOrder(this);
                    initDirectorEditor(this);
                }, 0);
                return r;
            }

            const container = document.createElement("div");
            container.className = "mmx-host";
            container.style.minHeight = `${getDirectorUiHeight(null)}px`;
            container.style.setProperty("--comfy-widget-min-height", String(getDirectorUiHeight(null)));
            const self = this;
            const widget = this.addDOMWidget("minimax_director_ui", "director", container, {
                getValue: () => "",
                setValue: () => {},
                getMinHeight: () => getDirectorUiHeight(self._minimaxEditor),
                hideOnZoom: false,
                onDraw() {
                    if (self._minimaxEditor?.isPlaying) return;
                    ensureDirectorDomWidgetWidth(self);
                },
                afterResize: () => {
                    if (self._minimaxEditor?.isPlaying || self._minimaxEditor?._pauseSettling) return;
                    ensureDirectorDomWidgetWidth(self);
                    self._minimaxEditor?.onNodeResize?.();
                },
            });
            bindDirectorDomWidgetSizing(self, widget, () => self._minimaxEditor);
            widget.element = container;
            ensureDirectorDomWidgetWidth(self);
            self._minimaxDomWidget = widget;
            finalizeDirectorWidgetOrder(self);

            setTimeout(() => {
                finalizeDirectorWidgetOrder(self);
                initDirectorEditor(self);
            }, 0);
            return r;
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            ensureDirectorDomWidgetWidth(this);
            const out = onResize?.apply(this, arguments);
            if (!this._minimaxEditor?.isPlaying && !this._minimaxEditor?._pauseSettling) {
                this._minimaxEditor?.onNodeResize?.(size);
            }
            return out;
        };

        const onSelected = nodeType.prototype.onSelected;
        nodeType.prototype.onSelected = function () {
            ensureDirectorDomWidgetWidth(this);
            const out = onSelected?.apply(this, arguments);
            this._minimaxEditor?.scheduleRender?.();
            return out;
        };

        const onDeselected = nodeType.prototype.onDeselected;
        nodeType.prototype.onDeselected = function () {
            const out = onDeselected?.apply(this, arguments);
            if (this._minimaxEditor?.isPlaying) this._minimaxEditor._stopPlay();
            return out;
        };

        const onRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            this._minimaxEditor?.destroy();
            return onRemoved?.apply(this, arguments);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            normalizeDirectorOutputs(this);
            const out = onConfigure?.apply(this, arguments);
            setTimeout(() => {
                finalizeDirectorWidgetOrder(this);
                const ed = initDirectorEditor(this) || this._minimaxEditor;
                if (!ed) return;
                const initTotal = Math.max(0, parseInt(ed.totalFramesWidget?.value || 124, 10));
                const initFps = coerceTimelineFps(ed.frameRateWidget?.value || 24);
                ed.timeline = parseTimeline(ed.timelineWidget?.value, initTotal, initFps);
                ed.syncFrameRateUI(ed.timeline.frameRate);
                ed._directorMode = ed.getDirectorMode();
                if (ed._directorMode === "video") {
                    ed.restoreVideoFromTimeline();
                } else if (ed._directorMode === "prompt_batch" || ed._directorMode === "image_batch") {
                    ensureImageBatchTimeline(ed);
                } else {
                    ed.ensureGenTimeline();
                }
                ed.applyTaskLayout(ed._directorMode);
                ed.populateTaskSelect(ed.globalTask, ed.taskTypeWidget?.value);
                ed.setEditMode(ed.timeline.editMode || "global");
                ed.selectedIndex = 0;
                ed.updateSelectionUI();
                ed.commit(true, { syncTimeline: false });
            }, 80);
            return out;
        };
    },
});
