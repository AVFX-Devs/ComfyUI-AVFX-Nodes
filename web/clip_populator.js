import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PANEL_ID = "obvpm-song-mode-panel";
const TOGGLE_ID = "obvpm-song-toggle-btn";
const RUN_ID = "obvpm-song-run-btn";
const LEN_ID = "obvpm-song-len";
const STATUS_ID = "obvpm-song-status";
const MOVIE_PANEL_ID = "obvpm-movie-mode-panel";
const MOVIE_TOGGLE_ID = "obvpm-movie-toggle-btn";
const MOVIE_RUN_ID = "obvpm-movie-run-btn";
const MOVIE_STATUS_ID = "obvpm-movie-status";
const DEFAULT_SEED = 42;
const GROUPS_PANEL_ID = "obvpm-groups-panel";
const GROUPS_TOGGLE_ID = "obvpm-groups-toggle-btn";
const GROUPS_LIST_ID = "obvpm-groups-list";
const GROUPS_FILTER_ID = "obvpm-groups-filter";
const HUNT_PANEL_ID = "obvpm-hunt-panel";
const HUNT_TOGGLE_ID = "obvpm-hunt-toggle-btn";
const CLEAR_TOGGLE_ID = "obvpm-clear-toggle-btn";
const GO_TOGGLE_ID = "obvpm-go-toggle-btn";

// ---------------------------------------------------------------------------
// node defaults (working version)
// ---------------------------------------------------------------------------
function lockPopulatorDefaults(node) {
    if (!node || node.comfyClass !== "AVFX_AutoClipPopulator" || !Array.isArray(node.widgets)) return;
    const durW = node.widgets.find(w => w.name === "clip_duration");
    const seedW = node.widgets.find(w => w.name === "base_seed");
    const ovlW = node.widgets.find(w => w.name === "overlap_frames");
    const repW = node.widgets.find(w => w.name === "replace_existing_plans");

    if (durW && (durW.value === 39 || durW.value === 1000 || Number(durW.value) <= 0)) durW.value = 15.0;
    if (seedW && (seedW.value === 1 || seedW.value === 39)) seedW.value = 1000;
    if (ovlW && (ovlW.value === 0 || ovlW.value === 1)) ovlW.value = 39;
    if (repW && typeof repW.value !== "boolean") repW.value = true;
}

// ---------------------------------------------------------------------------
// reading prompts (working version + Pause Text state fallback)
// ---------------------------------------------------------------------------
function extractTextFromNode(originNode) {
    if (!originNode) return "";
    if (Array.isArray(originNode.widgets)) {
        for (const w of originNode.widgets) {
            if (w.inputEl && typeof w.inputEl.value === "string" && w.inputEl.value.trim()) return w.inputEl.value;
            if (w.element) {
                const ta = w.element.tagName === "TEXTAREA" ? w.element : w.element.querySelector?.("textarea");
                if (ta && typeof ta.value === "string" && ta.value.trim()) return ta.value;
            }
            if (typeof w.value === "string" && w.value.trim().length > 10) return w.value;
        }
    }
    const cachedOut = app.nodeOutputs?.[String(originNode.id)] || app.nodeOutputs?.[originNode.id];
    if (cachedOut) {
        for (const val of Object.values(cachedOut)) {
            if (Array.isArray(val)) {
                const joined = val.flat().filter(v => typeof v === "string" && v.trim()).join("\n---\n");
                if (joined.trim()) return joined;
            } else if (typeof val === "string" && val.trim()) return val;
        }
    }
    const st = originNode.properties?.pauseTextState;   // Pixaroma Pause Text
    if (st) {
        if (typeof st.text === "string" && st.text.trim().length > 10) return st.text;
        if (typeof st.original === "string" && st.original.trim().length > 10) return st.original;
    }
    return "";
}

async function getPromptText(node, allowClipboard = true) {
    const inp = node?.inputs?.find(i => i.name === "packed_prompts") || node?.inputs?.[0];
    if (inp && inp.link != null) {
        const link = app.graph.links[inp.link];
        const originNode = link ? app.graph.getNodeById(link.origin_id) : null;
        const txt = extractTextFromNode(originNode);
        if (txt && txt.trim()) return txt;
    }

    const walkShadows = (root) => {
        for (const ta of root.querySelectorAll?.("textarea") || []) {
            if (ta.value && ta.value.includes("---") && ta.value.trim().length > 20) return ta.value;
        }
        for (const el of root.querySelectorAll?.("*") || []) {
            if (el.shadowRoot) {
                const found = walkShadows(el.shadowRoot);
                if (found) return found;
            }
        }
        return "";
    };
    const domText = walkShadows(document);
    if (domText) return domText;

    if (allowClipboard) {
        try {
            const clipText = await navigator.clipboard.readText();
            if (clipText && clipText.trim()) return clipText;
        } catch (_) {}
    }
    return "";
}

function findPopulatorNode() {
    return (app.graph?._nodes || []).find(n => n.comfyClass === "AVFX_AutoClipPopulator") || null;
}

// prompts for the Song panel (no clipboard prompt; empty is fine, the server writes default lip-sync prompts)
async function getPromptsForSong() {
    const pop = findPopulatorNode();
    if (pop) {
        const t = await getPromptText(pop, false);
        if (t && t.trim()) return t;
    }
    for (const n of app.graph?._nodes || []) {
        if (n.type === "PixaromaPauseText" || n.comfyClass === "PixaromaPauseText") {
            const t = extractTextFromNode(n);
            if (t && t.includes("---")) return t;
        }
    }
    return "";
}

// ---------------------------------------------------------------------------
// timeline node access
// ---------------------------------------------------------------------------
function findTimelineNode() {
    for (const n of app.graph?._nodes || []) {
        const cls = String(n.comfyClass || n.type || "");
        if (cls === "H3Timeline" || String(n.title || "").includes("H3 MCtx Timeline")) return n;
    }
    return null;
}

function getWidgetValue(node, name, fallback = "") {
    if (!node) return fallback;
    const w = node.widgets?.find((x) => x.name === name);
    if (w && w.value !== undefined && w.value !== null) return w.value;
    if (node.widgets_values_named && node.widgets_values_named[name] !== undefined) return node.widgets_values_named[name];
    return fallback;
}

function setWidgetValue(node, name, val) {
    if (!node) return;
    const w = node.widgets?.find((x) => x.name === name);
    if (w) {
        w.value = val;
        if (typeof w.callback === "function") {
            try { w.callback(val); } catch (_) {}
        }
    }
    if (node.widgets_values_named) node.widgets_values_named[name] = val;
}

function readTimeline(tlNode) {
    const raw = getWidgetValue(tlNode, "sequence", "");
    let obj = {};
    if (typeof raw === "string" && raw.trim().startsWith("{")) {
        try { obj = JSON.parse(raw); } catch (_) {}
    }
    const folder = String(getWidgetValue(tlNode, "base_folder", "")).trim() || obj.project?.folder || "Facial_city";
    return { raw: typeof raw === "string" ? raw : "", obj, folder, timeline: obj.project?.timeline || "" };
}

function applySequenceToTimeline(tlNode, sequence, clipDur) {
    if (!tlNode || !sequence) return;
    if (clipDur) setWidgetValue(tlNode, "duration_seconds", clipDur);
    setWidgetValue(tlNode, "sequence", sequence);
    if (Array.isArray(tlNode.widgets_values) && tlNode.widgets_values.length > 1) tlNode.widgets_values[1] = sequence;
    if (tlNode.widgets_values_named && typeof tlNode.widgets_values_named === "object") {
        tlNode.widgets_values_named["sequence"] = sequence;
    }
    tlNode.setDirtyCanvas?.(true, true);
    app.graph.setDirtyCanvas(true, true);
}

function syncFirstPromptIntoRef2vaNode(firstPrompt) {
    if (!firstPrompt) return;
    const inputNode = app.graph._nodes.find(n => String(n.id) === "761" || n.title === "H3 REF2VA Input");
    if (!inputNode) return;
    const valW = inputNode.widgets?.find(w => w.name === "value" || w.name === "prompt");
    if (valW) {
        valW.value = firstPrompt;
        if (typeof valW.callback === "function") valW.callback(firstPrompt);
    }
    inputNode.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------------------
// song length detection: manual box > timeline data > page text
// ---------------------------------------------------------------------------
const AUDIO_FILE_RE = /\.(mp3|wav|flac|m4a|aac|ogg|opus)\b/i;
const SKIP_KEYS = new Set(["plans", "next_draft", "nodes", "values", "modes"]);
const LEN_KEYS = ["use", "use_seconds", "exact", "exact_seconds", "dur", "duration", "length", "seconds", "sec"];

function songSecondsFromSeq(seq) {
    if (!seq || typeof seq !== "object") return 0;
    const fps = Number(seq.fps) || 24;
    let best = 0;
    const num = (o, keys) => {
        for (const k of keys) {
            const v = Number(o[k]);
            if (Number.isFinite(v) && v > 0) return v;
        }
        return 0;
    };
    const visit = (o, inAudio) => {
        if (Array.isArray(o)) { o.forEach(x => visit(x, inAudio)); return; }
        if (!o || typeof o !== "object") return;
        const isAudio = inAudio || o.kind === "audio" || /^A\d/.test(String(o.id || ""));
        const hasFile = Object.values(o).some(v => typeof v === "string" && AUDIO_FILE_RE.test(v));
        if (isAudio || hasFile) {
            let d = num(o, LEN_KEYS);
            if (!d) d = num(o, ["frames"]) / fps;
            if (d) best = Math.max(best, (Number(o.at ?? o.start ?? 0) || 0) + d);
        }
        for (const [k, v] of Object.entries(o)) {
            if (!SKIP_KEYS.has(k)) visit(v, isAudio);
        }
    };
    visit(seq, false);
    return best;
}

let seqCache = { raw: null, sec: 0 };
function songSecondsFromRaw(raw, obj) {
    if (raw && raw === seqCache.raw) return seqCache.sec;
    const sec = songSecondsFromSeq(obj);
    seqCache = { raw, sec };
    return sec;
}

function findAllRoots(root = document, out = []) {
    out.push(root);
    for (const el of root.querySelectorAll ? root.querySelectorAll("*") : []) {
        if (el.shadowRoot) findAllRoots(el.shadowRoot, out);
    }
    return out;
}

// "exact 133.17s" badge on the A1 clip, or the "use [133.17] s" box
function detectSongSecondsFromDOM() {
    for (const r of findAllRoots()) {
        for (const el of r.querySelectorAll ? r.querySelectorAll("*") : []) {
            if (el.children.length === 0 && (el.textContent || "").trim().toLowerCase() === "exact") {
                const sib = el.nextElementSibling;
                let m = sib && /(\d+(?:\.\d+)?)\s*s\b/i.exec(sib.textContent || "");
                if (!m && el.parentElement) m = /exact\s*(\d+(?:\.\d+)?)\s*s\b/i.exec(el.parentElement.textContent || "");
                if (m) return parseFloat(m[1]);
            }
        }
        for (const inp of r.querySelectorAll ? r.querySelectorAll("input") : []) {
            if (inp.closest?.("#" + PANEL_ID) || inp.closest?.("#" + MOVIE_PANEL_ID) || inp.closest?.("#" + GROUPS_PANEL_ID) || inp.closest?.("#" + HUNT_PANEL_ID)) continue;
            const val = parseFloat(inp.value);
            const pt = (inp.parentElement?.textContent || "").toLowerCase();
            if (!isNaN(val) && val > 1 && /\buse\b/.test(pt) && /\bs\b/.test(pt)) return val;
        }
    }
    return 0;
}

let domCache = { t: 0, sec: 0 };
function getSongSeconds(tlNode, { forceDom = false } = {}) {
    const manual = parseFloat(ui?.panel?.querySelector("#" + LEN_ID)?.value || "");
    if (manual > 0.5) return { sec: manual, source: "typed" };

    const tl = readTimeline(tlNode);
    const fromSeq = songSecondsFromRaw(tl.raw, tl.obj);
    if (fromSeq > 0.5) return { sec: fromSeq, source: "timeline" };

    const now = Date.now();
    if (forceDom || now - domCache.t > 5000) {
        domCache = { t: now, sec: detectSongSecondsFromDOM() };
    }
    if (domCache.sec > 0.5) return { sec: domCache.sec, source: "page" };
    return { sec: 0, source: "none" };
}

function formatMMSS(sec) {
    if (!sec || sec <= 0) return "";
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// populate (shared by the node button, the run event and the Song panel)
// ---------------------------------------------------------------------------
function describeResult(data) {
    let msg;
    if (data.song_mode) {
        msg = `Populated ${data.count} clips across the ${data.song_seconds}s song (${data.overlap_frames}f overlap, last clip ${data.last_clip_frames}f).`;
        if (data.prompts_total > 0 && data.prompts_total < data.count) {
            msg += ` Only ${data.prompts_total} prompt${data.prompts_total === 1 ? "" : "s"} found, the other clips use a default lip-sync prompt.`;
        } else if (data.prompts_total > data.count) {
            msg += ` ${data.prompts_total - data.count} extra prompts were not used (song is shorter).`;
        }
    } else {
        msg = `Populated ${data.count} planned clips into H3Timeline (target: ${data.prompt_target}).`;
    }
    return msg;
}

async function runTimelinePopulation(params) {
    const tlNode = findTimelineNode();
    if (!tlNode) return { ok: false, message: "H3Timeline node was not found in this workflow." };

    const tl = readTimeline(tlNode);
    let songSec = Number(params.song_seconds) || 0;
    if (!songSec && !params.force_plain) songSec = getSongSeconds(tlNode, { forceDom: true }).sec;

    const resp = await api.fetchApi("/avfx/clip_populator/build_timeline_plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            packed_prompts: params.packed_prompts || "",
            existing_sequence: tl.raw || "{}",
            base_folder: tl.folder,
            timeline_name: tl.timeline,
            duration: params.duration ?? 15.0,
            base_seed: params.base_seed ?? DEFAULT_SEED,
            overlap_window: String(params.overlap_window ?? "39"),
            replace_existing_plans: params.replace_existing_plans ?? true,
            song_seconds: songSec,
            require_song: !!params.require_song,
            force_plain: !!params.force_plain,
        }),
    });

    const data = await resp.json();
    if (data.status !== "ok") {
        return { ok: false, message: data.message || "Unknown error" };
    }
    applySequenceToTimeline(tlNode, data.sequence, params.duration ?? 15.0);
    syncFirstPromptIntoRef2vaNode(data.first_prompt);
    return { ok: true, data, message: describeResult(data) };
}

// ---------------------------------------------------------------------------
// Song panel (next to "+ add" on the timeline)
// ---------------------------------------------------------------------------
let ui = null;                 // { songBtn, panel, movieBtn, moviePanel, groupsBtn, groupsPanel, huntBtn, huntPanel }
let openWhich = null;          // "song" | "movie" | "groups" | "hunt" | null: only one panel is open at a time
let lastStatus = { text: "", color: "#9ca3af" };

function setStatus(text, color) {
    lastStatus = { text, color };
    const el = ui?.panel?.querySelector("#" + STATUS_ID);
    if (el) { el.textContent = text; el.style.color = color; }
}

// look of the native timeline buttons (quick / full / + add), copied at startup so the idle buttons match them
let nativeLook = null;
function offLook() {
    return nativeLook || { bg: "#1f1f24", fg: "#ffffff", border: "#444" };
}

function applyPanelState() {
    if (ui?.panel) ui.panel.style.display = openWhich === "song" ? "flex" : "none";
    if (ui?.moviePanel) ui.moviePanel.style.display = openWhich === "movie" ? "flex" : "none";
    if (ui?.groupsPanel) ui.groupsPanel.style.display = openWhich === "groups" ? "flex" : "none";
    if (ui?.huntPanel) ui.huntPanel.style.display = openWhich === "hunt" ? "flex" : "none";
    updateSongLabel();
    if (ui?.huntBtn) {
        const on = openWhich === "hunt";
        ui.huntBtn.style.background = on ? "linear-gradient(90deg,#6d28d9,#8b5cf6)" : offLook().bg;
        ui.huntBtn.style.color = on ? "#ffffff" : offLook().fg;
        ui.huntBtn.style.borderColor = on ? "#a78bfa" : offLook().border;
        ui.huntBtn.style.opacity = on ? "1" : "1";
    }
    if (ui?.groupsBtn) {
        const on = openWhich === "groups";
        ui.groupsBtn.style.background = on ? "linear-gradient(90deg,#c2410c,#ea580c)" : offLook().bg;
        ui.groupsBtn.style.color = on ? "#ffffff" : offLook().fg;
        ui.groupsBtn.style.borderColor = on ? "#fb923c" : offLook().border;
        ui.groupsBtn.style.opacity = on ? "1" : "1";
    }
    if (ui?.movieBtn) {
        const on = openWhich === "movie";
        ui.movieBtn.style.background = on ? "linear-gradient(90deg,#0e7490,#0891b2)" : offLook().bg;
        ui.movieBtn.style.color = on ? "#ffffff" : offLook().fg;
        ui.movieBtn.style.borderColor = on ? "#22d3ee" : offLook().border;
        ui.movieBtn.style.opacity = on ? "1" : "1";
    }
}

// clicking one button opens its panel and closes the other; clicking the open one closes it
function togglePanel(which = "song") {
    openWhich = openWhich === which ? null : which;
    applyPanelState();
    if (openWhich === "groups") { quietPass(); renderGroupsList(); }
    if (openWhich === "hunt") renderHuntList();
}

// the Movie/Song clip length is the master: the timeline's own "duration" box follows it
function syncClipLength(sec) {
    const v = parseFloat(sec);
    if (!(v > 0)) return;
    const tl = findTimelineNode();
    if (tl) {
        setWidgetValue(tl, "duration_seconds", v);
        tl.setDirtyCanvas?.(true, true);
    }
}

let songBusy = false;
async function runSongPopulate() {
    if (songBusy) return;
    songBusy = true;
    try {
        if (!(await ensureProjectForPopulate())) { setStatus("Not populated: choose or create a project first.", "#fbbf24"); return; }
        setStatus("Reading song length and populating clips...", "#c4b5fd");
        const tlNode = findTimelineNode();
        if (!tlNode) throw new Error("H3Timeline node was not found in this workflow.");
        if (tlNode.properties) tlNode.properties.obvpm_play_to_audio_end = true;

        const q = (id) => ui.panel.querySelector("#" + id);
        const isAdv = q("obvpm-song-mode").value === "advanced";
        const overlap = parseInt(isAdv ? q("obvpm-song-ov-custom").value : q("obvpm-song-ov-preset").value, 10);
        const { sec, source } = getSongSeconds(tlNode, { forceDom: true });
        const prompts = await getPromptsForSong();

        const res = await runTimelinePopulation({
            packed_prompts: prompts,
            duration: parseFloat(q("obvpm-song-dur").value || "15"),
            base_seed: parseInt(q("obvpm-song-seed").value || String(DEFAULT_SEED), 10),
            overlap_window: Number.isFinite(overlap) ? overlap : 39,
            replace_existing_plans: q("obvpm-song-replace").checked,
            song_seconds: sec,
            require_song: true,
        });
        if (res.ok) {
            console.log(`[obvpm] song length ${sec}s (from ${source})`);
            setStatus("OK: " + res.message, "#4ade80");
        } else {
            setStatus("Error: " + res.message, "#f87171");
        }
    } catch (err) {
        setStatus("Error: " + (err?.message || err), "#f87171");
    } finally {
        songBusy = false;
    }
}

function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = [
        `display: ${openWhich === "song" ? "flex" : "none"}`,
        "width: 100%", "padding: 8px 12px", "margin-top: 6px",
        "background: #1b1b26", "border: 1px solid #3c365c", "border-radius: 6px",
        "box-sizing: border-box", "font-size: 12px", "color: #ddd",
        "align-items: center", "gap: 10px", "flex-wrap: wrap",
    ].join(";");

    const sel = "background:#262636;color:#fff;border:1px solid #4c4670;border-radius:4px;padding:2px 6px;";
    let durOpts = "";
    for (let s = 15; s >= 5; s--) durOpts += `<option value="${s}" ${s === 15 ? "selected" : ""}>${s}s per clip</option>`;

    panel.innerHTML = `
        <span style="color:#a78bfa;font-weight:700;">🎵 Song Mode</span>
        <label>Clip Length:
            <select id="obvpm-song-dur" style="${sel}">${durOpts}</select>
        </label>
        <label>Mode:
            <select id="obvpm-song-mode" style="${sel}">
                <option value="simple" selected>Simple</option>
                <option value="advanced">Advanced</option>
            </select>
        </label>
        <span id="obvpm-song-simple-wrap">
            <label>Overlap:
                <select id="obvpm-song-ov-preset" style="${sel}">
                    <option value="39" selected>39f (1.63s Seamless)</option>
                    <option value="22">22f (0.92s Tight)</option>
                    <option value="0">0f (Hard Cuts)</option>
                </select>
            </label>
        </span>
        <span id="obvpm-song-adv-wrap" style="display:none;gap:8px;align-items:center;">
            <label>Overlap (f): <input id="obvpm-song-ov-custom" type="number" value="39" min="0" max="120" style="width:52px;${sel}"></label>
        </span>
        <label>Seed: <input id="obvpm-song-seed" type="number" value="${DEFAULT_SEED}" style="width:68px;${sel}"></label>
        <label><input id="obvpm-song-replace" type="checkbox" checked> Replace plans</label>
        <label title="Leave empty to read the length from the song on A1">Song length (s): <input id="${LEN_ID}" type="number" step="0.01" min="0" placeholder="auto" style="width:68px;${sel}"></label>
        <button id="${RUN_ID}" type="button" style="background:linear-gradient(90deg,#6d28d9,#7c3aed);color:#fff;border:none;border-radius:5px;padding:5px 12px;font-weight:700;cursor:pointer;">
            ⚡ Auto-Partition &amp; Populate Song Clips
        </button>
        <div id="${STATUS_ID}" style="width:100%;margin-top:4px;font-size:11px;color:${lastStatus.color};">${lastStatus.text}</div>
    `;

    panel.querySelector("#obvpm-song-dur").addEventListener("change", (e) => syncClipLength(e.target.value));
    const modeSel = panel.querySelector("#obvpm-song-mode");
    modeSel.addEventListener("change", () => {
        const adv = modeSel.value === "advanced";
        panel.querySelector("#obvpm-song-simple-wrap").style.display = adv ? "none" : "inline";
        panel.querySelector("#obvpm-song-adv-wrap").style.display = adv ? "inline-flex" : "none";
    });
    return panel;
}

