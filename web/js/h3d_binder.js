/**
 * Production-binder shell — step wizard IA (not an NLE / vendor director layout).
 * Steps: bible → shots → (media) → output
 * Media step only when the current task actually needs preview / timeline.
 */

import { applyWorkflowScope, ensureScopeSwitch } from "./h3d_scope.js";

function _q(root, sel) {
    try {
        return root?.querySelector?.(sel) || null;
    } catch {
        return null;
    }
}

function _move(el, dest, asFirst = false) {
    if (!el || !dest || el.parentNode === dest) return;
    if (asFirst) dest.insertBefore(el, dest.firstChild);
    else dest.appendChild(el);
}

/**
 * Same rule as applyTaskLayout hideTimeline (inverted):
 * need media for video edit, fl2v, and r2v batch; hide for other batch / gen.
 */
export function editorNeedsMediaTrack(editor) {
    if (!editor) return false;
    if (typeof editor.isFl2vMode === "function" && editor.isFl2vMode()) return true;
    if (typeof editor.isM2vBatch === "function" && editor.isM2vBatch()) return true;
    if (typeof editor.isR2vBatch === "function" && editor.isR2vBatch()) return true;
    if (typeof editor.isGenMode === "function" && editor.isGenMode()) return false;
    if (typeof editor.isImageBatch === "function" && editor.isImageBatch()) return false;
    const mode = editor.getDirectorMode?.() || editor._directorMode || "video";
    if (mode === "prompt_batch" || mode === "image_batch") return false;
    if (mode === "gen_blank" || mode === "gen_image") return false;
    return true;
}

/** m2v：隐藏剧本设定；只保留素材 / 动作视频 / 出库。 */
export function updateBinderStepCopy(editor) {
    const root = editor?.root;
    if (!root?.classList?.contains("h3d-binder")) return;
    const isM2v = typeof editor.isM2vBatch === "function" && editor.isM2vBatch();
    const rail = _q(root, '[data-r="h3d-step-rail"]');
    const workbench = editor.workbench || _q(root, ".h3d-workbench");
    const bibleBtn = rail?.querySelector('[data-step="bible"]');
    const biblePanel = workbench && _q(workbench, '[data-r="h3d-panel-bible"]');
    bibleBtn?.classList.toggle("hidden", !!isM2v);
    if (biblePanel) biblePanel.classList.toggle("h3d-binder-panel-disabled", !!isM2v);
    root.classList.toggle("h3d-binder-m2v", !!isM2v);
    if (isM2v && root.dataset.h3dStep === "bible") {
        if (typeof editor.showBinderStep === "function") editor.showBinderStep("media");
        else root.dataset.h3dStep = "media";
    }
    const setStep = (step, span, em) => {
        const btn = rail?.querySelector(`[data-step="${step}"]`);
        if (!btn) return;
        const s = btn.querySelector("span");
        const e = btn.querySelector("em");
        if (s) s.textContent = span;
        if (e) e.textContent = em;
    };
    const setPanel = (step, title, sub) => {
        const head = workbench && _q(workbench, `[data-r="h3d-panel-${step}"] .h3d-binder-head`);
        if (!head) return;
        const b = head.querySelector("b");
        const sp = head.querySelector("span");
        if (b) b.textContent = title;
        if (sp) sp.textContent = sub;
    };
    if (isM2v) {
        setStep("shots", "参考素材", "人物图 · 场景图 · 音频");
        setStep("media", "动作视频", "上传 · 裁切 · 均分（必做）");
        setStep("output", "成片出库", "分辨率 · 导出 · Queue");
        setPanel("shots", "01 · 参考素材", "人物图 / 场景图 / 音频");
        setPanel("media", "02 · 动作视频", "上传单路动作/运镜视频，可预览、裁切、均分");
        setPanel("output", "03 · 成片出库", "分辨率、导出方式与运行进度");
    } else {
        setStep("bible", "剧本设定", "连续 · 声景 · 提示词");
        setStep("shots", "分镜清单", "组 / 镜 / 提示词");
        setStep("media", "媒体轨", "预览 · 分割 · 轨道");
        setStep("output", "成片出库", "分辨率 · 导出 · 进度");
        setPanel("bible", "01 · 剧本设定", "先写清楚角色 / 场景 / 声景，再进分镜");
        setPanel("shots", "02 · 分镜清单", "按组推进，而不是按时间轴剪辑");
        setPanel("media", "03 · 媒体轨", "需要时再打开预览与轨道");
        setPanel("output", "04 · 成片出库", "分辨率、导出方式与运行进度");
    }
}

