/** Multi prompt-group UI for t2i / i2i / r2i / t2v / i2v / r2v / m2v (prompt batch mode). */

import { api } from "../../scripts/api.js";
import {
    DEFAULT_ASPECT_RATIO,
    DEFAULT_MEGAPIXELS,
    defaultDurationSec,
    defaultFrameCount,
    durationToMiniMaxFrames,
    framesToDurationSec,
    imageBatchVariant,
    isMotionTransferTask,
    isR2vLikeTask,
    isVideoBatchTask,
    MAX_GEN_FRAMES,
    MAX_REFERENCE_AUDIOS,
    MAX_REFERENCE_IMAGES,
    MAX_REFERENCE_VIDEOS,
    maxDurationSec,
    maxUserReferenceImages,
    MINIMAX_CANVAS_MULTIPLE,
    minDurationSec,
    minFrameCount,
    newBatchSegment,
    preferredDurationSecFromFrames,
    refAudioLabel,
    refImageLabel,
    refVideoLabel,
    resolveTaskKey,
    userRefStartIndex,
} from "./minimax_gen_timeline.js";
import { wirePromptImageMentions } from "./minimax_prompt_mentions.js";

const _players = new WeakMap();

function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}

function isChainContinuityOn(editor) {
    const out = editor?.timeline?.output;
    return out?.continuityEnabled === true || out?.continuity_enabled === true;
}

/**
 * When enabling chain continuity, shift user refs to slots 1–8 (Picture 2–9)
 * so slot 0 / 图片1 is reserved for the chain first-frame.
 * When disabling, shift back down.
 */
export function migrateRefsForChainContinuity(editor, enabled) {
    const migrateList = (refs) => {
        if (!Array.isArray(refs)) return [];
        if (enabled) {
            return refs
                .map((r) => {
                    const idx = Number(r.index ?? r.slot);
                    if (!Number.isFinite(idx)) return null;
                    const next = idx + 1;
                    if (next >= MAX_REFERENCE_IMAGES) return null;
                    return { ...r, index: next, slot: next };
                })
                .filter(Boolean);
        }
        return refs
            .map((r) => {
                const idx = Number(r.index ?? r.slot);
                if (!Number.isFinite(idx) || idx <= 0) return null;
                const next = idx - 1;
                return { ...r, index: next, slot: next };
            })
            .filter(Boolean);
    };
    for (const seg of editor?.timeline?.segments || []) {
        seg.refs = migrateList(seg.refs);
    }
    if (editor?.timeline?.global) {
        editor.timeline.global.refs = migrateList(editor.timeline.global.refs);
    }
}

function appendChainReservedSlot(refsEl, segIndex) {
    const slot = document.createElement("div");
    slot.className = "h3d-batch-ref first-frame chain-reserved";
    slot.title = segIndex > 0
        ? "图片1 · 链式首帧：运行时自动用上一组生成视频的末帧（已占用）"
        : "图片1 · 链式首帧槽：第 1 组可不传；从第 2 组起自动接力上一组末帧";
    slot.textContent = segIndex > 0 ? "图片1\n自动接力" : "图片1\n首帧槽";
    const tag = document.createElement("span");
    tag.className = "ff-tag";
    tag.textContent = "首帧";
    slot.appendChild(tag);
    refsEl.appendChild(slot);
}

function appendUserRefImageSlots(refsEl, seg, segIndex, editor, opts = {}) {
    const chainOn = isChainContinuityOn(editor);
    const start = userRefStartIndex(chainOn);
    const count = maxUserReferenceImages(chainOn);
    if (chainOn) appendChainReservedSlot(refsEl, segIndex);
    for (let i = 0; i < count; i++) {
        const slotIndex = start + i;
        const ref = (seg.refs || []).find((r) => Number(r.index ?? r.slot) === slotIndex);
        const slot = document.createElement("div");
        slot.className = "h3d-batch-ref";
        renderRefSlot(slot, ref, slotIndex, segIndex, editor, opts);
        slot.onclick = () => {
            if (editor._batchRefDragMoved) {
                editor._batchRefDragMoved = false;
                return;
            }
            uploadSegRef(editor, segIndex, slotIndex);
        };
        bindBatchRefDrop(slot, editor, segIndex, slotIndex);
        refsEl.appendChild(slot);
    }
}

/** User-facing seconds: keep free-form durationSec; only derive from frames for legacy rows. */
function resolveSegmentDurationSec(seg, defFc) {
    const fc = parseInt(seg._videoFrameCount ?? seg.frameCount ?? seg.length ?? defFc, 10) || defFc;
    if (seg.durationSec != null && Number.isFinite(Number(seg.durationSec))) {
        const sec = Number(seg.durationSec);
        // Heal values that were frames/fps round-trips (124f → 5.17) back to a nice input (5).
        const rawInverse = framesToDurationSec(fc, 24);
        if (Math.abs(sec - rawInverse) < 0.001) {
            return preferredDurationSecFromFrames(fc, 24);
        }
        return Math.round(sec * 100) / 100;
    }
    return preferredDurationSecFromFrames(fc, 24);
}

