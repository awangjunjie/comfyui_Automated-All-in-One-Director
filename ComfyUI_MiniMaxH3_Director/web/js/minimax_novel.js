/** Novel chapter mode UI: import → assets → storyboard → prepare → Queue. */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
    resolveTaskKey,
    isNovelLikeTask,
    confirmHighShotOrDuration,
    assertRefMediaDuration,
    SHOT_COUNT_WARN_THRESHOLD,
    DURATION_SEC_WARN_THRESHOLD,
    REF_MEDIA_DURATION_MIN_SEC,
    REF_MEDIA_DURATION_MAX_SEC,
} from "./minimax_gen_timeline.js";
import {
    coerceIndexedRefs,
    ensureImageBatchTimeline,
    normalizeImageBatchSegments,
    renderImageBatchGroups,
} from "./minimax_image_batch.js";
import { clearGlobalCreativeCache } from "./minimax_studio_desk.js";

export { isNovelTask, isFilmTask, isNovelLikeTask } from "./minimax_gen_timeline.js";

const STATUS_LABEL = {
    pending: "待处理",
    storyboarded: "已分镜",
    refs_ready: "参考已挂",
    generating: "生成中",
    done: "已完成",
    failed: "失败",
};

const NOVEL_STYLES = `
.h3d-novel{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(0,0,0,.22);margin-bottom:10px}
.h3d-novel[hidden]{display:none!important}
.h3d-novel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.h3d-novel-head b{font-size:13px;letter-spacing:.02em}
.h3d-novel-head span{opacity:.7;font-size:11px}
.h3d-novel-head [data-a="novel-clear-global-cache"]{margin-left:auto;flex-shrink:0}
.h3d-novel-hint{font-size:11px;opacity:.72;line-height:1.45;margin:0}
.h3d-novel-steps{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.h3d-novel-step{font-size:11px;padding:4px 8px;border-radius:6px;background:rgba(255,255,255,.05);opacity:.55;border:1px solid transparent}
.h3d-novel-step.done{opacity:.9;background:rgba(80,180,120,.18);border-color:rgba(80,180,120,.35)}
.h3d-novel-step.active{opacity:1;background:rgba(120,180,220,.2);border-color:rgba(120,180,220,.5);font-weight:600}
.h3d-novel-block{display:flex;flex-direction:column;gap:8px;padding:8px;border-radius:8px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
.h3d-novel-block h4{margin:0;font-size:12px;opacity:.9}
.h3d-novel-block .h3d-novel-block-sub{font-size:10px;opacity:.55;margin:0}
.h3d-novel-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.h3d-novel textarea{width:100%;min-height:72px;resize:vertical;background:#141018;color:#eee;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px;font:12px/1.45 ui-sans-serif,system-ui}
.h3d-novel select,.h3d-novel input[type="text"]{background:#141018;color:#eee;border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:4px 8px;font-size:12px}
.h3d-novel-chapters{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow:auto}
.h3d-novel-history{display:flex;flex-direction:column;gap:3px;max-height:110px;overflow:auto;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06)}
.h3d-novel-history-item{font-size:10px;opacity:.72;line-height:1.35;display:grid;grid-template-columns:auto 1fr;gap:6px}
.h3d-novel-history-item b{font-weight:600;opacity:.9;white-space:nowrap}
.h3d-novel-ch{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:6px 8px;border-radius:6px;cursor:pointer;background:rgba(255,255,255,.03)}
.h3d-novel-ch:hover{background:rgba(255,255,255,.07)}
.h3d-novel-ch.active{outline:1px solid rgba(120,220,160,.55);background:rgba(60,120,90,.18)}
.h3d-novel-badge{font-size:10px;padding:2px 6px;border-radius:999px;background:rgba(255,255,255,.1)}
.h3d-novel-badge.done{background:rgba(80,180,120,.35)}
.h3d-novel-badge.generating{background:rgba(200,160,60,.35)}
.h3d-novel-badge.failed{background:rgba(200,80,80,.35)}
.h3d-novel-assets{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.h3d-novel[data-product="film"] .h3d-novel-assets-film{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
.h3d-novel-assets-film{display:none}
.h3d-novel[data-product="film"] .h3d-novel-assets-film{display:grid}
.h3d-novel-asset.media .h3d-novel-asset-badge{font-size:10px;opacity:.75}
.h3d-novel-film-script{font-size:11px;opacity:.8;padding:6px 8px;border-radius:6px;background:rgba(200,170,90,.1);border:1px solid rgba(200,170,90,.25)}
.h3d-novel[data-product="novel"] .h3d-novel-film-script{display:none!important}

.h3d-novel-asset-col{display:flex;flex-direction:column;gap:6px;min-height:60px}
.h3d-novel-asset-col h4{margin:0;font-size:11px;opacity:.8}
.h3d-novel-asset{display:flex;gap:6px;align-items:center;font-size:11px}
.h3d-novel-asset img{width:36px;height:36px;object-fit:cover;border-radius:4px;background:#000}
.h3d-novel-asset-meta{flex:1;min-width:0}
.h3d-novel-asset-del{flex:none;font-size:11px;padding:2px 6px;line-height:1.2;opacity:.85}
.h3d-novel-asset-del:hover{opacity:1;color:#f0a0a0}
.h3d-novel-msg{font-size:11px;opacity:.8;min-height:1.2em;white-space:pre-wrap}
.h3d-novel-actions .h3d-btn{font-size:12px}
.h3d-novel-batch{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px;border-radius:8px;background:rgba(120,180,220,.08);border:1px solid rgba(120,180,220,.25)}
.h3d-novel-batch label{font-size:11px;opacity:.9;display:inline-flex;align-items:center;gap:4px;user-select:none}
.h3d-novel-batch .h3d-btn[disabled]{opacity:.45;pointer-events:none}
.h3d-novel[data-product="film"]{border-color:rgba(200,170,90,.35);background:linear-gradient(180deg,rgba(40,32,18,.45),rgba(0,0,0,.22))}
.h3d-novel[data-product="novel"]{border-color:rgba(120,180,220,.22)}
.h3d-novel[data-product="film"] .h3d-novel-head b{color:#e8d5a0}
.h3d-novel[data-product="novel"] .h3d-novel-head b{color:#c5daf0}
.h3d-novel-film-flow{display:none;flex-direction:column;gap:8px;padding:10px;border-radius:8px;background:rgba(200,170,90,.08);border:1px solid rgba(200,170,90,.28)}
.h3d-novel[data-product="film"] .h3d-novel-film-flow{display:flex}
.h3d-novel[data-product="film"] .h3d-novel-drama-flow{display:none!important}
.h3d-novel[data-product="novel"] .h3d-novel-film-flow{display:none!important}
.h3d-novel-film-flow h4{margin:0;font-size:12px;color:#e8d5a0}
.h3d-novel-film-flow .h3d-novel-block-sub{margin:0}
.h3d-novel-film-progress{font-size:12px;padding:6px 8px;border-radius:6px;background:rgba(0,0,0,.28);border:1px solid rgba(200,170,90,.2)}
.h3d-novel-only,.h3d-film-only{display:contents}
.h3d-novel[data-product="film"] .h3d-novel-only{display:none!important}
.h3d-novel[data-product="novel"] .h3d-film-only{display:none!important}
`;

function ensureNovelStyles() {
    if (document.getElementById("h3d-novel-styles")) return;
    const style = document.createElement("style");
    style.id = "h3d-novel-styles";
    style.textContent = NOVEL_STYLES;
    document.head.appendChild(style);
}

function productTaskKey(editor) {
    const key = resolveTaskKey(editor?.getTaskKey?.() || editor?.taskTypeWidget?.value || "");
    return key === "film" ? "film" : "novel";
}

function resolveNovelProduct(novel) {
    const raw = String(novel?.productTask || novel?.importMeta?.productTask || "").trim();
    if (raw.startsWith("film") || raw.includes("film")) return "film";
    if (String(novel?.settings?.narrativeMode || "").toLowerCase() === "film") return "film";
    if (String(novel?.projectId || "").startsWith("film_")) return "film";
    return "novel";
}

/** Keep novel/film project+assets in separate slots on the same timeline. */
function stashActiveNovel(timeline, productKey) {
    if (!timeline || typeof timeline !== "object") return;
    const bucket = timeline.novelByProduct || (timeline.novelByProduct = { novel: null, film: null });
    const key = productKey === "film" ? "film" : "novel";
    if (timeline.novel && typeof timeline.novel === "object") {
        bucket[key] = slimNovelForTimeline(timeline.novel);
    }
}

function restoreProductNovel(timeline, productKey) {
    if (!timeline || typeof timeline !== "object") return defaultNovelState();
    const bucket = timeline.novelByProduct || (timeline.novelByProduct = { novel: null, film: null });
    const key = productKey === "film" ? "film" : "novel";
    const saved = bucket[key];
    if (saved && typeof saved === "object" && (saved.projectId || (saved.assets && (
        (saved.assets.characters || []).length
        || (saved.assets.scenes || []).length
        || (saved.assets.audios || []).length
        || (saved.assets.videos || []).length
    )))) {
        timeline.novel = slimNovelForTimeline(saved);
    } else {
        const empty = defaultNovelState();
        empty.productTask = key;
        empty.settings = {
            ...empty.settings,
            ...(key === "film"
                ? {
                    narrativeMode: "film",
                    shotMin: 4,
                    shotMax: 12,
                    maxShotsPerChapter: 120,
                    durationMin: 4,
                    durationMax: 30,
                    defaultDurationSec: 8,
                    genBatchSize: 4,
                    segmentMaxMinutes: 5,
                }
                : {
                    narrativeMode: "short_drama",
                    shotMin: 2,
                    shotMax: 8,
                    maxShotsPerChapter: 8,
                    durationMin: 2,
                    durationMax: 12,
                    defaultDurationSec: 5,
                    genBatchSize: 8,
                    segmentMaxMinutes: 5,
                }),
        };
        timeline.novel = empty;
        bucket[key] = slimNovelForTimeline(empty);
    }
    timeline.novel.productTask = key;
    if (!timeline.novel.importMeta || typeof timeline.novel.importMeta !== "object") {
        timeline.novel.importMeta = {};
    }
    timeline.novel.importMeta.productTask = key;
    return timeline.novel;
}

