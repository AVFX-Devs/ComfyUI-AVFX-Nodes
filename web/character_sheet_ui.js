import { app } from "../../scripts/app.js";

const DEFAULT_META = {
    brief_description: "A cast of six photorealistic characters for one deep-space military squad and the alien entity they encountered. All six must look like the same cohesive set.",
    art_style_and_medium: "gritty sci-fi realism, realistic scarred armor plating and weathered skin textures, heavy wear (scratched, scorched, oil-stained, corroded)",
    setting_and_era: "far-future deep-space frontier outpost",
    palette_and_mood: "gunmetal grey, burnt orange, olive drab, isolated and tense",
    framing_and_layout: "full-body character sheet, neutral front-facing turnaround pose",
    lighting_and_backdrop: "dramatic rim lighting against a dark neutral grey studio backdrop"
};

const DEFAULT_CHAR = () => ({
    enabled: true,
    collapsed: false,
    role_archetype: "Squad Commander",
    age_build: "woman in her 40s, athletic battle-hardened build",
    head_hair: "buzzcut with silver temples",
    face_body: "weathered skin, scarred left eyebrow, stoic expression",
    outfit_fabrics: "heavy gunmetal chest plate with burnt-orange shoulder pauldron, tattered olive-drab tactical cloak",
    accessories_props: "wrist-mounted tactical scanner, worn utility belt",
    footwear: "scuffed magnetic combat boots",
    pose_expression: "confident upright stance, eyes locked forward"
});

const EMPTY_CHAR = () => ({
    enabled: true,
    collapsed: false,
    role_archetype: "",
    age_build: "",
    head_hair: "",
    face_body: "",
    outfit_fabrics: "",
    accessories_props: "",
    footwear: "",
    pose_expression: ""
});

const META_FIELDS = [
    { key: "brief_description", label: "BRIEF DESCRIPTION:", placeholder: "e.g. A cast of six photorealistic characters..." },
    { key: "art_style_and_medium", label: "ART STYLE & MEDIUM:", placeholder: "e.g. gritty sci-fi realism, realistic textures..." },
    { key: "setting_and_era", label: "SETTING AND ERA:", placeholder: "e.g. far-future deep-space frontier outpost" },
    { key: "palette_and_mood", label: "PALETTE AND MOOD:", placeholder: "e.g. gunmetal grey, burnt orange, isolated and tense" },
    { key: "framing_and_layout", label: "FRAMING & LAYOUT:", placeholder: "e.g. full-body character sheet, front-facing turnaround" },
    { key: "lighting_and_backdrop", label: "LIGHTING & BACKDROP:", placeholder: "e.g. dramatic rim lighting against neutral grey backdrop" }
];

const CHAR_FIELDS = [
    { key: "role_archetype", label: "ROLE / ARCHETYPE:", placeholder: "e.g. Squad Commander" },
    { key: "age_build", label: "AGE & BUILD:", placeholder: "e.g. woman in her 40s, athletic build" },
    { key: "head_hair", label: "HEAD & HAIR:", placeholder: "e.g. buzzcut with silver temples" },
    { key: "face_body", label: "FACE & BODY:", placeholder: "e.g. weathered skin, scarred eyebrow" },
    { key: "outfit_fabrics", label: "OUTFIT & FABRICS:", placeholder: "e.g. heavy gunmetal chest plate, tattered cloak" },
    { key: "accessories_props", label: "ACCESSORIES & PROPS:", placeholder: "e.g. wrist scanner, utility belt" },
    { key: "footwear", label: "FOOTWEAR:", placeholder: "e.g. scuffed magnetic combat boots" },
    { key: "pose_expression", label: "POSE & EXPRESSION:", placeholder: "e.g. confident upright stance, stoic gaze" }
];

function hideNativeWidget(widget) {
    if (!widget) return;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
}

const NODE_NAMES = ["AVFX_CharacterSheetConcat", "AVFX_CharacterSheetVision"];