function formatPreviewFps(value) {
    const fps = Math.round(Number(value) * 100) / 100;
    if (Number.isInteger(fps)) return String(fps);
    return fps.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function stopPlayer(el) {
    const st = _players.get(el);
    if (!st) return;
    st.playing = false;
    if (st.timer) {
        clearInterval(st.timer);
        st.timer = null;
    }
}

function stopAllPlayers(root) {
    root?.querySelectorAll(".h3d-batch-vpreview")?.forEach((wrap) => stopPlayer(wrap));
}

export const IMAGE_BATCH_STYLES = `
.h3d-btn.h3d-disabled,.h3d-btn:disabled{opacity:.38;cursor:not-allowed;pointer-events:none}
.h3d-mode button.h3d-disabled,.h3d-mode button:disabled{opacity:.38;cursor:not-allowed;pointer-events:none}
.h3d-batch{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:8px}
.h3d-batch-i2v-notice{display:none;color:#ffb74d;background:#3a2a12;border:1px solid #a67c00;border-radius:6px;padding:8px 10px;font-size:11px;line-height:1.5}
.h3d-batch-i2v-notice.visible{display:block}
.h3d-batch-global-refs .h3d-batch-refs{width:100%;max-width:none}
.h3d-batch-global-refs .h3d-label{font-size:11px;color:#9aa3b5}
.h3d-batch-src-row{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
.h3d-batch-src-wrap{display:flex;flex-direction:column;gap:4px;min-width:88px}
.h3d-batch-optional-refs{flex:1;min-width:180px}
.h3d-batch-src{position:relative}
.h3d-batch-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.h3d-batch-run-select.active{background:var(--h3d-accent-soft);color:var(--h3d-accent);border-color:var(--h3d-accent)}
.h3d-batch-run-all{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#aaa;cursor:pointer;user-select:none}
.h3d-batch-run-all.hidden{display:none!important}
.h3d-batch-run-all input{width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--h3d-accent)}
.h3d-batch-list{display:flex;flex-direction:column;gap:8px;width:100%;max-height:640px;overflow-y:auto;padding-right:2px}
.h3d-batch-card{background:var(--h3d-surface);border:1px solid var(--h3d-border);border-radius:var(--h3d-radius-panel);padding:8px;display:flex;flex-direction:column;gap:10px;align-items:stretch}
/* r2v：纵向分区，避免与主题 flex 叠层 */
.h3d-batch-card.h3d-batch-r2v{display:flex!important;flex-direction:column!important;gap:12px!important;grid-template-columns:none!important;grid-template-rows:none!important}
.h3d-batch-card.running{border-color:var(--h3d-accent);box-shadow:0 0 0 1px rgba(212,146,58,0.35)}
.h3d-batch-card.done{border-color:var(--h3d-secondary)}
.h3d-batch-card.run-skipped{opacity:.42}
/* selected / run-on must win over .done so timeline ↔ card selection stays visible */
.h3d-batch-card.selected,.h3d-batch-card.selected.done{border-color:var(--h3d-accent);box-shadow:0 0 0 1px rgba(212,146,58,0.35)}
.h3d-batch-card.run-on:not(.run-skipped){border-color:#8a6a3a}
.h3d-batch-card.selected.run-on,.h3d-batch-card.selected.run-on.done{border-color:var(--h3d-accent);box-shadow:0 0 0 1px rgba(212,146,58,0.35)}
.h3d-batch-head{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.h3d-batch-head b{color:#ccc;font-size:11px}
.h3d-batch-run-check{width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--h3d-accent);flex-shrink:0}
.h3d-batch-head-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.h3d-batch-fc{display:flex;align-items:center;gap:4px;color:#888;font-size:10px}
.h3d-batch-fc input{width:52px;background:#181818;border:1px solid #444;border-radius:4px;color:#eee;padding:3px 5px;font-size:11px}
.h3d-batch-del{background:transparent;border:1px solid #553;color:#f88;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer}
.h3d-batch-del:hover{background:#3a1515}
.h3d-batch-media{display:flex;flex-direction:column;gap:4px;min-width:0;max-width:none;width:100%}
.h3d-batch-media:has(.h3d-batch-src-row){max-width:none;min-width:0;grid-column:1/-1}
.h3d-batch-media-refs-only{max-width:none;min-width:0;width:100%;grid-column:1/-1}
.h3d-batch-refs-wide{width:100%;max-width:none!important}
.h3d-batch-optional-refs .h3d-batch-refs{width:100%;max-width:none}
.h3d-batch-src .x{position:absolute;top:1px;right:3px;color:#f88;font-size:12px;line-height:1;z-index:2;cursor:pointer}
.h3d-batch-r2v-imgs,.h3d-batch-r2v-av{
  grid-column:auto!important;grid-row:auto!important;position:relative;z-index:1;
  width:100%;min-width:0;display:flex;flex-direction:column;gap:8px;align-self:stretch;
  flex:0 0 auto!important;height:auto!important;max-height:none!important;
}
.h3d-batch-r2v-av{justify-content:flex-start}
.h3d-batch-src{width:88px;height:88px;border:1px dashed #555;border-radius:4px;background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;color:#666;font-size:9px;text-align:center;padding:4px;box-sizing:border-box}
.h3d-batch-src.has-img{border-style:solid;border-color:#444}
.h3d-batch-src img{width:100%;height:100%;object-fit:contain;background:#000}
/* 图片1–9：始终单行横向排列 */
.h3d-batch-refs{
  display:grid!important;grid-template-columns:repeat(9,minmax(52px,1fr))!important;
  gap:4px;width:100%;max-width:none;overflow-x:auto;overflow-y:hidden;
  padding-bottom:2px;scrollbar-gutter:stable;
}
.h3d-batch-r2v .h3d-batch-refs{width:100%;max-width:none;gap:4px}
.h3d-batch-ref{position:relative;aspect-ratio:1;min-width:52px;border:1px dashed #555;border-radius:3px;background:#111;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;font-size:8px;color:#666}
.h3d-batch-r2v .h3d-batch-ref{aspect-ratio:1;background:#0a0a0a;min-height:0}
.h3d-batch-ref.has-img{border-style:solid;cursor:grab}
.h3d-batch-ref.has-img:active{cursor:grabbing}
.h3d-batch-ref.drag-over{border-color:var(--h3d-accent)!important;box-shadow:inset 0 0 0 2px rgba(224,161,90,.55)}
.h3d-batch-ref.dragging{opacity:.45}
.h3d-batch-ref.from-global{border-color:var(--h3d-accent);box-shadow:inset 0 0 0 1px rgba(59,130,246,.45)}
.h3d-batch-ref.first-frame{border-color:#f59e0b;box-shadow:inset 0 0 0 1px rgba(245,158,11,.5)}
.h3d-batch-ref.first-frame.from-global{border-color:#f59e0b;box-shadow:inset 0 0 0 1px rgba(245,158,11,.55),0 0 0 1px rgba(59,130,246,.4)}
.h3d-batch-ref.chain-reserved{border-style:dashed;border-color:var(--h3d-accent);color:#8f8;font-size:10px;line-height:1.25;text-align:center;cursor:default;background:#152018;white-space:pre-line}
.h3d-batch-ref .g-tag{position:absolute;bottom:1px;left:1px;z-index:2;font-size:8px;line-height:1.2;background:#1d4ed8;color:#fff;padding:1px 3px;border-radius:2px;pointer-events:none}
.h3d-batch-ref .ff-tag{position:absolute;bottom:1px;left:1px;z-index:2;font-size:8px;line-height:1.2;background:#b45309;color:#fff;padding:1px 3px;border-radius:2px;pointer-events:none}
.h3d-batch-ref .role-tag{position:absolute;bottom:1px;left:1px;z-index:2;font-size:8px;line-height:1.2;background:#334155;color:#fff;padding:1px 3px;border-radius:2px;pointer-events:none;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.h3d-batch-ref .role-tag.char{background:#7c3aed}
.h3d-batch-ref .role-tag.scene{background:#0f766e}
.h3d-batch-ref .role-tag.prop{background:#b45309}
.h3d-batch-ref .role-tag.still{background:#b45309}
.h3d-batch-ref .role-tag.from-g{background:#1d4ed8}
.h3d-batch-ref.first-frame.from-global .ff-tag{background:linear-gradient(90deg,#b45309,#1d4ed8)}
.h3d-batch-ref img{width:100%;height:100%;object-fit:cover}
/* r2v：完整展示，不裁切 */
.h3d-batch-r2v .h3d-batch-ref img{width:100%;height:100%;object-fit:contain;object-position:center;background:#000}
.h3d-batch-ref .x{position:absolute;top:0;right:2px;color:#f88;font-size:10px;display:none;line-height:1}
.h3d-batch-ref:hover .x{display:block}
.h3d-batch-media-block{display:flex;flex-direction:column;gap:4px;min-width:0;flex:0 0 auto!important;height:auto!important;min-height:0}
.h3d-batch-media-block .h3d-label{color:#888;font-size:10px}
.h3d-batch-audios,.h3d-batch-videos{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;width:100%;max-width:none}
.h3d-batch-r2v .h3d-batch-audios,.h3d-batch-r2v .h3d-batch-videos{max-width:none;gap:6px;flex:0 0 auto}
.h3d-batch-audio,.h3d-batch-video{position:relative;min-height:48px;border:1px dashed #555;border-radius:4px;background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;padding:8px 6px;box-sizing:border-box;font-size:9px;color:#666;text-align:center;line-height:1.25;height:auto!important;flex:none!important}
.h3d-batch-audio.has-audio,.h3d-batch-video.has-video{border-style:solid;border-color:#4a6a4a;color:#cfe;background:#152015}
.h3d-batch-audio:hover,.h3d-batch-video:hover{border-color:var(--h3d-secondary)}
.h3d-batch-audio .name,.h3d-batch-video .name{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9ad;font-size:9px;padding:0 2px}
.h3d-batch-audio .x,.h3d-batch-video .x{position:absolute;top:1px;right:3px;color:#f88;font-size:12px;display:none;line-height:1}
.h3d-batch-audio:hover .x,.h3d-batch-video:hover .x{display:block}
.h3d-batch-prompts{display:flex;flex-direction:column;gap:4px;min-width:0;position:relative;z-index:0;flex:0 0 auto;width:100%}
.h3d-batch-prompts .h3d-label{color:#888;font-size:10px}
.h3d-batch-prompts textarea{width:100%;min-height:88px;background:#181818;border:1px solid #333;border-radius:4px;color:#eee;padding:6px;resize:vertical;font-size:11px;box-sizing:border-box;font-family:inherit;line-height:1.35}
.h3d-batch-r2v .h3d-batch-prompts{grid-column:auto!important;grid-row:auto!important;min-height:0;order:4}
.h3d-batch-r2v .h3d-batch-prompts textarea{min-height:120px;height:auto!important;resize:vertical;background:#141018}
.h3d-batch-preview{background:#0d0d0d;border:1px solid #333;border-radius:4px;min-height:100px;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;color:#555;font-size:10px;text-align:center;padding:4px;box-sizing:border-box;position:relative;z-index:0;flex:0 0 auto;width:100%}
.h3d-batch-r2v .h3d-batch-preview{grid-column:auto!important;grid-row:auto!important;min-height:140px;height:auto!important;order:5}
.h3d-batch-preview img{max-width:100%;max-height:160px;object-fit:contain;display:block}
.h3d-batch-r2v .h3d-batch-preview img{max-height:180px}
.h3d-batch-vpreview{width:100%;height:100%;display:flex;flex-direction:column;align-items:stretch;gap:4px;min-height:0}
.h3d-batch-vpreview canvas{width:100%;flex:1 1 auto;min-height:80px;max-height:100%;background:#000;border-radius:3px;display:block}
.h3d-batch-vpreview-ctrl{display:flex;align-items:center;justify-content:center;gap:6px}
.h3d-batch-vpreview-ctrl button{font-size:10px;padding:2px 8px}
.h3d-batch-vpreview-meta{color:#666;font-size:9px;text-align:center}
.h3d-batch-r2v .h3d-batch-head{order:0}
.h3d-batch-r2v .h3d-batch-r2v-imgs{order:1}
.h3d-batch-r2v .h3d-batch-r2v-av{order:2}
@media(max-width:720px){
.h3d-batch-preview{min-height:80px}
}
`;

const BATCH_CHUNK_SIZE = 8 * 1024 * 1024;
const BATCH_UPLOAD_SOFT_LIMIT = 95 * 1024 * 1024;

async function uploadImage(file) {
    const body = new FormData();
    body.append("image", file);
    body.append("type", "input");
    body.append("overwrite", "true");
    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
    if (!resp.ok) throw new Error(await resp.text() || `Upload failed (${resp.status})`);
    return resp.json();
}

async function uploadChunked(file) {
    const uploadId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / BATCH_CHUNK_SIZE);
    for (let i = 0; i < totalChunks; i++) {
        const start = i * BATCH_CHUNK_SIZE;
        const end = Math.min(start + BATCH_CHUNK_SIZE, file.size);
        const body = new FormData();
        body.append("upload_id", uploadId);
        body.append("chunk_index", String(i));
        body.append("total_chunks", String(totalChunks));
        body.append("filename", file.name);
        body.append("chunk", file.slice(start, end), `${file.name}.part`);
        const resp = await api.fetchApi("/minimax/director/upload_chunk", { method: "POST", body });
        if (!resp.ok) throw new Error(await resp.text() || `分块上传失败 (${resp.status})`);
        const data = await resp.json();
        if (data.name) return data;
    }
    throw new Error("分块上传未完成");
}

async function uploadMedia(file) {
    if (file.size <= BATCH_UPLOAD_SOFT_LIMIT) {
        try {
            return await uploadImage(file);
        } catch (err) {
            const msg = String(err?.message || err || "");
            if (!/too large|size|413/i.test(msg)) throw err;
        }
    }
    return uploadChunked(file);
}

function relPath(upload) {
    const name = upload.name || upload.filename;
    const sub = (upload.subfolder || "").replace(/\\/g, "/").replace(/\/$/, "");
    return sub ? `${sub}/${name}` : name;
}

function viewUrl(imageFile) {
    const norm = String(imageFile || "").replace(/\\/g, "/");
    const slash = norm.lastIndexOf("/");
    const filename = slash >= 0 ? norm.slice(slash + 1) : norm;
    const subfolder = slash >= 0 ? norm.slice(0, slash) : "";
    const params = new URLSearchParams({ filename, type: "input" });
    if (subfolder) params.set("subfolder", subfolder);
    return api.apiURL(`/view?${params.toString()}`);
}

export function mountImageBatchPanel(root) {
    const panel = document.createElement("div");
    panel.className = "h3d-batch hidden";
    panel.dataset.r = "batch-panel";
    panel.innerHTML = `
        <div class="h3d-section-title" data-r="batch-title"><b>提示词组清单</b><span>纵向卡片</span></div>
        <div class="h3d-batch-toolbar">
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="batch-add">+ 添加提示词组</button>
            <button type="button" class="h3d-btn h3d-btn-danger hidden" data-a="batch-del-selected" title="删除当前选中的素材组 / 提示词组">删除选中组</button>
            <button type="button" class="h3d-btn h3d-batch-run-select hidden" data-a="batch-run-select" title="开启后可勾选要运行的提示词组">选择运行</button>
            <label class="h3d-batch-run-all hidden" data-r="batch-run-all-wrap" title="勾选=全选，取消=全部不选">
                <input type="checkbox" data-r="batch-run-all-cb">
                <span>全选</span>
            </label>
            <span class="h3d-meta" data-r="batch-hint">每组生成 1 张图片</span>
        </div>
        <div class="h3d-batch-i2v-notice" data-r="batch-i2v-notice"></div>
        <div class="h3d-batch-global-refs hidden" data-r="batch-global-refs">
            <div class="h3d-batch-media-block">
                <div class="h3d-studio-row" style="justify-content:space-between;margin-bottom:4px">
                    <span class="h3d-label">全局参考图（图片1–9 纯参考；同步计入各组）</span>
                    <span class="h3d-studio-row" style="gap:4px">
                        <button type="button" class="h3d-btn" data-a="batch-clear-global-refs" title="清空全局条上所有参考图">清空图片</button>
                        <button type="button" class="h3d-btn" data-a="batch-push-global-refs" title="同步到各组参考图槽位（占用图片1–9；不覆盖本组已手动上传的图）">同步到各组</button>
                    </span>
                </div>
                <div class="h3d-batch-refs" data-r="batch-global-refs-grid"></div>
            </div>
        </div>
        <div class="h3d-batch-list" data-r="batch-list"></div>`;
    root.appendChild(panel);
    return {
        panel,
        list: panel.querySelector('[data-r="batch-list"]'),
        hint: panel.querySelector('[data-r="batch-hint"]'),
        i2vNotice: panel.querySelector('[data-r="batch-i2v-notice"]'),
        globalRefsWrap: panel.querySelector('[data-r="batch-global-refs"]'),
        globalRefsGrid: panel.querySelector('[data-r="batch-global-refs-grid"]'),
        title: panel.querySelector('[data-r="batch-title"]'),
        addBtn: panel.querySelector('[data-a="batch-add"]'),
        delBtn: panel.querySelector('[data-a="batch-del-selected"]'),
        runSelectBtn: panel.querySelector('[data-a="batch-run-select"]'),
        runSelectAllWrap: panel.querySelector('[data-r="batch-run-all-wrap"]'),
        runSelectAllCb: panel.querySelector('[data-r="batch-run-all-cb"]'),
    };
}

export function wireBatchRunSelectControls(editor, batchUi) {
    editor.batchRunSelectBtn = batchUi.runSelectBtn;
    editor.batchRunSelectAllWrap = batchUi.runSelectAllWrap;
    editor.batchRunSelectAllCb = batchUi.runSelectAllCb;
    batchUi.runSelectBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        editor.toggleRunSelectMode?.();
    });
    batchUi.runSelectAllCb?.addEventListener("change", (e) => {
        e.stopPropagation();
        if (!editor.isRunSelectEnabled?.()) return;
        editor.setRunSelectionAll?.(batchUi.runSelectAllCb.checked);
    });
}

