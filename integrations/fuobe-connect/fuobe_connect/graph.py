"""The checks Fuobe Connect makes itself, on this computer, whatever a studio sends.

A graph from a studio (a trusted page in direct mode, or the paired studio in pairing mode) runs only when:

- every node type is on the list that ships inside this pack (allowed_nodes.json: the nodes Fuobe's own workflows use),
  plus the types you list yourself in fuobe-connect-nodes.json in ComfyUI's user folder. A studio can never add to it;
- no text names a place: an absolute path in any form ("/x", "\\x", "//host/share", "\\\\?\\C:\\x", "C:\\x", "C:x"), a
  ".." step, a home folder ("~", "~user"), an environment variable at the start ("$HOME/", "%USERPROFILE%\\"), a URL,
  one of ComfyUI's folder tags ("name [output]", "name [temp]"), or a JSON key that names a file, folder or address
  ("video_path": ...). The check looks at the text after its leading spaces and quotes, as a node that trims it sees it;
- every input that a listed node reads as a file or a folder, or a name it downloads (PATH_INPUTS), holds a value the
  graph writes itself, in the one form Fuobe's own graphs use. It never takes a link: another node could work out any
  text;
- every file loader reads one of the files Fuobe sent for the run (named fuobe_<id>.<ext>), never a file of yours and
  never a value that another node works out;
- a link that ComfyUI doesn't type-check feeds only what Fuobe's own graphs feed that way (LOOSE_LINKS): a link from
  an output typed "any", match-typed or dropdown-typed (LOOSE, and inside ComfyUI every such output of every node), and
  any link into a dropdown. ComfyUI checks a dropdown's value against its list only when the graph writes it, so a
  value another node works out would reach a dropdown, or any other input, unchecked;
- a node that puts its inputs into a program's arguments (ARG_NODES: VHS_VideoCombine and ffmpeg) takes a link only
  into its media inputs, and its other text only as one plain word;
- a value the graph writes is never a JSON object, except a 3D view's entries: ComfyUI hands an object to a node
  unchecked, and some nodes read a file's path from one;
- a link names its node's output with a whole number from 0 (["4", 0]). ComfyUI also takes true, false, a number with
  a point (0.0) or -1 as an output. is_link here sees every link that ComfyUI sees, and a link in any of those forms
  is refused;
- a few inputs take only a link from one node type, or text of one shape (LINK_INPUTS, TEXT_INPUTS).

A result is downloaded only when this run's own history lists it. A model name the graph writes is checked by ComfyUI
itself, against the files in your model folders.

Pure, so the tests run it alone.
"""

from __future__ import annotations

import json
import os
import re

# The names Fuobe gives the files it sends (src/server/computer/tasks.ts stageInput).
INPUT_NAME = re.compile(r"^fuobe_[A-Za-z0-9_-]{8,24}\.[a-z0-9]{1,5}$")
# The file types a run sends: pictures, clips, sound, 3D scenes, arrays and subtitles. Never a page, a script, a
# program, or a settings file (.json, .txt, .csv) or a file of no known type (.bin, .octet) that a node could read as one.
INPUT_EXTS = frozenset(
    "png jpg jpeg jpe webp gif bmp tif tiff avif heic heif jxl exr hdr "
    "mp4 m4v mov webm mkv avi mpg mpeg wmv flv 3gp quick "
    "wav mp3 flac ogg oga opus m4a aac aif aiff wma xwav "
    "spz splat glb gltf ply obj fbx stl usdz "
    "npy npz srt vtt".split()
)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
TASK_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}\Z")
CLIENT_ID = re.compile(r"^fuobe-[A-Za-z0-9_-]{4,72}\Z")
# A run's filename prefix: fuobe/<generation id> (src/server/providers/comfyui.ts).
PREFIX = re.compile(r"^fuobe/[A-Za-z0-9_-]{6,64}\Z")

