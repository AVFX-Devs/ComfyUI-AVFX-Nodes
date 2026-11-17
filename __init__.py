"""ComfyUI-AVFX-Nodes: audio, video and audio-reactive visual effects nodes for ComfyUI."""

from .nodes.clip_populator import (
    NODE_CLASS_MAPPINGS as _CLIP_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _CLIP_NAMES,
)
from .nodes.character_sheet import (
    NODE_CLASS_MAPPINGS as _SHEET_CLASSES,
    NODE_DISPLAY_NAME_MAPPINGS as _SHEET_NAMES,
)

__version__ = "1.0.0"

NODE_CLASS_MAPPINGS = {**_CLIP_CLASSES, **_SHEET_CLASSES}
NODE_DISPLAY_NAME_MAPPINGS = {**_CLIP_NAMES, **_SHEET_NAMES}

WEB_DIRECTORY = "./web"

print(f"[ComfyUI-AVFX-Nodes] v{__version__} loaded {len(NODE_CLASS_MAPPINGS)} nodes")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]
