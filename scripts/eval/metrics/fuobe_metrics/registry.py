"""What each metric means and which model (at which pinned revision, under which licence) makes it.
scripts/eval/lib/metric-info.mjs holds the same directions for compare and the reports."""

# The suite names a metric family; each family writes these keys per job.
FAMILIES = {
    "clip": ["clip"],
    "aesthetic": ["aesthetic"],
    "style": ["style", "styleNearest"],
    "identity": ["identity", "faceRate"],
    "temporal": ["drift", "driftMax", "warp"],
    "lipsync": ["lipsync", "lipsyncOffset"],
    "continuity": ["continuity"],
    "palette": ["paletteFit", "paletteCover"],
    # Soundtrack separation against the case's known stems (scripts/eval/fixtures/make-separation.py).
    "separation": [
        "voiceSiSdr", "remixSiSdr", "musicSiSdr", "effectsSiSdr", "backgroundSiSdr", "voiceSdr", "backgroundSdr",
        "mixError", "bedLevel", "bedPeak", "bedScale", "stereoCorrGap", "noiseInVoice", "speedX",
    ],
    # Word error rate of the voice stem (Whisper), of the input as it is (the same ASR without separating first), and of
    # the job's own transcript when its graph transcribes (Qwen3-ASR in the dub's first step).
    "wer": ["wer", "werInput", "werTranscript"],
    "background": ["bgDiff", "bgPsnr"],
    # A splat file's nearly transparent share (opacity under 0.05) and its count (the splat suite).
    "splat": ["haze", "gaussians"],
}

METRICS = {
    "clip": {"label": "CLIP prompt adherence", "better": "higher", "unit": "CLIPScore 0–100"},
    "aesthetic": {"label": "Aesthetic (LAION v2)", "better": "higher", "unit": "1–10"},
    "style": {"label": "Style vs references", "better": "higher", "unit": "cosine to the reference centroid"},
    "styleNearest": {"label": "Style, nearest reference", "better": "higher", "unit": "cosine"},
    "identity": {"label": "Identity vs references", "better": "higher", "unit": "face-embedding cosine"},
    "faceRate": {"label": "Frames with a face", "better": "higher", "unit": "0–1"},
    "drift": {"label": "Frame-to-frame drift", "better": "lower", "unit": "1 − cosine"},
    "driftMax": {"label": "Worst frame jump", "better": "lower", "unit": "1 − cosine"},
    "warp": {"label": "Warp error (flicker)", "better": "lower", "unit": "mean abs error 0–1"},
    "lipsync": {"label": "Lip-sync proxy", "better": "higher", "unit": "Pearson r, mouth motion vs voice"},
    "lipsyncOffset": {"label": "A/V offset", "better": "none", "unit": "frames"},
    "syncnet": {"label": "SyncNet confidence", "better": "higher", "unit": "SyncNet conf"},
    "continuity": {"label": "Shot continuity", "better": "higher", "unit": "cosine between consecutive shots"},
    "paletteFit": {"label": "Palette distance", "better": "lower", "unit": "mean ΔE76 to the nearest palette colour"},
    "paletteCover": {"label": "Palette used", "better": "higher", "unit": "share of the palette's colours"},
    "voiceSiSdr": {"label": "Dialogue SI-SDR", "better": "higher", "unit": "dB against the known speech"},
    "musicSiSdr": {"label": "Music SI-SDR", "better": "higher", "unit": "dB against the known music"},
    "effectsSiSdr": {"label": "Effects SI-SDR", "better": "higher", "unit": "dB against the known effects"},
    "backgroundSiSdr": {"label": "Music & effects SI-SDR", "better": "higher", "unit": "dB against the known bed"},
    "voiceSdr": {"label": "Dialogue SDR", "better": "higher", "unit": "dB (level counts)"},
    "backgroundSdr": {"label": "Music & effects SDR", "better": "higher", "unit": "dB (level counts)"},
    "mixError": {"label": "Stems vs input", "better": "lower", "unit": "dB under the input (voice + bed)"},
    "bedLevel": {"label": "Bed level vs reference", "better": "none", "unit": "dB (0 = same; AudioMerge's peak scaling shows negative)"},
    "bedPeak": {"label": "Bed peak", "better": "none", "unit": "dBFS"},
    "remixSiSdr": {"label": "Clean dialogue SI-SDR", "better": "higher", "unit": "dB against the voice + the known bed at the level asked"},
    "bedScale": {"label": "Bed scaling", "better": "none", "unit": "dB, the bed against input − voice (0 = as subtracted; AudioMerge's peak scaling shows negative)"},
    "stereoCorrGap": {"label": "Bed stereo gap", "better": "lower", "unit": "|L/R correlation − the reference bed's|"},
    "noiseInVoice": {"label": "Noise left in the dialogue", "better": "lower", "unit": "share of the known hum or hiss"},
    "speedX": {"label": "Speed", "better": "higher", "unit": "x real time (all passes)"},
    "wer": {"label": "WER, dialogue stem", "better": "lower", "unit": "word error rate 0–1"},
    "werInput": {"label": "WER, input as is", "better": "lower", "unit": "word error rate 0–1"},
    "werTranscript": {"label": "WER, the job's transcript", "better": "lower", "unit": "word error rate 0–1"},
    "bgDiff": {"label": "Background change vs the source", "better": "lower", "unit": "mean abs error 0–1 on the frame's outer ring"},
    "bgPsnr": {"label": "Background PSNR vs the source", "better": "higher", "unit": "dB on the frame's outer ring"},
    "haze": {"label": "Splat haze", "better": "lower", "unit": "share of Gaussians under opacity 0.05"},
    "gaussians": {"label": "Gaussians", "better": "none", "unit": "count in the splat file"},
}