FILE_LOADERS = {
    "LoadImage": ["image"],
    "LoadImageMask": ["image"],
    "LoadImageOutput": ["image"],
    "LoadImageFuobeLive": ["image"],
    "LoadVideo": ["file"],
    "LoadAudio": ["audio"],
    "VHS_LoadVideo": ["video"],
    "VHS_LoadVideoPath": ["video"],
    "VHS_LoadAudio": ["audio_file"],
    "VHS_LoadAudioUpload": ["audio"],
    "VHS_LoadImages": ["directory"],
    "VHS_LoadImagesPath": ["directory"],
    # AusBoss's Crop + Rotate + Pad loads the upload itself.
    "AUSBOSS_NODES_ImageCropRotatePad": ["image"],
    # Any Angle's saved 3D view: the scene file, and the picture entries (checked one by one below).
    "Load3D": ["model_file"],
    # Hi3D's coarse mesh: any file in the input folder by name.
    "Hi3DLoadMesh": ["mesh_file"],
}
# Loaders whose file is optional: "" (no file) or one of the run's own inputs.
OPTIONAL_FILES = {
    # A continuation history (.npz) read from the input folder.
    "H3CharacterSwapShot": ["history_file"],
}
_FILEISH = re.compile(r"image|video|audio|file|path|directory", re.I)

_PATHLIKE = [
    re.compile(r"^[\\/]"),  # /etc/passwd, \Users\x, //host/share, //?/C:/x, \\host\share, \\?\C:\x, \/host/share
    re.compile(r"^[A-Za-z]:(?![ \t])"),  # C:\x, C:/x, and C:x or D:Users\x (a drive with no slash)
    re.compile(r"^~(?!\s)"),  # ~, ~/x, ~user/x
    # $HOME/x, %USERPROFILE%\x, %HOMEDRIVE%%HOMEPATH%\x
    re.compile(r"^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%)+(?:[\\/]|\Z)"),
    re.compile(r"(^|[\\/])\.\.([\\/]|\Z)"),  # a ".." step
    re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://"),  # a URL
    re.compile(r"^file:", re.I),
    re.compile(r"^blake3:", re.I),  # ComfyUI's asset names reach any registered file
    re.compile(r"\x00"),
]
# A key in JSON (or a Python dict) inside a text: "video_path": ..., 'output_folder': ...
_KEY = re.compile(r"""["']([A-Za-z0-9_.-]{1,64})["']\s*:""")
_PLACE_KEY = re.compile(r"(?:^|[_.-])(?:paths?|files?|file_?names?|file_?paths?|dirs?|directory|folders?|urls?|uris?|roots?|assets?|href|src)\Z", re.I)
_TAG = re.compile(r" \[(input|output|temp)\]\Z")
_QUOTES = "\"'`"


def staged_name_ok(name) -> bool:
    """A name Fuobe gives a file it sends: fuobe_<id>.<ext>, with a file type a run sends."""
    return isinstance(name, str) and bool(INPUT_NAME.match(name)) and name.rsplit(".", 1)[1] in INPUT_EXTS


def _trimmed(v: str) -> str:
    """The text as a node that trims spaces and quotes from its start sees it."""
    while True:
        t = v.lstrip().lstrip(_QUOTES)
        if t == v:
            return t
        v = t


def unsafe_text(v: str) -> bool:
    """A text that names a path, an address, a folder tag, or a file inside JSON."""
    t = _trimmed(v)
    return any(p.search(t) for p in _PATHLIKE) or any(_PLACE_KEY.search(k) for k in _KEY.findall(v))


# ---------------------------------------------------------------------------
# Inputs with rules of their own


_NAME = r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}"  # one file or folder name: it never starts with a dot, so it is never ".."
_NONE = re.compile(r"")  # only "": the node's own default, no file