// ---------------------------------------------------------------------------
// Movie panel: one planned clip per prompt (the node's values, on the timeline)
// ---------------------------------------------------------------------------
let movieStatus = { text: "", color: "#9ca3af" };
function setMovieStatus(text, color) {
    movieStatus = { text, color };
    const el = ui?.moviePanel?.querySelector("#" + MOVIE_STATUS_ID);
    if (el) { el.textContent = text; el.style.color = color; }
}

// prompts for the Movie panel: node input, Pause Text, any "---" text on the page, then the clipboard
async function getPromptsForMovie() {
    const pop = findPopulatorNode();
    if (pop) {
        const t = await getPromptText(pop, false);
        if (t && t.trim()) return t;
    }
    for (const n of app.graph?._nodes || []) {
        if (n.type === "PixaromaPauseText" || n.comfyClass === "PixaromaPauseText") {
            const t = extractTextFromNode(n);
            if (t && t.trim().length > 10) return t;
        }
    }
    return await getPromptText(null, true);
}

let movieBusy = false;
async function runMoviePopulate() {
    if (movieBusy) return;
    movieBusy = true;
    try {
        if (!(await ensureProjectForPopulate())) { setMovieStatus("Not populated: choose or create a project first.", "#fbbf24"); return; }
        setMovieStatus("Reading prompts and populating clips...", "#67e8f9");
        const q = (id) => ui.moviePanel.querySelector("#" + id);
        const prompts = await getPromptsForMovie();
        if (!prompts || !prompts.trim()) {
            throw new Error("No prompts found. Put your '---' separated prompts in Pause Text (or copy them), then click again.");
        }
        const dur = parseFloat(q("obvpm-movie-dur").value || "15");
        const ov = parseInt(q("obvpm-movie-ov").value, 10);
        const res = await runTimelinePopulation({
            packed_prompts: prompts,
            duration: dur,
            base_seed: parseInt(q("obvpm-movie-seed").value || String(DEFAULT_SEED), 10),
            overlap_window: Number.isFinite(ov) ? ov : 39,
            replace_existing_plans: q("obvpm-movie-replace").checked,
            force_plain: true,
        });
        if (res.ok) setMovieStatus("OK: " + res.message, "#4ade80");
        else setMovieStatus("Error: " + res.message, "#f87171");
    } catch (err) {
        setMovieStatus("Error: " + (err?.message || err), "#f87171");
    } finally {
        movieBusy = false;
    }
}

function buildMoviePanel() {
    const panel = document.createElement("div");
    panel.id = MOVIE_PANEL_ID;
    panel.style.cssText = [
        `display: ${openWhich === "movie" ? "flex" : "none"}`,
        "width: 100%", "padding: 8px 12px", "margin-top: 6px",
        "background: #16232b", "border: 1px solid #1f5a6b", "border-radius: 6px",
        "box-sizing: border-box", "font-size: 12px", "color: #ddd",
        "align-items: center", "gap: 10px", "flex-wrap: wrap",
    ].join(";");
    const sel = "background:#1f2f38;color:#fff;border:1px solid #2f6f82;border-radius:4px;padding:2px 6px;";
    let durOpts = "";
    for (let s = 15; s >= 5; s--) durOpts += `<option value="${s}" ${s === 15 ? "selected" : ""}>${s}s per clip</option>`;
    panel.innerHTML = `
        <span style="color:#22d3ee;font-weight:700;">🎬 Movie Mode</span>
        <label>Clip Length:
            <select id="obvpm-movie-dur" style="${sel}">${durOpts}</select>
        </label>
        <label>Overlap (f): <input id="obvpm-movie-ov" type="number" value="39" min="0" max="120" style="width:52px;${sel}"></label>
        <label>Seed: <input id="obvpm-movie-seed" type="number" value="${DEFAULT_SEED}" style="width:68px;${sel}"></label>
        <label><input id="obvpm-movie-replace" type="checkbox" checked> Replace plans</label>
        <button id="${MOVIE_RUN_ID}" type="button" style="background:linear-gradient(90deg,#0e7490,#0891b2);color:#fff;border:none;border-radius:5px;padding:5px 12px;font-weight:700;cursor:pointer;">
            ⚡ Populate Clips from Prompts
        </button>
        <div id="${MOVIE_STATUS_ID}" style="width:100%;margin-top:4px;font-size:11px;color:${movieStatus.color};">${movieStatus.text}</div>
    `;
    panel.querySelector("#obvpm-movie-dur").addEventListener("change", (e) => syncClipLength(e.target.value));
    return panel;
}

// ---------------------------------------------------------------------------
// Groups panel: on/off switches for the workflow's groups (mute or bypass their nodes)
// ---------------------------------------------------------------------------
const MODE_ALWAYS = 0, MODE_MUTE = 2, MODE_BYPASS = 4;
function loadGroupPref(key, def) {
    try { const v = localStorage.getItem("obvpm_groups_" + key); return v === null ? def : v; } catch (_) { return def; }
}
function saveGroupPref(key, val) {
    try { localStorage.setItem("obvpm_groups_" + key, String(val)); } catch (_) {}
}
let groupsAction = loadGroupPref("action", "bypass");          // "mute" | "bypass"
let groupsNested = loadGroupPref("nested", "0") === "1";       // also switch groups inside a group

function allGroups() {
    const gs = (app.graph?._groups || app.graph?.groups || []).filter((g) => g && g.title !== undefined);
    return gs.slice().sort((a, b) => ((a.pos?.[1] ?? a._bounding?.[1] ?? 0) - (b.pos?.[1] ?? b._bounding?.[1] ?? 0))
        || ((a.pos?.[0] ?? a._bounding?.[0] ?? 0) - (b.pos?.[0] ?? b._bounding?.[0] ?? 0)));
}
function groupBox(g) {
    const b = g._bounding || [g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.size?.[0] ?? 0, g.size?.[1] ?? 0];
    return { x: b[0], y: b[1], w: b[2], h: b[3] };
}
// where a node is DRAWN: a collapsed node (a Get/Set pill) keeps its old full size in `size`,
// so the size cannot be used for it; the frontend's own bounding rect says where it really is
function nodeRect(n) {
    const b = n.boundingRect;
    if (b && b.length >= 4 && Number.isFinite(b[2]) && Number.isFinite(b[3]) && b[2] > 0) {
        return { x: b[0], y: b[1], w: b[2], h: b[3] };
    }
    const x = n.pos?.[0] ?? 0, y = n.pos?.[1] ?? 0;
    if (n.flags?.collapsed) return { x, y: y - 30, w: n._collapsed_width || 140, h: 30 };
    return { x, y: y - 30, w: n.size?.[0] ?? 0, h: (n.size?.[1] ?? 0) + 30 };
}
function nodeInBox(n, box) {
    const r = nodeRect(n);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    return cx >= box.x && cx <= box.x + box.w && cy >= box.y && cy <= box.y + box.h;
}
// nodes whose centre is inside the group, minus (unless asked) those inside a group nested in it
function groupNodes(g) {
    const box = groupBox(g);
    const all = (app.graph?._nodes || []).filter((n) => typeof n.mode === "number");
    // what ComfyUI itself says is inside the group, plus every node drawn inside it
    const mine = new Set();
    try {
        g.recomputeInsideNodes?.();
        for (const c of g._children || g._nodes || []) {
            if (c && typeof c.mode === "number" && all.includes(c)) mine.add(c);
        }
    } catch (_) {}
    for (const n of all) if (nodeInBox(n, box)) mine.add(n);
    const nodes = all.filter((n) => mine.has(n));
    if (groupsNested) return nodes;
    const inner = allGroups().filter((o) => {
        if (o === g) return false;
        const ob = groupBox(o);
        const inside = ob.x >= box.x && ob.y >= box.y && ob.x + ob.w <= box.x + box.w && ob.y + ob.h <= box.y + box.h;
        const same = ob.x === box.x && ob.y === box.y && ob.w === box.w && ob.h === box.h;
        return inside && !same;
    }).map(groupBox);
    return nodes.filter((n) => !inner.some((ib) => nodeInBox(n, ib)));
}
function groupState(g) {
    const nodes = groupNodes(g);
    if (!nodes.length) return { state: "empty", n: 0 };
    const on = nodes.filter((n) => n.mode === MODE_ALWAYS).length;
    return { state: on === nodes.length ? "on" : on === 0 ? "off" : "mixed", n: nodes.length };
}
// Mute or Bypass for one group: its own choice (kept by group name), else the panel default
const groupKey = (g) => String(g.title ?? "");
const groupActionFor = (g) => (loadGroupPref("act:" + groupKey(g), groupsAction) === "mute" ? "mute" : "bypass");
function setGroupAction(g, act) { saveGroupPref("act:" + groupKey(g), act === "mute" ? "mute" : "bypass"); }

// What each node was before its group was switched off, kept in the workflow itself
// (graph.extra), so switching on puts back exactly that: a node that was already muted stays muted.
function groupMemory() {
    const g = app.graph;
    if (!g) return {};
    g.extra = g.extra || {};
    g.extra.obvpmGroupModes = g.extra.obvpmGroupModes || {};
    return g.extra.obvpmGroupModes;
}
// Another tool (the Pixaroma Group Switch, or by hand) may have switched a group since: a group seen
// fully on has nothing to restore, and a group that is gone or renamed keeps no memory.
function pruneGroupMemory() {
    const mem = groupMemory();
    const gs = allGroups();
    const names = new Set(gs.map(groupKey));
    for (const key of Object.keys(mem)) {
        if (!names.has(key)) delete mem[key];
    }
    for (const g of gs) {
        const key = groupKey(g);
        if (mem[key] && groupState(g).state === "on") delete mem[key];
    }
}
const MODE_WORDS = { 0: "on", 1: "on event", 2: "muted", 3: "on trigger", 4: "bypassed" };
const nodeLabel = (n) => String(n.title || n.type || n.comfyClass || ("node " + n.id));

// the arrow on a row: bring the group to the middle of the canvas (zooming out only if it is bigger than the screen)
function gotoGroup(g) {
    const c = app.canvas;
    if (!c?.ds || !g) return;
    const b = groupBox(g);
    const el = c.canvas;
    const cw = el?.clientWidth || el?.width || 1000;
    const ch = el?.clientHeight || el?.height || 700;
    let sc = c.ds.scale || 1;
    const fit = Math.min((0.9 * cw) / Math.max(1, b.w), (0.9 * ch) / Math.max(1, b.h));
    if (fit < sc) sc = Math.max(fit, 0.05);
    c.ds.scale = sc;
    c.ds.offset[0] = -(b.x + b.w / 2) + cw / (2 * sc);
    c.ds.offset[1] = -(b.y + b.h / 2) + ch / (2 * sc);
    c.setDirty?.(true, true);
    app.graph?.setDirtyCanvas?.(true, true);
}

// Shift-click: every node of the group on, whatever it was before; the group's memory is cleared
function forceGroupOn(g) {
    for (const n of groupNodes(g)) n.mode = MODE_ALWAYS;
    delete groupMemory()[groupKey(g)];
    app.graph?.change?.();
    app.graph?.setDirtyCanvas?.(true, true);
}

function setGroupOn(g, on) {
    const nodes = groupNodes(g);
    const mem = groupMemory();
    const key = groupKey(g);
    const saved = mem[key];
    if (on && saved) {
        // restore: nodes that were on come back on, the rest return to the mode they had
        for (const n of nodes) {
            const was = saved[String(n.id)];
            n.mode = was === undefined ? MODE_ALWAYS : was;
        }
        delete mem[key];
    } else if (on) {
        // nothing remembered (the group was off when the workflow opened): everything on
        for (const n of nodes) n.mode = MODE_ALWAYS;
    } else {
        // off: remember every node's mode; only the nodes that were on are switched
        // (a node already muted or bypassed is left exactly as it is)
        const off = groupActionFor(g) === "mute" ? MODE_MUTE : MODE_BYPASS;
        const snap = {};
        for (const n of nodes) {
            snap[String(n.id)] = n.mode;
            if (n.mode === MODE_ALWAYS) n.mode = off;
        }
        mem[key] = snap;
    }
    app.graph?.change?.();
    app.graph?.setDirtyCanvas?.(true, true);
}

// hover text of a row: which nodes are off, and how
function groupTip(g) {
    const nodes = groupNodes(g);
    const offs = nodes.filter((n) => n.mode !== MODE_ALWAYS);
    const hint = "(click: switch off / restore · Shift-click: all on)";
    if (!offs.length) {
        return { summary: `${nodes.length} node${nodes.length === 1 ? "" : "s"}, all on:`,
                 lines: nodes.map((n) => `• ${nodeLabel(n)}`), hint };
    }
    return { summary: `${offs.length} of ${nodes.length} nodes off:`,
             lines: offs.map((n) => `• ${nodeLabel(n)} (${MODE_WORDS[n.mode] ?? "mode " + n.mode})`), hint };
}
// a hover box in the same look as the menus: the group's full name in bold on top, then what was in the old tooltip
let tipEl = null, tipTimer = 0;
function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) { tipEl.remove(); tipEl = null; }
}
function attachGroupTip(row, g) {
    row.addEventListener("mouseover", (e) => {
        if (e.target.closest && e.target.closest("[data-obvpm-pin],[data-obvpm-go],[data-obvpm-pick]")) { hideTip(); return; }
        if (tipEl || tipTimer) return;
        tipTimer = setTimeout(() => {
            tipTimer = 0;
            const t = groupTip(g);
            const box = document.createElement("div");
            const wide = t.lines.length > 20;
            box.style.cssText = [
                "position:fixed", "z-index:100002", "pointer-events:none", "padding:10px 12px",
                `max-width:${wide ? 760 : 420}px`, "box-sizing:border-box", UI_PANEL_CSS,
            ].join(";");
            const head = document.createElement("div");
            head.textContent = String(g.title ?? "") || "(unnamed group)";
            head.style.cssText = "font-weight:700;margin-bottom:6px;word-break:break-word;";
            const sum = document.createElement("div");
            sum.textContent = t.summary;
            sum.style.cssText = "color:#aab2c3;margin-bottom:3px;";
            const body = document.createElement("div");
            body.textContent = t.lines.join("\\n");
            body.style.cssText = `white-space:pre-wrap;word-break:break-word;${wide ? "column-count:2;column-gap:18px;" : ""}`;
            const foot = document.createElement("div");
            foot.textContent = t.hint;
            foot.style.cssText = "color:#7f8798;margin-top:7px;font-size:11px;";
            box.append(head, sum, body, foot);
            document.body.appendChild(box);
            tipEl = box;
            const rr = row.getBoundingClientRect();
            const bw = box.offsetWidth, bh = box.offsetHeight;
            let left = Math.max(6, Math.min(rr.left, window.innerWidth - bw - 6));
            let top = rr.bottom + 6;
            if (top + bh > window.innerHeight - 6) top = Math.max(6, rr.top - bh - 6);
            box.style.left = left + "px";
            box.style.top = top + "px";
        }, 280);
    });
    row.addEventListener("mouseleave", hideTip);
    row.addEventListener("mousedown", hideTip);
}

// ---- Auto-quiet: a group that NEEDS something from a switched-off group is switched off too ----
// (otherwise ComfyUI complains "required input is missing" for its nodes when you queue)
let groupsQuiet = loadGroupPref("quiet", "1") === "1";
let quietNote = "";
const isSetGet = (n) => n && (n.type === "SetNode" || n.type === "GetNode"
    || /^(Set|Get)_/.test(String(n.title || "")));
const setGetKey = (n) => String(n.widgets?.[0]?.value ?? n.widgets_values?.[0] ?? String(n.title || "").replace(/^(Set|Get)_/, ""));
const graphLink = (id) => {
    const L = app.graph?.links;
    return L ? (typeof L.get === "function" ? L.get(id) : L[id]) : null;
};
// the first node along the way that is switched off, else the node that really produces what input
// `slot` of `n` receives: through Get/Set pairs and reroutes (a muted Set or Get blocks the way too)
function realOrigin(n, slot, depth = 0) {
    if (depth > 12) return null;
    const inp = n.inputs?.[slot];
    const link = inp && inp.link != null ? graphLink(inp.link) : null;
    if (!link) return null;
    const o = app.graph.getNodeById ? app.graph.getNodeById(link.origin_id) : (app.graph._nodes || []).find((x) => x.id === link.origin_id);
    if (!o) return null;
    if (o.mode !== MODE_ALWAYS) return o;
    const title = String(o.title || "");
    if (o.type === "GetNode" || /^Get_/.test(title)) {
        const key = setGetKey(o);
        const set = (app.graph._nodes || []).find((x) => x !== o && (x.type === "SetNode" || /^Set_/.test(String(x.title || ""))) && setGetKey(x) === key);
        if (!set) return null;
        if (set.mode !== MODE_ALWAYS) return set;
        return realOrigin(set, 0, depth + 1) || set;
    }
    if (o.type === "SetNode" || o.type === "Reroute") return realOrigin(o, 0, depth + 1) || o;
    return o;
}
function isRequiredInput(n, inp) {
    const req = n.constructor?.nodeData?.input?.required;
    if (req) return Object.prototype.hasOwnProperty.call(req, inp.name);
    return inp.shape !== 7;
}
// { groupTitleKey -> Set(of group keys it needs that are off) } for every group that is fully on
function groupNeeds(gs) {
    const owner = new Map();
    const state = new Map();
    for (const g of gs) {
        state.set(groupKey(g), groupState(g).state);
        for (const n of groupNodes(g)) if (!owner.has(n.id)) owner.set(n.id, g);
    }
    const needs = new Map();
    for (const g of gs) {
        const gk = groupKey(g);
        if (state.get(gk) !== "on") continue;
        for (const n of groupNodes(g)) {
            if (n.mode !== MODE_ALWAYS || isSetGet(n) || n.type === "Reroute") continue;
            (n.inputs || []).forEach((inp, i) => {
                if (!inp || inp.link == null || !isRequiredInput(n, inp)) return;
                const o = realOrigin(n, i);
                if (!o || o.mode === MODE_ALWAYS) return;
                const h = owner.get(o.id);
                if (!h || h === g) return;
                if (state.get(groupKey(h)) === "on") return;
                if (!needs.has(gk)) needs.set(gk, new Set());
                needs.get(gk).add(groupKey(h));
            });
        }
    }
    return needs;
}
function autoOffMemory() {
    const g = app.graph;
    if (!g) return {};
    g.extra = g.extra || {};
    g.extra.obvpmAutoOff = g.extra.obvpmAutoOff || {};
    return g.extra.obvpmAutoOff;
}
function quietPass() {
    if (!groupsQuiet || !app.graph) return [];
    const mem = autoOffMemory();
    const byKey = () => new Map(allGroups().map((g) => [groupKey(g), g]));
    let map = byKey();
    // 1. give back what we switched off once everything it needs is on again
    for (const k of Object.keys(mem)) {
        const g = map.get(k);
        if (!g || groupState(g).state === "on") { delete mem[k]; continue; }
        const ok = (mem[k] || []).every((hk) => { const h = map.get(hk); return !h || groupState(h).state === "on"; });
        if (ok) { setGroupOn(g, true); delete mem[k]; }
    }
    // 2. switch off every group whose needs are off (and then those that needed them)
    const done = [];
    for (let round = 0; round < 12; round++) {
        map = byKey();
        const needs = groupNeeds(allGroups());
        if (!needs.size) break;
        for (const [gk, hs] of needs) {
            const g = map.get(gk);
            if (!g) continue;
            setGroupOn(g, false);
            mem[gk] = [...hs];
            done.push({ group: String(g.title ?? ""), needs: [...hs].map((h) => String(map.get(h)?.title ?? h)) });
        }
    }
    quietNote = done.length
        ? "🧹 Auto-quiet switched off: " + done.map((d) => `${d.group} (needs ${d.needs.join(", ")})`).join("; ")
        : "";
    return done;
}
// "🔍 Check connections": every required input of a node that is on and has nothing real behind it, and why
function traceProblem(n, slot, depth = 0) {
    const groupOf = (x) => {
        const g = allGroups().find((gr) => groupNodes(gr).includes(x));
        return g ? `group “${g.title}”` : "no group";
    };
    const off = (x) => `“${nodeLabel(x)}” is ${MODE_WORDS[x.mode] || "off"} (${groupOf(x)})`;
    if (depth > 12) return "the chain of Get/Set nodes is too long";
    const inp = n.inputs?.[slot];
    if (!inp || inp.link == null) return "nothing is connected";
    const link = graphLink(inp.link);
    const o = link ? (app.graph.getNodeById ? app.graph.getNodeById(link.origin_id) : (app.graph._nodes || []).find((x) => x.id === link.origin_id)) : null;
    if (!o) return "its link points to a node that no longer exists";
    if (o.mode !== MODE_ALWAYS) return off(o);
    const title = String(o.title || "");
    if (o.type === "GetNode" || /^Get_/.test(title)) {
        const key = setGetKey(o);
        const sets = (app.graph._nodes || []).filter((x) => x !== o && (x.type === "SetNode" || /^Set_/.test(String(x.title || ""))) && setGetKey(x) === key);
        if (!sets.length) return `“${nodeLabel(o)}” reads the name “${key}” but no Set node has that name`;
        const set = sets[0];
        if (set.mode !== MODE_ALWAYS) return off(set);
        return traceProblem(set, 0, depth + 1);
    }
    if (o.type === "SetNode" || o.type === "Reroute") return traceProblem(o, 0, depth + 1);
    return null;
}
function diagnoseConnections() {
    const lines = [];
    for (const n of app.graph?._nodes || []) {
        if (n.mode !== MODE_ALWAYS || isSetGet(n) || n.type === "Reroute") continue;
        (n.inputs || []).forEach((inp, i) => {
            if (!inp || !isRequiredInput(n, inp) || inp.widget) return;
            const why = traceProblem(n, i);
            if (why) lines.push(`• ${nodeLabel(n)} · ${inp.name}: ${why}`);
        });
    }
    return lines;
}
// ---- 📌 Layouts: "when I switch THIS group on, put the other groups in the layout I saved" ----
function extraBag(name) {
    const g = app.graph;
    if (!g) return {};
    g.extra = g.extra || {};
    g.extra[name] = g.extra[name] || {};
    return g.extra[name];
}
const layoutStore = () => extraBag("obvpmLayouts");     // groupKey -> { otherKey: "on" | "off" }
const layoutBefore = () => extraBag("obvpmLayoutBefore"); // groupKey -> what the others were before it was applied
const isOnState = (h) => (groupState(h).state === "on" ? "on" : "off");
function pinLayout(g) {
    const store = layoutStore();
    const key = groupKey(g);
    if (store[key]) {
        delete store[key];
        delete layoutBefore()[key];
        return `📌 Layout of “${g.title}” cleared.`;
    }
    const snap = {};
    let on = 0, off = 0;
    for (const h of allGroups()) {
        if (h === g) continue;
        snap[groupKey(h)] = isOnState(h);
        if (snap[groupKey(h)] === "on") on++; else off++;
    }
    store[key] = snap;
    return `📌 Saved: whenever “${g.title}” is switched on, the other groups go to this layout (${on} on, ${off} off). Switching it off puts them back as they were.`;
}
function applyLayout(g) {
    const L = layoutStore()[groupKey(g)];
    if (!L) return "";
    const before = layoutBefore()[groupKey(g)] || {};
    let changed = 0;
    for (const h of allGroups()) {
        if (h === g) continue;
        const hk = groupKey(h);
        if (!(hk in L)) continue;
        const cur = isOnState(h);
        if (cur === L[hk]) continue;
        if (!(hk in before)) before[hk] = cur;
        setGroupOn(h, L[hk] === "on");
        delete autoOffMemory()[hk];
        changed++;
    }
    layoutBefore()[groupKey(g)] = before;
    return changed ? `📌 Layout of “${g.title}” applied (${changed} group${changed === 1 ? "" : "s"} changed).` : "";
}
function undoLayout(g) {
    const key = groupKey(g);
    const before = layoutBefore()[key];
    if (!before) return "";
    const map = new Map(allGroups().map((h) => [groupKey(h), h]));
    let changed = 0;
    for (const [hk, was] of Object.entries(before)) {
        const h = map.get(hk);
        if (!h || isOnState(h) === was) continue;
        setGroupOn(h, was === "on");
        delete autoOffMemory()[hk];
        changed++;
    }
    delete layoutBefore()[key];
    return changed ? `📌 The other groups are back as they were before “${g.title}” was switched on.` : "";
}
// ---- LLM / Timeline master switch: forces every group into one fixed layout, whatever it was before ----
const MASTER_MODES = {
    llm: { on: [/llm\s*generator/i, /ref\s*images/i] },
    timeline: { on: [/first\s*stage/i, /generation\s*engine/i, /timeline\s*us/i, /ref\s*images/i] },
};
function masterWants(mode, g) {
    return MASTER_MODES[mode].on.some((re) => re.test(String(g.title ?? "")));
}
function masterState() {
    const gs = allGroups().filter((g) => groupState(g).state !== "empty");
    if (!gs.length) return null;
    for (const mode of Object.keys(MASTER_MODES)) {
        if (gs.every((g) => (groupState(g).state === "on") === masterWants(mode, g))) return mode;
    }
    return null;
}
function applyMasterMode(mode) {
    if (!MASTER_MODES[mode]) return;
    for (const g of allGroups()) {
        const st = groupState(g).state;
        if (st === "empty") continue;
        if (masterWants(mode, g)) forceGroupOn(g);
        else if (st !== "off") setGroupOn(g, false);
        delete autoOffMemory()[groupKey(g)];
        delete layoutBefore()[groupKey(g)];
    }
    app.graph?.change?.();
    app.graph?.setDirtyCanvas?.(true, true);
}
function paintMasterBox() {
    const cur = masterState();
    for (const side of document.querySelectorAll("[data-obvpm-mode]")) {
        const on = side.dataset.obvpmMode === cur;
        side.style.background = on ? "linear-gradient(90deg,#84cc16,#a3e635)" : "transparent";
        side.style.color = on ? "#1a2e05" : (side.dataset.obvpmIdle || "#e5e7eb");
        side.style.fontWeight = on ? "700" : "600";
    }
}
// the same LLM | Timeline box beside "snap to latent grid", in that button row's own look
function injectTimelineMaster() {
    const snap = document.querySelector('[data-obvpm="snap-cuts"]');
    if (!snap || !snap.parentElement) return;
    const old = snap.parentElement.querySelector("[data-obvpm-master-tl]");
    if (old) return;
    const cs = getComputedStyle(snap);
    const box = document.createElement("span");
    box.setAttribute("data-obvpm-master-tl", "1");
    box.title = "Master switch: forces every group into the LLM layout or the Timeline layout, whatever it is now. You can still switch groups by hand afterwards.";
    box.style.cssText = `display:inline-flex;align-items:stretch;overflow:hidden;border:${cs.border};border-radius:${cs.borderRadius};background:#1f2229;margin:${cs.margin};height:${cs.height};box-sizing:border-box;`;
    const side = (mode, label) => {
        const el = document.createElement("span");
        el.dataset.obvpmMode = mode;
        el.dataset.obvpmIdle = cs.color || "#e5e7eb";
        el.textContent = label;
        el.style.cssText = `display:inline-flex;align-items:center;padding:0 ${cs.paddingLeft};cursor:pointer;user-select:none;font:${cs.font};`;
        return el;
    };
    const sep = document.createElement("span");
    sep.style.cssText = "width:1px;background:rgba(255,255,255,.18);";
    box.append(side("llm", "LLM"), sep, side("timeline", "Timeline"));
    snap.insertAdjacentElement("afterend", box);
    paintMasterBox();
}