function applyProductPresets(editor, productKey, { force = false } = {}) {
    ensureNovelTimeline(editor.timeline);
    const prev = editor._lastNovelProductKey;
    if (!force && prev === productKey) return;

    if (prev && prev !== productKey) {
        stashActiveNovel(editor.timeline, prev);
        restoreProductNovel(editor.timeline, productKey);
    } else if (!prev) {
        const novel = editor.timeline?.novel;
        const owned = resolveNovelProduct(novel);
        if (novel?.projectId) {
            stashActiveNovel(editor.timeline, owned);
            if (owned !== productKey) {
                // 当前工作流里挂着另一产品的项目：切到空槽，避免资产串台
                restoreProductNovel(editor.timeline, productKey);
            } else {
                const bucket = editor.timeline.novelByProduct || (editor.timeline.novelByProduct = {});
                bucket[productKey] = slimNovelForTimeline(novel);
            }
        } else {
            restoreProductNovel(editor.timeline, productKey);
        }
    }

    const novel = ensureNovelTimeline(editor.timeline);
    const want = productKey === "film" ? "film" : "short_drama";
    const presets = want === "film"
        ? {
            narrativeMode: "film",
            shotMin: 4,
            shotMax: 12,
            maxShotsPerChapter: 120,
            durationMin: 4,
            durationMax: 30,
            defaultDurationSec: 8,
            genBatchSize: 4,
            segmentMaxMinutes: 5,
        }
        : {
            narrativeMode: "short_drama",
            shotMin: 2,
            shotMax: 8,
            maxShotsPerChapter: 8,
            durationMin: 2,
            durationMax: 12,
            defaultDurationSec: 5,
            genBatchSize: 8,
            segmentMaxMinutes: 5,
        };
    novel.settings = { ...(novel.settings || {}), ...presets };
    novel.productTask = productKey;
    if (!novel.importMeta || typeof novel.importMeta !== "object") novel.importMeta = {};
    novel.importMeta.productTask = productKey;

    const skillId = want === "film" ? "novel-film" : "novel-short-drama";
    const desk = editor.timeline.desk || (editor.timeline.desk = {});
    const td = desk.text_director || (desk.text_director = {});
    td.skill_id = skillId;
    const skillEl = editor.studioDesk?.querySelector?.('[data-r="ld-skill"]');
    if (skillEl) skillEl.value = skillId;
    const w = editor.node?.widgets?.find((x) => x.name === "local_director_skill");
    if (w) {
        w.value = skillId;
        w.callback?.(skillId);
    }
    editor._lastNovelProductKey = productKey;
    if (editor.novelPanel) {
        refreshNovelHistory(editor).catch(() => {});
    }
}

export function defaultNovelState() {
    return {
        projectId: "",
        title: "",
        productTask: "",
        importMeta: {},
        chapters: [],
        currentChapterId: "",
        history: [],
        assets: { characters: [], scenes: [], audios: [], videos: [] },
        settings: {
            narrativeMode: "short_drama",
            maxShotsPerChapter: 8,
            defaultDurationSec: 5,
            autoConcatChapter: true,
            reviewBeforeQueue: false,
            shotMin: 2,
            shotMax: 8,
            durationMin: 2,
            durationMax: 12,
            genBatchSize: 4,
            segmentMaxMinutes: 5,
        },
        updatedAt: "",
    };
}

export function ensureNovelTimeline(timeline) {
    if (!timeline || typeof timeline !== "object") return defaultNovelState();
    if (!timeline.novel || typeof timeline.novel !== "object") {
        timeline.novel = defaultNovelState();
    }
    timeline.novel = slimNovelForTimeline(timeline.novel);
    return timeline.novel;
}

/** Keep only chapter status rows in the Comfy widget — full text lives on disk. */
export function slimNovelForTimeline(novel) {
    const base = defaultNovelState();
    if (!novel || typeof novel !== "object") return base;
    const chapters = Array.isArray(novel.chapters) ? novel.chapters : [];
    const hist = Array.isArray(novel.history) ? novel.history : [];
    const assets = novel.assets && typeof novel.assets === "object" ? novel.assets : {};
    const slimAsset = (a) => ({
        id: a?.id || "",
        name: a?.name || "",
        aliases: Array.isArray(a?.aliases) ? a.aliases : [],
        imageFile: a?.imageFile || "",
        inputFile: a?.inputFile || "",
        imagePath: a?.imagePath || "",
        mediaFile: a?.mediaFile || "",
        mediaPath: a?.mediaPath || "",
        audioFile: a?.audioFile || "",
        videoFile: a?.videoFile || "",
        bindCharacter: a?.bindCharacter || "",
    });
    return {
        ...base,
        ...novel,
        projectId: novel.projectId || "",
        title: novel.title || "",
        productTask: novel.productTask || novel.importMeta?.productTask || "",
        importMeta: novel.importMeta && typeof novel.importMeta === "object" ? novel.importMeta : {},
        currentChapterId: novel.currentChapterId || "",
        settings: { ...base.settings, ...(novel.settings || {}) },
        updatedAt: novel.updatedAt || "",
        chapters: chapters.map((ch) => ({
            id: ch?.id || "",
            index: ch?.index ?? 0,
            title: ch?.title || "",
            status: ch?.status || "pending",
            shotCount: Number(ch?.shotCount) || (Array.isArray(ch?.shots) ? ch.shots.length : 0) || 0,
            shotDoneCount: Number(ch?.shotDoneCount) || 0,
            updatedAt: ch?.updatedAt || "",
            outputPath: ch?.outputPath || "",
            error: ch?.error || "",
            narrativeUnit: ch?.narrativeUnit || "",
            parentActTitle: ch?.parentActTitle || "",
            parentActId: ch?.parentActId || "",
            segmentIndex: ch?.segmentIndex,
            segmentCount: ch?.segmentCount,
            estimatedMinutes: ch?.estimatedMinutes,
            maxMinutes: ch?.maxMinutes,
        })),
        history: hist.slice(-40).map((h) => ({
            at: h?.at || h?.time || "",
            action: h?.action || "",
            detail: h?.detail || "",
        })),
        assets: {
            characters: (Array.isArray(assets.characters) ? assets.characters : []).map(slimAsset),
            scenes: (Array.isArray(assets.scenes) ? assets.scenes : []).map(slimAsset),
            audios: (Array.isArray(assets.audios) ? assets.audios : []).map(slimAsset),
            videos: (Array.isArray(assets.videos) ? assets.videos : []).map(slimAsset),
        },
    };
}

/** Reload chapter status / history from project.json (source of truth). */
export async function syncNovelFromDisk(editor, { silent = true } = {}) {
    const novel = ensureNovelTimeline(editor?.timeline);
    const pid = String(novel.projectId || "").trim();
    if (!pid) return null;
    try {
        const data = await novelApi("/minimax/director/novel/projects", {
            action: "load",
            projectId: pid,
        });
        const next = slimNovelForTimeline(data.novel || data.project);
        const product = productTaskKey(editor);
        const owned = resolveNovelProduct(next);
        if (owned !== product) {
            // Disk project doesn't match current task — don't overwrite active assets
            const bucket = editor.timeline.novelByProduct || (editor.timeline.novelByProduct = {});
            bucket[owned] = next;
            if (String(novel.projectId || "") === String(next.projectId || "")) {
                restoreProductNovel(editor.timeline, product);
                renderNovelPanel(editor);
                editor.commit?.(false, { syncTimeline: true });
            }
            if (!silent) {
                editor._novelSetMsg?.(
                    owned === "film"
                        ? "磁盘项目是电影资产，未覆盖当前小说库"
                        : "磁盘项目是小说资产，未覆盖当前电影库",
                    true,
                );
            }
            return next;
        }
        // Preserve local chapter selection if still valid
        const cur = novel.currentChapterId;
        if (cur && (next.chapters || []).some((c) => c.id === cur)) {
            next.currentChapterId = cur;
        }
        next.productTask = product;
        if (!next.importMeta || typeof next.importMeta !== "object") next.importMeta = {};
        next.importMeta.productTask = product;
        editor.timeline.novel = next;
        const bucket = editor.timeline.novelByProduct || (editor.timeline.novelByProduct = {});
        bucket[product] = slimNovelForTimeline(next);
        ensureNovelTimeline(editor.timeline);
        renderNovelPanel(editor);
        editor.commit?.(false, { syncTimeline: true });
        if (!silent) editor._novelSetMsg?.(`已同步项目状态：${next.title || pid}`);
        return next;
    } catch (err) {
        console.warn("[novel] sync from disk failed:", err);
        if (!silent) editor._novelSetMsg?.(String(err?.message || err), true);
        return null;
    }
}

async function novelApi(path, body) {
    const res = await api.fetchApi(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `HTTP ${res.status}`);
    }
    return data;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function setNodeWidget(node, name, value) {
    const w = node?.widgets?.find((x) => x.name === name);
    if (!w) return false;
    w.value = value;
    w.callback?.(value);
    return true;
}

async function waitForComfyIdle(signal, { timeoutMs = 8 * 3600 * 1000 } = {}) {
    const t0 = Date.now();
    await sleep(900);
    while (Date.now() - t0 < timeoutMs) {
        if (signal?.aborted) throw new Error("已取消一键跑");
        let remaining = 0;
        try {
            const res = await api.fetchApi("/queue");
            const data = await res.json();
            remaining = (data?.queue_running?.length || 0) + (data?.queue_pending?.length || 0);
        } catch (_) {
            remaining = 1;
        }
        if (remaining === 0) {
            await sleep(1200);
            if (signal?.aborted) throw new Error("已取消一键跑");
            try {
                const res2 = await api.fetchApi("/queue");
                const data2 = await res2.json();
                const rem2 = (data2?.queue_running?.length || 0) + (data2?.queue_pending?.length || 0);
                if (rem2 === 0) return;
            } catch (_) {
                return;
            }
            continue;
        }
        await sleep(2000);
    }
    throw new Error("等待 Queue 超时");
}

function pickVideoFromHistoryEntry(entry) {
    const outs = entry?.outputs || {};
    for (const nodeOut of Object.values(outs)) {
        if (!nodeOut || typeof nodeOut !== "object") continue;
        for (const key of ["gifs", "videos", "images"]) {
            const arr = nodeOut[key];
            if (!Array.isArray(arr)) continue;
            for (const item of arr) {
                const fn = String(item?.filename || "");
                if (/\.(mp4|webm|mov|mkv)$/i.test(fn)) {
                    return {
                        filename: fn,
                        subfolder: item.subfolder || "",
                        type: item.type || "output",
                    };
                }
            }
        }
    }
    return null;
}

async function pickLatestHistoryVideo() {
    try {
        const res = await api.fetchApi("/history?max_items=12");
        const hist = await res.json();
        const entries = Object.entries(hist || {});
        // Prefer newest prompt ids (often appended); also try reverse insertion order
        for (let i = entries.length - 1; i >= 0; i -= 1) {
            const hit = pickVideoFromHistoryEntry(entries[i][1]);
            if (hit) return hit;
        }
    } catch (err) {
        console.warn("[novel] history scan failed:", err);
    }
    return null;
}

async function queueNovelChapterVideo(editor, signal) {
    const node = editor?.node;
    // Ensure full video path (not stills-only)
    setNodeWidget(node, "ref_gen_only", false);
    editor.commit?.(true, { syncTimeline: true });
    editor.flushTimelineSync?.();
    if (signal?.aborted) throw new Error("已取消一键跑");
    await app.queuePrompt(0);
    await waitForComfyIdle(signal);
}

