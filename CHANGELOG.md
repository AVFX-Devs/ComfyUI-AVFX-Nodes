# Changelog

## 1.0.0
- First release of ComfyUI-AVFX-Nodes, combining two earlier local packs: obvpm Auto Clip Populator and Character Sheet Prompt Builder (v1.4.0).
- All node IDs now use the `AVFX_` prefix and live under the `AVFX/` menu. Workflows saved with the old node names need those nodes replaced.
  - `ObvpmAutoClipPopulator` -> `AVFX_AutoClipPopulator`
  - `CharacterSheetConcatNode` -> `AVFX_CharacterSheetConcat`
  - `CharacterSheetVisionNode` -> `AVFX_CharacterSheetVision`
  - `CharacterSheetAllInOneNode` -> `AVFX_CharacterSheetAllInOne`
- Auto Clip Populator server routes moved from `/obvpm_populator/*` to `/avfx/clip_populator/*`; the timeline event is now `avfx_populate_timeline_now`.
- Added pyproject.toml for the ComfyUI Registry and an MIT license.

## Earlier history (Character Sheet Prompt Builder)

### 1.4.0
- New node: Character Sheet Prompt Generator (All-in-One Vision).
- Sockets grow automatically (collector vision_1..16, all-in-one image_1..16).
- Collector supports up to 16 vision sockets.

### 1.3.1
- Added writer_system_prompt.txt.

### 1.3.0
- New node: Character Sheet Prompt Collector (Vision).
- Added vision_extraction_system_prompt.txt.

### 1.2.0
- Collapsible character cards; drag-to-reorder.

### 1.1.0
- Duplicate dropdown and button; node shrinks after deleting cards.

### 1.0.0
- Manual Character Sheet Prompt Builder node.