/** Toggle media step button/panel; relocate toolbar; leave media step if unavailable. */
export function updateBinderMediaStep(editor) {
    const root = editor?.root;
    if (!root?.classList?.contains("h3d-binder")) return;
    const need = editorNeedsMediaTrack(editor);
    root.dataset.h3dMedia = need ? "1" : "0";
    root.classList.toggle("h3d-binder-no-media", !need);

    const rail = _q(root, '[data-r="h3d-step-rail"]');
    const mediaBtn = rail?.querySelector('[data-step="media"]');
    if (mediaBtn) mediaBtn.classList.toggle("hidden", !need);

    const workbench = editor.workbench || _q(root, ".h3d-workbench");
    const mediaPanel = workbench && _q(workbench, '[data-r="h3d-panel-media"]');
    if (mediaPanel) mediaPanel.classList.toggle("h3d-binder-panel-disabled", !need);

    updateBinderStepCopy(editor);

    if (!need && root.dataset.h3dStep === "media") {
        if (typeof editor.showBinderStep === "function") editor.showBinderStep("shots");
        else root.dataset.h3dStep = "shots";
    }
}

/** Keep task/toolbar on the outermost shell (chrome → toolbar → steps → panels). */
function pinOuterToolbar(root) {
    const toolbar = _q(root, ".h3d-toolbar-wrap");
    if (!toolbar) return;
    toolbar.classList.add("h3d-toolbar-outer");
    const rail = _q(root, '[data-r="h3d-step-rail"]');
    const workbench = _q(root, ".h3d-workbench");
    const before = rail || workbench;
    if (before && before.parentNode === root) {
        if (toolbar.parentNode !== root || toolbar.nextSibling !== before) {
            root.insertBefore(toolbar, before);
        }
        return;
    }
    const chrome = _q(root, ".h3d-chrome");
    if (chrome?.parentNode === root) {
        if (toolbar.parentNode !== root || toolbar.previousSibling !== chrome) {
            root.insertBefore(toolbar, chrome.nextSibling);
        }
        return;
    }
    if (toolbar.parentNode !== root) root.appendChild(toolbar);
}

/** Re-home late-mounted panels into the active binder destinations. */
export function syncBinderContent(editor) {
    const root = editor?.root;
    if (!root?.classList?.contains("h3d-binder")) return;
    const workbench = editor.workbench || _q(root, ".h3d-workbench");
    if (!workbench) return;

    updateBinderMediaStep(editor);
    const needMedia = editorNeedsMediaTrack(editor);

    // Always outermost — never bury task select inside a step panel.
    pinOuterToolbar(root);
    ensureScopeSwitch(editor);
    applyWorkflowScope(editor);

    const bibleBody = _q(workbench, '[data-r="h3d-panel-body-bible"]');
    const shotsBody = _q(workbench, '[data-r="h3d-panel-body-shots"]');
    const mediaBody = _q(workbench, '[data-r="h3d-panel-body-media"]');
    const outputBody = _q(workbench, '[data-r="h3d-panel-body-output"]');
    const main = editor.mainBody || _q(root, ".h3d-main");

    const find = (sel) => _q(main, sel) || _q(root, sel) || _q(workbench, sel);

    if (bibleBody && editor.studioDesk) _move(editor.studioDesk, bibleBody);

    _move(find('[data-r="batch-panel"]'), shotsBody);
    _move(find(".h3d-fl2v-detail-wrap"), shotsBody);
    _move(find('[data-r="global-panel"]'), shotsBody);
    _move(find('[data-r="segment-panel"]'), shotsBody);
    const split = find(".h3d-split");
    if (split && shotsBody && !split.querySelector('[data-r="global-panel"], [data-r="segment-panel"]')) {
        split.classList.add("hidden");
    }

    // Preview / track only live in media step when that step exists.
    if (needMedia) {
        _move(find(".h3d-preview-dock"), mediaBody);
        _move(find('[data-r="split-edit-bar"]'), mediaBody);
        _move(find(".h3d-track-dock"), mediaBody);
    }

    _move(find(".h3d-filmout"), outputBody);
    _move(find('[data-r="run-status"]'), outputBody);

    // 成片栏挪位后重刷：链式连贯 / 连贯去帧 显隐依赖当前任务
    try {
        editor.updateSegmentContinuityUI?.();
    } catch {
        /* ignore */
    }
}