function fileToB64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function directorLlmPayload(editor) {
    const desk = editor?.timeline?.desk || {};
    const td = desk.text_director || {};
    const backend = String(td.backend || "local").toLowerCase() === "cloud" ? "cloud" : "local";
    const cloudModel = td.llm_model || td.llmModel || "";
    const localModel = td.model || editor.widget?.("local_director_model")?.value || "";
    const skillId = String(td.skill_id || "").trim();
    const product = productTaskKey(editor);
    const narrativeMode = product === "film" ? "film" : "short_drama";
    if (editor?.timeline?.novel?.settings) {
        editor.timeline.novel.settings.narrativeMode = narrativeMode;
    }
    const fallbackSkill = narrativeMode === "film" ? "novel-film" : "novel-short-drama";
    const resolvedSkill = !skillId || skillId === "none"
        ? fallbackSkill
        : (narrativeMode === "film" && skillId === "novel-short-drama"
            ? "novel-film"
            : (narrativeMode !== "film" && skillId === "novel-film" ? "novel-short-drama" : skillId));
    return {
        model: backend === "cloud" ? (cloudModel || localModel) : (localModel || cloudModel),
        backend,
        llm_url: td.llm_url || td.llmUrl || "",
        api_format: td.llm_api_format || td.api_format || td.apiFormat || "Ollama",
        api_key: td.llm_api_key || td.api_key || td.apiKey || "",
        n_gpu_layers: td.n_gpu_layers ?? td.nGpuLayers,
        n_ctx: td.n_ctx ?? td.nCtx,
        temperature: td.temperature == null || td.temperature === "" ? 0.6 : td.temperature,
        mmproj: td.mmproj,
        thinking: td.zhipu_thinking ? "enabled" : "disabled",
        skill_id: resolvedSkill,
        continuity: [
            desk.continuity?.characters,
            desk.continuity?.locations,
            desk.continuity?.props,
        ]
            .filter(Boolean)
            .join("\n"),
        deskStyle: desk.style || "",
        deskSoundscape: desk.soundscape || "",
        deskMusic: desk.music || "",
    };
}