# Weights, each pinned to a Hugging Face revision. "commercial" says whether the model itself may be used
# commercially; a metric model only scores outputs, but the licence is recorded with every result.
MODELS = {
    "clip-b32": {
        "arch": "ViT-B-32",
        "repo": "laion/CLIP-ViT-B-32-laion2B-s34B-b79K",
        "file": "open_clip_model.safetensors",
        "revision": "1a25a446712ba5ee05982a381eed697ef9b435cf",
        "licence": "MIT",
        "commercial": True,
    },
    "clip-l14": {
        "arch": "ViT-L-14-quickgelu",
        "repo": "timm/vit_large_patch14_clip_224.openai",
        "file": "open_clip_model.safetensors",
        "revision": "18d0535469bb561bf468d76c1d73aa35156c922b",
        "licence": "MIT (OpenAI CLIP)",
        "commercial": True,
    },
    "aesthetic-v2": {
        "repo": "camenduru/improved-aesthetic-predictor",
        "file": "sac+logos+ava1-l14-linearMSE.pth",
        "revision": "7b2449be1264fcd9a1cf92e3d30dd29af989c836",
        "licence": "Apache-2.0 (christophschuhmann/improved-aesthetic-predictor; a mirror of the original weights)",
        "commercial": True,
    },
    # AuraFace's recognition model. Its card covers that model only: the SCRFD detector the repo also ships is
    # recorded on its own ("scrfd") and isn't used unless --face-detector scrfd asks for it.
    "auraface": {
        "repo": "fal/AuraFace-v1",
        "files": ["glintr100.onnx", "scrfd_10g_bnkps.onnx"],
        "recognition": "glintr100.onnx",
        "revision": "af6d057c9b0ec4071d4c49c80e3539258798b609",
        "licence": "Apache-2.0 (fal/AuraFace-v1's recognition model glintr100.onnx, trained on commercially usable data)",
        "commercial": True,
    },
    # Face detectors for AuraFace. YuNet (default) has a clear permissive licence; SCRFD is what AuraFace's own
    # example uses, but the weights come from insightface's model zoo, released for non-commercial research.
    "yunet": {
        "repo": "opencv/face_detection_yunet",
        "file": "face_detection_yunet_2023mar.onnx",
        "revision": "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310",
        "licence": "MIT (Shiqi Yu's YuNet, libfacedetection; OpenCV Zoo)",
        "commercial": True,
    },
    "scrfd": {
        "repo": "fal/AuraFace-v1",
        "file": "scrfd_10g_bnkps.onnx",
        "revision": "af6d057c9b0ec4071d4c49c80e3539258798b609",
        "licence": "unclear: SCRFD-10G from insightface's model zoo, whose pretrained models insightface releases for non-commercial research (AuraFace's card covers only its recognition model)",
        "commercial": None,
    },
    "buffalo_l": {
        "repo": "insightface model zoo (downloaded by insightface)",
        "licence": "non-commercial research only (insightface model packs)",
        "commercial": False,
    },
    # Speech recognition for the separation suite's word error rate (pnpm eval:setup --asr).
    "whisper-base-en": {
        "repo": "openai/whisper-base.en",
        "files": ["config.json", "generation_config.json", "model.safetensors", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", "vocab.json", "merges.txt", "normalizer.json", "added_tokens.json", "special_tokens_map.json"],
        "revision": "911407f4214e0e1d82085af863093ec0b66f9cd6",
        "licence": "MIT (OpenAI Whisper code and weights; the Hugging Face card says Apache-2.0)",
        "commercial": True,
    },
    # Style similarity on image features alone (--style-model dinov2): DINOv2 ViT-S/14 as timm packs it.
    "dinov2-small": {
        "arch": "vit_small_patch14_dinov2.lvd142m",
        "repo": "timm/vit_small_patch14_dinov2.lvd142m",
        "file": "model.safetensors",
        "revision": "4610ca143709d58a633b6397a74412c2c3842454",
        "licence": "Apache-2.0 (facebookresearch/dinov2)",
        "commercial": True,
    },
}
