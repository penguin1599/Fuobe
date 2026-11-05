"""The splat metric (the splat suite): the share of nearly transparent Gaussians in an .spz or a 3DGS .ply, read by
content, and what the scorer does with a run's 3D files and a clean graph's preview still. numpy only; the files are
written here from the formats' layouts (docs/research/idol-9.md §2.1, §2.4)."""

import argparse
import gzip
import pathlib
import struct

import numpy as np
import pytest

from fuobe_metrics import score, splat

# 10 Gaussians: 4 under opacity 0.05 (the haze), 6 above it.
OPACITY = np.array([0.0, 0.01, 0.03, 0.049, 0.06, 0.2, 0.5, 0.8, 0.95, 1.0], np.float32)


def spz(opacity: np.ndarray, version: int = 2) -> bytes:
    n = len(opacity)
    head = struct.pack("<IIIBBBB", splat.SPZ_MAGIC, version, n, 0, 12, 0, 0)
    pos = bytes(n * (6 if version == 1 else 9))
    alpha = np.round(opacity * 255).clip(0, 255).astype(np.uint8).tobytes()
    rest = bytes(n * 9)  # colour, scale and rotation bytes, unread
    return gzip.compress(head + pos + alpha + rest)


def ply(opacity: np.ndarray) -> bytes:
    n = len(opacity)
    names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    rows = np.zeros(n, dtype=[(k, "<f4") for k in names])
    op = opacity.astype(np.float64).clip(1e-6, 1 - 1e-6)
    rows["opacity"] = np.log(op / (1 - op))
    head = f"ply\nformat binary_little_endian 1.0\nelement vertex {n}\n" + "".join(f"property float {k}\n" for k in names) + "end_header\n"
    return head.encode() + rows.tobytes()


@pytest.mark.parametrize("version", [1, 2, 3])
def test_spz_haze(tmp_path, version):
    f = tmp_path / "a.spz"
    f.write_bytes(spz(OPACITY, version))
    assert splat.haze(splat.opacities(f)) == {"gaussians": 10, "haze": 0.4}


def test_ply_haze_and_a_file_saved_under_another_name(tmp_path):
    f = tmp_path / "a.bin"
    f.write_bytes(ply(OPACITY))
    op = splat.opacities(f)
    assert np.allclose(op, OPACITY, atol=1e-5)
    assert splat.haze(op) == {"gaussians": 10, "haze": 0.4}


def test_what_isnt_a_splat(tmp_path):
    glb = tmp_path / "m.glb"
    glb.write_bytes(b"glTF" + bytes(16))
    with pytest.raises(splat.NotASplat):
        splat.opacities(glb)
    future = tmp_path / "v9.spz"
    future.write_bytes(gzip.compress(struct.pack("<IIIBBBB", splat.SPZ_MAGIC, 9, 1, 0, 12, 0, 0) + bytes(64)))
    with pytest.raises(splat.NotASplat, match="version 9"):
        splat.opacities(future)
    points = tmp_path / "points.ply"
    points.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nend_header\n" + bytes(4))
    with pytest.raises(splat.NotASplat, match="no opacity"):
        splat.opacities(points)
    assert splat.haze(np.array([], np.float32)) == {"gaussians": 0, "haze": 0.0}


def scorer(run_dir):
    s = score.Scorer(argparse.Namespace(device="cpu"))
    s.run_dir = run_dir
    return s


def test_the_scorer_reads_the_splat_among_a_runs_files(tmp_path):
    out = tmp_path / "outputs" / "j"
    out.mkdir(parents=True)
    (out / "0-splat.spz").write_bytes(spz(OPACITY))
    (out / "1-turntable.mp4").write_bytes(b"")
    job = {"id": "j", "outputs": [{"file": "outputs/j/0-splat.spz", "kind": "model3d", "role": "splat"}, {"file": "outputs/j/1-turntable.mp4", "kind": "video", "role": "turntable"}]}
    assert scorer(tmp_path).m_splat(job, []) == {"gaussians": 10, "haze": 0.4}
    # The demo's splat is a GLB: noted, not scored.
    (out / "demo.glb").write_bytes(b"glTF" + bytes(16))
    demo = {"id": "d", "outputs": [{"file": "outputs/j/demo.glb", "kind": "model3d"}]}
    assert "no splat file" in scorer(tmp_path).m_splat(demo, [])["_note"]
    assert "no 3D file" in scorer(tmp_path).m_splat({"id": "x", "outputs": []}, [])["_note"]


def test_a_preview_still_beside_a_clip_isnt_scored(tmp_path):
    out = tmp_path / "outputs" / "j"
    out.mkdir(parents=True)
    for name in ("orbit.mp4", "seen.png"):
        (out / name).write_bytes(b"")
    clip = {"file": "outputs/j/orbit.mp4", "kind": "video", "role": "turntable"}
    still = {"file": "outputs/j/seen.png", "kind": "image", "role": "preview"}
    assert score.media_outputs(tmp_path, {"outputs": [clip, still]}) == [pathlib.Path(tmp_path / clip["file"])]
    # A preview that is the result itself (no clip beside it) is still scored.
    assert score.media_outputs(tmp_path, {"outputs": [still]}) == [pathlib.Path(tmp_path / still["file"])]
