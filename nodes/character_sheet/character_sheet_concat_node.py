import json

class CharacterSheetConcatNode:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "meta_json": ("STRING", {
                    "default": json.dumps({
                        "brief_description": "A cast of six photorealistic characters for one deep-space military squad and the alien entity they encountered. All six must look like the same cohesive set.",
                        "art_style_and_medium": "gritty sci-fi realism, realistic scarred armor plating and weathered skin textures, heavy wear (scratched, scorched, oil-stained, corroded)",
                        "setting_and_era": "far-future deep-space frontier outpost",
                        "palette_and_mood": "gunmetal grey, burnt orange, olive drab, isolated and tense",
                        "framing_and_layout": "full-body character sheet, neutral front-facing turnaround pose",
                        "lighting_and_backdrop": "dramatic rim lighting against a dark neutral grey studio backdrop"
                    }),
                    "multiline": False
                }),
                "characters_json": ("STRING", {
                    "default": json.dumps([
                        {
                            "enabled": True,
                            "role_archetype": "Squad Commander",
                            "age_build": "woman in her 40s, athletic battle-hardened build",
                            "head_hair": "buzzcut with silver temples",
                            "face_body": "weathered skin, scarred left eyebrow, stoic expression",
                            "outfit_fabrics": "heavy gunmetal chest plate with burnt-orange shoulder pauldron, tattered olive-drab tactical cloak",
                            "accessories_props": "wrist-mounted tactical scanner, worn utility belt",
                            "footwear": "scuffed magnetic combat boots",
                            "pose_expression": "confident upright stance, eyes locked forward"
                        }
                    ]),
                    "multiline": False
                }),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("formatted_prompt",)
    FUNCTION = "build_prompt"
    CATEGORY = "AVFX/Prompt Builders"

    def build_prompt(self, meta_json="", characters_json=""):
        try:
            meta = json.loads(meta_json) if meta_json and meta_json.strip() else {}
        except Exception:
            meta = {}

        try:
            characters = json.loads(characters_json) if characters_json and characters_json.strip() else []
        except Exception:
            characters = []

        if not isinstance(characters, list):
            characters = []

        active_chars = [c for c in characters if isinstance(c, dict) and c.get("enabled", True)]
        num_sheets = len(active_chars)

        lines = [f"Number of sheets: {num_sheets}"]

        meta_fields = [
            ("Brief description", meta.get("brief_description", "")),
            ("Art style & medium", meta.get("art_style_and_medium", meta.get("style", ""))),
            ("Setting and era", meta.get("setting_and_era", "")),
            ("Palette and mood", meta.get("palette_and_mood", "")),
            ("Framing & layout", meta.get("framing_and_layout", "")),
            ("Lighting & backdrop", meta.get("lighting_and_backdrop", "")),
        ]

        for label, val in meta_fields:
            val_str = str(val).strip()
            if val_str:
                lines.append(f"{label}: {val_str}")

        lines.append("Characters, in order:")

        for idx, char in enumerate(active_chars, start=1):
            role = str(char.get("role_archetype", char.get("role", ""))).strip()
            details = []
            for key in [
                "age_build",
                "head_hair",
                "face_body",
                "outfit_fabrics",
                "accessories_props",
                "footwear",
                "pose_expression",
            ]:
                v = str(char.get(key, "")).strip()
                if v:
                    details.append(v)

            detail_str = ", ".join(details)
            if role and detail_str:
                entry = f"{idx}. {role}: {detail_str}"
            elif role:
                entry = f"{idx}. {role}"
            elif detail_str:
                entry = f"{idx}. {detail_str}"
            else:
                entry = f"{idx}."

            lines.append("")
            lines.append(entry)

        return ("\n".join(lines),)


NODE_CLASS_MAPPINGS = {
    "AVFX_CharacterSheetConcat": CharacterSheetConcatNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AVFX_CharacterSheetConcat": "AVFX Character Sheet Prompt Concat"
}
