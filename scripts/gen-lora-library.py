#!/usr/bin/env python3
"""
Generate src/lib/catalog/lora-library.generated.ts: every LoRA the Fuobe Originals use, with its pinned
download, unique local file name and a licence snapshot, plus the motion / effect preset → LoRA map.
Source: docs/research/fuobe-originals-recipes-5.json (loraLibrary, presets, motionsEffects, adapterLoras: the LoRAs an
Original's recipe always loads, such as Fuobe Try-On's try-on LoRA, and Mixed Media's looks:
studios[mixed-media].original.looks).

The LoRA files are never committed: src/server/loras.ts downloads them (pinned civitai versions,
Hugging Face files) into ComfyUI's loras folder, or mirrors them for the cloud engine.

Every file is pinned to exact bytes (scripts/fetch-lora-pins.py reads the pins once): a civitai version id, or
the Hugging Face commit the URL is rewritten to (resolve/<commit>/…), plus the file's SHA256 and size, which
the downloader checks instead of trusting what the source serves that day.

Licences are information (the owner's decision of 2026-10-27; Settings → Models & licences has the switches):
a default that uses a non-commercial LoRA, or sends one licensed for the user's GPU only to the cloud, is
printed as a licence note, never a failure.

Fuobe's own LoRAs (research fuobeTrainedLoras, §6; the training kit in scripts/train/): until a trained file exists
each one is a "planned" entry (PLANNED_LORAS) that no preset may use. Once `scripts/train/kit.mjs publish` has published the
file and its data-licence log, the entry's `trained` block (pinned URL, SHA256, size, licence) moves it into the library.

Fails (exit 1) when an entry's data is wrong:
- an entry without a licence snapshot (the licence as written, and commercial / hostedOk read on a date);
- a preset, a motion / effect row or a Mixed Media look that uses a planned LoRA (no trained file yet);
- a civitai entry without a pinned version id or a permission snapshot, or whose commercial / hostedOk
  flags disagree with its permissions (Image = outputs may be sold, Rent = may run on fal / Replicate);
- a file without a SHA256 pin, or a Hugging Face file without a pinned commit;
- two entries with the same local file name but different downloads (ComfyUI keys LoRAs on the name), or a
  name many unrelated LoRAs share (pytorch_lora_weights.safetensors, lora_weights_step_02000.safetensors…);
- a file name that isn't a plain file name.

Run:  python3 scripts/gen-lora-library.py
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = json.loads((ROOT / "docs/research/fuobe-originals-recipes-5.json").read_text(encoding="utf-8"))
AS_OF = DATA["asOf"]
DOWNLOADS = {"direct", "civitai-token", "hf-gated"}
SAFE_FILE = re.compile(r"^[\w.\-\[\]() ]+\.safetensors$")
# Names many unrelated LoRAs share (diffusers' and trainers' defaults): a file already in ComfyUI's folder under such
# a name may be another LoRA, so the library renames them (research: "file").
GENERIC_FILE = re.compile(r"^(pytorch_lora_weights|adapter_model|diffusion_pytorch_model|model|lora|lora_weights(_step_\d+)?|v\d+)\.safetensors$", re.I)
HF_MAIN = re.compile(r"^(https://huggingface\.co/[^/]+/[^/]+/resolve/)main/(.+)$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
# Motion / effect statuses whose LoRAs become defaults (build plan O4: gen-oss-loras.py takes these rows).
DEFAULT_STATUSES = {"add-lora", "replace", "relight-route", "weak-candidate", "local-only", "licence-hold"}
errors = []
notes = []


def slug(s):
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))


def permissions(licence):
    """'civitai permissions: Image, RentCivit (no third-party hosting)' -> ['Image', 'RentCivit']."""
    m = re.match(r"^civitai permissions:\s*(.*)$", licence or "")
    if not m:
        return None
    return [p for p in (re.sub(r"\(.*?\)", "", x).strip() for x in m.group(1).split(",")) if p]


def entry(raw, key, group, checked=None, spare=False):
    where = f"{group} {key}"
    lic = raw.get("licence") or ""
    # Licences are information, but every entry carries one: the licence as written and what it allows, read on a date.
    if not lic.strip() or not isinstance(raw.get("commercial"), bool) or not isinstance(raw.get("hostedOk"), bool):
        errors.append(f"{where}: no licence snapshot (licence, commercial and hostedOk)")
    perms = permissions(lic)
    url = raw.get("url") or ""
    out = {
        "key": key,
        "name": raw["name"],
        "file": raw.get("file") or "",
        "url": url,
        "page": raw.get("page") or "",
        "strength": raw.get("strength", 1.0),
        "base": raw.get("base") or "",
        "download": raw.get("download") or "",
        "group": group,
    }
    trig = (raw.get("trigger") or "").strip()
    if trig:
        out["trigger"] = trig
    if raw.get("target"):
        out["target"] = raw["target"]
    elif out["base"].startswith("wan2.1"):
        # Wan 2.1 LoRAs run on both Wan 2.2 experts (build plan O1).
        out["target"] = "both"
    version = re.search(r"civitai\.com/api/download/models/(\d+)", url)
    if version:
        out["version"] = version.group(1)
    hf = HF_MAIN.match(url)
    if hf:
        # Pinned to the commit the hash was read at: a file replaced upstream is never downloaded silently.
        rev = raw.get("revision") or ""
        if not COMMIT.match(rev):
            errors.append(f"{where}: Hugging Face file without a pinned commit (run scripts/fetch-lora-pins.py)")
        else:
            out["url"] = f"{hf.group(1)}{rev}/{hf.group(2)}"
            out["version"] = rev
    elif out["download"] != "civitai-token" and url.startswith("https://huggingface.co/"):
        errors.append(f"{where}: Hugging Face URL {url!r} is not a resolve/main/… file URL")
    sha = (raw.get("sha256") or "").lower()
    if SHA256.match(sha):
        out["sha256"] = sha
        if isinstance(raw.get("sizeBytes"), int):
            out["sizeBytes"] = raw["sizeBytes"]
    else:
        errors.append(f"{where}: no SHA256 pin for {out['file']} (run scripts/fetch-lora-pins.py)")
    model = re.search(r"civitai\.com/models/(\d+)", out["page"])
    if model:
        out["civitaiModel"] = model.group(1)
    licence = {"commercial": bool(raw.get("commercial")), "hostedOk": bool(raw.get("hostedOk")), "snapshotDate": raw.get("checked") or checked or AS_OF, "name": lic}
    if perms is not None:
        licence["permissions"] = perms
    out["licence"] = licence
    for k in ("released", "hostedEndpoint", "notes"):
        if raw.get(k):
            out[k] = raw[k]
    if spare:
        out["spare"] = True

    # The data's own rules (pins, file names, flags that match the permissions).
    if not SAFE_FILE.match(out["file"]) or "/" in out["file"] or ".." in out["file"]:
        errors.append(f"{where}: file {out['file']!r} is not a plain .safetensors name")
    if GENERIC_FILE.match(out["file"]):
        errors.append(f"{where}: file {out['file']!r} is a name other LoRAs use too; give it a unique one")
    if out["download"] not in DOWNLOADS:
        errors.append(f"{where}: unknown download {out['download']!r}")
    if not url.startswith("https://"):
        errors.append(f"{where}: no https download URL")
    if out["download"] == "civitai-token":
        if "version" not in out:
            errors.append(f"{where}: civitai download without a pinned version id ({url})")
        if not perms:
            errors.append(f"{where}: civitai download without a permission snapshot")
    if perms is not None:
        if licence["commercial"] != ("Image" in perms):
            errors.append(f"{where}: commercial={licence['commercial']} but permissions are {perms}")
        if licence["hostedOk"] != ("Rent" in perms):
            errors.append(f"{where}: hostedOk={licence['hostedOk']} but permissions are {perms}")
    return out


used = {l["key"] for p in DATA["presets"] for l in (p.get("loras") or [])}
used |= {l["key"] for l in DATA["soul"].get("loras") or [] if isinstance(l, dict) and l.get("key")}
# Fuobe Mixed Media's looks (build plan O9): a preset id → the Z-Image LoRAs its frames are drawn with.
MIXED = (next((s for s in DATA["studios"] if s["id"] == "mixed-media"), {}).get("original") or {}).get("looks") or {}
used |= {l["key"] for ls in MIXED.values() for l in ls}

library = []
by_file = {}


def add(e):
    prev = by_file.get(e["file"])
    if prev:
        if prev["url"] != e["url"]:
            errors.append(f"{e['key']}: file {e['file']} is also {prev['key']} with another download")
        return prev
    by_file[e["file"]] = e
    library.append(e)
    return e


for raw in DATA["loraLibrary"]:
    add(entry(raw, raw["key"], "look", spare=raw["key"] not in used))

# A look a Soul preset uses runs on both engines: its licence is said, not enforced.
for e in library:
    if not e.get("spare") and not (e["licence"]["commercial"] and e["licence"]["hostedOk"]):
        notes.append(f"look {e['key']}: a preset uses it with commercial={e['licence']['commercial']} hostedOk={e['licence']['hostedOk']}")

motions = []
for m in DATA["motionsEffects"]:
    keys = []
    for raw in m.get("loras") or []:
        e = add(entry(raw, slug(re.sub(r"\.safetensors$", "", raw.get("file") or raw["name"])), m["kind"], checked=raw.get("checked")))
        if e["key"] not in keys:
            keys.append(e["key"])
        if m["status"] in DEFAULT_STATUSES:
            where = f"{m['kind']} {', '.join(m['presets'][:3])} ({m['status']}): {e['key']}"
            if not e["licence"]["commercial"]:
                notes.append(f"{where} is non-commercial")
            elif not e["licence"]["hostedOk"]:
                notes.append(f"{where} is licensed for the user's GPU only")
    row = {"kind": m["kind"], "presets": m["presets"], "status": m["status"], "loras": keys,
           "bothEnginesToday": bool(m.get("bothEnginesToday")), "newSinceMid2026": bool(m.get("newSinceMid2026"))}
    hosted = (m.get("hosted") or {}).get("endpoint")
    if hosted:
        row["hostedEndpoint"] = hosted
    if m.get("notes"):
        row["notes"] = m["notes"]
    motions.append(row)

# Adapters: a LoRA an Original's recipe always loads (Fuobe Try-On's try-on LoRA, build plan O10). Its licence is said
# like any other's, and Settings → Models & licences has its switch.
for raw in DATA.get("adapterLoras") or []:
    e = add(entry(raw, raw["key"], "adapter", checked=raw.get("checked")))
    if not (e["licence"]["commercial"] and e["licence"]["hostedOk"]):
        notes.append(f"adapter {e['key']} ({', '.join(raw.get('usedBy') or [])}): commercial={e['licence']['commercial']} hostedOk={e['licence']['hostedOk']}")

mixed = {}
for preset, ls in MIXED.items():
    if not re.match(r"^mixed-[a-z0-9-]+$", preset):
        errors.append(f"mixed-media look {preset!r} is not a Mixed Media preset id")
    for l in ls:
        e = next((x for x in library if x["key"] == l["key"]), None)
        if not e:
            errors.append(f"mixed-media look {preset}: no LoRA {l['key']!r} in loraLibrary")
        elif e["base"] != "z-image-turbo":
            errors.append(f"mixed-media look {preset}: {l['key']} is a {e['base']} LoRA, not Z-Image Turbo")
        if not (isinstance(l.get("strength"), (int, float)) and 0 < l["strength"] <= 2):
            errors.append(f"mixed-media look {preset}: strength {l.get('strength')!r} out of range")
    mixed[preset] = [{"key": l["key"], "strength": l["strength"]} for l in ls]

# Fuobe's own LoRAs (§6 and the Wan 2.2 motion LoRAs): planned until a trained file is published with its data-licence log.
OWN_ID = re.compile(r"^fuobe-[a-z0-9-]+$")
planned = []
for raw in DATA.get("fuobeTrainedLoras") or []:
    key = raw["id"]
    if not OWN_ID.match(key):
        errors.append(f"own LoRA {key!r} is not a fuobe-… id")
    group = raw.get("group") or "look"
    trained = raw.get("trained")
    if trained:
        # Published (scripts/train/kit.mjs publish): an ordinary library entry, pinned and with its licence snapshot.
        add(entry({"name": raw.get("name") or key, "base": raw["base"], **trained}, key, group, spare=key not in used))
        continue
    planned.append({
        "key": key,
        "base": raw["base"],
        "group": group,
        "kind": raw.get("kind") or "style",
        "presets": [x.strip() for x in re.split(r",(?![^(]*\))", re.sub(r"\s*\(.*?\)", "", raw.get("presets") or "")) if x.strip()],
        "file": f"{key}.safetensors",
        "status": "planned",
        "trainer": raw.get("trainer") or "",
        "spec": f"scripts/train/specs/{key}.json",
        "dataLog": f"scripts/train/data-logs/{key}.json",
        # What the data will be: Fuobe's own or licensed for AI training, logged item by item before any run.
        "licence": {"commercial": True, "hostedOk": True, "snapshotDate": AS_OF, "name": "Fuobe's own (data-licence log)"},
    })
planned_ids = {p["key"] for p in planned} | {p["file"] for p in planned}
for p in DATA["presets"]:
    for l in p.get("loras") or []:
        if l.get("key") in planned_ids or l.get("file") in planned_ids:
            errors.append(f"preset {p['name']}: uses the planned LoRA {l.get('key') or l.get('file')} (no trained file yet)")
for m in DATA["motionsEffects"]:
    for l in m.get("loras") or []:
        if l.get("file") in planned_ids:
            errors.append(f"{m['kind']} {', '.join(m['presets'][:3])}: uses the planned LoRA {l['file']} (no trained file yet)")
for preset, ls in MIXED.items():
    for l in ls:
        if l.get("key") in planned_ids:
            errors.append(f"mixed-media look {preset}: uses the planned LoRA {l['key']} (no trained file yet)")

keys = [e["key"] for e in library] + [p["key"] for p in planned]
dup = sorted({k for k in keys if keys.count(k) > 1})
if dup:
    errors.append(f"duplicate keys: {dup}")

if errors:
    print("gen-lora-library: the research data is wrong:\n  " + "\n  ".join(errors), file=sys.stderr)
    sys.exit(1)
if notes:
    print("licence notes (information, shown in Settings → Models & licences):\n  " + "\n  ".join(dict.fromkeys(notes)))

ts = (
    "// Generated by scripts/gen-lora-library.py from docs/research/fuobe-originals-recipes-5.json — do not edit by hand.\n"
    'import type { LoraEntry, MotionEffectLoras, PlannedLora } from "./loras";\n\n'
    f"/** When the LoRA research (licences, civitai permissions, pinned versions) was read. */\n"
    f"export const LORA_LIBRARY_AS_OF = {json.dumps(AS_OF)};\n\n"
    "/** Every LoRA the Originals use: Soul looks (group \"look\"), motion / effect LoRAs and the adapters a recipe always loads, one entry per local file. */\n"
    f"export const LORA_LIBRARY: LoraEntry[] = {json.dumps(library, indent=2, ensure_ascii=False)};\n\n"
    "/** Motion and effect presets (Higgsfield's generic names) → their LoRA keys in LORA_LIBRARY, with the research's status. */\n"
    f"export const MOTION_EFFECT_LORAS: MotionEffectLoras[] = {json.dumps(motions, indent=2, ensure_ascii=False)};\n\n"
    "/** Fuobe's own LoRAs not trained yet (research fuobeTrainedLoras; scripts/train/): no preset uses one until its file is published. */\n"
    f"export const PLANNED_LORAS: PlannedLora[] = {json.dumps(planned, indent=2, ensure_ascii=False)};\n\n"
    "/** Fuobe Mixed Media's looks (research studios[mixed-media].original.looks): preset id → the LORA_LIBRARY keys its frames are drawn with. */\n"
    f"export const MIXED_MEDIA_LOOK_LORAS: Record<string, {{ key: string; strength: number }}[]> = {json.dumps(mixed, indent=2, ensure_ascii=False)};\n"
)
(ROOT / "src/lib/catalog/lora-library.generated.ts").write_text(ts, encoding="utf-8")
print(f"wrote {len(library)} LoRAs ({sum(1 for e in library if e['group'] == 'look')} looks), {len(motions)} motion / effect rows, {len(mixed)} Mixed Media looks and {len(planned)} planned own LoRAs")