# Inputs that a listed node reads as a file or a folder. Each one takes only a value the graph writes itself, in the one
# form Fuobe's own graphs use; never a link. Every text input of every node on the shipped list was read in that node's
# source (at the commits Fuobe's workflows/comfyui/requirements.json pins); the others are words, numbers or data that
# no node opens as a file, or names that the node itself keeps inside ComfyUI's own folders.
PATH_INPUTS: dict[str, dict[str, re.Pattern]] = {
    # Writes a subtitle file at this path (an absolute one as given, else under the output folder).
    "AILab_Qwen3ASRSubtitle": {"output_path": re.compile(r"(?:fuobe(?:/[A-Za-z0-9_-]{1,64}){1,4})?")},
    # Model files, with $VARS and ~ expanded; a relative path is under the pack's own folder.
    "AuKModelLoader": {
        "checkpoint_path": re.compile(rf"ckpts/{_NAME}/{_NAME}\.safetensors"),
        "config_path": _NONE,
        "qwen_path": re.compile(rf"(?:ckpts/{_NAME})?"),
    },
    # A model folder ("" is ComfyUI's models/Hi3D).
    "Hi3DModelLoader": {"model_root": _NONE},
    # Opens any video or sound file at these paths.
    "MiniMaxH3SourceTimeline": {"video_path": _NONE, "audio_path": _NONE},
    # The run's own folder under output/h3_chains: Fuobe's jobs are named fuobe_<id> (or come from the swap plan nodes).
    "MiniMaxH3ChainPlanModern": {"run_name": re.compile(r"fuobe_[A-Za-z0-9_-]{0,60}[A-Za-z0-9]")},
    # A latent saved in output/open_h3_latents: only one a Fuobe draft saved (fuobe_h3_<id>_00001), never "(newest)",
    # which would be whatever was saved last, yours too.
    "OpenH3LoadRefinedLatent": {"latent_file": re.compile(r"fuobe_[A-Za-z0-9_-]{1,96}_\d{5}\.safetensors")},
    # A SAM model in models/sams, else a path from ComfyUI's working folder (loaded with torch).
    "QWMRefineMask": {"sam_model": re.compile(r"sam_vit_[bhl][A-Za-z0-9_.-]{0,64}\.pth")},
    # Writes every window's frames into this folder.
    "WanVideoImageToVideoMultiTalk": {"output_path": _NONE},
    # ffmpeg's settings for the format: video_formats/<name>.json, opened with the name as given, so never a folder in it.
    "VHS_VideoCombine": {"format": re.compile(rf"image/(?:gif|webp)|video/{_NAME}")},
    # Downloads the Hugging Face repo it names (into models/transformers/<name>) before it looks at the name.
    "DownloadAndLoadWav2VecModel": {"model": re.compile(r"TencentGameMate/chinese-wav2vec2-base|facebook/wav2vec2-base-960h")},
    # Downloads the checkpoint it names.
    "RIFE VFI": {"ckpt_name": re.compile(r"rife47\.pth|rife49\.pth|rife417\.pth|rife426\.pth|sudo_rife4_269\.662_testV1_scale1\.pth")},
    # A YOLO model in models/ultralytics (or its bbox and segm folders), loaded with pickle.
    "H3FaceTrackCrop": {"detector": re.compile(rf"(?:(?:bbox|segm)[\\/])?{_NAME}\.pt")},
    # A model folder, the adapter file and the text encoder (a folder, or a Hugging Face id it downloads).
    "ZenImage21AdapterLoader": {
        "model_folder": _NONE,
        "adapter_file": re.compile(rf"models/text_encoders/{_NAME}\.safetensors"),
        "text_encoder": re.compile(rf"Qwen/Qwen3\.5-0\.8B|models/text_encoders/{_NAME}"),
    },
}

# Inputs that may also (or only) take a link, but only from these node types.
_SWAP_PLANS = frozenset({"H3AdvancedSwapPlan", "H3ObjectSwapPlan", "H3OneClickSwapPlan", "H3PictureSwapPlan", "H3SceneSwapPlan", "H3MontagePlan"})
LINK_INPUTS: dict[str, dict[str, frozenset]] = {
    # The swap plan nodes name their runs from a hash of their inputs.
    "MiniMaxH3ChainPlanModern": {"run_name": _SWAP_PLANS},
    # An SVG that ComfyUI saves into the output folder: only the vectorizer's own.
    "TS_SVGStringToSVGBytesIO": {"SVG_String": frozenset({"TS_ImageToSVGStringColor_Vtracer"})},
}