function renderGroupsList() {
    queueMicrotask(() => paintMasterBox());
    const list = ui?.groupsPanel?.querySelector("#" + GROUPS_LIST_ID);
    if (!list) return;
    pruneGroupMemory();
    const noteEl = ui.groupsPanel.querySelector("#obvpm-groups-note");
    if (noteEl) { noteEl.textContent = quietNote; noteEl.style.whiteSpace = "pre-wrap"; noteEl.style.display = quietNote ? "block" : "none"; }
    const q = (ui.groupsPanel.querySelector("#" + GROUPS_FILTER_ID)?.value || "").trim().toLowerCase();
    const gs = allGroups();
    list.textContent = "";
    if (!gs.length) {
        const d = document.createElement("div");
        d.style.cssText = "color:#9ca3af;padding:4px 2px;";
        d.textContent = "No groups in this workflow.";
        list.appendChild(d);
        return;
    }
    gs.forEach((g, i) => {
        const title = String(g.title ?? "");
        if (q && !title.toLowerCase().includes(q)) return;
        const { state, n } = groupState(g);
        const row = document.createElement("div");
        row.dataset.obvpmGrp = String(i);
        attachGroupTip(row, g);
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:5px;cursor:pointer;min-width:260px;max-width:340px;flex:1 1 260px;background:#262626;";
        const sw = document.createElement("span");
        const color = state === "on" ? "#f97316" : state === "mixed" ? "#a16207" : "#4b5563";
        sw.style.cssText = `position:relative;width:34px;height:18px;border-radius:9px;flex:none;background:${color};`;
        const knob = document.createElement("span");
        const left = state === "on" ? "18px" : state === "mixed" ? "9px" : "2px";
        knob.style.cssText = `position:absolute;top:2px;left:${left};width:14px;height:14px;border-radius:50%;background:#fff;`;
        sw.appendChild(knob);
        const label = document.createElement("span");
        label.style.cssText = `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${state === "on" ? "#fff" : "#9ca3af"};`;
        label.textContent = title || "(unnamed group)";
        const meta = document.createElement("span");
        meta.style.cssText = "flex:none;color:#6b7280;font-size:10px;";
        meta.textContent = state === "mixed" ? `mixed · ${n}` : state === "empty" ? "empty" : `${n}`;
        if (autoOffMemory()[groupKey(g)]) { meta.textContent = "🧹 " + meta.textContent; meta.title = "Switched off by Auto-quiet: it needs " + autoOffMemory()[groupKey(g)].join(", "); }
        const pill = document.createElement("span");
        pill.dataset.obvpmPick = String(i);
        pill.title = "What switching this group off does: mute or bypass its nodes (click to change)";
        const mute = groupActionFor(g) === "mute";
        pill.style.cssText = `flex:none;padding:0 7px;border-radius:9px;font-size:10px;font-weight:700;cursor:pointer;border:1px solid ${mute ? "#b91c1c" : "#1d4ed8"};color:${mute ? "#fca5a5" : "#93c5fd"};`;
        pill.textContent = mute ? "Mute" : "Bypass";
        const go = document.createElement("span");
        go.dataset.obvpmGo = String(i);
        go.title = "Go to this group on the canvas";
        go.style.cssText = "flex:none;padding:0 5px;border-radius:4px;font-size:13px;line-height:16px;cursor:pointer;color:#fb923c;border:1px solid #7c3a12;";
        go.textContent = "\u279c";
        const pin = document.createElement("span");
        pin.dataset.obvpmPin = String(i);
        const pinned = !!layoutStore()[groupKey(g)];
        pin.title = pinned
            ? "A layout is saved for this group: whenever it is switched on, the other groups go to it. Click to clear it."
            : "Save the current on/off layout of the other groups: whenever this group is switched on, they go to it";
        pin.style.cssText = `flex:none;padding:0 4px;border-radius:4px;font-size:12px;line-height:16px;cursor:pointer;border:1px solid ${pinned ? "#facc15" : "#4b5563"};opacity:${pinned ? "1" : "0.55"};`;
        pin.textContent = "\ud83d\udccc";
        row.append(sw, label, meta, pin, go, pill);
        list.appendChild(row);
    });
}

function buildGroupsPanel() {
    const panel = document.createElement("div");
    panel.id = GROUPS_PANEL_ID;
    panel.style.cssText = [
        `display: ${openWhich === "groups" ? "flex" : "none"}`,
        "width: 100%", "padding: 8px 12px", "margin-top: 6px",
        "background: #231a14", "border: 1px solid #7c3a12", "border-radius: 6px",
        "box-sizing: border-box", "font-size: 12px", "color: #ddd",
        "align-items: center", "gap: 10px", "flex-wrap: wrap",
    ].join(";");
    const btn = (act) => `<button type="button" data-obvpm-act="${act}" style="border:1px solid #7c3a12;border-radius:4px;padding:3px 10px;cursor:pointer;font-weight:600;"></button>`;
    panel.innerHTML = `
        <span style="color:#fb923c;font-weight:700;">🔀 Groups</span>
        <span title="Set every group below to this" style="color:#9ca3af;">Set all:</span>
        <span style="display:inline-flex;gap:4px;">${btn("mute")}${btn("bypass")}</span>
        <button type="button" data-obvpm-act="diag" title="List every required input that has nothing real behind it, and why" style="border:1px solid #7c3a12;border-radius:4px;padding:3px 10px;cursor:pointer;font-weight:600;"></button>
        <label title="Also switch the nodes of groups that sit inside a group"><input id="obvpm-groups-nested" type="checkbox"> Include groups inside a group</label>
        <label title="Switch off a group when something it needs comes from a group that is off, so ComfyUI does not complain about missing connections. They come back on by themselves when what they need is on again."><input id="obvpm-groups-quiet" type="checkbox"> 🧹 Auto-quiet</label>
        <span id="obvpm-master" title="Master switch: forces every group into this layout, whatever it is now. You can still switch groups by hand afterwards." style="display:inline-flex;border:1px solid #7c3a12;border-radius:6px;overflow:hidden;background:#262626;">
            <span data-obvpm-mode="llm" style="padding:3px 12px;cursor:pointer;user-select:none;">LLM</span>
            <span style="width:1px;background:#7c3a12;"></span>
            <span data-obvpm-mode="timeline" style="padding:3px 12px;cursor:pointer;user-select:none;">Timeline</span>
        </span>
        <input id="${GROUPS_FILTER_ID}" type="text" placeholder="Filter groups..." style="width:150px;background:#262626;color:#fff;border:1px solid #7c3a12;border-radius:4px;padding:2px 6px;">
        <div id="obvpm-groups-note" style="width:100%;color:#fbbf24;font-size:11px;display:none;"></div>
        <div id="${GROUPS_LIST_ID}" style="width:100%;display:flex;flex-wrap:wrap;gap:6px;"></div>
    `;
    const labels = { mute: "Mute", bypass: "Bypass", diag: "🔍 Check connections" };
    for (const b of panel.querySelectorAll("[data-obvpm-act]")) b.textContent = labels[b.dataset.obvpmAct];
    panel.querySelector("#obvpm-groups-nested").checked = groupsNested;
    panel.querySelector("#obvpm-groups-nested").addEventListener("change", (e) => {
        groupsNested = !!e.target.checked;
        saveGroupPref("nested", groupsNested ? "1" : "0");
        renderGroupsList();
    });
    panel.querySelector("#obvpm-groups-quiet").checked = groupsQuiet;
    panel.querySelector("#obvpm-groups-quiet").addEventListener("change", (e) => {
        groupsQuiet = !!e.target.checked;
        saveGroupPref("quiet", groupsQuiet ? "1" : "0");
        if (groupsQuiet) quietPass(); else quietNote = "";
        renderGroupsList();
    });
    panel.querySelector("#" + GROUPS_FILTER_ID).addEventListener("input", renderGroupsList);
    paintGroupActions(panel);
    paintMasterBox();
    return panel;
}
function paintGroupActions(panel = ui?.groupsPanel) {
    if (!panel) return;
    for (const b of panel.querySelectorAll("[data-obvpm-act]")) {
        b.style.background = "#262626";
        b.style.color = "#e5e7eb";
    }
}

// ---------------------------------------------------------------------------
// Hunt panel: hunt any planned clip, as often as you like; a blue pill counts its batches
// ---------------------------------------------------------------------------
const PLAN_KEY = (id) => "plan:" + id;
let huntStatus = { text: "", color: "#9ca3af" };
function setHuntStatus(text, color) {
    huntStatus = { text, color };
    const el = ui?.huntPanel?.querySelector("#obvpm-hunt-status");
    if (el) { el.textContent = text; el.style.color = color; }
}

// The saved hunt batches of this project: the Result Preview asks the server for them
// (/obvpm/h3/hunt_runs); we read the same answer and can ask again with the same folder.
let huntRunsCache = { prefix: null, runs: [], at: 0 };
function hookHuntRuns() {
    if (hookHuntRuns.done) return;
    hookHuntRuns.done = true;
    const orig = api.fetchApi.bind(api);
    api.fetchApi = async function (url, opts) {
        const r = await orig(url, opts);
        try {
            if (typeof url === "string" && url.includes("/obvpm/h3/hunt_runs")) {
                const prefix = JSON.parse(opts?.body || "{}").prefix;
                r.clone().json().then((j) => {
                    huntRunsCache = { prefix, runs: Array.isArray(j?.runs) ? j.runs : [], at: Date.now() };
                }).catch(() => {});
            }
        } catch (_) {}
        return r;
    };
}
async function refreshHuntRuns() {
    if (huntRunsCache.prefix == null) return;
    if (refreshHuntRuns.busy) return;
    refreshHuntRuns.busy = true;
    try {
        const resp = await api.fetchApi("/obvpm/h3/hunt_runs", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prefix: huntRunsCache.prefix }),
        });
        if (resp.ok) {
            const j = await resp.json();
            huntRunsCache = { prefix: huntRunsCache.prefix, runs: Array.isArray(j?.runs) ? j.runs : [], at: Date.now() };
        }
    } catch (_) {} finally { refreshHuntRuns.busy = false; }
}

// the hunt batches made for plan number n, oldest first (batch 1 is the first one made)
function batchesOf(n) {
    const re = new RegExp("\\bplan " + n + "\\b");
    return (huntRunsCache.runs || [])
        .filter((r) => r?.batch && r.batch.kind === "hunt" && re.test(String(r.batch.detail || "")))
        .slice().sort((a, b) => (Number(a.mtime_ms) || 0) - (Number(b.mtime_ms) || 0));
}

// every plan of the timeline, in timeline order (made, queued or waiting alike)
function allPlanList() {
    const tl = findTimelineNode();
    if (!tl) return [];
    const doc = readTimeline(tl).obj || {};
    const plans = Array.isArray(doc.plans) ? doc.plans : [];
    const v1 = (doc.tracks || []).find((t) => t.id === "V1")?.clips || [];
    const at = new Map();
    v1.forEach((c, i) => { if (c.plan) at.set(c.plan, i); });
    const unchecked = doc.unchecked || [];
    return plans.map((p) => ({
        id: p.id, n: p.n, seed: p.seed,
        prompt: String(p.prompt || "").replace(/\s+/g, " ").trim(),
        ticked: !p.batch && !p.off_list && !unchecked.includes(PLAN_KEY(p.id)),
        isPlan: at.has(p.id),                       // still a planned clip on V1 (not turned into a made clip)
        at: at.has(p.id) ? at.get(p.id) : 1e9 + (p.n || 0),
    })).sort((a, b) => a.at - b.at);
}
const planNumById = (id) => allPlanList().find((x) => x.id === id)?.n;

function huntCountNow() {
    const v = Number(getWidgetValue(findTimelineNode(), "hunt_count", 4));
    return Number.isFinite(v) && v >= 2 ? Math.min(16, Math.round(v)) : 4;
}

// make this plan the only one that would be hunted: untick every other plan and any regen clip,
// bring the plan back to "waiting" if an earlier hunt used it, turn the hunt on
function huntSetup(planId, count) {
    const tl = findTimelineNode();
    if (!tl) throw new Error("H3Timeline node was not found in this workflow.");
    const doc = readTimeline(tl).obj;
    if (!doc || !Array.isArray(doc.plans)) throw new Error("The timeline has no planned clips.");
    const chosen = doc.plans.find((p) => p.id === planId);
    if (!chosen) throw new Error("That plan is not on the timeline any more.");
    const v1 = (doc.tracks || []).find((t) => t.id === "V1")?.clips || [];
    if (!v1.some((c) => c.plan === planId)) {
        throw new Error(`plan ${chosen.n} is already a made clip. Use the timeline's regenerate on it first.`);
    }
    const u = new Set(doc.unchecked || []);
    for (const p of doc.plans) {
        if (p.id === planId) u.delete(PLAN_KEY(p.id));
        else if (!p.batch) u.add(PLAN_KEY(p.id));
    }
    for (const c of Object.keys(doc.marks || {})) {
        if (doc.marks[c]?.length) u.add(c);
    }
    delete chosen.off_list;
    delete chosen.batch;                            // hunted before: back to waiting, so it can be hunted again
    if (u.size) doc.unchecked = [...u]; else delete doc.unchecked;
    applySequenceToTimeline(tl, JSON.stringify(doc), null);
    setWidgetValue(tl, "hunt_count", count);
    setWidgetValue(tl, "hunting", true);
    tl.setDirtyCanvas?.(true, true);
    return chosen;
}

let huntBusy = false;
let huntMenuFor = null;                              // plan id whose batch menu is open
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const huntCount = () => parseInt(ui?.huntPanel?.querySelector("#obvpm-hunt-count")?.value, 10) || 4;

async function huntClip(planId, run) {
    if (huntBusy) return;
    huntBusy = true;
    try {
        const count = huntCount();
        const chosen = huntSetup(planId, count);
        if (!run) {
            setHuntStatus(`plan ${chosen.n} is the only clip ticked, hunt ×${count} is on. Press Run (or the pill) to hunt it.`, "#4ade80");
        } else {
            setHuntStatus(`plan ${chosen.n}: hunting ×${count}...`, "#fdba74");
            await sleep(900);                         // let the timeline read the new ticks
            await app.queuePrompt(0, 1);
            setHuntStatus(`plan ${chosen.n}: hunt ×${count} queued. Its takes appear in the Result Preview.`, "#4ade80");
            setTimeout(() => { refreshHuntRuns().then(renderHuntList); }, 2500);
        }
        renderHuntList();
    } catch (err) {
        setHuntStatus("Error: " + (err?.message || err), "#f87171");
    } finally {
        huntBusy = false;
    }
}

// one click: first-stage drafts for every plan on the timeline, each on its own, one after the other.
// The timeline marks a plan as queued (its "batch") only when it has finished queueing it, so each clip is
// waited for before the next is set up (setting up the next one early undid the previous one: clips were skipped).
const planQueuedNow = (id) => !!(readTimeline(findTimelineNode()).obj.plans || []).find((q) => q.id === id)?.batch;
async function draftAll() {
    if (huntBusy) return;
    huntBusy = true;
    try {
        const count = huntCount();
        const plans = allPlanList().filter((x) => x.isPlan);
        if (!plans.length) throw new Error("No planned clips on the timeline.");
        const failed = [];
        let done = 0;
        for (const p of plans) {
            let ok = false;
            for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
                setHuntStatus(`Draft all: plan ${p.n} (${done + failed.length + 1} of ${plans.length}), ×${count} each${attempt > 1 ? `, try ${attempt}` : ""}...`, "#fdba74");
                try {
                    huntSetup(p.id, count);
                    await sleep(900);
                    await app.queuePrompt(0, 1);
                    ok = !!(await waitFor(() => planQueuedNow(p.id), 45000));
                } catch (err) {
                    if (attempt === 3) setHuntStatus(`Draft all: plan ${p.n}: ${err?.message || err}`, "#f87171");
                }
                if (!ok) await sleep(1500);
            }
            if (ok) done++; else failed.push(p.n);
            await sleep(500);
        }
        if (failed.length) {
            setHuntStatus(`Draft all: drafted ${done} of ${plans.length}. Not queued: plan ${failed.join(", plan ")}. Press Draft all again, or hunt those clips one by one.`, "#fbbf24");
        } else {
            setHuntStatus(`Draft all: drafted ${done} of ${plans.length}, ×${count} each. They run one after the other.`, "#4ade80");
        }
        setTimeout(() => { refreshHuntRuns().then(renderHuntList); }, 3000);
        renderHuntList();
    } catch (err) {
        setHuntStatus("Error: " + (err?.message || err), "#f87171");
    } finally {
        huntBusy = false;
    }
}

// show an old batch: the Result Preview's own history box (data-rp="runs") picks it
function openBatch(planId, index) {
    const n = planNumById(planId);
    const entry = batchesOf(n)[index];
    if (!entry) { setHuntStatus("That batch is not in the saved list (yet).", "#f87171"); return; }
    const boxes = Array.from(document.querySelectorAll('select[data-rp="runs"]'));
    const want = ["saved:" + entry.run, "batch:" + entry.batch?.id, entry.run];
    for (const box of boxes) {
        const opt = Array.from(box.options).find((o) => want.includes(o.value));
        if (opt) {
            box.value = opt.value;
            box.dispatchEvent(new Event("change"));
            huntMenuFor = null;
            setHuntStatus(`plan ${n}: batch ${index + 1} is open in the Result Preview.`, "#4ade80");
            renderHuntList();
            return;
        }
    }
    setHuntStatus(`plan ${n}: batch ${index + 1} was not found in the Result Preview's history box. Is a Result Preview on the canvas?`, "#f87171");
}

