/**
 * @name Liquid Glass (glassmorphism)
 * @author scripteditorpro
 * @version 4.3.1
 * @description Adds glassmorphism to Discord, mostly for transparent themes (Translucence by CapnKitten recommended). Adds actual refraction to UI elements, with settings you can change. WARNING: might lag. Change the settings to make it smoother if needed.
 */
"use strict";

const PLUGIN_ID = "TranslucenceLiquidGlass";
const SETTINGS_VERSION = 4;
const SVG_NS = "http://www.w3.org/2000/svg";
const ATTR = "data-tg-glass";
const ATTR_KIND = "data-tg-kind";
const DEFS_ID = "tg-liquid-glass-definitions";
const INNER_GROUPS = new Set(["modals", "popouts", "tooltips", "cards", "activity", "custom"]);
// a custom selector that matches more than this many elements is way too broad, we skip it
const MAX_CUSTOM_MATCHES = 30;
const BIG_OK = new Set(["modals", "settings", "panes", "custom"]);
const ROOT_VARS = ["--tg-glass-blur", "--tg-glass-refraction", "--tg-glass-specular"];
const STYLE_ID = "tg-liquid-glass-runtime";
const SAMPLES = 128;

// glass height curves from the liquid glass
const SURFACES = {
    convex_squircle: { label: "Convex squircle (iOS)", fn: x => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4) },
    convex_circle: { label: "Convex circle", fn: x => Math.sqrt(1 - Math.pow(1 - x, 2)) },
    concave: { label: "Concave", fn: x => 1 - Math.sqrt(1 - Math.pow(x, 2)) },
    lip: {
        label: "Lip",
        fn: x => {
            const convex = Math.pow(1 - Math.pow(1 - Math.min(x * 2, 1), 4), 1 / 4);
            const concave = 1 - Math.sqrt(1 - Math.pow(1 - x, 2)) + 0.1;
            const s = 6 * Math.pow(x, 5) - 15 * Math.pow(x, 4) + 10 * Math.pow(x, 3);
            return convex * (1 - s) + concave * s;
        }
    }
};

// the groups of stuff it puts glass on.
// lower rank wins if two glass things overlap. a glass parent blinds
// everything inside it, so only one of them can actually refract the bg
const GROUPS = {
    modals: {
        label: "Modals & dialogs", rank: 0,
        selectors: [
            "#app-mount [class*='modal_']:not([class*='modalContent'])",
            "#app-mount [class*='root_'][class*='fullscreenOnMobile']",
            "#app-mount .user-profile-modal"
        ]
    },
    popouts: {
        label: "Popouts, menus & user cards", rank: 1,
        selectors: [
            "#app-mount [class*='menu_']",
            "#app-mount [class*='popout_']",
            "#app-mount [class*='userPopoutOuter']",
            "#app-mount [class*='userProfileOuter']",
            "#app-mount .user-profile-popout"
        ]
    },
    tooltips: {
        label: "Tooltips", rank: 1,
        selectors: ["#app-mount [class*='tooltip_']:not([class*='tooltipPointer']):not([class*='tooltipContent'])"]
    },
    composer: {
        label: "Message bar", rank: 2,
        selectors: [
            "#app-mount [class*='channelTextArea'] [class*='scrollableContainer']",
            "#app-mount form [class*='channelTextArea']:not(:has([class*='scrollableContainer']))"
        ]
    },
    cards: {
        label: "Cards & embeds", rank: 3,
        selectors: ["#app-mount [class*='card_']", "#app-mount [class*='embedWrapper']"]
    },
    activity: {
        label: "Activity / user panel", rank: 3,
        selectors: ["#app-mount [class*='activityPanel']"]
    },
    custom: { label: "Custom selectors", rank: 3, selectors: [] },
    messages: {
        label: "Messages", rank: 4,
        selectors: ["#app-mount [class*='messageListItem'] [class*='message_']"]
    },
    buttons: {
        label: "Buttons", rank: 5,
        selectors: [
            "#app-mount button[class*='lookFilled']",
            "#app-mount button[class*='lookOutlined']",
            "#app-mount [role='button'][class*='lookFilled']"
        ]
    },
    settings: {
        label: "Settings overlay (large)", rank: 8,
        selectors: [
            "#app-mount [class*='standardSidebarView']",
            "#app-mount [class*='sidebarRegion']",
            "#app-mount [class*='contentRegion']"
        ]
    },
    panes: {
        label: "Big panes: sidebar / chat / members (large)", rank: 9,
        selectors: ["#app-mount [class*='sidebar_']", "#app-mount [class*='chat_']", "#app-mount [class*='members_']"]
    }
};

const GROUP_ORDER = ["modals", "popouts", "tooltips", "composer", "cards", "activity", "messages", "buttons", "custom", "settings", "panes"];

const DEFAULTS = {
    settingsVersion: SETTINGS_VERSION,
    presetChosen: null,
    enabled: true,

    // shape
    surface: "convex_circle",
    sizeMode: "relative",   // relative (short side / divisor) or fixed (px)
    divisor: 3.5,             // 1 unit = short side / divisor
    thicknessRel: 3,        // thickness in units
    bezelRel: 0.65,         // bezel width in units
    thicknessPx: 60,
    bezelPx: 14,
    ior: 1.5,
    refraction: 1,
    maxDisplacement: 45,    // % of short side, max px a pixel can move
    quality: 1,

    // looks
    blur: 0.6,
    saturation: 1.25,
    brightness: 1.05,
    specular: 0.8,
    specularAngle: 60,
    specularWidth: 1.5,

    // where it goes
    groups: {
        modals: true, popouts: true, tooltips: false, composer: true, cards: true,
        activity: true, custom: true, messages: true, buttons: true,
        settings: false, panes: false
    },
    customSelectors: "",
    maxSurfaces: 80,
    avoidNesting: true,
    neutralizeAncestors: true,
    neutralizeInner: true,
    hotkey: true,

    // big stuff (settings, panes, anything over the threshold)
    largeThreshold: 300,    // in thousands of px² (300 is about 700x430)
    largeDetail: "lite",    // full | lite | blur
    largeQuality: 0.5,      // map res multiplier for big surfaces

    // per group overrides
    profiles: {},

    // debug
    highlight: false,
    debug: false
};

// per group geometry. "global" = just use the main shape settings
const BASE_PROFILE = {
    sizeMode: "global",     // global / relative / fixed
    divisor: 3,
    thicknessRel: 3,
    bezelRel: 0.65,
    thicknessPx: 40,
    bezelPx: 12,
    detail: "auto",         // auto / full / lite / blur
    quality: 0              // 0 = use the global one
};

const PROFILE_PRESETS = {
    messages: { sizeMode: "fixed", thicknessPx: 28, bezelPx: 10 },
    popouts: { sizeMode: "fixed", thicknessPx: 36, bezelPx: 12 },
    modals: { sizeMode: "fixed", thicknessPx: 32, bezelPx: 12 },
    cards: { sizeMode: "fixed", thicknessPx: 30, bezelPx: 11 },
    settings: { sizeMode: "fixed", thicknessPx: 24, bezelPx: 10 },
    panes: { sizeMode: "fixed", thicknessPx: 24, bezelPx: 10 }
};

// these need more than just swapping filters when they change
const FULL_REBUILD = new Set(["enabled", "neutralizeAncestors", "neutralizeInner", "avoidNesting"]);
const RESCAN = new Set(["customSelectors", "maxSurfaces"]);
const STYLE_ONLY = new Set(["highlight", "debug"]);

