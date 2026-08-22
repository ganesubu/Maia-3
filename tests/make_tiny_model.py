#!/usr/bin/env python3
"""Writes tests/tiny-model.bin: a randomly initialised, structurally valid
Maia3 container with tiny dimensions.

It is NOT a real Maia network and plays nonsense moves. Its only purpose is
to let tests/engine-test.mjs exercise the REAL weights-format.js, model.js
and worker.js code paths (including the batched inference used by the
personality layer) without needing the 5M/23M/79M weights.
"""
import json
import math
import random
import struct
import sys
from pathlib import Path

random.seed(7)

CFG = {
    "dim_vit": 8,
    "dim_emb": 4,
    "num_heads": 2,
    "history": 2,
    "num_blocks": 1,
    "head_hid_dim": 4,
    "gab_gen_size": 2,
    "gab_intermediate_dim": 4,
    "gab_per_square_dim": 0,
    "mlp_ratio": 2.0,
    "use_rms_norm": False,
    "use_absolute_pe": False,
    "include_time_info": False,
    "activation": "gelu",
}

D = CFG["dim_vit"]
E = CFG["dim_emb"]
H = CFG["head_hid_dim"]
G = CFG["gab_gen_size"]
GI = CFG["gab_intermediate_dim"]
NH = CFG["num_heads"]
IN_DIM = 12 * CFG["history"] + 2 * E
MLP = int(round(D * CFG["mlp_ratio"]))

tensors = {}


def add(name, shape):
    n = 1
    for s in shape:
        n *= s
    scale = 1.0 / math.sqrt(max(1, shape[-1]))
    tensors[name] = (shape, [random.uniform(-scale, scale) for _ in range(n)])


add("elo_embedding_low", [E])
add("elo_embedding_high", [E])
add("token_projection.weight", [D, IN_DIM])
add("token_projection.bias", [D])
add("gab_shared_weight", [4096, G])

for b in range(CFG["num_blocks"]):
    p = f"transformer.layers.{b}"
    # gab_per_square_dim == 0 -> sm2 input is the pooled (dim_vit,) vector
    add(f"{p}.sm2.weight", [GI, D])
    add(f"{p}.sm2.bias", [GI])
    add(f"{p}.ln1.weight", [GI])
    add(f"{p}.ln1.bias", [GI])
    add(f"{p}.sm3.weight", [NH * G, GI])
    add(f"{p}.sm3.bias", [NH * G])
    add(f"{p}.ln2.weight", [NH * G])
    add(f"{p}.ln2.bias", [NH * G])
    add(f"{p}.mha.in_proj_weight", [3 * D, D])
    add(f"{p}.mha.out_proj.weight", [D, D])
    add(f"{p}.norm1.weight", [D])
    add(f"{p}.norm1.bias", [D])
    add(f"{p}.linear1.weight", [MLP, D])
    add(f"{p}.linear1.bias", [MLP])
    add(f"{p}.linear2.weight", [D, MLP])
    add(f"{p}.linear2.bias", [D])
    add(f"{p}.norm2.weight", [D])
    add(f"{p}.norm2.bias", [D])

add("final_norm.weight", [D])
add("final_norm.bias", [D])
add("proj_sq_from.weight", [H, D])
add("proj_sq_to.weight", [H, D])
add("promo_bias_proj.weight", [4, H])
add("last_ln.weight", [D])
add("last_ln.bias", [D])
add("fc_value_hid.weight", [H, D])
add("fc_value_hid.bias", [H])
add("fc_value.weight", [3, H])
add("fc_value.bias", [3])

header = {"config": CFG, "tensors": {}}
blob = bytearray()
offset = 0
for name, (shape, values) in tensors.items():
    header["tensors"][name] = {"shape": shape, "offset": offset, "length": len(values)}
    blob += struct.pack("<%df" % len(values), *values)
    offset += 4 * len(values)

header_bytes = json.dumps(header).encode("utf-8")
out = Path(sys.argv[1] if len(sys.argv) > 1 else "tests/tiny-model.bin")
with out.open("wb") as f:
    f.write(struct.pack("<Q", len(header_bytes)))
    f.write(header_bytes)
    f.write(blob)
print(f"wrote {out} ({out.stat().st_size} bytes, {len(tensors)} tensors)")
