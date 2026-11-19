"""Measure accuracy on data/known + data/groups and sweep the 'unknown' threshold.

Usage: python scripts/evaluate.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.face_engine import FaceEngine, load_image  # noqa: E402
from app.matcher import match_faces  # noqa: E402


def iou_center(box, truth_box) -> bool:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return truth_box[0] <= cx <= truth_box[2] and truth_box[1] <= cy <= truth_box[3]


def main() -> None:
    engine = FaceEngine()
    known_dir, groups_dir = ROOT / "data" / "known", ROOT / "data" / "groups"

    t0 = time.time()
    names, embs = [], []
    for p in sorted(known_dir.iterdir()):
        face, n = engine.detect_reference(load_image(p.read_bytes()))
        if face is None:
            print("  no face in", p.name)
            continue
        names.append(p.stem)
        embs.append(face.embedding)
    gallery = np.stack(embs)
    print(f"Gallery: {len(names)} people in {time.time() - t0:.1f}s")

    groups = []
    t0 = time.time()
    for img_path in sorted(groups_dir.glob("*.jpg")):
        truth = json.loads(img_path.with_suffix(".json").read_text())
        faces = engine.detect_group(load_image(img_path.read_bytes()))
        groups.append((truth, faces))
    print(f"Detected faces in {len(groups)} groups in {time.time() - t0:.1f}s")

    total_truth = sum(len(t) for t, _ in groups)
    found = sum(sum(any(iou_center(f.box, t["box"]) for f in faces) for t in truth) for truth, faces in groups)
    extra = sum(sum(not any(iou_center(f.box, t["box"]) for t in truth) for f in faces) for truth, faces in groups)
    print(f"Detection: {found}/{total_truth} faces found, {extra} false detections\n")

    print(" thresh | known correct | known->unknown | wrong name | unknown correct | unknown->named")
    for thr in np.arange(0.20, 0.56, 0.05):
        kc = ku = kw = uc = un = 0
        for truth, faces in groups:
            if not faces:
                continue
            ms = match_faces(np.stack([f.embedding for f in faces]), gallery, names, float(thr))
            for t in truth:
                hit = [m for f, m in zip(faces, ms) if iou_center(f.box, t["box"])]
                if not hit:
                    continue
                m = hit[0]
                if t["name"]:
                    if m.name == t["name"]:
                        kc += 1
                    elif m.name is None:
                        ku += 1
                    else:
                        kw += 1
                else:
                    uc += m.name is None
                    un += m.name is not None
        nk, nu = kc + ku + kw, uc + un
        print(f"  {thr:.2f}  | {kc:3d}/{nk} {kc / nk:6.1%} | {ku:4d}          | {kw:4d}       |"
              f" {uc:3d}/{nu} {uc / nu:6.1%}  | {un:4d}")


if __name__ == "__main__":
    main()