function huntHandle(path) {
    const d = (k) => { const el = path.find((e) => e && e.dataset && e.dataset[k] !== undefined); return el ? el.dataset[k] : undefined; };
    if (d("obvpmHall") !== undefined) { draftAll(); return; }
    const nw = d("obvpmHnew");
    if (nw !== undefined) { huntMenuFor = null; huntClip(nw, true); return; }
    const op = d("obvpmHopen");
    if (op !== undefined) { const [id, i] = op.split("|"); openBatch(id, Number(i)); return; }
    const run = d("obvpmHrun");
    if (run !== undefined) {
        if (batchesOf(planNumById(run)).length > 0) { huntMenuFor = huntMenuFor === run ? null : run; renderHuntList(); }
        else huntClip(run, true);
        return;
    }
    const sel = d("obvpmHsel");
    if (sel !== undefined) { huntMenuFor = null; huntClip(sel, false); }
}

function renderHuntList() {
    const list = ui?.huntPanel?.querySelector("#obvpm-hunt-list");
    if (!list) return;
    if (Date.now() - huntRunsCache.at > 6000) void refreshHuntRuns();
    const items = allPlanList();
    list.textContent = "";
    if (!items.length) {
        const d = document.createElement("div");
        d.style.cssText = "color:#9ca3af;padding:4px 2px;";
        d.textContent = "No planned clips on the timeline. Populate some first (Song or Movie).";
        list.appendChild(d);
        return;
    }
    for (const it of items) {
        const batches = batchesOf(it.n);
        const k = batches.length;
        const cell = document.createElement("div");
        cell.style.cssText = "display:flex;flex-direction:column;gap:3px;flex:1 1 320px;min-width:320px;max-width:520px;";
        const row = document.createElement("div");
        row.dataset.obvpmHsel = it.id;
        row.title = it.isPlan ? "Click: tick only this clip and turn the hunt on" : "Already a made clip: regenerate it on the timeline first";
        row.style.cssText = `display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:5px;cursor:pointer;background:${it.ticked ? "#3b2a12" : "#262626"};${it.isPlan ? "" : "opacity:.5;"}`;
        const num = document.createElement("span");
        num.style.cssText = "flex:none;font-weight:700;color:#fdba74;";
        const cn = it.isPlan ? clipNoOfPlan(it.id) : null;
        num.textContent = cn ? `clip ${cn} · plan ${it.n}` : `plan ${it.n}`;
        const txt = document.createElement("span");
        txt.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d1d5db;";
        txt.textContent = it.prompt || "(no prompt)";
        const seed = document.createElement("span");
        seed.style.cssText = "flex:none;color:#6b7280;font-size:10px;";
        seed.textContent = it.seed != null ? `seed ${it.seed}` : "";
        const pill = document.createElement("span");
        pill.dataset.obvpmHrun = it.id;
        pill.title = k ? `${k} batch${k === 1 ? "" : "es"} made: click for another batch or to show one` : "Tick only this clip, turn the hunt on and run it now";
        pill.style.cssText = `position:relative;flex:none;margin-right:8px;padding:0 8px;border-radius:9px;font-size:11px;font-weight:700;cursor:pointer;background:${k ? "#2563eb" : "#ea580c"};color:#fff;`;
        pill.textContent = "▶ Hunt" + (k ? " ▾" : "");
        if (k) {
            const sup = document.createElement("span");
            sup.style.cssText = "position:absolute;top:-8px;right:-9px;min-width:15px;height:15px;line-height:15px;padding:0 3px;border-radius:8px;font-size:10px;font-weight:700;text-align:center;background:#fff;color:#1d4ed8;box-sizing:border-box;";
            sup.textContent = String(k);
            pill.appendChild(sup);
        }
        row.append(num, txt, seed, pill);
        cell.appendChild(row);
        if (huntMenuFor === it.id && k) {
            const menu = document.createElement("div");
            menu.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;padding:4px 6px;background:#1e293b;border:1px solid #2563eb;border-radius:5px;";
            const mk = (attr, val, text, bg) => {
                const b = document.createElement("span");
                b.dataset[attr] = val;
                b.style.cssText = `padding:1px 9px;border-radius:9px;font-size:11px;font-weight:700;cursor:pointer;background:${bg};color:#fff;`;
                b.textContent = text;
                return b;
            };
            menu.appendChild(mk("obvpmHnew", it.id, `+ New batch (×${huntCount()})`, "#ea580c"));
            batches.forEach((b, i) => {
                const t = new Date(Number(b.mtime_ms) || 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                menu.appendChild(mk("obvpmHopen", it.id + "|" + i, `Batch ${i + 1} · ${t}`, "#2563eb"));
            });
            cell.appendChild(menu);
        }
        list.appendChild(cell);
    }
}

function buildHuntPanel() {
    const panel = document.createElement("div");
    panel.id = HUNT_PANEL_ID;
    panel.style.cssText = [
        `display: ${openWhich === "hunt" ? "flex" : "none"}`,
        "width: 100%", "padding: 8px 12px", "margin-top: 6px",
        "background: #1f1a24", "border: 1px solid #6b3fa0", "border-radius: 6px",
        "box-sizing: border-box", "font-size: 12px", "color: #ddd",
        "align-items: center", "gap: 10px", "flex-wrap: wrap",
    ].join(";");
    const sel = "background:#2a2433;color:#fff;border:1px solid #6b3fa0;border-radius:4px;padding:2px 6px;";
    let opts = "";
    const cur = huntCountNow();
    for (let n = 2; n <= 16; n++) opts += `<option value="${n}" ${n === cur ? "selected" : ""}>×${n}</option>`;
    panel.innerHTML = `
        <span style="color:#c4b5fd;font-weight:700;">🎯 Hunt a clip</span>
        <label>Takes: <select id="obvpm-hunt-count" style="${sel}">${opts}</select></label>
        <button type="button" data-obvpm-hall="1" style="background:linear-gradient(90deg,#6d28d9,#8b5cf6);color:#fff;border:none;border-radius:5px;padding:4px 12px;font-weight:700;cursor:pointer;">⚡ Draft all clips</button>
        <span style="color:#9ca3af;">Orange pill: hunt that clip. Blue pill (number = batches made): another batch, or show one.</span>
        <div id="obvpm-hunt-list" style="width:100%;display:flex;flex-wrap:wrap;gap:6px;"></div>
        <div id="obvpm-hunt-status" style="width:100%;font-size:11px;color:${huntStatus.color};">${huntStatus.text}</div>
    `;
    return panel;
}

// ---------------------------------------------------------------------------
// Teleport (jump the canvas to a group) and Clear (remove clips in one go)
// ---------------------------------------------------------------------------
let popupEl = null;
let popupCloser = null;
let popupOnClose = null;
function closePopup() {
    const cb = popupOnClose;
    popupOnClose = null;
    if (popupEl) { popupEl.remove(); popupEl = null; }
    if (popupCloser) { document.removeEventListener("mousedown", popupCloser, true); popupCloser = null; }
    try { cb?.(); } catch (_) {}
}
// a small menu under a toolbar button; `items`: [{ text, color, keep, onClick }]
const UI_PANEL_CSS = [
    "background:linear-gradient(160deg,#2a2f3b 0%,#1c1f27 58%,#181a21 100%)",
    "border:1px solid rgba(255,255,255,.11)", "border-radius:12px", "color:#e8eaf0",
    "box-shadow:0 14px 36px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.35)", "font:12px/1.35 sans-serif",
].join(";");
function showPopup(anchor, items, title, onClose = null) {
    closePopup();
    hideTip();
    popupOnClose = onClose;
    const pop = document.createElement("div");
    const r = anchor.getBoundingClientRect();
    pop.style.cssText = [
        "position:fixed", `left:${Math.max(6, Math.round(r.left))}px`, `top:${Math.round(r.bottom + 6)}px`,
        "z-index:100000", "min-width:240px", "max-width:520px", "max-height:60vh", "overflow:auto", "padding:6px",
        UI_PANEL_CSS, "opacity:0", "transform:translateY(-4px)", "transition:opacity .14s ease,transform .14s ease",
    ].join(";");
    if (title) {
        const h = document.createElement("div");
        h.style.cssText = "padding:5px 10px 7px;color:#aab2c3;font-size:11px;font-weight:600;letter-spacing:.2px;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:4px;";
        h.textContent = title;
        pop.appendChild(h);
    }
    for (const it of items) {
        const row = document.createElement("div");
        row.textContent = it.text;
        row.title = it.text;
        const sep = it.divider ? "border-top:1px solid rgba(255,255,255,.08);margin-top:4px;padding-top:9px;" : "";
        row.style.cssText = `padding:7px 10px;border-radius:8px;cursor:pointer;color:${it.color || "#e8eaf0"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .1s;${sep}`;
        row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,.09)"; });
        row.addEventListener("mouseleave", () => { row.style.background = "transparent"; });
        row.addEventListener("click", (e) => {
            e.stopPropagation();
            const keep = it.onClick?.(row, pop, e);
            if (!keep) closePopup();
        });
        pop.appendChild(row);
    }
    document.body.appendChild(pop);
    popupEl = pop;
    requestAnimationFrame(() => { pop.style.opacity = "1"; pop.style.transform = "translateY(0)"; });
    popupCloser = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopup(); };
    setTimeout(() => { if (popupEl === pop) document.addEventListener("mousedown", popupCloser, true); }, 0);
}

// ---- Teleport ---------------------------------------------------------------------
function gotoNodeRect(n) {
    const r = nodeRect(n);
    gotoGroup({ _bounding: [r.x, r.y, r.w, r.h] });
}
// the timeline's own group (the smallest group holding the H3Timeline node), else the node itself
function gotoTimeline() {
    const tl = findTimelineNode();
    if (!tl) { alert("H3Timeline node was not found in this workflow."); return; }
    const holding = allGroups().filter((g) => nodeInBox(tl, groupBox(g)))
        .sort((a, b) => (groupBox(a).w * groupBox(a).h) - (groupBox(b).w * groupBox(b).h));
    if (holding.length) gotoGroup(holding[0]);
    else gotoNodeRect(tl);
}
function openGoMenu(anchor) {
    const gs = allGroups();
    if (!gs.length) { showPopup(anchor, [{ text: "No groups in this workflow" }]); return; }
    showPopup(anchor, gs.map((g) => ({ text: String(g.title || "(unnamed group)"), onClick: () => { gotoGroup(g); } })),
        "Go to group:");
}

// ---- Clear clips --------------------------------------------------------------------
function clipCounts() {
    const tl = findTimelineNode();
    const doc = tl ? readTimeline(tl).obj || {} : {};
    const v1 = (doc.tracks || []).find((t) => t.id === "V1")?.clips || [];
    return { planned: v1.filter((c) => c.plan).length, total: v1.filter((c) => c.gap == null).length };
}
function clearClips(kind) {
    const tl = findTimelineNode();
    if (!tl) throw new Error("H3Timeline node was not found.");
    const doc = readTimeline(tl).obj;
    const v1t = (doc.tracks || []).find((t) => t.id === "V1");
    if (!v1t) throw new Error("The timeline has no V1 track.");
    const before = (v1t.clips || []).filter((c) => c.gap == null).length;
    if (kind === "all") {
        v1t.clips = [];
        doc.marks = {};
    } else {
        v1t.clips = (v1t.clips || []).filter((c) => !c.plan);
        // empty space left at the end goes too
        while (v1t.clips.length && v1t.clips[v1t.clips.length - 1].gap != null) v1t.clips.pop();
    }
    doc.plans = kind === "all" ? [] : (doc.plans || []).filter((p) => (v1t.clips || []).some((c) => c.plan === p.id));
    delete doc.unchecked;
    applySequenceToTimeline(tl, JSON.stringify(doc), null);
    const after = v1t.clips.filter((c) => c.gap == null).length;
    return before - after;
}
// ---- erase a timeline's files / a whole project folder (on disk, for good) ----
function fmtBytes(b) {
    if (b < 1024) return b + " B";
    const u = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
    return b.toFixed(b >= 100 ? 0 : 1) + " " + u[i];
}
function projectPointer() {
    const tl = findTimelineNode();
    const pr = tl ? readTimeline(tl).obj?.project : null;
    return pr && pr.folder ? { folder: String(pr.folder), timeline: String(pr.timeline || "") } : null;
}
async function folderPost(path, body) {
    const resp = await api.fetchApi(path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const out = await resp.json().catch(() => ({}));
    if (!resp.ok || out.error) throw new Error(out.error || ("HTTP " + resp.status));
    return out;
}
// a project that was erased is no longer this timeline's home: the timeline stays in the workflow
function detachProjectPointer() {
    const tl = findTimelineNode();
    if (!tl) return;
    const doc = readTimeline(tl).obj;
    if (!doc || !doc.project) return;
    delete doc.project;
    applySequenceToTimeline(tl, JSON.stringify(doc), null);
}
// ---- Save this timeline as a new project ------------------------------------------------------
// a small window in the menus' look: lines of text, an optional text box, and buttons -> {key, value}
function uiModal({ title, lines = [], input = null, buttons = [] }) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
        const box = document.createElement("div");
        box.style.cssText = "width:min(560px,92vw);max-height:88vh;overflow:auto;display:flex;flex-direction:column;gap:9px;padding:16px;" + UI_PANEL_CSS;
        const head = document.createElement("div");
        head.textContent = title;
        head.style.cssText = "font-weight:700;font-size:14px;";
        box.appendChild(head);
        for (const ln of lines) {
            const d = document.createElement("div");
            d.textContent = ln;
            d.style.cssText = "color:#c7ccd8;white-space:pre-wrap;word-break:break-word;";
            box.appendChild(d);
        }
        let field = null;
        if (input) {
            field = document.createElement("input");
            field.type = "text";
            field.value = input.value || "";
            field.placeholder = input.placeholder || "";
            field.style.cssText = "width:100%;box-sizing:border-box;background:#14161a;color:#f3f4f6;border:1px solid #4b5563;border-radius:6px;padding:7px 9px;font:13px sans-serif;outline:none;";
            box.appendChild(field);
        }
        const foot = document.createElement("div");
        foot.style.cssText = "display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:4px;";
        let done = false;
        const finish = (key) => { if (done) return; done = true; document.removeEventListener("keydown", onKey, true); overlay.remove(); resolve({ key, value: field ? field.value : "" }); };
        const onKey = (e) => {
            if (e.key === "Escape") { e.stopPropagation(); finish("cancel"); }
            else if (e.key === "Enter" && field && document.activeElement === field) { e.stopPropagation(); finish(buttons.find((b) => b.primary)?.key || "ok"); }
        };
        for (const b of buttons) {
            const el = document.createElement("button");
            el.type = "button";
            el.textContent = b.label;
            const bg = b.primary ? "linear-gradient(90deg,#4d7c0f,#65a30d)" : b.danger ? "#7f1d1d" : "#2d3340";
            el.style.cssText = `cursor:pointer;border-radius:6px;padding:6px 14px;font:12px sans-serif;border:1px solid rgba(255,255,255,.14);background:${bg};color:#fff;`;
            el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); finish(b.key); });
            foot.appendChild(el);
        }
        box.appendChild(foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        document.addEventListener("keydown", onKey, true);
        (field || foot.querySelector("button"))?.focus();
        field?.select();
    });
}
function uiProgress(title) {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText = "width:min(480px,92vw);display:flex;flex-direction:column;gap:9px;padding:16px;" + UI_PANEL_CSS;
    const head = document.createElement("div");
    head.textContent = title;
    head.style.cssText = "font-weight:700;font-size:14px;";
    const line = document.createElement("div");
    line.style.cssText = "color:#c7ccd8;word-break:break-all;";
    const track = document.createElement("div");
    track.style.cssText = "height:8px;border-radius:4px;background:rgba(255,255,255,.12);overflow:hidden;";
    const bar = document.createElement("div");
    bar.style.cssText = "height:100%;width:0%;background:linear-gradient(90deg,#84cc16,#a3e635);transition:width .15s;";
    track.appendChild(bar);
    box.append(head, line, track);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return {
        set(text, frac) { line.textContent = text; if (frac != null) bar.style.width = Math.max(0, Math.min(100, frac * 100)) + "%"; },
        close() { overlay.remove(); },
    };
}
// opens a project through the timeline's own "project" window, so the timeline does all of the switching itself
const PROJECTS_ROOT = "obvpm_projects";
let saveAsBypass = false;
async function openProjectViaPackDialog(folder) {
    const btn = document.querySelector('[data-obvpm="project-save-as"], [data-obvpm="project-btn"]');
    if (!btn) throw new Error("the timeline's project button was not found");
    saveAsBypass = true;
    try { btn.click(); } finally { saveAsBypass = false; }
    const input = await waitFor(() => document.querySelector('input[data-obvpm="project-folder"]'), 6000);
    if (!input) throw new Error("the timeline's project window did not open");
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, folder); else input.value = folder;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const go = await waitFor(() => {
        const g = document.querySelector('[data-obvpm="project-go"]');
        return g && !g.disabled && g.style.display !== "none" && /open/i.test(g.textContent) ? g : null;
    }, 9000, 200);
    if (!go) throw new Error("the timeline did not offer to open the new project");
    go.click();
    // "Replace this timeline?": yes, the project holds this very timeline
    const rep = await waitFor(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Replace it"), 3000, 150);
    if (rep) rep.click();
    return !!(await waitFor(() => projectPointer()?.folder === folder, 20000, 250));
}

