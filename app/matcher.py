"""Match faces found in a group photo against the known-people gallery."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

# Cosine similarity at or above this = same person. Tuned on test data
# (see scripts/evaluate.py); the user can also change it with a slider in the UI.
DEFAULT_THRESHOLD = 0.35


@dataclass
class Match:
    face_index: int
    name: str | None  # None => unknown
    score: float  # cosine similarity to the assigned / best candidate
    best_guess: str | None  # closest gallery name even when below threshold


def match_faces(
    probe: np.ndarray, gallery: np.ndarray, names: list[str], threshold: float = DEFAULT_THRESHOLD
) -> list[Match]:
    """One-to-one assignment between probe faces and gallery people.

    A person can appear only once in a photo, so we assign greedily from the
    most similar (face, person) pair downwards. This stops two look-alike faces
    both being labelled with the same name.
    """
    n = len(probe)
    if n == 0:
        return []
    if len(gallery) == 0:
        return [Match(i, None, 0.0, None) for i in range(n)]

    sims = probe @ gallery.T  # embeddings are L2-normalised
    best_idx = sims.argmax(1)
    matches = [Match(i, None, float(sims[i, best_idx[i]]), names[best_idx[i]]) for i in range(n)]

    used_faces: set[int] = set()
    used_people: set[int] = set()
    for flat in np.argsort(-sims, axis=None):
        i, j = divmod(int(flat), sims.shape[1])
        if sims[i, j] < threshold:
            break
        if i in used_faces or j in used_people:
            continue
        used_faces.add(i)
        used_people.add(j)
        matches[i] = Match(i, names[j], float(sims[i, j]), names[j])
    return matches
