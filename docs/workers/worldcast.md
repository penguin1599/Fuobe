# WorldCast worker (optional, your GPU)

WorldCast ([PixCtrol/WorldCast](https://github.com/PixCtrol/WorldCast) `7ccf2e0d`, weights
[ly56/worldcast](https://huggingface.co/ly56/worldcast) `27635f27`) films a still along a camera path while the back
and sides of the subject follow up to four reference views. It is the open half of the Fuobe Fly-Around Original:
Cinema's **Fly path**, **Turnaround / Fly around this character** and the **exact orbits** (Fuobe DoP, Cinema's moves,
Image to 3D's "Film it photoreal", Assist's `fly_around`) film with it on the open engine while a worker answers.
Nobody hosts WorldCast, so there is no cloud route: the cloud keeps H3 Max camera controls and its references routes.

WorldCast has no ComfyUI port: it needs its own DiT code. So it runs as a separate HTTP service on your GPU, like the
[TRIBE v2 worker](tribe-v2.md). Fuobe ships a reference server in [`workers/worldcast/`](../../workers/worldcast/README.md).

Research: [`new-models-7.md`](../research/new-models-7.md) §3.1–§3.6, §3.8, §3.11.

## Licence

- WorldCast code and weights: **Apache-2.0** (on Wan2.1-I2V-14B-720P, Apache-2.0). WorldCast's README says Stage 1
  trained on SpatialVID (CC BY-NC-SA 4.0), which the authors used "strictly for academic research purposes and not for
  any commercial applications". Fuobe records this as information in Settings → Models & licences.
- What Fuobe prepares each case with: MoGe 2 (MIT), SAM 3.1 (Meta SAM License).
- Optional, the paper's own: Depth Pro (Apple research licence, no commercial use) and VGGT-Omega (FAIR
  Noncommercial, gated). Each has its row and switch in Settings → Models & licences.

## Setting

**Settings → Open-source engine → WorldCast worker URL**, beside the isolated worker (or `WORLDCAST_URL`). It is the
studio owner's setting. An account's runs never reach it: accounts run on their own ComfyUI, and the three buttons
plan their Uni3C / Frames runs for them without mentioning the worker.

Fuobe asks `GET /health` before it plans (an answer is kept for a minute). While the worker answers, the buttons film
with WorldCast; otherwise they run as before and say so: "Runs on Uni3C: add a WorldCast worker (48 GB+) for sides that
match your photos" (Frames, on Turnaround).

## How Fuobe prepares a case

One run is a few steps (`src/lib/catalog/worldcast-plan.ts`):

1. **Depth of the still**: MoGe 2 (`oss-scene-moge`, the 3D scene's) by default; Depth Pro or VGGT-Omega through
   `POST /depth` when the worker lists them.
2. **Person masks**: core `SAM3_Detect` with the pinned `sam3.1_multiplex_fp16` (`image-person-mask-sam3`), for the
   still and each view.
3. **The case** (`src/server/worldcast-case.ts`, `src/lib/worldcast.ts`):
   - the still, centre-cropped to WorldCast's portrait 480:832 and sized 480 × 832, and its mask cropped the same way;
   - the path: 81 camera-to-world poses from the camera-path library (`framePoses`), OpenCV axes (x right, y down,
     z forward), the world being the first frame's camera, so pose 0 is the identity; the pixel intrinsic of the
     480 × 832 frame from the crop's field of view (Fuobe's default 24 mm lens);
   - `render.mp4` and `render_mask.mp4`: the still's point cloud (its MoGe depth) drawn along those poses, 81 frames at
     15 fps, H.264; the mask is white (255) where no point landed (a hole) and black (0) where one did;
   - the anchors: the views with WorldCast's names and azimuths (below), each with its SAM 3.1 mask, brought down to a
     longest side of 1344 px (the demo's body views are cut from 768 × 1344 frames) and never enlarged. The still is
     always the `front` anchor when no front view is given: the pipeline drops every anchor, the first frame's
     included, when it has no body view, and the released checkpoint was never trained that way;
   - `anchors_aligned_camera_info.json`: each anchor's camera on a level ring at the subject's distance, looking at
     it. This is a guess: the paper aligns real cameras with VGGT-Omega. Without the file WorldCast skips the anchors'
     Plücker rays; the quality impact of either is unknown.

### The anchors' names are where the camera stands

WorldCast's anchor names (front, right_side, back, left_side) name **where the camera stands**, measured from the
first frame's camera, with the azimuth growing as the camera moves round to its own right (Fuobe's camera-path
azimuth). WorldCast's own demo case shows this: its aligned `right_side` camera sits at +x of the first camera, and its
"right_side" crop shows the boy facing the lens, because the first frame shows him in profile.

Fuobe's views are named by the person's own sides, with the front as the first frame. To see a person's right side the
camera goes round to its left, so (`worldcastAnchor`):

| Fuobe side | WorldCast anchor | azimuth |
|---|---|---|
| front | `front` | 0° |
| right (the person's own) | `left_side` | 270° (`left_sign` −1: −90°) |
| back | `back` | 180° |
| left (the person's own) | `right_side` | 90° |

## Contract

All bodies are JSON unless said. Errors answer `{"error": "…"}` with an HTTP status.

Authentication: when the worker has a `WORLDCAST_TOKEN`, every call (health included) needs
`Authorization: Bearer <token>`, and answers 401 without it. Fuobe sends its own `WORLDCAST_TOKEN` setting (environment)
on every call and on the clip's download. A worker without a token must listen on `127.0.0.1` only. `POST /cases` and
`POST /depth` need a `Content-Length` (411 without one; 413 over 512 MB).

### `GET {WORLDCAST_URL}/health`

```json
{ "ok": true, "model": "PixCtrol/WorldCast@7ccf2e0", "vram_gb": 80, "busy": false, "depth": ["depth-pro"] }
```

`ok` is false while the weights load. `depth` lists the extra depth models the worker can run (`depth-pro`,
`vggt-omega`).

### `POST {WORLDCAST_URL}/cases`

`multipart/form-data`:

| Part | Kind | What |
|---|---|---|
| `first_frame.png` | file | the first frame, 480 × 832 RGB |
| `person_mask.png` | file | its person mask, 480 × 832, white = the person |
| `render.mp4` | file | the point-cloud render along the path, 81 frames, 480 × 832, 15 fps |
| `render_mask.mp4` | file | its holes: 0 = covered, 255 = a hole |
| `cam_info.json` | file | `{width, height, num_frames: 81, intrinsic: 3×3, extrinsic: 81 × 4×4 camera-to-world (OpenCV), …}` |
| `anchors` | field | JSON list, at most four: `[{"side": "back", "azimuth": 180, "image": "anchor_back.png", "mask": "anchor_back_mask.png"}]` |
| `anchor_<side>.png`, `anchor_<side>_mask.png` | file | each anchor's whole picture and its person mask, the same size |
| `anchors_aligned_camera_info.json` | file, optional | `{views: ["first_frame", "front", …], extrinsic: world-to-camera 4×4 per view, intrinsic, width, height}` |
| `prompt` | field | one sentence about the subject and what it does |
| `seed` | field | integer |
| `steps`, `cfg`, `shift` | field | 50, 5.0, 2.0 (the checkpoint's) |
| `height`, `width` | field | 832, 480 |

Answers `{"id": "<job id>"}` (letters, digits, `-` and `_`, at most 64), or 422 with what was wrong, or 503 while the
weights load.

The reference server lays the case out as WorldCast's `demo_case/` is laid out and cuts the `no_padding_black/` crops
itself, as read from `demo_case/` and `worldcast_pipeline.py` L842–869 and `_encode_per_view_nopad`: the picture with
the background set to black, cropped tight to the mask's bounding box (the demo's 319 × 1028 crop of a 768 × 1344 frame
touches the person on all four sides), and the mask cropped the same way as a 0 / 255 PNG. The first frame's crop is
WorldCast's first-frame anchor (RoPE slot 0); the anchors take slots 25 / 30 / 35 / 40 by name.

### `POST {WORLDCAST_URL}/depth`

`multipart/form-data`: `model` (`depth-pro` or `vggt-omega`), `image` (the still). Answers `{"id": "…"}`, or 501 when
that model isn't installed. The result is `GET /jobs/{id}/depth.png`: an 8-bit grey depth picture of the still, near =
bright.

### `GET {WORLDCAST_URL}/jobs/{id}`

```json
{ "id": "…", "status": "running", "progress": 0.42, "message": "…" }
```

`status` is `queued`, `running`, `succeeded` or `failed` (with `error`). 404 when the worker doesn't know the job (it
was restarted, or the job was forgotten).

### `GET {WORLDCAST_URL}/jobs/{id}/video`

The clip: an MP4, 81 frames at 15 fps (5.4 s), 480 × 832. 409 until it's done.

### `DELETE {WORLDCAST_URL}/jobs/{id}`

Stops a queued or running job.

## After the run

The clip is portrait 480 × 832 at 15 fps. In Upscale, FPS Boost (RIFE) takes it to 24 fps and the upscalers enlarge
it, as for any clip.

## What can't be checked without the GPU

Everything that runs WorldCast: at least 48 GB of VRAM, an 82 GB base download, an unknown run time (20–40 minutes per
clip on one 80 GB card is a guess), quality with MoGe 2 depth instead of Depth Pro, and quality with ring cameras or
without aligned anchor cameras. Fuobe's client is tested against a stand-in worker (`tests/worldcast-worker.test.ts`).
