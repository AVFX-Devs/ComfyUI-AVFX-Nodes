import copy
import glob
import json
import os
import random
import re
import time
from aiohttp import web
import folder_paths
from server import PromptServer



# Every clip after the first re-uses `overlap` frames of the previous clip as
# context, so each new clip only adds (clip_frames - overlap) new frames.
EXIT_SHIFT = -5          # same "d" / exit offset the working version used
MIN_NEW_TAIL_SEC = 1.0   # last clip must add at least this much new footage

# The timeline lays clips end to end by their full length (the overlap is handled inside the
# "extend" join), so the next clip starts where the previous one ends.  Set True only if
# your exported video turns out LONGER than the song (then overlap is shared, stride = clip - overlap).
STRIDE_SUBTRACTS_OVERLAP = False

# Plain (no-song) clips keep the exact length of the first working version (15s -> 360f).
# Song clips use the grid below (15s -> 362f), which generated fine. Set True to snap both.
SNAP_PLAIN_CLIPS = False

# "snap to latent grid": the timeline turns 15s into 362 frames (15.08s) and a short
# clip like 78 frames also fits, so valid lengths are 4*k + 2.  Change these two if
# your model uses a different grid.
GRID_STEP = 4
GRID_OFFSET = 2


# --------------------------------------------------------------------------
# small helpers (unchanged from the working version)
# --------------------------------------------------------------------------
def _make_plan_id(idx):
    chars = "abcdefghijklmnopqrstuvwxyz0123456789"
    suffix = "".join(random.choice(chars) for _ in range(4))
    return f"p{idx}_{suffix}"


def _extract_short_prompt(full_text, fallback_title):
    m = re.search(r"detailed_description:\s*(.+)", full_text, re.DOTALL)
    if m:
        lines = [ln.strip() for ln in m.group(1).splitlines() if ln.strip() and not ln.strip().startswith("Shot ")]
        if lines:
            return lines[0][:80]
    for ln in full_text.splitlines():
        s = ln.strip()
        if s and not s.endswith(":"):
            return s[:80]
    return fallback_title


def _split_prompts(raw):
    return [b.strip() for b in re.split(r"(?m)^\s*---\s*$", raw or "") if b.strip()]


def _as_dict(val):
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.strip().startswith("{"):
        try:
            parsed = json.loads(val)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    return {}


def _find_timeline_file(base_folder, timeline_name=""):
    """Find the timeline json inside output/<base_folder>.
    If several exist, prefer the one whose project.timeline matches, then the newest."""
    out_root = folder_paths.get_output_directory()
    proj_dir = os.path.join(out_root, base_folder)
    os.makedirs(proj_dir, exist_ok=True)
    best = None
    for path in glob.glob(os.path.join(proj_dir, "*.json")):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not (isinstance(data, dict) and ("obvpm_timeline_file" in data or "document" in data)):
                continue
            score = os.path.getmtime(path)
            doc = data.get("document")
            if timeline_name and isinstance(doc, dict) and _as_dict(doc.get("project")).get("timeline") == timeline_name:
                score += 1e12
            if best is None or score > best[0]:
                best = (score, path, data)
        except Exception:
            continue
    if best is None:
        return None, None
    return best[1], best[2]


def _detect_prompt_and_seed_targets(doc, existing_plans):
    prompt_target = None
    seed_target = None

    for p in existing_plans:
        if isinstance(p, dict):
            if not prompt_target and isinstance(p.get("prompt_at"), dict):
                prompt_target = copy.deepcopy(p["prompt_at"])
            if not seed_target and isinstance(p.get("seed_at"), dict):
                seed_target = copy.deepcopy(p["seed_at"])

    next_draft = doc.get("next_draft", {})
    vals = next_draft.get("values", {}) if isinstance(next_draft, dict) else {}

    if not prompt_target:
        if "761:763" in vals:
            prompt_target = {"input": "value", "node": "761:763"}
        else:
            prompt_target = {"input": "value", "node": "761"}

    if not seed_target:
        seed_target = {"input": "seed", "node": "765"}

    return prompt_target, seed_target


def _inject_prompt_into_values(vals_dict, prompt_text, prompt_target):
    if not isinstance(vals_dict, dict):
        return
    target_node = str(prompt_target.get("node", "761"))
    target_input = str(prompt_target.get("input", "value"))

    for key in {target_node, "761", "761:763"}:
        if key in vals_dict and isinstance(vals_dict[key], dict):
            vals_dict[key][target_input] = prompt_text
            if "value" in vals_dict[key]:
                vals_dict[key]["value"] = prompt_text
            if "prompt" in vals_dict[key]:
                vals_dict[key]["prompt"] = prompt_text
        elif key == target_node:
            vals_dict[key] = {target_input: prompt_text}


def _inject_seed_into_values(vals_dict, clip_seed, seed_target):
    if not isinstance(vals_dict, dict):
        return
    target_node = str(seed_target.get("node", "765"))
    target_input = str(seed_target.get("input", "seed"))
    if target_node in vals_dict and isinstance(vals_dict[target_node], dict):
        vals_dict[target_node][target_input] = clip_seed
    else:
        vals_dict[target_node] = {target_input: clip_seed}


# --------------------------------------------------------------------------
# song mode
# --------------------------------------------------------------------------
_AUDIO_FILE_RE = re.compile(r"\.(mp3|wav|flac|m4a|aac|ogg|opus)\b", re.I)
_SKIP_KEYS = {"plans", "next_draft", "nodes", "values", "modes"}
_LEN_KEYS = ("use", "use_seconds", "exact", "exact_seconds", "dur", "duration", "length", "seconds", "sec")