# A replacement field that reads an attribute or an item ("{a.__class__}", "{a[0]}"): Python's format can reach a
# module's globals (os.environ) through a node's object.
_FIELD_ACCESS = re.compile(r"(?<!\{)(?:\{\{)*\{[^{}!:]*[.\[]")

# Text inputs that must have one shape (a value the graph writes; never a link).
TEXT_INPUTS: dict[str, dict] = {
    "StringFormat": {"f_string": lambda s: not _FIELD_ACCESS.search(s)},
}

# The only inputs that take a JSON object the graph writes: a 3D view's entries (Load3D's are checked below).
OBJECT_INPUTS = frozenset({("Load3D", "image"), ("Save3DAdvanced", "viewport_state")})

# Nodes that take inputs under any name and put the values into a program's arguments. VHS_VideoCombine hands its
# format's settings to ffmpeg, one inside a filter (the GIF format's dither), and ComfyUI checks neither their type nor
# their value. Such a node takes a link only into the inputs named here, and any other text only as one plain word
# ("yuv420p", "hq", "sierra2_4a"), except the texts named here (a file name prefix: ComfyUI keeps the file in output).
ARG_NODES: dict[str, dict[str, frozenset]] = {
    "VHS_VideoCombine": {"links": frozenset({"images", "audio", "meta_batch", "vae", "frame_rate"}), "texts": frozenset({"filename_prefix"})},
}
_WORD = re.compile(r"[A-Za-z0-9_.-]{0,64}")


# ---------------------------------------------------------------------------
# Links ComfyUI doesn't check
#
# ComfyUI checks that a link's output type fits the input, but any type fits an output typed "any" ("*") or a
# match-typed one, and a dropdown-typed output fits every dropdown. It checks a dropdown's value against its list only
# when the graph writes the value, never for a link. So a value another node works out (a text, a list) would reach
# any input through such a link: a dropdown of model names, or an input that takes a file's path inside an object.
# Such links, and every link into a dropdown, may feed only what Fuobe's own graphs feed that way (generated with the
# node list by Fuobe's scripts/connect-nodes.mjs).

_LOOSE_TYPES = frozenset({"*", "COMFY_MATCHTYPE_V3", "COMBO"})
_DROPDOWN_TYPES = frozenset({"COMBO", "COMFY_DYNAMICCOMBO_V3"})


def _shipped() -> dict:
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "allowed_nodes.json"), encoding="utf-8") as f:
        data = json.load(f)
    return data if isinstance(data, dict) else {}


def input_kind(key: str) -> str:
    """An input's name with a trailing number made general: images.image1 and images.image2 are one kind of input."""
    return re.sub(r"\d+\Z", "#", key)


_DATA = _shipped()
# Node types on the shipped list whose outputs ComfyUI doesn't type-check, by output slot.
LOOSE: dict[str, frozenset] = {
    c: frozenset(s for s in slots if isinstance(s, int)) for c, slots in (_DATA.get("loose") or {}).items() if isinstance(c, str) and isinstance(slots, list)
}
# (source type, target type, input kind): the links of that kind that Fuobe's own graphs make.
LOOSE_LINKS: frozenset = frozenset(
    tuple(x) for x in (_DATA.get("links") or []) if isinstance(x, list) and len(x) == 3 and all(isinstance(p, str) for p in x)
)


def loose_type(t) -> bool:
    """An output type that ComfyUI matches to any input: "*", a match type, a dropdown, a list of options, or a text
    type of a node pack's own that says it equals every other type."""
    if type(t) is not str:
        return True
    return any(p.strip() in _LOOSE_TYPES for p in t.split(","))


def dropdown_spec(spec) -> bool:
    """An input spec ComfyUI shows as a dropdown: a list of options, COMBO, or a dynamic dropdown."""
    t = spec[0] if isinstance(spec, (list, tuple)) and spec else spec
    return isinstance(t, (list, tuple)) or (isinstance(t, str) and t in _DROPDOWN_TYPES)


