import gc
import inspect
import json
import os
import re
import traceback

from .character_sheet_concat_node import CharacterSheetConcatNode
from .character_sheet_vision_node import (
    FIELD_KEYS,
    KEY_ALIASES,
    _clean_value,
    _empty_char,
    _extract_json,
)

MAX_IMAGES = 16
EXTRACT_MAX_LENGTH = 512
_PKG_DIR = os.path.dirname(os.path.abspath(__file__))

SEPARATORS = {
    "--- with blank lines": "\n\n---\n\n",
    "blank line only": "\n\n",
    "one prompt per line": "\n",
}

_FALLBACK_VISION_PROMPT = (
    "You analyze ONE reference image of a character. Output ONLY one raw JSON object with exactly these keys: "
    + ", ".join(FIELD_KEYS)
    + ". Every value is a short plain-text description of what is visible, or an empty string."
)
_FALLBACK_WRITER_PROMPT = (
    "You write image-generation prompts for character turnaround sheets. Write exactly one prompt per numbered "
    "character, each as one paragraph, separated by a blank line, a line containing only ---, and a blank line."
)


def _read_text(filename, fallback):
    try:
        with open(os.path.join(_PKG_DIR, filename), "r", encoding="utf-8") as f:
            text = f.read().strip()
            return text or fallback
    except Exception:
        return fallback


# ---------------------------------------------------------------- ComfyUI helpers

def _model_list():
    try:
        import folder_paths
        for folder in ("text_encoders", "clip"):
            try:
                names = folder_paths.get_filename_list(folder)
            except Exception:
                names = []
            if names:
                return sorted(names)
    except ImportError:
        pass
    return ["(no text encoders found)"]


def _default_model(names):
    for n in names:
        if "qwen3vl_8b" in n.lower():
            return n
    return names[0]


def _clip_type_list():
    try:
        import comfy.sd
        names = [t.name.lower() for t in comfy.sd.CLIPType]
    except Exception:
        names = []
    if "stable_diffusion" not in names:
        names.insert(0, "stable_diffusion")
    return names


_CLIP_CACHE = {}


def _load_clip(name, clip_type):
    key = (name, clip_type)
    if key in _CLIP_CACHE:
        return _CLIP_CACHE[key]

    import comfy.sd
    import folder_paths

    ctype = getattr(comfy.sd.CLIPType, clip_type.upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)
    path = None
    for folder in ("text_encoders", "clip"):
        try:
            path = folder_paths.get_full_path(folder, name)
        except Exception:
            path = None
        if path:
            break
    if not path:
        raise FileNotFoundError(f"Text encoder file not found: {name}")

    clip = comfy.sd.load_clip(
        ckpt_paths=[path],
        embedding_directory=folder_paths.get_folder_paths("embeddings"),
        clip_type=ctype,
    )
    _CLIP_CACHE.clear()
    _CLIP_CACHE[key] = clip
    return clip


def _unload_clip():
    _CLIP_CACHE.clear()
    gc.collect()
    try:
        import comfy.model_management as mm
        mm.soft_empty_cache()
    except Exception:
        pass


def _accepts(fn, name):
    """True when a callable has a parameter with this exact name."""
    try:
        return name in inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False


def _accepts_any_kwargs(fn):
    try:
        return any(p.kind == inspect.Parameter.VAR_KEYWORD for p in inspect.signature(fn).parameters.values())
    except (TypeError, ValueError):
        return True


def _filter_kwargs(fn, kwargs):
    if _accepts_any_kwargs(fn):
        return kwargs
    return {k: v for k, v in kwargs.items() if _accepts(fn, k)}


def _tokenizer_param(clip, names):
    """Find which of `names` the tokenizer (or any nested tokenizer) explicitly accepts."""
    seen = set()
    stack = [getattr(clip, "tokenizer", None)]
    while stack:
        obj = stack.pop()
        if obj is None or id(obj) in seen:
            continue
        seen.add(id(obj))
        for meth in ("tokenize_with_weights", "tokenize"):
            fn = getattr(obj, meth, None)
            if fn is None:
                continue
            for name in names:
                if _accepts(fn, name):
                    return name
        try:
            stack.extend(v for v in vars(obj).values() if hasattr(v, "tokenize_with_weights"))
        except TypeError:
            pass
    return None


