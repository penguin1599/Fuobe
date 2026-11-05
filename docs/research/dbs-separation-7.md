# Fuobe research #7: DBS soundtrack separation (dialogue, music, effects)

_As of 2026-10-29. Machine-readable twin: [`dbs-separation-7.json`](dbs-separation-7.json) (`dbs`, `models`, `licences`, `pack`, `graphs`, `libraryTooling`, `outsideComfy`, `hosted`, `fuobeToday`, `comparison`, `placements`, `plan`, `risks`, `unknowns`, `sources`). It builds on [`comfyui-oss-3.md`](comfyui-oss-3.md) (MelBand RoFormer + Qwen3-ASR, the open dub's voice split) and [`paid-model-apis-3.md`](paid-model-apis-3.md) (the Demucs, SAM Audio and veed/clean-audio rows)._

**What was asked.** The owner wants DBS soundtrack separation in Fuobe. The new Dynamic Band Splitting (DBS) models split any soundtrack into music, sound effects and dialogue. They are tiny (1.0M and 4.7M parameters) and run on a CPU or a GPU. The pointer was the ComfyUI pack [hiroki-abe-58/ComfyUI-DBS](https://github.com/hiroki-abe-58/ComfyUI-DBS). Licences are information for Settings → Models & licences, never a reason to leave something out.

**How this was produced.** Read-only. Two repositories were cloned with `--depth 1` and read, never run: ComfyUI-DBS at `f656e53434b5485c148a2866fbd6ddc6b6152ed6` (`/home/user/ext/ComfyUI-DBS/repo`) and the upstream JusperLee/Dynamic-Band-Splitting at `ff526463a58ee0278e7bd05c4b8bce112b743e34` (`/home/user/ext/Dynamic-Band-Splitting/repo`). The vendored files were compared with `sha256sum`. Model facts come from the Hugging Face API (sizes, LFS hashes); the configs and cards were downloaded at the pinned revisions and hashed, and the parameter counts were read from the safetensors headers with HTTP range requests. The paper from the arXiv API and abs page; the Registry entry from api.comfy.org; hosted routes from fal's `llms.txt` pages and model search and from Replicate's model pages. The live CPU ComfyUI at `127.0.0.1:8188` was asked only read-only GETs (`/system_stats`, `/object_info`), and its source at `/home/user/ComfyUI` (`fc04da91`, v0.41.0-7) was read. Fuobe was read at `claude/fuobe-parity-4` (`7d7a765`). **Nothing was installed, nothing ran, and no paid call was made.**

## 1. The short version

- **DBS splits one soundtrack into three stems: music, sound effects and speech**, always in that order. The three stems add up to the input exactly (the model forces it), so "everything but the speech" is the original minus the speech (§2.1).
- **Two released models, both tiny and Apache-2.0.** DBS-TIGER-DnR (1,013,729 parameters, 4.1 MB) is the better one: 10.13 dB average SI-SDR on the DnR v2 test set. DBS-BSRNN-DnR (4,713,557 parameters, 18.9 MB) scores 9.07 dB but runs 3.7x faster on a CPU. Both take 44.1 kHz mono. The four files the loader needs come to 23 MB (§3).
- **Dialogue separates well; music against effects less so.** Speech scores 15–16 dB, music 6.5–7.8 dB, effects 5.7–6.7 dB. Fuobe can promise clean dialogue and dialogue-free beds, not a studio-grade music versus effects split. Every number is on synthetic English mixes; nobody has measured real films (§2.3).
- **CPU works, but slowly on Fuobe's server.** The pack's author measured DBS-BSRNN at 1.83x real time on a 24-thread desktop CPU and DBS-TIGER at 0.49x. Fuobe's ComfyUI host has 4 logical CPUs: my guess is 0.3–0.6x real time for DBS-BSRNN. On an RTX 5090 both run 16–22x real time in under 1.7 GiB (§2.4).
- **The ComfyUI pack is small and clean.** Two nodes (`DBSLoader`, `DBSSeparate`), MIT code, the vendored upstream code byte-identical, no downloads at run time, no network or exec code in the nodes, and no new Python package for Fuobe's ComfyUI. The Comfy Registry flags its only version (0.1.0) and gives no public reason; Fuobe would pin the git commit (§4.1–4.2).
- **Fuobe's graphs need only the two DBS nodes plus core nodes.** The pack's own video graph decodes every frame and must not be copied: Fuobe already has stream-copy mux graphs. A core `AudioMerge` subtract keeps a stereo music-and-effects bed at mono cost (§2.1, §4.4).
- **No hosted DBS exists.** The cloud route to three stems is two passes of fal's SAM Audio (prompt "speech", then "music" on what is left), about $0.20–0.40 per minute. Fuobe's Demucs is a music separator, not a dialogue one (§6).
- **What it changes in Fuobe.** Today Fuobe only splits "voice / background" for dubbing. DBS brings a Split soundtrack tool (Audio hub), Remove dialogue for videos (Video tools), a dub that keeps the score and effects (Translate & dub), cleaner voices before Transcribe and Lipsync, an "Original sound" choice in the studios that put a clip's sound back, a Canvas node and Assist tools (§8). The build plan has ten packages; three are P0 (§9).

## 2. What DBS is

### 2.1 What goes in and what comes out

| | |
|---|---|
| Input | One soundtrack. Both released models work on 44.1 kHz mono (model cards: "separates a 44.1 kHz mono soundtrack"; the pack refuses a model with any other rate, `dbs_comfy/runtime.py` L62). The pack resamples other inputs with ComfyUI's own `comfy.audio.resample` (L102–107; present in Fuobe's ComfyUI at `comfy/audio.py` L36). |
| Output | Three stems in a fixed order: music, sfx, speech (both model cards; `runtime.py` L29 `STEMS`). The pack adds a JSON report: model, device, input and output rate, resampled or not, channels, batch, windows, window and hop seconds, audio seconds, run seconds and times real time (L156–162). |
| The sum | The mask head forces the three masks to add up to 1+0j (`dbs/modules/dbs.py` L326–329), so music + sfx + speech = input. The pack measured the largest difference as 5e-7 (`docs/VERIFICATION.md` L56–57). |
| Length | Any. Inference is overlap-add with equal weights (`dbs/engine/inference.py` L29–53, `chunked`): DBS-TIGER uses 6 s windows every 3 s, DBS-BSRNN 3 s windows every 1.5 s. A clip of at most half a window is padded to one window; a clip between half a window and one window runs unpadded at its own length (L32–36); the last window of a long clip is padded and cropped. |
| Rates | `output_sample_rate` is `"44100"` (the model's rate) or `"input"` (resampled back; `runtime.py` L32, L148–154). |
| Extra | `model(mixture, return_aux=True)` also returns the band boundaries the model picked (model cards; `tiger.py` L682–689). The upstream Gradio demo draws them; the pack does not expose them. |

**What the sum means in practice.** Nothing is lost and nothing is invented; sound is only moved between stems. Whatever the model does not call "speech" stays in music or effects. So a "no dialogue" bed keeps any speech the model missed.

**Stereo.** The models are mono. The pack offers two modes (`channels`, `runtime.py` L140):

- **mono** separates the mean of the channels. This is the official usage. All three stems come out mono. For a 5.1 file the mean includes the LFE and surround channels (my reading of L140).
- **each channel** separates every channel on its own and keeps the channel count. The time grows with it: 2x for stereo, 6x for 5.1.

A third way, my proposal (not in the pack; a guess until it is heard): separate the mono mean, then subtract the mono speech from each original channel with core `AudioMerge` (`merge_method: subtract`). Torch broadcasts the 1-channel speech over the 2-channel original (`comfy_extras/nodes_audio.py` L708–741), so the bed keeps the original stereo image at mono cost. It is exact for dialogue mixed to the centre, the usual case in video. Speech panned off centre leaves half the left-right difference in the bed. One catch: `AudioMerge` divides the whole result by its peak when the peak is over 1.0 (L747–749), which would lower the bed's level on a loud mix. §4.4 uses this "fast stereo" bed and §9 D4 checks it.

### 2.2 How it works

From the upstream README overview (L38–48) and the arXiv abstract. Band-split separators (BSRNN, TIGER, BS-RoFormer) cut the spectrum into fixed frequency bands. DBS learns where to cut, for each input:

1. A scorer that looks at the content rates every STFT bin inside 4 coarse regions.
2. Hard Top-K picks a fixed number of boundaries, for a budget of 128 band tokens.
3. Content-weighted pooling makes one token per band.
4. The unchanged backbone (BSRNN, TIGER, BS-RoFormer or Mel-RoFormer) separates the tokens.
5. The tokens are smoothed, spread back over the STFT grid, refined along frequency and turned into complex masks by a head shared by all frequencies.

DBS-MelRoFormer uses a soft router instead of hard boundaries.

- **Paper:** "Learning Where to Split: Dynamic Band Splitting for Audio Source Separation", Bingzhe Zhang, Kai Li, Xiaolin Hu (Tsinghua University). [arXiv:2610.14993](https://arxiv.org/abs/2610.14993) [cs.SD], submitted 2026-10-10, 25 pages, 11 figures. The README's news entry of 2026-10-15 announces the paper; the paper, code and weights all went up on 2026-10-10.
- **Code:** [JusperLee/Dynamic-Band-Splitting](https://github.com/JusperLee/Dynamic-Band-Splitting) at `ff526463` (2026-10-15, still the remote HEAD on 2026-10-29). Python 3.11+.
- **Project page:** [cslikai.cn/Dynamic-Band-Splitting](https://cslikai.cn/Dynamic-Band-Splitting/).
- **Official listening demo:** Hugging Face Space [JusperLee/DBS-Demo](https://huggingface.co/spaces/JusperLee/DBS-Demo) (Gradio, ZeroGPU, files up to 10 minutes and 500 MB).

### 2.3 Quality

SI-SDR on the DnR v2 test set (973 full-length tracks), from the upstream README (L127–132), both model cards and the project page table:

| Model | Music | Speech | SFX | Average | Params | MACs per second of audio |
|---|---|---|---|---|---|---|
| **DBS-TIGER (128 bands)** | 7.78 | 15.90 | 6.70 | **10.13 dB** | 1.0M | 31.6 G |
| **DBS-BSRNN (128 bands)** | 6.48 | 15.01 | 5.73 | **9.07 dB** | 4.7M | 124.0 G |
| TIGER (128), retrained by the authors | | | | 8.74 dB | 1.4M | 20.4 G |
| BSRNN (128), retrained by the authors | | | | 7.69 dB | 35.5M | 76.6 G |
| TIGER (published) | | | | 7.44 dB | 1.4M | 10.8 G |
| MRX | | | | 7.40 dB | 30.5M | 10.6 G |
| BSRNN (published) | | | | 7.03 dB | 52.8M | 18.2 G |
| Conv-TasNet | | | | 3.60 dB | 5.3M | 19.8 G |

- The abstract's "29.0% relative gain" for DBS-BSRNN is against the published BSRNN (9.07 / 7.03 = 1.290), not against the retrained static BSRNN (128), where the gain is 18%.
- DBS-TIGER is about 2.7 dB better than the same author's earlier static model, [JusperLee/TIGER-DnR](https://huggingface.co/JusperLee/TIGER-DnR) (7.44 dB, Apache-2.0).
- **Reading the numbers.** Dialogue comes out well (15–16 dB). Music against effects is much weaker (5.7–7.8 dB): expect audible bleed between those two stems.
- **Other results in the paper, models not released** (README L134–147): MUSDB18-HQ 4 stems, DBS-BSRNN 5.43 dB (21.7M), DBS-BS-RoFormer 6.34 dB (33.9M), DBS-MelRoFormer 8.07 dB (19.1M); EchoSet SDRi, DBS-TIGER 14.55 dB (1.0M), DBS-BSRNN 13.21 dB (7.1M).

### 2.4 Speed and memory

Measured by the pack's author (`docs/VERIFICATION.md` L96–108; Windows 11, RTX 5090, Core Ultra 9 285K with 24 threads, torch 2.14.1+cu130; model already loaded):

| Model | Device | Input | Time | Speed | Peak GPU memory |
|---|---|---|---|---|---|
| DBS-TIGER | RTX 5090 | 10 min, mono | 37.9 s | 15.9x real time | 1.64 GiB |
| DBS-TIGER | RTX 5090 | 10 min, each channel | 74.5 s | 16.1x per channel | 1.61 GiB |
| DBS-BSRNN | RTX 5090 | 10 min, mono | 26.9 s | 22.4x | 1.42 GiB |
| DBS-BSRNN | RTX 5090 | 10 min, each channel | 53.7 s | 22.4x per channel | 1.42 GiB |
| DBS-TIGER | CPU, 24 threads | 60 s, mono | 122.5 s | 0.49x | – |
| DBS-BSRNN | CPU, 24 threads | 60 s, mono | 32.8 s | 1.83x | – |

- **On a CPU, use DBS-BSRNN.** It has 4x the MACs of DBS-TIGER but runs 3.7x faster there.
- **Fuobe's ComfyUI host** (4 logical CPUs, 14.3 GB RAM, torch 2.14.1+cpu, started with `--cpu`; `/system_stats`, `nproc`) was not measured during the research, because the research rules forbid running the pack. The guess then, scaling from 24 threads to 4: DBS-BSRNN at 0.3–0.6x real time, so a 1-minute clip takes 2–3 minutes; DBS-TIGER about 4x slower than that.
- **Measured on this host (package D1, 2026-10-29).** ComfyUI-DBS at `f656e53` on an isolated CPU worker (a copy of the same ComfyUI `fc04da91`, Python 3.13, torch 2.14.1+cpu, `--cpu`), the four weight files of §3.1 at their pinned revisions (`sha256sum -c` OK), graph `separate-soundtrack-dbs` with `output_sample_rate` `input`, synthetic 44.1 kHz test mixes (speech, a chord bed, noise bursts). The host was shared with other jobs (load average 3.4–6 on 4 CPUs), so these are a busy host's numbers. "Seconds" is the pack's own report (separation only); a run adds about 1–2 s to load and save.

  | Model | Input | Channels | Seconds | Real time (per channel) |
  |---|---|---|---|---|
  | DBS-BSRNN | 20 s stereo WAV | mono | 73.7 | 0.27x |
  | DBS-BSRNN | 20 s MP4 (H.264 + AAC, read by `LoadAudio`) | mono | 61.1 | 0.33x |
  | DBS-TIGER | 20 s stereo WAV | mono | 220.7 | 0.09x |
  | DBS-BSRNN | 20 s stereo WAV | each channel (2 passes) | 232.4 | 0.17x |
  | DBS-TIGER | 10 s stereo WAV | each channel (2 passes) | 247.0 | 0.08x |
  | DBS-BSRNN | 10 s 5.1 WAV | each channel (6 passes) | 193.4 | 0.31x |

  So DBS-BSRNN runs at about 0.27x real time here (a minute of audio in about 4 minutes, 3–6 on a busy host) and DBS-TIGER at about 0.09x (about 11 minutes a minute): 3x slower, not 4x. Stereo stems cost one pass per channel. On the 20 s test mix, against its known parts (a sanity check, not a benchmark): the dialogue stem scored 14.6 dB SI-SDR with DBS-BSRNN and 18.5 dB with DBS-TIGER (the mix itself scores −1.0 dB as "dialogue"); the music-and-effects bed 15.6 and 19.4 dB. Music + effects + speech matched the channel mean of the input to 3e-5 (16-bit FLAC). D1's time estimate used 0.27x / 0.09x per pass; since D4 it uses the quiet-host speeds below (`src/lib/av/split.ts` `DBS_SPEED`).
- **Measured by the separation suite (package D4, 2026-11-02).** The same host and pack, ComfyUI started with `--cpu` and nothing else running (load average under 1 before each run), through a running Fuobe (`pnpm eval:run --suite separation --engine open`, run `20261102-111016-separation-open-ae7e`): 24 jobs, six 12 s synthetic stereo mixes at 44.1 kHz (five FLAC, one H.264 + AAC MP4) × four settings. "x real time" is the pack's own `times_real_time` (audio seconds per second of separation, every channel's pass counted); "wall" is the job from upload to the last stem, as a user waits for it.

  | Model | Channels | x real time (pack) | Wall for 12 s | A minute of audio takes |
  |---|---|---|---|---|
  | DBS-BSRNN | mono | 0.22–0.28 (mean 0.25) | 45–55 s | about 4 minutes |
  | DBS-BSRNN | each channel (2 passes) | 0.24–0.27 per pass | 92–100 s | about 8 minutes |
  | DBS-TIGER | mono | 0.10–0.11 | 110–123 s | about 9–10 minutes |
  | DBS-TIGER | each channel (2 passes) | 0.10–0.11 per pass | 219–246 s | about 19 minutes |

  So on this 4-CPU host DBS-BSRNN is 2.4x faster than DBS-TIGER (not 3x: D1's runs shared the CPU). Split soundtrack's time estimate now uses 0.25x / 0.10x per pass (`DBS_SPEED`). Quality on the same mixes is in §9 D4. D5 measured DBS-BSRNN at 0.36–0.42x through graph C (§9 D5) on 15 s mono clips of Mandarin speech. The suite ran graph C itself on the same host (run `20261102-154635-separation-open-8fec`, Clean up dialogue at −18 dB on four of these mixes): 0.23–0.29x, against 0.26–0.30x for graph A on the same mixes that day. So graph C is not faster, and the difference comes from the clips or the host's state on the day, not the graph. The pack resamples every input to 44.1 kHz and runs the same 3 s windows (7 for 12 s, 9 for 15 s), so the clip length and its sample rate don't explain it either; the estimate keeps 0.25x, measured on a quiet host.
- **Threads.** The upstream demo runs DBS-TIGER on a CPU with one thread and NNPACK off and says that is faster and identical (`demo/README.md` L74–75; `demo/backend.py` L134–155). The pack measured that mode as 3.3x slower and not bit-identical (71.5 s against 21.4 s for 10 s of audio; VERIFICATION.md L112–114). Which wins on a 4-core host is unknown.
- **Memory.** The stems of the whole input stay in memory until the end: 12 bytes per input sample at 44.1 kHz, about 0.3 GB per 10 minutes (VERIFICATION.md L107–108). An hour of audio would need about 1.9 GB on top of the decoded input (my arithmetic).

### 2.5 Limits the authors and the pack state

- **Training data:** only DnR v2, synthetic mixes of English read speech (LibriSpeech), FMA music and FSD50K effects. Other languages, shouted or crowd speech, very loud music and real films are unverified.
- **Singing** is likely to end up in "music" (VERIFICATION.md, "Not checked"). That is what a dub wants; it is wrong for someone who asks for "vocals".
- **Determinism:** CUDA runs are not bit-identical. The pack measured 69–80 dB SNR against official runs; official runs differ from each other by 77.5 dB (DBS-TIGER) and 90.7 dB (DBS-BSRNN). ComfyUI's `--deterministic` does not set `cudnn.deterministic`, which DBS-BSRNN's LSTMs would need.
- **Devices:** the pack's `auto` uses ComfyUI's device when its type is `cuda`, otherwise the CPU (`nodes.py` L28–35). ComfyUI returns a `cuda` device for AMD ROCm as well (`comfy/model_management.py` L195–213; the comment at L218–220 says "NVIDIA + AMD/ROCm both expose their GPUs through torch.cuda"), so ROCm runs on the GPU. The pack never tested AMD (VERIFICATION.md L124). Apple MPS, Intel XPU and DirectML fall back to the CPU. The upstream demo backend refuses anything but CPU or CUDA (`demo/backend.py` L57–61).

## 3. The models and their licences

### 3.1 The two released models

| | DBS-TIGER-DnR | DBS-BSRNN-DnR |
|---|---|---|
| Repository @ revision | [`JusperLee/DBS-TIGER-DnR`](https://huggingface.co/JusperLee/DBS-TIGER-DnR) @ `22da7d4cd3ea63f9365181008bff1c0d2ab6fb2b` | [`JusperLee/DBS-BSRNN-DnR`](https://huggingface.co/JusperLee/DBS-BSRNN-DnR) @ `5af343f57f106fbb95efe8a60f1a3999eeb0aef8` |
| `model.safetensors` | 4,111,836 bytes | 18,886,156 bytes |
| `config.json` | 957 bytes | 1,242 bytes |
| `README.md` (optional card) | 2,403 bytes | 2,404 bytes |
| Parameters | 1,013,729 (1,013,727 F32 + 2 I64), 507 tensors | 4,713,557 (all F32), 314 tensors |
| Config | win 2048, stride 512, in 256, out 132, 8 blocks, upsampling depth 5, 3 sources, `use_fla` false (the optional flash-linear-attention block is never built); 4 regions, bins 0–40–80–352–1025, 32 tokens each = 128 bands | n_fft 2048, hop 512, win 2048, not normalized; dim 128, depth 6, bidirectional LSTM, hidden 128, 3 stems, mono; 4 regions, bins 0–64–128–576–1025, 64/64/32/32 tokens = 128 bands |
| Windows | 6 s every 3 s | 3 s every 1.5 s |
| Created, downloads (2026-10-29) | 2026-10-10, 1,648 | 2026-10-10, 704 |
| Gated | no | no |

SHA-256 of the files the ComfyUI loader needs (the pack's `tools/model_files.sha256` matches all of them; the LFS hashes are from the HF API, the configs and cards were downloaded and hashed):

| File (under `models/dbs/`) | SHA-256 |
|---|---|
| `DBS-TIGER-DnR/model.safetensors` | `3d8205743f2a6f5a6704f5d4104d7cf5bf7bf02dab2fd728da31f4c69225cadb` |
| `DBS-TIGER-DnR/config.json` | `c7f7893323e78f9b99747a13090558a13c4f4b77383a38acb9979709fd04d1d8` |
| `DBS-BSRNN-DnR/model.safetensors` | `26290f93e7b501113325e922e7b0c18edca944634e6b9be39856a55204628405` |
| `DBS-BSRNN-DnR/config.json` | `57055e2b71913d98a4e1ed426b71617f0dfc372901cc5a8a3bc4a5c69415043e` |
| `DBS-TIGER-DnR/README.md` (optional) | `df844475771bc045de2586686df4df9acf933cf57080dca7c9db41d6b22e2f2e` |
| `DBS-BSRNN-DnR/README.md` (optional) | `fb386d345dd955befb6dd13e7cb4522d1b2222cba382c17747750ac6a41b3f21` |

The loader reads two files per model (`runtime.py` L30 `FILES`), 4 files in all, 23,000,191 bytes. Both models have a file called `model.safetensors`, so they must live in their own folders. Download URLs follow `https://huggingface.co/<repo>/resolve/<revision>/<file>`. An unofficial mirror of the same size exists at `oulianov/DBS-TIGER-DnR`; Fuobe does not need it.

### 3.2 Licences, as information

For Settings → Models & licences. Every item below is permissive; nothing is held back.

| Item | Licence | Notes | Source |
|---|---|---|---|
| DBS-TIGER-DnR, DBS-BSRNN-DnR weights | **Apache-2.0** | Card front matter `license: apache-2.0`, HF tag `license:apache-2.0`, not gated. Trained from scratch on DnR v2. | model cards at the pinned revisions; HF API |
| Upstream DBS code | **Apache-2.0** | `LICENSE` is the plain template ("Copyright [yyyy] [name of copyright owner]"); the authors come from `pyproject.toml` and `CITATION.cff` (Zhang, Li, Hu). `THIRD_PARTY.md` keeps MIT notices for BS-RoFormer (c) 2023 Phil Wang, Music-Source-Separation-Training (c) 2024 Roman Solovyev (ZFTurbo) and TIGER / Look2Hear (c) 2026 Kai Li. | upstream @ `ff526463` |
| ComfyUI-DBS pack code (outside `dbs_comfy/vendor`) | **MIT**, (c) 2026 hiroki-abe-58 | `LICENSE`, `NOTICE`. The Registry metadata says `license: {"file": "LICENSE"}`. | pack @ `f656e53` |
| Vendored DBS code (`dbs_comfy/vendor`) | **Apache-2.0** with the MIT notices above | `vendor/LICENSE` SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`, identical to upstream | `sha256sum` |
| DnR v2 dataset | **CC BY 4.0** | Attribution: Petermann, Wichern, Wang, Le Roux (Zenodo record 6949108, v2.0, 2021-10-17). From general knowledge, not checked here: some FSD50K and FMA source clips carry their own CC licences, NC variants included. Whether that reaches the weights or their outputs is unresolved; record only. | [zenodo.org/api/records/6949108](https://zenodo.org/api/records/6949108) |
| Paper arXiv:2610.14993 | arXiv non-exclusive distribution licence 1.0 | | abs page |
| HF Space JusperLee/DBS-Demo | apache-2.0 (card) | | Space API |
| Docs images in the pack and project page | CC BY 3.0, (c) Blender Foundation (Tears of Steel, Sintel) | Fuobe does not need them. | pack `docs/`, project page |
| Hosted routes (§6) | Paid APIs | SAM Audio weights: Meta's "SAM License" (last updated November 19, 2025), gated with manual approval; Demucs MIT; ElevenLabs isolation and veed/clean-audio proprietary; DeepFilterNet's licence not checked. | provider pages, HF API, Demucs `LICENSE` |

For `src/lib/licences.ts`: a `NODE_PACKS` row for `ComfyUI-DBS` (MIT; note "vendored DBS code Apache-2.0 with MIT notices; the DBS weights are Apache-2.0, trained on DnR v2 (CC BY 4.0)"), and the workflow `license` text in each spec entry, which `workflowLicence` and `licenceInfo` turn into the model rows. Show the DnR v2 CC BY 4.0 attribution and the three MIT notices on About & licences.

### 3.3 What is not released

- Only the two DnR v2 checkpoints exist. The HF API lists 21 models by JusperLee; the only DBS ones are these two. There are no DBS checkpoints for MUSDB18-HQ (DBS-BSRNN, DBS-BS-RoFormer, DBS-MelRoFormer) or EchoSet.
- A related open model: **Bandit** ([kwatcharasupat/bandit](https://github.com/kwatcharasupat/bandit)), code Apache-2.0, DnR checkpoints on Zenodo 10160698 under CC BY-NC 4.0, 309–776 MB each, 32–83M parameters. DBS is 7–80x smaller with permissive weights. I did not compare scores: Bandit uses DnR record 5574713, which may be a different DnR version.

## 4. The ComfyUI pack and the graphs Fuobe would build

### 4.1 The pack

[hiroki-abe-58/ComfyUI-DBS](https://github.com/hiroki-abe-58/ComfyUI-DBS), an unofficial integration (`NOTICE`). HEAD of main = tag v0.1.0 = **`f656e53434b5485c148a2866fbd6ddc6b6152ed6`** (2026-10-19 15:46:40 +0900, "Make the slowest tests cheaper and give CI more time"; `git ls-remote` on 2026-10-29). `pyproject.toml`: name `dbs-soundtrack-separation`, version 0.1.0, PublisherId `hiroki-abe-58`, `requires-python >=3.10`. It uses ComfyUI's V3 node API (`comfy_api.latest`: `io.ComfyNode`, `ComfyExtension`, entry point `comfy_entrypoint`; `dbs_comfy/nodes.py` L100–107) and asks for ComfyUI v0.38.0+ (README L71).

**`DBSLoader`** ("DBS Loader", category `loaders/dbs`; `nodes.py` L38–63)

| Input | Type | Options | Default |
|---|---|---|---|
| `model` | Combo | `DBS-TIGER-DnR`, `DBS-BSRNN-DnR` (a fixed name list, not a file picker) | `DBS-TIGER-DnR` |
| `device` | Combo | `auto`, `cpu` | `auto` |

Output: `DBS_MODEL` (a custom type, display name "model"; a dict `{folder, name, device}`). It loads at once from `<models>/dbs/<model>/` holding `config.json` and `model.safetensors`; the first registered `dbs` folder holding both wins, so an `extra_model_paths.yaml` entry for `dbs` works (`paths.py` L13–28). A missing file fails at this node. The weights load with `safetensors.torch.load_model(..., strict=True)` (`runtime.py` L61). The cache keeps one model at a time and is cleared on any other load (L56–66), so a graph that uses both models reloads on each switch.

**`DBSSeparate`** ("DBS Separate (music / sfx / speech)", category `audio/dbs`; `nodes.py` L66–97)

| Input | Type | Options | Default |
|---|---|---|---|
| `model` | `DBS_MODEL` | | |
| `audio` | `AUDIO` | | |
| `channels` | Combo | `mono`, `each channel` | `mono` |
| `output_sample_rate` | Combo | `44100`, `input` | `44100` |

Outputs in order: `music` (AUDIO), `sfx` (AUDIO), `speech` (AUDIO), `report` (STRING, indented JSON). It shows a progress bar per window and checks for an interrupt at every window (`nodes.py` L15–25), processes batch items one by one, and refuses empty or non-finite waveforms (`runtime.py` L120–123).

**Fit with Fuobe's ComfyUI.** The pinned ComfyUI `fc04da91` has everything the pack calls: `io.Custom` (`comfy_api/latest/_io.py` L133), `ComfyExtension`, `comfy.audio.resample` (`comfy/audio.py` L36) and `folder_paths.add_model_folder_path` with `is_default` (`folder_paths.py` L382–398). On the live server, `GET /object_info/DBSLoader` and `/object_info/DBSSeparate` return `{}`: not installed (and nothing was installed). Every core node the pack's workflows use is present, plus `AudioAdjustVolume` (INT dB), `AudioMerge` (add, mean, subtract, multiply), `SplitAudioChannels` / `JoinAudioChannels` and the paid `ElevenLabsAudioIsolation` API node.

### 4.2 Dependencies, what the code does, and the Registry flag

- **Requirements:** `einops>=0.7` and `safetensors>=0.4`; torch comes from ComfyUI. Fuobe's ComfyUI already has einops (`scripts/comfy/install-comfyui.sh` L121: "ComfyUI-MelBandRoFormer needs rotary_embedding_torch + einops") and ships safetensors. The pack's clean-install run added no package (VERIFICATION.md L80–86). So it can live in the main ComfyUI, not the isolated worker.
- **Test coverage:** CI tests ComfyUI v0.38.0 (Ubuntu and Windows, Python 3.12, torch 2.14.1; Ubuntu Python 3.10, torch 2.8.0) and v0.42.1 (Ubuntu, Python 3.12) (`.github/workflows/ci.yml`). Fuobe runs ComfyUI v0.41.0-7 on Python 3.13 (`install-comfyui.sh` L12–13; live server 3.13.16): not covered by CI, though every API the pack calls exists in that tree.
- **No downloads at run time.** `paths.py` and `runtime.py` only read local files. The vendored `hub.py` is an empty `PyTorchModelHubMixin`. `tools/download_model.py` is a separate script a person runs by hand: it calls `huggingface_hub.hf_hub_download` at the pinned revisions for `config.json`, `model.safetensors` and `README.md`, then checks SHA-256 against `tools/model_files.sha256`.
- **Vendored code.** `dbs_comfy/vendor/dbs` is the inference subset of upstream `ff526463`. `models/bsrnn.py`, `models/tiger.py`, `modules/__init__.py`, `modules/band_split.py`, `modules/dbs.py`, `modules/stft.py`, `engine/inference.py`, `LICENSE` and `THIRD_PARTY.md` are byte-identical to upstream (`sha256sum`); `sha256sum -c MANIFEST.sha256` passes for all 13 entries. Four small files are the pack's own shims: `dbs/__init__.py`, `engine/__init__.py` (exports `separate` only), `models/__init__.py` (BSRNN and TIGER only) and `hub.py`. The author reports bit-for-bit CPU parity with the official package (6 of 6) and CUDA parity with deterministic algorithms (4 of 4) (VERIFICATION.md L22–54).
- **Risk scan.** A grep over every `.py` outside `tests/` for `requests`, `urllib`, `subprocess`, `eval(`, `exec(`, `pickle`, `torch.load`, `trust_remote_code`, `socket`, `os.system`, `Popen`, `importlib` and `hf_hub` finds nothing in the node code or the vendored code. Hits are only in tools a person runs: `tools/download_model.py` (`hf_hub_download`), `scripts/ci_queue_check.py` (starts a ComfyUI, talks to 127.0.0.1), `scripts/queue_client.py` (talks to a ComfyUI URL), `scripts/export_gui_workflows.py` (refuses anything but `http://127.0.0.1:`). `scripts/`, `tests/` and `.github/` are left out of the Registry zip by `.comfyignore`. `tiger.py` would import `fla` only for a config with `use_fla: true`; the released config has false. The `config.json` is passed straight into the model constructor (`runtime.py` L60): a tampered config could only raise an error; no code-execution path was seen.
- **The Comfy Registry flags it.** [api.comfy.org/nodes/dbs-soundtrack-separation](https://api.comfy.org/nodes/dbs-soundtrack-separation): created 2026-10-19, 12 downloads, 46 GitHub stars; its only version, 0.1.0, has status `NodeVersionStatusFlagged`, and the reason is not public. The Registry's `node.zip` was listed and hashed without being extracted: its files match the git tree at `f656e53`. Fuobe installs packs by pinned `git clone` (`install-comfyui.sh` `NODES`), so the flag does not block it, but it is a trust signal to record next to the pin.

### 4.3 The pack's example workflows

| Workflow (`workflows/api/…`, GUI copies in `workflows/gui/`) | Graph |
|---|---|
| `separate_soundtrack.json` | `LoadAudio`(soundtrack.wav) → `DBSLoader`(DBS-TIGER-DnR, auto) → `DBSSeparate`(mono, 44100) → 3 × `SaveAudioAdvanced` flac (`dbs/music`, `dbs/sfx`, `dbs/speech`) + `PreviewAny`(report) |
| `remove_dialogue.json` | `LoadAudio` → `DBSLoader` → `DBSSeparate`(each channel, input) → `AudioMerge`(music, sfx, add) → `SaveAudioAdvanced` `dbs/music_and_effects`; speech → `SaveAudioAdvanced` `dbs/dialogue`; `PreviewAny` |
| `video_remove_dialogue.json` | `LoadVideo`(clip.mp4) → `GetVideoComponents` → `DBSSeparate`(each channel, input) → `AudioMerge` add → `CreateVideo`(images, fps, audio) → `SaveVideo` `dbs/no_dialogue`; dialogue → FLAC; `PreviewAny` |

**Do not reuse the video graph.** `GetVideoComponents` decodes every frame into an `IMAGE` tensor and `CreateVideo` / `SaveVideo` encode the picture again: lossy, and memory grows with length. My arithmetic, with float32 frames: about 25 MB per 1080p frame, about 45 GB for one minute at 30 fps, far over the host's 14.3 GB. Fuobe already reads a video's sound with `LoadAudio` (`src/server/providers/comfyui.ts` L864) and puts sound back with stream-copy graphs (`video-mux-audio`, `video-mux-audio-replace`, `scripts/comfy/library.spec.mjs` L2400–2428: `Concatenate Video` with `complete_audio` copies the video packets and encodes only the new soundtrack).

### 4.4 The graphs Fuobe would build

All hand-built (`scripts/comfy/hand-built/`), with only `DBSLoader`, `DBSSeparate` and core nodes. Stems are saved as FLAC with `SaveAudioAdvanced` (`format: "flac"`), so they still add up to the source after saving. Stem names follow Fuobe's chain vocabulary: `voice` (the dialogue), `music`, `effects`, `background` (music and effects together).

**A. `separate-soundtrack-dbs`** (capability `separate-audio`). The one graph behind Split soundtrack, Remove dialogue, Clean up dialogue and the "Original sound" choices.

| id | class | inputs |
|---|---|---|
| 1 | `LoadAudio` | `audio` ← binding `audio` (an audio file or a video; `LoadAudio` decodes a video's soundtrack without frames) |
| 2 | `DBSLoader` | `model` ← binding `separationModel` (default `DBS-BSRNN-DnR`), `device` `auto` |
| 3 | `DBSSeparate` | `model` [2,0], `audio` [1,0], `channels` ← binding `channels` (default `mono`), `output_sample_rate` `input` |
| 4 | `AudioMerge` | `audio1` [1,0] (the original), `audio2` [3,2] (speech), `merge_method` `subtract` → **background** |
| 5 | `SaveAudioAdvanced` | [3,2], `filename_prefix` `fuobe/dbs/voice`, `format` flac → output stem `voice` |
| 6 | `SaveAudioAdvanced` | [3,0], `fuobe/dbs/music` → stem `music` |
| 7 | `SaveAudioAdvanced` | [3,1], `fuobe/dbs/effects` → stem `effects` |
| 8 | `SaveAudioAdvanced` | [4,0], `fuobe/dbs/background` → stem `background` |
| 9 | `PreviewAny` | `source` [3,3] → text output, role `report` (speed and windows for the job's details) |

Why the background is "original minus speech" (node 4) and not "music plus effects": with `channels: mono` it keeps the original stereo image (§2.1); with `each channel` it equals music + effects in every channel anyway (the sum is exact). Output order puts `voice` first, so a chain without a `stem` takes the dialogue (`pickOutput`, `src/server/generations.ts` L777–789). Defaults: `DBS-BSRNN-DnR` and `mono` on CPU hosts; `DBS-TIGER-DnR` and `each channel` are worth it on CUDA hosts, where they still run well over 10x real time (§2.4). Fuobe can tell which host it has from `GET /system_stats` `devices[0].type` (ComfyUI `server.py` L783–796; Fuobe already reads `devices[0]` at `comfyui.ts` L1530). For more than 2 channels, use `each channel` or down-mix first, because node 4 would take the speech out of the LFE and surround channels too. *As built (D1 fixes):* `each channel` can't be used there: ComfyUI's audio save (`comfy_api/latest/_ui.py`, `AudioSaveHelper`) writes any waveform with more than one channel as "stereo", so a 4 s 5.1 stem came out on the worker as 12 s of scrambled stereo. A file with more than 2 channels is split in `mono`, and node 4 becomes music + effects (`AudioMerge` add): every stem is mono and valid.

**B. `dub-prepare-dbs-transcribe`** (capability `separate-audio`). Same output contract as today's `dub-prepare-separate-transcribe` (`library.spec.mjs` L2239–2262: stems `voice` and `background`, text `cues`, `transcript`, `language`), so the open dub only changes its model id.

| id | class | inputs |
|---|---|---|
| 1 | `LoadAudio` | binding `audio` |
| 2 | `DBSLoader` | binding `separationModel`, default `DBS-BSRNN-DnR` |
| 3 | `DBSSeparate` | `mono`, `input` |
| 4 | `AudioMerge` | original − speech → background |
| 5 / 6 | `SaveAudioAdvanced` | voice ([3,2]) → stem `voice`; background ([4,0]) → stem `background` |
| 7 | `AILab_Qwen3ASRSubtitle` | `audio` [3,2]; the same settings as node 7 of the existing graph (Qwen3-ASR 1.7B + ForcedAligner 0.6B; bindings `sourceLanguage`, `asrModel`, `hints`, `maxChars`) |
| 8 / 9 / 10 | `SaveText` / `SaveText` / `PreviewAny` | cues, transcript, language |

Honest expectation: the separation half becomes CPU-friendly (23 MB instead of the 0.46 GB MelBand RoFormer), but Qwen3-ASR stays in the graph, so the 8 GB listing and the ~5.9 GB first-run ASR download remain (`library.spec.mjs` L2255–2259). *As built (D3):* as in this table, with both DBS models required (as in graph A) and the provider's surround rule (a file with more than 2 channels gets its background from music + effects). Validated on the CPU ComfyUI; a real CPU run of a 12 s clip (LibriSpeech speech over chords and noise bursts, `asrModel` Qwen3-ASR 0.6B) took 133 s including the ASR load, the voice and background added back to the source within 3.0e-5, and the transcript was right. The full open dub after it (local LLM translation, Chatterbox, InfiniteTalk) was not run here.

**C. `soundtrack-remix-dbs`** (capability `separate-audio`, one output). For server-side remixes (Assist, MCP, Canvas, a video Remix) where the browser mixer is not in the loop.

| id | class | inputs |
|---|---|---|
| 1–3 | `LoadAudio`, `DBSLoader`, `DBSSeparate` | as in A, binding `channels` |
| 4 / 5 / 6 | `AudioAdjustVolume` × 3 | `volume` ← bindings `voiceDb`, `musicDb`, `effectsDb` (INT, −100…100) on speech, music, sfx |
| 7 / 8 | `AudioMerge` add × 2 | voice + music, then + effects |
| 9 | `SaveAudioAdvanced` | → output `audio` (role `mix`) |

`AudioMerge` scales the whole mix down when it peaks over 1.0 (§2.1), which acts as a crude safety limiter; the level then differs from the dB asked for. With `channels: mono` the mix is mono: for a stereo video, prefer `each channel`, or the two-stem route below.

**Video jobs need no new graph.** Remove dialogue is a two-step chain: graph A on the video, then the existing `mux` op. "No dialogue": `video-mux-audio-replace` with the `background` stem. "Dialogue only": the same with the `voice` stem. "Lower the music": `video-mux-audio` with `audio` = voice, `audio2` = background and `backgroundVolumeDb` (the provider already picks between the two mux graphs). The picture is stream-copied in every case. *As built (D2):* the "Lower the music" mux waits on the one split twice (voice into `audio`, background into `audio2`), which `createPipeline` now allows when each slot names its own stem. Verified on the CPU ComfyUI with a 15 s H.264 + AAC stereo clip, all three outcomes: the result's video packets hash the same as the source's (ffmpeg `framemd5` with `-c copy`), voice + background add back to the decoded source within 3.1e-5 (16-bit FLAC), the new AAC soundtrack correlates 0.997–0.998 with the stem (or voice + bed at −12 dB) it was made from, and the split ran at 0.28x real time (54.5 s) with each mux about 1–2 s.

### 4.5 Library tooling changes

- **Install pin.** Add `[ComfyUI-DBS]="https://github.com/hiroki-abe-58/ComfyUI-DBS f656e53434b5485c148a2866fbd6ddc6b6152ed6"` to `NODES` in `scripts/comfy/install-comfyui.sh` (L15–34), with a comment that the Registry flags 0.1.0 and the code was read at this commit. No extra Python packages. The weights are small enough to fetch in the same script: an opt-out block (`DBS_WEIGHTS=0` skips it) that downloads the 4 files of §3.1 at the pinned revisions into `models/dbs/<name>/` and checks them with `sha256sum -c`.
- **Folder models.** `build-library.mjs` finds models only through `LOADER_FOLDERS[class][input]` or a file-name extension on a widget value (L31–48, L306–334). `DBSLoader.model` is a name with no extension, so the builder would neither list nor flag the DBS weights, and the Workflows page's missing-model help (`src/app/api/comfyui/route.ts`, `src/components/workflows-view.tsx` L43) would not know them. Fix: `KNOWN_MODELS` entries keyed by the path under the folder (`'DBS-BSRNN-DnR/model.safetensors': { folder: 'dbs', url }`, and the same for `config.json` and the TIGER pair) plus a new spec field, say `requiredModels: [...]`, handled next to the existing `optionalModels` loop (L335–346); TIGER goes in `optionalModels`. Presence then works as it is: with the pack loaded, ComfyUI registers the `dbs` folder with no extension filter (`folder_paths.py` L398, L445–446), so `GET /models/dbs` lists `DBS-BSRNN-DnR/config.json` and `DBS-BSRNN-DnR/model.safetensors`, which `/api/comfyui` matches by file string. (A Windows ComfyUI would list back-slashed paths; a minor gap.) *As built (D1):* the TIGER pair is in `requiredModels` too, because a CUDA host runs DBS-TIGER by default and the Workflows page's install commands skip optional files; the provider also reads `GET /models/dbs` (back slashes included) and never queues a model that isn't on disk.
- **Packs not on the validation server.** Use the existing `packs: ['ComfyUI-DBS']` field with a `PACK_CLASSES` entry `/^DBS(Loader|Separate)$/` (`library.spec.mjs` L140–143 and L2809; `build-library.mjs` L260–262), like the H3 entries. Add `CUSTOM_NODE_REPOS['ComfyUI-DBS']` (L110–136).
- **Bindings.** Add `separationModel`, `channels`, `voiceDb`, `musicDb` and `effectsDb` to `BINDING_KEYS` (`build-library.mjs` L96ff) and to the spec header, and teach `src/server/providers/comfyui.ts` to fill them from `params`.
- **Validation.** `validate-workflows.mjs` only POSTs `/prompt` and deletes the job (L9–20), and it creates zero-byte placeholders for missing models (L111–113, L190). DBS's combo is fixed, so placeholders are not needed to validate, and nothing checks that the real weights exist: only a run would catch a missing file, at `DBSLoader`.

### 4.6 What this machine can and cannot verify

- **Can:** unit tests; build-library on the spec; a static check of the core nodes against `/object_info` on the shared server; and, because DBS is tiny and runs on a CPU, **real runs on an isolated worker** where the pack and the 23 MB of weights are installed (`scripts/comfy/install-isolated-worker.sh` pattern, its own `ISO_DIR` and port, never the shared server at 8188). That worker can validate the graphs (`COMFYUI_URL=http://127.0.0.1:<port> node validate-workflows.mjs …`), run them on short clips and measure the speed this 4-core host really gets.
- **Cannot:** any GPU timing; quality on real films without a listening panel; paid SAM Audio, Demucs or veed calls without a key and a budget.

## 5. Running it outside ComfyUI

Yes, the models run outside ComfyUI, but every route is new plumbing for Fuobe.

1. **The weights** are plain F32 safetensors plus `config.json` in the Hugging Face `PyTorchModelHubMixin` layout. There is no ONNX file and no export path in upstream, the cards or the pack.
2. **A Python sidecar** (proven code, new seam). `dbs_comfy/runtime.py` calls itself "DBS separation without ComfyUI"; its only ComfyUI import is `comfy.audio`, loaded lazily for non-44.1 kHz input (L102–107), which torchaudio or `ffmpeg -ar 44100` can replace. It needs torch (CPU), safetensors, einops, the vendored Apache-2.0 subset (77,643 bytes of `.py`) and the weights. Fuobe's app server never starts processes (`git grep` for `child_process`, `spawn(`, `execFile`, `execa`, `fluent-ffmpeg` in `src/` finds nothing; all compute goes to ComfyUI or hosted APIs), so a product sidecar would add a runtime, process management and an audio decoder. **Not worth it as a product path** while ComfyUI does this in two nodes.
3. **For evaluation it is cheap.** Fuobe's eval harness already has a uv venv with torch 2.14.1+cpu and safetensors 0.8.0 (`scripts/eval/metrics/requirements.txt` L73, L83); only einops is missing. The harness has no separation metric yet (`fuobe_metrics` covers CLIP, aesthetics, flow, lip-sync and audio-envelope maths).
4. **ONNX for onnxruntime-node or -web** (feasible, unverified; my analysis). ONNX has STFT (opset 17) but no complex tensors and no ISTFT, so an export would wrap the network core: real and imaginary spectra in, masked spectra out, with STFT / iSTFT (n_fft 2048, hop 512, Hann, torch `center=True` reflect padding) and overlap-add in JavaScript. Patches needed: TIGER calls `torch.stft` / `torch.istft` inside `forward` (`tiger.py` L651, L679) and builds `torch.complex` in `FreqDechunker` (L526); BSRNN's `TokenMaskDecoder` uses `view_as_real` and `torch.complex` (`modules/dbs.py` L315, L332). Op coverage: Hard Top-K → `TopK` (fixed k per region), `cumsum` → `CumSum`, `gather` → `GatherElements`, `scatter_add_` → `ScatterElements` add (opset 16+), `scatter_reduce_` amax with `include_self` → `ScatterElements` max (opset 18+; whether `torch.onnx` exports it cleanly is a guess), bidirectional LSTMs (`tiger.py` L280, `modules/dbs.py` L113), grouped and dilated convolutions, nearest interpolation, softmax. Windows are mostly fixed (TIGER 264,600 samples / 517 frames; BSRNN 132,300 / 259), but clips between half a window and one window run unpadded (`inference.py` L32–34): a port must support that length or always pad, which gives slightly different output from the official code. Parity can be checked the way the pack's `tests/test_parity.py` does.
5. **In the browser** (P2, the heaviest). The browser already decodes and resamples to 44.1 kHz (`decodeAudioData`, `OfflineAudioContext`). The rest would be new: JS STFT → onnxruntime-web (WASM SIMD with threads, or WebGPU) → JS iSTFT → WAV. Model sizes 4.1 MB (TIGER) and 18.9 MB (BSRNN); fp16 would be about half (a guess). Compute is 31.6 G and 124 G MACs per second of audio: guess, minutes per minute of audio on WASM. Whether ORT-web's WebGPU provider covers LSTM and `ScatterElements` max is unknown.
6. **What the browser can do today with no model:** a live stem mixer (per-stem gain, solo and mute, export with `OfflineAudioContext`) that works whichever engine made the stems. That is part of package D1.

## 6. Cloud routes

**No hosted DBS exists.** A re-run of fal's model search (keywords separation, separate, stem, stems, isolation, dialogue, roformer, demucs, vocal, audio-to-audio; 2026-10-29) returned SAM Audio (3 endpoints), Demucs, ElevenLabs isolation, DeepFilterNet 3 and veed/clean-audio, and no dialogue/music/effects model. Replicate's search page is rendered in the browser and could not be checked; a web search found no Replicate model for this.

| Provider / endpoint | What it gives | Inputs (exact) | Price | In Fuobe today |
|---|---|---|---|---|
| fal **`fal-ai/sam-audio/separate`** | Meta SAM Audio, prompted: `target` (what the prompt names) and `residual` ("everything else"), 48 kHz by default | `audio_url`* (WAV, MP3, FLAC), `prompt`* ("speech", "piano playing"), `predict_spans` (false), `reranking_candidates` 1–7 (1), `acceleration` fast\|balanced\|quality (balanced), `max_chunk_duration` 10–60 s (60), `chunk_overlap` 0–30 s (5), `output_format` wav\|mp3 (wav) | **$0.05 per 30 s of output audio**, +$0.025 per 30 s per extra reranking candidate | researched (`paid-model-apis-3.md` L369), not in the catalog; `STEM_ALIASES` already maps target → voice and residual → background (`generations.ts` L764–767) |
| fal `fal-ai/sam-audio/visual-separate` | the same, with a video and an optional mask video (black = target) | `video_url`*, `mask_video_url`, `prompt` (""), `reranking_candidates` 1–4, `acceleration`, `max_chunk_duration`, `chunk_overlap`, `output_format` | $0.05 per 30 s of output | no |
| fal `fal-ai/sam-audio/span-separate` | the same, guided by time spans | `audio_url`*, `spans`* [{start, end, include}], `prompt`, `reranking_candidates` 1–7, `use_sound_activity_ranking`, `trim_to_span`, `acceleration`, `max_chunk_duration`, `chunk_overlap`, `output_format` | $0.05 per 30 s of output | no |
| fal `fal-ai/demucs` | music stems: vocals, drums, bass, other (+ guitar, piano with `htdemucs_6s`) | `audio_url`*, `model` (8 choices, default `htdemucs_6s`), `stems`, `segment_length`, `shifts` 1–10, `overlap` 0–1, `output_format` mp3\|wav | "$0.0007 per seconds" (audio or compute seconds is not said; Fuobe assumes audio: $0.042/min) | yes, `demucs`, fixed to `htdemucs` (`scripts/gen-cloud-models.py` L886–887) |
| fal `fal-ai/elevenlabs/audio-isolation` | the isolated voice only, no background | `audio_url` or `video_url` | $0.10 per minute | yes, `elevenlabs-voice-isolation` (L895–896) |
| fal `fal-ai/deepfilternet3` | one denoised speech track (speech enhancement, not separation) | audio | $0.001 per second | no |
| fal `veed/clean-audio` | one cleaned speech track, 48 kHz, loudness-normalized; audio or video up to 30 min | `audio_url`*, `strength` | $0.0125 per minute of input, rounded up, 1-minute minimum | researched (`paid-model-apis-3.md` L370), not in the catalog |
| Replicate `ryan5453/demucs` | Demucs v4/v3/v2 music stems | | about $0.0062 per run (page estimate; hardware text says A100, the page's JSON says A40) | no |
| Replicate `cjwbw/demucs` | older Demucs: drums, bass, vocals, other | | about $0.0087 per run on a T4 (page estimate) | no |
| Replicate `geopti/sam-audio-large` | community SAM Audio wrapper | `audio`*, `description` ("speech"), `use_span_prompting`, `span_anchors`, `predict_spans`, `output_residual` (false) | about $0.063 per run on an L40S (page estimate, ~65 s per run) | no |
| HF Space `JusperLee/DBS-Demo` | the only hosted DBS: music, sfx, speech WAVs + boundary JSON | Gradio `api_name="separate"`: upload, window, hop, model, language | free within the visitor's ZeroGPU quota; queue of 4, one at a time | not suitable as an engine |
| AudioShake API (no fal / Replicate listing) | `dialogue`, `effects`, `music_fx` (music + effects), `music_removal` (speech + effects) | | 1.5 credits/min (dialogue, effects, music_fx), 10 credits/min (music_removal); the dollar price per credit is not public | no (a new provider and key) |

**Three stems in the cloud: two SAM Audio passes** (my proposal; fal does not document it). Pass 1, prompt "speech": target = dialogue, residual = music and effects. Pass 2 on that residual, prompt "music": target = music, residual = effects. One "speech" pass alone already gives the music-and-effects bed a dub or "remove dialogue" needs.

**Price per minute.** One pass: $0.10, or $0.20 if fal counts both the target and the residual as output (the page does not say). Two passes: $0.20–0.40. Fuobe should show the range until a real bill settles it. Demucs: $0.042 per minute if billed per audio second. How well "music" against "sound effects" separates by prompt is undocumented.

**Self-hosting DBS** on a Replicate Cog model or a fal serverless app under the user's account is possible (CPU is enough; guess, well under $0.01 per audio minute) but is not a listed endpoint, and Fuobe's cloud engine uses only listed endpoints.

## 7. How it compares to what Fuobe uses today

### 7.1 What Fuobe has today

Fuobe has no three-stem (dialogue / music / effects) separation anywhere. It has a voice-against-background split for dubbing and Demucs music stems in the cloud.

- **The operation.** `separate-audio`: "audio or video → voice and background stems" (`src/lib/catalog/types.ts` L59), labelled "Separate voice" (L126), output kind audio (L193); plan check "Add the audio or video to split" (`plan.ts` L492). Hosted answers are tagged per file with `meta.stem` and sorted by `STEM_ORDER` (`payload.ts` L822–834); music, sfx and effects are not in that list, so they sort last. Chains pick stems in `src/server/generations.ts` L764–789: `STEM_ALIASES` voice = voice | vocals | speech | target, background = background | accompaniment | instrumental | residual | no_vocals; any other stem name must match exactly. So DBS's "speech" already satisfies `voice`; "music" and "sfx" can be asked for by name; but "background" never matches music or sfx, which is why graph A outputs a merged `background`. `types.ts` L894–898 (`ChainSlot.stem`) and `src/lib/av/dub.ts` L159–160 (`VOICE_STEMS`, `BACKGROUND_STEMS`) repeat these lists. The demo provider returns only voice and background (`src/server/providers/mock.ts` L287–297).
- **Cloud models** (`scripts/gen-cloud-models.py` L886–896): `demucs` (fal, `htdemucs`, $0.0007/s), `extract-soundtrack` (hidden, $0.0002/s of compute), `elevenlabs-voice-isolation` ($0.10/min).
- **Open model** `oss-voice-separate`, "MelBand RoFormer + Qwen3-ASR" (`src/lib/catalog/models.ts` L1113–1124), workflow `dub-prepare-separate-transcribe` (`library.spec.mjs` L2239–2262): `LoadAudio` → MelBand RoFormer (`MelBandRoformer_fp16`, 0.46 GB, MIT; a vocals/instrumental model) → two MP3 stems, plus Qwen3-ASR on the vocals. `vramGb` 8 covers separation and ASR together.
- **Translate & dub** (`src/lib/av/dub.ts`, `src/server/dub.ts`, `src/components/dub/dub-studio.tsx`). Cloud (L41–59, L144–153): ElevenLabs isolation gives the voice to clone, Scribe v2 transcribes it, `extract-soundtrack` then Demucs give the background (every stem but vocals), each background stem is lowered by `BACKGROUND_DB` = −3 with fal loudnorm in linear mode (L61–70), and a failed background split leaves a voice-only dub (`OPTIONAL_PREPARE`, L157). Open: `oss-voice-separate`, then `oss-mux` of the new voice over the background stem.
- **Hubs.** Audio (`src/lib/hubs.ts` L16–27): Speech, Dialogue, Voice change, Translate, Transcribe, Sound effects, Music, Loop / extend, Join, Sound for video; no split mode. Video tools (L28–37): Remove background, Remove object, Relight, Depth map, Captions, Trim, Join clips, Match colors; no sound tools. Tool modes are registered in `TOOLS` (`src/components/studio/mode-switch-studio.tsx` L56–67); the audio tools API is a zod union on `tool` (`src/server/audio-tools.ts` L24) behind `/api/audio-tools` (`?preview=1` plans and prices).
- **Studios that put a clip's sound back** with a stream-copy mux: Shorts (`src/lib/catalog/shorts.ts` L694–764), Mixed Media (`mixed-media.ts` L709–747, L869–878), Character Swap Studio ("Put the clip's sound back", `swap-studio-plan.ts` L540–549), Genjutsu (`genjutsu.ts` L1034) and Remove object (`remove-object.ts` L632). Faceless mixes a generated bed (`faceless.ts` L572–626).
- **Canvas:** one output handle `OUT` per node (`canvas.ts` L457); `separate-audio` takes audio or video (L501). **Assist:** `src/server/assist/tools.ts` documents `separate-audio` (L93, L254–259) and `background_audio` as "the background stem from separate-audio" (L260).
- **Eval harness:** no separation or dub cases and no separation metric (`scripts/eval/cases/`, `scripts/eval/metrics/fuobe_metrics/`).

### 7.2 Side by side

| Job | Fuobe today, open | Fuobe today, cloud | With DBS (open) | Cloud with this research |
|---|---|---|---|---|
| Dialogue / music / effects, three stems | none | none | **DBS**, one job, 23 MB of weights, CPU or GPU | **SAM Audio × 2**, $0.20–0.40/min |
| Voice against music-and-effects (dub, remove dialogue) | MelBand RoFormer, a vocals model: singing goes with the voice | ElevenLabs isolation (voice only) + extract + Demucs (vocals against drums/bass/other) | **DBS**: singing stays in music, effects stay in the bed | **SAM Audio "speech"**: target and residual in one call |
| Music stems (drums, bass, …) | none | Demucs | not DBS's job | Demucs |
| Clean up speech (noise, hiss) | none | ElevenLabs isolation | DBS removes music and effects; steady noise is unmeasured (§11) | veed/clean-audio, DeepFilterNet 3, ElevenLabs isolation |
| Weights / price | MelBand 0.46 GB | $0.042–0.10/min | 4.1 MB or 18.9 MB | $0.10–0.40/min |

There is no shared benchmark between DBS, MelBand RoFormer, Demucs and SAM Audio. DBS is the only one of them trained for film-style dialogue, music and effects; the others were built for music or for prompted isolation. Package D4 measures them on the same clips before any default changes.

## 8. Where it goes in Fuobe and why

DBS goes where users already handle sound, on both engines wherever a route exists.

| Where | What the user gets | Open engine | Cloud engine | Why | Priority |
|---|---|---|---|---|---|
| **Audio hub → Split soundtrack** (`/audio/split`) | Drop a song, podcast, film clip or video; get tiles for Dialogue, Music, Effects and Music & effects with play, solo, mute, level and download; presets; a free live mixer; export; "Put back on the video" | graph A on `oss-dbs-separate` | `sam-audio-separate` two passes; Demucs as "voice and background" fallback | The exact ask: remix and clean up any soundtrack. Nothing like it exists in Fuobe. | P0 (D1) |
| **Video tools → Remove dialogue** (`/video-tools/remove-dialogue`) | No dialogue / Dialogue only / Lower the music, on a video; picture untouched (stream copy); the removed stem as a download | graph A → `video-mux-audio(-replace)` | extract → SAM "speech" → `merge-audio-video` (compose for "lower") | Re-voicing, B-roll beds, posting without speech; one click from any video result | P0 (D2) |
| **Translate & dub** | The dub keeps the original score and effects where they were; only the voice changes | `dub-prepare-dbs-transcribe` as a choice next to MelBand | one SAM "speech" call replaces extract + Demucs (one bed, one loudnorm); Demucs stays as fallback | Today's open split is a vocals model and the cloud split scatters effects and pulls singing out with the dialogue | P0 (D3) |
| **Eval harness** | A separation suite: SI-SDR on synthetic mixes, ASR WER on the voice stem, blind A/B, speed on this host | DBS-TIGER vs DBS-BSRNN, mono vs fast stereo vs each channel, DBS vs MelBand | SAM Audio vs Demucs | Decides every default above with numbers instead of guesses | P1 (D4) |
| **Clean up dialogue** (Audio hub, also on video) | Clear speech from a noisy or musical recording: keep the dialogue, drop or lower the rest, optionally denoise | DBS voice (+ bed at −18 dB) | veed/clean-audio or DeepFilterNet 3; ElevenLabs isolation | The owner's "cleaning up audio" | P1 (D5) |
| **Transcribe, Captions, Lipsync, Genjutsu transcribe, Swap Studio transcript** | "Clean the voice first": tighter transcripts and lip sync; after lipsync the music and effects go back | DBS voice before Qwen3-ASR / InfiniteTalk / LatentSync; `video-mux-audio` after | ElevenLabs isolation (in the catalog); SAM residual to put the bed back | Music under speech hurts ASR and lip sync | P1 (D6) |
| **Shorts, Mixed Media, Genjutsu, Remove object, Character Swap Studio, Faceless** | "Original sound": Everything / Music & effects only / Dialogue only / Lower the music; Faceless "Use a clip's soundtrack as the bed" | DBS before the existing stream-copy mux | SAM "speech" before compose + merge; `visual-separate` with the studio's SAM mask to remove one person's voice (cloud only) | When a person is swapped or removed, their speech should usually go too | P1 (D7) |
| **Canvas** | A Split soundtrack node with Dialogue, Music, Effects and Music & effects handles | `oss-dbs-separate` | `sam-audio-separate` / `demucs` (a handle a model cannot fill is disabled with a reason) | Wire stems into Transcribe, Change voice, a concatenator or a mux | P1 (D8) |
| **Assist and MCP** | "Remove the dialogue from this video", "give me just the music", "dub this but keep the score" | `split_soundtrack`, `remove_dialogue` tools on `oss-dbs-separate` | same tools on SAM / Demucs, priced first | One sentence does it | P1 (D9) |
| **On this device (beta)** | Split a short clip in the browser, nothing installed, no key | ONNX + onnxruntime-web | n/a (falls back to the cloud) | No ComfyUI and no key needed; unverified | P2 (D10) |

Settings → Models & licences, the install script and the demo provider are not placements of their own: they ship with D1.

## 9. Build plan

Packages in priority order. The full brief of each one (goal, exact spots, both engines, UI, tests, browser checks, what this machine can verify, licences) is in the JSON twin, `plan.packages[].brief`; the sections below are the short form. D1 lays the shared ground (pack pin, weights, graph A, the model, the stem names, licences, demo stems, the cloud SAM model); D2–D9 build on D1's commit. Every package: both engines where a route exists and an honest note where one does not; prices shown before running (`?preview=1` or the studio's estimate); tests; a browser check at 1440 px and 390 px in light and dark with no horizontal scroll; `pnpm typecheck`, `pnpm lint`, the targeted tests and the full vitest run; a commit per step.

| # | Package | Priority | Depends on | Effort |
|---|---|---|---|---|
| D1 | Split soundtrack in the Audio hub (and the DBS ground) | P0 | — | large |
| D2 | Remove dialogue for videos (Video tools) | P0 | D1 | small |
| D3 | Translate & dub keeps the score and effects | P0 | D1 | medium |
| D4 | Separation evaluation (scripts/eval) | P1 | D1 | medium |
| D5 | Clean up dialogue | P1 | D1 | small |
| D6 | Clean the voice first (Transcribe, Captions, Lipsync) | P1 | D1 | small |
| D7 | "Original sound" choice in the studios | P1 | D1, D2 | medium |
| D8 | Canvas Split soundtrack node | P1 | D1 | medium |
| D9 | Assist and MCP tools | P1 | D1, D2 | small |
| D10 | On this device (beta): DBS in the browser | P2 | D1 | large |

### D1 · Split soundtrack in the Audio hub (P0)

- **Ground (both engines).** Pin the pack and fetch the weights (§4.5). Hand-build graph A (§4.4) with the spec entry: capability `separate-audio`, bindings `audio`, `separationModel`, `channels`, outputs voice / music / effects / background / report, `requiredModels` (BSRNN pair) and `optionalModels` (TIGER pair), `packs: ['ComfyUI-DBS']`, `vramGb` 0 with a note "CPU OK, ~1.7 GiB on CUDA", `license` "DBS weights Apache-2.0 (JusperLee; trained on DnR v2, CC BY 4.0); ComfyUI-DBS code MIT; vendored DBS code Apache-2.0 with MIT notices". ModelDef `oss-dbs-separate` "DBS (dialogue, music, effects)" in `src/lib/catalog/models.ts` beside `oss-voice-separate` (L1113), tagline "Splits a soundtrack into dialogue, music and effects · 23 MB · CPU or GPU · Apache-2.0". Choose the DBS model by host (`devices[0].type`, §4.4). Stems: add `music: ["music"]` and `effects: ["effects", "sfx"]` to `STEM_ALIASES` (`generations.ts` L764); add `music`, `sfx`, `effects` to `STEM_ORDER` (`payload.ts` L822) after the voice names; update the `separate-audio` comment (`types.ts` L59). `dub.ts`'s own lists (L159–160) already accept DBS's `voice` and `background`. Demo: `mock.ts` L287–297 returns four stems (voice, music, effects, background) for DBS and for the cloud split. Licences: a `NODE_PACKS` row (`licences.ts` ~L406). Cloud model `sam-audio-separate` from the research row through `scripts/gen-cloud-models.py` (fal `fal-ai/sam-audio/separate`; fields `audio_url`, `prompt`, `output_format` wav, `acceleration`; price $0.05 per 30 s of output with the "both outputs may be billed" note).
- **Tool.** `{ id: "split", label: "Split soundtrack" }` in `HUB_MODES.audio` (`hubs.ts`, after Transcribe), `TOOLS.audio.split` (`mode-switch-studio.tsx` L56), planner `src/lib/av/split.ts`, a `split` variant in `AudioToolBody` (`src/server/audio-tools.ts` L24) and `/api/audio-tools`. Open: one job on `oss-dbs-separate`. Cloud: pass 1 SAM "speech" → pass 2 SAM "music" on the `background` (residual) stem, relabelled Music and Effects; a cheaper "Dialogue and the rest" (one pass) and Demucs ("Voice / Background, a music model") as choices.
- **UI.** Input: drop or pick audio or video (Library, `?audio=` / `?video=`). Options: engine; open "Fast (DBS-BSRNN) / Best (DBS-TIGER)" with the host's pick preselected and "Stereo stems (takes about twice as long)"; a time estimate on the open engine and a price on the cloud. Result: four stem tiles (waveform, play, solo, mute, level −24…+6 dB, Download, in the Library), presets No dialogue / Dialogue only / Music only / Music under dialogue (−12 dB), a live WebAudio mixer, Export mix (OfflineAudioContext → WAV → Library), and for a video source "Put back on the video" (open `video-mux-audio-replace`, cloud `merge-audio-video`). Next-step chip "Split soundtrack" on audio and video results (`src/lib/output-actions.ts` L105–131, `NEXT_STEPS` L165–166).
- **Tests.** Planner per engine and option; prices; stem aliasing and ordering; mock stems; manifest entry, pins and folder models; licence row; mixer maths (dB → gain, presets).
- **Verify here.** Build and validate on an isolated worker with the pack; real CPU runs of 10–30 s clips there; record the measured speed in the doc's §2.4.

### D2 · Remove dialogue for videos (P0)

`{ id: "remove-dialogue", label: "Remove dialogue" }` in `HUB_MODES["video-tools"]` and `TOOLS["video-tools"]`; outcomes No dialogue (default) / Dialogue only / Lower the music (slider, default −12 dB). Open: graph A → the `mux` op (§4.4, no new graph). Cloud: `extract-soundtrack` → SAM "speech" → `merge-audio-video` (No dialogue: residual; Dialogue only: target; Lower: `ffmpeg-loudnorm` linear on the residual, which can only lower, then `compose-timeline`-style mix, then merge). The removed stem is kept as a second output. A "Remove dialogue" chip on video results. Tests: plans, chain stems, mux choice, prices. Browser: before/after players at both widths.

### D3 · Translate & dub keeps the score and effects (P0)

Open: graph B `dub-prepare-dbs-transcribe` and ModelDef `oss-dbs-voice-separate` "DBS + Qwen3-ASR"; a "Voice split" choice in Dub studio (DBS / MelBand RoFormer), default unchanged until D4 reports. Cloud: replace `sound` + `background` (extract + Demucs, three beds) in `prepareSteps` (`dub.ts` L116, cloud branch L144–158) with extract + `sam-audio-separate` prompt "speech": one bed (`residual`), one loudnorm at `BACKGROUND_DB`, one compose track; Demucs stays the fallback (`OPTIONAL_PREPARE`). Keep ElevenLabs isolation for the clone voice. Copy: "Keeps the music and sound effects of the original". Tests in the dub suites. *As built:* the open half only. SAM Audio is not used on the cloud, so the cloud dub keeps extract + Demucs (three beds) unchanged and the studio says what Demucs does ("Music model: some sound effects may be lowered, and singing may be replaced"); the SAM Audio step and a Background split setting wait on that decision.

### D4 · Separation evaluation (P1)

A `separation` metric family in `scripts/eval/metrics/fuobe_metrics` (SI-SDR and SDR per stem, mixture-consistency check, peak and level of the bed, ASR WER of the voice stem against the known text), synthetic test mixes built from licensed or generated material (Fuobe TTS speech, generated music and effects) with known stems, cases in `scripts/eval/cases/separation.json` (DBS-TIGER, DBS-BSRNN, mono / fast stereo / each channel, MelBand, Demucs, SAM Audio), the existing blind A/B page for real clips, and a speed record on this host. Outputs decide D1's and D3's defaults.

*As built (D4, 2026-11-02).* The `separation` and `wer` metric families (`scripts/eval/metrics/fuobe_metrics/separation.py`), the generated suite `scripts/eval/cases/separation.json`, test mixes from `scripts/eval/fixtures/make-separation.py` (12 s, 44.1 kHz stereo; speech: LibriSpeech dev-clean speaker 1272, CC BY 4.0, because no TTS weights were on this host; music, effects, hum and hiss synthesized by the script, CC0), Whisper base.en for WER (`pnpm eval:setup --asr`), audio players in the report and the blind review (dialogue and music & effects judged as separate pairs). Two real runs on the 4-CPU ComfyUI through a running Fuobe; the cloud variant (Demucs) was planned only (no key), and SAM Audio is not in the suite (`samAudioCloud` false). Means over the six mixes unless named (SI-SDR in dB; WER by Whisper):

| Setting | Dialogue | Music | Effects | Music & effects | Bed stereo gap | Dialogue WER (input as is) | Wall for 12 s |
|---|---|---|---|---|---|---|---|
| DBS-BSRNN, mono (fast stereo bed) | 14.7 | 8.2 | 3.3 | 9.6 | 0.146 | 0.105 (0.117) | 48 s |
| DBS-BSRNN, each channel | 14.4 | 9.0 | 4.1 | 11.2 | 0.027 | 0.152 | 93 s |
| DBS-TIGER, mono | 16.1 | 10.5 | 3.5 | 10.9 | 0.138 | 0.154 | 116 s |
| DBS-TIGER, each channel | 15.7 | 10.9 | 3.9 | 12.5 | 0.017 | 0.128 | 227 s |

What the numbers say:
- **DBS-TIGER is better on every mix** (dialogue +1.2 to +2.1 dB, music +2 dB) but 2.4x slower on this CPU: a minute of audio takes 9–10 minutes in mono. Kept: DBS-BSRNN on CPU hosts, DBS-TIGER on CUDA hosts (`dbsModelFor`, unchanged; no GPU here to measure).
- **The fast stereo bed holds for centred dialogue and fails for panned dialogue.** Centred mixes: bed stereo gap 0.03–0.04 and level within 0.6 dB of the known bed (each channel: 0.02–0.04), at half the time. Dialogue panned left: the mono speech subtracted from both channels leaves the left-right difference in the bed (bed SI-SDR 1.0 dB against 11.2 with each channel, gap 0.71, the bed 1.7 dB too loud). Kept: mono by default; "Stereo stems" is the answer for off-centre dialogue (a hint for the tool's copy, not built here).
- **AudioMerge's peak scaling:** the master at −0.1 dBFS left a bed peaking at −7 dBFS (level −0.04 to −0.12 dB), because its peaks were the dialogue's. A second loud master, `loud-bed` (music at −12 and effects at −16 dBFS RMS, the whole mix normalised to −0.1 dBFS), has a known bed that peaks at +0.1 dBFS: it goes over full scale only where the speech pulls the other way (run `20261102-154635-separation-open-8fec`, DBS-BSRNN mono). DBS's bed came out peaking at −0.07 dBFS, and `bedScale` (the bed's gain against input − voice) read 0.00 dB: nothing was scaled. On an input that is already under full scale, the fast bed can only go over by what the dialogue takes away at the loudest moment, here about 0.1 dB, and the model's dialogue stem didn't reach it. The scaling can matter for an input that is itself over full scale (a float WAV, or an AAC decode that overshoots); that isn't measured. Dialogue under a bed this loud is hard for both the model and Whisper (dialogue 7.5 dB, WER 0.58 against 0.50 for the input as is).
- **Where steady noise goes (§11):** a 50 Hz hum goes mostly to music with DBS-BSRNN (72 %; 14 % stays in the dialogue) and to effects with DBS-TIGER (54 %; 18 % in the dialogue); tape hiss splits across effects (49–59 %), music and dialogue (20–31 %). DBS doesn't clean hiss off a voice, as D5 says.
- **Stems add up:** voice + bed match the input to −79 dB (FLAC) on every DBS run; the video source scores as the audio file does.
- **The dub's voice split** (run `20261102-150312-separation-open-32a4`, centre, hum and video, Qwen3-ASR 0.6B in the graph): MelBand RoFormer scored higher than DBS on these mixes (dialogue 14.6–22.1 dB against 14.2–15.4; music & effects 10.2–16.8 against 9.8–10.5; Qwen3-ASR's own transcript WER 0–0.08 against 0.11–0.12), and was slower: the first job of each (centre) also loaded Qwen3-ASR and took 127 s with DBS and 190 s with MelBand; warm, 12 s took 47–49 s with DBS (0.26x real time with the ASR) against 128–133 s with MelBand. The test mixes have no singing and no recorded effects, which is where a vocals model goes wrong, so this decides nothing about films: the dub's default stays MelBand RoFormer (`DEFAULT_VOICE_SPLIT`), and the owner's real clips on the blind review page are the next step.
- **Clean up dialogue (D5, open: graph C at the −18 dB preset;** run `20261102-154635-separation-open-8fec`, centre, hum, hiss and `loud-bed`, DBS-BSRNN mono): the one file scored 15.2–16.6 dB against the voice plus the known bed at −18 dB on the three ordinary mixes (9.4 on `loud-bed`), and Whisper's WER fell where the input was hard (hiss: 0.000 against 0.138 for the input as is; elsewhere the same as the input). But the bed comes out louder than asked: its gain in the file is −12.5 to −12.7 dB, not −18 (−16.7 on `loud-bed`). The dialogue stem itself carries the bed at about −18 dB (measured the same way on graph A's voice stem: −18.0 to −18.3 dB), and graph C adds the bed back at −18 dB on top, in phase, so the two add up to about −12.5. "Dialogue only" leaves that leak at about −18 dB. D5's "a −18 dB bed came out at −17.9 dB" measured the bed against the input music on a different clip; this suite measures the bed's gain in the finished file by least squares against the known voice and bed together. The preset's numbers are not changed here; a person decides, after hearing it, whether the presets should ask for less (by arithmetic, not measured: −24 dB would give about −14.5 dB in the file, "Dialogue only" about −18) or keep the words. A hum is partly put back (25 % of it in the file against 14 % in graph A's dialogue stem), and hiss stays (33 %), as D5 says. The cloud cleaners (VEED Clean Audio, DeepFilterNet 3) are in the suite as dry runs only: no key and no paid call.
- **"Clean the voice first" (D6, not built yet):** Whisper heard the input as is as well as the DBS dialogue stem (WER 0.117 against 0.105–0.154; the speech sits 6 dB over the music here). Separating first helped only with hiss and DBS-BSRNN (0.069 against 0.138). The evidence supports D6's default off for audio-only speech; on video, measure with real clips first.

### D5 · Clean up dialogue (P1)

A "Clean up dialogue" preset in Split soundtrack plus a direct entry in the Audio hub and on videos. Open: DBS voice, optionally the bed at −18 dB (graph C or the browser mixer). There is no open denoiser in Fuobe's research, so the open route removes music and effects but not hiss or hum (say so). Cloud: add `veed/clean-audio` (research row exists) and `fal-ai/deepfilternet3` (needs a research record first) through `gen-cloud-models.py`; ElevenLabs isolation stays. *As built (D5):* a Clean up dialogue task in Split soundtrack (`?preset=clean-dialogue`, a chip on audio and video results) and a Clean dialogue (−18 dB) mixer preset. Open: graph C `soundtrack-remix-dbs` on `oss-dbs-remix` (music and effects at Off / −24 / −18 / −12 dB; Off sends −100 dB), then `oss-mux` for a video. Cloud: `veed-clean-audio` (its `audio_url` takes a video too; fal also lists `veed/clean-audio/video`, which returns the video with the picture copied, not used yet), `deepfilternet3` (audio only: `extract-soundtrack` first for a video; MIT OR Apache-2.0) and ElevenLabs isolation, then `merge-audio-video`; no bed under the cloud voice (`samAudioCloud` false). Main's Clean up voice (RE-USE) is the open denoiser this research did not have; the page points to it. Measured on the CPU ComfyUI with graph C, 15 s mono clips (Mandarin read speech, so outside DBS's English training data): speech under loud music went from −15.2 to −5.1 dB SI-SDR against the clean speech; speech over a 50 + 150 Hz hum with pink hiss went from −1.6 to 5.2 dB, the 50 Hz line about 51 dB lower and 150 Hz about 39 dB lower, hiss above 4 kHz only about 10.6 dB lower; a −18 dB bed came out at −17.9 dB against the input music; DBS-BSRNN ran at 0.36–0.42x real time.

### D6 · Clean the voice first (P1)

A switch "Clean the voice first" in Transcribe (`TRANSCRIBE_STUDIO`, `studios.ts` L259), Captions (Video tools), Lipsync (`LIPSYNC_STUDIO`, L94), Genjutsu transcribe (`src/app/api/genjutsu/transcribe/route.ts`) and the Swap Studio transcript (`src/server/swap-studio.ts` L713). Open: DBS voice (chain `stem: "voice"`) before Qwen3-ASR, InfiniteTalk or LatentSync; after lipsync, `video-mux-audio` puts the `background` back. Cloud: ElevenLabs isolation before Scribe v2 or the lipsync model; the bed back from a SAM residual. Default on for video sources, off for audio-only speech (a guess until D4).

### D7 · "Original sound" choice in the studios (P1)

Shorts (`shorts.ts` L694–764), Mixed Media (`mixed-media.ts` L709–747), Genjutsu (`genjutsu.ts` L1034), Remove object (`remove-object.ts` L632) and Character Swap Studio (`swap-studio-plan.ts` L540–549) get "Original sound: Everything / Music & effects only / Dialogue only / Lower the music". Open: graph A on the working clip, then the existing stream-copy mux with the chosen stem. Cloud: SAM "speech" then compose + merge; for "remove only this person's voice", `fal-ai/sam-audio/visual-separate` with the studio's SAM mask video (cloud only; the open engine has no per-person route). Faceless: "Use a clip's soundtrack as the bed" (DBS background → `oss-audio-loop` → `oss-mux`; cloud SAM residual → loop → compose).

### D8 · Canvas Split soundtrack node (P1)

A `split-soundtrack` utility node in `src/lib/catalog/canvas.ts` (node types L44–62, `PALETTE` L259ff) and `src/components/canvas/nodes.tsx`, with four output handles (Dialogue, Music, Effects, Music & effects) mapped to `ChainSlot.stem` voice / music / effects / background. Multi-handle output is new work: today every node has one `OUT` (L457). A handle the chosen model cannot fill (Demucs has no effects stem) is disabled with a reason.

### D9 · Assist and MCP tools (P1)

`split_soundtrack({ media, keep?: ["dialogue","music","effects"], levels_db? })` and `remove_dialogue({ video, keep?: "dialogue"|"bed", music_db? })` in `src/server/assist/studio-tools.ts`, exposed through `src/server/mcp.ts`, priced with `estimate_job` first; document the new stems in `src/server/assist/tools.ts` L93 and L254–260. Both engines through D1's and D2's planners.

### D10 · On this device (beta): DBS in the browser (P2)

An ONNX export of the network core (§5, item 4) made by a script in the eval venv, a parity test against PyTorch, JS STFT / iSTFT / overlap-add, onnxruntime-web (WASM, WebGPU where it works), an "On this device (beta)" engine in Split soundtrack for clips up to a minute, and real separation in demo mode. Unverified; ship only if parity and speed hold.

## 10. Risks

- **Registry flag.** dbs-soundtrack-separation 0.1.0 is `NodeVersionStatusFlagged` with no public reason. The node code has no network or exec path and the Registry zip matches git at `f656e53`. The pack is new (released 2026-10-19), from one author, with 12 Registry downloads. Pin the commit and record the flag.
- **The pack's video graph** decodes every frame and re-encodes the picture (about 45 GB per minute of 1080p30 at float32, my arithmetic). Use `LoadAudio` plus the stream-copy mux graphs.
- **Domain.** Trained only on synthetic English DnR v2 mixes. Real films, other languages, crowd or shouted speech and songs with vocals are unverified; singing goes to "music".
- **Music against effects is modest** (5.7–7.8 dB). Promise clean dialogue and dialogue-free beds, not a studio-grade music/effects split. Because stems sum exactly to the input, any missed speech stays in the bed (guess: audible in quiet scenes).
- **CPU speed.** DBS-TIGER, the pack's default, runs at 0.49x real time on a 24-thread desktop; Fuobe should default to DBS-BSRNN on CPU hosts. On Fuobe's 4-CPU host, guess 0.3–0.6x real time. `each channel` doubles the time for stereo, 6x for 5.1.
- **Channels.** `mono` collapses stereo stems; the fast stereo bed (§2.1) is a guess until heard; for more than 2 channels it would also take the speech out of the LFE and surrounds. Fuobe's media probe does not read channel counts (`src/lib/media-probe.ts` L22, L152–163); the browser can (`AudioBuffer.numberOfChannels`).
- **`AudioMerge` normalizes peaks** (`nodes_audio.py` L747–749): a bed or remix that peaks over full scale is scaled down as a whole, changing its level.
- **Library tooling.** Without the folder-model change (§4.5) the weights are invisible to install and missing-model help, and validation passes even with no weights.
- **Untested combination.** The pack's CI covers ComfyUI v0.38.0 and v0.42.1 on Python 3.10 and 3.12; Fuobe runs v0.41.0-7 on Python 3.13. The APIs exist; there is no test evidence for 3.13.
- **Devices.** On ROCm `auto` uses the AMD GPU (untested by the pack); offer `cpu` as a fallback setting. CUDA output is not bit-deterministic.
- **Cloud.** No hosted DBS. SAM Audio needs two prompted passes for three stems, returns 48 kHz, and may bill target and residual both; prompted "music" against "effects" is undocumented; its weights are under Meta's gated SAM License (information). Switching the cloud dub from Demucs to SAM Audio raises the per-minute price (about $0.10–0.20 against $0.042) but drops two loudnorm steps: listen before changing the default.
- **Licences (information).** Code and weights are MIT and Apache-2.0, data CC BY 4.0. Show the DnR v2 attribution and the MIT notices. Some DnR source clips may carry NC licences (unverified).

## 11. Unknowns

- Separation quality on real film and video soundtracks, other languages and music with vocals, compared with MelBand RoFormer, Demucs `htdemucs` and SAM Audio on the same clips (D4).
- Speed on Fuobe's CPU-only host: measured (§2.4, D1 and D4). Whether single-thread no-NNPACK helps DBS-TIGER there is still unmeasured.
- Whether the fast stereo bed (§2.1) sounds right on real stereo mixes.
- Why the Comfy Registry flagged 0.1.0.
- Whether an ONNX export of the network core works and matches PyTorch (`scatter_reduce` amax with `include_self`, TopK, dynamic-length windows), and which ops onnxruntime-web's WebGPU provider supports (bidirectional LSTM, `ScatterElements` max).
- How fal bills SAM Audio (input length or summed target + residual), how well prompts like "music" and "sound effects" split the residual, and whether Demucs's "$0.0007 per seconds" counts audio or compute seconds.
- Whether the authors will release more DBS checkpoints (MUSDB 4-stem, EchoSet), and whether fal or Replicate will host DBS. Replicate could not be ruled out with certainty.
- AudioShake's dollar price per credit.
- Replicate `ryan5453/demucs` hardware (A100 in the text, A40 in the page's JSON); all Replicate prices are page estimates.
- Where steady noise (hiss, hum, room tone) lands: sfx or speech. It matters for "Clean up dialogue". Measured twice, in different ways, and the two agree on hum but read hiss differently. *D5:* one mono Mandarin clip through graph C, measured as the drop in level at the noise's frequencies in the cleaned voice: a mains hum went mostly to sfx (removed), broadband hiss mostly stayed with the speech (about 10 dB lower). *D4 (§9 D4):* six stereo English mixes through graph A, measured as each stem's share of the known noise by projection: hum mostly to music (BSRNN) or effects (TIGER), hiss spread across effects (49–59 %), music and dialogue (20–31 % left in the dialogue). A 20–31 % share of the hiss's energy is 5–7 dB down, so both say the dialogue keeps an audible part of the hiss. Room tone and real recordings are unmeasured.
- The licences of individual DnR v2 source clips and whether they matter for the Apache-2.0 weights or their outputs.

## Sources (read 2026-10-29)

- ComfyUI-DBS: https://github.com/hiroki-abe-58/ComfyUI-DBS cloned at `f656e53434b5485c148a2866fbd6ddc6b6152ed6` (HEAD = main = tag v0.1.0 per `git ls-remote`): `README.md`, `LICENSE`, `NOTICE`, `.comfyignore`, `requirements.txt`, `pyproject.toml`, `__init__.py`, `dbs_comfy/nodes.py`, `paths.py`, `runtime.py`, `vendor/UPSTREAM.md`, `vendor/MANIFEST.sha256` (`sha256sum -c`: all OK), the vendor shims, `tools/download_model.py`, `tools/model_files.sha256`, `docs/VERIFICATION.md`, `workflows/api/*.json`, `.github/workflows/ci.yml`; a grep scan of every `.py` outside `tests/`.
- Comfy Registry: https://api.comfy.org/nodes/dbs-soundtrack-separation and `/versions`; node zip https://cdn.comfy.org/hiroki-abe-58/dbs-soundtrack-separation/0.1.0/node.zip (listed and hashed, not extracted).
- Upstream: https://github.com/JusperLee/Dynamic-Band-Splitting cloned at `ff526463a58ee0278e7bd05c4b8bce112b743e34`: `README.md`, `CITATION.cff`, `LICENSE`, `THIRD_PARTY.md`, `pyproject.toml`, `requirements.txt`, `demo/README.md`, `demo/app.py`, `demo/backend.py` L57–155, `project_page/index.html` (results), `dbs/engine/inference.py`, `dbs/modules/stft.py`, `band_split.py`, `dbs.py` L300–332, `dbs/models/tiger.py` L275–285, L454–526, L640–690.
- Paper: https://export.arxiv.org/api/query?id_list=2610.14993 and https://arxiv.org/abs/2610.14993.
- Hugging Face: https://huggingface.co/api/models/JusperLee/DBS-TIGER-DnR and `/tree/main`; https://huggingface.co/api/models/JusperLee/DBS-BSRNN-DnR and `/tree/main`; READMEs and configs at the pinned revisions (hashed); safetensors headers by HTTP range request; https://huggingface.co/api/models?author=JusperLee ; https://huggingface.co/api/models/JusperLee/TIGER-DnR ; https://huggingface.co/api/models/oulianov/DBS-TIGER-DnR ; https://huggingface.co/api/spaces/JusperLee/DBS-Demo ; https://huggingface.co/api/models/facebook/sam-audio-large (and -base, -small) and its `LICENSE`.
- Dataset: https://zenodo.org/api/records/6949108 (DnR v2.0); Bandit: https://github.com/kwatcharasupat/bandit and https://zenodo.org/api/records/10160698.
- fal: https://fal.ai/models/fal-ai/sam-audio/separate/llms.txt , …/visual-separate/llms.txt , …/span-separate/llms.txt , https://fal.ai/models/fal-ai/demucs/llms.txt , https://fal.ai/models/fal-ai/elevenlabs/audio-isolation/llms.txt , https://fal.ai/models/fal-ai/deepfilternet3/llms.txt , https://fal.ai/models/veed/clean-audio/llms.txt ; the model search https://fal.ai/api/models?keywords=… (2026-10-29).
- Replicate: https://replicate.com/ryan5453/demucs , https://replicate.com/cjwbw/demucs , https://replicate.com/geopti/sam-audio-large ; Demucs licence https://raw.githubusercontent.com/facebookresearch/demucs/main/LICENSE .
- AudioShake: https://developer.audioshake.ai/models.md , https://developer.audioshake.ai/billing.md .
- Live ComfyUI (read-only GETs): `http://127.0.0.1:8188/system_stats` (v0.41.0, torch 2.14.1+cpu, Python 3.13.16, `--cpu`, 14.3 GB RAM) and `/object_info`; source `/home/user/ComfyUI` @ `fc04da91`: `comfy/audio.py` L36, `comfy/model_management.py` L195–220, `comfy_api/latest/_io.py` L133, `folder_paths.py` L382–400 and L445–491, `comfy_extras/nodes_audio.py` L198–335, L400–420, L520–600, L617–790, `server.py` L406–418 and L783–820; `nproc` = 4.
- Fuobe @ `claude/fuobe-parity-4` (`7d7a765`): `src/lib/catalog/types.ts`, `plan.ts`, `payload.ts`, `models.ts`, `canvas.ts`, `shorts.ts`, `mixed-media.ts`, `faceless.ts`, `genjutsu.ts`, `remove-object.ts`, `swap-studio-plan.ts`; `src/server/generations.ts`, `providers/mock.ts`, `providers/comfyui.ts`, `audio-tools.ts`, `swap-studio.ts`, `assist/tools.ts`, `assist/studio-tools.ts`; `src/lib/av/dub.ts`, `src/lib/hubs.ts`, `src/lib/studios.ts`, `src/lib/output-actions.ts`, `src/lib/licences.ts`, `src/lib/media-probe.ts`; `src/components/studio/mode-switch-studio.tsx`, `src/components/workflows-view.tsx`; `src/app/api/comfyui/route.ts`; `scripts/gen-cloud-models.py`; `scripts/comfy/install-comfyui.sh`, `install-isolated-worker.sh`, `library.spec.mjs`, `build-library.mjs`, `validate-workflows.mjs`, `hand-built/dub-prepare-separate-transcribe.json`, `hand-built/video-mux-audio*.json`; `scripts/eval/metrics/requirements.*`; `docs/research/paid-model-apis-3.md` L365–372, `comfyui-oss-3.md`.
