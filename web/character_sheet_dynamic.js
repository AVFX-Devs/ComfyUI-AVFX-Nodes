import { app } from "../../scripts/app.js";

// Auto-growing sockets: the node always shows the connected sockets plus ONE empty one.
// Connect the last visible socket and the next one appears. Disconnect and the extras go away.
// The backend declares every socket up to `max`; the browser just hides the unused ones.
const DYNAMIC = {
    AVFX_CharacterSheetVision: { prefix: "vision_", type: "STRING", max: 16 },
    AVFX_CharacterSheetAllInOne: { prefix: "image_", type: "IMAGE", max: 16, status: true },
};

const SLOT_HEIGHT = 20;
const INPUT = 1; // LiteGraph.INPUT

function dynamicInputs(node, cfg) {
    const re = new RegExp("^" + cfg.prefix + "(\\d+)$");
    const out = [];
    (node.inputs || []).forEach((inp, idx) => {
        const m = re.exec(inp.name || "");
        if (m) out.push({ inp, idx, n: parseInt(m[1], 10) });
    });
    return out;
}

function updateSlots(node, cfg) {
    if (node.__csBusy) return;
    node.__csBusy = true;
    try {
        const before = dynamicInputs(node, cfg);
        let highest = 0;
        for (const d of before) {
            if (d.inp.link != null) highest = Math.max(highest, d.n);
        }
        const want = Math.min(cfg.max, highest + 1);

        // Remove unconnected sockets above the wanted count, last one first so indices stay valid.
        before
            .filter((d) => d.n > want && d.inp.link == null)
            .sort((a, b) => b.idx - a.idx)
            .forEach((d) => node.removeInput(d.idx));

        // Add any missing sockets up to the wanted count.
        const have = new Set(dynamicInputs(node, cfg).map((d) => d.n));
        for (let n = 1; n <= want; n++) {
            if (!have.has(n)) node.addInput(cfg.prefix + n, cfg.type);
        }

        const after = dynamicInputs(node, cfg).length;
        const delta = (after - before.length) * SLOT_HEIGHT;
        if (delta !== 0 && node.size) {
            node.setSize([node.size[0], Math.max(100, node.size[1] + delta)]);
        }
        if (node.setDirtyCanvas) node.setDirtyCanvas(true, true);
    } finally {
        node.__csBusy = false;
    }
}

function addStatusWidget(node) {
    const box = document.createElement("textarea");
    box.readOnly = true;
    box.placeholder = "Status appears here after a run";
    box.style.cssText =
        "width:100%;height:100%;box-sizing:border-box;resize:none;background:#1b1b1b;color:#bbb;" +
        "border:1px solid #333;border-radius:4px;font-size:11px;padding:6px;";
    const widget = node.addDOMWidget("status_view", "div", box, {
        serialize: false,
        hideOnZoom: false,
    });
    widget.computeSize = (width) => [width, 90];
    node.__csStatusBox = box;
}

app.registerExtension({
    name: "AVFX.CharacterSheet.DynamicInputs",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        const cfg = DYNAMIC[nodeData.name];
        if (!cfg) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origCreated ? origCreated.apply(this, arguments) : undefined;
            if (cfg.status) addStatusWidget(this);
            setTimeout(() => updateSlots(this, cfg), 0);
            return r;
        };

        const origConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = origConfigure ? origConfigure.apply(this, arguments) : undefined;
            setTimeout(() => updateSlots(this, cfg), 0);
            return r;
        };

        const origChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type) {
            const r = origChange ? origChange.apply(this, arguments) : undefined;
            if (type === INPUT) setTimeout(() => updateSlots(this, cfg), 0);
            return r;
        };

        if (cfg.status) {
            const origExecuted = nodeType.prototype.onExecuted;
            nodeType.prototype.onExecuted = function (message) {
                if (origExecuted) origExecuted.apply(this, arguments);
                const text = message && message.status && message.status[0];
                if (this.__csStatusBox && typeof text === "string") this.__csStatusBox.value = text;
            };
        }
    },
});