class _Generator:
    """Runs text/vision generation on a CLIP-style model the same way the built-in Generate Text node does."""

    def __init__(self, clip, temperature, seed):
        self.clip = clip
        self.temperature = float(temperature)
        self.seed = int(seed)
        self.system_kw = _tokenizer_param(clip, ["system_prompt"])
        self.image_kw = _tokenizer_param(clip, ["image", "images"]) or "image"
        self.used_system_kw = False

    def generate(self, system_prompt, user_prompt, image=None, max_length=512, seed_offset=0):
        text = user_prompt
        tok_kwargs = {"skip_template": False, "min_length": 1, "thinking": False}
        if image is not None:
            tok_kwargs[self.image_kw] = [image] if self.image_kw == "images" else image
        if system_prompt:
            if self.system_kw:
                tok_kwargs[self.system_kw] = system_prompt
                self.used_system_kw = True
            else:
                text = f"{system_prompt}\n\n{user_prompt}"

        tokens = self.clip.tokenize(text, **tok_kwargs)
        gen_kwargs = dict(
            do_sample=self.temperature > 0,
            max_length=int(max_length),
            temperature=self.temperature if self.temperature > 0 else 1.0,
            top_k=64,
            top_p=0.95,
            min_p=0.05,
            repetition_penalty=1.05,
            presence_penalty=0.0,
            seed=self.seed + seed_offset,
        )
        gen_kwargs = _filter_kwargs(self.clip.generate, gen_kwargs)
        ids = self.clip.generate(tokens, **gen_kwargs)
        out = self.clip.decode(ids, skip_special_tokens=True)
        return re.sub(r"<think>.*?</think>", "", str(out), flags=re.S).strip()


def _flatten_images(kwargs):
    """image_1..image_16 in numeric order; a batch of several images counts as several characters."""
    found = []
    for i in range(1, MAX_IMAGES + 1):
        t = kwargs.get(f"image_{i}")
        if t is None:
            continue
        try:
            count = int(t.shape[0])
        except Exception:
            found.append((i, t))
            continue
        for b in range(count):
            found.append((i, t[b:b + 1]))
    return found


def _split_prompts(text):
    text = re.sub(r"<think>.*?</think>", "", str(text), flags=re.S)
    parts = re.split(r"(?:^|\n)[ \t]*-{3,}[ \t]*(?:\n|$)", text)
    prompts = []
    for part in parts:
        flat = " ".join(part.split())
        if flat:
            prompts.append(flat)
    return prompts


def _strip_bullet(line):
    return re.sub(r"^\s*(?:\d+[.)]|[-*•])\s*", "", line).strip()