export function mountNovelPanel(editor) {
    if (!editor?.root || editor._novelPanelMounted) return;
    editor._novelPanelMounted = true;
    ensureNovelStyles();
    ensureNovelTimeline(editor.timeline);

    const panel = document.createElement("div");
    panel.className = "h3d-novel";
    panel.dataset.r = "novel-panel";
    panel.dataset.product = "novel";
    panel.hidden = true;
    panel.innerHTML = `
      <div class="h3d-novel-head">
        <b data-r="novel-head-title">小说短剧 · 主流程</b>
        <span data-r="novel-progress">未导入</span>
        <button type="button" class="h3d-btn" data-a="novel-clear-global-cache" title="清空全局提示词/风格声景/各组提示词等历史缓存，便于新创作">清除全局缓存</button>
      </div>
      <p class="h3d-novel-hint" data-r="novel-head-hint">短剧：按章一次分镜→挂图→装载→Queue；可用「一键跑全书」。</p>
      <div class="h3d-novel-steps" data-r="novel-steps">
        <span class="h3d-novel-step" data-step="1" data-r="novel-step-1">1 导入</span>
        <span class="h3d-novel-step" data-step="2" data-r="novel-step-2">2 资产</span>
        <span class="h3d-novel-step" data-step="3" data-r="novel-step-3">3 分镜</span>
        <span class="h3d-novel-step" data-step="4" data-r="novel-step-4">4 挂图</span>
        <span class="h3d-novel-step" data-step="5" data-r="novel-step-5">5 装载</span>
      </div>

      <div class="h3d-novel-block" data-block="import">
        <h4 data-r="novel-import-title">① 导入项目</h4>
        <p class="h3d-novel-block-sub" data-r="novel-import-sub">选择历史或导入 txt / epub / docx / 粘贴正文</p>
        <div class="h3d-novel-row">
          <select data-r="novel-history" title="历史项目" style="min-width:180px">
            <option value="">历史项目…</option>
          </select>
          <button type="button" class="h3d-btn" data-a="novel-refresh">刷新</button>
          <button type="button" class="h3d-btn" data-a="novel-continue" data-r="novel-continue-ch">继续未完成章</button>
        </div>
        <div class="h3d-novel-row">
          <input type="text" data-r="novel-title" placeholder="作品标题（可选）" style="flex:1;min-width:140px" />
          <label class="h3d-btn" style="cursor:pointer">
            选择文件
            <input type="file" data-r="novel-file" accept=".txt,.epub,.docx,text/plain" hidden />
          </label>
          <button type="button" class="h3d-btn h3d-btn-primary" data-a="novel-import">一键导入</button>
        </div>
        <textarea data-r="novel-paste" placeholder="粘贴正文…（电影模式：整份剧情文本，不按章切分）"></textarea>
      </div>

      <div class="h3d-novel-block" data-block="assets">
        <h4 data-r="novel-assets-title">② 全局人物 / 场景参考库</h4>
        <p class="h3d-novel-block-sub" data-r="novel-assets-sub">先提取名单，再上传定妆图（LLM 在下方「推理」页配置）</p>
        <div class="h3d-novel-row h3d-novel-actions">
          <button type="button" class="h3d-btn" data-a="novel-extract">提取全局资产</button>
        </div>
        <div class="h3d-novel-assets">
          <div class="h3d-novel-asset-col">
            <h4>人物参考库</h4>
            <div data-r="novel-chars"></div>
            <div class="h3d-novel-row">
              <input type="text" data-r="novel-char-name" placeholder="人物名" style="flex:1" />
              <label class="h3d-btn" style="cursor:pointer">上传图
                <input type="file" data-r="novel-char-file" accept="image/*" hidden />
              </label>
            </div>
          </div>
          <div class="h3d-novel-asset-col">
            <h4>场景参考库</h4>
            <div data-r="novel-scenes"></div>
            <div class="h3d-novel-row">
              <input type="text" data-r="novel-scene-name" placeholder="场景名" style="flex:1" />
              <label class="h3d-btn" style="cursor:pointer">上传图
                <input type="file" data-r="novel-scene-file" accept="image/*" hidden />
              </label>
            </div>
          </div>
        </div>
        <div class="h3d-novel-assets-film h3d-film-only" data-r="novel-media-assets">
          <div class="h3d-novel-asset-col">
            <h4>音频资产库</h4>
            <p class="h3d-novel-block-sub">配乐 / 环境音素材库（单文件须 ${REF_MEDIA_DURATION_MIN_SEC}～${REF_MEDIA_DURATION_MAX_SEC} 秒，超限禁止上传）；装载后在分镜卡按镜选用并可填起止秒剪辑</p>
            <div data-r="novel-audios"></div>
            <div class="h3d-novel-row">
              <input type="text" data-r="novel-audio-name" placeholder="音频名" style="flex:1" />
              <label class="h3d-btn" style="cursor:pointer">上传音频
                <input type="file" data-r="novel-audio-file" accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg" hidden />
              </label>
            </div>
          </div>
          <div class="h3d-novel-asset-col">
            <h4>动作视频库</h4>
            <p class="h3d-novel-block-sub">动作参考视频库（单文件须 ${REF_MEDIA_DURATION_MIN_SEC}～${REF_MEDIA_DURATION_MAX_SEC} 秒，超限禁止上传）；装载后在分镜卡按镜挂载并可填起止秒剪辑</p>
            <div data-r="novel-videos"></div>
            <div class="h3d-novel-row">
              <input type="text" data-r="novel-video-name" placeholder="动作名" style="flex:1" />
              <input type="text" data-r="novel-video-bind" placeholder="绑定角色（可选）" style="flex:1" />
              <label class="h3d-btn" style="cursor:pointer">上传视频
                <input type="file" data-r="novel-video-file" accept="video/*,.mp4,.webm,.mov,.mkv" hidden />
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="h3d-novel-block" data-block="chapter">
        <h4 data-r="novel-chapter-title">③ 本章操作</h4>
        <p class="h3d-novel-block-sub" data-r="novel-chapter-sub">点选下方章节后操作</p>
        <p class="h3d-novel-block-sub" data-r="novel-mode-hint" style="margin:0"></p>
        <div class="h3d-novel-film-script" data-r="film-script-status">电影剧本：未导入（按幕切分；无标记可智能切幕）</div>
        <div class="h3d-novel-chapters" data-r="novel-chapters"></div>
        <div class="h3d-novel-history" data-r="novel-op-history" title="磁盘项目操作记录"></div>

        <div class="h3d-novel-row" data-r="novel-shot-range-row" title="分镜镜数与单镜时长（无硬上限；超过 ${SHOT_COUNT_WARN_THRESHOLD} 镜或 ${DURATION_SEC_WARN_THRESHOLD}s 会弹窗确认）">
          <label style="font-size:11px;opacity:.85" data-r="novel-shot-label">镜数
            <input type="number" class="h3d-num" data-r="novel-shot-min" min="1" step="1" value="2" style="width:52px" />
            <span style="opacity:.6">～</span>
            <input type="number" class="h3d-num" data-r="novel-shot-max" min="1" step="1" value="8" style="width:52px" title="超过 ${SHOT_COUNT_WARN_THRESHOLD} 会提示确认" />
          </label>
          <label style="font-size:11px;opacity:.85">单镜秒数
            <input type="number" class="h3d-num" data-r="novel-dur-min" min="0.5" step="0.5" value="2" style="width:56px" />
            <span style="opacity:.6">～</span>
            <input type="number" class="h3d-num" data-r="novel-dur-max" min="0.5" step="0.5" value="12" style="width:56px" title="超过 ${DURATION_SEC_WARN_THRESHOLD}s 会提示确认" />
          </label>
          <label style="font-size:11px;opacity:.85" data-r="novel-gen-batch-wrap" class="h3d-film-only">每批生成
            <input type="number" class="h3d-num" data-r="novel-gen-batch" min="1" max="16" step="1" value="4" style="width:52px" title="仅「本幕分批续跑」时每次 Queue 镜数" />
          </label>
          <label style="font-size:11px;opacity:.85" data-r="novel-seg-max-wrap" class="h3d-film-only" title="将一幕切成片段时，每片段目标上限（分钟）">片段最大
            <input type="number" class="h3d-num" data-r="novel-seg-max-min" min="1" max="60" step="0.5" value="5" style="width:56px" />
            <span style="opacity:.65">分钟</span>
          </label>
        </div>

        <div class="h3d-novel-drama-flow h3d-novel-only" data-r="novel-drama-flow">
          <div class="h3d-novel-row h3d-novel-actions">
            <button type="button" class="h3d-btn" data-a="novel-storyboard">本章分镜</button>
            <button type="button" class="h3d-btn" data-a="novel-bind">按镜挂参考图</button>
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="novel-prepare">装载并准备 Queue</button>
            <button type="button" class="h3d-btn" data-a="novel-mark-done">标记本章完成</button>
            <button type="button" class="h3d-btn" data-a="novel-sync">同步状态</button>
          </div>
          <div class="h3d-novel-batch" data-r="novel-batch">
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="novel-run-all"
              title="按章自动：分镜→挂图→装载→Queue→按章名存视频">一键跑全书</button>
            <button type="button" class="h3d-btn" data-a="novel-run-cancel" hidden>停止一键跑</button>
            <label title="已完成章不再重跑"><input type="checkbox" data-r="novel-skip-done" checked />跳过已完成</label>
            <label title="已有分镜时不重拆"><input type="checkbox" data-r="novel-reuse-shots" checked />复用已有分镜</label>
          </div>
        </div>

        <div class="h3d-novel-film-flow h3d-film-only" data-r="novel-film-flow">
          <h4>按幕工作流</h4>
          <p class="h3d-novel-block-sub">一幕可再切成多个片段（可设「片段最大分钟」）。每个片段单独分镜 → 挂图 → 一次 Queue 成片；片段内同场硬锁，片段间内容参考连贯、不硬锁末帧。</p>
          <div class="h3d-novel-film-progress" data-r="film-shot-progress">幕进度：未导入</div>
          <div class="h3d-novel-row h3d-novel-actions">
            <button type="button" class="h3d-btn" data-a="novel-split-acts" title="无「第×幕」标记时用 LLM 切幕">智能切幕</button>
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="novel-split-segments"
              title="把当前选中的幕按最大分钟切成多个片段">本幕切片段</button>
            <button type="button" class="h3d-btn" data-a="novel-storyboard" title="重写本片段/本幕全部分镜">本片段分镜</button>
            <button type="button" class="h3d-btn" data-a="novel-bind">按镜挂参考图</button>
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="novel-prepare" title="装载本片段全部镜">装载本片段并准备 Queue</button>
          </div>
          <div class="h3d-novel-batch">
            <button type="button" class="h3d-btn h3d-btn-primary" data-a="novel-run-all"
              title="按列表顺序：分镜→挂图→装载→Queue→按名存视频">一键跑全片</button>
            <button type="button" class="h3d-btn" data-a="novel-run-cancel" data-r="film-run-cancel" hidden>停止一键跑</button>
            <label title="已完成幕不再重跑"><input type="checkbox" data-r="novel-skip-done-film" checked />跳过已完成</label>
            <label title="已有分镜时不重拆"><input type="checkbox" data-r="novel-reuse-shots-film" checked />复用已有分镜</label>
          </div>
          <div class="h3d-novel-row h3d-novel-actions">
            <button type="button" class="h3d-btn" data-a="novel-mark-done">标记本幕完成</button>
            <button type="button" class="h3d-btn" data-a="novel-sync">从磁盘同步进度</button>
            <button type="button" class="h3d-btn" data-a="novel-continue-gen" data-r="novel-continue-btn"
              title="仅当本幕镜数极大时：按「每批生成」分批续跑">本幕分批续跑</button>
          </div>
        </div>
      </div>

      <div class="h3d-novel-msg" data-r="novel-msg"></div>
    `;

    // Prefer bible panel; fallback mainBody
    const bibleBody =
        editor.root.querySelector('[data-r="h3d-panel-body-bible"]') ||
        editor.root.querySelector(".h3d-main") ||
        editor.root;
    bibleBody.insertBefore(panel, bibleBody.firstChild);
    editor.novelPanel = panel;

    const q = (sel) => panel.querySelector(sel);
    const setMsg = (text, isErr = false) => {
        const el = q('[data-r="novel-msg"]');
        if (el) {
            el.textContent = text || "";
            el.style.color = isErr ? "#f0a0a0" : "";
        }
    };

    const applyNovel = (novel) => {
        if (!novel || typeof novel !== "object") return;
        const product = productTaskKey(editor);
        const slim = slimNovelForTimeline(novel);
        const owned = resolveNovelProduct(slim) || product;
        // Always tag with the product we're editing under
        slim.productTask = owned;
        if (!slim.importMeta || typeof slim.importMeta !== "object") slim.importMeta = {};
        slim.importMeta.productTask = owned;
        if (owned !== product) {
            // Opened a project that belongs to the other product → park into that slot only
            const bucket = editor.timeline.novelByProduct || (editor.timeline.novelByProduct = {});
            bucket[owned] = slim;
            setMsg(
                owned === "film"
                    ? "该项目属于电影模式，已存入电影资产槽；请切换到「电影模式」任务查看"
                    : "该项目属于小说短剧，已存入小说资产槽；请切换到「小说章节」任务查看",
                true,
            );
            return;
        }
        editor.timeline.novel = slim;
        const bucket = editor.timeline.novelByProduct || (editor.timeline.novelByProduct = {});
        bucket[product] = slimNovelForTimeline(slim);
        ensureNovelTimeline(editor.timeline);
        renderNovelPanel(editor);
        editor.commit?.(false, { syncTimeline: true });
        editor.node?.setDirtyCanvas?.(true, true);
    };

    const readShotSettingsFromPanel = () => {
        const novel = ensureNovelTimeline(editor.timeline);
        const settings = { ...(novel.settings || {}) };
        const product = productTaskKey(editor);
        const mode = product === "film" ? "film" : "short_drama";
        settings.narrativeMode = mode;
        let shotMin = parseInt(q('[data-r="novel-shot-min"]')?.value, 10);
        let shotMax = parseInt(q('[data-r="novel-shot-max"]')?.value, 10);
        let durMin = parseFloat(q('[data-r="novel-dur-min"]')?.value);
        let durMax = parseFloat(q('[data-r="novel-dur-max"]')?.value);
        if (!Number.isFinite(shotMin) || shotMin < 1) shotMin = mode === "film" ? 4 : 2;
        if (!Number.isFinite(shotMax) || shotMax < 1) shotMax = mode === "film" ? 12 : 8;
        shotMax = Math.max(1, shotMax);
        shotMin = Math.max(1, Math.min(shotMax, shotMin));
        if (!Number.isFinite(durMin) || durMin < 0.5) durMin = mode === "film" ? 4 : 2;
        if (!Number.isFinite(durMax) || durMax < 0.5) durMax = mode === "film" ? 30 : 12;
        durMax = Math.max(0.5, durMax);
        durMin = Math.max(0.5, Math.min(durMax, durMin));
        settings.shotMin = shotMin;
        settings.shotMax = shotMax;
        settings.maxShotsPerChapter = mode === "film"
            ? Math.max(shotMax, Number(settings.maxShotsPerChapter) || 120)
            : shotMax;
        settings.durationMin = durMin;
        settings.durationMax = durMax;
        if (mode === "film" && (settings.defaultDurationSec == null || settings.defaultDurationSec < 4)) {
            settings.defaultDurationSec = 8;
        }
        let genBatch = parseInt(q('[data-r="novel-gen-batch"]')?.value, 10);
        if (!Number.isFinite(genBatch) || genBatch < 1) genBatch = mode === "film" ? 4 : 8;
        genBatch = Math.max(1, genBatch);
        settings.genBatchSize = genBatch;
        let segMax = parseFloat(q('[data-r="novel-seg-max-min"]')?.value);
        if (!Number.isFinite(segMax) || segMax < 1) {
            segMax = Number(settings.segmentMaxMinutes) > 0 ? Number(settings.segmentMaxMinutes) : 5;
        }
        segMax = Math.max(1, Math.min(60, segMax));
        settings.segmentMaxMinutes = segMax;
        novel.settings = settings;
        // Keep inputs normalized (no hard upper caps)
        const minEl = q('[data-r="novel-shot-min"]');
        const maxEl = q('[data-r="novel-shot-max"]');
        const dMinEl = q('[data-r="novel-dur-min"]');
        const dMaxEl = q('[data-r="novel-dur-max"]');
        const batchEl = q('[data-r="novel-gen-batch"]');
        const segEl = q('[data-r="novel-seg-max-min"]');
        if (minEl) minEl.value = String(shotMin);
        if (maxEl) maxEl.value = String(shotMax);
        if (dMinEl) dMinEl.value = String(durMin);
        if (dMaxEl) dMaxEl.value = String(durMax);
        if (batchEl) batchEl.value = String(genBatch);
        if (segEl) segEl.value = String(segMax);
        return settings;
    };

    for (const sel of [
        '[data-r="novel-shot-min"]',
        '[data-r="novel-shot-max"]',
        '[data-r="novel-dur-min"]',
        '[data-r="novel-dur-max"]',
        '[data-r="novel-gen-batch"]',
        '[data-r="novel-seg-max-min"]',
    ]) {
        q(sel)?.addEventListener("change", () => {
            readShotSettingsFromPanel();
            editor.commit?.(false, { syncTimeline: true });
        });
    }

    const selectedChapterId = () =>
        editor.timeline?.novel?.currentChapterId ||
        editor.timeline?.novel?.chapters?.[0]?.id ||
        "";

    const setBatchRunningUi = (running) => {
        const runBtn = q('[data-a="novel-run-all"]');
        const cancelBtns = panel.querySelectorAll('[data-a="novel-run-cancel"]');
        if (runBtn) runBtn.disabled = !!running;
        cancelBtns.forEach((cancelBtn) => {
            cancelBtn.hidden = !running;
        });
        for (const sel of [
            '[data-a="novel-storyboard"]',
            '[data-a="novel-storyboard-append"]',
            '[data-a="novel-split-acts"]',
            '[data-a="novel-split-segments"]',
            '[data-a="novel-bind"]',
            '[data-a="novel-prepare"]',
            '[data-a="novel-continue-gen"]',
            '[data-a="novel-mark-done"]',
        ]) {
            panel.querySelectorAll(sel).forEach((el) => {
                el.disabled = !!running;
            });
        }
    };

    const applyPreparedTimeline = (data) => {
        const prepared = data.timeline || {};
        const preparedSegs = Array.isArray(prepared.segments)
            ? JSON.parse(JSON.stringify(prepared.segments))
            : [];
        const tw = editor.taskTypeWidget || editor.widget?.("task_type");
        const product = productTaskKey(editor);
        const productPrefix = product === "film" ? "film" : "novel";
        const productLabel = product === "film"
            ? "film — 电影模式(Film Mode)"
            : "novel — 小说章节(Novel Chapters)";
        if (tw) {
            const opts = tw.options?.values || [];
            const hit = opts.find((o) => String(o).startsWith(productPrefix));
            if (hit) tw.value = hit;
            else tw.value = productLabel;
        }
        if (editor.globalTask) {
            const opts = [...(editor.globalTask.options || [])].map((o) => o.value || o);
            const hit = opts.find((o) => String(o).startsWith(productPrefix));
            if (hit) editor.globalTask.value = hit;
        }
        editor.applyTaskLayout?.();
        if (prepared.novel) editor.timeline.novel = slimNovelForTimeline(prepared.novel);
        else if (data.novel) applyNovel(data.novel);
        else applyNovel(editor.timeline.novel);
        if (prepared.image_director) {
            editor.timeline.image_director = prepared.image_director;
        }
        for (const seg of preparedSegs) {
            if (seg) seg.refs = coerceIndexedRefs(seg.refs);
        }
        if (prepared.global && typeof prepared.global === "object") {
            const gRefs = coerceIndexedRefs(prepared.global.refs);
            editor.timeline.global = {
                ...(editor.timeline.global || {}),
                ...prepared.global,
                taskType: product,
                refs: gRefs,
            };
        } else {
            editor.timeline.global = {
                ...(editor.timeline.global || {}),
                taskType: product,
            };
        }
        editor.timeline.segments = preparedSegs;
        editor.timeline.editMode = "segment";
        editor.timeline.timelineMode = "prompt_batch";
        editor._batchWorkspaceStash = null;
        try {
            if (editor.timeline.global) editor.timeline.global.refs = [];
            ensureImageBatchTimeline(editor);
            normalizeImageBatchSegments(editor);
            renderImageBatchGroups(editor);
            editor.updateContinuityUI?.();
            editor.updateSeamDedupeUI?.();
        } catch (err) {
            console.warn("[novel] refresh batch cards failed:", err);
        }
        updateNovelPanelVisibility(editor);
        editor.syncBinderContent?.();
        editor.commit?.(true, { syncTimeline: true });
        editor.updateDomWidgetHeight?.();
        editor.node?.setDirtyCanvas?.(true, true);
        return preparedSegs;
    };

    const prepareChapterOntoTimeline = async (chapterId, opts = {}) => {
        const novel = ensureNovelTimeline(editor.timeline);
        const settings = readShotSettingsFromPanel();
        const product = productTaskKey(editor);
        const resume = opts.resume !== false;
        // Default: whole act/chapter. Explicit batchLimit only for optional film batch resume.
        const batchLimit = opts.batchLimit != null ? opts.batchLimit : 0;
        // Flush hand-tuned seconds/prompts into timeline before prepare rebuild
        editor.harvestBatchPrompts?.();
        editor.flushTimelineSync?.();
        const data = await novelApi("/minimax/director/novel/chapter/prepare", {
            projectId: novel.projectId,
            chapterId,
            timeline: editor.timeline,
            productTask: product,
            resume,
            batchLimit: batchLimit > 0 ? batchLimit : 0,
        });
        const segs = applyPreparedTimeline(data);
        return { data, segs };
    };

    const maybeAutoSplitActs = async (novelLike) => {
        const product = productTaskKey(editor);
        if (product !== "film") return novelLike;
        const meta = novelLike?.importMeta || {};
        const chapters = novelLike?.chapters || [];
        const needs = meta.needsLlmActSplit === true || (chapters.length <= 1 && Number(meta.charCount || 0) >= 800);
        if (!needs || chapters.length > 1) return novelLike;
        const llm = directorLlmPayload(editor);
        if (!llm.model) {
            setMsg("已导入单幕剧本；请在「推理」页配置导演模型后点「智能切幕」", true);
            return novelLike;
        }
        setMsg("未检测到幕标记，正在智能切幕…");
        try {
            const data = await novelApi("/minimax/director/novel/split_acts", {
                projectId: novelLike.projectId,
                force: false,
                ...llm,
            });
            applyNovel(data.novel || data.project);
            setMsg(`智能切幕完成：${data.actCount || (data.novel?.chapters || []).length || "?"} 幕`);
            return data.novel || data.project;
        } catch (err) {
            console.warn("[film] auto split_acts failed:", err);
            setMsg(`导入为单幕（智能切幕失败：${err?.message || err}）。可稍后点「智能切幕」重试`, true);
            return novelLike;
        }
    };

    const continueFilmGeneration = async () => {
        const novel = ensureNovelTimeline(editor.timeline);
        if (!novel.projectId) throw new Error("请先导入或打开项目");
        const cid = selectedChapterId();
        if (!cid) throw new Error("请先选择章节");
        const settings = readShotSettingsFromPanel();
        const llm = directorLlmPayload(editor);
        const abort = new AbortController();
        editor._novelBatchAbort = abort;
        editor._novelBatchRunning = true;
        setBatchRunningUi(true);
        try {
            // Bind refs once before batches
            setMsg("按镜挂参考图…");
            const bound = await novelApi("/minimax/director/novel/assets/bind", {
                projectId: novel.projectId,
                chapterId: cid,
            });
            applyNovel(bound.novel || bound.project);

            let round = 0;
            while (!abort.signal.aborted) {
                round += 1;
                setMsg(`本幕分批续跑 · 第 ${round} 批：装载未完成镜…`);
                const { data, segs } = await prepareChapterOntoTimeline(cid, {
                    resume: true,
                    batchLimit: settings.genBatchSize || 4,
                });
                const pending = Number(data.pendingCount ?? data.shotPendingCount ?? 0);
                const selected = Number(data.selectedCount || segs.filter((s) => s?.runSelected !== false).length || 0);
                const done = Number(data.doneCount ?? data.shotDoneCount ?? 0);
                const total = Number(data.shotCount || segs.length || 0);
                if (pending <= 0 || selected <= 0) {
                    setMsg(`本幕已全部完成：${done}/${total} 镜`);
                    break;
                }
                setMsg(`Queue 本批 ${selected} 镜（本幕进度 ${done}/${total}）…请保持本页打开`);
                editor.showBinderStep?.("output");
                await queueNovelChapterVideo(editor, abort.signal);
                await syncNovelFromDisk(editor, { silent: true });
                renderNovelPanel(editor);
            }
            if (abort.signal.aborted) setMsg("已停止续跑（已完成镜与尾帧已保存，可随时继续）");
        } finally {
            editor._novelBatchRunning = false;
            editor._novelBatchAbort = null;
            setBatchRunningUi(false);
            await syncNovelFromDisk(editor, { silent: true });
            renderNovelPanel(editor);
        }
    };

    const runOneChapterPipeline = async (chapter, settings, llm, opts, signal) => {
        const novel = ensureNovelTimeline(editor.timeline);
        const pid = novel.projectId;
        const cid = chapter.id;
        const title = chapter.title || cid;
        const reuseShots = !!opts.reuseShots;
        const hasShots = Number(chapter.shotCount || 0) > 0
            || (Array.isArray(chapter.shots) && chapter.shots.length > 0)
            || ["storyboarded", "refs_ready", "generating"].includes(String(chapter.status || ""));

        novel.currentChapterId = cid;
        editor.commit?.(false, { syncTimeline: true });
        renderNovelPanel(editor);

        if (!(reuseShots && hasShots)) {
            setMsg(`【${title}】分镜中…（镜数 ${settings.shotMin}～${settings.shotMax}）`);
            const sb = await novelApi("/minimax/director/novel/chapter/storyboard", {
                projectId: pid,
                chapterId: cid,
                settings,
                ...llm,
            });
            applyNovel(sb.novel || sb.project);
            if (signal?.aborted) throw new Error("已取消一键跑");
        } else {
            setMsg(`【${title}】复用已有分镜…`);
        }

        setMsg(`【${title}】挂参考图…`);
        const bound = await novelApi("/minimax/director/novel/assets/bind", {
            projectId: pid,
            chapterId: cid,
        });
        applyNovel(bound.novel || bound.project);
        if (signal?.aborted) throw new Error("已取消一键跑");

        setMsg(`【${title}】装载时间线…`);
        await prepareChapterOntoTimeline(cid);
        if (signal?.aborted) throw new Error("已取消一键跑");

        const sinceTs = Date.now() / 1000 - 1;
        setMsg(`【${title}】Queue 生成中…请保持本页打开`);
        editor.showBinderStep?.("output");
        await queueNovelChapterVideo(editor, signal);

        setMsg(`【${title}】保存成片到章节文件夹…`);
        const media = await pickLatestHistoryVideo();
        const saved = await novelApi("/minimax/director/novel/chapter/save_output", {
            projectId: pid,
            chapterId: cid,
            sinceTs,
            markDone: true,
            ...(media || {}),
        });
        applyNovel(saved.novel || saved.project);
        return saved;
    };

    const runAllChapters = async () => {
        if (editor._novelBatchRunning) return;
        const novel = ensureNovelTimeline(editor.timeline);
        const product = productTaskKey(editor);
        const nSeg = (novel.chapters || []).filter((c) => String(c?.narrativeUnit || "") === "segment").length;
        const unit = product === "film" ? (nSeg > 0 ? "片段" : "幕") : "章";
        if (!novel.projectId) throw new Error(product === "film" ? "请先导入或打开电影项目" : "请先导入或打开小说项目");
        const settings = readShotSettingsFromPanel();
        const llm = directorLlmPayload(editor);
        if (!llm.model) throw new Error("请先在「推理」页配置提示词导演模型");
        const skipDone = !!(
            q('[data-r="novel-skip-done"]')?.checked
            || q('[data-r="novel-skip-done-film"]')?.checked
        );
        const reuseShots = !!(
            q('[data-r="novel-reuse-shots"]')?.checked
            || q('[data-r="novel-reuse-shots-film"]')?.checked
        );
        const chapters = [...(novel.chapters || [])].filter((c) => c && c.id);
        if (!chapters.length) throw new Error(product === "film" ? "项目没有幕" : "项目没有章节");

        const queue = chapters.filter((c) => !(skipDone && c.status === "done"));
        if (!queue.length) {
            setMsg(`没有需要跑的${unit}（均已完成）`);
            return;
        }
        if (!confirmHighShotOrDuration({
            shotMin: settings.shotMin,
            shotMax: settings.shotMax,
            durationMin: settings.durationMin,
            durationMax: settings.durationMax,
        })) {
            setMsg("已取消一键跑");
            return;
        }

        const abort = new AbortController();
        editor._novelBatchAbort = abort;
        editor._novelBatchRunning = true;
        setBatchRunningUi(true);
        const okTitles = [];
        const failTitles = [];
        try {
            setMsg(
                `一键跑启动：共 ${queue.length} ${unit}，沿用镜数 ${settings.shotMin}～${settings.shotMax}、`
                + `单镜 ${settings.durationMin}～${settings.durationMax}s`,
            );
            for (let i = 0; i < queue.length; i += 1) {
                if (abort.signal.aborted) throw new Error("已取消一键跑");
                const ch = queue[i];
                const title = ch.title || ch.id;
                setMsg(`一键跑 ${i + 1}/${queue.length}：${title}`);
                try {
                    const saved = await runOneChapterPipeline(
                        ch,
                        settings,
                        llm,
                        { reuseShots },
                        abort.signal,
                    );
                    okTitles.push(`${title} → ${saved.outputPath || "已保存"}`);
                } catch (err) {
                    if (abort.signal.aborted || /已取消/.test(String(err?.message || err))) {
                        throw err;
                    }
                    console.error(err);
                    failTitles.push(`${title}: ${err?.message || err}`);
                    try {
                        await novelApi("/minimax/director/novel/progress", {
                            projectId: novel.projectId,
                            chapterId: ch.id,
                            status: "failed",
                            error: String(err?.message || err),
                        });
                        await syncNovelFromDisk(editor, { silent: true });
                    } catch (_) { /* ignore */ }
                }
            }
            const lines = [
                `一键跑结束：成功 ${okTitles.length}，失败 ${failTitles.length}`,
                ...okTitles.map((s) => `✓ ${s}`),
                ...failTitles.map((s) => `✗ ${s}`),
            ];
            setMsg(lines.join("\n"), failTitles.length > 0);
        } finally {
            editor._novelBatchRunning = false;
            editor._novelBatchAbort = null;
            setBatchRunningUi(false);
            await syncNovelFromDisk(editor, { silent: true });
            renderNovelPanel(editor);
        }
    };

    editor._novelSetMsg = setMsg;

    panel.addEventListener("click", async (ev) => {
        const btn = ev.target?.closest?.("[data-a]");
        if (!btn || !panel.contains(btn)) return;
        const action = btn.dataset.a;
        try {
            if (action === "novel-run-cancel") {
                editor._novelBatchAbort?.abort?.();
                setMsg(
                    productTaskKey(editor) === "film"
                        ? "正在停止一键跑（当前幕生成结束后生效）…"
                        : "正在停止一键跑（当前章生成结束后生效）…",
                );
                return;
            }
            if (action === "novel-run-all") {
                await runAllChapters();
                return;
            }
            if (action === "novel-continue-gen") {
                await continueFilmGeneration();
                return;
            }
            if (action === "novel-split-acts") {
                const novel = ensureNovelTimeline(editor.timeline);
                if (!novel.projectId) throw new Error("请先导入电影项目");
                const llm = directorLlmPayload(editor);
                if (!llm.model) throw new Error("请先在「推理」页配置提示词导演模型");
                const force = (novel.chapters || []).length > 1
                    ? window.confirm("已有多幕，确定强制重新切幕？已有分镜可能需重做。")
                    : false;
                if ((novel.chapters || []).length > 1 && !force) {
                    setMsg("已取消智能切幕");
                    return;
                }
                setMsg("智能切幕中…");
                const data = await novelApi("/minimax/director/novel/split_acts", {
                    projectId: novel.projectId,
                    force: (novel.chapters || []).length > 1 ? !!force : false,
                    ...llm,
                });
                applyNovel(data.novel || data.project);
                setMsg(`智能切幕完成：${data.actCount || (data.novel?.chapters || []).length || "?"} 幕`);
                return;
            }
            if (action === "novel-split-segments") {
                const novel = ensureNovelTimeline(editor.timeline);
                if (!novel.projectId) throw new Error("请先导入电影项目");
                const cid = selectedChapterId();
                if (!cid) throw new Error("请先选择要切分的幕");
                const cur = (novel.chapters || []).find((c) => c.id === cid);
                const settings = readShotSettingsFromPanel();
                const maxMin = settings.segmentMaxMinutes || 5;
                const title = cur?.title || cid;
                const shots = Number(cur?.shotCount || 0);
                const ok = window.confirm(
                    `将「${title}」按「片段最大 ${maxMin} 分钟」切成多个片段？\n\n`
                    + (shots > 0 ? "该幕已有分镜将被替换为新片段列表，需重新分镜。\n" : "")
                    + "切分后每个片段可单独分镜与生成。",
                );
                if (!ok) {
                    setMsg("已取消切片段");
                    return;
                }
                const llm = directorLlmPayload(editor);
                setMsg(`正在切片段（≤${maxMin} 分钟/片）…`);
                const data = await novelApi("/minimax/director/novel/split_segments", {
                    projectId: novel.projectId,
                    chapterId: cid,
                    segmentMaxMinutes: maxMin,
                    settings,
                    useLlm: !!llm.model,
                    ...llm,
                });
                applyNovel(data.novel || data.project);
                setMsg(
                    `「${data.parentActTitle || title}」已切为 ${data.segmentCount || "?"} 片段`
                    + `（目标 ≤${data.maxMinutes || maxMin} 分钟/片，原约 ${data.estimatedMinutes ?? "?"} 分钟）`,
                );
                return;
            }
            if (action === "novel-refresh") {
                await refreshNovelHistory(editor);
                await syncNovelFromDisk(editor, { silent: false });
                setMsg("已刷新历史项目与章节状态");
                return;
            }
            if (action === "novel-sync") {
                setMsg("正在从磁盘同步章节状态…");
                await syncNovelFromDisk(editor, { silent: false });
                return;
            }
            if (action === "novel-clear-global-cache") {
                const ok = window.confirm(
                    "清除全局缓存？\n\n将清空全局提示词、创意简述、连续性、整体风格/声景、各组提示词，以及本项目各章磁盘上的全局提示词缓存。\n不改 LLM 配置与参考图文件。",
                );
                if (!ok) return;
                setMsg("正在清除全局缓存…");
                clearGlobalCreativeCache(editor, { clearSegments: true });
                const pid = String(novel.projectId || editor.timeline?.novel?.projectId || "").trim();
                if (pid) {
                    const data = await novelApi("/minimax/director/novel/clear_global_cache", {
                        projectId: pid,
                        chapterId: selectedChapterId(),
                        allChapters: true,
                    });
                    if (data.novel || data.project) applyNovel(data.novel || data.project);
                }
                setMsg("已清除全局缓存，可重新填写故事/风格后分镜");
                return;
            }
            if (action === "novel-import") {
                setMsg("正在导入…");
                const file = q('[data-r="novel-file"]')?.files?.[0];
                const product = productTaskKey(editor);
                const payload = {
                    title: q('[data-r="novel-title"]')?.value || "",
                    text: q('[data-r="novel-paste"]')?.value || "",
                    productTask: product,
                    // Film backend splits by 幕 markers; novel by 章
                    splitChapters: true,
                };
                if (file) {
                    payload.filename = file.name;
                    payload.fileB64 = await fileToB64(file);
                }
                const data = await novelApi("/minimax/director/novel/import", payload);
                applyNovel(data.novel || data.project);
                await refreshNovelHistory(editor);
                let nCh = (data.project?.chapters || data.novel?.chapters || []).length;
                if (product === "film") {
                    const after = await maybeAutoSplitActs(data.novel || data.project);
                    nCh = (after?.chapters || []).length || nCh;
                    setMsg(
                        `电影剧本已导入：${nCh} 幕`
                        + `${data.project?.importMeta?.charCount ? ` · ${data.project.importMeta.charCount} 字` : ""}`,
                    );
                } else {
                    setMsg(`导入成功：${nCh} 章`);
                }
                return;
            }
            if (action === "novel-continue") {
                const novel = ensureNovelTimeline(editor.timeline);
                const next = (novel.chapters || []).find((c) => c.status !== "done");
                if (!next) {
                    setMsg("全部章节已完成", false);
                    return;
                }
                novel.currentChapterId = next.id;
                applyNovel(novel);
                setMsg(`已定位：${next.title}`);
                return;
            }
            const novel = ensureNovelTimeline(editor.timeline);
            if (!novel.projectId) throw new Error("请先导入或打开小说项目");
            const llm = directorLlmPayload(editor);
            if (action === "novel-extract") {
                setMsg("正在提取全局人物/场景…");
                const data = await novelApi("/minimax/director/novel/assets/extract", {
                    projectId: novel.projectId,
                    timeline: editor.timeline,
                    enableGen: false,
                    ...llm,
                });
                if (data.timeline) Object.assign(editor.timeline, data.timeline);
                applyNovel(data.novel || data.project);
                setMsg("全局资产已写入参考库（可再上传定妆图）");
                return;
            }
            if (action === "novel-storyboard" || action === "novel-storyboard-append") {
                const append = action === "novel-storyboard-append";
                const settings = readShotSettingsFromPanel();
                if (!confirmHighShotOrDuration({
                    shotMin: settings.shotMin,
                    shotMax: settings.shotMax,
                    durationMin: settings.durationMin,
                    durationMax: settings.durationMax,
                })) {
                    setMsg("已取消分镜");
                    return;
                }
                const unit = productTaskKey(editor) === "film" ? "幕" : "章";
                setMsg(append ? `追加本${unit}分镜中…` : `本${unit}分镜中…`);
                const data = await novelApi("/minimax/director/novel/chapter/storyboard", {
                    projectId: novel.projectId,
                    chapterId: selectedChapterId(),
                    settings,
                    append,
                    ...llm,
                });
                applyNovel(data.novel || data.project);
                const total = data.shotCount || data.shots?.length || 0;
                setMsg(
                    (append ? `追加完成，本${unit}共 ${total} 镜` : `分镜完成：${total} 镜`)
                    + `（范围 ${settings.shotMin}～${settings.shotMax}）`
                    + (data.shotDoneCount != null ? ` · 已生成 ${data.shotDoneCount}` : ""),
                );
                return;
            }
            if (action === "novel-bind") {
                setMsg("按镜匹配出场人物/场景…");
                const data = await novelApi("/minimax/director/novel/assets/bind", {
                    projectId: novel.projectId,
                    chapterId: selectedChapterId(),
                });
                applyNovel(data.novel || data.project);
                setMsg(
                    `已按镜挂接：${data.boundShots || 0}/${data.shotCount || 0} 镜，`
                    + `共 ${data.boundRefs || 0} 张参考（场景 ${data.boundSceneRefs || 0}）`,
                );
                return;
            }
            if (action === "novel-prepare") {
                const product = productTaskKey(editor);
                const unit = product === "film" ? "幕" : "章";
                setMsg(`装载本${unit}到时间线…`);
                const { data, segs } = await prepareChapterOntoTimeline(selectedChapterId(), {
                    resume: true,
                    batchLimit: 0,
                });
                editor.showBinderStep?.("shots");
                const n = segs.length || data.segmentCount || 0;
                const selected = data.selectedCount != null ? data.selectedCount : n;
                const withPrompt = segs.filter((s) => String(s?.prompt || "").trim()).length;
                const withRef = segs.filter(
                    (s) => Array.isArray(s?.refs) && s.refs.some((r) => r?.imageFile)
                ).length;
                setMsg(
                    product === "film"
                        ? `已装载本幕 ${n} 镜，将生成 ${selected} 镜（完成 ${data.doneCount || 0}/${data.shotCount || n}）。`
                          + `侧栏核对后 Queue；极大幕可用「本幕分批续跑」。`
                        : `已装载 ${n} 组分镜（含提示词 ${withPrompt}，含参考图 ${withRef}）。`
                          + `请到侧栏「章节分镜」核对后，再去「成片出库」Queue`,
                );
                return;
            }
            if (action === "novel-mark-done") {
                const data = await novelApi("/minimax/director/novel/progress", {
                    projectId: novel.projectId,
                    chapterId: selectedChapterId(),
                    status: "done",
                });
                applyNovel(data.novel || data.project);
                setMsg(productTaskKey(editor) === "film" ? "已标记本幕完成" : "已标记本章完成");
            }
        } catch (err) {
            console.error(err);
            setMsg(String(err?.message || err), true);
        }
    });

    q('[data-r="novel-history"]')?.addEventListener("change", async (ev) => {
        const id = ev.target.value;
        if (!id) return;
        try {
            const data = await novelApi("/minimax/director/novel/projects", {
                action: "load",
                projectId: id,
            });
            applyNovel(data.novel || data.project);
            setMsg(`已打开：${data.project?.title || id}`);
        } catch (err) {
            setMsg(String(err?.message || err), true);
        }
    });

    const uploadViaComfy = async (file) => {
        const soft = 95 * 1024 * 1024;
        const chunkSize = 8 * 1024 * 1024;
        const relOf = (upload) => {
            const name = upload.name || upload.filename;
            const sub = String(upload.subfolder || "").replace(/\\/g, "/").replace(/\/$/, "");
            return sub ? `${sub}/${name}` : name;
        };
        if (file.size <= soft) {
            try {
                const body = new FormData();
                body.append("image", file);
                body.append("type", "input");
                body.append("overwrite", "true");
                const resp = await api.fetchApi("/upload/image", { method: "POST", body });
                if (resp.ok) return relOf(await resp.json());
            } catch (_) {
                /* fall through to chunked */
            }
        }
        const uploadId = crypto.randomUUID();
        const totalChunks = Math.ceil(file.size / chunkSize);
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, file.size);
            const body = new FormData();
            body.append("upload_id", uploadId);
            body.append("chunk_index", String(i));
            body.append("total_chunks", String(totalChunks));
            body.append("filename", file.name);
            body.append("chunk", file.slice(start, end), `${file.name}.part`);
            const resp = await api.fetchApi("/minimax/director/upload_chunk", { method: "POST", body });
            if (!resp.ok) throw new Error(await resp.text() || `分块上传失败 (${resp.status})`);
            const data = await resp.json();
            if (data.name) return relOf(data);
        }
        throw new Error("分块上传未完成");
    };

    const uploadAsset = async (kind, nameSel, fileSel, extra = {}) => {
        const name = q(nameSel)?.value?.trim();
        const file = q(fileSel)?.files?.[0];
        const novel = ensureNovelTimeline(editor.timeline);
        if (!novel.projectId) throw new Error("请先导入项目");
        if (!name) throw new Error("请填写名称");
        if (!file) throw new Error(kind === "audios" || kind === "videos" ? "请选择媒体文件" : "请选择图片");
        const labels = { characters: "人物图", scenes: "场景图", audios: "音频", videos: "动作视频" };
        if (kind === "audios" || kind === "videos") {
            await assertRefMediaDuration(file, { kind: labels[kind] || "媒体" });
        }
        setMsg(`上传${labels[kind] || kind}…`);
        const payload = {
            projectId: novel.projectId,
            kind,
            name,
            bindCharacter: extra.bindCharacter || "",
            filename: file.name,
        };
        if (kind === "audios" || kind === "videos") {
            payload.mediaPath = await uploadViaComfy(file);
        } else {
            payload.imageB64 = await fileToB64(file);
        }
        const data = await novelApi("/minimax/director/novel/assets/upload", payload);
        applyNovel(data.novel || data.project);
        setMsg(`${labels[kind] || "资产"}已保存到库`);
        if (q(fileSel)) q(fileSel).value = "";
    };

    q('[data-r="novel-char-file"]')?.addEventListener("change", async () => {
        try {
            await uploadAsset("characters", '[data-r="novel-char-name"]', '[data-r="novel-char-file"]');
        } catch (err) {
            setMsg(String(err?.message || err), true);
        }
    });
    q('[data-r="novel-scene-file"]')?.addEventListener("change", async () => {
        try {
            await uploadAsset("scenes", '[data-r="novel-scene-name"]', '[data-r="novel-scene-file"]');
        } catch (err) {
            setMsg(String(err?.message || err), true);
        }
    });
    q('[data-r="novel-audio-file"]')?.addEventListener("change", async () => {
        try {
            await uploadAsset("audios", '[data-r="novel-audio-name"]', '[data-r="novel-audio-file"]');
        } catch (err) {
            setMsg(String(err?.message || err), true);
            const el = q('[data-r="novel-audio-file"]');
            if (el) el.value = "";
        }
    });
    q('[data-r="novel-video-file"]')?.addEventListener("change", async () => {
        try {
            await uploadAsset("videos", '[data-r="novel-video-name"]', '[data-r="novel-video-file"]', {
                bindCharacter: q('[data-r="novel-video-bind"]')?.value?.trim() || "",
            });
        } catch (err) {
            setMsg(String(err?.message || err), true);
            const el = q('[data-r="novel-video-file"]');
            if (el) el.value = "";
        }
    });

    editor._novelSetMsg = setMsg;
    refreshNovelHistory(editor).catch(() => {});
    // Reopen / reload: pull chapter status from disk project.json
    syncNovelFromDisk(editor, { silent: true }).finally(() => renderNovelPanel(editor));
}