function cloneRefs(refs) {
    if (!Array.isArray(refs) || !refs.length) return [];
    try {
        return JSON.parse(JSON.stringify(refs));
    } catch {
        return refs.map((r) => ({ ...r }));
    }
}

/** Keep i2v genImage (= first frame) in sync with refs[图片1]. */
function syncSegFirstFrameFromRefs(seg) {
    if (!seg || typeof seg !== "object") return;
    const r0 = (seg.refs || []).find((r) => Number(r.index ?? r.slot) === 0 && r?.imageFile);
    if (r0?.imageFile) {
        seg.genImage = { ...(seg.genImage || {}), imageFile: r0.imageFile };
        seg.imageFile = r0.imageFile;
    } else {
        seg.genImage = { ...(seg.genImage || {}), imageFile: "" };
        seg.imageFile = "";
    }
}

/** Move legacy separate 源图 into refs[0] (首帧 within 图片1–9). */
function migrateGenImageIntoFirstRef(seg) {
    if (!seg || typeof seg !== "object") return false;
    const path = seg.genImage?.imageFile || seg.imageFile || "";
    if (!path) return false;
    const refs = [...(seg.refs || [])];
    const r0 = refs.find((r) => Number(r.index ?? r.slot) === 0);
    if (r0?.imageFile) {
        syncSegFirstFrameFromRefs(seg);
        return false;
    }
    const filtered = refs.filter((r) => Number(r.index ?? r.slot) !== 0);
    filtered.push({
        index: 0,
        imageFile: path,
        imageB64: "",
        fromGlobal: false,
        role: "first",
    });
    seg.refs = filtered.sort((a, b) => Number(a.index ?? a.slot) - Number(b.index ?? b.slot));
    syncSegFirstFrameFromRefs(seg);
    return true;
}

/**
 * Sync global.refs into each prompt group's refs (图片1–9).
 * - Occupies the same slot indices within MAX_REFERENCE_IMAGES
 * - Marks with fromGlobal:true for UI badge「全局」
 * - i2i only: slot 0 syncs genImage; i2v/r2v refs are pure reference
 * - Does not overwrite slots the user uploaded locally
 */
export function migrateGlobalRefsIntoBatchSegments(editor, taskKey) {
    const key = resolveTaskKey(taskKey || editor.getTaskKey?.() || "");
    if (!["r2i", "r2v", "m2v", "i2v", "i2i"].includes(key)) return false;
    const globalRefs = (editor.timeline?.global?.refs || []).filter((r) => r?.imageFile);
    if (!globalRefs.length) return false;
    let moved = false;
    for (const seg of editor.timeline.segments || []) {
        if (!seg || typeof seg !== "object") continue;
        if (key === "i2i") migrateGenImageIntoFirstRef(seg);
        let refs = [...(seg.refs || [])];
        let changed = false;
        for (const g of globalRefs) {
            const idx = Number(g.index ?? g.slot);
            if (!Number.isFinite(idx) || idx < 0 || idx >= MAX_REFERENCE_IMAGES) continue;
            const existing = refs.find((r) => Number(r.index ?? r.slot) === idx);
            // Keep local uploads; refresh or fill global-tagged / empty slots
            if (existing?.imageFile && !existing.fromGlobal) continue;
            refs = refs.filter((r) => Number(r.index ?? r.slot) !== idx);
            refs.push({
                index: idx,
                imageFile: g.imageFile,
                imageB64: g.imageB64 || "",
                fromGlobal: true,
                role: key === "i2i" && idx === 0 ? (g.role || "first") : (g.role || ""),
                roleLabel: g.roleLabel || "",
                fromDirector: !!g.fromDirector,
            });
            changed = true;
        }
        if (changed) {
            seg.refs = refs.sort((a, b) => Number(a.index ?? a.slot) - Number(b.index ?? b.slot));
            if (key === "i2i") syncSegFirstFrameFromRefs(seg);
            moved = true;
        }
    }
    return moved;
}

export function ensureImageBatchTimeline(editor) {
    // Keep 整局/分镜; only default to 分镜 when unset.
    if (editor.timeline.editMode !== "global" && editor.timeline.editMode !== "segment") {
        editor.timeline.editMode = "segment";
    }
    editor.timeline.output = editor.timeline.output || {};
    const taskKey = resolveTaskKey(editor.getTaskKey?.() || editor.taskTypeWidget?.value);
    editor.timeline.output.mode = "fixed";
    if (!editor.timeline.output.aspectRatio) editor.timeline.output.aspectRatio = DEFAULT_ASPECT_RATIO;
    if (editor.timeline.output.megapixels == null) editor.timeline.output.megapixels = DEFAULT_MEGAPIXELS;
    if (editor.timeline.output.multiple == null) editor.timeline.output.multiple = MINIMAX_CANVAS_MULTIPLE;
    if (!isVideoBatchTask(taskKey)) {
        editor.timeline.output.exportMode = "all";
    }
    const defFc = defaultFrameCount(taskKey);
    if (taskKey === "i2v") {
        editor.timeline.video = {
            fileName: "",
            videoFile: "",
            subfolder: "",
            type: "input",
            frames: [],
            frameMap: [],
        };
        editor.timeline.videoClips = [];
    }
    if (!editor.timeline.segments?.length) {
        editor.timeline.segments = [newBatchSegment({ durationSec: defaultDurationSec(taskKey) })];
    }
    // r2i/r2v need per-group refs. If the user came from rv2v (global refs) or left
    // refs only on global, copy them into empty batch groups so generation actually
    // receives reference_image_* — otherwise it silently behaves like t2v/t2i.
    migrateGlobalRefsIntoBatchSegments(editor, taskKey);
    const isM2v = isMotionTransferTask(taskKey);
    for (const seg of editor.timeline.segments) {
        if (isVideoBatchTask(taskKey)) {
            const sec = resolveSegmentDurationSec(seg, defFc);
            const fc = durationToMiniMaxFrames(sec, 24);
            seg.durationSec = sec;
            seg.frameCount = fc;
            // m2v：length 属于媒体轨动作源区间，不能被生成帧数覆盖
            if (!isM2v) seg.length = fc;
            seg._videoFrameCount = fc;
        } else {
            const prevFc = parseInt(seg.frameCount ?? seg.length, 10) || 0;
            if (prevFc > 1) seg._videoFrameCount = prevFc;
            seg.frameCount = 1;
            seg.length = 1;
        }
        seg.negativePrompt = seg.negativePrompt ?? "";
        seg.genImage = seg.genImage || { imageFile: seg.imageFile || "" };
        // i2v refs are pure reference; only i2i keeps genImage↔图片1 source sync.
        seg.refs = seg.refs || [];
        if (taskKey === "i2i") {
            migrateGenImageIntoFirstRef(seg);
            syncSegFirstFrameFromRefs(seg);
        }
        seg.refAudios = seg.refAudios || seg.ref_audios || [];
        seg.refVideos = seg.refVideos || seg.ref_videos || [];
        seg.previewB64 = seg.previewB64 || "";
        seg.previewFrames = seg.previewFrames || [];
        seg.previewFps = seg.previewFps || parseFloat(editor.frameRateWidget?.value || 24);
        if (!seg.id) seg.id = newBatchSegment().id;
    }
    normalizeImageBatchSegments(editor);
}

export function normalizeImageBatchSegments(editor) {
    const taskKey = resolveTaskKey(editor.getTaskKey?.() || editor.taskTypeWidget?.value);
    const isVideo = isVideoBatchTask(taskKey);
    const isM2v = isMotionTransferTask(taskKey);
    const defFc = defaultFrameCount(taskKey);
    const defSec = defaultDurationSec(taskKey);
    let start = 0;
    const fixed = [];
    for (const seg of editor.timeline.segments) {
        let fc = 1;
        let durationSec;
        if (isVideo) {
            const sec = resolveSegmentDurationSec(seg, defFc);
            const clampedSec = clamp(sec || defSec, minDurationSec(), maxDurationSec());
            fc = durationToMiniMaxFrames(clampedSec, 24);
            durationSec = clampedSec;
        }
        if (isM2v) {
            const trackStart = parseInt(seg.start, 10);
            const trackLen = parseInt(seg.length, 10);
            const useStart = Number.isFinite(trackStart) ? trackStart : start;
            const useLen = Number.isFinite(trackLen) && trackLen > 0 ? trackLen : fc;
            fixed.push({
                ...seg,
                start: useStart,
                length: useLen,
                frameCount: fc,
                ...(isVideo ? { durationSec } : {}),
                prompt: FIXED_M2V_PROMPT,
                negativePrompt: "",
                genImage: seg.genImage || { imageFile: "" },
                refs: seg.refs || [],
                refAudios: seg.refAudios || [],
                refVideos: [],
                _videoFrameCount: seg._videoFrameCount,
                previewB64: seg.previewB64 || "",
                previewFrames: seg.previewFrames || [],
                previewFps: seg.previewFps || parseFloat(editor.frameRateWidget?.value || 24),
            });
            start = useStart + useLen;
            continue;
        }
        fixed.push({
            ...seg,
            start,
            length: fc,
            frameCount: fc,
            ...(isVideo ? { durationSec } : {}),
            negativePrompt: seg.negativePrompt ?? "",
            genImage: seg.genImage || { imageFile: "" },
            refs: seg.refs || [],
            refAudios: seg.refAudios || [],
            refVideos: seg.refVideos || [],
            _videoFrameCount: seg._videoFrameCount,
            previewB64: seg.previewB64 || "",
            previewFrames: seg.previewFrames || [],
            previewFps: seg.previewFps || parseFloat(editor.frameRateWidget?.value || 24),
        });
        start += fc;
    }
    if (!fixed.length) fixed.push(newBatchSegment({ durationSec: defSec }));
    editor.timeline.segments = fixed;
    if (isM2v) {
        editor.timeline.global = editor.timeline.global || {};
        editor.timeline.global.prompt = FIXED_M2V_PROMPT;
        const videoTotal = typeof editor.getTotalFrames === "function"
            ? editor.getTotalFrames()
            : (parseInt(editor.timeline.totalFrames, 10) || 0);
        editor.timeline.totalFrames = videoTotal > 0 ? videoTotal : (start || fixed[0].frameCount);
    } else {
        editor.timeline.totalFrames = start || fixed[0].frameCount;
    }
}

export function addImageBatchGroup(editor) {
    const taskKey = resolveTaskKey(editor.getTaskKey?.() || editor.taskTypeWidget?.value);
    editor.timeline.segments.push(newBatchSegment({
        durationSec: defaultDurationSec(taskKey),
        negativePrompt: "",
    }));
    normalizeImageBatchSegments(editor);
    editor.selectedIndex = Math.max(0, editor.timeline.segments.length - 1);
    editor.renderImageBatchGroups();
    editor.commit();
    editor.updateVideoNameLabel?.();
    editor.updateDomWidgetHeight?.();
}

export function deleteImageBatchGroup(editor, index) {
    if (editor.timeline.segments.length <= 1) return;
    editor.timeline.segments.splice(index, 1);
    normalizeImageBatchSegments(editor);
    editor.selectedIndex = clamp(
        editor.selectedIndex > index ? editor.selectedIndex - 1 : editor.selectedIndex,
        0,
        editor.timeline.segments.length - 1,
    );
    editor.renderImageBatchGroups();
    editor.commit();
    editor.updateVideoNameLabel?.();
    editor.updateDomWidgetHeight?.();
}

