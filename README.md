# ComfyUI-AVFX-Nodes

A versatile suite of custom ComfyUI nodes designed to streamline image, video, and creative production pipelines, combining modular workflow tools, external integrations, and practical utilities.

## Nodes

All nodes live under the **AVFX** menu in ComfyUI.

| Node | ID | Category |
| --- | --- | --- |
| AVFX Auto Clip Populator | `AVFX_AutoClipPopulator` | AVFX/Automation |
| AVFX Character Sheet Prompt Concat | `AVFX_CharacterSheetConcat` | AVFX/Prompt Builders |
| AVFX Character Sheet Prompt Collector (Vision) | `AVFX_CharacterSheetVision` | AVFX/Prompt Builders |
| AVFX Character Sheet Prompt Generator (All-in-One Vision) | `AVFX_CharacterSheetAllInOne` | AVFX/Prompt Builders |

### Auto Clip Populator

Splits a song or a plain run into overlapping clips, builds timeline plans and fills the timeline automatically. It adds Song, Movie, Groups and Hunt panels to the ComfyUI interface, plus project tools (save, rename, duplicate, delete) that always stay inside ComfyUI's `output/` folder.

It works together with the obvpm H3 timeline nodes, which provide the `/obvpm/h3/*` routes and the `obvpm_projects` folder it reads and writes.

### Character Sheet Prompt Builders

- **Concat**: build character sheet prompts by hand from editable, collapsible, reorderable character cards.
- **Collector (Vision)**: fill the character cards from vision-model outputs (up to 16 inputs; sockets grow as you connect them).
- **Generator (All-in-One Vision)**: pick a text encoder on the node, connect up to 16 images, and get finished prompts plus labeled outputs (formatted brief, cards JSON, image descriptions, status, and one output per card field).

The system prompts used by the vision and writer steps are in `nodes/character_sheet/*.txt` and can be edited.

## Install

```
cd ComfyUI/custom_nodes
git clone https://github.com/AVFX-Devs/ComfyUI-AVFX-Nodes
```

Restart ComfyUI. No extra Python packages are needed.

## Layout

```
__init__.py              registers every node and the web folder
nodes/clip_populator/    Auto Clip Populator (node + server routes)
nodes/character_sheet/   Character Sheet nodes and their system prompts
web/                     front-end extensions
```

## License

MIT, see [LICENSE](LICENSE).