def _song_seconds_from_doc(doc):
    """Length of the song on the A1 / audio track of a timeline document (0 if none).
    Searches generically because the exact audio-clip layout is owned by the timeline node."""
    fps = 24
    if isinstance(doc, dict):
        try:
            fps = int(doc.get("fps", 24)) or 24
        except (TypeError, ValueError):
            pass
    best = [0.0]

    def num(o, keys):
        for k in keys:
            try:
                v = float(o.get(k))
            except (TypeError, ValueError):
                continue
            if v > 0:
                return v
        return 0.0

    def visit(o, in_audio):
        if isinstance(o, list):
            for x in o:
                visit(x, in_audio)
            return
        if not isinstance(o, dict):
            return
        is_audio = in_audio or o.get("kind") == "audio" or re.match(r"^A\d", str(o.get("id", ""))) is not None
        has_file = any(isinstance(v, str) and _AUDIO_FILE_RE.search(v) for v in o.values())
        if is_audio or has_file:
            d = num(o, _LEN_KEYS)
            if not d:
                d = num(o, ("frames",)) / fps
            if d:
                try:
                    at = float(o.get("at", o.get("start", 0)) or 0)
                except (TypeError, ValueError):
                    at = 0.0
                best[0] = max(best[0], at + d)
        for k, v in o.items():
            if k not in _SKIP_KEYS:
                visit(v, is_audio)

    visit(doc, False)
    return best[0]