class NodeKinds:
    """What the node classes themselves say, inside ComfyUI: which outputs ComfyUI doesn't type-check and which inputs
    are dropdowns. It covers every node, your own listed ones too. `lookup(class_type)` gives (INPUT_TYPES(),
    RETURN_TYPES) or None. A node's kinds are read once (a class that fails to say is asked again next time: ComfyUI
    refuses a graph with it anyway)."""

    def __init__(self, lookup):
        self._lookup = lookup
        self._seen: dict[str, tuple] = {}

    def _kinds(self, cls: str) -> tuple:
        if cls not in self._seen:
            loose, drops = frozenset(), frozenset()
            try:
                found = self._lookup(cls)
            except Exception:
                return loose, drops
            if found is not None:
                inputs, outputs = found
                try:
                    loose = frozenset(i for i, t in enumerate(outputs or ()) if loose_type(t))
                except Exception:
                    loose = frozenset(range(64))
                try:
                    drops = frozenset(
                        k for part in ("required", "optional") for k, spec in dict((inputs or {}).get(part) or {}).items() if dropdown_spec(spec)
                    )
                except Exception:
                    drops = frozenset()
            self._seen[cls] = (loose, drops)
        return self._seen[cls]

    def loose(self, cls: str, slot: int) -> bool:
        return slot in self._kinds(cls)[0]

    def dropdown(self, cls: str, key: str) -> bool:
        return key in self._kinds(cls)[1]


def comfy_kinds(mappings) -> NodeKinds:
    """NodeKinds from ComfyUI's NODE_CLASS_MAPPINGS (a callable that returns it, read at each new node type)."""

    def lookup(cls):
        klass = mappings().get(cls)
        if klass is None:
            return None
        return klass.INPUT_TYPES(), getattr(klass, "RETURN_TYPES", ())

    return NodeKinds(lookup)


def is_link(v) -> bool:
    """[node id, output slot]: a value another node works out. Every value ComfyUI reads as a link
    (comfy_execution/graph_utils.py is_link): the slot may be any number, true or false too. ComfyUI reads [n, false] as
    output 0, [n, true] as output 1 and [n, -1] as the last output."""
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], (int, float))


def plain_slot(v) -> bool:
    """A link whose slot is written the way Fuobe's graphs (and ComfyUI's own page) write it: a whole number from 0
    (0, 1, 2 ...). Any other form is refused: -1 is the last output, which the checks here would take for another
    one, and Fuobe's graphs never write true, false or a number with a point."""
    return type(v[1]) is int and 0 <= v[1] < 1000


def link_problem(graph: dict, cls: str, key: str, v, kinds: NodeKinds | None = None) -> str | None:
    """A link from an output ComfyUI doesn't type-check, or into a dropdown, that Fuobe's own graphs don't make:
    'unsafe-graph'. A link to no node is ComfyUI's to refuse."""
    src = graph.get(v[0])
    if not isinstance(src, dict) or not isinstance(src.get("class_type"), str):
        return None
    src_cls = src["class_type"]
    loose = v[1] in LOOSE.get(src_cls, ()) or (kinds is not None and kinds.loose(src_cls, v[1]))
    if not loose and not (kinds is not None and kinds.dropdown(cls, key)):
        return None
    return None if (src_cls, cls, input_kind(key)) in LOOSE_LINKS else "unsafe-graph"


def input_problem(graph: dict, cls: str, key: str, v, kinds: NodeKinds | None = None) -> str | None:
    """What is wrong with one input under its node's own rule: 'unsafe-path', 'unsafe-graph', or None."""
    if isinstance(v, dict) and (cls, key) not in OBJECT_INPUTS:
        return "unsafe-graph"
    if is_link(v) and not plain_slot(v):
        return "unsafe-graph"
    links = LINK_INPUTS.get(cls, {}).get(key)
    if is_link(v) and links is not None:
        src = graph.get(v[0])
        return None if isinstance(src, dict) and src.get("class_type") in links else "unsafe-graph"
    form = PATH_INPUTS.get(cls, {}).get(key)
    if form is not None:
        return None if isinstance(v, str) and form.fullmatch(v) else "unsafe-path"
    shape = TEXT_INPUTS.get(cls, {}).get(key)
    if shape is not None:
        return None if isinstance(v, str) and shape(v) else "unsafe-path"
    if links is not None:
        return "unsafe-graph"
    args = ARG_NODES.get(cls)
    if args is not None:
        if is_link(v) and key not in args["links"]:
            return "unsafe-graph"
        if isinstance(v, str) and key not in args["texts"] and not _WORD.fullmatch(v):
            return "unsafe-path"
    if is_link(v):
        return link_problem(graph, cls, key, v, kinds)
    return None