export function applyBinderShell(editor) {
    const root = editor?.root;
    if (!root || root.dataset.h3dBinder === "1") {
        syncBinderContent(editor);
        return;
    }
    root.dataset.h3dBinder = "1";
    root.classList.add("h3d-binder");

    const workbench = editor.workbench || _q(root, ".h3d-workbench");
    const main = editor.mainBody;
    const desk = editor.studioDesk;
    if (!workbench || !main || !desk) return;

    let rail = _q(root, '[data-r="h3d-step-rail"]');
    if (!rail) {
        rail = document.createElement("div");
        rail.className = "h3d-step-rail";
        rail.dataset.r = "h3d-step-rail";
        rail.innerHTML = `
          <button type="button" class="h3d-step on" data-step="bible">
            <i>01</i><span>剧本设定</span><em>连续 · 声景 · 提示词</em>
          </button>
          <button type="button" class="h3d-step" data-step="shots">
            <i>02</i><span>分镜清单</span><em>组 / 镜 / 提示词</em>
          </button>
          <button type="button" class="h3d-step" data-step="media">
            <i>03</i><span>媒体轨</span><em>预览 · 分割 · 轨道</em>
          </button>
          <button type="button" class="h3d-step" data-step="output">
            <i>04</i><span>成片出库</span><em>分辨率 · 导出 · 进度</em>
          </button>`;
        // chrome → toolbar → step rail → workbench
        const toolbar = _q(root, ".h3d-toolbar-wrap");
        if (toolbar?.parentNode === root) root.insertBefore(rail, toolbar.nextSibling);
        else if (workbench) root.insertBefore(rail, workbench);
        else root.appendChild(rail);
    }
    pinOuterToolbar(root);

    const ensurePanel = (step, title, sub) => {
        let p = _q(workbench, `[data-r="h3d-panel-${step}"]`);
        if (p) return p;
        p = document.createElement("div");
        p.className = `h3d-binder-panel${step === "bible" ? " on" : ""}`;
        p.dataset.r = `h3d-panel-${step}`;
        p.dataset.step = step;
        p.innerHTML = `<header class="h3d-binder-head"><b>${title}</b><span>${sub}</span></header><div class="h3d-binder-body" data-r="h3d-panel-body-${step}"></div>`;
        workbench.appendChild(p);
        return p;
    };

    ensurePanel("bible", "01 · 剧本设定", "先写清楚角色 / 场景 / 声景，再进分镜");
    ensurePanel("shots", "02 · 分镜清单", "按组推进，而不是按时间轴剪辑");
    ensurePanel("media", "03 · 媒体轨", "需要时再打开预览与轨道");
    ensurePanel("output", "04 · 成片出库", "分辨率、导出方式与运行进度");

    desk.classList.add("h3d-desk-document", "open");
    const head = desk.querySelector(".h3d-studio-desk-head");
    if (head) head.classList.add("h3d-desk-head-slim");

    const nav = desk.querySelector(".h3d-desk-nav");
    if (nav) {
        nav.classList.add("h3d-desk-chapters");
        const brand = nav.querySelector(".h3d-desk-brand");
        if (brand) brand.textContent = "章节";
    }

    const chrome = _q(root, ".h3d-chrome");
    if (chrome) {
        chrome.classList.add("h3d-chrome-minimal");
        const brand = chrome.querySelector(".h3d-chrome-brand span");
        if (brand) brand.textContent = "制片步骤本 · 非剪辑台布局";
    }

    workbench.classList.add("h3d-shell-binder");
    workbench.classList.remove("is-side");
    main.classList.add("h3d-main-slot");
    if (main.parentNode !== workbench) workbench.appendChild(main);

    const showStep = (step) => {
        let key = String(step || "bible");
        if (key === "media" && !editorNeedsMediaTrack(editor)) key = "shots";
        root.dataset.h3dStep = key;
        rail.querySelectorAll("[data-step]").forEach((b) => {
            b.classList.toggle("on", b.dataset.step === key);
        });
        workbench.querySelectorAll(".h3d-binder-panel").forEach((p) => {
            p.classList.toggle("on", p.dataset.step === key);
        });
        syncBinderContent(editor);
        editor.updateDomWidgetHeight?.();
        editor._markNodeDirtyLight?.();
        editor.scheduleRender?.();
    };

    rail.querySelectorAll("[data-step]").forEach((btn) => {
        btn.onclick = () => showStep(btn.dataset.step);
    });

    editor.showBinderStep = showStep;
    editor.syncBinderContent = () => syncBinderContent(editor);
    editor.updateBinderMediaStep = () => updateBinderMediaStep(editor);

    ensureScopeSwitch(editor);
    applyWorkflowScope(editor);
    syncBinderContent(editor);
    showStep(root.dataset.h3dStep || "bible");
}