// the timeline's own "save as project" button: a click asks which kind of save, and the timeline's own way stays one choice
function bindSaveAsButton() {
    if (window.__obvpmSaveAsBound) return;
    window.__obvpmSaveAsBound = true;
    window.addEventListener("click", (e) => {
        if (saveAsBypass) return;
        const path = e.composedPath ? e.composedPath() : [];
        const btn = path.find((el) => el && el.dataset && el.dataset.obvpm === "project-save-as");
        if (!btn) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        showPopup(btn, [
            { text: "📁 Save as project in the clips' own folder", onClick: () => { saveAsBypass = true; try { btn.click(); } finally { saveAsBypass = false; } } },
            { text: "💾 Save into a NEW project folder… (copies the clips there, then removes the originals)", onClick: () => { setTimeout(() => void saveAsNewProject(), 0); } },
        ], "Save this timeline as a project");
    }, true);
}
// ---- Populate needs a project: on an empty timeline, ask where the new clips go --------------------
// a list window: pick one row -> its key, or null (cancel / Esc)
function uiPick({ title, lines = [], options, cancelLabel = "Cancel" }) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
        const box = document.createElement("div");
        box.style.cssText = "width:min(560px,92vw);max-height:88vh;display:flex;flex-direction:column;gap:9px;padding:16px;" + UI_PANEL_CSS;
        const head = document.createElement("div");
        head.textContent = title;
        head.style.cssText = "font-weight:700;font-size:14px;";
        box.appendChild(head);
        for (const ln of lines) {
            const d = document.createElement("div");
            d.textContent = ln;
            d.style.cssText = "color:#c7ccd8;white-space:pre-wrap;";
            box.appendChild(d);
        }
        const list = document.createElement("div");
        list.style.cssText = "overflow:auto;max-height:50vh;display:flex;flex-direction:column;gap:3px;";
        let done = false;
        const finish = (key) => { if (done) return; done = true; document.removeEventListener("keydown", onKey, true); overlay.remove(); resolve(key); };
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); finish(null); } };
        for (const o of options) {
            const row = document.createElement("div");
            row.style.cssText = `padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid ${o.accent ? "rgba(163,230,53,.45)" : "rgba(255,255,255,.07)"};background:${o.accent ? "rgba(132,204,22,.10)" : "transparent"};transition:background .1s;`;
            const a = document.createElement("div");
            a.textContent = o.label;
            a.style.cssText = "font-weight:600;word-break:break-word;";
            row.appendChild(a);
            if (o.sub) {
                const b = document.createElement("div");
                b.textContent = o.sub;
                b.style.cssText = "color:#8b93a6;font-size:11px;word-break:break-all;";
                row.appendChild(b);
            }
            row.addEventListener("mouseenter", () => { row.style.background = "rgba(255,255,255,.09)"; });
            row.addEventListener("mouseleave", () => { row.style.background = o.accent ? "rgba(132,204,22,.10)" : "transparent"; });
            row.addEventListener("click", (e) => { e.stopPropagation(); finish(o.key); });
            list.appendChild(row);
        }
        box.appendChild(list);
        const foot = document.createElement("div");
        foot.style.cssText = "display:flex;justify-content:flex-end;margin-top:4px;";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = cancelLabel;
        cancel.style.cssText = "cursor:pointer;border-radius:6px;padding:6px 14px;font:12px sans-serif;border:1px solid rgba(255,255,255,.14);background:#2d3340;color:#fff;";
        cancel.addEventListener("click", (e) => { e.stopPropagation(); finish(null); });
        foot.appendChild(cancel);
        box.appendChild(foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        document.addEventListener("keydown", onKey, true);
    });
}
const v1Count = () => ((readTimeline(findTimelineNode()).obj.tracks || []).find((t) => t.id === "V1")?.clips || []).filter((c) => c && (c.path || c.plan)).length;
const inProjectNow = () => !!projectPointer() && !document.querySelector('[data-obvpm="project-save-as"]');
const TL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/;
// the timeline's own "timelines" window: switch to one of this project's timelines, or make a new one
async function packSwitchTimeline(name, isNew) {
    const btn = document.querySelector('[data-obvpm="project-timeline"]');
    if (!btn) throw new Error("the timeline's timeline button was not found");
    saveAsBypass = true;
    try { btn.click(); } finally { saveAsBypass = false; }
    const list = await waitFor(() => document.querySelector('[data-obvpm="timeline-list"]'), 6000);
    if (!list) throw new Error("the timeline's timelines window did not open");
    if (isNew) {
        const nb = await waitFor(() => document.querySelector('[data-obvpm="timeline-new"]'), 3000);
        if (!nb) throw new Error("the New… button was not found");
        nb.click();
        const input = await waitFor(() => document.querySelector('input[data-obvpm="ask-name-input"]'), 5000);
        if (!input) throw new Error("the new timeline's name window did not open");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, name); else input.value = name;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const go = await waitFor(() => { const g = document.querySelector('[data-obvpm="ask-name-go"]'); return g && !g.disabled ? g : null; }, 5000, 150);
        if (!go) throw new Error("the timeline did not accept that name");
        go.click();
    } else {
        const item = [...document.querySelectorAll('[data-obvpm="timeline-item"]')].find((el) => el.dataset.name === name);
        if (!item) throw new Error(`timeline “${name}” was not in the timeline's list`);
        item.click();
    }
    return !!(await waitFor(() => projectPointer()?.timeline === name, 20000, 250));
}
async function ensureProjectForPopulate() {
    if (!findTimelineNode() || v1Count() > 0) return true;
    const here = inProjectNow() ? projectPointer() : null;
    let known = [];
    try { known = (await folderPost("/obvpm/h3/project_list", { rescan: true })).projects || []; } catch (_) {}
    const options = [];
    const label = (f) => known.find((p) => p.folder === f)?.name || f.split("/").pop();
    if (here) options.push({ key: "p:" + here.folder, label: "This project: " + label(here.folder), sub: here.folder + (here.timeline ? " · timeline " + here.timeline : ""), accent: true });
    for (const pr of known) if (!here || pr.folder !== here.folder) options.push({ key: "p:" + pr.folder, label: pr.name || pr.folder, sub: pr.folder });
    options.push({ key: "new", label: "➕ Create a new project…", sub: `made in ${PROJECTS_ROOT}/` });
    const pick = await uiPick({
        title: "Which project do the new clips go into?",
        lines: ["The timeline is empty, so the new clips need a project to live in."],
        options, cancelLabel: "Cancel (don't populate)",
    });
    if (!pick) return false;
    try {
        let folder, tlName, isNew = false;
        if (pick === "new") {
            const a = await uiModal({
                title: "New project", lines: [`Its folder is made in “${PROJECTS_ROOT}” inside ComfyUI's output folder.`],
                input: { value: "my_project", placeholder: "my_film" },
                buttons: [{ key: "cancel", label: "Cancel" }, { key: "go", label: "Create", primary: true }],
            });
            if (a.key !== "go") return false;
            let typed = a.value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
            if (!typed) throw new Error("Type a name for the new project.");
            if (!typed.includes("/")) typed = PROJECTS_ROOT + "/" + typed.replace(/[<>:"|?*]/g, "_");
            await folderPost("/obvpm/h3/project_create", { folder: typed, document: null });
            folder = typed;
            tlName = null;
        } else {
            folder = pick.slice(2);
            const info = await folderPost("/obvpm/h3/project_open", { folder });
            const names = info.project?.timelines || [];
            const opts = names.map((n) => ({
                key: "t:" + n, label: n,
                sub: here && here.folder === folder && here.timeline === n ? "open now" : (n === info.timeline ? "last used" : ""),
                accent: here && here.folder === folder && here.timeline === n,
            }));
            opts.push({ key: "newtl", label: "➕ New timeline in this project…", sub: "starts empty" });
            const t = await uiPick({ title: `Which timeline of “${info.project?.name || folder}”?`, lines: [], options: opts, cancelLabel: "Cancel (don't populate)" });
            if (!t) return false;
            if (t === "newtl") {
                isNew = true;
                for (;;) {
                    const a = await uiModal({
                        title: "New timeline", lines: ["Letters, numbers, spaces, - _ and . only."],
                        input: { value: `timeline ${names.length + 1}`, placeholder: "timeline name" },
                        buttons: [{ key: "cancel", label: "Cancel" }, { key: "go", label: "Create", primary: true }],
                    });
                    if (a.key !== "go") return false;
                    const nm = a.value.trim();
                    if (!TL_NAME_RE.test(nm) || nm.endsWith(".")) { notify("warn", "New timeline", "That name can't be used: letters, numbers, spaces, - _ and . only."); continue; }
                    if (names.some((x) => x.toLowerCase() === nm.toLowerCase())) { notify("warn", "New timeline", `“${nm}” exists already in this project.`); continue; }
                    tlName = nm;
                    break;
                }
            } else tlName = t.slice(2);
        }
        // switch the timeline over, through its own windows
        const sameProject = here && here.folder === folder;
        if (sameProject) {
            if (isNew || tlName !== here.timeline) {
                if (!(await packSwitchTimeline(tlName, isNew))) throw new Error("the timeline did not switch");
            }
        } else {
            if (isNew) await folderPost("/obvpm/h3/timeline_create", { folder, name: tlName });
            if (tlName) await folderPost("/obvpm/h3/project_open", { folder, timeline: tlName });   // it opens as the project's last one
            if (!(await openProjectViaPackDialog(folder))) throw new Error("the project did not open");
        }
        await sleep(400);
        const n = v1Count();
        if (n > 0) {
            const ok = await uiModal({
                title: "This timeline already has clips",
                lines: [`“${projectPointer()?.timeline || tlName}” holds ${n} clip${n === 1 ? "" : "s"}. Populating replaces ${n === 1 ? "it" : "them"} on the timeline (made files stay on disk).`],
                buttons: [{ key: "cancel", label: "Cancel (don't populate)" }, { key: "go", label: `Replace ${n} clip${n === 1 ? "" : "s"} and populate`, danger: true }],
            });
            if (ok.key !== "go") return false;
        }
        return true;
    } catch (err) {
        notify("error", "Project for the new clips", String(err?.message || err));
        return false;
    }
}

// ---- a free-standing clip before the first clip: one more item on the timeline's own pin menu ----
// (the menu at a clip's left end offers "+ prepend new" and "use existing footage"; on the FIRST clip this adds
//  "plan a free-standing clip at the start", which is not joined to anything: clips can be moved up afterwards
//  and the space between them bridged with the ✨ button)
async function planFreeStanding(anchor, mode = "free", presetText = null) {
    if (gapFillBusy) return;
    const tl = findTimelineNode();
    if (!tl) return notify("warn", "No timeline", "The H3Timeline node was not found.");
    gapFillBusy = true;
    let restore = null;
    try {
        const hold = workflowPromptWidget();
        const list = presetText ? [] : await promptListQuiet();
        const now = String(hold?.w.value ?? "");
        const text = presetText ?? await choosePlanPrompt(anchor, 1, list, { prompt: now, prompt_full: now }, []);
        if (text && hold && text !== now) {
            restore = { hold, was: now };
            setWorkflowPrompt(hold, text);
            await sleep(250);
        }
        const before = planIdsNow();
        // nothing pinned: the next run is a root take, placed at frame 0 (the timeline's own "next.at")
        const cur = readTimeline(tl);
        const doc = { ...cur.obj };
        if (mode === "prepend") {
            // the run that leads into the first clip: the timeline's own prepend pin on it
            const first = (doc.tracks || []).find((t) => t.id === "V1")?.clips?.find((c) => c && c.gap == null);
            if (!first?.path) return notify("warn", "Cannot prepend", "The clip after this space is a planned one with no file yet, so there is nothing to lead into. Use the free-standing choice.");
            doc.next = { role: "prepend", source: first.path, window: "22" };
        } else if (mode === "end") {
            delete doc.next;                 // nothing pinned or placed: the next run lands after the last clip
        } else {
            doc.next = { at: 0, track: "V1" };
        }
        applySequenceToTimeline(tl, JSON.stringify(doc));
        await sleep(700);
        notify("info", mode === "prepend" ? "Prepending" : mode === "end" ? "Duplicating the plan" : "Free-standing clip", mode === "prepend" ? "Planning a clip that leads into the next clip..." : mode === "end" ? "Planning a copy at the end of the timeline..." : "Planning a clip at the start of the timeline, not joined to any other clip...");
        let add = await waitFor(() => document.querySelector('[data-obvpm="plan-add"]'), 3000, 200);
        if (!add) return notify("warn", "Not planned", "The timeline's \"+ plan\" button was not found. Select the next-run band at the end of the timeline, press its \"+ plan\", and the clip is planned from the timeline's own placement.");
        add.click();
        const rec = await waitFor(() => (readTimeline(tl).obj.plans || []).find((p) => !before.has(p.id)), 6000);
        if (restore) { setWorkflowPrompt(restore.hold, restore.was); restore = null; }
        if (!rec) return notify("warn", "Not planned", "The timeline refused to plan a clip (see its message). Planning needs the generation part of the workflow switched on.");
        if (!(await waitFor(() => v1HasPlan(rec.id)))) return notify("warn", "Not planned", "The planned clip did not appear on V1.");
        if (text) {
            const fresh = (readTimeline(tl).obj.plans || []).find((p) => p.id === rec.id);
            if (fresh && String(fresh.prompt_full || "").trim() !== text.trim() && setPlanPrompt(rec.id, text)) await sleep(900);
        }
        if (mode !== "end") await huntClip(rec.id, true);
        notify("success", mode === "prepend" ? "Prepend planned" : mode === "end" ? "Plan duplicated" : "Free-standing clip planned", mode === "prepend"
            ? `plan ${rec.n} leads into the next clip, and drafts are queued.`
            : mode === "end" ? `plan ${rec.n} is a copy with the same prompt, at the end of the timeline. Drag it where you want it.`
            : `plan ${rec.n} is at the start, joined to nothing, and drafts are queued. Move the clips after it up if you want room for a bridge, then use ✨ on the space.`);
    } catch (err) {
        notify("error", "Free-standing clip failed", String(err?.message || err));
    } finally {
        if (restore) { try { setWorkflowPrompt(restore.hold, restore.was); } catch (_) {} }
        gapFillBusy = false;
    }
}
function addFreeItemToSeamMenu(root) {
    if (!root || root.nodeType !== 1) return;
    const items = [...root.querySelectorAll ? root.querySelectorAll("div") : []];
    if (root.tagName === "DIV") items.push(root);
    for (const it of items) {
        if (it.children.length || !/^\+ prepend new/.test(it.textContent || "") || it.dataset.obvpmFreeDone) continue;
        it.dataset.obvpmFreeDone = "1";
        // which clip is this menu for? its hover text names it; an armed item says "active", then the pin does
        const t = String(it.title || "");
        const m = t.match(/prepends into (.+?)(?: \(no mctx|$)/);
        const entries = v1Entries();
        const doc = readTimeline(findTimelineNode()).obj;
        const target = (m ? m[1] : doc.next?.source || "").trim();
        const base = (x) => String(x || "").replace(/\\/g, "/").split("/").pop();
        const k = target ? entries.findIndex((c) => c && c.path && base(c.path) === base(target)) : -1;
        if (k >= 0) {
            if (entries.slice(0, k).some((c) => c && c.gap == null)) continue;   // only the first real clip
        } else {
            // a planned clip has no file to name, so go by where the menu is: at the left end of the first clip box
            const firstBox = [...document.querySelectorAll("[data-obvpm-frames]")].find((b) => b.dataset.obvpmGap !== "1");
            const r1 = firstBox?.getBoundingClientRect(), r2 = it.getBoundingClientRect();
            if (!r1 || !r2.width || Math.abs(r2.left - r1.left) > 260) continue;
            if (entries.filter((c) => c && c.gap == null).length < 1) continue;
        }
        const mine = it.cloneNode(false);
        mine.dataset.obvpmFreeDone = "1";
        mine.textContent = "✨ plan a free-standing clip at the start";
        mine.title = "A new planned clip at the very start, joined to no other clip (pick its prompt next).";
        mine.style.cssText = it.style.cssText;
        mine.addEventListener("mouseenter", () => { mine.style.background = "rgba(127,127,127,.3)"; });
        mine.addEventListener("mouseleave", () => { mine.style.background = "none"; });
        mine.addEventListener("click", (e) => {
            e.stopPropagation();
            const block = document.querySelector("[data-obvpm-frames]") || document.body;
            document.dispatchEvent(new MouseEvent("click"));       // closes the timeline's menu
            setTimeout(() => void planFreeStanding(block), 50);
        });
        it.insertAdjacentElement("afterend", mine);
    }
}
function watchSeamMenus() {
    if (window.__obvpmSeamWatch) return;
    window.__obvpmSeamWatch = true;
    new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.addedNodes) {
            try { addFreeItemToSeamMenu(n); } catch (_) {}
        }
    }).observe(document.body, { childList: true, subtree: true });
}

