import json
import re

from .character_sheet_concat_node import CharacterSheetConcatNode

# Same fields as the character cards in the UI.
FIELD_KEYS = [
    "role_archetype",
    "age_build",
    "head_hair",
    "face_body",
    "outfit_fabrics",
    "accessories_props",
    "footwear",
    "pose_expression",
]

# Accepted alternative names a vision model might use.
KEY_ALIASES = {
    "role": "role_archetype",
    "archetype": "role_archetype",
    "age": "age_build",
    "build": "age_build",
    "hair": "head_hair",
    "head": "head_hair",
    "face": "face_body",
    "outfit": "outfit_fabrics",
    "clothing": "outfit_fabrics",
    "accessories": "accessories_props",
    "props": "accessories_props",
    "shoes": "footwear",
    "pose": "pose_expression",
    "expression": "pose_expression",
}

MAX_SLOTS = 16


def _empty_char():
    char = {"enabled": True, "collapsed": False}
    for key in FIELD_KEYS:
        char[key] = ""
    return char


def _extract_json(text):
    """Pull one JSON object out of a vision model reply (tolerates code fences and chatter)."""
    if not text:
        return None
    text = str(text).strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except Exception:
        return None
    if isinstance(data, list):
        data = next((d for d in data if isinstance(d, dict)), None)
    return data if isinstance(data, dict) else None


def _clean_value(value):
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = ", ".join(str(v).strip() for v in value if str(v).strip())
    return str(value).strip()


class CharacterSheetVisionNode:
    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            f"vision_{i}": ("STRING", {"forceInput": True})
            for i in range(1, MAX_SLOTS + 1)
        }
        return {
            "required": {
                "meta_json": ("STRING", {"default": "{}", "multiline": False}),
                "characters_json": ("STRING", {"default": "[]", "multiline": False}),
                "fill_from_vision": ("BOOLEAN", {
                    "default": True,
                    "label_on": "fill from vision (turns off after filling)",
                    "label_off": "keep my edits",
                }),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("formatted_prompt",)
    FUNCTION = "collect"
    CATEGORY = "AVFX/Prompt Builders"
    # Output node: it can be run on its own ("run selected output nodes"),
    # so you can fill the cards and edit them before any image is generated.
    OUTPUT_NODE = True

    def collect(self, meta_json="", characters_json="", fill_from_vision=True, **kwargs):
        try:
            characters = json.loads(characters_json) if characters_json and characters_json.strip() else []
        except Exception:
            characters = []
        if not isinstance(characters, list):
            characters = []
        characters = [c for c in characters if isinstance(c, dict)]

        status = []
        filled_any = False

        if fill_from_vision:
            for slot in range(1, MAX_SLOTS + 1):
                raw = kwargs.get(f"vision_{slot}")
                if raw is None or not str(raw).strip():
                    continue
                data = _extract_json(raw)
                if data is None:
                    status.append(f"Slot {slot}: could not read JSON from the vision model")
                    continue

                # Normalise key names, then copy non-empty values into the card.
                values = {}
                for key, value in data.items():
                    norm = KEY_ALIASES.get(str(key).strip().lower(), str(key).strip().lower())
                    if norm in FIELD_KEYS:
                        values[norm] = _clean_value(value)

                while len(characters) < slot:
                    characters.append(_empty_char())
                target = characters[slot - 1]
                count = 0
                for key in FIELD_KEYS:
                    if values.get(key):
                        target[key] = values[key]
                        count += 1
                if count:
                    filled_any = True
                status.append(f"Slot {slot}: filled {count} of {len(FIELD_KEYS)} fields")

        formatted = CharacterSheetConcatNode().build_prompt(meta_json, json.dumps(characters))[0]

        ui = {
            "characters_json": [json.dumps(characters)],
            "vision_status": [" | ".join(status)],
            "filled": ["1" if filled_any else "0"],
        }
        return {"ui": ui, "result": (formatted,)}


NODE_CLASS_MAPPINGS = {
    "AVFX_CharacterSheetVision": CharacterSheetVisionNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AVFX_CharacterSheetVision": "AVFX Character Sheet Prompt Collector (Vision)"
}