// presets. these get applied on top of DEFAULTS so you dont need to list everything
const PRESETS = {
    Professional: {
        tag: "Heaviest",
        desc: "Everything on, sharpest maps. Only if you have a strong GPU.",
        values: {
            quality: 2, blur: 0.4, specular: 1, specularWidth: 1.8, thicknessRel: 3.5,
            saturation: 1.3, brightness: 1.06, maxSurfaces: 160, largeQuality: 1,
            groups: { tooltips: true, settings: true }
        }
    },
    High: {
        tag: "Heavy",
        desc: "Full refraction on most things, good looking and still ok on mid PCs.",
        values: {
            quality: 1, blur: 0.6, maxSurfaces: 110, largeQuality: 0.5,
            groups: { tooltips: true }
        }
    },
    Default: {
        tag: "Balanced",
        desc: "What I use. Good mix of looks and speed.",
        values: {}
    },
    "Lite (Best)": {
        tag: "Lightest",
        desc: "Just the message bar, popouts and modals, low res maps. Best pick if you're not sure or your PC is weaker.",
        values: {
            quality: 0.5, blur: 0.4, specular: 0.6, maxSurfaces: 30, largeDetail: "blur", largeQuality: 0.25,
            groups: { messages: false, cards: false, activity: false, tooltips: false, buttons: false, settings: false, panes: false },
            profiles: {
                composer: { detail: "lite" },
                popouts: { detail: "lite" },
                modals: { detail: "lite" }
            }
        }
    }
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sgn = v => (v < 0 ? -1 : 1);

// refraction math, how far a pixel gets pushed along the bezel (snell's law)
function computeBezelTable(thickness, bezel, surfaceFn, ior) {
    const eta = 1 / ior;
    const out = new Float32Array(SAMPLES);

    for (let i = 0; i < SAMPLES; i++) {
        const x = i / SAMPLES;
        const y = surfaceFn(x);
        const dx = x < 1 ? 0.0001 : -0.0001;
        const y2 = surfaceFn(clamp(x + dx, 0, 1));
        const derivative = (y2 - y) / dx;
        const magnitude = Math.sqrt(derivative * derivative + 1);
        const nx = -derivative / magnitude;
        const ny = -1 / magnitude;

        const dot = ny;
        const k = 1 - eta * eta * (1 - dot * dot);

        if (k < 0) { out[i] = 0; continue; }

        const kSqrt = Math.sqrt(k);
        const rx = -(eta * dot + kSqrt) * nx;
        const ry = eta - (eta * dot + kSqrt) * ny;

        out[i] = rx * ((y * bezel + thickness) / ry);
    }

    let max = 0;
    for (let i = 0; i < SAMPLES; i++) max = Math.max(max, Math.abs(out[i]));

    return { table: out, max: max || 1 };
}

module.exports = class TranslucenceLiquidGlass {
    constructor() {
        // no saved config = fresh install, ask for a preset before doing anything
        let saved = null;
        try { saved = BdApi.Data.load(PLUGIN_ID, "settings"); } catch (e) { /* ignore */ }
        this.needsPreset = !saved;

        this.settings = this.loadSettings();

        this.running = false;
        this.records = new Map();       // element -> record (has glass on it)
        this.candidates = new Map();    // element -> group
        this.visible = new Set();       // candidates on / near screen
        this.filters = new Map();       // filterKey -> { id, node, refs }
        this.mapCache = new Map();      // mapKey -> maps
        this.tableCache = new Map();
        this.neutral = new Map();       // ancestor -> { prev, refs }
        this.cleanAncestors = new WeakSet();
        this.refreshQueue = [];
        this.filterCounter = 0;
    }

    // ---- settings ----
    loadSettings() {
        let saved = {};
        try { saved = BdApi.Data.load(PLUGIN_ID, "settings") || {}; } catch (e) { /* ignore */ }

        // old settings used a different scale
        const compatible = saved.settingsVersion === SETTINGS_VERSION;
        const base = compatible ? saved : { enabled: saved.enabled !== false, debug: !!saved.debug };

        const settings = { ...DEFAULTS, ...base, settingsVersion: SETTINGS_VERSION };
        settings.groups = { ...DEFAULTS.groups, ...(base.groups || {}) };
        settings.profiles = { ...(base.profiles || {}) };
        return settings;
    }

    saveSettings() {
        try { BdApi.Data.save(PLUGIN_ID, "settings", this.settings); } catch (e) { /* ignore */ }
    }

    log(...args) {
        if (this.settings.debug) console.info("[TranslucenceLiquidGlass]", ...args);
    }

    // ---- start / stop ----
    start() {
        if (this.running || this.waiting) return;

        // fresh install; show the picker first and dont touch discord yet
        if (this.needsPreset) {
            this.waiting = true;
            this.showPresetPicker();
            return;
        }

        this.begin();
    }

    begin() {
        if (this.running) return;
        this.running = true;

        this.root = document.createElementNS(SVG_NS, "svg");
        this.root.id = DEFS_ID;
        this.root.setAttribute("aria-hidden", "true");
        this.root.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
        this.defs = document.createElementNS(SVG_NS, "defs");
        this.root.appendChild(this.defs);
        document.body.appendChild(this.root);

        this.resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (this.records.has(entry.target)) this.queueRefresh(entry.target);
            }
        });

        this.intersectionObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (entry.isIntersecting) this.visible.add(entry.target);
                else this.visible.delete(entry.target);
            }
            this.queueReconcile();
        }, { rootMargin: "120px" });

        this.mutationObserver = new MutationObserver(mutations => {
            // ignore our own svg stuff
            if (mutations.every(m => this.root && this.root.contains(m.target))) return;
            this.queueScan();
        });
        this.mutationObserver.observe(document.getElementById("app-mount") || document.body, { childList: true, subtree: true });

        // ctrl + shift + g = inspect something (works while a popout is open, settings doesnt)
        this.onKey = e => {
            if (!this.settings.hotkey || !e.ctrlKey || !e.shiftKey || e.code !== "KeyG") return;
            e.preventDefault();
            this.startPicker(el => this.inspect(el));
        };
        document.addEventListener("keydown", this.onKey, true);

        this.refreshRuntimeStyle();
        this.scan();
        this.scanInterval = setInterval(() => { if (!document.hidden) this.scan(); }, 5000);

        this.log("started");
    }

    stop() {
        this.waiting = false;
        this.closePresetPicker();
        this.running = false;

        clearInterval(this.scanInterval);
        clearTimeout(this.scanTimer);
        clearTimeout(this.reconcileTimer);
        clearTimeout(this.applyTimer);
        cancelAnimationFrame(this.pumpFrame);
        this.refreshQueue = [];
        this.stopPicker();
        if (this.onKey) document.removeEventListener("keydown", this.onKey, true);
        this.onKey = null;

        this.mutationObserver?.disconnect();
        this.resizeObserver?.disconnect();
        this.intersectionObserver?.disconnect();

        for (const el of [...this.records.keys()]) this.detach(el);

        this.records.clear();
        this.candidates.clear();
        this.visible.clear();
        this.filters.clear();
        this.mapCache.clear();
        this.tableCache.clear();
        this.neutral.clear();
        this.cleanAncestors = new WeakSet();

        // put <html> back how we found it
        const rootStyle = document.documentElement.style;
        for (const name of ROOT_VARS) rootStyle.removeProperty(name);
        if (document.documentElement.getAttribute("style") === "") document.documentElement.removeAttribute("style");

        this.removeRuntimeStyle();

        this.root?.remove();
        this.root = null;
        this.defs = null;

        this.log("stopped");
    }

    // ---- finding elements ----
    queueScan() {
        if (!this.running || this.scanTimer) return;
        this.scanTimer = setTimeout(() => { this.scanTimer = null; if (!document.hidden) this.scan(); }, 250);
    }

    queueReconcile() {
        if (!this.running || this.reconcileTimer) return;
        this.reconcileTimer = setTimeout(() => { this.reconcileTimer = null; this.reconcile(); }, 30);
    }

    selectorsFor(key) {
        if (key === "custom") {
            return this.settings.customSelectors
                .split("\n").map(s => s.trim()).filter(Boolean);
        }
        return GROUPS[key].selectors;
    }

    scan() {
        if (!this.running) return;

        const found = new Map();

        if (this.settings.enabled) {
            for (const key of GROUP_ORDER) {
                if (!this.settings.groups[key]) continue;

                const selectors = this.selectorsFor(key);
                if (!selectors.length) continue;

                const lists = [];

                if (key === "custom") {
                    // check these one at a time, a too broad one (like div[class*='container_']) would put
                    // glass on half of discord and mess up the whole ui
                    for (const selector of selectors) {
                        let list;
                        try { list = document.querySelectorAll(selector); }
                        catch (err) { this.log("bad selector", selector, err.message); continue; }

                        if (list.length > MAX_CUSTOM_MATCHES) {
                            this.warnBroadSelector(selector, list.length);
                            continue;
                        }
                        lists.push(list);
                    }
                } else try { lists.push(document.querySelectorAll(selectors.join(","))); }
                catch (e) {
                    // one bad selector (prob a custom one) shouldnt break the rest
                    for (const selector of selectors) {
                        try { lists.push(document.querySelectorAll(selector)); }
                        catch (err) { this.log("bad selector", selector, err.message); }
                    }
                }

                for (const list of lists) {
                    list.forEach(el => {
                        const prior = found.get(el);
                        if (!prior || GROUPS[key].rank < GROUPS[prior].rank) found.set(el, key);
                    });
                }
            }
        }

        // new ones
        for (const [el, key] of found) {
            if (!this.candidates.has(el)) this.intersectionObserver.observe(el);
            this.candidates.set(el, key);
        }

        // ones that are gone
        for (const el of [...this.candidates.keys()]) {
            if (!found.has(el)) {
                this.candidates.delete(el);
                this.visible.delete(el);
                this.intersectionObserver.unobserve(el);
                if (this.records.has(el)) this.detach(el);
            }
        }

        this.reconcile();
    }

    warnBroadSelector(selector, count) {
        this.skippedSelectors = this.skippedSelectors || new Set();
        if (this.skippedSelectors.has(selector)) return;
        this.skippedSelectors.add(selector);

        console.warn(`[TranslucenceLiquidGlass] custom selector skipped, it matches ${count} elements (max ${MAX_CUSTOM_MATCHES}): ${selector}`);
        try { BdApi.UI.showToast(`Liquid Glass: a custom selector matches ${count} elements so it was skipped. Check the custom selectors in settings.`, { type: "warning" }); } catch (e) { /* ignore */ }
    }

    reconcile() {
        if (!this.running) return;

        // remove glass from stuff that shouldnt have it anymore
        for (const el of [...this.records.keys()]) {
            if (!el.isConnected || !this.candidates.has(el) || !this.visible.has(el)) this.detach(el);
        }

        if (!this.settings.enabled) return;

        // add glass to visible stuff, most important first
        const pending = [];
        for (const el of this.visible) {
            if (this.candidates.has(el) && !this.records.has(el) && el.isConnected) pending.push(el);
        }

        pending.sort((a, b) => GROUPS[this.candidates.get(a)].rank - GROUPS[this.candidates.get(b)].rank);

        const start = performance.now();
        for (const el of pending) {
            if (this.records.size >= this.settings.maxSurfaces) break;
            this.attach(el, this.candidates.get(el));

            // making maps is the slow part so spread it over a few frames
            if (performance.now() - start > 10) { this.queueReconcile(); break; }
        }
    }

    // ---- attach / detach ----
    measure(el) {
        const w = el.offsetWidth || Math.round(el.getBoundingClientRect().width);
        const h = el.offsetHeight || Math.round(el.getBoundingClientRect().height);

        let radius = 0;
        const raw = getComputedStyle(el).borderTopLeftRadius || "0px";
        const value = parseFloat(raw) || 0;
        radius = raw.includes("%") ? (value / 100) * Math.min(w, h) : value;
        radius = clamp(radius, 0, Math.min(w, h) / 2);

        return { w, h, radius };
    }

    conflictsFor(el) {
        const list = [];
        for (const other of this.records.keys()) {
            if (other === el) continue;
            if (other.contains(el) || el.contains(other)) list.push(other);
        }
        return list;
    }

    attach(el, key) {
        const m = this.measure(el);
        if (m.w < 24 || m.h < 18 || m.w > 2600 || m.h > 2600) return false;

        // a thing that covers most of the window is a layout container not a surface, only
        // the groups that are meant for big stuff (or ones you picked yourself) are allowed
        if (!BIG_OK.has(key) && m.w > window.innerWidth * 0.6 && m.h > window.innerHeight * 0.6) {
            this.log("skipped, covers most of the window", key, el);
            return false;
        }

        const score = this.surfaceScore(el);

        if (this.settings.avoidNesting) {
            const conflicts = this.conflictsFor(el);
            const rank = GROUPS[key].rank;

            for (const other of conflicts) {
                const rec = this.records.get(other);
                if (rec.rank < rank) {
                    this.log("skipped, nested next to higher priority glass", key, el);
                    return false;
                }
                // same priority: keep whichever one actually looks like the visible card
                if (rec.rank === rank && !this.prefers(el, score, other, rec.score)) {
                    this.log("skipped, other element is the better surface", key, el);
                    return false;
                }
            }

            for (const other of conflicts) this.detach(other);
        }

        const previous = {};
        for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
            previous[property] = {
                value: el.style.getPropertyValue(property),
                priority: el.style.getPropertyPriority(property)
            };
        }

        const record = { key, rank: GROUPS[key].rank, score, previous, filterKey: null, w: 0, h: 0, neutralized: [] };
        this.records.set(el, record);

        el.setAttribute(ATTR, "active");
        el.setAttribute(ATTR_KIND, key);

        this.applyFilterTo(el, record, m);
        this.resizeObserver.observe(el);

        if (this.settings.neutralizeAncestors) this.neutralizeAncestors(el, record);
        if (this.settings.neutralizeInner && INNER_GROUPS.has(key)) this.neutralizeInner(el, record);
        if (this.settings.debug) this.reportBlockers(el, key);

        return true;
    }

    detach(el) {
        const record = this.records.get(el);
        if (!record) return;

        this.resizeObserver.unobserve(el);

        for (const [property, old] of Object.entries(record.previous)) {
            if (old.value) el.style.setProperty(property, old.value, old.priority);
            else el.style.removeProperty(property);
        }

        el.removeAttribute(ATTR);
        el.removeAttribute(ATTR_KIND);
        if (el.getAttribute("style") === "") el.removeAttribute("style");

        clearTimeout(record.refreshTimer);
        record.refreshTimer = null;

        this.releaseFilter(record.filterKey);
        this.restoreAncestors(record);
        this.records.delete(el);
    }

    queueRefresh(el) {
        const record = this.records.get(el);
        if (!record) return;

        const run = () => {
            record.refreshTimer = null;
            if (!this.records.has(el) || !el.isConnected) return;
            this.applyFilterTo(el, record, this.measure(el));
        };

        // big ones wait a bit so dragging the window doesnt rebuild maps every frame
        clearTimeout(record.refreshTimer);
        const big = record.w * record.h > this.settings.largeThreshold * 1000;
        record.refreshTimer = big ? setTimeout(run, 150) : setTimeout(run, 16);
    }

    // redo every surface without removing anything, a few at a time
    refreshAll() {
        this.refreshQueue = [...this.records.keys()];
        cancelAnimationFrame(this.pumpFrame);
        this.pump();
    }

    pump() {
        const start = performance.now();

        while (this.refreshQueue.length) {
            const el = this.refreshQueue.shift();
            const record = this.records.get(el);
            if (record && el.isConnected) this.applyFilterTo(el, record, this.measure(el));
            if (performance.now() - start > 8) break;
        }

        if (this.refreshQueue.length) this.pumpFrame = requestAnimationFrame(() => this.pump());
    }

    applyFilterTo(el, record, m) {
        const plan = this.planFor(record.key, m);
        const filterKey = `${plan.detail}|${plan.mapKey}#${this.colorKey(plan.detail)}`;

        if (filterKey === record.filterKey) return;

        const filter = this.acquireFilter(filterKey, plan, m);
        const url = `url("#${filter.id}")`;

        el.style.setProperty("backdrop-filter", url, "important");
        el.style.setProperty("-webkit-backdrop-filter", url, "important");

        this.releaseFilter(record.filterKey);
        record.filterKey = filterKey;
        record.w = m.w;
        record.h = m.h;
    }

    // ---- backdrop root stuff (why nested glass doesnt work) ----
    // rough "confirming" score since idk if this gonna work on mac
    surfaceScore(el) {
        const cs = getComputedStyle(el);
        let score = 0;

        if (parseFloat(cs.borderTopLeftRadius) > 0) score += 2;
        if (cs.boxShadow && cs.boxShadow !== "none") score += 1;
        if (cs.backgroundImage && cs.backgroundImage !== "none") score += 1;
        const bg = cs.backgroundColor;
        if (bg && bg !== "transparent" && !/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)$/.test(bg)) score += 1;

        return score;
    }

    // same rank overlap: better score wins, if equal the inner one wins
    prefers(el, score, other, otherScore) {
        if (score !== otherScore) return score > otherScore;
        return other.contains(el);
    }

    // clears backdrop-filter on one element and remembers how to put it back
    neutralizeNode(node, record) {
        if (this.neutral.has(node)) {
            this.neutral.get(node).refs++;
            record.neutralized.push(node);
            return;
        }

        this.neutral.set(node, {
            refs: 1,
            prev: {
                bf: [node.style.getPropertyValue("backdrop-filter"), node.style.getPropertyPriority("backdrop-filter")],
                wbf: [node.style.getPropertyValue("-webkit-backdrop-filter"), node.style.getPropertyPriority("-webkit-backdrop-filter")]
            }
        });
        node.style.setProperty("backdrop-filter", "none", "important");
        node.style.setProperty("-webkit-backdrop-filter", "none", "important");
        record.neutralized.push(node);
    }

    neutralizeAncestors(el, record) {
        let p = el.parentElement;

        while (p && p !== document.documentElement) {
            if (!this.records.has(p)) {
                if (this.neutral.has(p)) {
                    this.neutralizeNode(p, record);
                } else if (!this.cleanAncestors.has(p)) {
                    const cs = getComputedStyle(p);
                    if (!cs.backdropFilter || cs.backdropFilter === "none") this.cleanAncestors.add(p);
                    else this.neutralizeNode(p, record);
                }
            }
            p = p.parentElement;
        }
    }

    // a see-through layer with its own backdrop-filter covering most of the card can sit on top
    // of our refraction, so clear those. small stuff (pills etc) is left alone
    neutralizeInner(el, record) {
        const area = record.w * record.h;
        if (!area) return;

        const nodes = el.querySelectorAll("*");
        const limit = Math.min(nodes.length, 600);

        for (let i = 0; i < limit; i++) {
            const n = nodes[i];
            if (this.records.has(n)) continue;

            const cs = getComputedStyle(n);
            if (!cs.backdropFilter || cs.backdropFilter === "none") continue;
            if (n.offsetWidth * n.offsetHeight < area * 0.6) continue;

            this.neutralizeNode(n, record);
        }
    }

    restoreAncestors(record) {
        for (const p of record.neutralized) {
            const n = this.neutral.get(p);
            if (!n) continue;
            n.refs--;
            if (n.refs > 0) continue;

            const [bf, bfp] = n.prev.bf;
            const [wbf, wbfp] = n.prev.wbf;
            if (bf) p.style.setProperty("backdrop-filter", bf, bfp); else p.style.removeProperty("backdrop-filter");
            if (wbf) p.style.setProperty("-webkit-backdrop-filter", wbf, wbfp); else p.style.removeProperty("-webkit-backdrop-filter");
            this.neutral.delete(p);
        }
        record.neutralized = [];
    }

    findBlockers(el) {
        const blockers = [];
        let p = el.parentElement;

        while (p && p !== document.documentElement) {
            const cs = getComputedStyle(p);
            const reasons = [];

            if (cs.backdropFilter && cs.backdropFilter !== "none") reasons.push(`backdrop-filter: ${cs.backdropFilter}`);
            if (cs.filter && cs.filter !== "none") reasons.push(`filter: ${cs.filter}`);
            if (parseFloat(cs.opacity) < 1) reasons.push(`opacity: ${cs.opacity}`);
            if (cs.maskImage && cs.maskImage !== "none") reasons.push("mask");
            if (cs.clipPath && cs.clipPath !== "none") reasons.push("clip-path");
            if (cs.mixBlendMode && cs.mixBlendMode !== "normal") reasons.push(`mix-blend-mode: ${cs.mixBlendMode}`);
            if (/filter|opacity|backdrop|mask|clip-path/.test(cs.willChange || "")) reasons.push(`will-change: ${cs.willChange}`);

            if (reasons.length) blockers.push({ element: p, reasons: reasons.join(", ") });
            p = p.parentElement;
        }

        return blockers;
    }

    reportBlockers(el, key) {
        const blockers = this.findBlockers(el);
        if (!blockers.length) return;

        console.groupCollapsed(`[TranslucenceLiquidGlass] ${key} surface has ${blockers.length} backdrop-root ancestor(s)`);
        console.log("surface:", el);
        console.table(blockers.map(b => ({ reasons: b.reasons, tag: b.element.tagName, class: String(b.element.className).slice(0, 80) })));
        console.groupEnd();
    }

    diagnose() {
        const rows = [];
        for (const [el, rec] of this.records) {
            const blockers = this.findBlockers(el);
            rows.push({
                group: rec.key,
                size: `${rec.w}x${rec.h}`,
                blockedBy: blockers.length ? blockers.map(b => b.reasons).join(" | ") : "-",
                element: el
            });
        }

        console.info(`[TranslucenceLiquidGlass] ${this.records.size} active surfaces, ${this.candidates.size} candidates, ${this.visible.size} visible, ${this.filters.size} filters`);
        console.table(rows);

        const blocked = rows.filter(r => r.blockedBy !== "-").length;
        const message = `${this.records.size} glass surfaces active${blocked ? `, ${blocked} still have a backdrop-root ancestor (see console)` : ""}.`;
        try { BdApi.UI.showToast(message, { type: blocked ? "warning" : "success" }); } catch (e) { /* ignore */ }
    }

    // ---- filters ----
    colorKey(detail) {
        const s = this.settings;
        return [s.blur, s.saturation, s.brightness, detail === "full" ? s.specular : "-"].join("|");
    }

    getProfile(key) {
        return { ...BASE_PROFILE, ...(PROFILE_PRESETS[key] || {}), ...(this.settings.profiles[key] || {}) };
    }

    // figures out everything one surface needs.
    // relative: unit = short side / divisor, thickness + bezel are multiples of that
    // fixed: plain px, so every surface refracts the same
    planFor(key, m) {
        const s = this.settings;
        const p = this.getProfile(key);
        const area = m.w * m.h;
        const large = area > s.largeThreshold * 1000;

        let detail = p.detail;
        if (detail === "auto") detail = large ? s.largeDetail : "full";

        const own = p.sizeMode !== "global";
        const mode = own ? p.sizeMode : s.sizeMode;
        const divisor = Math.max(0.5, own ? p.divisor : s.divisor);
        const thicknessRel = own ? p.thicknessRel : s.thicknessRel;
        const bezelRel = own ? p.bezelRel : s.bezelRel;
        const thicknessPx = own ? p.thicknessPx : s.thicknessPx;
        const bezelPx = own ? p.bezelPx : s.bezelPx;

        const shortSide = Math.min(m.w, m.h);
        const unit = shortSide / divisor;

        const thickness = Math.max(1, mode === "relative" ? unit * thicknessRel : thicknessPx);
        const bezel = clamp(mode === "relative" ? unit * bezelRel : bezelPx, 1, shortSide / 2);

        let quality = p.quality > 0 ? p.quality : s.quality;
        if (p.quality === 0 && large) quality *= s.largeQuality;

        const mapKey = detail === "blur"
            ? "blur"
            : [
                m.w, m.h, Math.round(m.radius * 2) / 2,
                s.surface, thickness.toFixed(1), bezel.toFixed(1),
                s.ior, s.refraction, s.maxDisplacement, quality.toFixed(2), detail,
                detail === "full" ? `${s.specularAngle}|${s.specularWidth}` : "-"
            ].join("|");

        return { detail, thickness, bezel, shortSide, quality, mapKey };
    }

    acquireFilter(filterKey, plan, m) {
        let filter = this.filters.get(filterKey);

        if (!filter) {
            const maps = plan.detail === "blur" ? null : this.getMaps(plan, m);
            const id = `tg-glass-${++this.filterCounter}`;
            const node = this.buildFilter(id, maps, m, plan.detail);
            this.defs.appendChild(node);
            filter = { id, node, refs: 0 };
            this.filters.set(filterKey, filter);
        }

        filter.refs++;
        return filter;
    }

    releaseFilter(filterKey) {
        if (!filterKey) return;
        const filter = this.filters.get(filterKey);
        if (!filter) return;

        filter.refs--;
        if (filter.refs <= 0) {
            filter.node.remove();
            this.filters.delete(filterKey);
        }
    }

    svg(name, attrs = {}) {
        const node = document.createElementNS(SVG_NS, name);
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
        return node;
    }

    // full = blur, refract, saturate, brightness, highlight rim
    // lite = same but no highlight (one less image pass)
    // blur = no refraction at all, no maps cheapest
    buildFilter(id, maps, m, detail) {
        const s = this.settings;

        const node = this.svg("filter", {
            id, x: 0, y: 0, width: 1, height: 1,
            "color-interpolation-filters": "sRGB"
        });

        const blur = this.svg("feGaussianBlur", { in: "SourceGraphic", stdDeviation: s.blur, result: "blurred" });
        node.appendChild(blur);

        let current = "blurred";

        if (detail !== "blur") {
            const dispImage = this.svg("feImage", {
                x: 0, y: 0, width: m.w, height: m.h,
                preserveAspectRatio: "none", result: "displacement_map"
            });
            dispImage.setAttribute("href", maps.displacement);

            const displace = this.svg("feDisplacementMap", {
                in: "blurred", in2: "displacement_map",
                scale: maps.scale.toFixed(3),
                xChannelSelector: "R", yChannelSelector: "G", result: "displaced"
            });

            node.append(dispImage, displace);
            current = "displaced";
        }

        node.appendChild(this.svg("feColorMatrix", { in: current, type: "saturate", values: s.saturation, result: "saturated" }));

        const bright = this.svg("feComponentTransfer", { in: "saturated", result: "bright" });
        for (const channel of ["feFuncR", "feFuncG", "feFuncB"]) {
            bright.appendChild(this.svg(channel, { type: "linear", slope: s.brightness }));
        }
        node.appendChild(bright);

        if (detail === "full") {
            const specImage = this.svg("feImage", {
                x: 0, y: 0, width: m.w, height: m.h,
                preserveAspectRatio: "none", result: "specular_layer"
            });
            specImage.setAttribute("href", maps.specular);

            const specFade = this.svg("feComponentTransfer", { in: "specular_layer", result: "specular_faded" });
            specFade.appendChild(this.svg("feFuncA", { type: "linear", slope: s.specular }));

            node.append(specImage, specFade, this.svg("feBlend", { in: "specular_faded", in2: "bright", mode: "screen" }));
        }

        return node;
    }

    // ---- map generation ----
    getTable(thickness, bezel) {
        const s = this.settings;
        const key = `${s.surface}|${thickness.toFixed(1)}|${bezel.toFixed(1)}|${s.ior}`;

        let entry = this.tableCache.get(key);
        if (!entry) {
            entry = computeBezelTable(thickness, bezel, (SURFACES[s.surface] || SURFACES.convex_squircle).fn, s.ior);
            this.tableCache.set(key, entry);
            if (this.tableCache.size > 200) this.tableCache.delete(this.tableCache.keys().next().value);
        }
        return entry;
    }

    getMaps(plan, m) {
        let maps = this.mapCache.get(plan.mapKey);
        if (maps) return maps;

        maps = this.generateMaps(m, plan);
        this.mapCache.set(plan.mapKey, maps);
        if (this.mapCache.size > 160) this.mapCache.delete(this.mapCache.keys().next().value);
        return maps;
    }

    // only the edge band of a surface actually bends anything, so the middle
    // gets filled in one go and we only loop over the edges. way less work on big stuff
    generateMaps(m, plan) {
        const s = this.settings;
        const { w, h, radius } = m;
        const { thickness, bezel, shortSide, quality, detail } = plan;
        const { table, max } = this.getTable(thickness, bezel);
        const wantSpec = detail === "full";

        const density = Math.min(quality, 1600 / Math.max(w, h));
        const mapW = Math.max(8, Math.round(w * density));
        const mapH = Math.max(8, Math.round(h * density));

        const dispData = new ImageData(mapW, mapH);
        const specData = wantSpec ? new ImageData(mapW, mapH) : null;
        const d = dispData.data;
        const sp = specData ? specData.data : null;

        // neutral = R128 G128 B0 A255 (as a little endian uint32)
        new Uint32Array(d.buffer).fill(0xFF008080);

        const hw = w / 2;
        const hh = h / 2;
        const innerW = hw - radius;
        const innerH = hh - radius;

        const angle = (s.specularAngle * Math.PI) / 180;
        const lx = Math.cos(angle);
        const ly = Math.sin(angle);
        const specW = Math.max(0.5, s.specularWidth);

        const reach = Math.max(bezel, wantSpec ? specW : 0) + 2;
        const band = Math.min(Math.ceil(reach * density) + 1, Math.max(mapW, mapH));

        const shade = (x, y) => {
            const px = (x + 0.5) / density;
            const py = (y + 0.5) / density;

            const qx = Math.abs(px - hw) - innerW;
            const qy = Math.abs(py - hh) - innerH;
            const ox = qx > 0 ? qx : 0;
            const oy = qy > 0 ? qy : 0;
            const outside = Math.hypot(ox, oy);
            const edge = -(outside + Math.min(Math.max(qx, qy), 0) - radius);

            if (edge < -1) return;
            const aa = edge < 0 ? 1 + edge : 1;
            const i = (y * mapW + x) * 4;

            let nx, ny;
            if (outside > 0.001) {
                nx = sgn(px - hw) * ox / outside;
                ny = sgn(py - hh) * oy / outside;
            } else if (qx > qy) {
                nx = sgn(px - hw); ny = 0;
            } else {
                nx = 0; ny = sgn(py - hh);
            }

            if (edge < bezel) {
                const t = clamp(edge / bezel, 0, 1);
                const dist = table[Math.min(SAMPLES - 1, Math.floor(t * SAMPLES))];
                const k = (dist / max) * aa * 127;

                d[i] = clamp(128 - nx * k, 0, 255);
                d[i + 1] = clamp(128 - ny * k, 0, 255);
            }

            if (wantSpec && edge < specW) {
                const dot = Math.abs(nx * lx + (-ny) * ly);
                const ratio = clamp(edge / specW, 0, 1);
                const sharp = Math.sqrt(1 - (1 - ratio) * (1 - ratio));
                const coefficient = dot * sharp;
                const color = Math.min(255, 255 * coefficient);

                sp[i] = color; sp[i + 1] = color; sp[i + 2] = color;
                sp[i + 3] = Math.min(255, color * coefficient * aa);
            }
        };

        for (let y = 0; y < mapH; y++) {
            if (y < band || y >= mapH - band) {
                for (let x = 0; x < mapW; x++) shade(x, y);
            } else {
                for (let x = 0; x < band; x++) shade(x, y);
                for (let x = mapW - band; x < mapW; x++) shade(x, y);
            }
        }

        // how far the edge pixels move, capped so it cant tear
        const desired = Math.min(max * s.refraction, shortSide * (s.maxDisplacement / 100));

        // feDisplacementMap moves by scale * (channel - 0.5) but our map only uses 127/255 of that, so fix it
        const scale = desired * (255 / 127);

        return {
            displacement: this.toDataURL(dispData),
            specular: specData ? this.toDataURL(specData) : null,
            scale
        };
    }

    toDataURL(imageData) {
        const canvas = document.createElement("canvas");
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        canvas.getContext("2d").putImageData(imageData, 0, 0);
        const url = canvas.toDataURL("image/png");

        // we only want the string, dont keep the pixel buffer around
        canvas.width = 0;
        canvas.height = 0;
        return url;
    }

    // ---- applying settings ----
    refreshRuntimeStyle() {
        let css = "";
        if (this.settings.highlight) {
            css += `[${ATTR}="active"]{outline:1px dashed rgba(0,255,170,.9)!important;outline-offset:-1px;}`;
        }

        this.removeRuntimeStyle();

        if (!css) return;

        try { BdApi.DOM.addStyle(STYLE_ID, css); }
        catch (e) {
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    removeRuntimeStyle() {
        try { BdApi.DOM.removeStyle(STYLE_ID); } catch (e) { /* ignore */ }
        document.getElementById(STYLE_ID)?.remove();
    }

    applySettings(level = "full") {
        if (!this.running) return;

        const root = document.documentElement.style;
        root.setProperty(ROOT_VARS[0], `${this.settings.blur}px`);
        root.setProperty(ROOT_VARS[1], this.settings.refraction);
        root.setProperty(ROOT_VARS[2], this.settings.specular);

        this.refreshRuntimeStyle();

        if (level === "style") return;

        if (level === "full") {
            // these change nesting / ancestors so start fresh
            for (const el of [...this.records.keys()]) this.detach(el);
            this.cleanAncestors = new WeakSet();
            this.scan();
            return;
        }

        if (level === "scan") { this.scan(); return; }

        // soft: leave everything attached, just swap the filters
        this.refreshAll();
    }

    queueApply(level = "soft") {
        const order = { style: 0, soft: 1, scan: 2, full: 3 };
        if (!this.pendingLevel || order[level] > order[this.pendingLevel]) this.pendingLevel = level;

        clearTimeout(this.applyTimer);
        this.applyTimer = setTimeout(() => {
            const lvl = this.pendingLevel;
            this.pendingLevel = null;
            this.applySettings(lvl);
        }, 90);
    }

    levelFor(key) {
        if (FULL_REBUILD.has(key)) return "full";
        if (RESCAN.has(key)) return "scan";
        if (STYLE_ONLY.has(key)) return "style";
        return "soft";
    }

    updateSetting(key, value, rebuildPanel) {
        this.settings[key] = value;
        this.saveSettings();
        this.queueApply(this.levelFor(key));
        rebuildPanel?.();
    }

    updateGroup(key, value) {
        this.settings.groups[key] = value;
        this.saveSettings();
        this.queueApply("scan");
    }

    updateProfile(group, field, value, rebuildPanel) {
        this.settings.profiles[group] = { ...(this.settings.profiles[group] || {}), [field]: value };
        this.saveSettings();
        this.queueApply("soft");
        rebuildPanel?.();
    }

    // ---- presets ----
    applyPreset(name) {
        const preset = PRESETS[name];
        if (!preset) return;

        // keep stuff the user typed / debug flags, reset the rest
        const keep = {
            customSelectors: this.settings.customSelectors,
            debug: this.settings.debug,
            highlight: this.settings.highlight,
            enabled: true
        };

        const v = preset.values;
        this.settings = {
            ...DEFAULTS,
            ...v,
            ...keep,
            groups: { ...DEFAULTS.groups, ...(v.groups || {}) },
            profiles: { ...(v.profiles || {}) },
            presetChosen: name,
            settingsVersion: SETTINGS_VERSION
        };

        this.saveSettings();
    }

    showPresetPicker() {
        this.closePresetPicker();

        const overlay = document.createElement("div");
        overlay.id = "tg-preset-picker";
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font-family:var(--font-primary,'gg sans',sans-serif);";

        const box = document.createElement("div");
        box.style.cssText = "width:min(560px,92vw);max-height:90vh;overflow:auto;padding:22px;border-radius:20px;background:rgba(24,25,32,.96);color:#f2f3f5;border:1px solid rgba(255,255,255,.14);box-shadow:0 24px 60px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:12px;";

        const title = document.createElement("div");
        title.textContent = "Choose a Preset";
        title.style.cssText = "font-size:22px;font-weight:700;";

        const warn = document.createElement("div");
        warn.textContent = "Don't choose one that is too heavy for your specs!";
        warn.style.cssText = "font-size:13px;opacity:.8;margin-top:-6px;";

        box.append(title, warn);

        for (const [name, preset] of Object.entries(PRESETS)) {
            const card = document.createElement("button");
            card.type = "button";
            card.style.cssText = "text-align:left;padding:12px 14px;border-radius:14px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.07);color:inherit;cursor:pointer;display:flex;flex-direction:column;gap:4px;font:inherit;";

            const row = document.createElement("div");
            row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:10px;";

            const label = document.createElement("strong");
            label.textContent = name;
            label.style.fontSize = "15px";

            const tag = document.createElement("span");
            tag.textContent = preset.tag;
            tag.style.cssText = "font-size:11px;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,.14);";

            row.append(label, tag);

            const desc = document.createElement("div");
            desc.textContent = preset.desc;
            desc.style.cssText = "font-size:12px;opacity:.75;";

            card.append(row, desc);

            card.addEventListener("mouseenter", () => { card.style.background = "rgba(255,255,255,.14)"; });
            card.addEventListener("mouseleave", () => { card.style.background = "rgba(255,255,255,.07)"; });
            card.addEventListener("click", () => {
                this.applyPreset(name);
                this.needsPreset = false;
                this.waiting = false;
                this.closePresetPicker();
                this.begin();
                try { BdApi.UI.showToast(`Liquid Glass: ${name} applied. You can change everything in the plugin settings.`, { type: "success" }); } catch (e) { /* ignore */ }
            });

            box.appendChild(card);
        }

        const foot = document.createElement("div");
        foot.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:12px;opacity:.7;";

        const note = document.createElement("span");
        note.textContent = "You can change all of this later in the plugin settings.";

        const skip = document.createElement("button");
        skip.type = "button";
        skip.textContent = "Not now";
        skip.style.cssText = "background:none;border:none;color:inherit;text-decoration:underline;cursor:pointer;font:inherit;";
        skip.addEventListener("click", () => {
            // stays off, will ask again next time discord loads
            this.waiting = false;
            this.closePresetPicker();
        });

        foot.append(note, skip);
        box.appendChild(foot);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
        this.pickerOverlay = overlay;
    }

    closePresetPicker() {
        this.pickerOverlay?.remove();
        this.pickerOverlay = null;
        document.getElementById("tg-preset-picker")?.remove();
    }

    // ---- inspector (press the hotkey click something, it tells you why it is / isnt glass) ----
    describe(el) {
        const classes = [...el.classList].slice(0, 2).map(c => c.replace(/_{1,2}[a-zA-Z0-9]{5,8}$/, ""));
        return `${el.tagName.toLowerCase()}${classes.length ? "." + classes.join(".") : ""}`;
    }

    statusOf(el) {
        const record = this.records.get(el);

        if (record) {
            const notes = [];
            const blockers = this.findBlockers(el);
            if (blockers.length) notes.push(`a parent is blocking it (${blockers[0].reasons})`);

            const bg = getComputedStyle(el).backgroundColor;
            const alpha = (bg.match(/rgba?\(([^)]+)\)/) || [])[1]?.split(",")[3];
            if (alpha !== undefined && parseFloat(alpha) > 0.85) notes.push("its own background is almost solid so you cant see through it");

            return `**glass** (${record.key})${notes.length ? ", but " + notes.join(" and ") : ""}`;
        }

        const key = this.candidates.get(el);
        if (!key) return "no selector matches this (or its group is turned off)";

        if (!this.visible.has(el)) return `matches ${key}, but its off screen`;

        const m = this.measure(el);
        if (m.w < 24 || m.h < 18) return `matches ${key}, but its too small`;

        const conflicts = this.conflictsFor(el);
        if (conflicts.length) return `matches ${key}, skipped because of glass on ${this.describe(conflicts[0])} (${this.records.get(conflicts[0]).key})`;

        if (this.records.size >= this.settings.maxSurfaces) return `matches ${key}, but max glass surfaces is reached`;

        return `matches ${key}, should turn on in a sec`;
    }

    looksLikeSurface(el) {
        return el.offsetWidth >= 60 && el.offsetHeight >= 30 && parseFloat(getComputedStyle(el).borderTopLeftRadius) > 0;
    }

    inspect(target) {
        const chain = [];
        for (let n = target; n && n !== document.body && chain.length < 10; n = n.parentElement) chain.push(n);

        const lines = chain.map(el => `- \`${this.describe(el)}\` ${el.offsetWidth}x${el.offsetHeight}: ${this.statusOf(el)}`);
        const best = chain.find(el => !this.records.has(el) && this.looksLikeSurface(el));

        const hasGlass = chain.some(el => this.records.has(el));
        const header = hasGlass
            ? "Glass is on for something in this stack. If it still looks flat, check the notes below."
            : "Nothing in this stack has glass on it.";

        const bestSelector = best ? this.selectorFor(best) : null;
        let bestNote = "";
        if (best && bestSelector) bestNote = `\n\nBest guess for the visible card: \`${this.describe(best)}\`\n\nSelector it would add: \`${bestSelector}\``;
        else if (best) bestNote = `\n\nBest guess for the visible card: \`${this.describe(best)}\`, but its classes are too generic to make a safe selector. Try picking a more specific element.`;

        const canAdd = !!(best && bestSelector && !chain.some(el => this.records.has(el)));

        const text = `${header}\n\n${lines.join("\n")}${bestNote}`;

        console.info("[TranslucenceLiquidGlass] inspect\n" + text.replace(/\*\*|`/g, ""));

        try {
            BdApi.UI.showConfirmationModal("Glass check", text, {
                confirmText: canAdd ? "Add best guess as glass" : "Close",
                cancelText: canAdd ? "Close" : null,
                onConfirm: () => {
                    if (!canAdd) return;
                    const selector = bestSelector;
                    const list = this.settings.customSelectors.split("\n").map(x => x.trim()).filter(Boolean);
                    if (!list.includes(selector)) list.push(selector);
                    this.settings.customSelectors = list.join("\n");
                    this.settings.groups.custom = true;
                    this.saveSettings();
                    this.queueApply("scan");
                }
            });
        } catch (e) {
            try { BdApi.UI.alert("Glass check", text); } catch (err) { /* ignore */ }
        }
    }

    // ---- element picker (discord classes are hashed so this grabs a selector for you) ----
    startPicker(onPick) {
        this.stopPicker();

        const outline = document.createElement("div");
        outline.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #00ffaa;background:rgba(0,255,170,.12);border-radius:6px;";
        document.body.appendChild(outline);

        const target = e => document.elementFromPoint(e.clientX, e.clientY);

        const move = e => {
            const el = target(e);
            if (!el) return;
            const r = el.getBoundingClientRect();
            outline.style.left = `${r.left}px`;
            outline.style.top = `${r.top}px`;
            outline.style.width = `${r.width}px`;
            outline.style.height = `${r.height}px`;
        };

        const click = e => {
            e.preventDefault();
            e.stopPropagation();
            const el = target(e);
            this.stopPicker();
            if (el) onPick(el, this.selectorFor(el));
        };

        const key = e => { if (e.key === "Escape") this.stopPicker(); };

        document.addEventListener("mousemove", move, true);
        document.addEventListener("click", click, true);
        document.addEventListener("keydown", key, true);

        this.picker = { outline, move, click, key };

        try { BdApi.UI.showToast("Click the thing you want to check (Esc cancels).", { type: "info" }); } catch (e) { /* ignore */ }
    }

    stopPicker() {
        if (!this.picker) return;
        document.removeEventListener("mousemove", this.picker.move, true);
        document.removeEventListener("click", this.picker.click, true);
        document.removeEventListener("keydown", this.picker.key, true);
        this.picker.outline.remove();
        this.picker = null;
    }

    // builds a selector for el that matches only a few things. returns null if it cant make a safe one
    selectorFor(el) {
        const esc = text => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(text) : text.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
        const stable = /^([a-zA-Z]+)_{1,2}[a-zA-Z0-9]{5,8}$/;

        // classes look like name_a1b2c3, the hash changes between discord updates but the name doesnt
        const build = node => {
            const classes = [...node.classList];
            const prefixes = classes.map(c => c.match(stable)).filter(Boolean).map(m => `[class*='${m[1]}_']`);
            const exact = classes.map(c => "." + esc(c));
            return {
                tag: node.tagName.toLowerCase(),
                options: [prefixes.slice(0, 2).join(""), prefixes.join(""), exact.join("")].filter(Boolean)
            };
        };

        const self = build(el);
        const parent = el.parentElement && el.parentElement !== document.body ? build(el.parentElement) : null;

        const tries = [];
        for (const o of self.options) tries.push(`#app-mount ${self.tag}${o}`);
        if (parent) {
            for (const po of parent.options) {
                for (const o of self.options) tries.push(`#app-mount ${parent.tag}${po} > ${self.tag}${o}`);
            }
        }

        // first one that really hits this element and only a handful of others wins (durable ones come first)
        for (const selector of new Set(tries)) {
            try {
                const count = document.querySelectorAll(selector).length;
                if (count >= 1 && count <= 5 && el.matches(selector)) return selector;
            } catch (e) { /* ignore */ }
        }

        return null;
    }

    // ---- settings panel ----
    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.cssText = "padding:16px;color:var(--text-normal,#ddd);display:flex;flex-direction:column;gap:10px;";

        const card = "padding:12px;border-radius:12px;background:rgba(127,127,127,.14);";
        const openGroups = new Set();

        const render = () => {
            panel.textContent = "";
            const s = this.settings;
            const rebuild = () => render();

            const heading = (text, note) => {
                const box = document.createElement("div");
                box.style.cssText = "margin-top:10px;";
                const h = document.createElement("h3");
                h.textContent = text;
                h.style.cssText = "margin:0;font-size:15px;";
                box.appendChild(h);
                if (note) {
                    const p = document.createElement("div");
                    p.textContent = note;
                    p.style.cssText = "font-size:12px;opacity:.7;margin-top:2px;";
                    box.appendChild(p);
                }
                panel.appendChild(box);
            };

            const toggle = (label, note, get, set) => {
                const row = document.createElement("label");
                row.style.cssText = `${card}display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;`;

                const text = document.createElement("div");
                const strong = document.createElement("strong");
                strong.textContent = label;
                text.appendChild(strong);
                if (note) {
                    const n = document.createElement("div");
                    n.textContent = note;
                    n.style.cssText = "font-size:12px;opacity:.7;margin-top:3px;";
                    text.appendChild(n);
                }

                const input = document.createElement("input");
                input.type = "checkbox";
                input.checked = !!get();
                input.addEventListener("change", () => set(input.checked));

                row.append(text, input);
                panel.appendChild(row);
            };

            const slider = (label, note, key, min, max, step, unit = "") => {
                const row = document.createElement("div");
                row.style.cssText = `${card}display:flex;flex-direction:column;gap:6px;`;

                const top = document.createElement("div");
                top.style.cssText = "display:flex;justify-content:space-between;";
                const name = document.createElement("strong");
                name.textContent = label;
                const value = document.createElement("span");
                value.textContent = `${s[key]}${unit}`;
                top.append(name, value);

                const input = document.createElement("input");
                input.type = "range";
                input.min = min; input.max = max; input.step = step;
                input.value = s[key];
                input.style.width = "100%";
                input.addEventListener("input", () => {
                    const v = Number(input.value);
                    value.textContent = `${v}${unit}`;
                    this.updateSetting(key, v);
                });

                row.append(top, input);

                if (note) {
                    const n = document.createElement("small");
                    n.textContent = note;
                    n.style.opacity = ".7";
                    row.appendChild(n);
                }
                panel.appendChild(row);
            };

            const select = (label, note, key, options, rebuildAfter) => {
                const row = document.createElement("div");
                row.style.cssText = `${card}display:flex;align-items:center;justify-content:space-between;gap:12px;`;

                const text = document.createElement("div");
                const strong = document.createElement("strong");
                strong.textContent = label;
                text.appendChild(strong);
                if (note) {
                    const n = document.createElement("div");
                    n.textContent = note;
                    n.style.cssText = "font-size:12px;opacity:.7;margin-top:3px;";
                    text.appendChild(n);
                }

                const input = document.createElement("select");
                for (const [value, text2] of options) {
                    const opt = document.createElement("option");
                    opt.value = value;
                    opt.textContent = text2;
                    input.appendChild(opt);
                }
                input.value = String(s[key]);
                input.addEventListener("change", () => {
                    const raw = input.value;
                    this.updateSetting(key, isNaN(Number(raw)) ? raw : Number(raw), rebuildAfter ? rebuild : null);
                });

                row.append(text, input);
                panel.appendChild(row);
            };

            const button = (label, onClick) => {
                const b = document.createElement("button");
                b.textContent = label;
                b.style.cssText = "padding:8px 14px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);color:inherit;cursor:pointer;";
                b.addEventListener("click", onClick);
                return b;
            };

            const miniSlider = (container, label, group, field, min, max, step, unit = "") => {
                const profile = this.getProfile(group);
                const row = document.createElement("div");
                row.style.cssText = "display:flex;flex-direction:column;gap:3px;";

                const top = document.createElement("div");
                top.style.cssText = "display:flex;justify-content:space-between;font-size:12px;";
                const name = document.createElement("span");
                name.textContent = label;
                const value = document.createElement("span");
                value.textContent = `${profile[field]}${unit}`;
                top.append(name, value);

                const input = document.createElement("input");
                input.type = "range";
                input.min = min; input.max = max; input.step = step;
                input.value = profile[field];
                input.style.width = "100%";
                input.addEventListener("input", () => {
                    const v = Number(input.value);
                    value.textContent = `${v}${unit}`;
                    this.updateProfile(group, field, v);
                });

                row.append(top, input);
                container.appendChild(row);
            };

            const miniSelect = (container, label, group, field, options) => {
                const profile = this.getProfile(group);
                const row = document.createElement("div");
                row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;";

                const name = document.createElement("span");
                name.textContent = label;

                const input = document.createElement("select");
                for (const [value, text] of options) {
                    const opt = document.createElement("option");
                    opt.value = value;
                    opt.textContent = text;
                    input.appendChild(opt);
                }
                input.value = String(profile[field]);
                input.addEventListener("change", () => {
                    const raw = input.value;
                    this.updateProfile(group, field, isNaN(Number(raw)) ? raw : Number(raw), rebuild);
                });

                row.append(name, input);
                container.appendChild(row);
            };

            const groupRow = key => {
                const wrap = document.createElement("div");
                wrap.style.cssText = `${card}display:flex;flex-direction:column;gap:8px;`;

                const head = document.createElement("label");
                head.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;";
                const strong = document.createElement("strong");
                strong.textContent = GROUPS[key].label;
                const input = document.createElement("input");
                input.type = "checkbox";
                input.checked = !!s.groups[key];
                input.addEventListener("change", () => this.updateGroup(key, input.checked));
                head.append(strong, input);
                wrap.appendChild(head);

                const details = document.createElement("details");
                details.open = openGroups.has(key);
                details.addEventListener("toggle", () => {
                    if (details.open) openGroups.add(key); else openGroups.delete(key);
                });

                const summary = document.createElement("summary");
                summary.textContent = "Tune";
                summary.style.cssText = "cursor:pointer;font-size:12px;opacity:.8;";
                details.appendChild(summary);

                const body = document.createElement("div");
                body.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:8px;";

                const profile = this.getProfile(key);

                miniSelect(body, "Thickness mode", key, "sizeMode", [
                    ["global", "Use global shape"],
                    ["relative", "Relative (short side ÷ divisor)"],
                    ["fixed", "Fixed (px, same on every surface)"]
                ]);

                if (profile.sizeMode === "relative") {
                    miniSlider(body, "Divisor", key, "divisor", 1, 12, 0.5);
                    miniSlider(body, "Thickness", key, "thicknessRel", 0.5, 8, 0.1, "×");
                    miniSlider(body, "Bezel width", key, "bezelRel", 0.1, 1.5, 0.05, "×");
                } else if (profile.sizeMode === "fixed") {
                    miniSlider(body, "Thickness", key, "thicknessPx", 2, 200, 1, "px");
                    miniSlider(body, "Bezel width", key, "bezelPx", 2, 60, 1, "px");
                }

                miniSelect(body, "Detail", key, "detail", [
                    ["auto", "Auto (lite/blur when large)"],
                    ["full", "Full (refraction + highlight)"],
                    ["lite", "Lite (refraction only)"],
                    ["blur", "Blur only (cheapest)"]
                ]);

                miniSelect(body, "Map quality", key, "quality", [
                    ["0", "Use global"], ["0.25", "0.25×"], ["0.5", "0.5×"], ["1", "1×"], ["2", "2×"]
                ]);

                body.appendChild(button("Reset this group", () => {
                    delete this.settings.profiles[key];
                    this.saveSettings();
                    this.queueApply("soft");
                    render();
                }));

                details.appendChild(body);
                wrap.appendChild(details);
                panel.appendChild(wrap);
            };

            // header
            const title = document.createElement("h2");
            title.textContent = "Liquid Glass";
            title.style.margin = "0";
            panel.appendChild(title);

            toggle("Enable Liquid Glass", "Master switch.", () => s.enabled, v => this.updateSetting("enabled", v));

            const presetRow = document.createElement("div");
            presetRow.style.cssText = `${card}display:flex;gap:8px;flex-wrap:wrap;align-items:center;`;
            const presetLabel = document.createElement("strong");
            presetLabel.textContent = "Presets";
            presetRow.appendChild(presetLabel);
            for (const name of Object.keys(PRESETS)) {
                presetRow.appendChild(button(name, () => {
                    this.applyPreset(name);
                    // preset can change groups / nesting stuff so do a full redo
                    if (this.running) this.applySettings("full");
                    else if (!this.waiting) { this.needsPreset = false; this.begin(); }
                    render();
                }));
            }
            presetRow.appendChild(button("Reset everything", () => {
                this.settings = { ...DEFAULTS, groups: { ...DEFAULTS.groups }, profiles: {}, presetChosen: this.settings.presetChosen };
                this.saveSettings();
                if (this.running) this.applySettings("full");
                render();
            }));
            panel.appendChild(presetRow);

            // surfaces
            heading("Where glass is applied", "Glass can't be nested: anything inside a glass surface can no longer see the wallpaper. Large panes are off by default because they would blind the message bar, messages and buttons inside them.");

            for (const key of GROUP_ORDER) groupRow(key);

            const customBox = document.createElement("div");
            customBox.style.cssText = `${card}display:flex;flex-direction:column;gap:8px;`;
            const customTitle = document.createElement("strong");
            customTitle.textContent = "Custom selectors (one per line)";
            const area = document.createElement("textarea");
            area.value = s.customSelectors;
            area.rows = 3;
            area.placeholder = "#app-mount [class*='panels_'] > div";
            area.style.cssText = "width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;border-radius:8px;padding:8px;";
            area.addEventListener("change", () => this.updateSetting("customSelectors", area.value));
            customBox.append(customTitle, area, button("Pick an element…", () => {
                this.startPicker((el, selector) => {
                    if (!selector) {
                        try { BdApi.UI.showToast("Liquid Glass: that element's classes are too generic for a safe selector. Pick a more specific one.", { type: "warning" }); } catch (e) { /* ignore */ }
                        return;
                    }
                    const next = [area.value.trim(), selector].filter(Boolean).join("\n");
                    area.value = next;
                    this.settings.groups.custom = true;
                    this.updateSetting("customSelectors", next, rebuild);
                });
            }));
            panel.appendChild(customBox);

            slider("Max glass surfaces", "Performance cap. Only on-screen surfaces are ever rendered.", "maxSurfaces", 10, 200, 5);

            // shape
            heading("Glass shape");

            select("Surface profile", "Height curve of the bezel.", "surface",
                Object.entries(SURFACES).map(([k, v]) => [k, v.label]));

            select("Thickness mode", "Relative scales thickness and bezel with each surface (short side ÷ divisor). Fixed uses the same pixel values everywhere. Each group below can override this.", "sizeMode",
                [["relative", "Relative (short side ÷ divisor)"], ["fixed", "Fixed (px)"]], true);

            if (s.sizeMode === "relative") {
                slider("Size divisor", "One unit = the surface's short side ÷ this number. Raise it for thinner, cheaper glass on everything; lower it for chunkier glass.", "divisor", 1, 12, 0.5);
                slider("Glass thickness", "In units. Thicker glass bends the background more.", "thicknessRel", 0.5, 8, 0.1, "×");
                slider("Bezel width", "In units. How far in from the edge the lens extends.", "bezelRel", 0.1, 1.5, 0.05, "×");
            } else {
                slider("Glass thickness", "Pixels.", "thicknessPx", 5, 300, 1, "px");
                slider("Bezel width", "Pixels (limited to half the short side).", "bezelPx", 2, 80, 1, "px");
            }

            slider("Refractive index", "1.0 = no bending. Glass is about 1.5.", "ior", 1, 2.5, 0.01);
            slider("Refraction strength", "Multiplier on the physical displacement.", "refraction", 0, 3, 0.05);
            slider("Max displacement", "Hard limit on how far a pixel can move, as a % of the surface's short side. Stops large or thick surfaces from tearing.", "maxDisplacement", 5, 100, 1, "%");
            select("Map quality", "Resolution of the refraction map. Higher is crisper and heavier.", "quality",
                [["0.5", "Low (0.5×)"], ["1", "Normal (1×)"], ["2", "High (2×)"]]);

            // big surfaces
            heading("Large surfaces", "Filter cost grows with area, not thickness. Anything bigger than the threshold (and set to Auto detail) is simplified so settings and other big UI stay smooth.");
            slider("Large threshold", "Surfaces with more area than this count as large. 300 ≈ 700×430 px.", "largeThreshold", 50, 2000, 10, "k px²");
            select("Large surface detail", "Full keeps everything. Lite drops the highlight layer. Blur only skips refraction entirely and is the cheapest.", "largeDetail",
                [["full", "Full"], ["lite", "Lite (refraction only)"], ["blur", "Blur only"]]);
            select("Large surface map quality", "Multiplier on map resolution for large surfaces.", "largeQuality",
                [["0.25", "0.25×"], ["0.5", "0.5×"], ["1", "1×"]]);

            // looks
            heading("Look");
            slider("Backdrop blur", null, "blur", 0, 8, 0.1, "px");
            slider("Saturation", null, "saturation", 0.5, 2, 0.05);
            slider("Brightness", null, "brightness", 0.7, 1.5, 0.01);
            slider("Specular highlight", "Opacity of the bright rim.", "specular", 0, 1.5, 0.01);
            slider("Light angle", null, "specularAngle", 0, 360, 1, "°");
            slider("Highlight width", null, "specularWidth", 0.5, 5, 0.1, "px");

            // compat
            heading("Compatibility");
            toggle("Avoid nested glass", "If two glass surfaces overlap, keep the higher-priority one and skip the other.", () => s.avoidNesting, v => this.updateSetting("avoidNesting", v));
            toggle("Clear big inner backdrop-filters", "A see-through layer inside a popout / profile card that covers most of it and has its own blur can sit on top of the refraction. This clears only those (small stuff like pills is left alone).", () => s.neutralizeInner, v => this.updateSetting("neutralizeInner", v));
            toggle("Neutralize ancestor backdrop-filters (recommended)", "Themes often put backdrop-filter: blur(0px) on parent panes. That silently makes them a backdrop root and stops glass inside them from refracting. This clears it on the ancestors only while glass is active.", () => s.neutralizeAncestors, v => this.updateSetting("neutralizeAncestors", v));

            // debug
            heading("Debug");
            toggle("Inspector hotkey (Ctrl + Shift + G)", "Open a popout / profile / whatever, press the hotkey and click it. Tells you if it's glass and why not. Settings closes popouts so use the hotkey instead of the picker for those.", () => s.hotkey, v => this.updateSetting("hotkey", v));
            toggle("Highlight glass surfaces", "Dashed outline on every active surface.", () => s.highlight, v => this.updateSetting("highlight", v));
            toggle("Debug logging", "Logs skipped surfaces and any ancestor that blocks refraction.", () => s.debug, v => this.updateSetting("debug", v));

            const diagRow = document.createElement("div");
            diagRow.style.cssText = "display:flex;gap:8px;";
            diagRow.append(button("Run diagnostics", () => this.diagnose()));
            panel.appendChild(diagRow);
        };

        render();
        return panel;
    }
};