function pickFile(accept, onFile) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
        const file = input.files?.[0];
        if (file) onFile(file);
    };
    input.click();
}

async function uploadSegSource(editor, index) {
    pickFile("image/*", async (file) => {
        try {
            const uploaded = await uploadImage(file);
            const seg = editor.timeline.segments[index];
            if (!seg) return;
            const imageFile = relPath(uploaded);
            const dims = await readImageDimensions(file);
            seg.genImage = { imageFile, width: dims.width, height: dims.height };
            seg.imageFile = imageFile;
            editor.renderImageBatchGroups();
            editor.updateOutputPreview?.();
            editor.commit();
        } catch (err) {
            console.error("[MiniMax H3Director] batch source upload failed:", err);
        }
    });
}

function clearSegSource(editor, index) {
    const seg = editor.timeline.segments[index];
    if (!seg) return;
    seg.genImage = { imageFile: "" };
    seg.imageFile = "";
    editor.renderImageBatchGroups();
    editor.commit();
}

async function uploadGlobalRef(editor, slot) {
    pickFile("image/*", async (file) => {
        try {
            const uploaded = await uploadImage(file);
            const g = editor.timeline.global = editor.timeline.global || { refs: [] };
            g.refs = (g.refs || []).filter((r) => Number(r.index ?? r.slot) !== slot);
            g.refs.push({ index: slot, imageFile: relPath(uploaded), imageB64: "" });
            editor.renderImageBatchGroups();
            editor.commit();
        } catch (err) {
            console.error("[MiniMax H3Director] global ref upload failed:", err);
        }
    });
}

function removeGlobalRef(editor, slot) {
    const g = editor.timeline.global;
    if (!g) return;
    g.refs = (g.refs || []).filter((r) => Number(r.index ?? r.slot) !== slot);
    editor.renderImageBatchGroups();
    editor.commit();
}

/** Clear all timeline.global.refs (batch global strip). */
export function clearAllGlobalBatchRefs(editor) {
    const g = editor.timeline.global = editor.timeline.global || { refs: [] };
    g.refs = [];
    editor.renderImageBatchGroups?.();
    editor.commit?.();
}

/** Clear one segment's reference images (optional: also clear audio/video for r2v). */
export function clearSegBatchRefs(editor, segIndex, { images = true, audios = false, videos = false } = {}) {
    const seg = editor.timeline?.segments?.[segIndex];
    if (!seg) return;
    if (images) {
        seg.refs = [];
        if (seg.genImage) seg.genImage = { ...(seg.genImage || {}), imageFile: "" };
        seg.imageFile = "";
    }
    if (audios) seg.refAudios = [];
    if (videos) seg.refVideos = [];
    editor.renderImageBatchGroups?.();
    editor.commit?.();
}

function renderGlobalRefsStrip(editor) {
    const wrap = editor.batchGlobalRefsWrap;
    const grid = editor.batchGlobalRefsGrid;
    if (!wrap || !grid) return;
    const key = resolveTaskKey(editor.getTaskKey?.() || editor.taskTypeWidget?.value);
    const globalScope = (editor.timeline?.editMode || "global") === "global";
    // 动作迁移整局：只需「整局素材」一层角色图，隐藏全局条（若全局有图则并入第 1 组）
    if (isMotionTransferTask(key) && globalScope) {
        migrateGlobalRefsIntoBatchSegments(editor, key);
        wrap.classList.add("hidden");
        grid.innerHTML = "";
        return;
    }
    const show = key === "i2v" || key === "i2i" || isR2vLikeTask(key) || key === "r2i";
    wrap.classList.toggle("hidden", !show);
    if (!show) return;
    const g = editor.timeline.global = editor.timeline.global || { refs: [] };
    g.refs = g.refs || [];
    grid.innerHTML = "";
    const chainOn = (key === "i2v" || isR2vLikeTask(key)) && isChainContinuityOn(editor);
    const start = userRefStartIndex(chainOn);
    const count = maxUserReferenceImages(chainOn);
    if (chainOn) {
        const reserved = document.createElement("div");
        reserved.className = "h3d-batch-ref first-frame chain-reserved";
        reserved.title = "图片1 · 链式首帧（各组运行时占用；全局条不上传此槽）";
        reserved.textContent = "图片1\n首帧槽";
        const tag = document.createElement("span");
        tag.className = "ff-tag";
        tag.textContent = "首帧";
        reserved.appendChild(tag);
        grid.appendChild(reserved);
    }
    for (let i = 0; i < count; i++) {
        const slotIndex = start + i;
        const ref = (g.refs || []).find((r) => Number(r.index ?? r.slot) === slotIndex);
        const slot = document.createElement("div");
        slot.className = `h3d-batch-ref${ref?.imageFile ? " has-img" : ""}`;
        const label = refImageLabel(slotIndex);
        slot.title = slotIndex === 0 && key === "i2i"
            ? `${label} — 全局源图（同步后计入各组图片1）`
            : `${label} — 全局参考图；点击上传`;
        if (ref?.imageFile) {
            const img = document.createElement("img");
            img.src = viewUrl(ref.imageFile);
            img.draggable = false;
            slot.appendChild(img);
            const badge = refRoleBadge(ref, {
                isFirst: slotIndex === 0,
                fromGlobal: false,
            });
            if (badge) {
                const tag = document.createElement("span");
                const plain = String(ref.roleLabel || badge).replace(/^全局·/, "") || badge;
                tag.className = (slotIndex === 0 && (!ref.role || ref.role === "first" || ref.role === "still"))
                    ? "ff-tag"
                    : roleTagClass(ref, false);
                tag.textContent = plain;
                slot.appendChild(tag);
                if (slotIndex === 0) slot.classList.add("first-frame");
            }
            const x = document.createElement("span");
            x.className = "x";
            x.textContent = "×";
            x.onclick = (e) => { e.stopPropagation(); removeGlobalRef(editor, slotIndex); };
            slot.appendChild(x);
        } else {
            slot.textContent = slotIndex === 0 && key === "i2i" ? `${label}\n源图` : label;
        }
        slot.onclick = () => {
            if (editor._batchRefDragMoved) {
                editor._batchRefDragMoved = false;
                return;
            }
            uploadGlobalRef(editor, slotIndex);
        };
        bindBatchRefDrop(slot, editor, -1, slotIndex);
        grid.appendChild(slot);
    }
}

/** i2i: 源图 = 图片1；i2v 已改为纯参考槽，不再走此路径。 */
function appendSourceAndOptionalRefs(card, seg, index, editor) {
    migrateGenImageIntoFirstRef(seg);
    syncSegFirstFrameFromRefs(seg);
    const media = document.createElement("div");
    media.className = "h3d-batch-media h3d-batch-media-refs-only";
    const block = document.createElement("div");
    block.className = "h3d-batch-optional-refs";
    const head = document.createElement("div");
    head.className = "h3d-studio-row";
    head.style.cssText = "justify-content:space-between;margin-bottom:2px";
    head.innerHTML = `
        <span class="h3d-label">参考图（图片1=源图，共 9 槽；可含全局同步）</span>
        <button type="button" class="h3d-btn" data-a="batch-clear-seg-refs" title="清空本组全部参考图">清空图片</button>`;
    head.querySelector('[data-a="batch-clear-seg-refs"]').onclick = (e) => {
        e.stopPropagation();
        clearSegBatchRefs(editor, index, { images: true });
    };
    block.appendChild(head);
    const refs = document.createElement("div");
    refs.className = "h3d-batch-refs h3d-batch-refs-wide";
    for (let i = 0; i < MAX_REFERENCE_IMAGES; i++) {
        const ref = (seg.refs || []).find((r) => Number(r.index ?? r.slot) === i);
        const slot = document.createElement("div");
        slot.className = "h3d-batch-ref";
        renderRefSlot(slot, ref, i, index, editor, { markFirstFrame: true });
        slot.onclick = () => {
            if (editor._batchRefDragMoved) {
                editor._batchRefDragMoved = false;
                return;
            }
            uploadSegRef(editor, index, i);
        };
        bindBatchRefDrop(slot, editor, index, i);
        refs.appendChild(slot);
    }
    block.appendChild(refs);
    media.appendChild(block);
    card.appendChild(media);
}

function readImageDimensions(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("Failed to read image dimensions"));
        };
        img.src = url;
    });
}

async function assignSegRefFromFile(editor, index, slot, file) {
    if (!file?.type?.startsWith("image/")) return;
    try {
        const uploaded = await uploadImage(file);
        const seg = editor.timeline.segments[index];
        if (!seg) return;
        const taskKey = resolveTaskKey(editor.getTaskKey?.() || "");
        seg.refs = (seg.refs || []).filter((r) => Number(r.index ?? r.slot) !== slot);
        seg.refs.push({
            index: slot,
            imageFile: relPath(uploaded),
            imageB64: "",
            fromGlobal: false,
            role: taskKey === "i2i" && slot === 0 ? "first" : "",
        });
        if (taskKey === "i2i") syncSegFirstFrameFromRefs(seg);
        editor.renderImageBatchGroups();
        editor.commit();
    } catch (err) {
        console.error("[MiniMax H3Director] batch ref upload failed:", err);
    }
}

async function uploadSegRef(editor, index, slot) {
    pickFile("image/*", (file) => assignSegRefFromFile(editor, index, slot, file));
}

const REF_DRAG_MIME = "application/x-minimax-ref-slot";

function getBatchRefOwner(editor, segIndex) {
    if (segIndex < 0) {
        const g = editor.timeline.global = editor.timeline.global || { refs: [] };
        g.refs = g.refs || [];
        return g;
    }
    return editor.timeline.segments?.[segIndex] || null;
}

function normalizeRefRole(ref, slot) {
    if (!ref) return ref;
    const role = ref.role === "first" && slot !== 0 ? "" : (ref.role || "");
    return { ...ref, index: slot, slot: undefined, role };
}

function swapBatchRefSlots(owner, fromSlot, toSlot) {
    if (!owner || fromSlot === toSlot) return false;
    const refs = [...(owner.refs || [])];
    const fromRef = refs.find((r) => Number(r.index ?? r.slot) === fromSlot);
    if (!fromRef?.imageFile && !fromRef?.imageB64) return false;
    const toRef = refs.find((r) => Number(r.index ?? r.slot) === toSlot);
    owner.refs = refs.filter((r) => {
        const idx = Number(r.index ?? r.slot);
        return idx !== fromSlot && idx !== toSlot;
    });
    owner.refs.push(normalizeRefRole(fromRef, toSlot));
    if (toRef) owner.refs.push(normalizeRefRole(toRef, fromSlot));
    return true;
}

function writeBatchRefSlot(owner, slot, ref, { fromGlobal = false } = {}) {
    if (!owner) return;
    owner.refs = (owner.refs || []).filter((r) => Number(r.index ?? r.slot) !== slot);
    if (!ref) return;
    const next = normalizeRefRole({
        ...ref,
        fromGlobal: fromGlobal || !!ref.fromGlobal,
        imageB64: ref.imageB64 || "",
    }, slot);
    if (fromGlobal) next.fromGlobal = true;
    owner.refs.push(next);
}

function clearBatchRefSlot(owner, slot) {
    if (!owner) return;
    owner.refs = (owner.refs || []).filter((r) => Number(r.index ?? r.slot) !== slot);
}

function afterBatchRefMutation(editor, ...segIndexes) {
    const key = resolveTaskKey(editor.getTaskKey?.() || "");
    if (key === "i2i") {
        for (const idx of segIndexes) {
            if (idx < 0) continue;
            const seg = editor.timeline.segments?.[idx];
            if (seg) syncSegFirstFrameFromRefs(seg);
        }
    }
    editor.renderImageBatchGroups();
    editor.commit();
}