def _snap_grid(frames):
    """Round up to the latent grid (4k+2): 360 -> 362, 77 -> 78."""
    k = max(1, -(-(int(frames) - GRID_OFFSET) // GRID_STEP))
    return GRID_OFFSET + k * GRID_STEP


def partition_song(total_frames, clip_frames, overlap, fps=24):
    """Split a song of `total_frames` into clip lengths (in frames, on the latent grid).

    Clips are `clip_frames` long and laid end to end like the timeline draws them
    (see STRIDE_SUBTRACTS_OVERLAP). The last clip is trimmed to what is
    left of the song (rounded up to the grid, so it never ends short).
    Returns (lengths, effective_overlap).
    """
    clip_frames = _snap_grid(clip_frames)
    overlap = max(0, min(int(overlap), clip_frames // 2))
    stride = clip_frames - overlap if STRIDE_SUBTRACTS_OVERLAP else clip_frames
    min_tail = overlap + int(MIN_NEW_TAIL_SEC * fps)   # last clip adds >= 1s of new footage
    lengths = []
    start = 0
    while True:
        remaining = total_frames - start
        if remaining <= clip_frames:
            if lengths:
                remaining = max(remaining, min_tail)   # extend clip needs its overlap window + 1s
            lengths.append(min(_snap_grid(remaining), clip_frames))
            break
        lengths.append(clip_frames)
        start += stride
    return lengths, overlap


def _sanitize_song_prompt(text, clip_idx, total_clips):
    """Music-video prompt: audio comes only from the pinned A1 master track."""
    audio_line = "Pinned A1 master audio track only (no generated voice or sound effects)."
    if not text or not text.strip():
        return (
            "subject_definitions:\n"
            "<Subject 1> is the main performer depicted in <Picture 1>.\n\n"
            "summary:\n"
            f"[reference generation] Music video segment {clip_idx} of {total_clips}. "
            "<Subject 1> performs and lip-syncs naturally in sync with the pinned A1 master audio track.\n\n"
            "detailed_description:\n"
            "In a cinematic music video style, <Subject 1> performs expressively and lip-syncs accurately to the vocals "
            "or moves naturally with the rhythm of the pinned A1 master audio track. Smooth camera motion, consistent lighting, "
            "and cohesive visual continuity.\n\n"
            "overall_soundscape:\n" + audio_line + "\n\n"
            "non_diegetic_music:\nPinned A1 master audio track."
        )

    cleaned = re.sub(r"<d>.*?</d>", "", text.strip(), flags=re.DOTALL).strip()
    if "subject_definitions:" not in cleaned and "detailed_description:" not in cleaned:
        return (
            "subject_definitions:\n"
            "<Subject 1> is the main performer depicted in <Picture 1>.\n\n"
            "summary:\n"
            f"[reference generation] Music video segment {clip_idx} of {total_clips}. "
            "<Subject 1> performs and lip-syncs in time with the pinned A1 master audio track.\n\n"
            "detailed_description:\n"
            "In a cinematic music video style, <Subject 1> performs expressively and lip-syncs naturally to the music "
            f"while matching the mood and lyrics: {cleaned}. Smooth camera motion and consistent lighting.\n\n"
            "overall_soundscape:\n" + audio_line + "\n\n"
            "non_diegetic_music:\nPinned A1 master audio track."
        )

    if "overall_soundscape:" in cleaned:
        cleaned = re.sub(
            r"overall_soundscape:.*?(?=\n\s*non_diegetic_music:|\Z)",
            "overall_soundscape:\n" + audio_line,
            cleaned,
            flags=re.DOTALL,
        )
    return cleaned.strip()


# --------------------------------------------------------------------------
# main route
# --------------------------------------------------------------------------
@PromptServer.instance.routes.post("/avfx/clip_populator/build_timeline_plans")
async def build_timeline_plans_route(request):
    try:
        payload = await request.json()
        packed_prompts = payload.get("packed_prompts", "")
        existing_seq_raw = payload.get("existing_sequence", "{}")
        base_folder = str(payload.get("base_folder", "Facial_city")).strip() or "Facial_city"
        timeline_name = str(payload.get("timeline_name", "")).strip()
        duration = float(payload.get("duration", 15.0))
        base_seed = int(payload.get("base_seed", 1000))
        overlap_window = str(payload.get("overlap_window", "39"))
        overlap_shift = int(payload.get("overlap_shift", EXIT_SHIFT))
        replace_existing_plans = bool(payload.get("replace_existing_plans", True))
        song_seconds = float(payload.get("song_seconds", 0) or 0)   # measured by the UI (0 = none)
        require_song = bool(payload.get("require_song", False))     # Song panel button
        force_plain = bool(payload.get("force_plain", False))       # Movie panel: one clip per prompt, never song mode

        try:
            overlap = max(0, int(float(overlap_window)))
        except ValueError:
            overlap = 39

        blocks = _split_prompts(packed_prompts)

        live_seq = _as_dict(existing_seq_raw)
        proj_dir = os.path.join(folder_paths.get_output_directory(), base_folder)
        # New project layout (project.json + timelines/): the timeline saves itself, and the
        # json files in the project root are not the timeline, so never read or write them.
        new_layout = os.path.isdir(os.path.join(proj_dir, "timelines"))
        if new_layout:
            disk_path, disk_wrapper = None, None
        else:
            disk_path, disk_wrapper = _find_timeline_file(base_folder, timeline_name)
        disk_doc = disk_wrapper.get("document") if disk_wrapper and isinstance(disk_wrapper.get("document"), dict) else None

        # Song length: UI value first, otherwise audio found on the A1 track.
        # Only trust the saved file when the live timeline gave us nothing: a song you already
        # deleted from A1 can still be sitting in the old saved copy.
        if force_plain:
            song_seconds = 0.0
        elif song_seconds <= 0.5:
            if live_seq.get("tracks"):
                song_seconds = _song_seconds_from_doc(live_seq)
            else:
                song_seconds = _song_seconds_from_doc(disk_doc or {})
        song_mode = song_seconds > 0.5
        if require_song and not song_mode:
            return web.json_response(
                {"status": "error", "message": "No song length found. Drop the song on A1, or type the song length in seconds."},
                status=400,
            )
        if not song_mode and not blocks:
            return web.json_response({"status": "error", "message": "No prompts found (separate clips with ---)."}, status=400)

        # Base document: the live timeline you are looking at; the saved file is only a fallback.
        live_ok = bool(live_seq.get("tracks") or live_seq.get("next_draft"))
        if live_ok:
            seq = copy.deepcopy(live_seq)
        elif disk_doc is not None:
            seq = copy.deepcopy(disk_doc)
        else:
            seq = copy.deepcopy(live_seq)

        seq.setdefault("obvpm_timeline", 1)
        seq.setdefault("project", {"folder": base_folder})
        if isinstance(seq.get("project"), dict):
            seq["project"]["folder"] = base_folder

        fps = int(seq.get("fps", 24))
        frames_per_clip = max(1, int(round(duration * fps)))
        if song_mode or SNAP_PLAIN_CLIPS:
            frames_per_clip = _snap_grid(frames_per_clip)

        # How long is each clip?
        if song_mode:
            total_frames = int(round(song_seconds * fps))
            frame_lengths, overlap = partition_song(total_frames, frames_per_clip, overlap, fps)
            overlap_window = str(overlap)
            specs = []
            for i, flen in enumerate(frame_lengths):
                raw = blocks[i] if i < len(blocks) else ""
                specs.append((flen, _sanitize_song_prompt(raw, i + 1, len(frame_lengths))))
        else:
            specs = [(frames_per_clip, b) for b in blocks]

        next_draft = seq.setdefault("next_draft", {})
        template_values = copy.deepcopy(next_draft.get("values", {}))
        template_modes = copy.deepcopy(next_draft.get("modes", {}))

        existing_plans = seq.setdefault("plans", [])
        prompt_target, seed_target = _detect_prompt_and_seed_targets(seq, existing_plans)

        tracks = seq.setdefault("tracks", [{"id": "V1", "kind": "video", "clips": []}])
        v1_track = next((t for t in tracks if t.get("id") == "V1"), tracks[0])
        v1_clips = v1_track.setdefault("clips", [])

        if replace_existing_plans:
            v1_clips[:] = [c for c in v1_clips if "plan" not in c]
            seq["plans"] = []
            existing_plans = seq["plans"]
            # Deleted clips leave empty space ({"gap": frames}) behind. Close it, so the new
            # clips start where the footage ends, or at 0s when V1 has no real footage:
            #  - no real clip on V1: every gap goes, the stack starts at the left edge;
            #  - real clips: only the gaps after the last one go (gaps you left between or
            #    before your own clips stay as you made them).
            last_real_i = max((i for i, c in enumerate(v1_clips) if c.get("path")), default=-1)
            v1_clips[:] = [c for i, c in enumerate(v1_clips) if not ("gap" in c and i > last_real_i)]

        start_n = len(existing_plans) + 1
        now_ts = int(time.time() * 1000)
        last_real_clip = next((c for c in reversed(v1_clips) if c.get("path")), None)

        prev_frames = frames_per_clip
        for idx, (clip_frames, full_prompt) in enumerate(specs):
            plan_num = start_n + idx
            plan_id = _make_plan_id(plan_num)
            clip_seed = base_seed + idx

            clip_values = copy.deepcopy(template_values)
            _inject_prompt_into_values(clip_values, full_prompt, prompt_target)
            _inject_seed_into_values(clip_values, clip_seed, seed_target)

            around_obj = {}
            is_extension = False
            if idx == 0 and last_real_clip:
                is_extension = True
                around_obj = {
                    "prev": {
                        "d": overlap_shift,
                        "now": {"exit": last_real_clip.get("exit", frames_per_clip - 5), "path": last_real_clip["path"]},
                        "was": {"path": last_real_clip["path"]}
                    }
                }
            elif idx > 0 and overlap > 0:
                is_extension = True
                prev_plan_id = existing_plans[-1]["id"]
                around_obj = {
                    "prev": {
                        "d": overlap_shift,
                        "now": {"exit": prev_frames + overlap_shift, "plan": prev_plan_id},
                        "was": {"plan": prev_plan_id}
                    }
                }

            plan_entry = {
                "around": around_obj,
                "cont": {"next": idx < len(specs) - 1, "prev": is_extension},
                "dir": base_folder,
                "dur": round(clip_frames / float(fps), 4) if (song_mode or SNAP_PLAIN_CLIPS) else duration,
                "frames": clip_frames,
                "id": plan_id,
                "made_at": now_ts + idx,
                "modes": copy.deepcopy(template_modes),
                "n": plan_num,
                "prompt": _extract_short_prompt(full_prompt, f"Clip {plan_num}"),
                "prompt_at": copy.deepcopy(prompt_target),
                "prompt_full": full_prompt,
                "refs": [],
                "seed": clip_seed,
                "seed_at": copy.deepcopy(seed_target),
                "values": clip_values,
                "window": overlap_window
            }
            if is_extension:
                plan_entry["join"] = "extend"

            existing_plans.append(plan_entry)
            clip_obj = {"frames": clip_frames, "plan": plan_id}
            if is_extension:
                clip_obj["join"] = "extend"
            v1_clips.append(clip_obj)
            prev_frames = clip_frames

        if existing_plans:
            first_plan = existing_plans[0]
            _inject_prompt_into_values(next_draft.setdefault("values", {}), specs[0][1], prompt_target)
            seq["next"] = {
                "leave_early": False,
                "mode": "masked",
                "role": "extend" if (last_real_clip or len(existing_plans) > 1) else "generate",
                "source": f"plan:{first_plan['id']}",
                "window": overlap_window
            }

        seq_str = json.dumps(seq, separators=(",", ":"), ensure_ascii=False)

        if new_layout:
            disk_path = ""
        else:
            if not disk_path:
                disk_path = os.path.join(folder_paths.get_output_directory(), base_folder, f"{base_folder}.json")
                disk_wrapper = {
                    "obvpm_timeline_file": 1,
                    "rev": 1,
                    "document": seq
                }
            else:
                disk_wrapper["rev"] = int(disk_wrapper.get("rev", 1)) + 10
                disk_wrapper["document"] = seq

            os.makedirs(os.path.dirname(disk_path), exist_ok=True)
            with open(disk_path, "w", encoding="utf-8") as f:
                json.dump(disk_wrapper, f, indent=2, ensure_ascii=False)

        print(f"[AVFX clip populator] base={'live timeline' if live_ok else 'saved file'} | song={song_mode} | "
              f"{len(specs)} clips x {frames_per_clip}f (last {specs[-1][0]}f) | overlap={overlap} | "
              f"saved file: {disk_path or 'none (new layout)'}")

        return web.json_response({
            "status": "ok",
            "count": len(specs),
            "first_prompt": specs[0][1],
            "prompt_target": prompt_target["node"],
            "disk_path": disk_path,
            "sequence": seq_str,
            "song_mode": song_mode,
            "song_seconds": round(song_seconds, 2) if song_mode else 0,
            "overlap_frames": overlap,
            "last_clip_frames": specs[-1][0],
            "prompts_used": min(len(blocks), len(specs)),
            "prompts_total": len(blocks),
        })
    except Exception as e:
        return web.json_response({"status": "error", "message": str(e)}, status=500)


class AVFXAutoClipPopulator:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "packed_prompts": ("STRING", {"forceInput": True}),
                "clip_duration": ("FLOAT", {"default": 15.0, "min": 1.0, "max": 60.0, "step": 0.1}),
                "base_seed": ("INT", {"default": 1000, "min": 0, "max": 0xFFFFFFFF}),
                "overlap_frames": ("INT", {"default": 39, "min": 1, "max": 120}),
                "replace_existing_plans": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("STRING", "INT")
    RETURN_NAMES = ("packed_prompts", "clip_count")
    FUNCTION = "populate"
    CATEGORY = "AVFX/Automation"

    def populate(self, packed_prompts, clip_duration, base_seed, overlap_frames, replace_existing_plans):
        blocks = _split_prompts(packed_prompts)
        PromptServer.instance.send_sync("avfx_populate_timeline_now", {
            "packed_prompts": packed_prompts,
            "duration": clip_duration,
            "base_seed": base_seed,
            "overlap_window": str(overlap_frames),
            "replace_existing_plans": replace_existing_plans
        })
        return (packed_prompts, len(blocks))



# --------------------------------------------------------------------------
# project / timeline folder tools (erase for good, always inside output/)
# --------------------------------------------------------------------------
import shutil
import sys
import tempfile

_TL_RE = re.compile(r"^[^\W_][\w \-.]{0,79}$")


def _out_root():
    return os.path.realpath(folder_paths.get_output_directory())


def _project_dir(folder):
    """(text, absolute path) of an existing project folder inside output/, else ValueError."""
    text = str(folder or "").strip().replace("\\", "/").strip("/")
    if not text or re.match(r"^[A-Za-z]:", text) or ".." in text.split("/"):
        raise ValueError("a project folder must be written relative to the output folder")
    root = _out_root()
    path = os.path.join(root, *text.split("/"))
    if os.path.islink(path):
        raise ValueError(f"{text} is a link to another place; remove the link by hand")
    real = os.path.realpath(path)
    if real == root or os.path.commonpath([root, real]) != root:
        raise ValueError(f"{text} is outside the output folder")
    if not os.path.isfile(os.path.join(real, "project.json")):
        raise ValueError(f"{text} is not a project (no project.json)")
    return text, real


def _read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(path, data):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _size_of(path):
    """(files, bytes) of a file or folder."""
    if os.path.isfile(path):
        try:
            return 1, os.path.getsize(path)
        except OSError:
            return 0, 0
    files = size = 0
    for dp, _dn, fn in os.walk(path):
        for n in fn:
            try:
                size += os.path.getsize(os.path.join(dp, n))
                files += 1
            except OSError:
                pass
    return files, size


def _timeline_parts(path, name):
    tl = os.path.join(path, "timelines")
    return [os.path.join(tl, name + ".json"), os.path.join(tl, "versions", name),
            os.path.join(tl, "backups", name)]


def _erase(p):
    if os.path.isdir(p) and not os.path.islink(p):
        shutil.rmtree(p)
    elif os.path.lexists(p):
        os.unlink(p)


def _recycle(path):
    """Send a file or folder to the operating system's recycle bin / trash. Raises if it cannot
    (it never falls back to erasing)."""
    path = os.path.abspath(path)
    try:
        from send2trash import send2trash  # used when ComfyUI's Python has it
        send2trash(path)
        return
    except ImportError:
        pass
    if sys.platform.startswith("win"):
        import ctypes
        from ctypes import wintypes

        class SHFILEOPSTRUCTW(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT),
                        ("pFrom", wintypes.LPCWSTR), ("pTo", wintypes.LPCWSTR),
                        ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL),
                        ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]
        op = SHFILEOPSTRUCTW()
        op.wFunc = 3                       # FO_DELETE
        op.pFrom = path + "\0"             # (the list ends with a second null)
        op.fFlags = 0x40 | 0x10 | 0x4 | 0x400  # allow undo (recycle bin), no prompts, silent, no error UI
        rc = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        if rc != 0 or op.fAnyOperationsAborted:
            raise OSError(f"the recycle bin refused {os.path.basename(path)} (code {rc})")
        return
    if sys.platform == "darwin":
        import subprocess
        script = 'tell application "Finder" to delete POSIX file "%s"' % path.replace("\\", "\\\\").replace('"', '\\"')
        r = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        if r.returncode != 0:
            raise OSError("the Trash refused it: " + (r.stderr.strip() or "osascript failed"))
        return
    # Linux / other: the freedesktop trash
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    tdir = os.path.join(base, "Trash")
    files, infos = os.path.join(tdir, "files"), os.path.join(tdir, "info")
    os.makedirs(files, exist_ok=True)
    os.makedirs(infos, exist_ok=True)
    from urllib.parse import quote
    name = os.path.basename(path.rstrip(os.sep)) or "item"
    target, n = os.path.join(files, name), 1
    while os.path.lexists(target) or os.path.lexists(os.path.join(infos, os.path.basename(target) + ".trashinfo")):
        n += 1
        target = os.path.join(files, f"{name}.{n}")
    with open(os.path.join(infos, os.path.basename(target) + ".trashinfo"), "w", encoding="utf-8") as f:
        f.write("[Trash Info]\nPath=%s\nDeletionDate=%s\n" % (quote(path), time.strftime("%Y-%m-%dT%H:%M:%S")))
    shutil.move(path, target)


def _remove(p, mode):
    if not os.path.lexists(p):
        return
    if mode == "recycle":
        _recycle(p)
    else:
        _erase(p)


def _forget_in_project_list(text):
    """Best effort: drop the folder from the timeline pack's remembered project list."""
    try:
        for name, mod in list(sys.modules.items()):
            if name.endswith("project_store") and hasattr(mod, "_save_cache") and hasattr(mod, "list_projects"):
                got = mod.list_projects().get("projects", [])
                mod._save_cache([e for e in got if e.get("folder") != text])
                return
    except Exception:
        pass


def project_info(folder):
    text, path = _project_dir(folder)
    project = _read_json(os.path.join(path, "project.json"))
    names = [n for n in (project.get("timelines") or []) if isinstance(n, str)]
    tls = []
    for n in names:
        files = size = 0
        for part in _timeline_parts(path, n):
            f, b = _size_of(part)
            files += f
            size += b
        tls.append({"name": n, "files": files, "bytes": size})
    pf, pb = _size_of(path)
    return {"folder": text, "name": project.get("name") or text.rsplit("/", 1)[-1],
            "timelines": tls, "files": pf, "bytes": pb}


def project_delete(folder, kind, timeline=None, keep=None, mode="permanent"):
    mode = "recycle" if mode == "recycle" else "permanent"
    text, path = _project_dir(folder)
    if kind == "project":
        _remove(path, mode)
        _forget_in_project_list(text)
        return {"deleted": "project", "folder": text, "mode": mode}
    pfile = os.path.join(path, "project.json")
    project = _read_json(pfile)
    names = [n for n in (project.get("timelines") or []) if isinstance(n, str)]
    if kind == "timeline":
        name = str(timeline or "")
        if name not in names or not _TL_RE.match(name):
            raise ValueError(f"{text} has no timeline {name!r}")
        if len(names) < 2:
            raise ValueError("a project keeps at least one timeline")
        if keep and name == keep:
            raise ValueError("that timeline is open in this workflow: switch to another first")
        gone = [name]
    elif kind == "others":
        keep = str(keep or "")
        if keep not in names:
            raise ValueError("the open timeline is not one of this project's: open the project first")
        gone = [n for n in names if n != keep]
        if not gone:
            raise ValueError("there are no other timelines")
    else:
        raise ValueError("unknown kind")
    for n in gone:
        if not _TL_RE.match(n):
            continue
        for part in _timeline_parts(path, n):
            _remove(part, mode)
    if kind == "others":
        _remove(os.path.join(path, "timelines", "deleted"), mode)
    project["timelines"] = [n for n in names if n not in gone]
    if project.get("last") in gone:
        project["last"] = project["timelines"][0]
    project["renamed"] = {k: v for k, v in (project.get("renamed") or {}).items()
                          if v not in gone and k not in gone}
    _write_json(pfile, project)
    return {"deleted": gone, "timelines": project["timelines"]}


def _json_route(path, call):
    async def handler(request):
        try:
            import asyncio
            data = await request.json()
            if not isinstance(data, dict):
                data = {}
            return web.json_response(await asyncio.to_thread(call, data))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
    PromptServer.instance.routes.post(path)(handler)


# ---------------------------------------------------------------------------------------------
# "Save this timeline as a new project": copy the takes (and their small companion files) into the
# new project's folder, with the timeline's paths rewritten, then remove the originals (checked).
# ---------------------------------------------------------------------------------------------
_MEDIA_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v", ".gif",
               ".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac", ".opus"}


def _walk_strings(obj, fn):
    if isinstance(obj, str):
        return fn(obj)
    if isinstance(obj, list):
        return [_walk_strings(x, fn) for x in obj]
    if isinstance(obj, dict):
        return {k: _walk_strings(v, fn) for k, v in obj.items()}
    return obj


def _rel_clean(text):
    t = str(text or "").strip().replace("\\", "/").strip("/")
    while "//" in t:
        t = t.replace("//", "/")
    return t


def _new_folder_text(folder):
    t = _rel_clean(folder)
    if not t:
        raise ValueError("Type a folder name for the new project.")
    if os.path.isabs(t) or re.match(r"^[A-Za-z]:", t) or ".." in t.split("/"):
        raise ValueError("The project folder must be inside the output folder, written relative to it (like projects/my_film).")
    if any(c in t for c in '<>:"|?*'):
        raise ValueError("The folder name has characters a folder cannot have.")
    root = _out_root()
    path = os.path.abspath(os.path.join(root, t))
    if path == root or os.path.commonpath([root, path]) != root:
        raise ValueError("That folder is outside the output folder.")
    return t, path


def _inside_project(root, rel_dir):
    """The project folder holding `rel_dir` (or one above it), if any."""
    cur = rel_dir
    while True:
        if os.path.isfile(os.path.join(root, cur, "project.json")):
            return cur or "."
        if not cur:
            return None
        cur = cur.rsplit("/", 1)[0] if "/" in cur else ""


def saveproj_plan(document, folder):
    root = _out_root()
    text, new_path = _new_folder_text(folder)
    doc = json.loads(document) if isinstance(document, str) else dict(document or {})
    doc.pop("project", None)   # a leftover pointer (the timeline's own "save as project" is offered only outside a project)
    if os.path.isfile(os.path.join(new_path, "project.json")):
        raise ValueError(f"{text} is a project already. Pick another folder name.")
    # every string of the timeline that names an existing media file in the output folder
    found, missing = {}, []

    def see(s):
        rel = _rel_clean(s)
        if rel and os.path.splitext(rel)[1].lower() in _MEDIA_EXTS and not os.path.isabs(rel) and ".." not in rel.split("/"):
            full = os.path.join(root, rel)
            if os.path.isfile(full):
                found[rel] = os.path.getsize(full)
            elif rel not in missing:
                missing.append(rel)
        return s
    _walk_strings(doc, see)
    # (no clip files yet, only planned clips: the project is made all the same, starting with this timeline)
    # refuse when the takes already belong to a project
    for rel in found:
        d = rel.rsplit("/", 1)[0] if "/" in rel else ""
        owner = _inside_project(root, d)
        if owner:
            raise ValueError(f"The takes in {owner} already belong to a project. Open that project instead.")
    # each take with its companion files (same name before the extension: the .mctx sidecar and the like)
    files, taken, mapping = [], set(), {}
    for rel in sorted(found):
        d, _, base = rel.rpartition("/")
        stem = os.path.splitext(base)[0]
        cand = ("_candidates/" if ("/" + d + "/").find("/_candidates/") >= 0 else "")
        suffix, n = "", 1
        while any((cand + stem + suffix + base[len(stem):]) == t for t in taken):
            n += 1
            suffix = f"_{n}"
        dst_base = stem + suffix + base[len(stem):]
        dst = text + "/" + cand + dst_base
        taken.add(cand + dst_base)
        mapping[rel] = dst
        group = [base]
        try:
            for name in sorted(os.listdir(os.path.join(root, d))):
                if name != base and name.startswith(stem + ".") and os.path.isfile(os.path.join(root, d, name)):
                    group.append(name)
        except OSError:
            pass
        for name in group:
            srel = (d + "/" if d else "") + name
            drel = text + "/" + cand + stem + suffix + name[len(stem):]
            if any(f["src"] == srel for f in files):
                continue
            files.append({"src": srel, "dst": drel, "size": os.path.getsize(os.path.join(root, srel))})
            if os.path.exists(os.path.join(root, drel)):
                raise ValueError(f"{drel} exists already in the new folder. Pick another folder name.")
    # the timeline's text with the new paths
    def rewrite(s):
        rel = _rel_clean(s)
        return mapping.get(rel, s)
    new_doc = _walk_strings(doc, rewrite)
    old_dirs = {(f["src"].rpartition("/")[0]) for f in files}
    plain = {d for d in old_dirs if "_candidates" not in d.split("/")}
    for pl in new_doc.get("plans") or []:
        if isinstance(pl, dict) and _rel_clean(pl.get("dir")) in plain:
            pl["dir"] = text
    return {"folder": text, "files": files, "total": sum(f["size"] for f in files), "document": json.dumps(new_doc),
            "missing": missing, "from": sorted(old_dirs)}


def saveproj_copy(src, dst, size=None):
    root = _out_root()
    s, d = _rel_clean(src), _rel_clean(dst)
    sp, dp = os.path.abspath(os.path.join(root, s)), os.path.abspath(os.path.join(root, d))
    for pth in (sp, dp):
        if pth == root or os.path.commonpath([root, pth]) != root:
            raise ValueError("outside the output folder")
    if not os.path.isfile(sp):
        raise ValueError(f"{s} is not there any more")
    if os.path.exists(dp):
        raise ValueError(f"{d} exists already")
    os.makedirs(os.path.dirname(dp), exist_ok=True)
    tmp = dp + ".part"
    import shutil
    shutil.copy2(sp, tmp)
    want = os.path.getsize(sp)
    if os.path.getsize(tmp) != want or (size is not None and int(size) != want):
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise ValueError(f"copy of {s} did not come out the same size")
    os.replace(tmp, dp)
    return {"ok": True, "size": want}


def saveproj_cleanup(pairs, mode="permanent"):
    """Remove originals whose copy is verified (there, same size). Never touches anything else."""
    root = _out_root()
    removed, kept, freed = 0, [], 0
    dirs = set()
    for pr in pairs or []:
        s, d = _rel_clean(pr.get("src")), _rel_clean(pr.get("dst"))
        sp, dp = os.path.abspath(os.path.join(root, s)), os.path.abspath(os.path.join(root, d))
        ok = (sp != dp and os.path.isfile(sp) and os.path.isfile(dp) and os.path.getsize(sp) == os.path.getsize(dp)
              and os.path.commonpath([root, sp]) == root and os.path.commonpath([root, dp]) == root and sp != root)
        if not ok:
            kept.append(s)
            continue
        freed += os.path.getsize(sp)
        _remove(sp, "recycle" if mode == "recycle" else "permanent")
        removed += 1
        dirs.add(os.path.dirname(sp))
    for dpath in sorted(dirs, key=len, reverse=True):      # folders left empty
        try:
            if dpath != root and not os.listdir(dpath):
                os.rmdir(dpath)
        except OSError:
            pass
    return {"removed": removed, "kept": kept, "freed": freed}



# ---------------------------------------------------------------------------------------------
# Project window extras: rename (the folder too) and duplicate (the whole project folder)
# ---------------------------------------------------------------------------------------------
_PROJ_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]*$")