# ---------------------------------------------------------------------------
# The node list


_HERE = os.path.dirname(os.path.abspath(__file__))
OWN_NODES_FILE = "fuobe-connect-nodes.json"


def shipped_nodes() -> frozenset:
    return frozenset(n for n in _shipped().get("nodes", []) if isinstance(n, str))


def own_nodes(user_dir: str | None) -> frozenset:
    """The node types the person added in ComfyUI's user folder (a list, or {"nodes": [...]}); never from a studio."""
    if not user_dir:
        return frozenset()
    try:
        with open(os.path.join(user_dir, OWN_NODES_FILE), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return frozenset()
    items = data.get("nodes") if isinstance(data, dict) else data
    return frozenset(n for n in items if isinstance(n, str)) if isinstance(items, list) else frozenset()


class NodeList:
    """The shipped list plus the person's own file, read again when that file changes."""

    def __init__(self, user_dir: str | None = None, kinds: NodeKinds | None = None):
        self.user_dir = user_dir
        self.shipped = shipped_nodes()
        # Inside ComfyUI: what the node classes say about their outputs and dropdowns (for vet_graph).
        self.kinds = kinds
        self._mtime = None
        self._own = frozenset()

    def __call__(self) -> frozenset:
        path = os.path.join(self.user_dir, OWN_NODES_FILE) if self.user_dir else None
        try:
            mtime = os.stat(path).st_mtime if path else None
        except OSError:
            mtime = None
        if mtime != self._mtime:
            self._mtime = mtime
            self._own = own_nodes(self.user_dir) if mtime is not None else frozenset()
        return self.shipped | self._own


# ---------------------------------------------------------------------------
# A graph


def _staged(v, staged) -> bool:
    """One of the run's own inputs (optionally tagged " [input]")."""
    if not isinstance(v, str):
        return False
    name = v[: -len(" [input]")] if v.endswith(" [input]") else v
    return staged_name_ok(name) and (staged is None or name in staged)


def graph_problem(graph, staged: list[str] | None) -> str | None:
    """Every file loader names one of this run's own inputs. `staged`: the run's input names (None: any name Fuobe
    gives an input, for direct mode, where the pack doesn't know the run). Else: what is wrong."""
    if not isinstance(graph, dict) or not graph:
        return "No graph"
    for node_id, node in graph.items():
        if not isinstance(node, dict):
            return f"Node {node_id} isn't a node"
        cls = node.get("class_type") if isinstance(node.get("class_type"), str) else ""
        inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
        keys = FILE_LOADERS.get(cls)
        known = keys is not None
        if keys is None:
            keys = [k for k in inputs if _FILEISH.search(k)] if re.match(r"^(Load|VHS_Load)", cls) else []
        for k in keys:
            v = inputs.get(k)
            if v is None:
                continue
            if isinstance(v, list):
                # The studio names its files as values; a loader fed by another node could be fed any name.
                if known:
                    return f"Node {node_id} ({cls}) reads a file named by another node"
                continue
            if not _staged(v, staged):
                return f"Node {node_id} ({cls}) reads a file this run didn't send"
        for k in OPTIONAL_FILES.get(cls, []):
            v = inputs.get(k)
            if v is None or v == "":
                continue
            if not _staged(v, staged):
                return f"Node {node_id} ({cls}) reads a file this run didn't send"
        if cls == "Load3D" and "image" in inputs:
            pics = inputs["image"]
            if isinstance(pics, dict):
                for f, x in pics.items():
                    if f == "camera_info" or x in ("", None):
                        continue
                    if not _staged(x, staged):
                        return f"Node {node_id} ({cls}) reads a file this run didn't send"
            elif pics not in ("", None):
                return f"Node {node_id} ({cls}) reads a file this run didn't send"
    return None


def vet_graph(graph, allowed: frozenset | set, staged: list[str] | None, kinds: NodeKinds | None = None) -> str | None:
    """The first reason this graph may not run here, or None. The reasons are the worker program's
    ('unknown-node', 'unsafe-path') and 'unsafe-graph': a loader that reads a file this run didn't send, a JSON object
    the graph writes, or a link from a node that may not feed that input. `kinds`: what ComfyUI's node classes say
    (inside ComfyUI); without it, only the shipped list of untyped outputs is known."""
    if not isinstance(graph, dict) or not graph or len(graph) > 5000:
        return "unsafe-graph"
    for node in graph.values():
        if not isinstance(node, dict) or not isinstance(node.get("class_type"), str) or node["class_type"] not in allowed:
            return "unknown-node"
    for node in graph.values():
        inputs = node.get("inputs")
        if inputs is None:
            continue
        if not isinstance(inputs, dict):
            return "unsafe-graph"
        for k, v in inputs.items():
            for s in _strings(v):
                if unsafe_text(s) or (_TAG.search(s) and not _staged(s, staged)):
                    return "unsafe-path"
            why = input_problem(graph, node["class_type"], k, v, kinds)
            if why:
                return why
    if graph_problem(graph, staged):
        return "unsafe-graph"
    return None


def _strings(v, depth: int = 0):
    """Every text in an input value (a picture entry list is a dict of texts). A link [node, slot] has none: ComfyUI
    reads one only as the input's whole value, so a list inside a value is read for its texts like any other."""
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict) and depth < 4:
        for x in v.values():
            yield from _strings(x, depth + 1)
    elif isinstance(v, list) and depth < 4 and not (depth == 0 and is_link(v)):
        for x in v:
            yield from _strings(x, depth + 1)