// A space at the very start has nothing on its left, so the timeline's own [+] is switched off there.
// This gives it a job: plan a clip that leads into the next one, or a free-standing one.
function isStartGap(block) {
    const v1 = v1Entries();
    const blocks = [...document.querySelectorAll('[data-obvpm-gap="1"]')];
    const gaps = v1.map((c, i) => (c && c.gap != null ? i : -1)).filter((i) => i >= 0);
    const bi = blocks.indexOf(block);
    return bi >= 0 && gaps.length === blocks.length && gaps[bi] === 0 && !!v1[1] && v1[1].gap == null;
}
function tuneStartGap() {
    for (const block of document.querySelectorAll('[data-obvpm-gap="1"]')) {
        const plus = block.querySelector("button");
        if (!plus || !isStartGap(block)) continue;
        if (plus.dataset.obvpmStart) continue;
        plus.dataset.obvpmStart = "1";
        plus.style.cursor = "pointer";
        plus.style.background = "rgba(150,104,222,.85)";
        plus.title = "Plan a clip here: one that leads into the next clip, or a free-standing one";
    }
}
function bindStartGapPlus() {
    if (window.__obvpmStartGapBound) return;
    window.__obvpmStartGapBound = true;
    window.addEventListener("click", (e) => {
        const path = e.composedPath ? e.composedPath() : [];
        const btn = path.find((el) => el && el.dataset && el.dataset.obvpmStart === "1");
        if (!btn) return;
        const block = btn.closest('[data-obvpm-gap="1"]');
        if (!block || !isStartGap(block)) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        showPopup(btn, [
            { text: "⏩ Prepend: a clip that leads into the next clip", onClick: () => { setTimeout(() => void planFreeStanding(block, "prepend"), 50); } },
            { text: "✨ Free-standing clip at the start (joined to nothing)", onClick: () => { setTimeout(() => void planFreeStanding(block, "free"), 50); } },
        ], "Plan a clip in this space");
    }, true);
}
// ---- the timeline's Project window: rename / delete on every project, and Duplicate in its footer ----
const PRJ_BTN_CSS = "display:inline-block;cursor:pointer;border-radius:4px;padding:1px 7px;font:11px/16px sans-serif;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.35);color:#e5e7eb;white-space:nowrap;";
function decorateProjectDialog() {
    const ov = document.querySelector('[data-obvpm-dialog="project"]');
    if (!ov) return;
    const list = ov.querySelector('[data-obvpm="project-list"]');
    if (!list) return;
    let openFolder = "", openName = "";
    for (const row of list.querySelectorAll('[data-obvpm="project-item"]')) {
        const open = row.dataset.isOpen === "1";
        if (open) { openFolder = row.dataset.folder; openName = row.querySelector('[data-obvpm="project-item-name"]')?.textContent || ""; }
        if (row.querySelector("[data-obvpm-prj]")) continue;
        const box = document.createElement("span");
        box.style.cssText = "display:inline-flex;gap:4px;flex-shrink:0;margin-left:6px;";
        for (const [act, label] of [["rename", "rename…"], ["delete", "delete…"]]) {
            const b = document.createElement("span");
            b.dataset.obvpmPrj = act;
            b.dataset.folder = row.dataset.folder;
            b.dataset.name = row.querySelector('[data-obvpm="project-item-name"]')?.textContent || "";
            b.dataset.open = open ? "1" : "0";
            b.textContent = label;
            b.title = open ? "This project is open now: open another project first." : (act === "rename" ? "Rename this project (its folder is renamed too)" : "Delete this project folder");
            b.style.cssText = PRJ_BTN_CSS + (open ? "opacity:.4;cursor:default;" : "");
            box.appendChild(b);
        }
        row.appendChild(box);
    }
    // footer: duplicate the open project
    const cancel = [...ov.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel");
    const foot = cancel?.parentElement;
    if (!foot) return;
    // "Project folder": opens the open project's folder (the output folder when none is open)
    if (!foot.querySelector("[data-obvpm-openfolder]")) {
        const fb = document.createElement("button");
        fb.type = "button";
        fb.dataset.obvpmOpenfolder = "1";
        fb.style.cssText = cancel.style.cssText;
        fb.style.display = "inline-flex";
        fb.style.alignItems = "center";
        fb.style.gap = "7px";
        fb.innerHTML = FOLDER_SVG + "<span>Project folder</span>";
        fb.title = "Open the open project's folder in the file manager";
        foot.insertBefore(fb, foot.firstChild);
    }
    let dup = foot.querySelector("[data-obvpm-prj-dup]");
    if (!openFolder) { dup?.remove(); return; }
    if (!dup) {
        dup = document.createElement("button");
        dup.type = "button";
        dup.dataset.obvpmPrjDup = "1";
        dup.dataset.obvpmPrj = "duplicate";
        dup.style.cssText = cancel.style.cssText;
        foot.insertBefore(dup, foot.firstChild);
    }
    dup.dataset.folder = openFolder;
    dup.dataset.name = openName;
    const want = `Duplicate ${openName}…`;
    if (dup.textContent !== want) dup.textContent = want;
}
async function reopenProjectDialog() {
    const ov = document.querySelector('[data-obvpm-dialog="project"]');
    [...(ov?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === "Cancel")?.click();
    await sleep(350);
    document.querySelector('[data-obvpm="project-btn"]')?.click();
}
let prjBusy = false;
async function projectAction(act, folder, name) {
    if (prjBusy) return;
    prjBusy = true;
    let prog = null;
    try {
        if (act === "rename") {
            const a = await uiModal({
                title: `Rename “${name}”`,
                lines: ["The project's folder is renamed to match, in the same place. Letters, numbers, spaces, - _ and . only."],
                input: { value: name }, buttons: [{ key: "cancel", label: "Cancel" }, { key: "go", label: "Rename", primary: true }],
            });
            if (a.key !== "go") return;
            const r = await folderPost("/avfx/clip_populator/project_rename", { folder, name: a.value.trim() });
            notify("success", "Project renamed", `“${name}” is now “${r.name}” (${r.folder}).`);
            await reopenProjectDialog();
        } else if (act === "delete") {
            const info = await folderPost("/avfx/clip_populator/project_info", { folder });
            const one = await uiModal({
                title: `Delete the project “${info.name}”?`,
                lines: [`The whole folder “${info.folder}” goes: ${info.files} file${info.files === 1 ? "" : "s"}, ${fmtBytes(info.bytes)}, all its timelines and clips.`],
                buttons: [{ key: "cancel", label: "Cancel" }, { key: "go", label: "Continue", danger: true }],
            });
            if (one.key !== "go") return;
            const two = await uiModal({
                title: "Last check",
                lines: [`“${info.name}” cannot be brought back if you erase it. The recycle bin can.`],
                buttons: [{ key: "cancel", label: "Cancel" }, { key: "recycle", label: "♻ Recycle bin", primary: true }, { key: "permanent", label: "🗑 Erase for good", danger: true }],
            });
            if (two.key !== "recycle" && two.key !== "permanent") return;
            await folderPost("/avfx/clip_populator/project_delete", { folder, kind: "project", mode: two.key });
            notify("success", "Project deleted", two.key === "recycle" ? `“${info.name}” is in the recycle bin.` : `“${info.name}” was erased.`);
            await reopenProjectDialog();
        } else if (act === "duplicate") {
            const a = await uiModal({
                title: `Duplicate “${name}”`,
                lines: ["The whole project folder is copied (clips, timelines, versions) to a new project next to it."],
                input: { value: name + " copy" }, buttons: [{ key: "cancel", label: "Cancel" }, { key: "go", label: "Continue", primary: true }],
            });
            if (a.key !== "go") return;
            const plan = await folderPost("/avfx/clip_populator/project_dup_plan", { folder, name: a.value.trim() });
            const n = plan.files.length;
            const ok = await uiModal({
                title: "Copy the project?",
                lines: [`${n} file${n === 1 ? "" : "s"}, ${fmtBytes(plan.total)}, will be copied into “${plan.folder}”.` + (plan.skipped ? ` (${plan.skipped} linked file${plan.skipped === 1 ? "" : "s"} skipped.)` : "")],
                buttons: [{ key: "cancel", label: "Cancel" }, { key: "go", label: "Copy", primary: true }],
            });
            if (ok.key !== "go") return;
            prog = uiProgress("Copying into " + plan.folder);
            const copied = [];
            let done = 0, bytes = 0;
            try {
                for (const f of plan.files) {
                    prog.set(`${done + 1} of ${n}: ${f.src.split("/").pop()} (${fmtBytes(f.size)})`, plan.total ? bytes / plan.total : done / n);
                    await folderPost("/avfx/clip_populator/saveproj_copy", f);
                    copied.push(f);
                    done++;
                    bytes += f.size;
                }
                await folderPost("/avfx/clip_populator/project_dup_finish", { folder, name: a.value.trim() });
            } catch (err) {
                try { await folderPost("/avfx/clip_populator/saveproj_cleanup", { pairs: copied.map((f) => ({ src: f.dst, dst: f.src })), mode: "permanent" }); } catch (_) {}
                throw new Error(`Copy stopped at ${done + 1} of ${n}: ${err?.message || err}. The partial copy was removed; the original is untouched.`);
            }
            prog.close(); prog = null;
            notify("success", "Project duplicated", `“${plan.name}” is ready (${n} files, ${fmtBytes(plan.total)}).`);
            await reopenProjectDialog();
        }
    } catch (err) {
        prog?.close();
        notify("error", "Project", String(err?.message || err));
    } finally {
        prjBusy = false;
    }
}
function watchProjectDialog() {
    if (window.__obvpmPrjWatch) return;
    window.__obvpmPrjWatch = true;
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; try { decorateProjectDialog(); injectFolderButton(); } catch (_) {} });
    }).observe(document.body, { childList: true, subtree: true });
    window.addEventListener("click", (e) => {
        const path = e.composedPath ? e.composedPath() : [];
        const el = path.find((x) => x && x.dataset && x.dataset.obvpmPrj);
        if (!el) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (el.dataset.open === "1" && el.dataset.obvpmPrj !== "duplicate") return;
        void projectAction(el.dataset.obvpmPrj, el.dataset.folder, el.dataset.name);
    }, true);
}
// ---- right-click on a planned clip: "Edit prompt…" next to the timeline's own Delete -------------------
let ctxClipIdx = -1;
async function editPlanPrompt(planId) {
    const tl = findTimelineNode();
    const doc = readTimeline(tl).obj;
    const plan = (doc.plans || []).find((p) => p.id === planId);
    if (!plan) return notify("warn", "Edit prompt", "That plan was not found.");
    const v1 = (doc.tracks || []).find((t) => t.id === "V1")?.clips || [];
    const at = v1.findIndex((c) => c && c.plan === planId);
    const no = at + 1;
    const byId = new Map((doc.plans || []).map((p) => [p.id, p]));
    const near = (dir) => {
        for (let k = at + dir; k >= 0 && k < v1.length; k += dir) {
            if (v1[k] && v1[k].gap != null) continue;
            const q = v1[k]?.plan ? byId.get(v1[k].plan) : null;
            const t = String(q?.prompt_full || q?.prompt || "").trim();
            return t ? { q, text: t } : null;
        }
        return null;
    };
    const sources = [];
    const list = await promptListQuiet();
    if (list[no - 1]) sources.push({ label: `List prompt ${no}`, text: list[no - 1] });
    const before = near(-1), after = near(1);
    if (before) sources.push({ label: `clip before (plan ${before.q.n})`, text: before.text });
    if (after) sources.push({ label: `clip after (plan ${after.q.n})`, text: after.text });
    const hold = workflowPromptWidget();
    const wf = String(hold?.w.value ?? "").trim();
    if (wf) sources.push({ label: "Workflow's current", text: wf });
    const initial = String(plan.prompt_full || plan.prompt || "");
    const text = await openPromptEditor({ title: `Prompt for clip ${no} (plan ${plan.n})`, initial, sources });
    if (text == null || text.trim() === initial.trim()) return;
    if (!setPlanPrompt(planId, text)) return notify("warn", "Edit prompt", "This plan has no prompt box recorded, so its prompt can't be changed from here.");
    notify("success", "Prompt changed", `clip ${no} (plan ${plan.n}) has the new prompt. It was changed on the plan only: draft it again to get clips from it.`);
}
function planRecOf(id) { return (readTimeline(findTimelineNode()).obj.plans || []).find((p) => p.id === id); }
async function copyPlanPrompt(id) {
    const t = String(planRecOf(id)?.prompt_full || planRecOf(id)?.prompt || "");
    if (!t) return notify("warn", "Copy prompt", "This plan has no prompt.");
    try { await navigator.clipboard.writeText(t); }
    catch (_) {
        const ta = document.createElement("textarea");
        ta.value = t; ta.style.cssText = "position:fixed;opacity:0;";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    notify("success", "Prompt copied", `${t.split(/\s+/).length} words on the clipboard.`);
}
async function useListPrompt(id) {
    const v1 = v1Entries();
    const no = v1.findIndex((c) => c && c.plan === id) + 1;
    const list = await promptListQuiet();
    if (!list[no - 1]) return notify("warn", "List prompt", `Your list has no prompt ${no} (clip ${no}).`);
    if (!setPlanPrompt(id, list[no - 1])) return notify("warn", "List prompt", "This plan has no prompt box recorded, so its prompt can't be changed from here.");
    notify("success", "Prompt reset", `clip ${no} now has list prompt ${no}. Draft it again to get clips from it.`);
}
async function duplicatePlan(id) {
    const t = String(planRecOf(id)?.prompt_full || planRecOf(id)?.prompt || "");
    if (!t) return notify("warn", "Duplicate", "This plan has no prompt to copy.");
    await planFreeStanding(document.body, "end", t);
}
function watchClipMenu() {
    if (window.__obvpmClipMenuWatch) return;
    window.__obvpmClipMenuWatch = true;
    window.addEventListener("contextmenu", (e) => {
        const path = e.composedPath ? e.composedPath() : [];
        const block = path.find((el) => el && el.dataset && el.dataset.obvpmFrames !== undefined);
        const strip = block?.parentElement;
        ctxClipIdx = block && strip ? [...strip.children].filter((el) => el.dataset && el.dataset.obvpmFrames !== undefined).indexOf(block) : -1;
    }, true);
    new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            const menu = n.dataset?.obvpm === "clip-menu" ? n : n.querySelector?.('[data-obvpm="clip-menu"]');
            if (!menu || menu.dataset.obvpmEdit) continue;
            menu.dataset.obvpmEdit = "1";
            try {
                const entry = ctxClipIdx >= 0 ? v1Entries()[ctxClipIdx] : null;
                const planId = entry?.plan;
                const del = menu.querySelector('[data-act="delete"]');
                if (!planId || !del) continue;
                const mk = (act, label, title, run) => {
                    const it = del.cloneNode(false);
                    it.dataset.act = act;
                    it.textContent = label;
                    it.title = title;
                    it.style.cssText = del.style.cssText;
                    it.addEventListener("mouseenter", () => { it.style.background = "rgba(127,127,127,.35)"; });
                    it.addEventListener("mouseleave", () => { it.style.background = "none"; });
                    it.addEventListener("click", () => { menu.remove(); setTimeout(() => void run(planId), 30); });
                    del.insertAdjacentElement("beforebegin", it);
                };
                mk("edit-prompt", "✏ Edit prompt…", "Change this planned clip's prompt (the same window as the ✨ one).", editPlanPrompt);
                mk("draft-this", "🎯 Draft alternatives for this clip", "Hunt this clip now (as the Hunt clip button, without selecting it first).", (id) => huntClip(id, true));
                mk("copy-prompt", "📋 Copy prompt", "Put this clip's prompt on the clipboard.", copyPlanPrompt);
                mk("list-prompt", "↺ Use list prompt for this clip number", "Reset this clip's prompt to the one at its clip number in your list.", useListPrompt);
                mk("dup-plan", "⧉ Duplicate this plan", "A second planned clip with the same prompt, at the end of the timeline.", duplicatePlan);
            } catch (_) {}
        }
    }).observe(document.body, { childList: true });
}
// ---- hover preview: rest the mouse on a made or drafted clip for a second and it plays -------------------
const PV = { timer: 0, hideT: 0, block: null, el: null, srcs: [], idx: 0, titleOff: null, overBlock: false, overPv: false, token: 0, textBox: null };
const pvCache = new Map();           // batch key -> {at, takes}
const frameBlocks = (strip) => [...strip.children].filter((el) => el.dataset && el.dataset.obvpmFrames !== undefined);
const baseName = (c) => String(c).replace(/\\/g, "/").split("/").pop();
const clipUrl = (clip) => {
    const parts = String(clip).replace(/\\/g, "/").split("/");
    const file = parts.pop();
    return api.apiURL(`/view?filename=${encodeURIComponent(file)}&subfolder=${encodeURIComponent(parts.join("/"))}&type=output`);
};
async function previewSources(entry) {
    if (!entry) return [];
    if (entry.path) return [{ url: clipUrl(entry.path), label: "take", name: baseName(entry.path) }];
    if (!entry.plan) return [];
    const doc = readTimeline(findTimelineNode()).obj;
    const plan = (doc.plans || []).find((p) => p.id === entry.plan);
    if (!plan?.batch) return [];
    const runs = doc.plan_runs || [];
    const dirs = new Set();
    for (const r of runs) if (r.batch === plan.batch) dirs.add(r.dir ?? "");
    if (!dirs.size) dirs.add("");
    // the plan itself remembers only its newest batch, so look in the folder for all of them
    const found = new Map();
    for (const d of dirs) {
        try {
            const got = await folderPost("/avfx/clip_populator/plan_batches", { folder: d, plan_id: plan.id });
            for (const g of got.batches || []) if (!found.has(g.batch)) found.set(g.batch, g.takes || []);
        } catch (_) {}
    }
    const out = [];
    const order = [...found.keys()];
    if (plan.batch && order.includes(plan.batch)) { order.splice(order.indexOf(plan.batch), 1); order.unshift(plan.batch); }
    for (const [bi, b] of order.entries()) {
        for (const t of found.get(b)) out.push({ url: clipUrl(t.clip), label: t.draft ? "draft" : "take", name: baseName(t.clip), bi });
    }
    if (out.length) return out;
    // fallback: the old way, the newest batch only
    const batches = [plan.batch].filter(Boolean);
    for (const [bi, b] of batches.entries()) {
        const takes = [], drafts = [];
        const run = runs.find((r) => r.batch === b);
        if (!run) continue;
        const key = (run.dir ?? "") + "|" + b;
        let got = pvCache.get(key);
        if (!got || Date.now() - got.at > 15000) {
            try { got = { at: Date.now(), takes: (await folderPost("/obvpm/h3/plan_takes", { folder: run.dir ?? "", batch: b })).takes || [] }; }
            catch (_) { got = { at: Date.now(), takes: [] }; }
            pvCache.set(key, got);
        }
        for (const t of got.takes) {
            if (t.plan_id !== plan.id || t.sound_only || !t.clip) continue;
            (t.draft ? drafts : takes).push({ url: clipUrl(t.clip), label: t.draft ? "draft" : "take", name: baseName(t.clip), bi });
        }
        out.push(...takes, ...drafts);
    }
    return out;                           // batches newest first
}
function pvHideNow() {
    clearTimeout(PV.timer); clearTimeout(PV.hideT);
    PV.timer = PV.hideT = 0;
    PV.token++;
    if (PV.el) {
        const v = PV.el.querySelector("video");
        try { v.pause(); v.removeAttribute("src"); v.load(); } catch (_) {}
        PV.el.remove();
    }
    if (PV.block && PV.titleOff != null && PV.block.isConnected && !PV.block.title) PV.block.title = PV.titleOff;
    PV.el = null; PV.titleOff = null; PV.srcs = []; PV.overPv = false;
    if (PV.textBox) { PV.textBox.remove(); PV.textBox = null; }
}
function pvMaybeHide() {
    clearTimeout(PV.hideT);
    PV.hideT = setTimeout(() => { if (!PV.overBlock && !PV.overPv) { pvHideNow(); PV.block = null; } }, 260);
}
async function pvShow(block, token) {
    const strip = block.parentElement;
    if (!strip) return;
    const entry = v1Entries()[frameBlocks(strip).indexOf(block)];
    const srcs = await previewSources(entry);
    if (token !== PV.token || !block.isConnected || !srcs.length) return;
    const groups = [];                    // one list per batch, newest batch first
    for (const sc of srcs) { let g = groups.find((x) => x[0].bi === sc.bi); if (!g) groups.push(g = []); g.push(sc); }
    let gi = 0;
    let cur = groups[0];
    PV.srcs = cur; PV.idx = 0;
    const wide = groups.some((g) => g.length > 1);
    const box = document.createElement("div");
    box.style.cssText = `position:fixed;z-index:100003;width:${wide ? 440 : 320}px;padding:6px;box-sizing:border-box;` + UI_PANEL_CSS;
    // the row of small ones on top (only when the batch on show has several): click one to watch it
    const MAXT = 8;
    let tiles = [];
    const strip2 = document.createElement("div");
    strip2.style.cssText = "display:flex;gap:4px;margin-bottom:5px;flex-wrap:wrap;";
    const buildTiles = () => {
        strip2.textContent = "";
        tiles = [];
        strip2.style.display = cur.length > 1 ? "flex" : "none";
        if (cur.length < 2) return;
        cur.slice(0, MAXT).forEach((sc, i) => {
            const t = document.createElement("div");
            t.style.cssText = "position:relative;flex:1 1 0;min-width:0;max-width:96px;height:54px;border-radius:5px;overflow:hidden;background:#000;cursor:pointer;border:2px solid transparent;box-sizing:border-box;";
            const tv = document.createElement("video");
            tv.muted = true; tv.preload = "metadata"; tv.playsInline = true;
            tv.src = sc.url + "#t=0.1";
            tv.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;";
            const lb = document.createElement("span");
            lb.textContent = `${sc.label} ${i + 1}`;
            lb.style.cssText = "position:absolute;left:2px;top:2px;font:600 8px/10px sans-serif;padding:0 3px;border-radius:3px;background:rgba(0,0,0,.65);color:#fff;pointer-events:none;";
            t.append(tv, lb);
            t.addEventListener("click", (e) => { e.stopPropagation(); PV.picked = true; play(i); });
            strip2.appendChild(t);
            tiles.push(t);
        });
        if (cur.length > MAXT) {
            const more = document.createElement("span");
            more.textContent = `+${cur.length - MAXT} more`;
            more.style.cssText = "align-self:center;font-size:10px;color:#aab2c3;padding:0 4px;";
            strip2.appendChild(more);
        }
    };
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:relative;background:#000;border-radius:8px;overflow:hidden;min-height:90px;";
    const v = document.createElement("video");
    v.muted = true; v.autoplay = true; v.playsInline = true; v.controls = false;
    v.style.cssText = "display:block;width:100%;max-height:260px;object-fit:contain;background:#000;";
    const tag = document.createElement("span");
    tag.style.cssText = "position:absolute;top:4px;right:5px;font:600 9px/12px sans-serif;padding:0 5px;border-radius:3px;background:rgba(0,0,0,.6);color:#fff;pointer-events:none;";
    wrap.append(v, tag);
    // batch arrows, bottom centre of the picture: only when the clip has more than one batch
    let counter = null;
    const goBatch = (d) => {
        gi = ((gi + d) % groups.length + groups.length) % groups.length;
        cur = groups[gi]; PV.srcs = cur; PV.picked = false;
        buildTiles(); play(0); place();
    };
    if (groups.length > 1) {
        const bar = document.createElement("div");
        bar.style.cssText = "position:absolute;left:50%;bottom:6px;transform:translateX(-50%);display:flex;align-items:center;gap:2px;padding:2px 4px;border-radius:14px;background:rgba(0,0,0,.62);color:#fff;font:600 11px/16px sans-serif;user-select:none;";
        const arrow = (ch, d, tip) => {
            const a = document.createElement("span");
            a.textContent = ch; a.title = tip;
            a.style.cssText = "width:22px;height:20px;line-height:19px;text-align:center;font-size:17px;border-radius:10px;cursor:pointer;";
            a.addEventListener("mouseenter", () => { a.style.background = "rgba(255,255,255,.22)"; });
            a.addEventListener("mouseleave", () => { a.style.background = ""; });
            a.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); goBatch(d); });
            return a;
        };
        counter = document.createElement("span");
        counter.style.cssText = "min-width:34px;text-align:center;padding:0 2px;";
        bar.append(arrow("‹", -1, "previous batch"), counter, arrow("›", 1, "next batch"));
        wrap.appendChild(bar);
    }
    const cap = document.createElement("div");
    cap.style.cssText = "margin-top:5px;color:#e5e7eb;font-size:11px;word-break:break-all;";
    const hint = document.createElement("div");
    hint.textContent = "Click here to see the tooltip";
    hint.style.cssText = "margin-top:3px;font-size:11px;color:#a3e635;cursor:pointer;text-decoration:underline;";
    hint.addEventListener("click", (e) => {
        e.stopPropagation();
        const text = PV.titleOff || block.title || "";
        if (PV.textBox) { PV.textBox.remove(); PV.textBox = null; return; }
        if (!text) return;
        const tb = document.createElement("div");
        tb.style.cssText = "position:fixed;z-index:100004;max-width:420px;padding:10px 12px;white-space:pre-wrap;word-break:break-word;" + UI_PANEL_CSS;
        tb.textContent = text;
        document.body.appendChild(tb);
        const br = box.getBoundingClientRect();
        tb.style.left = Math.max(6, Math.min(br.right + 8, innerWidth - tb.offsetWidth - 6)) + "px";
        tb.style.top = Math.max(6, Math.min(br.top, innerHeight - tb.offsetHeight - 6)) + "px";
        PV.textBox = tb;
    });
    box.appendChild(strip2);
    box.append(wrap, cap, hint);
    box.addEventListener("mouseenter", () => { PV.overPv = true; clearTimeout(PV.hideT); });
    box.addEventListener("mouseleave", () => { PV.overPv = false; pvMaybeHide(); });
    document.body.appendChild(box);
    PV.el = box;
    PV.picked = false;
    if (block.title) { PV.titleOff = block.title; block.title = ""; }   // the browser's own tooltip would sit on top of this
    const place = () => {
        const r = block.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
        let top = r.top - h - 4;
        if (top < 6) top = Math.min(innerHeight - h - 6, r.bottom + 4);
        box.style.left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 6)) + "px";
        box.style.top = top + "px";
    };
    let bad = 0;
    function play(i) {
        PV.idx = ((i % cur.length) + cur.length) % cur.length;
        const many = cur.length > 1;
        const sc = cur[PV.idx];
        if (counter) counter.textContent = `${gi + 1} / ${groups.length}`;
        tag.textContent = sc.label;
        const seed = String(sc.name || "").match(/seed[_-]?(\d+)/i);
        cap.textContent = `${sc.name || sc.label}${seed ? " · seed " + seed[1] : ""}${many ? `  (${PV.idx + 1} of ${cur.length})` : ""}${groups.length > 1 ? `  · batch ${gi + 1} of ${groups.length}` : ""}`;
        tiles.forEach((t, k) => { t.style.borderColor = k === PV.idx ? "#3b82f6" : "transparent"; });
        v.loop = !many || PV.picked;      // one video, or one picked by hand: it repeats; otherwise on to the next
        v.src = sc.url;
        const p = v.play();
        if (p && p.catch) p.catch(() => {});
    }
    v.addEventListener("loadeddata", () => { bad = 0; place(); });
    v.addEventListener("ended", () => play(PV.idx + 1));
    v.addEventListener("error", () => {
        if (++bad >= cur.length) { cap.textContent = "This video can't be played here."; v.removeAttribute("src"); return; }
        play(PV.idx + 1);
    });
    buildTiles();
    place();
    play(0);
}
function watchClipPreview() {
    if (window.__obvpmPvWatch) return;
    window.__obvpmPvWatch = true;
    const blockOf = (t) => {
        const b = t?.closest ? t.closest("[data-obvpm-frames]") : null;
        return b && b.dataset.obvpmGap !== "1" ? b : null;
    };
    window.addEventListener("mouseover", (e) => {
        const b = blockOf(e.target);
        if (!b) return;
        PV.overBlock = true;
        clearTimeout(PV.hideT);
        if (PV.block === b && (PV.timer || PV.el)) return;
        if (PV.block !== b) pvHideNow();
        PV.block = b;
        if (e.buttons || document.querySelector("[data-obvpm-dialog]")) return;
        PV.token++;
        const token = PV.token;
        PV.timer = setTimeout(() => { PV.timer = 0; void pvShow(b, token); }, 1000);
    }, true);
    window.addEventListener("mouseout", (e) => {
        const b = blockOf(e.target);
        if (!b || (e.relatedTarget && b.contains(e.relatedTarget))) return;
        PV.overBlock = false;
        if (PV.timer) { clearTimeout(PV.timer); PV.timer = 0; PV.token++; }
        pvMaybeHide();
    }, true);
    for (const t of ["mousedown", "dragstart", "wheel", "contextmenu"]) {
        window.addEventListener(t, (e) => { if (PV.el && PV.el.contains(e.target)) return; pvHideNow(); }, true);
    }
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") pvHideNow(); }, true);
}
// ---- a yellow folder button in the timeline's project row: opens the open project's folder -------------
const FOLDER_SVG = '<svg width="16" height="14" viewBox="0 0 16 14" xmlns="http://www.w3.org/2000/svg" style="display:block"><path d="M1 2.2C1 1.54 1.54 1 2.2 1h3.4c.3 0 .58.12.79.33L7.4 2.34c.2.21.49.33.79.33h5.6c.66 0 1.2.54 1.2 1.2v7.93c0 .66-.54 1.2-1.2 1.2H2.2c-.66 0-1.2-.54-1.2-1.2V2.2z" fill="#E3A21A"/><path d="M1 4.6c0-.66.54-1.2 1.2-1.2h11.6c.66 0 1.2.54 1.2 1.2v7.2c0 .66-.54 1.2-1.2 1.2H2.2c-.66 0-1.2-.54-1.2-1.2V4.6z" fill="#FFCA3A"/></svg>';
function injectFolderButton() {
    const row = document.querySelector('[data-obvpm="project-row"]');
    if (!row || row.querySelector("[data-obvpm-openfolder]")) return;
    const btns = [...row.querySelectorAll("button")];
    const model = btns.find((b) => /^versions/i.test(b.textContent.trim())) || btns[btns.length - 1];
    if (!model) return;
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.obvpmOpenfolder = "1";
    b.innerHTML = FOLDER_SVG;
    b.title = "Open this project's folder";
    b.style.cssText = model.style.cssText;
    b.style.display = "inline-flex";
    b.style.alignItems = "center";
    b.style.justifyContent = "center";
    b.style.width = "auto";
    b.style.padding = "0 9px";
    const rest = model.style.background || getComputedStyle(model).backgroundColor;
    b.addEventListener("mouseenter", () => { b.style.background = "rgba(127,127,127,.3)"; });
    b.addEventListener("mouseleave", () => { b.style.background = rest; });
    model.insertAdjacentElement("afterend", b);
}
window.addEventListener("click", (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    if (!path.some((el) => el && el.dataset && el.dataset.obvpmOpenfolder)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const folder = inProjectNow() ? (projectPointer()?.folder || "") : "";
    folderPost("/avfx/clip_populator/open_folder", { folder }).catch((err) => notify("error", "Open folder", String(err?.message || err)));
}, true);
let saveProjBusy = false;
async function saveAsNewProject() {
    if (saveProjBusy) return;
    saveProjBusy = true;
    let prog = null;
    try {
        const tl = findTimelineNode();
        if (!tl) throw new Error("No H3 Timeline node found.");
        const cur = readTimeline(tl);
        // (a leftover project pointer in the timeline's text is ignored: the timeline offers this button only outside a project)
        const docNow = { ...cur.obj };
        delete docNow.project;
        const clips = ((cur.obj.tracks || []).find((t) => t.id === "V1")?.clips || []).filter((c) => c.path);
        const guess = (clips[0]?.path || "").replace(/\\/g, "/").split("/").filter(Boolean).slice(-2, -1)[0] || "";
        const ask = await uiModal({
            title: "Save this timeline as a new project",
            lines: [`Name the new project. It is made in the “${PROJECTS_ROOT}” folder inside ComfyUI's output folder (type a path with a / to put it somewhere else). Every clip this timeline uses, with its small files, is copied into it, the timeline's paths follow, and then the originals are removed so nothing is kept twice.`],
            input: { value: guess && guess !== PROJECTS_ROOT ? guess : "my_project", placeholder: "my_film" },
            buttons: [{ key: "cancel", label: "Cancel" }, { key: "go", label: "Continue", primary: true }],
        });
        if (ask.key !== "go") return;
        let typed = ask.value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        if (!typed) throw new Error("Type a name for the new project.");
        if (!typed.includes("/")) typed = PROJECTS_ROOT + "/" + typed.replace(/[<>:"|?*]/g, "_");
        const plan = await folderPost("/avfx/clip_populator/saveproj_plan", { document: JSON.stringify(docNow), folder: typed });
        const n = plan.files.length;
        const lines = [];
        if (n) lines.push(`${n} file${n === 1 ? "" : "s"}, ${fmtBytes(plan.total)}, will be copied from ${plan.from.map((f) => f || "the output folder").join(", ")} into “${plan.folder}”.`);
        else lines.push(`This timeline has no made clip files yet (only planned clips), so nothing is copied. The project “${plan.folder}” starts with this timeline, and the clips you make from now on are saved in it.`);
        if (plan.missing?.length) lines.push(`Not found, and left as they are (${plan.missing.length}): ${plan.missing.slice(0, 3).join(", ")}${plan.missing.length > 3 ? "…" : ""}`);
        if (n) lines.push("Nothing is removed yet: the originals go only after the copies are checked and the project is open.");
        const ok = await uiModal({ title: n ? "Copy into the new project?" : "Create the new project?", lines, buttons: [{ key: "cancel", label: "Cancel" }, { key: "go", label: n ? "Copy and create the project" : "Create the project", primary: true }] });
        if (ok.key !== "go") return;

        prog = uiProgress(n ? "Copying into " + plan.folder : "Creating " + plan.folder);
        let done = 0, bytes = 0;
        const copied = [];
        try {
            for (const f of plan.files) {
                prog.set(`${done + 1} of ${n}: ${f.src.split("/").pop()} (${fmtBytes(f.size)})`, plan.total ? bytes / plan.total : done / n);
                await folderPost("/avfx/clip_populator/saveproj_copy", f);
                copied.push(f);
                done++;
                bytes += f.size;
            }
        } catch (err) {
            // nothing was changed in the originals; take back the copies made so far
            try { await folderPost("/avfx/clip_populator/saveproj_cleanup", { pairs: copied.map((f) => ({ src: f.dst, dst: f.src })), mode: "permanent" }); } catch (_) {}
            throw new Error(`Copy stopped at ${done + 1} of ${n}: ${err?.message || err}. The originals were not touched.`);
        }
        prog.set("Checked: every copy has the same size. Creating the project…", 1);
        await folderPost("/obvpm/h3/project_create", { folder: plan.folder, document: plan.document });
        prog.set("Opening the project in the timeline…", 1);
        const opened = await openProjectViaPackDialog(plan.folder);
        prog.close(); prog = null;
        if (opened && !n) { notify("success", "Saved as a project", `The timeline is now the project “${plan.folder}”.`); return; }
        if (!opened) {
            notify("warn", "Project created", `The project “${plan.folder}” is ready with all its clips, but it did not open by itself: open it with the timeline's project button. The originals were kept.`);
            return;
        }
        const del = await uiModal({
            title: "Project is open: remove the originals?",
            lines: [`${n} file${n === 1 ? "" : "s"} (${fmtBytes(plan.total)}) are now in “${plan.folder}”, and the timeline uses those. The old copies can go, so nothing is kept twice.`],
            buttons: [{ key: "keep", label: "Keep the originals" }, { key: "recycle", label: "♻ Recycle bin", primary: true }, { key: "permanent", label: "🗑 Erase for good", danger: true }],
        });
        if (del.key === "recycle" || del.key === "permanent") {
            const r = await folderPost("/avfx/clip_populator/saveproj_cleanup", { pairs: plan.files.map((f) => ({ src: f.src, dst: f.dst })), mode: del.key });
            notify("success", "Saved as a project", `${r.removed} original${r.removed === 1 ? "" : "s"} removed (${fmtBytes(r.freed)})${r.kept?.length ? `, ${r.kept.length} kept` : ""}.`);
        } else {
            notify("success", "Saved as a project", "The originals were kept.");
        }
    } catch (err) {
        prog?.close();
        notify("error", "Save as project", String(err?.message || err));
    } finally {
        saveProjBusy = false;
    }
}

async function openFolderMenu(anchor) {
    const ptr = projectPointer();
    if (!ptr) {
        showPopup(anchor, [{ text: "This timeline is not saved in a project folder." }], "Project folders");
        return;
    }
    showPopup(anchor, [{ text: "Reading the project folder…" }], "Project folders");
    let info;
    try {
        info = await folderPost("/avfx/clip_populator/project_info", { folder: ptr.folder });
    } catch (err) {
        showPopup(anchor, [{ text: "Error: " + (err?.message || err), color: "#fca5a5" }], "Project folders");
        return;
    }
    const armed = {};
    const act = (key, label, armedText, run) => ({
        text: label, color: "#fca5a5", keep: true,
        onClick: async (row, pop, ev) => {
            const go = async (mode) => {
                row.replaceChildren();
                row.textContent = mode === "recycle" ? "Moving to the recycle bin…" : "Erasing…";
                row.style.color = "#fca5a5";
                try {
                    const msg = await run(mode);
                    row.textContent = msg;
                    row.style.color = "#86efac";
                } catch (err) {
                    row.textContent = "Error: " + (err?.message || err);
                }
                row.style.whiteSpace = "normal";
                setTimeout(closePopup, 2200);
            };
            if (armed[key]) {
                // second step: the click must land on one of the two halves
                const mode = ev?.target?.closest?.("[data-mode]")?.dataset.mode;
                if (mode) await go(mode);
                return true;
            }
            for (const k of Object.keys(armed)) armed[k] = false;
            armed[key] = true;
            row.replaceChildren();
            row.style.whiteSpace = "normal";
            row.style.cursor = "default";
            const q = document.createElement("div");
            q.textContent = "⚠ Sure? " + armedText;
            q.style.cssText = "color:#fca5a5;margin-bottom:5px;";
            const two = document.createElement("div");
            two.style.cssText = "display:flex;gap:6px;";
            const half = (mode, text, bg, border, fg) => {
                const b = document.createElement("div");
                b.dataset.mode = mode;
                b.textContent = text;
                b.style.cssText = `flex:1;text-align:center;padding:5px 6px;border-radius:4px;cursor:pointer;font-weight:600;background:${bg};border:1px solid ${border};color:${fg};`;
                return b;
            };
            two.append(
                half("permanent", "🗑 Erase for good", "#7f1d1d", "#ef4444", "#fecaca"),
                half("recycle", "♻ Recycle bin", "#14532d", "#22c55e", "#bbf7d0"),
            );
            row.append(q, two);
            return true;
        },
    });
    const items = [];
    const open = ptr.timeline;
    for (const t of info.timelines) {
        const stats = `${t.files} file${t.files === 1 ? "" : "s"}, ${fmtBytes(t.bytes)}`;
        if (t.name === open) {
            items.push({ text: `▶ “${t.name}” is open now (${stats})`, color: "#9ca3af" });
        } else if (info.timelines.length > 1) {
            items.push(act("t:" + t.name, `🗑 Delete timeline “${t.name}” (${stats})`,
                `timeline “${t.name}” with its versions and backups (${stats}). Clips stay.`,
                async (mode) => {
                    await folderPost("/avfx/clip_populator/project_delete",
                        { folder: ptr.folder, kind: "timeline", timeline: t.name, keep: open, mode });
                    return `Timeline “${t.name}” ${mode === "recycle" ? "sent to the recycle bin" : "erased"}.`;
                }));
        }
    }
    const others = info.timelines.filter((t) => t.name !== open);
    if (others.length) {
        items.push(act("others", `🗑 Delete ALL other timelines (${others.length}), keep “${open}”`,
            `${others.length} timeline${others.length === 1 ? "" : "s"} with their versions and backups. “${open}” and the clips stay.`,
            async (mode) => {
                const r = await folderPost("/avfx/clip_populator/project_delete",
                    { folder: ptr.folder, kind: "others", keep: open, mode });
                return `${r.deleted.length} timeline${r.deleted.length === 1 ? "" : "s"} ${mode === "recycle" ? "sent to the recycle bin" : "erased"}.`;
            }));
    }
    items.push(act("project", `🗑 Delete the WHOLE project folder “${info.folder}” (${info.files} files, ${fmtBytes(info.bytes)})`,
        `the folder “${info.folder}” and everything in it: clips, drafts, timelines, versions (${info.files} files, ${fmtBytes(info.bytes)}).`,
        async (mode) => {
            await folderPost("/avfx/clip_populator/project_delete", { folder: ptr.folder, kind: "project", mode });
            detachProjectPointer();
            return `Project folder “${info.folder}” ${mode === "recycle" ? "sent to the recycle bin" : "erased"}.`;
        }));
    showPopup(anchor, items, `Project “${info.name}” — erased for good, or sent to the recycle bin:`);
}
function openClearMenu(anchor) {
    const { planned, total } = clipCounts();
    const armed = {};
    const mk = (kind, text) => ({
        text, color: "#fca5a5", keep: true,
        onClick: (row, pop) => {
            if (!armed[kind]) {
                for (const k of Object.keys(armed)) armed[k] = false;
                armed[kind] = true;
                row.textContent = "⚠ Click again to confirm: " + text;
                return true;
            }
            try {
                const n = clearClips(kind);
                row.textContent = `Removed ${n} clip${n === 1 ? "" : "s"}.`;
                row.style.color = "#86efac";
            } catch (err) {
                row.textContent = "Error: " + (err?.message || err);
            }
            setTimeout(closePopup, 1400);
            return true;
        },
    });
    const items = [];
    if (planned) items.push(mk("planned", `Remove all planned clips (${planned})`));
    if (total) items.push(mk("all", `Remove ALL clips, planned and made (${total})`));
    if (!items.length) items.push({ text: "The timeline has no clips." });
    items.push({
        text: "🗂 Delete timeline / project folders ▸", color: "#fca5a5", keep: true,
        onClick: () => { void openFolderMenu(anchor); return true; },
    });
    showPopup(anchor, items, "Clear the V1 track (made files stay on disk):");
}

// Our toolbar buttons take the size and font of the timeline's own "+ add" button, so none is bigger
// or bolder than its neighbours; Clear is red and Go to is green.
function sizeToolbarButtons(ref) {
    if (!ref || !ui) return;
    const cs = getComputedStyle(ref);
    nativeLook = { bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopColor };
    const copy = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight",
        "paddingBottom", "paddingLeft", "height", "minHeight", "borderRadius", "boxSizing", "textTransform"];
    const set = (el, prop, val) => el.style.setProperty(prop, val, "important");
    const kebab = (k) => k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
    const btns = [ui.songBtn, ui.movieBtn, ui.groupsBtn, ui.huntBtn, ui.clearBtn, ui.goBtn].filter(Boolean);
    for (const b of btns) {
        for (const k of copy) {
            const v = cs[k];
            if (v && v !== "auto" && v !== "normal" || k === "fontWeight" || k === "lineHeight") set(b, kebab(k), v);
        }
        set(b, "display", "inline-flex");
        set(b, "flex-direction", "row");
        set(b, "align-items", "center");
        set(b, "justify-content", "center");
        set(b, "gap", "5px");
        set(b, "white-space", "nowrap");
        set(b, "width", "auto");
        set(b, "min-width", "0");
        set(b, "max-width", "none");
        set(b, "flex", "none");
        set(b, "margin-left", "6px");
    }
    const tint = (b, bg, border, fg) => {
        if (!b) return;
        set(b, "background", bg);
        set(b, "border", "1px solid " + border);
        set(b, "color", fg);
        set(b, "opacity", "1");
    };
    tint(ui.clearBtn, "#7f1d1d", "#ef4444", "#fecaca");
    tint(ui.goBtn, "#14532d", "#22c55e", "#bbf7d0");
    applyPanelState();
    const arrow = ui.goBtn?.querySelector("span");
    if (arrow) arrow.style.color = "#4ade80";
}

function updateSongLabel() {
    if (!ui?.songBtn) return;
    const { sec } = getSongSeconds(findTimelineNode());
    const b = ui.songBtn;
    if (openWhich === "song") {
        // panel open: lime/yellow-green, same idea as the other buttons' "on" colours
        b.textContent = sec > 0.5 ? `🎵 Song (${formatMMSS(sec)})` : "🎵 Song";
        b.style.background = "linear-gradient(90deg,#84cc16,#a3e635)";
        b.style.color = "#1a2e05";
        b.style.borderColor = "#bef264";
        b.style.opacity = "1";
    } else if (sec > 0.5) {
        b.textContent = `🎵 Song (${formatMMSS(sec)})`;
        b.style.background = "linear-gradient(90deg,#5b21b6,#6d28d9)";
        b.style.color = "#ffffff";
        b.style.borderColor = "#8b5cf6";
        b.style.opacity = "1";
    } else {
        b.textContent = "🎵 Song";
        b.style.background = offLook().bg;
        b.style.color = offLook().fg;
        b.style.borderColor = offLook().border;
        b.style.opacity = "1";
    }
}

// ---------------------------------------------------------------------------
// ✨ on the timeline's empty space (hover): fill the hole with a bridge, then draft alternatives.
// It presses the timeline's own "+" (arms a bridge between the clips either side) and "+ plan", then hunts the
// new planned clip: nothing here re-implements how the timeline plans a clip.
// ---------------------------------------------------------------------------
const GAPFILL_ATTR = "data-obvpm-gapfill";
let gapFillBusy = false;
function notify(severity, summary, detail) {
    try { app.extensionManager?.toast?.add?.({ severity, summary, detail, life: 9000 }); }
    catch (_) { console.log("[obvpm]", summary, detail || ""); }
}
const planIdsNow = () => new Set((readTimeline(findTimelineNode()).obj.plans || []).map((p) => p.id));
const v1HasPlan = (id) => {
    const v1 = (readTimeline(findTimelineNode()).obj.tracks || []).find((t) => t.id === "V1")?.clips || [];
    return v1.some((c) => c.plan === id);
};
async function waitFor(fn, ms = 10000, step = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const v = fn();
        if (v) return v;
        await sleep(step);
    }
    return null;
}
// the prompts the Movie/Song panels would use, without touching the clipboard
async function promptListQuiet() {
    let text = "";
    try {
        const pop = findPopulatorNode();
        if (pop) text = (await getPromptText(pop, false)) || "";
    } catch (_) {}
    if (!text.trim()) {
        for (const n of app.graph?._nodes || []) {
            if (n.type === "PixaromaPauseText" || n.comfyClass === "PixaromaPauseText") {
                const t = extractTextFromNode(n);
                if (t && t.trim().length > 10) { text = t; break; }
            }
        }
    }
    return text.split(/\n\s*-{3,}\s*\n/).map((x) => x.trim()).filter(Boolean);
}
// a planned clip's prompt, where the plan keeps it (the workflow node input it was planned from) and as it is shown
function setPlanPrompt(planId, text) {
    const tl = findTimelineNode();
    const doc = readTimeline(tl).obj;
    const plan = (doc.plans || []).find((p) => p.id === planId);
    if (!plan) return false;
    const at = plan.prompt_at;
    if (!(at && at.node != null)) return false;
    plan.values = plan.values || {};
    const key = String(at.node);
    plan.values[key] = plan.values[key] || {};
    plan.values[key][at.input || "value"] = text;
    plan.prompt_full = text;
    plan.prompt = text.replace(/\s+/g, " ").trim().slice(0, 300);
    applySequenceToTimeline(tl, JSON.stringify(doc), null);
    return true;
}
const snip = (t, n = 70) => { const x = String(t || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };
// a small editor window for a prompt: resolves to the text, or null when cancelled
function openPromptEditor({ title, initial, sources = [] }) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;";
        const box = document.createElement("div");
        box.style.cssText = "width:min(680px,92vw);max-height:88vh;display:flex;flex-direction:column;gap:8px;padding:14px;" + UI_PANEL_CSS;
        const head = document.createElement("div");
        head.textContent = title || "Prompt";
        head.style.cssText = "font-weight:600;font-size:14px;";
        const bar = document.createElement("div");
        bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;";
        const ta = document.createElement("textarea");
        ta.value = initial || "";
        ta.spellcheck = true;
        ta.style.cssText = "width:100%;min-height:200px;height:260px;resize:vertical;box-sizing:border-box;background:#14161a;color:#f3f4f6;border:1px solid #4b5563;border-radius:6px;padding:8px;font:13px/1.45 sans-serif;outline:none;";
        const info = document.createElement("div");
        info.style.cssText = "font-size:11px;color:#9ca3af;display:flex;justify-content:space-between;gap:8px;";
        const stat = document.createElement("span");
        const hint = document.createElement("span");
        hint.textContent = "Ctrl+Enter = use this prompt · Esc = cancel";
        info.append(stat, hint);
        const upd = () => {
            const t = ta.value.trim();
            stat.textContent = `${t ? t.split(/\s+/).length : 0} words · ${ta.value.length} characters`;
        };
        ta.addEventListener("input", upd);
        const mkBtn = (label, css, fn, tip) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = label;
            if (tip) b.title = tip;
            b.style.cssText = "cursor:pointer;border-radius:5px;padding:4px 10px;font:12px sans-serif;border:1px solid #4b5563;background:#2d3340;color:#e5e7eb;" + (css || "");
            b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); fn(); ta.focus(); });
            return b;
        };
        const lbl = document.createElement("span");
        lbl.textContent = "Fill from:";
        lbl.style.cssText = "color:#9ca3af;font-size:11px;";
        if (sources.length) bar.appendChild(lbl);
        for (const src of sources) bar.appendChild(mkBtn(src.label, "", () => { ta.value = src.text; upd(); }, snip(src.text, 200)));
        const tools = document.createElement("div");
        tools.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;align-items:center;";
        tools.append(
            mkBtn("Tidy", "", () => { ta.value = ta.value.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim(); upd(); }, "Trim spaces and collapse blank lines"),
            mkBtn("One line", "", () => { ta.value = ta.value.replace(/\s+/g, " ").trim(); upd(); }, "Join everything into a single line"),
            mkBtn("Quote-safe", "", () => { ta.value = ta.value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); upd(); }, "Straight quotes instead of curly ones"),
            mkBtn("Clear", "", () => { ta.value = ""; upd(); }),
        );
        const foot = document.createElement("div");
        foot.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";
        let closed = false;
        const close = (val) => {
            if (closed) return;
            closed = true;
            window.removeEventListener("keydown", onKey, true);
            overlay.remove();
            resolve(val);
        };
        const ok = () => { const t = ta.value.trim(); close(t || null); };
        foot.append(
            mkBtn("Cancel", "", () => close(null)),
            mkBtn("Use this prompt", "background:#4d7c0f;border-color:#84cc16;color:#fff;font-weight:600;", ok),
        );
        const onKey = (e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
            else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); ok(); }
            else if (overlay.contains(e.target)) e.stopPropagation();   // keep ComfyUI's shortcuts out of the box
        };
        window.addEventListener("keydown", onKey, true);
        for (const t of ["keyup", "keypress"]) ta.addEventListener(t, (e) => e.stopPropagation());
        overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(null); });
        box.append(head, bar, ta, tools, info, foot);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        upd();
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
    });
}
// ask which prompt the new clip gets; resolves to a text, or null = keep the workflow's
function choosePlanPrompt(anchor, pos, list, rec, extras = []) {
    return new Promise((resolve) => {
        const items = [];
        let typing = false;
        const mine = list[pos - 1];
        if (mine) items.push({ text: `📋 Prompt ${pos} of your list (clip ${pos}): “${snip(mine)}”`, onClick: () => { resolve(mine); } });
        for (const x of extras) items.push({ text: `${x.label}: “${snip(x.text)}”`, onClick: () => { resolve(x.text); } });
        items.push({ text: `Keep the workflow's current prompt: “${snip(rec.prompt)}”`, onClick: () => { resolve(null); } });
        items.push({
            divider: true,
            text: "✏ Write or edit a prompt…",
            onClick: () => {
                typing = true;
                const sources = [];
                if (mine) sources.push({ label: `List prompt ${pos}`, text: mine });
                for (const x of extras) sources.push({ label: x.label.replace(/^Same as /, "").replace(/^the /, ""), text: x.text });
                const cur = String(rec.prompt_full || rec.prompt || "").trim();
                if (cur) sources.push({ label: "Workflow's current", text: cur });
                void openPromptEditor({ title: `Prompt for the new clip (clip ${pos})`, initial: mine || cur, sources }).then(resolve);
            },
        });
        showPopup(anchor, items, `Which prompt for the new clip (clip ${pos})?`, () => { if (!typing) resolve(null); });
    });
}
// the workflow's own prompt box (the "H3 REF2VA Input" node's prompt); the plan copies it when it is planned
function workflowPromptWidget() {
    const nodes = app.graph?._nodes || [];
    const plans = readTimeline(findTimelineNode()).obj.plans || [];
    const at = plans.map((p) => p.prompt_at).find((x) => x && x.node != null && !String(x.node).includes(":"));
    const node = (at && nodes.find((n) => String(n.id) === String(at.node)))
        || nodes.find((n) => String(n.id) === "761" || n.title === "H3 REF2VA Input");
    if (!node) return null;
    const w = (at && node.widgets?.find((x) => x.name === at.input)) || node.widgets?.find((x) => x.name === "value" || x.name === "prompt");
    return w ? { node, w } : null;
}
function setWorkflowPrompt(h, text) {
    h.w.value = text;
    try { h.w.callback?.(text); } catch (_) {}
    h.node.setDirtyCanvas?.(true, true);
}
// where this empty space is on V1: its place in the list, the planned clips either side and its clip number
function gapNeighbours(plusBtn) {
    const block = plusBtn.closest ? plusBtn.closest('[data-obvpm-gap="1"]') : null;
    const blocks = [...document.querySelectorAll('[data-obvpm-gap="1"]')];
    const v1 = (readTimeline(findTimelineNode()).obj.tracks || []).find((t) => t.id === "V1")?.clips || [];
    const gaps = v1.map((c, i) => (c.gap != null ? i : -1)).filter((i) => i >= 0);
    const bi = block ? blocks.indexOf(block) : -1;
    const at = bi >= 0 && gaps.length === blocks.length ? gaps[bi] : -1;
    if (at < 0) return { at: -1, pos: 1, extras: [] };
    const plansById = new Map((readTimeline(findTimelineNode()).obj.plans || []).map((p) => [p.id, p]));
    const extras = [];
    for (const [k, label] of [[at - 1, "Same as the clip before"], [at + 1, "Same as the clip after"]]) {
        const p = v1[k] && v1[k].plan ? plansById.get(v1[k].plan) : null;
        const t = String(p?.prompt_full || p?.prompt || "").trim();
        if (t) extras.push({ label: `${label} (plan ${p.n})`, text: t });
    }
    return { at, pos: at + 1, extras };
}
async function fillGap(plusBtn) {
    if (gapFillBusy) return;
    const bi0 = (() => { const b = plusBtn.closest ? plusBtn.closest('[data-obvpm-gap="1"]') : null; return b ? [...document.querySelectorAll('[data-obvpm-gap="1"]')].indexOf(b) : -1; })();
    // the timeline redraws while the popup is open, so the "+" we were given may be detached: find the live one again
    const freshPlus = () => {
        if (plusBtn.isConnected) return plusBtn;
        const b = bi0 >= 0 ? document.querySelectorAll('[data-obvpm-gap="1"]')[bi0] : null;
        return b?.querySelector("button") || plusBtn;
    };
    if (!findTimelineNode()) return notify("warn", "No timeline", "The H3Timeline node was not found.");
    gapFillBusy = true;
    let restore = null;
    try {
        // 1. which prompt? (asked first: the plan copies the workflow's prompt box at the moment it is planned,
        //    so it holds the chosen one itself, and clicking the clip later loads it back as any plan's)
        const hold = workflowPromptWidget();
        const nb = gapNeighbours(plusBtn);
        const list = await promptListQuiet();
        const now = String(hold?.w.value ?? "");
        const anchor = plusBtn.isConnected ? plusBtn : (ui?.huntBtn || document.body);
        const text = await choosePlanPrompt(anchor, nb.pos, list, { prompt: now, prompt_full: now }, nb.extras);
        if (text && hold && text !== now) {
            restore = { hold, was: now };
            setWorkflowPrompt(hold, text);
            await sleep(250);
        } else if (text && !hold) {
            notify("warn", "Prompt box not found", "The prompt box (H3 REF2VA Input) was not found, so the plan keeps what the workflow has.");
        }
        const before = planIdsNow();
        notify("info", "Filling the empty space", "Planning a bridge between the clips on either side...");
        // pressed look = this space is already armed: a second click would clear it
        const plus = freshPlus();
        const armed = plus.style.boxShadow && plus.style.boxShadow !== "none";
        if (!armed) { plus.click(); await sleep(600); }
        const add = document.querySelector('[data-obvpm="plan-add"]');
        if (!add) return notify("warn", "Not planned", "The timeline's \"+ plan\" button was not found.");
        add.click();
        const rec = await waitFor(() => (readTimeline(findTimelineNode()).obj.plans || []).find((p) => !before.has(p.id)), 5000);
        if (restore) { setWorkflowPrompt(restore.hold, restore.was); restore = null; }   // the workflow is as it was; the plan keeps its own
        if (!rec) {
            // the usual reason: planning keeps a copy of the workflow's generation part, and that part is switched off
            const off = allGroups().filter((g) => /generation|first stage|upscale|refine|timeline/i.test(String(g.title)) && groupState(g).state !== "on")
                .map((g) => String(g.title));
            return notify("warn", "Not planned",
                "The timeline refused to plan a clip (see its message). Planning needs the generation part of the workflow switched on"
                + (off.length ? `; switched off right now: ${off.join(", ")}. Switch them on in the Groups panel, then press ✨ again.` : "."));
        }
        if (!(await waitFor(() => v1HasPlan(rec.id)))) return notify("warn", "Not planned", "The planned clip did not appear on V1.");
        const both = !!(rec.cont && rec.cont.prev && rec.cont.next);
        // belt and braces: if the plan still does not hold the chosen prompt, write it into the plan itself
        if (text) {
            const fresh = (readTimeline(findTimelineNode()).obj.plans || []).find((p) => p.id === rec.id);
            if (fresh && String(fresh.prompt_full || "").trim() !== text.trim()) {
                if (setPlanPrompt(rec.id, text)) await sleep(900);
            }
        }
        await huntClip(rec.id, true);
        notify("success", both ? "Bridge planned and drafting" : "Planned and drafting",
            `plan ${rec.n}: ${both ? "joined to the clips on both sides" : "not joined on both sides"}, drafts queued. Its takes appear in the Result Preview.`);
    } catch (err) {
        notify("error", "Fill failed", String(err?.message || err));
    } finally {
        if (restore) { try { setWorkflowPrompt(restore.hold, restore.was); } catch (_) {} }
        gapFillBusy = false;
    }
}
// ---- clip numbers: "clip N" on every box of V1, left to right; an empty space takes a number too ----
const CLIPNO_ATTR = "data-obvpm-clipno";
function v1Entries() {
    try { return (readTimeline(findTimelineNode()).obj.tracks || []).find((t) => t.id === "V1")?.clips || []; } catch (_) { return []; }
}
// the clip number of a planned clip: its place on V1 counted from 1, empty spaces included
function clipNoOfPlan(id) {
    const i = v1Entries().findIndex((c) => c && c.plan === id);
    return i >= 0 ? i + 1 : null;
}
function numberClips() {
    const first = document.querySelector('[data-obvpm="clip-title"]');
    const gap1 = document.querySelector('[data-obvpm-gap="1"]');
    const strip = first?.parentElement?.parentElement || gap1?.parentElement;
    if (!strip) return;
    const blocks = [...strip.children].filter((el) => el.dataset && el.dataset.obvpmFrames !== undefined);
    blocks.forEach((block, i) => {
        const isGap = block.dataset.obvpmGap === "1";
        const row = isGap ? null : block.querySelector(':scope > [data-obvpm="clip-title"]');
        if (!isGap && !row) return;
        // wide enough: "clip 6" with room reserved in the title bar; narrow: just the number, over the corner
        const w = block.offsetWidth || 0;
        const wide = w >= 150;
        const text = w >= 62 || !w ? `clip ${i + 1}` : String(i + 1);
        let chip = block.querySelector(":scope > [" + CLIPNO_ATTR + "]");
        if (!chip) {
            chip = document.createElement("span");
            chip.setAttribute(CLIPNO_ATTR, "1");
            chip.title = "Clip number on the timeline, counted from the left (empty spaces count too)";
            chip.style.cssText = "position:absolute;z-index:5;pointer-events:none;user-select:none;white-space:nowrap;font:600 9px/13px sans-serif;border-radius:3px;padding:0 5px;height:13px;box-sizing:border-box;background:rgba(0,0,0,.55);color:#fff;";
            block.appendChild(chip);
        }
        if (chip.textContent !== text) chip.textContent = text;
        if (isGap) {
            chip.style.top = "2px";
            chip.style.left = "4px";
            return;
        }
        if (row.dataset.obvpmPad0 === undefined) row.dataset.obvpmPad0 = String(parseFloat(getComputedStyle(row).paddingLeft) || 14);
        const pad0 = parseFloat(row.dataset.obvpmPad0);
        const th = row.offsetHeight || 18;
        chip.style.top = Math.max(0, Math.round((th - 13) / 2)) + "px";
        chip.style.left = Math.max(2, Math.round(pad0 - 6)) + "px";
        // room for it in front of the name, only where the name still has plenty of space
        const want = wide ? pad0 + chip.offsetWidth - 2 : pad0;
        const cur = parseFloat(row.style.paddingLeft);
        if (!(Math.abs(cur - want) < 0.5)) row.style.paddingLeft = want + "px";
    });
}
function injectGapButtons() {
    for (const block of document.querySelectorAll('[data-obvpm-gap="1"]')) {
        if (block.querySelector("[" + GAPFILL_ATTR + "]")) continue;
        const btns = [...block.querySelectorAll("button")];
        const plus = btns.find((b) => b.textContent.trim() === "+");
        if (!plus) continue;
        const b = document.createElement("button");
        b.setAttribute(GAPFILL_ATTR, "1");
        b.textContent = "✨";
        b.title = "Fill this empty space: plan a bridge between the clips on both sides and draft alternatives of it";
        Object.assign(b.style, {
            display: "none", alignItems: "center", justifyContent: "center", width: "22px", height: "18px",
            padding: "0", background: "rgba(77,124,15,0.95)", color: "#fff", border: "none", borderRadius: "3px",
            cursor: "pointer", font: "11px/1 sans-serif", marginBottom: "3px",
        });
        plus.insertAdjacentElement("afterend", b);
        // ✨ follows the timeline's own "+": it is shown whenever "+" is (hover, or a redraw under a still mouse) and the
        // timeline offers a bridge here (clips with context on both sides); while this space is the armed run the timeline
        // draws its own "+ plan", so ✨ stays out of the way and the pressed "+" (which only clears the bridge) shows as ✕
        const sync = () => {
            const armed = !!plus.style.boxShadow && plus.style.boxShadow !== "none";
            const glyph = armed ? "\u2715" : "+";
            if (plus.textContent !== glyph) {
                plus.textContent = glyph;
                plus.style.font = (armed ? "9px" : "13px") + "/1 sans-serif";
            }
            const shown = plus.style.display !== "none" && plus.style.cursor === "pointer" && block.dataset.obvpmRunHere !== "1";
            b.style.display = shown ? "flex" : "none";
        };
        try {
            const mo = new MutationObserver(sync);
            mo.observe(plus, { attributes: true, attributeFilter: ["style"] });
            mo.observe(block, { attributes: true, attributeFilter: ["data-obvpm-run-here"] });
        } catch (_) {}
        block.addEventListener("mouseenter", sync);
        block.addEventListener("mouseleave", sync);
        sync();
        for (const t of ["mousedown", "pointerdown", "mouseup", "pointerup", "dragstart"]) {
            b.addEventListener(t, (ev) => { ev.stopPropagation(); if (t === "dragstart") ev.preventDefault(); });
        }
        b.addEventListener("click", (ev) => { ev.stopPropagation(); void fillGap(plus); });
    }
}