def _refresh_project_list():
    """Best effort: let the timeline pack read its project list afresh."""
    try:
        for name, mod in list(sys.modules.items()):
            if name.endswith("project_store") and hasattr(mod, "list_projects"):
                mod.list_projects(rescan=True)
                return
    except Exception:
        pass


def _sibling(text, name):
    nm = str(name or "").strip()
    if not _PROJ_NAME_RE.match(nm) or nm.endswith("."):
        raise ValueError("A project's name can use letters, numbers, spaces, - _ and . only.")
    parent = text.rsplit("/", 1)[0] if "/" in text else ""
    new_text = (parent + "/" if parent else "") + nm
    new_path = os.path.join(_out_root(), *new_text.split("/"))
    return nm, new_text, new_path


def project_rename(folder, name):
    text, path = _project_dir(folder)
    nm, new_text, new_path = _sibling(text, name)
    if new_text == text:
        raise ValueError("That is the name it has already.")
    if os.path.exists(new_path):
        raise ValueError(f"{new_text} exists already. Pick another name.")
    os.rename(path, new_path)
    pj = os.path.join(new_path, "project.json")
    data = _read_json(pj)
    data["name"] = nm
    _write_json(pj, data)
    _forget_in_project_list(text)
    _refresh_project_list()
    return {"folder": new_text, "name": nm}