function moveBatchRefSlot(editor, segIndex, fromSlot, toSlot) {
    const owner = getBatchRefOwner(editor, segIndex);
    if (!swapBatchRefSlots(owner, fromSlot, toSlot)) return;
    afterBatchRefMutation(editor, segIndex);
}

async function askRefCopyOrMove(editor, message) {
    if (typeof editor.showBdDialog === "function") {
        return editor.showBdDialog({
            title: "参考图拖放",
            message,
            items: [
                { value: "copy", label: "复制 — 写入目标槽，源位置保留" },
                { value: "move", label: "移动 — 写入目标槽，源位置清空" },
            ],
            confirmText: "确定",
            cancelText: "取消",
        });
    }
    // eslint-disable-next-line no-alert
    const ok = window.confirm(`${message}\n\n确定=复制，取消=放弃（移动请用弹窗；此处仅复制）`);
    return ok ? "copy" : null;
}

async function transferBatchRefCross(editor, fromSeg, fromSlot, toSeg, toSlot, mode) {
    const src = getBatchRefOwner(editor, fromSeg);
    const dst = getBatchRefOwner(editor, toSeg);
    if (!src || !dst) return;
    const fromRef = (src.refs || []).find((r) => Number(r.index ?? r.slot) === fromSlot);
    if (!fromRef?.imageFile && !fromRef?.imageB64) return;
    const fromGlobal = fromSeg < 0;
    writeBatchRefSlot(dst, toSlot, fromRef, { fromGlobal: fromGlobal && mode === "copy" });
    if (mode === "move") clearBatchRefSlot(src, fromSlot);
    afterBatchRefMutation(editor, fromSeg, toSeg);
}

function bindBatchRefDrop(slot, editor, index, slotIndex) {
    const hasImg = slot.classList.contains("has-img");
    const isGlobal = index < 0;
    slot.draggable = hasImg;
    if (hasImg) {
        slot.title = (slot.title || "") + (slot.title?.includes("拖") ? "" : "；拖到其他格可换位 / 跨组复制或移动");
    }
    slot.addEventListener("dragstart", (e) => {
        if (!hasImg || slot.classList.contains("chain-reserved")) {
            e.preventDefault();
            return;
        }
        editor._batchRefDragMoved = false;
        slot.classList.add("dragging");
        const payload = JSON.stringify({
            scope: isGlobal ? "global" : "seg",
            segIndex: index,
            from: slotIndex,
        });
        e.dataTransfer.setData(REF_DRAG_MIME, payload);
        e.dataTransfer.setData("text/plain", payload);
        e.dataTransfer.effectAllowed = "copyMove";
    });
    slot.addEventListener("dragend", () => {
        slot.classList.remove("dragging");
        editor.root?.querySelectorAll?.(".h3d-batch-ref.drag-over")
            ?.forEach?.((el) => el.classList.remove("drag-over"));
        setTimeout(() => { editor._batchRefDragMoved = false; }, 0);
    });
    slot.addEventListener("dragover", (e) => {
        if (slot.classList.contains("chain-reserved")) return;
        const types = [...(e.dataTransfer?.types || [])];
        if (!types.includes(REF_DRAG_MIME) && !types.includes("Files") && !types.includes("text/plain")) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        slot.classList.add("drag-over");
        e.dataTransfer.dropEffect = types.includes(REF_DRAG_MIME) ? "move" : "copy";
    });
    slot.addEventListener("dragleave", () => {
        slot.classList.remove("drag-over");
    });
    slot.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        slot.classList.remove("drag-over");
        if (slot.classList.contains("chain-reserved")) return;
        const raw = e.dataTransfer.getData(REF_DRAG_MIME)
            || e.dataTransfer.getData("text/plain");
        if (raw) {
            try {
                const data = JSON.parse(raw);
                const fromSeg = Number(data.segIndex);
                const fromSlot = Number(data.from);
                if (!Number.isFinite(fromSeg) || !Number.isFinite(fromSlot)) return;
                if (fromSeg === index && fromSlot === slotIndex) return;
                editor._batchRefDragMoved = true;
                const sameLevel = fromSeg === index;
                if (sameLevel) {
                    moveBatchRefSlot(editor, index, fromSlot, slotIndex);
                    return;
                }
                const fromLab = fromSeg < 0 ? "全局" : `提示词组 ${fromSeg + 1}`;
                const toLab = index < 0 ? "全局" : `提示词组 ${index + 1}`;
                const mode = await askRefCopyOrMove(
                    editor,
                    `将「${fromLab} · 图片${fromSlot + 1}」放到「${toLab} · 图片${slotIndex + 1}」。请选择复制或移动：`,
                );
                if (mode !== "copy" && mode !== "move") return;
                await transferBatchRefCross(editor, fromSeg, fromSlot, index, slotIndex, mode);
                return;
            } catch (_) { /* fall through */ }
        }
        const f = e.dataTransfer.files?.[0];
        if (f?.type?.startsWith("image/")) {
            if (isGlobal) {
                try {
                    const uploaded = await uploadImage(f);
                    const g = getBatchRefOwner(editor, -1);
                    writeBatchRefSlot(g, slotIndex, {
                        imageFile: relPath(uploaded),
                        imageB64: "",
                        fromGlobal: false,
                    });
                    afterBatchRefMutation(editor, -1);
                } catch (err) {
                    console.error("[MiniMax H3Director] global ref drop failed:", err);
                }
            } else {
                assignSegRefFromFile(editor, index, slotIndex, f);
            }
        }
    });
}

function removeSegRef(editor, index, slot) {
    const seg = editor.timeline.segments[index];
    if (!seg) return;
    seg.refs = (seg.refs || []).filter((r) => Number(r.index ?? r.slot) !== slot);
    if (resolveTaskKey(editor.getTaskKey?.() || "") === "i2i") syncSegFirstFrameFromRefs(seg);
    editor.renderImageBatchGroups();
    editor.commit();
}

async function uploadSegAudio(editor, index, slot) {
    pickFile("audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac", async (file) => {
        try {
            const uploaded = await uploadMedia(file);
            const seg = editor.timeline.segments[index];
            if (!seg) return;
            seg.refAudios = (seg.refAudios || []).filter((r) => Number(r.index ?? r.slot) !== slot);
            seg.refAudios.push({
                index: slot,
                audioFile: relPath(uploaded),
                fileName: uploaded?.name || file.name,
                type: "input",
                subfolder: uploaded?.subfolder || "",
            });
            editor.renderImageBatchGroups();
            editor.commit();
        } catch (err) {
            console.error("[MiniMax H3Director] batch audio upload failed:", err);
            alert(`参考音频上传失败：${err?.message || err}`);
        }
    });
}

function removeSegAudio(editor, index, slot) {
    const seg = editor.timeline.segments[index];
    if (!seg) return;
    seg.refAudios = (seg.refAudios || []).filter((r) => Number(r.index ?? r.slot) !== slot);
    editor.renderImageBatchGroups();
    editor.commit();
}

async function uploadSegVideo(editor, index, slot) {
    pickFile("video/*,.mp4,.mov,.webm,.mkv", async (file) => {
        try {
            const uploaded = await uploadMedia(file);
            const seg = editor.timeline.segments[index];
            if (!seg) return;
            const videoFile = relPath(uploaded);
            seg.refVideos = (seg.refVideos || []).filter((r) => Number(r.index ?? r.slot) !== slot);
            seg.refVideos.push({
                index: slot,
                videoFile,
                fileName: uploaded?.name || file.name,
                type: "input",
                subfolder: uploaded?.subfolder || "",
            });
            editor.renderImageBatchGroups();
            editor.commit();
        } catch (err) {
            console.error("[MiniMax H3Director] batch video upload failed:", err);
            alert(`参考视频上传失败：${err?.message || err}`);
        }
    });
}

function removeSegVideo(editor, index, slot) {
    const seg = editor.timeline.segments[index];
    if (!seg) return;
    seg.refVideos = (seg.refVideos || []).filter((r) => Number(r.index ?? r.slot) !== slot);
    editor.renderImageBatchGroups();
    editor.commit();
}

function renderAudioSlot(el, ref, slot, index, editor) {
    const label = refAudioLabel(slot);
    const file = ref?.audioFile || ref?.fileName || "";
    el.className = `h3d-batch-audio${file ? " has-audio" : ""}`;
    el.title = file ? `${label}: ${file}` : `${label} — 点击上传`;
    el.innerHTML = "";
    if (file) {
        const tag = document.createElement("span");
        tag.textContent = label;
        el.appendChild(tag);
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = file.split("/").pop() || file;
        el.appendChild(name);
        const x = document.createElement("span");
        x.className = "x";
        x.textContent = "×";
        x.onclick = (e) => { e.stopPropagation(); removeSegAudio(editor, index, slot); };
        el.appendChild(x);
    } else {
        el.textContent = `${label}\n上传`;
    }
}

function renderVideoSlot(el, ref, slot, index, editor) {
    const label = refVideoLabel(slot);
    const file = ref?.videoFile || ref?.fileName || "";
    el.className = `h3d-batch-video${file ? " has-video" : ""}`;
    el.title = file ? `${label}: ${file}` : `${label} — 点击上传参考视频`;
    el.innerHTML = "";
    if (file) {
        const tag = document.createElement("span");
        tag.textContent = label;
        el.appendChild(tag);
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = file.split("/").pop() || file;
        el.appendChild(name);
        const x = document.createElement("span");
        x.className = "x";
        x.textContent = "×";
        x.onclick = (e) => { e.stopPropagation(); removeSegVideo(editor, index, slot); };
        el.appendChild(x);
    } else {
        el.textContent = `${label}\n上传`;
    }
}

/** m2v 固定提示词（界面不展示；生成时由后端再加固 / 对齐官方标签）。 */
export const FIXED_M2V_PROMPT =
    "Motion transfer: use ONLY the motion, pose sequence, timing, and camera movement from <Video 1>. "
    + "REPLACE the person/identity, face, hair, and clothing in <Video 1> with the appearance from "
    + "character reference pictures (<Picture 1> and any other character pictures provided). "
    + "Use scene reference pictures for environment/background when provided. "
    + "Do NOT keep the original face or identity from <Video 1>. "
    + "If reference audio is provided, keep lip-sync / performance aligned. "
    + "动作迁移：只保留 <Video 1> 的动作与运镜；人物外观以参考图为准，禁止保留原视频人物身份。";

function appendM2vImageSlotRange(refsEl, seg, segIndex, editor, fromIdx, toIdx) {
    for (let slotIndex = fromIdx; slotIndex <= toIdx; slotIndex++) {
        const ref = (seg.refs || []).find((r) => Number(r.index ?? r.slot) === slotIndex);
        const slot = document.createElement("div");
        slot.className = "h3d-batch-ref";
        renderRefSlot(slot, ref, slotIndex, segIndex, editor, {});
        slot.onclick = () => {
            if (editor._batchRefDragMoved) {
                editor._batchRefDragMoved = false;
                return;
            }
            uploadSegRef(editor, segIndex, slotIndex);
        };
        bindBatchRefDrop(slot, editor, segIndex, slotIndex);
        refsEl.appendChild(slot);
    }
}

