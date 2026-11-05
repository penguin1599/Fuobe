"""Gaussian splat files (the splat suite): how many Gaussians a .spz or .ply holds, and the share that is nearly
transparent (opacity under 0.05), the haze Idol is known for (docs/research/idol-9.md §2.4). numpy only.

The two formats ComfyUI's SplatToFile3D writes (comfy_extras/nodes_gaussian_splat.py):
- .spz (Niantic), gzip-wrapped: a 16-byte header (magic "NGSP", version, count, SH degree, fractional bits, flags,
  reserved), then the positions (version 1: float16 x 3; versions 2 and 3: 24-bit fixed point x 3), then one alpha
  byte per Gaussian (opacity x 255).
- .ply (3DGS): a text header, then binary little-endian vertices with a logit `opacity` property.
"""

from __future__ import annotations

import gzip
import pathlib
import struct

import numpy as np

HAZE_OPACITY = 0.05
SPZ_MAGIC = 0x5053474E  # "NGSP"
PLY_TYPES = {
    "char": "i1", "uchar": "u1", "short": "i2", "ushort": "u2", "int": "i4", "uint": "u4", "float": "f4", "double": "f8",
    "int8": "i1", "uint8": "u1", "int16": "i2", "uint16": "u2", "int32": "i4", "uint32": "u4", "float32": "f4", "float64": "f8",
}


class NotASplat(ValueError):
    """The file isn't a splat this module reads (a GLB, a .ksplat, an ASCII .ply, an unknown .spz version)."""


def spz_opacities(data: bytes) -> np.ndarray:
    raw = gzip.decompress(data)
    if len(raw) < 16 or struct.unpack_from("<I", raw, 0)[0] != SPZ_MAGIC:
        raise NotASplat("not an .spz (bad magic)")
    version, n = struct.unpack_from("<II", raw, 4)
    per_point = {1: 6, 2: 9, 3: 9}.get(version)
    if per_point is None:
        raise NotASplat(f".spz version {version} isn't read here (1-3 are)")
    off = 16 + n * per_point
    if len(raw) < off + n:
        raise NotASplat(".spz is cut short")
    return np.frombuffer(raw, np.uint8, count=n, offset=off).astype(np.float32) / 255.0


def ply_opacities(data: bytes) -> np.ndarray:
    end = data.find(b"end_header\n")
    if not data.startswith(b"ply") or end < 0:
        raise NotASplat("not a .ply")
    body = end + len(b"end_header\n")
    lines = data[:end].decode("ascii", "replace").splitlines()
    if "format binary_little_endian 1.0" not in [ln.strip() for ln in lines]:
        raise NotASplat("only binary little-endian .ply is read here")
    props: list[tuple[str, str]] = []
    count = 0
    seen: list[str] = []
    for ln in lines:
        p = ln.split()
        if not p:
            continue
        if p[0] == "element":
            seen.append(p[1])
            if p[1] == "vertex":
                count = int(p[2])
        elif p[0] == "property" and seen[-1:] == ["vertex"]:
            if p[1] == "list":
                raise NotASplat("the .ply's vertices have list properties")
            if p[1] not in PLY_TYPES:
                raise NotASplat(f"the .ply has a property type {p[1]} this doesn't read")
            props.append((p[2], "<" + PLY_TYPES[p[1]]))
    if seen[:1] != ["vertex"]:
        raise NotASplat("the .ply's first element isn't its vertices")
    names = [n for n, _ in props]
    if "opacity" not in names:
        raise NotASplat("the .ply has no opacity (a point cloud, not a splat)")
    arr = np.frombuffer(data, np.dtype(props), count=count, offset=body)
    logit = arr["opacity"].astype(np.float64)
    return (1.0 / (1.0 + np.exp(-logit))).astype(np.float32)


def opacities(path: str | pathlib.Path) -> np.ndarray:
    """Each Gaussian's opacity (0-1), read by content rather than by name (a run may save an .spz under .bin)."""
    data = pathlib.Path(path).read_bytes()
    if data[:2] == b"\x1f\x8b":
        return spz_opacities(data)
    if data[:3] == b"ply":
        return ply_opacities(data)
    raise NotASplat("not an .spz or .ply")


def haze(op: np.ndarray, threshold: float = HAZE_OPACITY) -> dict:
    """The count and the share of nearly transparent Gaussians."""
    n = int(op.size)
    return {"gaussians": n, "haze": round(float((op < threshold).mean()) if n else 0.0, 4)}
