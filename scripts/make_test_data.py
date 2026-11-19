"""Build practice data from LFW (Labeled Faces in the Wild).

Dev-time only: never used by the app at runtime.

Creates:
  data/known/<First Last>.jpg      50 people, one photo each (the "folder")
  data/groups/group_XX.jpg         collage group photos of ~10 people
  data/groups/group_XX.json        ground truth: box + true name (or null = not in folder)

Each group photo uses a DIFFERENT photo of a known person than the one in the
folder (as in the real demo), plus 2-4 people who are not in the folder.
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import tarfile
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LFW_URL = "https://ndownloader.figshare.com/files/5976018"  # lfw.tgz (sklearn mirror)


def ensure_lfw() -> Path:
    lfw_dir = DATA / "raw" / "lfw"
    if lfw_dir.exists():
        return lfw_dir
    archive = DATA / "raw" / "lfw.tgz"
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        print("Downloading LFW (~173 MB)...")
        urllib.request.urlretrieve(LFW_URL, archive)
    print("Extracting...")
    with tarfile.open(archive) as t:
        t.extractall(archive.parent, filter="data")
    return lfw_dir


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--known", type=int, default=50)
    ap.add_argument("--groups", type=int, default=20)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = random.Random(args.seed)

    lfw = ensure_lfw()
    people = {p.name: sorted(p.glob("*.jpg")) for p in lfw.iterdir() if p.is_dir()}
    multi = sorted(n for n, imgs in people.items() if len(imgs) >= 3)
    singles = sorted(n for n, imgs in people.items() if len(imgs) == 1)
    known = rng.sample(multi, args.known)

    known_dir, groups_dir = DATA / "known", DATA / "groups"
    for d in (known_dir, groups_dir):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)

    for n in known:
        shutil.copy(people[n][0], known_dir / f"{n.replace('_', ' ')}.jpg")

    for g in range(args.groups):
        n_known = rng.randint(6, 9)
        n_unknown = rng.randint(2, 4)
        members = [(n, rng.choice(people[n][1:])) for n in rng.sample(known, n_known)]
        members += [(None, people[n][0]) for n in rng.sample(singles, n_unknown)]
        rng.shuffle(members)

        cols = (len(members) + 1) // 2
        cell_w, cell_h = 300, 330
        canvas = Image.new("RGB", (cols * cell_w + 60, 2 * cell_h + 60), (225, 222, 215))
        truth = []
        for k, (name, path) in enumerate(members):
            row, col = divmod(k, cols)
            size = rng.randint(170, 280)
            face = Image.open(path).convert("RGB").resize((size, size))
            x = 30 + col * cell_w + rng.randint(0, cell_w - size)
            y = 30 + row * cell_h + rng.randint(0, cell_h - size)
            canvas.paste(face, (x, y))
            # LFW face sits roughly in the central 40% of the 250px image
            truth.append({
                "name": name.replace("_", " ") if name else None,
                "box": [x + size * 0.3, y + size * 0.3, x + size * 0.7, y + size * 0.75],
            })
        canvas.save(groups_dir / f"group_{g:02d}.jpg", quality=90)
        (groups_dir / f"group_{g:02d}.json").write_text(json.dumps(truth, indent=1))

    print(f"Wrote {len(known)} known people to {known_dir}")
    print(f"Wrote {args.groups} group photos to {groups_dir}")


if __name__ == "__main__":
    main()