function injectSongToolbar() {
    if (ui && ui.songBtn.isConnected && ui.movieBtn?.isConnected && ui.moviePanel?.isConnected
            && ui.groupsBtn?.isConnected && ui.groupsPanel?.isConnected
            && ui.huntBtn?.isConnected && ui.huntPanel?.isConnected
            && ui.clearBtn?.isConnected && ui.goBtn?.isConnected) {
        if (openWhich === "groups") renderGroupsList();
        if (openWhich === "hunt") renderHuntList();
        updateSongLabel();
        return;
    }
    ui?.panel?.remove?.();
    ui?.moviePanel?.remove?.();
    ui?.groupsPanel?.remove?.();
    ui?.movieBtn?.remove?.();
    ui?.groupsBtn?.remove?.();
    ui?.huntPanel?.remove?.();
    ui?.huntBtn?.remove?.();
    ui?.clearBtn?.remove?.();
    ui?.goBtn?.remove?.();
    closePopup();
    ui = null;
    for (const r of findAllRoots()) {
        const addBtn = Array.from(r.querySelectorAll ? r.querySelectorAll("button") : [])
            .find((b) => b.textContent && b.textContent.trim() === "+ add");
        if (!addBtn || !addBtn.parentElement) continue;

        const bar = addBtn.parentElement;
        const songBtn = document.createElement("button");
        songBtn.id = TOGGLE_ID;
        songBtn.type = "button";
        songBtn.style.cssText = [
            "margin-left: 6px", "padding: 4px 10px", "border-radius: 5px", "font-size: 12px",
            "font-weight: 600", "cursor: pointer", "border: 1px solid #555", "transition: all 0.15s ease",
        ].join(";");
        addBtn.insertAdjacentElement("afterend", songBtn);

        const movieBtn = document.createElement("button");
        movieBtn.id = MOVIE_TOGGLE_ID;
        movieBtn.type = "button";
        movieBtn.textContent = "🎬 Movie";
        movieBtn.style.cssText = [
            "margin-left: 6px", "padding: 4px 10px", "border-radius: 5px", "font-size: 12px",
            "font-weight: 600", "cursor: pointer", "border: 1px solid #444", "transition: all 0.15s ease",
        ].join(";");
        songBtn.insertAdjacentElement("afterend", movieBtn);

        const groupsBtn = document.createElement("button");
        groupsBtn.id = GROUPS_TOGGLE_ID;
        groupsBtn.type = "button";
        groupsBtn.textContent = "🔀 Groups";
        groupsBtn.style.cssText = movieBtn.style.cssText;
        movieBtn.insertAdjacentElement("afterend", groupsBtn);

        const huntBtn = document.createElement("button");
        huntBtn.id = HUNT_TOGGLE_ID;
        huntBtn.type = "button";
        huntBtn.textContent = "🎯 Hunt clip";
        huntBtn.style.cssText = movieBtn.style.cssText;
        groupsBtn.insertAdjacentElement("afterend", huntBtn);

        const clearBtn = document.createElement("button");
        clearBtn.id = CLEAR_TOGGLE_ID;
        clearBtn.type = "button";
        clearBtn.textContent = "🗑 Clear ▾";
        clearBtn.title = "Remove clips from the V1 track in one go";
        clearBtn.style.cssText = movieBtn.style.cssText;
        huntBtn.insertAdjacentElement("afterend", clearBtn);

        const goBtn = document.createElement("button");
        goBtn.id = GO_TOGGLE_ID;
        goBtn.type = "button";
        goBtn.innerHTML = '<span style="color:#4ade80;">➜</span> Go to ▾';
        goBtn.title = "Jump the canvas to a group";
        goBtn.style.cssText = movieBtn.style.cssText;
        goBtn.style.opacity = "1";
        goBtn.style.color = "#e5e7eb";
        clearBtn.insertAdjacentElement("afterend", goBtn);

        const panel = buildPanel();
        const moviePanel = buildMoviePanel();
        bar.parentElement.insertBefore(panel, bar.nextSibling);
        bar.parentElement.insertBefore(moviePanel, panel.nextSibling);
        const groupsPanel = buildGroupsPanel();
        bar.parentElement.insertBefore(groupsPanel, moviePanel.nextSibling);
        const huntPanel = buildHuntPanel();
        bar.parentElement.insertBefore(huntPanel, groupsPanel.nextSibling);
        ui = { songBtn, panel, movieBtn, moviePanel, groupsBtn, groupsPanel, huntBtn, huntPanel, clearBtn, goBtn };
        sizeToolbarButtons(addBtn);
        setTimeout(() => sizeToolbarButtons(addBtn), 400);
        applyPanelState();
        break;
    }
    updateSongLabel();
}