# ---------------------------------------------------------------------------
# Results


def files_in(entries: list) -> list[dict]:
    out = []
    for e in entries or []:
        outputs = e.get("outputs") if isinstance(e, dict) else None
        for ui in (outputs or {}).values() if isinstance(outputs, dict) else []:
            if not isinstance(ui, dict):
                continue
            for v in ui.values():
                if isinstance(v, list):
                    for f in v:
                        if isinstance(f, dict) and isinstance(f.get("filename"), str) and isinstance(f.get("type"), str):
                            out.append(f)
    return out


def may_download(w: dict, entries: list) -> bool:
    return any(
        x["filename"] == w.get("filename") and (x.get("subfolder") or "") == w.get("subfolder") and x["type"] == w.get("type") for x in files_in(entries)
    )


def safe_wanted(w: dict) -> bool:
    """A wanted file the server named: a plain file name in output or temp, no way out of the folder."""
    name = w.get("filename")
    sub = w.get("subfolder") or ""
    if not isinstance(name, str) or not name or re.search(r"[\\/]", name) or name in (".", "..") or _TAG.search(name) or unsafe_text(name):
        return False
    if not isinstance(sub, str) or any(p == ".." for p in re.split(r"[\\/]", sub)) or sub.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", sub):
        return False
    return w.get("type") in ("output", "temp")


def has_prefix(prompt, prefix: str) -> bool:
    if not isinstance(prompt, dict) or not isinstance(prefix, str) or not prefix:
        return False
    return any(isinstance(n, dict) and isinstance(n.get("inputs"), dict) and n["inputs"].get("filename_prefix") == prefix for n in prompt.values())


def fuobe_prefixed(prompt) -> bool:
    """A prompt that saves under Fuobe's own prefix (fuobe/<generation id>): one of Fuobe's runs."""
    if not isinstance(prompt, dict):
        return False
    return any(
        isinstance(n, dict) and isinstance(n.get("inputs"), dict) and isinstance(n["inputs"].get("filename_prefix"), str) and PREFIX.match(n["inputs"]["filename_prefix"])
        for n in prompt.values()
    )