class CharacterSheetAllInOneNode:
    @classmethod
    def INPUT_TYPES(cls):
        models = _model_list()
        optional = {
            "vision_system_prompt": ("STRING", {"forceInput": True}),
            "writer_system_prompt": ("STRING", {"forceInput": True}),
        }
        for i in range(1, MAX_IMAGES + 1):
            optional[f"image_{i}"] = ("IMAGE",)
        return {
            "required": {
                "model": (models, {"default": _default_model(models)}),
                "clip_type": (_clip_type_list(), {"default": "stable_diffusion"}),
                "brief_description": ("STRING", {"default": "", "multiline": True}),
                "art_style_and_medium": ("STRING", {"default": "", "multiline": True}),
                "setting_and_era": ("STRING", {"default": "", "multiline": False}),
                "palette_and_mood": ("STRING", {"default": "", "multiline": False}),
                "framing_and_layout": ("STRING", {"default": "full-body character sheet, neutral front-facing turnaround pose", "multiline": False}),
                "lighting_and_backdrop": ("STRING", {"default": "", "multiline": False}),
                "character_types": ("STRING", {
                    "default": "",
                    "multiline": True,
                    "placeholder": "Optional, one per line, in order: sets the role of each character and adds characters beyond your images",
                }),
                "separator": (list(SEPARATORS.keys()), {"default": "--- with blank lines"}),
                "temperature": ("FLOAT", {"default": 0.2, "min": 0.0, "max": 2.0, "step": 0.05}),
                "max_length": ("INT", {"default": 4096, "min": 256, "max": 16384}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "unload_after_run": ("BOOLEAN", {"default": False}),
            },
            "optional": optional,
        }

    RETURN_TYPES = tuple(["STRING"] * 13)
    RETURN_NAMES = (
        "rewritten_prompts",
        "formatted_brief",
        "character_cards_json",
        "image_descriptions",
        "status",
        "role_archetype",
        "age_build",
        "head_hair",
        "face_body",
        "outfit_fabrics",
        "accessories_props",
        "footwear",
        "pose_expression",
    )
    FUNCTION = "run"
    CATEGORY = "AVFX/Prompt Builders"
    OUTPUT_NODE = True

    def run(
        self,
        model,
        clip_type,
        brief_description="",
        art_style_and_medium="",
        setting_and_era="",
        palette_and_mood="",
        framing_and_layout="",
        lighting_and_backdrop="",
        character_types="",
        separator="--- with blank lines",
        temperature=0.2,
        max_length=4096,
        seed=0,
        unload_after_run=False,
        vision_system_prompt=None,
        writer_system_prompt=None,
        **kwargs,
    ):
        status = []
        images = _flatten_images(kwargs)
        types = [_strip_bullet(l) for l in str(character_types).splitlines() if _strip_bullet(l)]
        total = max(len(images), len(types))
        if total == 0:
            raise ValueError("Connect at least one image or type at least one character in character_types.")

        vision_prompt = (vision_system_prompt or "").strip() or _read_text(
            "vision_extraction_system_prompt.txt", _FALLBACK_VISION_PROMPT
        )
        writer_prompt = (writer_system_prompt or "").strip() or _read_text(
            "writer_system_prompt.txt", _FALLBACK_WRITER_PROMPT
        )

        clip = _load_clip(model, clip_type)
        gen = _Generator(clip, temperature, seed)

        cards = []
        descriptions = []
        for idx in range(total):
            card = _empty_char()
            if idx < len(images):
                source_slot, img = images[idx]
                label = f"Character {idx + 1} (image socket {source_slot})"
                try:
                    raw = gen.generate(
                        vision_prompt,
                        "Describe this character.",
                        image=img,
                        max_length=EXTRACT_MAX_LENGTH,
                        seed_offset=idx,
                    )
                    descriptions.append(f"Image {idx + 1}:\n{raw}")
                    data = _extract_json(raw)
                    if data is None:
                        status.append(f"{label}: could not read JSON from the model reply")
                    else:
                        filled = 0
                        for key, value in data.items():
                            norm = KEY_ALIASES.get(str(key).strip().lower(), str(key).strip().lower())
                            if norm in FIELD_KEYS:
                                val = _clean_value(value)
                                if val:
                                    card[norm] = val
                                    filled += 1
                        status.append(f"{label}: filled {filled} of {len(FIELD_KEYS)} fields")
                except Exception as exc:  # keep going with the other images
                    descriptions.append(f"Image {idx + 1}:\n(failed: {exc})")
                    status.append(f"{label}: failed ({type(exc).__name__}: {exc})")
                    traceback.print_exc()
            if idx < len(types):
                card["role_archetype"] = types[idx]
            cards.append(card)

        meta = {
            "brief_description": brief_description,
            "art_style_and_medium": art_style_and_medium,
            "setting_and_era": setting_and_era,
            "palette_and_mood": palette_and_mood,
            "framing_and_layout": framing_and_layout,
            "lighting_and_backdrop": lighting_and_backdrop,
        }
        formatted = CharacterSheetConcatNode().build_prompt(json.dumps(meta), json.dumps(cards))[0]

        raw_prompts = ""
        prompts = []
        try:
            raw_prompts = gen.generate(
                writer_prompt, formatted, image=None, max_length=max_length, seed_offset=1000
            )
            prompts = _split_prompts(raw_prompts)
        except Exception as exc:
            status.append(f"Writer pass failed ({type(exc).__name__}: {exc})")
            traceback.print_exc()

        if len(prompts) < total:
            status.append(f"Writer returned {len(prompts)} prompt(s), expected {total}")
        elif len(prompts) > total:
            status.append(f"Writer returned {len(prompts)} prompts, kept the first {total}")
            prompts = prompts[:total]
        else:
            status.append(f"Wrote {total} prompt(s)")
        if not gen.used_system_kw:
            status.append("System prompt was sent inside the user text (model path has no system_prompt argument)")

        joined = SEPARATORS.get(separator, SEPARATORS["--- with blank lines"]).join(prompts)
        if not prompts and raw_prompts:
            joined = raw_prompts  # never lose what the model said

        if unload_after_run:
            _unload_clip()

        status_text = "\n".join(status)
        field_outputs = tuple("\n".join(c.get(k, "") for c in cards) for k in FIELD_KEYS)
        result = (
            joined,
            formatted,
            json.dumps(cards),
            "\n\n".join(descriptions),
            status_text,
        ) + field_outputs
        return {"ui": {"status": [status_text]}, "result": result}


NODE_CLASS_MAPPINGS = {
    "AVFX_CharacterSheetAllInOne": CharacterSheetAllInOneNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AVFX_CharacterSheetAllInOne": "AVFX Character Sheet Prompt Generator (All-in-One Vision)",
}