// The timeline swallows mouse events inside its own UI, so our buttons never saw them.
// Listen on window in the capture phase (runs first) and handle clicks for our controls here.
function bindGlobalHandlers() {
    if (window.__obvpmSongBound) return;
    window.__obvpmSongBound = true;
    const types = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu", "keydown", "keyup", "keypress"];
    for (const t of types) {
        window.addEventListener(t, (e) => {
            const path = e.composedPath ? e.composedPath() : [];
            if (!path.some((el) => el && (el.id === PANEL_ID || el.id === TOGGLE_ID
                    || el.id === MOVIE_PANEL_ID || el.id === MOVIE_TOGGLE_ID
                    || el.id === GROUPS_PANEL_ID || el.id === GROUPS_TOGGLE_ID
                    || el.id === HUNT_PANEL_ID || el.id === HUNT_TOGGLE_ID
                    || el.id === CLEAR_TOGGLE_ID || el.id === GO_TOGGLE_ID
                    || (el.hasAttribute && el.hasAttribute("data-obvpm-master-tl"))))) return;
            e.stopPropagation();           // keep the timeline from reacting; default actions still work
            if (t !== "click") return;
            if (path.some((el) => el && el.id === RUN_ID)) {
                e.preventDefault();
                runSongPopulate();
            } else if (path.some((el) => el && el.id === MOVIE_RUN_ID)) {
                e.preventDefault();
                runMoviePopulate();
            } else if (path.some((el) => el && el.id === TOGGLE_ID)) {
                e.preventDefault();
                togglePanel("song");
            } else if (path.some((el) => el && el.id === MOVIE_TOGGLE_ID)) {
                e.preventDefault();
                togglePanel("movie");
            } else if (path.some((el) => el && el.id === GROUPS_TOGGLE_ID)) {
                e.preventDefault();
                togglePanel("groups");
            } else if (path.some((el) => el && el.id === CLEAR_TOGGLE_ID)) {
                e.preventDefault();
                if (popupEl) closePopup(); else openClearMenu(ui.clearBtn);
            } else if (path.some((el) => el && el.id === GO_TOGGLE_ID)) {
                e.preventDefault();
                if (popupEl) closePopup(); else openGoMenu(ui.goBtn);
            } else if (path.some((el) => el && el.id === HUNT_TOGGLE_ID)) {
                e.preventDefault();
                togglePanel("hunt");
            } else {
                const hrun = path.find((el) => el && el.dataset && el.dataset.obvpmHrun !== undefined);
                const hsel = path.find((el) => el && el.dataset && el.dataset.obvpmHsel !== undefined);
                const act = path.find((el) => el && el.dataset && el.dataset.obvpmAct);
                const mm = path.find((el) => el && el.dataset && el.dataset.obvpmMode);
                const pick = path.find((el) => el && el.dataset && el.dataset.obvpmPick !== undefined);
                const go = path.find((el) => el && el.dataset && el.dataset.obvpmGo !== undefined);
                const row = path.find((el) => el && el.dataset && el.dataset.obvpmGrp !== undefined);
                if (hrun || hsel || path.some((el) => el && el.dataset && (el.dataset.obvpmHall !== undefined
                        || el.dataset.obvpmHnew !== undefined || el.dataset.obvpmHopen !== undefined))) {
                    e.preventDefault();
                    huntHandle(path);
                } else if (mm) {
                    e.preventDefault();
                    applyMasterMode(mm.dataset.obvpmMode);
                    quietNote = mm.dataset.obvpmMode === "llm" ? "LLM layout applied." : "Timeline layout applied.";
                    renderGroupsList();
                    paintMasterBox();
                } else if (path.some((el) => el && el.dataset && el.dataset.obvpmPin !== undefined)) {
                    e.preventDefault();
                    const pe = path.find((el) => el && el.dataset && el.dataset.obvpmPin !== undefined);
                    const g = allGroups()[parseInt(pe.dataset.obvpmPin, 10)];
                    if (g) { quietNote = pinLayout(g); renderGroupsList(); }
                } else if (go) {
                    e.preventDefault();
                    gotoGroup(allGroups()[parseInt(go.dataset.obvpmGo, 10)]);
                } else if (pick) {
                    e.preventDefault();
                    const g = allGroups()[parseInt(pick.dataset.obvpmPick, 10)];
                    if (g) {
                        setGroupAction(g, groupActionFor(g) === "mute" ? "bypass" : "mute");
                        renderGroupsList();
                    }
                } else if (act && act.dataset.obvpmAct === "diag") {
                    e.preventDefault();
                    const lines = diagnoseConnections();
                    quietNote = lines.length ? "Missing connections found:\n" + lines.join("\n") : "✅ No required input is missing a connection.";
                    renderGroupsList();
                } else if (act) {
                    e.preventDefault();
                    groupsAction = act.dataset.obvpmAct === "mute" ? "mute" : "bypass";
                    saveGroupPref("action", groupsAction);
                    for (const g of allGroups()) setGroupAction(g, groupsAction);
                    renderGroupsList();
                } else if (row) {
                    e.preventDefault();
                    const g = allGroups()[parseInt(row.dataset.obvpmGrp, 10)];
                    if (g) {
                        // on or half-on: switch it off; off: switch it back on;
                        // Shift-click: everything on, forgetting how it was
                        let turnedOn;
                        if (e.shiftKey) {
                            forceGroupOn(g);
                            turnedOn = true;
                        } else {
                            pruneGroupMemory();
                            const st = groupState(g).state;
                            setGroupOn(g, st === "off");
                            turnedOn = st === "off";
                        }
                        // a hand-made switch ends Auto-quiet's claim on this group
                        delete autoOffMemory()[groupKey(g)];
                        const layoutMsg = turnedOn ? applyLayout(g) : undoLayout(g);
                        quietNote = "";
                        quietPass();
                        if (layoutMsg) quietNote = layoutMsg + (quietNote ? "\n" + quietNote : "");
                        renderGroupsList();
                    }
                }
            }
        }, true);
    }
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------
app.registerExtension({
    name: "AVFX.ClipPopulator.UI",
    setup() {
        bindGlobalHandlers();
        bindSaveAsButton();
        watchSeamMenus();
        watchProjectDialog();
        watchClipMenu();
        watchClipPreview();
        bindStartGapPlus();
        hookHuntRuns();
        setInterval(() => { injectSongToolbar(); try { injectGapButtons(); numberClips(); tuneStartGap(); injectFolderButton(); injectTimelineMaster(); paintMasterBox(); } catch (_) {} }, 1200);
        // the timeline redraws its empty spaces on every edit: put ✨ back at once
        try {
            let queued = false;
            new MutationObserver(() => {
                if (queued) return;
                queued = true;
                requestAnimationFrame(() => { queued = false; try { injectGapButtons(); numberClips(); tuneStartGap(); injectTimelineMaster(); paintMasterBox(); } catch (_) {} });
            }).observe(document.body, { childList: true, subtree: true });
        } catch (_) {}

        // fired by the node when the workflow runs
        api.addEventListener("avfx_populate_timeline_now", async ({ detail }) => {
            if (!detail) return;
            const res = await runTimelinePopulation(detail);
            alert(res.ok ? res.message : "Failed to populate H3Timeline: " + res.message);
        });
    },
    loadedGraphNode(node) {
        if (node.comfyClass === "AVFX_AutoClipPopulator") {
            setTimeout(() => lockPopulatorDefaults(node), 50);
        }
    },
    nodeCreated(node) {
        if (node.comfyClass !== "AVFX_AutoClipPopulator") return;
        setTimeout(() => lockPopulatorDefaults(node), 50);
        const btn = node.addWidget("button", "Auto-Populate H3Timeline Clips", null, async () => {
            const packed = await getPromptText(node);
            const hasSong = getSongSeconds(findTimelineNode(), { forceDom: true }).sec > 0.5;
            if ((!packed || !packed.trim()) && !hasSong) {
                alert("Copy your '---' prompts (Ctrl+A, Ctrl+C inside Pause Text) first, then click Auto-Populate H3Timeline Clips!");
                return;
            }
            const getW = (name, def) => {
                const w = node.widgets?.find(x => x.name === name);
                return w ? w.value : def;
            };
            const res = await runTimelinePopulation({
                packed_prompts: packed,
                duration: getW("clip_duration", 15.0),
                base_seed: getW("base_seed", 1000),
                overlap_window: getW("overlap_frames", 39),
                replace_existing_plans: getW("replace_existing_plans", true),
            });
            alert(res.ok ? res.message : "Failed to populate H3Timeline: " + res.message);
        });
        btn.serialize = false;
        // a way back to the timeline: the canvas jumps to the group the H3Timeline node sits in
        const go = node.addWidget("button", "➜ Go to the timeline group", null, () => gotoTimeline());
        go.serialize = false;
    },
});