def project_dup_plan(folder, name):
    text, path = _project_dir(folder)
    nm, new_text, new_path = _sibling(text, name)
    if os.path.exists(new_path):
        raise ValueError(f"{new_text} exists already. Pick another name.")
    files, skipped = [], 0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
        for fn in sorted(filenames):
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, path).replace(os.sep, "/")
            if rel == "project.json" or fn.endswith(".part"):
                continue
            if os.path.islink(full):
                skipped += 1
                continue
            files.append({"src": text + "/" + rel, "dst": new_text + "/" + rel, "size": os.path.getsize(full)})
    return {"folder": new_text, "name": nm, "files": files, "total": sum(f["size"] for f in files), "skipped": skipped}


def project_dup_finish(folder, name):
    import uuid
    text, path = _project_dir(folder)
    nm, new_text, new_path = _sibling(text, name)
    os.makedirs(new_path, exist_ok=True)
    data = _read_json(os.path.join(path, "project.json"))
    data["id"] = uuid.uuid4().hex
    data["name"] = nm
    data["created"] = time.time()
    _write_json(os.path.join(new_path, "project.json"), data)
    _refresh_project_list()
    return {"folder": new_text, "name": nm}



def open_folder(folder=""):
    """Open a folder of the output folder (or the output folder itself) in the file manager of this computer."""
    root = _out_root()
    text = str(folder or "").strip().replace("\\", "/").strip("/")
    if ".." in text.split("/") or re.match(r"^[A-Za-z]:", text):
        raise ValueError("a folder must be written relative to the output folder")
    path = os.path.abspath(os.path.join(root, *text.split("/"))) if text else root
    if os.path.commonpath([root, path]) != root:
        raise ValueError("that folder is outside the output folder")
    if not os.path.isdir(path):
        raise ValueError(f"{text or 'the output folder'} does not exist (yet)")
    import subprocess
    if sys.platform.startswith("win"):
        os.startfile(path)                                  # noqa: the file manager (Explorer)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])
    return {"opened": text or "(output folder)"}