/** Build r2v top row: left=images, right=videos then audios. m2v: 人物/场景图 + 音频；动作视频在媒体轨。 */
function appendR2vMediaSections(card, seg, index, editor) {
    const isM2v = isMotionTransferTask(editor?.getTaskKey?.() || "");
    const imgs = document.createElement("div");
    imgs.className = isM2v ? "h3d-batch-r2v-imgs h3d-batch-m2v-imgs" : "h3d-batch-r2v-imgs";

    if (isM2v) {
        const tip = document.createElement("div");
        tip.className = "h3d-batch-hint";
        tip.style.cssText = "margin:0 0 6px;opacity:.9;font-size:11px";
        const globalScope = (editor.timeline?.editMode || "global") === "global";
        tip.textContent = globalScope
            ? "只需上传素材：媒体轨=动作视频；本卡=人物图/场景图/音频。"
            : "分镜：媒体轨均分/裁切选段；各卡上传人物图/场景图/音频。";
        imgs.appendChild(tip);

        const charBlock = document.createElement("div");
        charBlock.className = "h3d-batch-media-block";
        charBlock.innerHTML = `
            <div class="h3d-studio-row" style="justify-content:space-between;margin-bottom:2px">
                <span class="h3d-label">人物图 (图片1–4)</span>
                <button type="button" class="h3d-btn" data-a="batch-clear-char-refs" title="清空人物图">清空</button>
            </div>`;
        charBlock.querySelector('[data-a="batch-clear-char-refs"]').onclick = (e) => {
            e.stopPropagation();
            seg.refs = (seg.refs || []).filter((r) => Number(r.index ?? r.slot) > 3);
            editor.renderImageBatchGroups?.();
            editor.scheduleTimelineSync?.();
        };
        const charRefs = document.createElement("div");
        charRefs.className = "h3d-batch-refs";
        appendM2vImageSlotRange(charRefs, seg, index, editor, 0, 3);
        charBlock.appendChild(charRefs);
        imgs.appendChild(charBlock);

        const sceneBlock = document.createElement("div");
        sceneBlock.className = "h3d-batch-media-block";
        sceneBlock.style.marginTop = "8px";
        sceneBlock.innerHTML = `
            <div class="h3d-studio-row" style="justify-content:space-between;margin-bottom:2px">
                <span class="h3d-label">场景图 (图片5–9)</span>
                <button type="button" class="h3d-btn" data-a="batch-clear-scene-refs" title="清空场景图">清空</button>
            </div>`;
        sceneBlock.querySelector('[data-a="batch-clear-scene-refs"]').onclick = (e) => {
            e.stopPropagation();
            seg.refs = (seg.refs || []).filter((r) => Number(r.index ?? r.slot) < 4);
            editor.renderImageBatchGroups?.();
            editor.scheduleTimelineSync?.();
        };
        const sceneRefs = document.createElement("div");
        sceneRefs.className = "h3d-batch-refs";
        appendM2vImageSlotRange(sceneRefs, seg, index, editor, 4, 8);
        sceneBlock.appendChild(sceneRefs);
        imgs.appendChild(sceneBlock);
        card.appendChild(imgs);
    } else {
        const imgBlock = document.createElement("div");
        imgBlock.className = "h3d-batch-media-block";
        const chainOn = isChainContinuityOn(editor);
        const head = document.createElement("div");
        head.className = "h3d-studio-row";
        head.style.cssText = "justify-content:space-between;margin-bottom:2px";
        const labelText = chainOn
            ? "参考图（图片1=链式首帧，用户可传图片2–9）"
            : "参考图 (图片1–9)";
        head.innerHTML = `
            <span class="h3d-label">${labelText}</span>
            <button type="button" class="h3d-btn" data-a="batch-clear-seg-refs" title="清空本组全部参考图">清空图片</button>`;
        head.querySelector('[data-a="batch-clear-seg-refs"]').onclick = (e) => {
            e.stopPropagation();
            clearSegBatchRefs(editor, index, { images: true });
        };
        imgBlock.appendChild(head);
        const refs = document.createElement("div");
        refs.className = "h3d-batch-refs";
        appendUserRefImageSlots(refs, seg, index, editor);
        imgBlock.appendChild(refs);
        imgs.appendChild(imgBlock);
        card.appendChild(imgs);
    }

    const av = document.createElement("div");
    av.className = "h3d-batch-r2v-av";

    if (!isM2v) {
        const videoBlock = document.createElement("div");
        videoBlock.className = "h3d-batch-media-block";
        videoBlock.innerHTML = `<span class="h3d-label">参考视频 (视频1–3)</span>`;
        const videos = document.createElement("div");
        videos.className = "h3d-batch-videos";
        for (let i = 0; i < MAX_REFERENCE_VIDEOS; i++) {
            const ref = (seg.refVideos || []).find((r) => Number(r.index ?? r.slot) === i);
            const slot = document.createElement("div");
            renderVideoSlot(slot, ref, i, index, editor);
            slot.onclick = () => uploadSegVideo(editor, index, i);
            videos.appendChild(slot);
        }
        videoBlock.appendChild(videos);
        av.appendChild(videoBlock);
    }

    const audioBlock = document.createElement("div");
    audioBlock.className = "h3d-batch-media-block";
    audioBlock.innerHTML = `<span class="h3d-label">参考音频 (音频1–3)</span>`;
    const audios = document.createElement("div");
    audios.className = "h3d-batch-audios";
    for (let i = 0; i < MAX_REFERENCE_AUDIOS; i++) {
        const ref = (seg.refAudios || []).find((r) => Number(r.index ?? r.slot) === i);
        const slot = document.createElement("div");
        renderAudioSlot(slot, ref, i, index, editor);
        slot.onclick = () => uploadSegAudio(editor, index, i);
        audios.appendChild(slot);
    }
    audioBlock.appendChild(audios);
    av.appendChild(audioBlock);

    card.appendChild(av);
}

function renderSourceSlot(el, imageFile) {
    el.classList.toggle("has-img", !!imageFile);
    if (imageFile) {
        el.innerHTML = `<img src="${viewUrl(imageFile)}" alt="">`;
    } else {
        el.textContent = "上传源图";
    }
}

function refRoleBadge(ref, { isFirst = false, fromGlobal = false } = {}) {
    const role = String(ref?.role || "");
    const label = String(ref?.roleLabel || "").trim();
    if (isFirst || role === "first" || role === "still") {
        if (fromGlobal || label.startsWith("全局")) return label || "全局·静帧";
        return label || "静帧";
    }
    if (label) return label;
    const map = { character: "人物", scene: "场景", prop: "道具", style: "画风" };
    const base = map[role] || "";
    if (!base) return fromGlobal ? "全局" : "";
    return fromGlobal ? `全局·${base}` : base;
}

function roleTagClass(ref, fromGlobal) {
    const role = String(ref?.role || "");
    let cls = "role-tag";
    if (role === "character") cls += " char";
    else if (role === "scene") cls += " scene";
    else if (role === "prop") cls += " prop";
    else if (role === "still" || role === "first") cls += " still";
    if (fromGlobal) cls += " from-g";
    return cls;
}

function renderRefSlot(el, ref, slot, index, editor, opts = {}) {
    const label = refImageLabel(slot);
    const fromGlobal = !!(ref?.fromGlobal && ref?.imageFile);
    const isFirst = !!(opts.markFirstFrame && slot === 0);
    const hasImg = !!ref?.imageFile;
    const badge = refRoleBadge(ref, { isFirst, fromGlobal });
    el.classList.toggle("has-img", hasImg);
    el.classList.toggle("from-global", fromGlobal);
    el.classList.toggle("first-frame", isFirst && hasImg);
    el.innerHTML = "";
    if (badge) {
        el.title = `${label} · ${badge} — 点击可替换`;
    } else if (isFirst) {
        el.title = fromGlobal
            ? `${label} · 首帧（全局同步）— 点击可替换`
            : `${label} · 首帧 — 点击上传`;
    } else if (fromGlobal) {
        el.title = `${label} · 全局参考 — 点击可替换`;
    } else {
        el.title = `${label} — 点击上传`;
    }
    if (hasImg) {
        const img = document.createElement("img");
        img.src = viewUrl(ref.imageFile);
        img.draggable = false;
        el.appendChild(img);
        if (badge) {
            const tag = document.createElement("span");
            if (isFirst && !ref?.roleLabel && (ref?.role === "first" || !ref?.role)) {
                tag.className = "ff-tag";
            } else {
                tag.className = roleTagClass(ref, fromGlobal);
            }
            tag.textContent = badge;
            el.appendChild(tag);
        }
        const x = document.createElement("span");
        x.className = "x";
        x.textContent = "×";
        x.onclick = (e) => { e.stopPropagation(); removeSegRef(editor, index, slot); };
        el.appendChild(x);
    } else {
        el.textContent = isFirst ? `${label}\n首帧` : label;
    }
}

function frameSrc(b64) {
    if (!b64) return "";
    return b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
}

function loadFrameImages(frames) {
    return Promise.all(frames.map((b64) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = frameSrc(b64);
    })));
}