app.registerExtension({
    name: "AVFX.CharacterSheet.UI",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.includes(nodeData.name)) return;
        // The vision collector shares this UI, but its cards are filled from vision inputs.
        const isVision = nodeData.name === "AVFX_CharacterSheetVision";

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (onNodeCreated) onNodeCreated.apply(this, arguments);

            const metaWidget = this.widgets?.find((w) => w.name === "meta_json");
            const charsWidget = this.widgets?.find((w) => w.name === "characters_json");

            hideNativeWidget(metaWidget);
            hideNativeWidget(charsWidget);

            let metaState = { ...DEFAULT_META };
            try {
                if (metaWidget && metaWidget.value) {
                    const parsed = JSON.parse(metaWidget.value);
                    if (parsed && typeof parsed === "object") {
                        metaState = { ...DEFAULT_META, ...parsed };
                    }
                }
            } catch (e) {}

            let charList = [isVision ? EMPTY_CHAR() : DEFAULT_CHAR()];
            try {
                if (charsWidget && charsWidget.value) {
                    const parsed = JSON.parse(charsWidget.value);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        charList = parsed.map((c) => ({ ...EMPTY_CHAR(), ...c }));
                    }
                }
            } catch (e) {}

            // Outer element: this is what ComfyUI stretches to the node's widget area.
            const container = document.createElement("div");
            container.style.cssText = [
                "box-sizing: border-box",
                "width: 100%",
                "overflow-y: auto"
            ].join(";");

            // Inner element: always its natural height, so we can measure the real content
            // size. (Measuring the outer element only ever grows, because it is stretched.)
            const content = document.createElement("div");
            content.style.cssText = [
                "display: flex",
                "flex-direction: column",
                "gap: 10px",
                "padding: 6px 4px",
                "box-sizing: border-box",
                "width: 100%",
                "font-family: sans-serif",
                "color: #e2e2e2",
                "user-select: none"
            ].join(";");
            container.appendChild(content);

            let countBadge = null;
            let dupSelect = null;
            let dupIndex = 0;
            let dragIndex = null;
            let visionStatus = "";

            const charLabel = (c, i) => {
                const role = String((c && c.role_archetype) || "").trim();
                return role ? `${i + 1}. ${role}` : `Character ${i + 1}`;
            };

            // Rebuild the "Duplicate" dropdown so it always lists the current characters.
            const refreshDupOptions = () => {
                if (!dupSelect) return;
                if (dupIndex >= charList.length) dupIndex = charList.length - 1;
                if (dupIndex < 0) dupIndex = 0;
                dupSelect.innerHTML = "";
                charList.forEach((c, i) => {
                    const opt = document.createElement("option");
                    opt.value = String(i);
                    opt.textContent = charLabel(c, i);
                    dupSelect.appendChild(opt);
                });
                dupSelect.value = String(dupIndex);
            };

            const syncToWidgets = () => {
                if (metaWidget) {
                    metaWidget.value = JSON.stringify(metaState);
                }
                if (charsWidget) {
                    charsWidget.value = JSON.stringify(charList);
                }
                if (countBadge) {
                    const activeCount = charList.filter((c) => c.enabled !== false).length;
                    countBadge.textContent = `NUMBER OF SHEETS: ${activeCount}`;
                }
                refreshDupOptions();
            };

            const updateNodeHeight = () => {
                requestAnimationFrame(() => {
                    // Fit the node to the real content height, so it also shrinks
                    // after characters are removed.
                    const desiredHeight = Math.max(200, content.scrollHeight + 56);
                    const currentWidth = Math.max(520, this.size[0]);
                    this.setSize([currentWidth, desiredHeight]);
                    this.setDirtyCanvas(true, true);
                });
            };

            const createInputField = (labelText, value, placeholderText, onInput) => {
                const wrap = document.createElement("div");
                wrap.style.cssText = "display: flex; flex-direction: column; gap: 3px; width: 100%;";

                const lbl = document.createElement("div");
                lbl.textContent = labelText;
                lbl.style.cssText = "font-size: 10px; font-weight: 700; letter-spacing: 0.4px; color: #a8b0b8;";

                const inp = document.createElement("input");
                inp.type = "text";
                inp.value = value || "";
                inp.placeholder = placeholderText || "";
                inp.style.cssText = [
                    "width: 100%",
                    "box-sizing: border-box",
                    "background: #16181a",
                    "border: 1px solid #34383d",
                    "border-radius: 4px",
                    "color: #f0f0f0",
                    "padding: 5px 8px",
                    "font-size: 12px",
                    "outline: none"
                ].join(";");

                inp.addEventListener("focus", () => {
                    inp.style.borderColor = "#3d8bfd";
                    inp.select();
                });
                inp.addEventListener("blur", () => {
                    inp.style.borderColor = "#34383d";
                });
                inp.addEventListener("keydown", (e) => {
                    e.stopPropagation();
                });
                inp.addEventListener("input", (e) => {
                    onInput(e.target.value);
                    syncToWidgets();
                });

                wrap.appendChild(lbl);
                wrap.appendChild(inp);
                return wrap;
            };

            const render = () => {
                content.innerHTML = "";

                if (isVision) {
                    const hint = document.createElement("div");
                    hint.style.cssText = "background: #1f2a24; border: 1px solid #2f7a55; border-radius: 6px; padding: 8px 10px; font-size: 11px; line-height: 1.4; color: #b7e4cf;";
                    hint.textContent = "Connect the vision outputs to vision_1, vision_2, ... Run once with the switch on: the cards fill from the images, then the switch turns off so your edits stay. Edit any field freely.";
                    content.appendChild(hint);
                    if (visionStatus) {
                        const st = document.createElement("div");
                        st.style.cssText = "font-size: 10px; color: #a8b0b8; padding: 0 2px; word-break: break-word;";
                        st.textContent = visionStatus;
                        content.appendChild(st);
                    }
                }

                // Top Scene & Style Card
                const topCard = document.createElement("div");
                topCard.style.cssText = [
                    "background: #232629",
                    "border: 1px solid #363a3f",
                    "border-radius: 6px",
                    "padding: 10px",
                    "display: flex",
                    "flex-direction: column",
                    "gap: 7px"
                ].join(";");

                const topHeader = document.createElement("div");
                topHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;";

                const topTitle = document.createElement("span");
                topTitle.textContent = "SCENE & STYLE BRIEF";
                topTitle.style.cssText = "font-size: 11px; font-weight: 700; color: #d0d5dd; letter-spacing: 0.5px;";

                countBadge = document.createElement("span");
                const activeCount = charList.filter((c) => c.enabled !== false).length;
                countBadge.textContent = `NUMBER OF SHEETS: ${activeCount}`;
                countBadge.style.cssText = [
                    "background: #1d4d36",
                    "color: #6ee7b7",
                    "border: 1px solid #2b6cb0",
                    "border-color: #2f7a55",
                    "border-radius: 4px",
                    "padding: 2px 7px",
                    "font-size: 10px",
                    "font-weight: 700"
                ].join(";");

                topHeader.appendChild(topTitle);
                topHeader.appendChild(countBadge);
                topCard.appendChild(topHeader);

                for (const f of META_FIELDS) {
                    const fieldEl = createInputField(
                        f.label,
                        metaState[f.key],
                        f.placeholder,
                        (val) => {
                            metaState[f.key] = val;
                        }
                    );
                    topCard.appendChild(fieldEl);
                }

                content.appendChild(topCard);

                // Character Cards (collapsible, drag-to-reorder)
                const cardEls = [];
                const clearDropMarks = () => {
                    cardEls.forEach((el) => {
                        el.style.boxShadow = "none";
                    });
                };

                charList.forEach((charObj, index) => {
                    const isEnabled = charObj.enabled !== false;
                    const isCollapsed = charObj.collapsed === true;
                    const card = document.createElement("div");
                    card.style.cssText = [
                        "background: #232629",
                        `border: 1px solid ${isEnabled ? "#363a3f" : "#2a2c30"}`,
                        "border-radius: 6px",
                        "padding: 10px",
                        "display: flex",
                        "flex-direction: column",
                        "gap: 7px",
                        `opacity: ${isEnabled ? "1" : "0.6"}`
                    ].join(";");
                    cardEls.push(card);

                    const header = document.createElement("div");
                    header.style.cssText = `display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: ${isCollapsed ? "0" : "2px"};`;

                    const leftGroup = document.createElement("div");
                    leftGroup.style.cssText = "display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1;";

                    // Dotted drag handle (left side). Only the handle starts a drag,
                    // so selecting text inside the input fields still works normally.
                    const grip = document.createElement("div");
                    grip.title = "Drag to change the order";
                    grip.style.cssText = [
                        "width: 8px",
                        "height: 14px",
                        "flex: 0 0 auto",
                        "cursor: grab",
                        "background-image: radial-gradient(circle, #868e96 1.2px, transparent 1.4px)",
                        "background-size: 4px 4px"
                    ].join(";");
                    grip.addEventListener("mousedown", () => { card.draggable = true; });
                    grip.addEventListener("mouseup", () => { card.draggable = false; });

                    const toggleBtn = document.createElement("button");
                    toggleBtn.type = "button";
                    toggleBtn.textContent = isEnabled ? "ON" : "OFF";
                    toggleBtn.style.cssText = [
                        `background: ${isEnabled ? "#d9531e" : "#495057"}`,
                        "color: #ffffff",
                        "border: none",
                        "border-radius: 10px",
                        "padding: 2px 9px",
                        "font-size: 10px",
                        "font-weight: 700",
                        "cursor: pointer",
                        "flex: 0 0 auto"
                    ].join(";");
                    toggleBtn.addEventListener("click", () => {
                        charList[index].enabled = !isEnabled;
                        syncToWidgets();
                        render();
                    });

                    const charTitle = document.createElement("span");
                    charTitle.textContent = `Character ${index + 1}`;
                    charTitle.style.cssText = "font-size: 12px; font-weight: 700; color: #f1f3f5; white-space: nowrap; flex: 0 0 auto;";

                    // Role name next to the title, so a collapsed card is still recognisable.
                    const roleSpan = document.createElement("span");
                    roleSpan.textContent = String(charObj.role_archetype || "").trim();
                    roleSpan.style.cssText = "font-size: 11px; color: #868e96; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;";

                    leftGroup.appendChild(grip);
                    leftGroup.appendChild(toggleBtn);
                    leftGroup.appendChild(charTitle);
                    leftGroup.appendChild(roleSpan);

                    const rightGroup = document.createElement("div");
                    rightGroup.style.cssText = "display: flex; align-items: center; gap: 2px; flex: 0 0 auto;";

                    const iconBtnStyle = [
                        "background: transparent",
                        "border: none",
                        "color: #868e96",
                        "font-size: 14px",
                        "line-height: 1",
                        "cursor: pointer",
                        "padding: 2px 6px"
                    ].join(";");

                    // Collapse (-) / expand (square), like window minimise / maximise.
                    const collapseBtn = document.createElement("button");
                    collapseBtn.type = "button";
                    collapseBtn.textContent = isCollapsed ? "□" : "–";
                    collapseBtn.title = isCollapsed ? "Expand" : "Collapse";
                    collapseBtn.style.cssText = iconBtnStyle;
                    collapseBtn.addEventListener("mouseenter", () => { collapseBtn.style.color = "#ffffff"; });
                    collapseBtn.addEventListener("mouseleave", () => { collapseBtn.style.color = "#868e96"; });
                    collapseBtn.addEventListener("click", () => {
                        charList[index].collapsed = !isCollapsed;
                        syncToWidgets();
                        render();
                    });

                    const delBtn = document.createElement("button");
                    delBtn.type = "button";
                    delBtn.textContent = "✕";
                    delBtn.title = "Remove character";
                    delBtn.style.cssText = iconBtnStyle;
                    delBtn.addEventListener("mouseenter", () => { delBtn.style.color = "#ffffff"; });
                    delBtn.addEventListener("mouseleave", () => { delBtn.style.color = "#868e96"; });
                    delBtn.addEventListener("click", () => {
                        if (charList.length > 1) {
                            charList.splice(index, 1);
                        } else {
                            charList[0] = EMPTY_CHAR();
                        }
                        syncToWidgets();
                        render();
                    });

                    rightGroup.appendChild(collapseBtn);
                    rightGroup.appendChild(delBtn);

                    header.appendChild(leftGroup);
                    header.appendChild(rightGroup);
                    card.appendChild(header);

                    // Drag and drop reordering
                    card.addEventListener("dragstart", (e) => {
                        dragIndex = index;
                        if (e.dataTransfer) {
                            e.dataTransfer.effectAllowed = "move";
                            try { e.dataTransfer.setData("text/plain", String(index)); } catch (err) {}
                        }
                        card.style.opacity = "0.45";
                    });
                    card.addEventListener("dragend", () => {
                        card.draggable = false;
                        card.style.opacity = isEnabled ? "1" : "0.6";
                        dragIndex = null;
                        clearDropMarks();
                    });
                    card.addEventListener("dragover", (e) => {
                        if (dragIndex === null) return;
                        e.preventDefault();
                        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                        const r = card.getBoundingClientRect();
                        const after = e.clientY > r.top + r.height / 2;
                        clearDropMarks();
                        card.style.boxShadow = after ? "0 3px 0 0 #3d8bfd" : "0 -3px 0 0 #3d8bfd";
                        card.dataset.dropAfter = after ? "1" : "0";
                    });
                    card.addEventListener("drop", (e) => {
                        if (dragIndex === null) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const from = dragIndex;
                        let to = index + (card.dataset.dropAfter === "1" ? 1 : 0);
                        dragIndex = null;
                        clearDropMarks();
                        if (to === from || to === from + 1) return; // dropped back in place
                        const keep = charList[dupIndex]; // keep the Duplicate dropdown on the same character
                        const moved = charList.splice(from, 1)[0];
                        if (from < to) to -= 1;
                        charList.splice(to, 0, moved);
                        const keepIdx = charList.indexOf(keep);
                        if (keepIdx >= 0) dupIndex = keepIdx;
                        syncToWidgets();
                        render();
                    });

                    if (!isCollapsed) {
                        for (const f of CHAR_FIELDS) {
                            const fieldEl = createInputField(
                                f.label,
                                charObj[f.key],
                                f.placeholder,
                                (val) => {
                                    charList[index][f.key] = val;
                                    if (f.key === "role_archetype") {
                                        roleSpan.textContent = String(val || "").trim();
                                    }
                                }
                            );
                            card.appendChild(fieldEl);
                        }
                    }

                    content.appendChild(card);
                });

                // Bottom Action Bar
                const btnRow = document.createElement("div");
                btnRow.style.cssText = "display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 2px;";

                const makeActionBtn = (text, bg, hoverBg, onClick) => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.textContent = text;
                    btn.style.cssText = [
                        `background: ${bg}`,
                        "color: #ffffff",
                        "border: 1px solid rgba(255,255,255,0.08)",
                        "border-radius: 5px",
                        "padding: 7px 10px",
                        "font-size: 11px",
                        "font-weight: 700",
                        "cursor: pointer"
                    ].join(";");
                    btn.addEventListener("mouseenter", () => { btn.style.background = hoverBg; });
                    btn.addEventListener("mouseleave", () => { btn.style.background = bg; });
                    btn.addEventListener("click", onClick);
                    return btn;
                };

                btnRow.appendChild(makeActionBtn("+ Add character", "#2b6e4a", "#35855a", () => {
                    charList.push(EMPTY_CHAR());
                    syncToWidgets();
                    render();
                }));

                btnRow.appendChild(makeActionBtn("Clear all", "#34383d", "#43484e", () => {
                    metaState = {
                        brief_description: "",
                        art_style_and_medium: "",
                        setting_and_era: "",
                        palette_and_mood: "",
                        framing_and_layout: "",
                        lighting_and_backdrop: ""
                    };
                    charList = [EMPTY_CHAR()];
                    syncToWidgets();
                    render();
                }));

                btnRow.appendChild(makeActionBtn("Reset", "#34383d", "#43484e", () => {
                    metaState = { ...DEFAULT_META };
                    charList = [isVision ? EMPTY_CHAR() : DEFAULT_CHAR()];
                    syncToWidgets();
                    render();
                }));

                // Duplicate row: pick a character from the dropdown, then clone it.
                const dupRow = document.createElement("div");
                dupRow.style.cssText = "display: flex; align-items: center; gap: 8px; margin-top: 2px;";

                const dupLabel = document.createElement("span");
                dupLabel.textContent = "DUPLICATE:";
                dupLabel.style.cssText = "font-size: 10px; font-weight: 700; letter-spacing: 0.4px; color: #a8b0b8; white-space: nowrap;";

                dupSelect = document.createElement("select");
                dupSelect.style.cssText = [
                    "flex: 1",
                    "min-width: 0",
                    "box-sizing: border-box",
                    "background: #16181a",
                    "border: 1px solid #34383d",
                    "border-radius: 4px",
                    "color: #f0f0f0",
                    "padding: 5px 8px",
                    "font-size: 12px",
                    "outline: none",
                    "cursor: pointer"
                ].join(";");
                dupSelect.addEventListener("change", () => {
                    dupIndex = parseInt(dupSelect.value, 10) || 0;
                });
                dupSelect.addEventListener("keydown", (e) => {
                    e.stopPropagation();
                });

                const dupBtn = makeActionBtn("Duplicate", "#2b6e4a", "#35855a", () => {
                    const src = charList[dupIndex];
                    if (!src) return;
                    // Deep copy so editing the copy never changes the original.
                    const copy = JSON.parse(JSON.stringify(src));
                    copy.collapsed = false;
                    // Insert the copy directly after the original so the order stays logical.
                    charList.splice(dupIndex + 1, 0, copy);
                    syncToWidgets();
                    render();
                });
                dupBtn.style.flex = "0 0 auto";

                dupRow.appendChild(dupLabel);
                dupRow.appendChild(dupSelect);
                dupRow.appendChild(dupBtn);
                content.appendChild(dupRow);

                content.appendChild(btnRow);
                syncToWidgets();
                updateNodeHeight();
            };

            const domWidget = this.addDOMWidget("character_sheet_builder_ui", "div", container, {
                serialize: false,
                hideOnZoom: false
            });

            domWidget.computeSize = (width) => {
                const h = Math.max(200, content.scrollHeight + 16);
                return [width, h];
            };

            // Vision node: after a run, show what the vision model read in the cards,
            // then switch "fill from vision" off so manual edits are kept from now on.
            if (isVision) {
                const origOnExecuted = this.onExecuted;
                this.onExecuted = function (message) {
                    if (origOnExecuted) origOnExecuted.apply(this, arguments);
                    try {
                        visionStatus = (message && message.vision_status && message.vision_status[0]) || "";
                        const filled = !!(message && message.filled && message.filled[0] === "1");
                        if (filled && message.characters_json && message.characters_json[0]) {
                            const parsed = JSON.parse(message.characters_json[0]);
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                charList = parsed.map((c) => ({ ...EMPTY_CHAR(), ...c }));
                            }
                            const sw = this.widgets?.find((w) => w.name === "fill_from_vision");
                            if (sw) sw.value = false;
                        }
                    } catch (e) {}
                    syncToWidgets();
                    render();
                    this.setDirtyCanvas(true, true);
                };
            }

            // Restore state when loading saved workflows
            const origOnConfigure = this.onConfigure;
            this.onConfigure = function (info) {
                if (origOnConfigure) origOnConfigure.apply(this, arguments);
                hideNativeWidget(metaWidget);
                hideNativeWidget(charsWidget);
                try {
                    if (metaWidget && metaWidget.value) {
                        const parsed = JSON.parse(metaWidget.value);
                        if (parsed && typeof parsed === "object") {
                            metaState = { ...DEFAULT_META, ...parsed };
                        }
                    }
                } catch (e) {}
                try {
                    if (charsWidget && charsWidget.value) {
                        const parsed = JSON.parse(charsWidget.value);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            charList = parsed.map((c) => ({ ...EMPTY_CHAR(), ...c }));
                        }
                    }
                } catch (e) {}
                render();
            };

            render();
        };
    }
});