def _tl_mod(suffix):
    for name, mod in list(sys.modules.items()):
        if name.endswith(suffix) and "obvpm" in name:
            return mod
    return None


def plan_batches(folder, plan_id):
    """Every batch that made takes or drafts for one planned clip, found by looking at the
    files in `folder` (output-relative): {"batches": [{"batch", "takes": [{clip, draft, candidate}]}]},
    the newest batch first. The timeline keeps only the newest batch's id on the plan itself."""
    ti = _tl_mod("take_info")
    if ti is None:
        return {"batches": []}
    root = os.path.abspath(folder_paths.get_output_directory())
    path = os.path.abspath(os.path.join(root, str(folder or "")))
    if path != root and not path.startswith(root + os.sep):
        return {"batches": []}
    want = str(plan_id or "")
    groups = {}
    def add(batch, item, when):
        g = groups.setdefault(batch, {"batch": batch, "takes": [], "at": 0})
        g["takes"].append(item)
        g["at"] = max(g["at"], when)
    for side, video, candidate in ti._job_sidecars(path):
        try:
            h = ti.mctx.read_header(side)
        except Exception:
            continue
        if h.get("plan_id") != want or not h.get("plan_batch") or h.get("sound_only"):
            continue
        try:
            when = os.path.getmtime(video)
        except OSError:
            when = 0
        add(str(h["plan_batch"]), {"clip": os.path.relpath(video, root).replace(os.sep, "/"),
                                   "candidate": bool(candidate)}, when)
    nh = _tl_mod("nodes_hunt")
    CANDIDATE_DIR = getattr(nh, "CANDIDATE_DIR", None)
    nr = _tl_mod("nodes_result")
    hunts = os.path.join(path, CANDIDATE_DIR) if CANDIDATE_DIR else None
    if nr is not None and hunts and os.path.isdir(hunts):
        for r in sorted(os.listdir(hunts)):
            rd = os.path.join(hunts, r)
            if not os.path.isdir(rd):
                continue
            try:
                items = nr.run_extras(rd, None)
            except Exception:
                items = []
            for it in items:
                if isinstance(it, dict) and it.get("plan_id") == want and it.get("plan_batch") and it.get("clip"):
                    add(str(it["plan_batch"]), {"clip": it["clip"], "candidate": True, "draft": True},
                        float(it.get("mtime_ms") or 0) / 1000.0)
    out = sorted(groups.values(), key=lambda g: -g["at"])
    for g in out:
        g["takes"].sort(key=lambda t: (bool(t.get("draft")), t["clip"]))
        del g["at"]
    return {"batches": out}