export async function refreshNovelHistory(editor) {
    const panel = editor?.novelPanel;
    if (!panel) return;
    const sel = panel.querySelector('[data-r="novel-history"]');
    if (!sel) return;
    const product = productTaskKey(editor);
    const isFilm = product === "film";
    try {
        const res = await api.fetchApi(
            `/minimax/director/novel/projects?productTask=${encodeURIComponent(product)}`,
        );
        const data = await res.json();
        const projects = data.projects || [];
        const cur = editor.timeline?.novel?.projectId || "";
        const curProduct = String(
            editor.timeline?.novel?.productTask
            || editor.timeline?.novel?.importMeta?.productTask
            || "",
        );
        const curMatches = !cur || curProduct === product || (!curProduct && !isFilm);
        sel.innerHTML = isFilm
            ? `<option value="">电影历史剧本…</option>`
            : `<option value="">小说历史项目…</option>`;
        for (const p of projects) {
            const opt = document.createElement("option");
            opt.value = p.projectId;
            if (isFilm) {
                const sc = Number(p.shotCount || 0);
                const sd = Number(p.shotDoneCount || 0);
                opt.textContent = sc > 0 ? `${p.title}（镜 ${sd}/${sc}）` : `${p.title}（剧本）`;
            } else {
                opt.textContent = `${p.title}（${p.doneCount}/${p.chapterCount}）`;
            }
            if (curMatches && p.projectId === cur) opt.selected = true;
            sel.appendChild(opt);
        }
    } catch {
        /* ignore */
    }
}

