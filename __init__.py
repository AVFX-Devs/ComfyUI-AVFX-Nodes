"""ComfyUI-AVFX-Nodes: audio, video and audio-reactive visual effects nodes for ComfyUI."""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__version__ = "1.0.0"

WEB_DIRECTORY = "./web"

print(f"[ComfyUI-AVFX-Nodes] v{__version__} loaded {len(NODE_CLASS_MAPPINGS)} nodes")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY", "__version__"]
