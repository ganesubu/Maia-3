#!/usr/bin/env python3
"""
Convert an official CSSLab Maia-3 checkpoint (.pt) into a single flat binary
file that the offline web page can read directly (no PyTorch, no server,
no internet required at play-time).

Run this ONCE, locally, with the same Python environment you used to install
`maia3` (it needs `torch`; `numpy` is optional but used if present).

    python convert_weights.py --checkpoint /path/to/maia3-5m.pt --model 5m

This writes `weights/maia3-5m.bin` next to this script. Open index.html,
tap "Load engine", and pick that file.

Why this step exists: Maia-3 ships as a PyTorch pickle/zip checkpoint.
Browsers cannot read that format under any circumstances -- there is no
JS or WASM library that opens raw .pt files -- so this script unpacks the
tensors CSSLab trained into a trivial container format (JSON header +
raw float32 bytes, the same idea as HuggingFace's `safetensors`) that a
few dozen lines of JavaScript can parse directly. This is the only
non-browser step in the whole project; everything after this is offline.
"""

import argparse
import json
import struct
import sys
from pathlib import Path

try:
    import torch
except ImportError:
    sys.exit(
        "This script needs PyTorch (the same environment you used for "
        "`pip install maia3` / `pip install torch`).\n"
        "Install it with:  python -m pip install torch --index-url https://download.pytorch.org/whl/cpu"
    )


# ----------------------------------------------------------------------------
# Architecture presets, mirrored from CSSLab/maia3's model_registry.py.
# These are plain interoperability numbers (layer widths, head counts) that
# describe how to wire the weights back together -- not source code.
# ----------------------------------------------------------------------------
BASE_SIZE_CONFIG = {
    "history": 8,
    "dim_emb": 128,
    "num_blocks": 8,
    "mlp_ratio": 2.0,
    "use_rms_norm": True,
    "omit_qkv_biases": True,
    "activation": "gelu",
}

MODEL_PRESETS = {
    "3m": {
        **BASE_SIZE_CONFIG,
        "hf_repo": "UofTCSSLab/Maia3-ablate-3M",
        "checkpoint_filename": "maia3-3m.pt",
        "dim_vit": 192, "head_hid_dim": 192, "num_heads": 6,
        "gab_gen_size": 64, "gab_per_square_dim": 0, "gab_intermediate_dim": 64,
    },
    "5m": {
        **BASE_SIZE_CONFIG,
        "hf_repo": "UofTCSSLab/Maia3-5M",
        "checkpoint_filename": "maia3-5m.pt",
        "dim_vit": 256, "head_hid_dim": 256, "num_heads": 8,
        "gab_gen_size": 64, "gab_per_square_dim": 0, "gab_intermediate_dim": 64,
    },
    "23m": {
        **BASE_SIZE_CONFIG,
        "hf_repo": "UofTCSSLab/Maia3-23M",
        "checkpoint_filename": "maia3-23m.pt",
        "dim_vit": 512, "head_hid_dim": 512, "num_heads": 16,
        "gab_gen_size": 128, "gab_per_square_dim": 32, "gab_intermediate_dim": 128,
    },
    "79m": {
        **BASE_SIZE_CONFIG,
        "hf_repo": "UofTCSSLab/Maia3-79M",
        "checkpoint_filename": "maia3-79m.pt",
        "dim_vit": 1024, "head_hid_dim": 1024, "num_heads": 32,
        "gab_gen_size": 128, "gab_per_square_dim": 32, "gab_intermediate_dim": 128,
    },
}

ALIASES = {"3m": "3m", "maia3-3m": "3m", "maia3-3m-ablation": "3m",
           "5m": "5m", "maia3-5m": "5m",
           "23m": "23m", "maia3-23m": "23m",
           "79m": "79m", "maia3-79m": "79m"}


def resolve_preset(name: str) -> dict:
    key = ALIASES.get(name.strip().lower())
    if key is None:
        sys.exit(f"Unknown --model '{name}'. Choose one of: 3m, 5m, 23m, 79m")
    return {"alias": key, **MODEL_PRESETS[key]}


def load_state_dict(checkpoint_path: Path) -> dict:
    try:
        ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    except Exception as exc:
        print(f"note: weights_only load failed ({exc}); retrying without it.\n"
              f"      Only do this for a checkpoint you downloaded yourself from\n"
              f"      the official https://huggingface.co/UofTCSSLab repos.", file=sys.stderr)
        ckpt = torch.load(checkpoint_path, map_location="cpu", weights_only=False)

    state_dict = ckpt["model_state_dict"] if isinstance(ckpt, dict) and "model_state_dict" in ckpt else ckpt
    if not isinstance(state_dict, dict):
        sys.exit("Checkpoint did not contain a recognizable state_dict.")

    # Older checkpoints used "smolgen" naming for what is now the GAB module.
    return {k.replace("smolgen", "gab"): v for k, v in state_dict.items()}