_json_route("/avfx/clip_populator/plan_batches", lambda d: plan_batches(d.get("folder"), d.get("plan_id")))
_json_route("/avfx/clip_populator/project_info", lambda d: project_info(d.get("folder")))
_json_route("/avfx/clip_populator/project_delete", lambda d: project_delete(
    d.get("folder"), d.get("kind"), d.get("timeline"), d.get("keep"), d.get("mode")))
_json_route("/avfx/clip_populator/project_rename", lambda d: project_rename(d.get("folder"), d.get("name")))
_json_route("/avfx/clip_populator/project_dup_plan", lambda d: project_dup_plan(d.get("folder"), d.get("name")))
_json_route("/avfx/clip_populator/project_dup_finish", lambda d: project_dup_finish(d.get("folder"), d.get("name")))
_json_route("/avfx/clip_populator/open_folder", lambda d: open_folder(d.get("folder")))
_json_route("/avfx/clip_populator/saveproj_plan", lambda d: saveproj_plan(d.get("document"), d.get("folder")))
_json_route("/avfx/clip_populator/saveproj_copy", lambda d: saveproj_copy(d.get("src"), d.get("dst"), d.get("size")))
_json_route("/avfx/clip_populator/saveproj_cleanup", lambda d: saveproj_cleanup(d.get("pairs"), d.get("mode")))


NODE_CLASS_MAPPINGS = {
    "AVFX_AutoClipPopulator": AVFXAutoClipPopulator
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AVFX_AutoClipPopulator": "AVFX Auto Clip Populator"
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