function drawFrame(canvas, img) {
    const ctx = canvas.getContext("2d");
    if (!ctx || !img) return;
    const cw = canvas.clientWidth || 160;
    const ch = canvas.clientHeight || 90;
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cw, ch);
    const scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.drawImage(img, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

function mountVideoPreview(el, seg, running, fps) {
    stopPlayer(el);
    el.innerHTML = "";
    if (running) {
        el.textContent = "生成中…";
        return;
    }
    const frames = (seg.previewFrames?.length ? seg.previewFrames : null)
        || (seg.previewB64 ? [seg.previewB64] : null);
    if (!frames?.length) {
        el.textContent = "运行后在此预览视频";
        return;
    }
    const wrap = document.createElement("div");
    wrap.className = "h3d-batch-vpreview";
    const canvas = document.createElement("canvas");
    canvas.height = 90;
    const ctrl = document.createElement("div");
    ctrl.className = "h3d-batch-vpreview-ctrl";
    const playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "h3d-btn";
    playBtn.textContent = "▶ 播放";
    const meta = document.createElement("div");
    meta.className = "h3d-batch-vpreview-meta";
    meta.textContent = `${frames.length}帧 · ${formatPreviewFps(fps)}fps(预览)`;
    ctrl.appendChild(playBtn);
    wrap.appendChild(canvas);
    wrap.appendChild(ctrl);
    wrap.appendChild(meta);
    el.appendChild(wrap);

    const state = { playing: false, timer: null, idx: 0, images: null };
    _players.set(wrap, state);

    loadFrameImages(frames).then((images) => {
        state.images = images;
        drawFrame(canvas, images[0]);
    }).catch(() => {
        meta.textContent = "预览加载失败";
    });

    playBtn.onclick = (e) => {
        e.stopPropagation();
        if (!state.images?.length) return;
        if (state.playing) {
            state.playing = false;
            if (state.timer) clearInterval(state.timer);
            state.timer = null;
            playBtn.textContent = "▶ 播放";
            return;
        }
        state.playing = true;
        playBtn.textContent = "⏸ 暂停";
        const interval = Math.max(20, 1000 / Math.max(1, fps));
        state.timer = setInterval(() => {
            if (!state.images?.length) return;
            state.idx = (state.idx + 1) % state.images.length;
            drawFrame(canvas, state.images[state.idx]);
        }, interval);
    };
}

function renderImagePreview(el, seg, running) {
    stopPlayer(el);
    el.innerHTML = "";
    if (running) {
        el.textContent = "生成中…";
        return;
    }
    if (seg.previewB64) {
        const img = document.createElement("img");
        img.src = frameSrc(seg.previewB64);
        img.alt = "preview";
        el.appendChild(img);
        return;
    }
    el.textContent = "运行后在此预览";
}

function renderPreview(el, seg, running, isVideo, fps) {
    if (isVideo) mountVideoPreview(el, seg, running, fps);
    else renderImagePreview(el, seg, running);
}

export function renderImageBatchGroups(editor) {
    const list = editor.batchList;
    if (!list) return;
    stopAllPlayers(list);
    const key = resolveTaskKey(editor.getTaskKey?.() || editor.taskTypeWidget?.value);
    const variant = imageBatchVariant(key);
    const isVideo = isVideoBatchTask(key);
    const runningIdx = editor._runHighlightSeg;
    const fps = parseFloat(editor.frameRateWidget?.value || editor.timeline?.frameRate || 24);
    const chainOn = isChainContinuityOn(editor);
    // Heal saved timelines that still keep user images in slot 0 while continuity is on.
    if (chainOn && (key === "i2v" || isR2vLikeTask(key))) {
        const hasSlot0 = (editor.timeline?.segments || []).some((s) =>
            (s.refs || []).some((r) => Number(r.index ?? r.slot) === 0)
        ) || (editor.timeline?.global?.refs || []).some((r) => Number(r.index ?? r.slot) === 0);
        if (hasSlot0) migrateRefsForChainContinuity(editor, true);
    }

    if (editor.batchHint) {
        const hints = {
            t2i: "文生图 · 开启「选择运行」可只跑勾选的组",
            t2v: chainOn
                ? "文生视频 · 链式连贯开：第1组纯文生；第2组起用上镜末帧作首帧硬锁定"
                : "文生视频 · 每组纯文生；可开「链式连贯」让后续镜承接上镜末帧",
            i2v: chainOn
                ? "图生视频 · 链式连贯开：图片1=上镜末帧；用户参考图为图片2–9；第1组可不传首帧"
                : "图生视频 · 图片1–9 纯参考（不锁首帧）；可开「链式连贯」；锁首尾请用「首尾帧」",
            i2i: "图生图 · 图片1=源图（计入 9 张），可同步全局参考",
            r2v: chainOn
                ? "参考主体 · 链式连贯开：图片1=上镜末帧；用户参考图剩 8 槽（图片2–9）"
                : "参考主体生视频 · 图片/音频/视频纯参考；可开「链式连贯」",
            m2v: (editor.timeline?.editMode || "global") === "global"
                ? "动作迁移：短视频可整局；超过约 5s 会自动分镜。人物图要清晰正脸/全身，场景图可选。"
                : "动作迁移分镜：每段约 5s 效果更稳；各卡确认人物图后 Queue（勿只跑第 1 段）。",
        };
        editor.batchHint.textContent = hints[key] || (isVideo ? "每组生成一段视频" : "每组生成 1 张图片");
    }
    if (editor.batchI2vNotice) {
        const needsRefs = key === "r2i" || isR2vLikeTask(key) || key === "i2v";
        const needsSource = key === "i2i";
        const hasAnyMedia = (editor.timeline.segments || []).some((s) => (
            (s.refs || []).length > 0
            || (s.refAudios || []).length > 0
            || (s.refVideos || []).length > 0
            || !!(s.genImage?.imageFile || s.imageFile)
        ));
        const hasGlobal = ((editor.timeline.global?.refs) || []).some((r) => r?.imageFile);
        const hasTrackVideo = !!(editor.hasVideo?.()
            || editor.timeline?.video?.videoFile
            || editor.timeline?.video?.fileName
            || (editor.timeline?.videoClips || []).length);
        const hasAnyImage = (editor.timeline.segments || []).some((s) => (s.refs || []).some((r) => r?.imageFile)) || hasGlobal;
        if (isMotionTransferTask(key) && (!hasTrackVideo || !hasAnyImage)) {
            editor.batchI2vNotice.textContent =
                "动作迁移：①「动作视频」上传 1 路 → ② 人物图（建议多张清晰正脸/全身）→ ③ Queue。"
                + "长视频会自动按约 5s 分镜，避免后半段漂回原片。";
            editor.batchI2vNotice.classList.add("visible");
        } else if (needsRefs && !hasAnyMedia && !hasGlobal && !isMotionTransferTask(key)) {
            editor.batchI2vNotice.textContent = isR2vLikeTask(key)
                ? "当前没有参考素材：请在素材组中上传图片 / 音频 / 视频。未上传时生成会退化成文生视频（t2v）。"
                : key === "i2v"
                    ? "当前没有参考图：请上传图片1–9（纯参考，不锁首帧）。未上传时生成会退化成文生视频（t2v）。需要锁首尾帧请用「首尾帧」模式。"
                    : "当前没有参考图：请在提示词组卡片中上传图片1–9。未上传时生成会退化成文生图（t2i）。";
            editor.batchI2vNotice.classList.add("visible");
        } else if (needsSource && !hasAnyMedia && !hasGlobal) {
            editor.batchI2vNotice.textContent =
                "图生图：在图片1上传源图（计入 9 张），或上方全局同步。无图时该组会报缺源图。";
            editor.batchI2vNotice.classList.add("visible");
        } else {
            editor.batchI2vNotice.classList.remove("visible");
            editor.batchI2vNotice.textContent = "";
        }
    }
    renderGlobalRefsStrip(editor);
    const titleEl = editor.batchPanel?.querySelector('[data-r="batch-title"]');
    if (titleEl) {
        titleEl.innerHTML = isMotionTransferTask(key)
            ? "<b>动作迁移素材</b><span>人物图 · 场景图 · 音频</span>"
            : isR2vLikeTask(key)
                ? "<b>素材组清单</b><span>参考图 / 音视频 · 纵向卡片</span>"
                : "<b>提示词组清单</b><span>纵向卡片</span>";
    }
    const addBtn = editor.batchPanel?.querySelector('[data-a="batch-add"]');
    if (addBtn) {
        // m2v 分镜用媒体轨「均分」建组，不在此添加空素材组
        if (isMotionTransferTask(key)) {
            addBtn.classList.add("hidden");
            addBtn.disabled = true;
        } else {
            addBtn.textContent = isR2vLikeTask(key) ? "添加素材组" : "+ 添加提示词组";
            addBtn.classList.remove("hidden");
            addBtn.disabled = false;
        }
    }
    const delBtn = editor.batchPanel?.querySelector('[data-a="batch-del-selected"]');
    if (delBtn) {
        // r2v：删除放清单内；m2v 用媒体轨「删除分段」
        const showBatchDel = isR2vLikeTask(key) && !isMotionTransferTask(key);
        delBtn.classList.toggle("hidden", !showBatchDel);
        delBtn.disabled = showBatchDel && (editor.timeline?.segments?.length || 0) <= 1;
    }

    list.innerHTML = "";
    const globalScope = (editor.timeline?.editMode || "global") === "global";
    const segs = editor.timeline.segments || [];
    const renderIdxs = globalScope
        ? (segs.length ? [0] : [])
        : segs.map((_, i) => i);
    // 整局：清单内只编辑第 1 组，隐藏多组添加/删除
    const addBtnScope = editor.batchPanel?.querySelector('[data-a="batch-add"]');
    const delBtnScope = editor.batchPanel?.querySelector('[data-a="batch-del-selected"]');
    if (globalScope) {
        if (addBtnScope) addBtnScope.classList.add("hidden");
        if (delBtnScope) delBtnScope.classList.add("hidden");
        editor.selectedIndex = 0;
    }
    renderIdxs.forEach((index) => {
        const seg = segs[index];
        if (!seg) return;
        const isR2v = isR2vLikeTask(key);
        const card = document.createElement("div");
        card.className = `h3d-batch-card${isR2v ? " h3d-batch-r2v" : ""}${globalScope ? " h3d-batch-card-single" : ""}`;
        const runSelectOn = !globalScope && !!(editor.isRunSelectEnabled?.() && editor.supportsRunSelect?.());
        const runEnabled = !runSelectOn || !!editor.isSegmentRunEnabled?.(index);
        if (index === editor.selectedIndex || globalScope) card.classList.add("selected");
        if (index === runningIdx) card.classList.add("running");
        if (runSelectOn && runEnabled) card.classList.add("run-on");
        if (runSelectOn && !runEnabled) card.classList.add("run-skipped");
        if (isR2v && !globalScope) {
            card.onclick = (e) => {
                if (e.target.closest?.("button, input, textarea, select, .h3d-batch-ref, .h3d-batch-audio, .h3d-batch-video, .h3d-batch-src, .x")) {
                    return;
                }
                if (editor.selectedIndex === index) return;
                editor.selectedIndex = index;
                list.querySelectorAll(".h3d-batch-card").forEach((el, i) => {
                    el.classList.toggle("selected", i === index);
                });
                editor.scheduleRender?.();
                editor.updateVideoNameLabel?.();
            };
        }
        const hasPreview = isVideo
            ? (seg.previewFrames?.length > 0 || seg.previewB64)
            : !!seg.previewB64;
        if (hasPreview && index !== runningIdx) card.classList.add("done");

        const head = document.createElement("div");
        head.className = "h3d-batch-head";
        // Timeline + cards stay in sync for run-select (incl. r2v).
        if (runSelectOn) {
            const runCb = document.createElement("input");
            runCb.type = "checkbox";
            runCb.className = "h3d-batch-run-check";
            runCb.checked = runEnabled;
            runCb.title = "勾选后参与本次运行（与时间轴同步）";
            runCb.onclick = (e) => {
                e.stopPropagation();
                editor.toggleSegmentRun(index);
            };
            head.appendChild(runCb);
        }
        const title = document.createElement("b");
        if (isMotionTransferTask(key)) {
            title.textContent = globalScope ? "整局素材" : `分镜素材 ${index + 1}`;
        } else {
            title.textContent = globalScope
                ? (isR2v ? "整局素材" : "整局提示词")
                : (isR2v ? `素材组 ${index + 1}` : `提示词组 ${index + 1}`);
        }
        head.appendChild(title);
        const meta = document.createElement("div");
        meta.className = "h3d-batch-head-meta";
        if (isVideo) {
            // 动作迁移整局：不显示秒数，生成时长跟媒体轨视频
            if (isMotionTransferTask(key) && globalScope) {
                if (typeof editor._syncM2vDurationsFromTrack === "function") {
                    editor._syncM2vDurationsFromTrack({ preserveManual: false });
                } else {
                    const curSec = resolveSegmentDurationSec(seg, defaultFrameCount(key));
                    seg.durationSec = curSec;
                    seg.frameCount = durationToMiniMaxFrames(curSec, 24);
                }
            } else {
                const secRow = document.createElement("label");
                secRow.className = "h3d-batch-fc";
                const curSec = resolveSegmentDurationSec(seg, defaultFrameCount(key));
                const frames = durationToMiniMaxFrames(curSec, 24);
                seg.durationSec = curSec;
                seg.frameCount = frames;
                if (!isMotionTransferTask(key)) seg.length = frames;
                const secTitle = isMotionTransferTask(key)
                    ? `生成秒数（默认同媒体轨分段；可手调）→ ${frames} 帧`
                    : `用户填写秒数；帧数按 H3 公式换算 → ${frames} 帧`;
                secRow.innerHTML = `秒数 <input type="number" min="${minDurationSec()}" max="${maxDurationSec()}" step="0.1" value="${seg.durationSec}" title="${secTitle}">`;
                const secInput = secRow.querySelector("input");
                const applySec = () => {
                    const sec = clamp(
                        parseFloat(secInput.value) || defaultDurationSec(key),
                        minDurationSec(),
                        maxDurationSec(),
                    );
                    const rounded = Math.round(sec * 100) / 100;
                    const fc = durationToMiniMaxFrames(rounded, 24);
                    // Keep the user's seconds as-is; do NOT rewrite to frames/fps.
                    secInput.value = String(rounded);
                    secInput.title = `用户填写秒数；帧数按 H3 公式换算 → ${fc} 帧`;
                    seg.durationSec = rounded;
                    seg.frameCount = fc;
                    // m2v：手调秒数只改生成帧数，不改媒体轨动作源 length
                    if (!isMotionTransferTask(key)) seg.length = fc;
                    normalizeImageBatchSegments(editor);
                    editor.scheduleTimelineSync();
                    editor.scheduleRender?.();
                    editor.updateVideoNameLabel?.();
                    editor.updateOutputPreview?.();
                };
                secInput.onchange = applySec;
                secInput.oninput = () => {
                    clearTimeout(secInput._t);
                    secInput._t = setTimeout(applySec, 280);
                };
                meta.appendChild(secRow);
            }
        }
        if (!globalScope) {
            const del = document.createElement("button");
            del.type = "button";
            del.className = "h3d-batch-del";
            del.textContent = "删除";
            del.disabled = editor.timeline.segments.length <= 1;
            del.onclick = (e) => { e.stopPropagation(); deleteImageBatchGroup(editor, index); };
            meta.appendChild(del);
        }
        head.appendChild(meta);
        card.appendChild(head);

        if (variant === "source") {
            appendSourceAndOptionalRefs(card, seg, index, editor);
        } else if (variant === "refs" && isR2v) {
            appendR2vMediaSections(card, seg, index, editor);
        } else if (variant === "refs") {
            const media = document.createElement("div");
            media.className = "h3d-batch-media";
            const chainOn = isChainContinuityOn(editor);
            const head = document.createElement("div");
            head.className = "h3d-studio-row";
            head.style.cssText = "justify-content:space-between;margin-bottom:2px";
            const labelText = chainOn
                ? "参考图（图片1=链式首帧，用户可传图片2–9；第1组可不传首帧）"
                : "参考图 (图片1–9)";
            head.innerHTML = `
                <span class="h3d-label">${labelText}</span>
                <button type="button" class="h3d-btn" data-a="batch-clear-seg-refs" title="清空本组全部参考图">清空图片</button>`;
            head.querySelector('[data-a="batch-clear-seg-refs"]').onclick = (e) => {
                e.stopPropagation();
                clearSegBatchRefs(editor, index, { images: true });
            };
            media.appendChild(head);
            const refs = document.createElement("div");
            refs.className = "h3d-batch-refs";
            appendUserRefImageSlots(refs, seg, index, editor);
            media.appendChild(refs);
            card.appendChild(media);
        }

        // m2v：不展示提示词，写入固定模板
        if (isMotionTransferTask(key)) {
            seg.prompt = FIXED_M2V_PROMPT;
            seg.negativePrompt = "";
        } else {
            const prompts = document.createElement("div");
            prompts.className = "h3d-batch-prompts";
            const ph = isR2v
                ? "描述画面与运动；可用 <Picture N> / <Video K> / <Audio J>，或输入 @ 引用已上传素材"
                : "描述要生成的内容（含画面、运镜、音频；MiniMax H3 无反向提示词）";
            prompts.innerHTML = `
                <span class="h3d-label">提示词</span>
                <textarea data-f="prompt" placeholder="${ph}">${seg.prompt || ""}</textarea>`;
            const promptEl = prompts.querySelector('[data-f="prompt"]');
            promptEl.oninput = (e) => {
                seg.prompt = e.target.value;
                seg.negativePrompt = "";
                editor.scheduleTimelineSync();
            };
            if (isR2v) {
                wirePromptImageMentions(editor, promptEl, () => ({
                    refs: seg.refs || [],
                    audios: seg.refAudios || [],
                    videos: seg.refVideos || [],
                }));
            }
            card.appendChild(prompts);
        }

        const preview = document.createElement("div");
        preview.className = "h3d-batch-preview";
        renderPreview(preview, seg, index === runningIdx, isVideo, seg.previewFps || fps);

        card.appendChild(preview);

        list.appendChild(card);
    });
}

export function setImageBatchPreview(editor, segmentIndex, imageB64, extra = {}) {
    const seg = editor.timeline.segments[segmentIndex];
    if (!seg) return;
    seg.previewB64 = imageB64 || "";
    if (Array.isArray(extra.frames) && extra.frames.length) {
        seg.previewFrames = extra.frames;
        seg.previewFps = extra.fps || seg.previewFps || 24;
    } else if (imageB64) {
        seg.previewFrames = [imageB64];
    }
    editor.renderImageBatchGroups();
}

export function bindImageBatchEvents(editor) {
    editor.batchAddBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        addImageBatchGroup(editor);
    });
    editor.batchPanel?.querySelector('[data-a="batch-del-selected"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = Number.isFinite(editor.selectedIndex) ? editor.selectedIndex : 0;
        deleteImageBatchGroup(editor, idx);
    });
    editor.batchPanel?.querySelector('[data-a="batch-push-global-refs"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        const moved = migrateGlobalRefsIntoBatchSegments(editor);
        const key = resolveTaskKey(editor.getTaskKey?.() || "");
        if (key === "i2i") {
            for (const seg of editor.timeline.segments || []) {
                syncSegFirstFrameFromRefs(seg);
            }
        }
        editor.renderImageBatchGroups();
        editor.commit();
        if (moved) {
            console.info("[MiniMax H3Director] synced global refs into batch groups");
        }
    });
    editor.batchPanel?.querySelector('[data-a="batch-clear-global-refs"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        clearAllGlobalBatchRefs(editor);
    });
}

