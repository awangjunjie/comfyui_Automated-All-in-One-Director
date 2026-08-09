/**
 * H3 Desk theme — production binder (step wizard), not an NLE / vendor director UI.
 */

export const H3D_THEME_ID = "h3d-theme";

export const H3D_PAINT = {
    bg: "#12161c",
    surface: "#1a222d",
    elevated: "#243041",
    border: "#3d4a5c",
    text: "#e6edf5",
    muted: "#93a1b5",
    accent: "#d4923a",
    accentSoft: "#2a2218",
    accentText: "#1a140c",
    secondary: "#5eb1a8",
    danger: "#e07a7a",
    track: "#2a3340",
};

const THEME_CSS = `
:root,.h3d-wrap{
  --h3d-bg:#16131a;
  --h3d-surface:#221c28;
  --h3d-elevated:#2c2433;
  --h3d-border:#4a3f55;
  --h3d-text:#f3ebe3;
  --h3d-muted:#b2a4b8;
  --h3d-accent:#e0a15a;
  --h3d-accent-soft:#3a2a18;
  --h3d-accent-text:#1a1208;
  --h3d-secondary:#7eb8a8;
  --h3d-danger:#e08a8a;
  --h3d-track:#32283a;
  --h3d-radius-ctl:0;
  --h3d-radius-panel:0;
  --h3d-font:"Palatino Linotype","Book Antiqua","Noto Serif SC","Songti SC",Georgia,serif;
  --h3d-ui-font:"Segoe UI","PingFang SC","Noto Sans SC",system-ui,sans-serif;
  --h3d-workbench-h:720px;
}
.h3d-host{width:100%;box-sizing:border-box;display:block}
.h3d-wrap,.h3d-binder{
  font-family:var(--h3d-ui-font);
  color:var(--h3d-text);
  font-size:12px;
  display:flex;flex-direction:column;gap:0;
  background:
    radial-gradient(1200px 420px at 10% -10%, rgba(224,161,90,.12), transparent 55%),
    linear-gradient(180deg,#1b1620 0%, #141018 100%);
  border:1px solid var(--h3d-border);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.03);
  padding:0;box-sizing:border-box;overflow:hidden;
}
/* Minimal masthead */
.h3d-chrome,.h3d-chrome-minimal{
  display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;
  padding:14px 16px 10px;border-bottom:1px solid var(--h3d-border);
  background:transparent;border-left:none;border-radius:0;
}
.h3d-chrome-brand strong{
  font-family:var(--h3d-font);font-size:22px;font-weight:700;letter-spacing:.08em;
  color:var(--h3d-text);display:block;line-height:1.1;
}
.h3d-chrome-brand span{font-size:11px;color:var(--h3d-muted);letter-spacing:.04em}
.h3d-chrome-chips{display:flex;gap:8px;flex-wrap:wrap}
.h3d-chip{
  font-size:11px;padding:5px 10px;border:1px solid var(--h3d-border);
  border-radius:0;color:var(--h3d-muted);background:rgba(0,0,0,.2);
}
.h3d-chip.on{color:var(--h3d-accent-text);background:var(--h3d-accent);border-color:var(--h3d-accent);font-weight:700}
/* 整局 / 分镜 — top-level workflow scope */
.h3d-scope-switch{
  display:flex;gap:0;border:1px solid var(--h3d-border);background:rgba(0,0,0,.25);flex-shrink:0;
}
.h3d-scope-btn{
  border:none;background:transparent;color:var(--h3d-muted);cursor:pointer;
  padding:8px 14px;font-size:12px;font-family:inherit;font-weight:600;letter-spacing:.04em;
}
.h3d-scope-btn:hover{color:var(--h3d-text);background:rgba(224,161,90,.08)}
.h3d-scope-btn.active{
  color:var(--h3d-accent-text);background:var(--h3d-accent);
}
.h3d-scope-global .h3d-fl2v-actions,
.h3d-scope-global [data-a="batch-add"],
.h3d-scope-global [data-a="batch-del-selected"]{display:none!important}
.h3d-mode button.active{
  background:var(--h3d-accent)!important;color:var(--h3d-accent-text)!important;border-color:var(--h3d-accent)!important;
}
/* Step rail — primary navigation (kills NLE toolbar look) */
.h3d-step-rail{
  display:grid;grid-template-columns:repeat(4,minmax(0,1fr));
  gap:0;border-bottom:1px solid var(--h3d-border);background:rgba(0,0,0,.18);
}
.h3d-binder.h3d-binder-no-media .h3d-step-rail,
.h3d-binder[data-h3d-media="0"] .h3d-step-rail{
  grid-template-columns:repeat(3,minmax(0,1fr));
}
.h3d-binder.h3d-binder-no-media .h3d-step[data-step="media"],
.h3d-binder[data-h3d-media="0"] .h3d-step[data-step="media"]{display:none!important}
.h3d-binder-panel.h3d-binder-panel-disabled{display:none!important}
.h3d-step{
  display:flex;flex-direction:column;align-items:flex-start;gap:2px;
  padding:12px 14px;border:none;border-right:1px solid var(--h3d-border);
  background:transparent;color:var(--h3d-muted);cursor:pointer;text-align:left;
  font-family:inherit;min-height:76px;
}
.h3d-step:last-child{border-right:none}
.h3d-step i{
  font-style:normal;font-family:var(--h3d-font);font-size:18px;font-weight:700;
  color:var(--h3d-border);letter-spacing:.06em;
}
.h3d-step span{font-size:13px;font-weight:700;color:var(--h3d-text)}
.h3d-step em{font-style:normal;font-size:10px;color:var(--h3d-muted)}
.h3d-step:hover{background:rgba(224,161,90,.06)}
.h3d-step.on{background:linear-gradient(180deg, rgba(224,161,90,.16), transparent);box-shadow:inset 0 -3px 0 var(--h3d-accent)}
.h3d-step.on i{color:var(--h3d-accent)}
@media(max-width:900px){
  .h3d-step-rail{grid-template-columns:1fr 1fr}
  .h3d-step{min-height:64px;border-bottom:1px solid var(--h3d-border)}
}
/* Binder workbench: one step at a time */
.h3d-workbench.h3d-shell-binder,
.h3d-workbench.h3d-shell-v2.h3d-shell-binder{
  display:block!important;width:100%;height:auto!important;max-height:none!important;
  grid-template-columns:none!important;overflow:visible;
}
.h3d-main-slot{display:none!important}
.h3d-binder-panel{display:none;padding:16px;min-height:420px}
.h3d-binder-panel.on{display:block}
.h3d-binder-head{
  display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;
  margin:0 0 14px;padding:0 0 10px;border-bottom:2px solid var(--h3d-accent);
}
.h3d-binder-head b{
  font-family:var(--h3d-font);font-size:20px;letter-spacing:.04em;font-weight:700;
}
.h3d-binder-head span{font-size:11px;color:var(--h3d-muted)}
.h3d-binder-body{display:flex;flex-direction:column;gap:12px}
/* Desk as document page (not side inspector) */
.h3d-desk-document.h3d-studio-desk{
  display:flex!important;flex-direction:column!important;
  border:1px solid var(--h3d-border);background:rgba(34,28,40,.92);
  box-shadow:0 10px 40px rgba(0,0,0,.25);min-height:360px;
}
.h3d-desk-document .h3d-desk-chapters,
.h3d-desk-nav.h3d-desk-chapters{
  width:100%!important;flex:0 0 auto!important;
  display:flex!important;flex-direction:row!important;flex-wrap:wrap;gap:6px;
  padding:10px 12px;border-right:none;border-bottom:1px solid var(--h3d-border);
  background:rgba(0,0,0,.15);
}
.h3d-desk-nav.h3d-desk-chapters .h3d-desk-brand{
  width:100%;text-align:left;border:none;margin:0 0 4px;padding:0;
  font-family:var(--h3d-font);letter-spacing:.12em;
}
.h3d-desk-nav.h3d-desk-chapters button{
  width:auto;min-width:72px;padding:8px 12px;
  border:1px solid var(--h3d-border);border-left:1px solid var(--h3d-border);
  background:transparent;color:var(--h3d-muted);
}
.h3d-desk-nav.h3d-desk-chapters button.active{
  background:var(--h3d-accent);color:var(--h3d-accent-text);border-color:var(--h3d-accent);font-weight:700;
}
.h3d-desk-head-slim{display:none!important}
.h3d-desk-document .h3d-desk-main{display:flex;flex-direction:column;min-height:0}
.h3d-desk-document.open .h3d-studio-desk-body{
  display:flex!important;max-height:none!important;min-height:280px;padding:14px 16px 18px;
  width:100%;box-sizing:border-box;
}
.h3d-desk-document .h3d-studio-page.active{width:100%}
.h3d-desk-document .h3d-studio-grid{width:100%}
.h3d-studio-grid{display:grid;gap:12px 14px;width:100%}
.h3d-studio-grid-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.h3d-studio-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.h3d-studio-grid > .h3d-studio-field{min-width:0}
.h3d-studio-grid > .h3d-studio-field textarea{min-height:120px}
.h3d-studio-grid-tall > .h3d-studio-field textarea{min-height:148px}
@media(max-width:820px){
  .h3d-studio-grid-3,.h3d-studio-grid-2{grid-template-columns:1fr}
}
.h3d-studio-tabs{display:none!important}
/* Outer chrome toolbar — always above step panels for task switching */
.h3d-toolbar-wrap,.h3d-toolbar-outer{
  margin:0;padding:10px 14px 12px;
  border-bottom:1px solid var(--h3d-border);
  background:rgba(0,0,0,.22);box-sizing:border-box;width:100%;
}
.h3d-toolbar.h3d-toolbar-v2{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}
.h3d-tool-group{
  display:flex;flex-wrap:wrap;gap:6px;align-items:center;
  padding:8px 10px;border:1px solid var(--h3d-border);background:rgba(0,0,0,.18);
  flex:1 1 auto;min-width:120px;
}
.h3d-tool-group.h3d-tool-meta{flex:0 1 160px}
.h3d-tool-label{
  width:100%;font-size:10px;letter-spacing:.14em;text-transform:uppercase;
  color:var(--h3d-accent);font-family:var(--h3d-font);
}
.h3d-binder > .h3d-toolbar-outer .h3d-select[data-r="global-task"]{
  min-width:min(280px,100%);max-width:100%;
}
.h3d-btn{
  background:transparent;color:var(--h3d-text);
  border:1px solid var(--h3d-border);border-radius:0;
  padding:7px 12px;font-size:11px;cursor:pointer;font-family:inherit;
}
.h3d-btn:hover{background:rgba(224,161,90,.1);border-color:var(--h3d-accent)}
.h3d-btn-primary{background:var(--h3d-accent);border-color:var(--h3d-accent);color:var(--h3d-accent-text);font-weight:700}
.h3d-btn-danger:hover{background:rgba(224,138,138,.12);border-color:var(--h3d-danger);color:#f0b4b4}
.h3d-btn-sm{padding:3px 8px;font-size:10px}
.h3d-btn.h3d-disabled,.h3d-btn:disabled{opacity:.38;cursor:not-allowed;pointer-events:none}
.h3d-select,.h3d-num,.h3d-prompt,.h3d-frame-input,
.h3d-studio-field textarea,.h3d-studio-field input,.h3d-studio-field select{
  background:rgba(0,0,0,.28);color:var(--h3d-text);
  border:1px solid var(--h3d-border);border-radius:0;font-family:inherit;
}
.h3d-prompt{font-family:var(--h3d-font);font-size:13px;line-height:1.45;min-height:120px}
.h3d-select:focus,.h3d-num:focus,.h3d-prompt:focus,
.h3d-studio-field textarea:focus,.h3d-studio-field input:focus,.h3d-studio-field select:focus{
  border-color:var(--h3d-accent);outline:none;box-shadow:none;
}
/* Media step: compact preview + track (secondary, not hero) */
.h3d-preview-dock,.h3d-track-dock,.h3d-filmout,.h3d-prompt-dock{
  border:1px solid var(--h3d-border);background:rgba(0,0,0,.18);padding:10px;border-radius:0;
}
.h3d-section-title{
  display:flex;justify-content:space-between;gap:8px;margin:0 0 8px;
  font-family:var(--h3d-font);letter-spacing:.08em;font-size:12px;color:var(--h3d-accent);
}
.h3d-section-title b{font-size:14px;color:var(--h3d-text);letter-spacing:.04em}
.h3d-preview-dock .h3d-stage{max-height:160px;min-height:90px;border:1px solid var(--h3d-border);background:#000}
.h3d-track-dock .h3d-viewport{
  max-height:none;min-height:240px;background:#0c0a0e;border:1px solid var(--h3d-border);
}
.h3d-prompt-layout.h3d-prompt-stack{display:flex;flex-direction:column;gap:10px}
.h3d-prompt-layout.h3d-prompt-stack .h3d-refs-col{border-top:1px solid var(--h3d-border);padding-top:8px}
.h3d-prompt-layout.h3d-prompt-stack .h3d-refs{
  grid-template-columns:repeat(9,minmax(48px,1fr));overflow-x:auto;
}
.h3d-batch-refs,.h3d-batch-global-refs .h3d-batch-refs{
  display:grid!important;grid-template-columns:repeat(9,minmax(52px,1fr))!important;
  width:100%;max-width:none;overflow-x:auto;
}
/* Shot / batch lists as manuscript entries */
.h3d-fl2v-shots,.h3d-batch-list{display:flex!important;flex-direction:column!important;gap:10px!important}
.h3d-batch-card{
  width:100%!important;display:flex!important;flex-direction:column!important;
  gap:10px!important;padding:12px!important;
  background:rgba(0,0,0,.2)!important;border:1px solid var(--h3d-border)!important;border-radius:0!important;
  border-left:3px solid var(--h3d-accent)!important;
  grid-template-columns:none!important;grid-template-rows:none!important;
  overflow:visible!important;
}
.h3d-batch-card.h3d-batch-r2v .h3d-batch-r2v-imgs,
.h3d-batch-card.h3d-batch-r2v .h3d-batch-r2v-av,
.h3d-batch-card.h3d-batch-r2v .h3d-batch-prompts,
.h3d-batch-card.h3d-batch-r2v .h3d-batch-preview{
  grid-column:auto!important;grid-row:auto!important;
  position:relative!important;width:100%!important;
  flex:0 0 auto!important;height:auto!important;max-height:none!important;
}
.h3d-batch-card.h3d-batch-r2v .h3d-batch-audio,
.h3d-batch-card.h3d-batch-r2v .h3d-batch-video{
  height:auto!important;min-height:48px!important;flex:none!important;
}
.h3d-batch-card.h3d-batch-r2v .h3d-batch-prompts textarea{
  height:auto!important;min-height:120px!important;
}
.h3d-fl2v-shot{
  width:100%!important;display:flex!important;flex-direction:column!important;
  gap:10px!important;padding:12px 14px!important;
  background:rgba(0,0,0,.2)!important;border:1px solid var(--h3d-border)!important;border-radius:0!important;
  border-left:3px solid var(--h3d-accent)!important;
}
.h3d-fl2v-shot.selected,.h3d-batch-card.selected{
  background:rgba(224,161,90,.08)!important;box-shadow:none!important;
}
.h3d-fl2v-shot-body{
  display:grid!important;grid-template-columns:minmax(0,1fr) minmax(132px,168px)!important;
  gap:12px 14px!important;align-items:stretch;
}
.h3d-fl2v-slots{display:grid!important;grid-template-columns:1fr 1fr!important;gap:12px!important;min-width:0}
.h3d-fl2v-slot{aspect-ratio:16/9;min-height:110px;max-height:168px}
.h3d-fl2v-slot img{width:100%;height:100%;object-fit:cover}
@media(max-width:720px){
  .h3d-fl2v-shot-body{grid-template-columns:1fr!important}
}
.h3d-run-status{
  margin-top:8px;padding:12px;border:1px solid var(--h3d-border);
  background:rgba(0,0,0,.22);border-radius:0;
}
.h3d-run-bar{height:4px;background:var(--h3d-track);border-radius:0;overflow:hidden}
.h3d-run-bar-fill{height:100%;background:var(--h3d-accent)}
/* Kill old side-by-side NLE shell when binder present */
.h3d-binder .h3d-workbench.h3d-shell-v2:not(.h3d-shell-binder){display:block!important}
.h3d-binder .h3d-studio-desk-head .h3d-meta{display:none}
/* Scrollbars */
.h3d-wrap ::-webkit-scrollbar{width:8px;height:8px}
.h3d-wrap ::-webkit-scrollbar-thumb{background:var(--h3d-border)}
.h3d-wrap ::-webkit-scrollbar-track{background:transparent}
`;

export function ensureH3dTheme() {
    if (typeof document === "undefined") return;
    let el = document.getElementById(H3D_THEME_ID);
    if (!el) {
        el = document.createElement("style");
        el.id = H3D_THEME_ID;
        document.head.appendChild(el);
    }
    el.textContent = THEME_CSS;
}

export default { ensureH3dTheme, H3D_PAINT, H3D_THEME_ID };