function comfyInputViewUrl(imageFile) {
    const norm = String(imageFile || "").replace(/\\/g, "/");
    if (!norm || /^[A-Za-z]:\//.test(norm) || norm.startsWith("/")) return "";
    const slash = norm.lastIndexOf("/");
    const filename = slash >= 0 ? norm.slice(slash + 1) : norm;
    const subfolder = slash >= 0 ? norm.slice(0, slash) : "";
    const params = new URLSearchParams({ filename, type: "input" });
    if (subfolder) params.set("subfolder", subfolder);
    return api.apiURL(`/view?${params.toString()}`);
}

function assetThumbUrl(projectId, asset) {
    const a = asset || {};
    if (String(a.imageB64 || "").startsWith("data:")) return a.imageB64;
    const viaInput = comfyInputViewUrl(a.inputFile || "");
    if (viaInput) return viaInput;
    // Fallback: project-local file served by novel image route
    const rel = String(a.imagePath || "").replace(/\\/g, "/");
    const inp = String(a.inputFile || "").replace(/\\/g, "/");
    if (projectId && (rel || inp)) {
        const params = new URLSearchParams({ projectId });
        if (rel) params.set("rel", rel);
        if (inp) params.set("input", inp);
        return api.apiURL(`/minimax/director/novel/image?${params.toString()}`);
    }
    return "";
}

function renderAssetList(host, items, projectId, opts = {}) {
    if (!host) return;
    const kind = opts.kind || "characters";
    const editor = opts.editor;
    const isMedia = kind === "audios" || kind === "videos";
    host.innerHTML = "";
    for (const a of items || []) {
        const row = document.createElement("div");
        row.className = "h3d-novel-asset" + (isMedia ? " media" : "");
        let thumbEl;
        if (isMedia) {
            thumbEl = document.createElement("div");
            thumbEl.className = "h3d-novel-asset-badge";
            thumbEl.textContent = kind === "audios" ? "♪" : "▶";
            thumbEl.title = a.inputFile || a.audioFile || a.videoFile || a.mediaPath || "";
            thumbEl.style.cssText =
                "width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:6px;background:rgba(255,255,255,.08);flex-shrink:0";
        } else {
            thumbEl = document.createElement("img");
            const thumb = assetThumbUrl(projectId, a);
            thumbEl.alt = a.name || "";
            thumbEl.title = a.inputFile || a.imagePath || a.imageFile || "";
            if (thumb) {
                thumbEl.src = thumb;
                thumbEl.onerror = () => {
                    thumbEl.removeAttribute("src");
                    thumbEl.alt = (a.name || "?").slice(0, 1);
                };
            } else {
                thumbEl.alt = (a.name || "?").slice(0, 1);
            }
        }
        const hasFile = isMedia
            ? !!(a.inputFile || a.audioFile || a.videoFile || a.mediaFile || a.mediaPath)
            : !!(a.inputFile || a.imageFile || a.imagePath || a.imageB64);
        const meta = document.createElement("div");
        meta.className = "h3d-novel-asset-meta";
        const sub = isMedia
            ? (hasFile ? "已存档" : "未上传")
                + (a.bindCharacter ? ` · 绑 ${a.bindCharacter}` : "")
            : (hasFile ? "已存图" : "仅提示词");
        meta.innerHTML = `<div>${escapeHtml(a.name || "")}</div><div style="opacity:.6">${escapeHtml(sub)}</div>`;
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "h3d-btn h3d-novel-asset-del";
        delBtn.textContent = "删除";
        delBtn.title = `从全局库删除「${a.name || ""}」`;
        delBtn.addEventListener("click", async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (!projectId) {
                editor?._novelSetMsg?.("请先导入项目", true);
                return;
            }
            const label = a.name || a.id || "该资产";
            if (!window.confirm(`确定从全局库删除「${label}」？\n（磁盘文件也会删除）`)) return;
            try {
                editor?._novelSetMsg?.(`正在删除 ${label}…`);
                const data = await novelApi("/minimax/director/novel/assets/delete", {
                    projectId,
                    kind,
                    assetId: a.id || "",
                    name: a.name || "",
                });
                if (editor) {
                    editor.timeline.novel = slimNovelForTimeline(data.novel || data.project);
                    ensureNovelTimeline(editor.timeline);
                    renderNovelPanel(editor);
                    editor.commit?.(false, { syncTimeline: true });
                }
                editor?._novelSetMsg?.(`已删除：${label}`);
            } catch (err) {
                console.error(err);
                editor?._novelSetMsg?.(String(err?.message || err), true);
            }
        });
        row.appendChild(thumbEl);
        row.appendChild(meta);
        row.appendChild(delBtn);
        host.appendChild(row);
    }
    if (!(items || []).length) {
        host.innerHTML = `<div style="opacity:.5;font-size:11px">暂无</div>`;
    }
}