def pick_tensor(state_dict: dict, *candidates):
    for name in candidates:
        if name in state_dict:
            return name, state_dict[name]
    return None, None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--checkpoint", required=True, help="Path to the downloaded .pt checkpoint file")
    ap.add_argument("--model", required=True, choices=sorted(MODEL_PRESETS), help="Which Maia3 size this checkpoint is")
    ap.add_argument("--output", default=None, help="Output .bin path (default: weights/maia3-<model>.bin)")
    args = ap.parse_args()

    preset = resolve_preset(args.model)
    ckpt_path = Path(args.checkpoint).expanduser()
    if not ckpt_path.exists():
        sys.exit(f"Checkpoint not found: {ckpt_path}")

    out_path = Path(args.output) if args.output else Path(__file__).parent / "weights" / f"maia3-{preset['alias']}.bin"
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"Loading {ckpt_path} ...")
    state_dict = load_state_dict(ckpt_path)
    print(f"Found {len(state_dict)} tensors in checkpoint.")

    depth = preset["num_blocks"]
    has_sq = preset["gab_per_square_dim"] > 0

    # Collect the exact tensors the JS forward pass needs, by their PyTorch
    # qualified names, and normalize them into a flat name -> ndarray map.
    tensors = {}

    def grab(out_name, *candidates, required=True):
        name, t = pick_tensor(state_dict, *candidates)
        if t is None:
            if required:
                sys.exit(f"Missing expected tensor for '{out_name}'. Looked for: {candidates}\n"
                          f"Available keys sample: {list(state_dict)[:10]}")
            return
        tensors[out_name] = t.detach().to(torch.float32).contiguous().numpy()

    grab("elo_embedding_low", "elo_embedding_low.weight")
    grab("elo_embedding_high", "elo_embedding_high.weight")
    grab("token_projection.weight", "token_projection.weight")
    grab("token_projection.bias", "token_projection.bias")
    grab("gab_shared_weight", "gab_shared_weight",
         "transformer.layers.0.self_attn.gab_weight")
    grab("final_norm.weight", "transformer.norm.weight")
    grab("final_norm.bias", "transformer.norm.bias")
    grab("last_ln.weight", "last_ln.weight")
    grab("last_ln.bias", "last_ln.bias")
    grab("fc_value_hid.weight", "fc_value_hid.weight")
    grab("fc_value_hid.bias", "fc_value_hid.bias")
    grab("fc_value.weight", "fc_value.weight")
    grab("fc_value.bias", "fc_value.bias")
    grab("proj_sq_from.weight", "proj_sq_from.weight")
    grab("proj_sq_to.weight", "proj_sq_to.weight")
    grab("promo_bias_proj.weight", "promo_bias_proj.weight")

    for i in range(depth):
        p = f"transformer.layers.{i}"
        grab(f"{p}.mha.in_proj_weight", f"{p}.self_attn.mha.in_proj_weight")
        grab(f"{p}.mha.out_proj.weight", f"{p}.self_attn.mha.out_proj.weight")
        if has_sq:
            grab(f"{p}.sm1.weight", f"{p}.self_attn.sm1.weight")
            grab(f"{p}.sm1.bias", f"{p}.self_attn.sm1.bias")
        grab(f"{p}.sm2.weight", f"{p}.self_attn.sm2.weight")
        grab(f"{p}.sm2.bias", f"{p}.self_attn.sm2.bias")
        grab(f"{p}.ln1.weight", f"{p}.self_attn.ln1.weight")
        grab(f"{p}.ln1.bias", f"{p}.self_attn.ln1.bias")
        grab(f"{p}.sm3.weight", f"{p}.self_attn.sm3.weight")
        grab(f"{p}.sm3.bias", f"{p}.self_attn.sm3.bias")
        grab(f"{p}.ln2.weight", f"{p}.self_attn.ln2.weight")
        grab(f"{p}.ln2.bias", f"{p}.self_attn.ln2.bias")
        grab(f"{p}.linear1.weight", f"{p}.linear1.weight")
        grab(f"{p}.linear1.bias", f"{p}.linear1.bias")
        grab(f"{p}.linear2.weight", f"{p}.linear2.weight")
        grab(f"{p}.linear2.bias", f"{p}.linear2.bias")
        grab(f"{p}.norm1.weight", f"{p}.norm1.weight")
        grab(f"{p}.norm2.weight", f"{p}.norm2.weight")
        # RMSNorm has no bias; LayerNorm would. Grab non-required so both work.
        grab(f"{p}.norm1.bias", f"{p}.norm1.bias", required=False)
        grab(f"{p}.norm2.bias", f"{p}.norm2.bias", required=False)

    # ---- Write container: [8B header_len][header JSON][raw float32 data] ----
    header = {"config": {**{k: v for k, v in preset.items() if k not in ("hf_repo", "checkpoint_filename")}}, "tensors": {}}
    blobs = []
    offset = 0
    for name, arr in tensors.items():
        flat = arr.reshape(-1).astype("<f4")
        n_bytes = flat.nbytes
        header["tensors"][name] = {"shape": list(arr.shape), "offset": offset, "length": int(flat.size)}
        blobs.append(flat.tobytes())
        offset += n_bytes

    header_bytes = json.dumps(header).encode("utf-8")
    with open(out_path, "wb") as f:
        f.write(struct.pack("<Q", len(header_bytes)))
        f.write(header_bytes)
        for blob in blobs:
            f.write(blob)

    total_mb = out_path.stat().st_size / (1024 * 1024)
    print(f"\nWrote {out_path}  ({total_mb:.1f} MB, {len(tensors)} tensors, model={preset['alias']})")
    print("Place this .bin file where the web app asks for it (or just pick it")
    print("with the 'Load engine' file picker -- it will be cached for offline use).")


if __name__ == "__main__":
    main()