def run_prefix(prefix, graph) -> str | None:
    """The run's prefix when it is Fuobe's form and this run's own graph saves under it; else None."""
    if isinstance(prefix, str) and PREFIX.match(prefix) and has_prefix(graph, prefix):
        return prefix
    return None


_ABS_PATH = re.compile(r"(?:[A-Za-z]:[\\/]|\\\\|(?<![\w.~-])/(?=[^\s/'\"]+/))[^\s'\"<>|]*")
_LIST = re.compile(r"\s*not in \[.*", re.S)


def scrub(text, limit: int = 300):
    """ComfyUI's words without folders on this computer or lists of your files, cut short."""
    if not isinstance(text, str):
        return None
    return _ABS_PATH.sub("<path>", _LIST.sub(" not in the list", text[: limit * 4]))[:limit]


def _slim_status(status):
    if not isinstance(status, dict):
        return status
    out = {k: status.get(k) for k in ("status_str", "completed") if k in status}
    msgs = []
    for m in status.get("messages") or []:
        if not (isinstance(m, list) and len(m) == 2 and isinstance(m[0], str) and isinstance(m[1], dict)):
            continue
        d = m[1]
        keep = {k: d[k] for k in ("prompt_id", "node_id", "node_type", "timestamp") if k in d}
        if "exception_message" in d:
            keep["exception_message"] = scrub(d.get("exception_message"), 600)
        if "exception_type" in d:
            keep["exception_type"] = scrub(d.get("exception_type"), 120)
        msgs.append([m[0], keep])
    out["messages"] = msgs[:50]
    return out


def slim(e: dict) -> dict:
    """A history entry as the studio needs it: its status and outputs, not the whole graph again, and no traceback."""
    p = e.get("prompt")
    return {
        "prompt": [p[0], p[1]] if isinstance(p, list) and len(p) >= 2 else None,
        "status": _slim_status(e.get("status")),
        "outputs": e.get("outputs"),
    }


def refusal(answer, sent: set | None = None) -> dict:
    """ComfyUI's 400 answer to a prompt, as the studio needs it to say what was missing: the error types, the node
    classes, and the values the graph itself sent, without lists of your files or folders on this computer."""
    out: dict = {}
    if not isinstance(answer, dict):
        return out
    err = answer.get("error")
    if isinstance(err, dict):
        e = {k: scrub(err.get(k), n) for k, n in (("type", 80), ("message", 300)) if isinstance(err.get(k), str)}
        info = err.get("extra_info")
        if isinstance(info, dict) and isinstance(info.get("class_type"), str):
            e["extra_info"] = {"class_type": info["class_type"][:128]}
        out["error"] = e
    nodes = answer.get("node_errors")
    if isinstance(nodes, dict):
        slim_nodes = {}
        for nid, n in list(nodes.items())[:24]:
            if not isinstance(n, dict):
                continue
            errors = []
            for x in (n.get("errors") or [])[:6]:
                if not isinstance(x, dict):
                    continue
                item = {k: scrub(x.get(k), 300) for k in ("type", "message", "details") if isinstance(x.get(k), str)}
                info = x.get("extra_info") if isinstance(x.get("extra_info"), dict) else {}
                extra = {}
                if isinstance(info.get("input_name"), str):
                    extra["input_name"] = info["input_name"][:64]
                got = info.get("received_value")
                if isinstance(got, str) and len(got) <= 256 and (sent is None or got in sent):
                    extra["received_value"] = got
                if extra:
                    item["extra_info"] = extra
                errors.append(item)
            slim_node = {"errors": errors}
            if isinstance(n.get("class_type"), str):
                slim_node["class_type"] = n["class_type"][:128]
            slim_nodes[str(nid)[:32]] = slim_node
        out["node_errors"] = slim_nodes
    return out


def graph_strings(graph) -> set:
    """Every text a graph's nodes take."""
    out = set()
    for node in graph.values() if isinstance(graph, dict) else []:
        if isinstance(node, dict) and isinstance(node.get("inputs"), dict):
            for v in node["inputs"].values():
                out.update(_strings(v))
    return out