function escapeHtml(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function novelPipelineStep(editor, novel) {
    const chars = novel?.assets?.characters || [];
    const scenes = novel?.assets?.scenes || [];
    const audios = novel?.assets?.audios || [];
    const videos = novel?.assets?.videos || [];
    const hasAsset = [...chars, ...scenes, ...audios, ...videos].some(
        (a) => a && (a.inputFile || a.imageFile || a.imagePath || a.audioFile || a.videoFile || a.mediaFile || a.mediaPath || a.prompt),
    );
    const ch = (novel?.chapters || []).find((c) => c.id === novel.currentChapterId)
        || (novel?.chapters || [])[0];
    const status = String(ch?.status || "");
    const segs = editor?.timeline?.segments || [];
    const loaded = segs.some((s) => s?.novelChapterId || s?.taskType === "novel" || s?.taskType === "film");
    if (!novel?.projectId) return 1;
    if (!hasAsset) return 2;
    if (!status || status === "pending") return 3;
    if (status === "storyboarded") return 4;
    if (status === "refs_ready" && !loaded) return 5;
    if (loaded || status === "generating" || status === "done") return 5;
    return 3;
}

export function renderNovelPanel(editor) {
    const panel = editor?.novelPanel;
    if (!panel) return;
    const novel = ensureNovelTimeline(editor.timeline);
    const product = productTaskKey(editor);
    const isFilm = product === "film";
    applyProductPresets(editor, product);
    panel.dataset.product = product;

    const headTitle = panel.querySelector('[data-r="novel-head-title"]');
    if (headTitle) headTitle.textContent = isFilm ? "电影模式 · 按幕流水线" : "小说短剧 · 按章流水线";
    const headHint = panel.querySelector('[data-r="novel-head-hint"]');
    if (headHint) {
        headHint.textContent = isFilm
            ? "电影：按幕切分，过长幕可再切片段（设最大分钟）→ 每片段单独分镜/生成。片段内硬锁，片段间内容参考一致。"
            : "短剧：本章一次分镜→挂图→装载→Queue；全书可用「一键跑全书」。没有追加分镜/续跑。";
    }
    const setTxt = (sel, value) => {
        const el = panel.querySelector(sel);
        if (el) el.textContent = value;
    };
    setTxt('[data-r="novel-import-title"]', isFilm ? "① 导入电影剧本" : "① 导入小说项目");
    setTxt('[data-r="novel-import-sub"]', isFilm
        ? "按「第×幕 / ACT N」切幕；无标记则导入后智能切幕；过长幕可再切片段"
        : "选择历史或导入 txt / epub / docx / 粘贴正文；下拉仅显示「小说」历史");
    setTxt('[data-r="novel-assets-title"]', isFilm ? "② 电影定妆 / 场景 / 音频 / 动作视频" : "② 小说人物 / 场景参考库");
    setTxt('[data-r="novel-assets-sub"]', isFilm
        ? "仅属本电影项目：定妆锁定外观；音频/动作视频按镜挂载（跨幕/片段共享资产库）"
        : "仅属本小说项目：先提取名单，再上传定妆图（与电影库隔离；LLM 在下方「推理」页）");
    setTxt('[data-r="novel-chapter-title"]', isFilm ? "③ 片段/幕：分镜 → 挂图 → 装载" : "③ 本章：分镜 → 挂图 → 装载");
    setTxt('[data-r="novel-chapter-sub"]', isFilm
        ? "点选下方列表；过长幕先「本幕切片段」，再对每个片段分镜与生成"
        : "点选下方章节后操作；装载后到侧栏「章节分镜」核对，再去「成片出库」Queue");
    setTxt('[data-r="novel-mode-hint"]', isFilm
        ? "电影参数：片段最大分钟可调 · 每片段 4～12 镜 · 片段内硬锁 / 片段间不硬锁"
        : "短剧参数：本章 2～8 镜 · 偏对白冲突 · 一次装载整章");
    setTxt('[data-r="novel-step-1"]', isFilm ? "1 剧本" : "1 导入");
    setTxt('[data-r="novel-step-2"]', isFilm ? "2 资产" : "2 资产");
    setTxt('[data-r="novel-step-3"]', isFilm ? "3 片段分镜" : "3 分镜");
    setTxt('[data-r="novel-step-4"]', isFilm ? "4 挂图" : "4 挂图");
    setTxt('[data-r="novel-step-5"]', isFilm ? "5 片段生成" : "5 装载");
    const shotLabel = panel.querySelector('[data-r="novel-shot-label"]');
    if (shotLabel && shotLabel.firstChild) {
        // label text node before input
        const first = [...shotLabel.childNodes].find((n) => n.nodeType === 3);
        if (first) first.textContent = isFilm ? "片段镜数 " : "镜数 ";
    }

    const continueCh = panel.querySelector('[data-r="novel-continue-ch"]');
    if (continueCh) continueCh.textContent = isFilm ? "继续未完成片段" : "继续未完成章";

    const prog = panel.querySelector('[data-r="novel-progress"]');
    const chapters = novel.chapters || [];
    const done = chapters.filter((c) => c.status === "done").length;
    const cur = chapters.find((c) => c.id === novel.currentChapterId) || chapters[0];
    const shotDone = Number(cur?.shotDoneCount || 0);
    const shotTotal = Number(cur?.shotCount || 0);
    const shotPending = Math.max(0, shotTotal - shotDone);
    const nSeg = chapters.filter((c) => String(c.narrativeUnit || "") === "segment").length;
    const unitLabel = nSeg > 0 ? "片段" : "幕";
    if (prog) {
        prog.textContent = novel.projectId
            ? (isFilm
                ? `${novel.title || novel.projectId} · ${done}/${chapters.length} ${unitLabel} · 当前镜 ${shotDone}/${shotTotal || 0}`
                : `${novel.title || novel.projectId} · ${done}/${chapters.length} 章`)
            : "未导入";
    }
    const filmScript = panel.querySelector('[data-r="film-script-status"]');
    if (filmScript) {
        const chars = Number(novel.importMeta?.charCount || 0);
        const nAud = (novel.assets?.audios || []).length;
        const nVid = (novel.assets?.videos || []).length;
        const segMax = Number(novel.settings?.segmentMaxMinutes || 5);
        if (!novel.projectId) {
            filmScript.textContent = "电影剧本：未导入（支持「第×幕」；过长幕可再切片段）";
        } else {
            filmScript.textContent =
                `剧本「${novel.title || novel.projectId}」· ${chars || "?"} 字 · 列表 ${chapters.length} 项`
                + (nSeg ? `（含 ${nSeg} 片段）` : "（幕）")
                + ` · 片段上限 ${segMax} 分钟`
                + ` · 音频 ${nAud} · 动作视频 ${nVid}`
                + (novel.importMeta?.needsLlmActSplit ? " · 建议点「智能切幕」" : "");
        }
    }
    const filmProg = panel.querySelector('[data-r="film-shot-progress"]');
    if (filmProg) {
        const actTitle = cur?.title || `本${unitLabel}`;
        if (!chapters.length) {
            filmProg.textContent = "进度：未导入";
        } else if (!shotTotal) {
            filmProg.textContent = `进度：${done}/${chapters.length} ${unitLabel}完成 · 「${actTitle}」尚未分镜`;
        } else if (shotPending <= 0) {
            filmProg.textContent = `进度：${done}/${chapters.length} ${unitLabel}完成 · 「${actTitle}」镜已全部生成 ${shotDone}/${shotTotal}`;
        } else {
            filmProg.textContent =
                `进度：${done}/${chapters.length} ${unitLabel}完成 · 「${actTitle}」已完成 ${shotDone}/${shotTotal}，待生成 ${shotPending}`;
        }
    }

    const titleEl = panel.querySelector('[data-r="novel-title"]');
    if (titleEl && novel.title && !titleEl.value) titleEl.value = novel.title;

    const settings = novel.settings || {};
    const fillIfIdle = (sel, value) => {
        const el = panel.querySelector(sel);
        if (!el || document.activeElement === el) return;
        if (value == null || Number.isNaN(value)) return;
        el.value = String(value);
    };
    fillIfIdle('[data-r="novel-shot-min"]', settings.shotMin ?? (isFilm ? 4 : 2));
    fillIfIdle('[data-r="novel-shot-max"]', settings.shotMax ?? (isFilm ? 12 : 8));
    fillIfIdle('[data-r="novel-dur-min"]', settings.durationMin ?? (isFilm ? 4 : 2));
    fillIfIdle('[data-r="novel-dur-max"]', settings.durationMax ?? (isFilm ? 30 : 12));
    fillIfIdle('[data-r="novel-gen-batch"]', settings.genBatchSize ?? 4);
    fillIfIdle('[data-r="novel-seg-max-min"]', settings.segmentMaxMinutes ?? 5);

    const curStep = novelPipelineStep(editor, novel);
    panel.querySelectorAll(".h3d-novel-step").forEach((el) => {
        const n = Number(el.dataset.step || 0);
        el.classList.toggle("active", n === curStep);
        el.classList.toggle("done", n < curStep);
    });

    const list = panel.querySelector('[data-r="novel-chapters"]');
    if (list) {
        list.innerHTML = "";
        for (const ch of chapters) {
            const row = document.createElement("div");
            row.className = "h3d-novel-ch" + (ch.id === novel.currentChapterId ? " active" : "");
            const isSeg = String(ch.narrativeUnit || "") === "segment";
            const est = ch.estimatedMinutes != null ? ` · ~${ch.estimatedMinutes}分` : "";
            const shotLine = isFilm
                ? `${ch.shotCount || 0} 镜${ch.shotDoneCount ? ` · 完 ${ch.shotDoneCount}` : ""}${est}`
                : `${ch.shotCount || 0} 镜`;
            const badge = isSeg ? "片段" : (isFilm ? "幕" : "");
            row.innerHTML = `
              <div title="${escapeHtml((ch.text || "").slice(0, 200))}">${escapeHtml(ch.title || ch.id)}${badge ? ` <span style="opacity:.55;font-size:10px">[${badge}]</span>` : ""}</div>
              <span class="h3d-novel-badge ${ch.status || ""}">${STATUS_LABEL[ch.status] || ch.status || "pending"}</span>
              <span style="opacity:.65;font-size:11px">${shotLine}</span>
            `;
            row.addEventListener("click", () => {
                novel.currentChapterId = ch.id;
                editor.commit?.(false, { syncTimeline: true });
                renderNovelPanel(editor);
            });
            list.appendChild(row);
        }
    }
    renderAssetList(panel.querySelector('[data-r="novel-chars"]'), novel.assets?.characters, novel.projectId, {
        kind: "characters",
        editor,
    });
    renderAssetList(panel.querySelector('[data-r="novel-scenes"]'), novel.assets?.scenes, novel.projectId, {
        kind: "scenes",
        editor,
    });
    renderAssetList(panel.querySelector('[data-r="novel-audios"]'), novel.assets?.audios, novel.projectId, {
        kind: "audios",
        editor,
    });
    renderAssetList(panel.querySelector('[data-r="novel-videos"]'), novel.assets?.videos, novel.projectId, {
        kind: "videos",
        editor,
    });

    const histHost = panel.querySelector('[data-r="novel-op-history"]');
    if (histHost) {
        const hist = Array.isArray(novel.history) ? novel.history.slice(-12).reverse() : [];
        if (!hist.length) {
            histHost.innerHTML = `<div class="h3d-novel-history-item"><span style="opacity:.5">暂无操作记录（分镜/挂图/装载/完成会写入磁盘）</span></div>`;
        } else {
            histHost.innerHTML = hist
                .map((h) => {
                    const at = escapeHtml(String(h.at || "").replace("T", " ").slice(0, 19));
                    const act = escapeHtml(String(h.action || ""));
                    const detail = escapeHtml(String(h.detail || ""));
                    return `<div class="h3d-novel-history-item"><b>${at || act}</b><span>${act}${detail ? ` · ${detail}` : ""}</span></div>`;
                })
                .join("");
        }
    }
}

export function updateNovelPanelVisibility(editor) {
    const panel = editor?.novelPanel;
    if (!panel) return;
    const show = isNovelLikeTask(editor.getTaskKey?.() || editor.taskTypeWidget?.value);
    panel.hidden = !show;
    panel.style.display = show ? "flex" : "none";
    editor.updateNovelDeskMode?.();
    if (show) {
        ensureNovelTimeline(editor.timeline);
        applyProductPresets(editor, productTaskKey(editor));
        renderNovelPanel(editor);
        // Debounced disk sync when entering novel/film mode / showing panel
        clearTimeout(editor._novelSyncTimer);
        editor._novelSyncTimer = setTimeout(() => {
            syncNovelFromDisk(editor, { silent: true }).catch(() => {});
        }, 200);
    }
}