export function getImageBatchUiHeight(editor) {
    const n = Math.max(1, editor?.timeline?.segments?.length || 1);
    const key = resolveTaskKey(editor?.getTaskKey?.() || editor?.taskTypeWidget?.value);
    // r2v/m2v: 2-row ref grid + side-by-side bottom row.
    const rowH = isR2vLikeTask(key) ? 240 : (key === "i2v" || key === "i2i" ? 200 : (isVideoBatchTask(key) ? 155 : 130));
    return 240 + Math.min(n, 4) * rowH + 60;
}

export function setToolbarDisabledForBatch(editor, disabled) {
    const btns = [
        editor.btnVideo,
        editor.btnVideoAppend,
        editor.root?.querySelector('[data-a="split"]'),
        editor.root?.querySelector('[data-a="smart-split"]'),
        editor.root?.querySelector('[data-a="equal"]'),
        editor.root?.querySelector('[data-a="del"]'),
    ];
    for (const btn of btns) {
        if (!btn) continue;
        // Batch / t2v / i2v: fully hide video-editing controls (not just disable).
        btn.classList.toggle("hidden", disabled);
        btn.disabled = disabled;
        btn.classList.toggle("h3d-disabled", disabled);
    }
    if (editor.equalCountInput) {
        editor.equalCountInput.classList.toggle("hidden", disabled);
        editor.equalCountInput.disabled = disabled;
        editor.equalCountInput.classList.toggle("h3d-disabled", disabled);
    }
    editor.root?.querySelector('[data-r="equal-n"]')?.classList.toggle("hidden", disabled);
    // Keep 整局/分镜 switch visible for batch / t2v / i2v.
}

/** r2v: hide outer material/edit shells; add/delete live inside 素材组清单. */
export function setR2vToolbar(editor, enabled) {
    const hide = [
        editor.btnVideo,
        editor.btnVideoAppend,
        editor.root?.querySelector('[data-a="split"]'),
        editor.root?.querySelector('[data-a="smart-split"]'),
        editor.root?.querySelector('[data-a="equal"]'),
        // Keep 整局/分镜 switch available (single group vs multi group).
    ];
    for (const btn of hide) {
        if (!btn) continue;
        btn.classList.toggle("hidden", enabled);
        btn.disabled = enabled;
        btn.classList.toggle("h3d-disabled", enabled);
    }
    if (editor.equalCountInput) {
        editor.equalCountInput.classList.toggle("hidden", enabled);
        editor.equalCountInput.disabled = enabled;
        editor.equalCountInput.classList.toggle("h3d-disabled", enabled);
    }
    editor.root?.querySelector('[data-r="equal-n"]')?.classList.toggle("hidden", enabled);
    // Do not hide .h3d-mode — 整局/分镜 must stay switchable.

    // Outer del / add stay hidden in r2v — controls moved into batch panel.
    const outerDel = editor.root?.querySelector('.h3d-toolbar-wrap [data-a="del"]')
        || editor.root?.querySelector('[data-a="del"]');
    if (outerDel) {
        if (enabled) {
            outerDel.classList.add("hidden", "h3d-disabled");
            outerDel.disabled = true;
        } else {
            outerDel.classList.remove("hidden", "h3d-disabled");
            outerDel.disabled = false;
            outerDel.textContent = "删除片段";
            outerDel.title = "删除选中片段并裁剪视频，时间轴自动衔接";
        }
    }
    const outerAdd = editor.root?.querySelector('.h3d-toolbar-wrap [data-a="r2v-add-group"]')
        || editor.root?.querySelector('[data-a="r2v-add-group"]');
    if (outerAdd) {
        outerAdd.classList.add("hidden");
        outerAdd.disabled = true;
    }
    const batchAdd = editor.batchPanel?.querySelector('[data-a="batch-add"]');
    if (batchAdd) {
        batchAdd.classList.toggle("hidden", false);
        batchAdd.textContent = enabled ? "添加素材组" : "+ 添加提示词组";
    }
    const batchDel = editor.batchPanel?.querySelector('[data-a="batch-del-selected"]');
    if (batchDel) batchDel.classList.toggle("hidden", !enabled);
    updateR2vToolbarBtns(editor);
}

function _toolGroupHasVisibleControls(group) {
    if (!group) return false;
    return !!group.querySelector("button:not(.hidden), input:not(.hidden), select:not(.hidden), label:not(.hidden)");
}

export function updateR2vToolbarBtns(editor) {
    const showR2v = !!editor?.isR2vBatch?.();
    const showM2v = !!editor?.isM2vBatch?.();
    const outerAdd = editor?.root?.querySelector?.('.h3d-toolbar-wrap [data-a="r2v-add-group"]')
        || editor?.root?.querySelector?.('[data-a="r2v-add-group"]');
    if (outerAdd) {
        outerAdd.classList.add("hidden");
        outerAdd.disabled = true;
    }
    const batchAdd = editor?.batchPanel?.querySelector?.('[data-a="batch-add"]');
    if (batchAdd && showR2v && !showM2v) {
        batchAdd.classList.remove("hidden");
        batchAdd.textContent = "添加素材组";
        batchAdd.disabled = false;
    }
    if (batchAdd && showM2v) {
        batchAdd.classList.add("hidden");
        batchAdd.disabled = true;
    }
    const batchDel = editor?.batchPanel?.querySelector?.('[data-a="batch-del-selected"]');
    if (batchDel) {
        batchDel.classList.toggle("hidden", !showR2v || showM2v);
        if (showR2v && !showM2v) {
            batchDel.disabled = (editor.timeline?.segments?.length || 0) <= 1;
        }
    }
    const toolbar = editor?.root?.querySelector?.(".h3d-toolbar-wrap");
    if (toolbar) {
        for (const group of toolbar.querySelectorAll(".h3d-tool-group")) {
            const label = group.querySelector(".h3d-tool-label")?.textContent?.trim() || "";
            if (label !== "素材" && label !== "剪辑") continue;
            // r2v 隐藏外层素材/剪辑；m2v 保留媒体轨剪辑
            group.classList.toggle("hidden", (showR2v && !showM2v) || (!_toolGroupHasVisibleControls(group) && !showM2v));
        }
    }
}
