"""Offline face detection + recognition on CPU.

Pipeline:
    image -> SCRFD (det_10g.onnx) -> boxes + 5 landmarks
          -> similarity-align each face to the 112x112 ArcFace template
          -> ArcFace R50 (w600k_r50.onnx) -> L2-normalised 512-d embedding

Both models are the InsightFace "buffalo_l" pack, run directly with
onnxruntime so we do not need the `insightface` pip package (which needs a
C++ compiler on Windows).
"""
from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

MODELS_DIR = Path(__file__).resolve().parent.parent / "models"

# Canonical 5-point positions (eyes, nose, mouth corners) for ArcFace 112x112.
ARCFACE_DST = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


@dataclass
class Face:
    box: np.ndarray  # x1, y1, x2, y2 in original image pixels
    landmarks: np.ndarray  # 5x2
    det_score: float
    embedding: np.ndarray | None = field(default=None, repr=False)

    @property
    def width(self) -> float:
        return float(self.box[2] - self.box[0])

    @property
    def height(self) -> float:
        return float(self.box[3] - self.box[1])


# --------------------------------------------------------------------------- #
# Image loading
# --------------------------------------------------------------------------- #
def load_image(data: bytes) -> np.ndarray:
    """Decode bytes to a BGR uint8 array, honouring EXIF rotation (phone photos)."""
    img = Image.open(io.BytesIO(data))
    img = ImageOps.exif_transpose(img).convert("RGB")
    return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)


# --------------------------------------------------------------------------- #
# Geometry helpers
# --------------------------------------------------------------------------- #
def _umeyama(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Least-squares similarity transform (rotation+uniform scale+translation)."""
    n = src.shape[0]
    src_mean, dst_mean = src.mean(0), dst.mean(0)
    src_c, dst_c = src - src_mean, dst - dst_mean
    cov = dst_c.T @ src_c / n
    u, s, vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(cov) < 0:
        d[-1] = -1
    r = u @ np.diag(d) @ vt
    scale = (s * d).sum() / src_c.var(0).sum()
    t = dst_mean - scale * r @ src_mean
    m = np.zeros((2, 3), dtype=np.float32)
    m[:, :2] = scale * r
    m[:, 2] = t
    return m


def align_face(img: np.ndarray, landmarks: np.ndarray) -> np.ndarray:
    m = _umeyama(landmarks.astype(np.float32), ARCFACE_DST)
    return cv2.warpAffine(img, m, (112, 112), borderValue=0.0)


def _nms(dets: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2, scores = dets.T
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size > 0:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        iou = w * h / (areas[i] + areas[order[1:]] - w * h)
        order = order[np.where(iou <= thresh)[0] + 1]
    return keep


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #
def _session(path: Path) -> ort.InferenceSession:
    if not path.exists():
        raise FileNotFoundError(
            f"Model not found: {path}. Run `python scripts/download_models.py` once (needs internet)."
        )
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    return ort.InferenceSession(str(path), opts, providers=["CPUExecutionProvider"])


class SCRFD:
    """SCRFD-10GF detector: 3 strides, 2 anchors per location, with keypoints."""

    STRIDES = (8, 16, 32)
    NUM_ANCHORS = 2

    def __init__(self, path: Path):
        self.sess = _session(path)
        self.input_name = self.sess.get_inputs()[0].name
        self._anchor_cache: dict[tuple[int, int, int], np.ndarray] = {}

    def _anchors(self, h: int, w: int, stride: int) -> np.ndarray:
        key = (h, w, stride)
        if key not in self._anchor_cache:
            ys, xs = np.mgrid[:h, :w]
            centers = np.stack([xs, ys], axis=-1).astype(np.float32).reshape(-1, 2) * stride
            centers = np.repeat(centers, self.NUM_ANCHORS, axis=0)
            self._anchor_cache[key] = centers
        return self._anchor_cache[key]

    def detect(
        self,
        img: np.ndarray,
        input_size: int = 640,
        score_thresh: float = 0.5,
        nms_thresh: float = 0.4,
    ) -> list[Face]:
        h, w = img.shape[:2]
        scale = input_size / max(h, w)
        nh, nw = int(round(h * scale)), int(round(w * scale))
        canvas = np.zeros((input_size, input_size, 3), dtype=np.uint8)
        canvas[:nh, :nw] = cv2.resize(img, (nw, nh))
        blob = cv2.dnn.blobFromImage(
            canvas, 1.0 / 128, (input_size, input_size), (127.5, 127.5, 127.5), swapRB=True
        )
        outs = self.sess.run(None, {self.input_name: blob})

        all_boxes, all_kps, all_scores = [], [], []
        for i, stride in enumerate(self.STRIDES):
            scores = outs[i].reshape(-1)
            boxes = outs[i + 3].reshape(-1, 4) * stride
            kps = outs[i + 6].reshape(-1, 10) * stride
            fh, fw = input_size // stride, input_size // stride
            centers = self._anchors(fh, fw, stride)
            keep = np.where(scores >= score_thresh)[0]
            if keep.size == 0:
                continue
            c = centers[keep]
            b = boxes[keep]
            all_boxes.append(np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], -1))
            k = kps[keep].reshape(-1, 5, 2) + c[:, None, :]
            all_kps.append(k)
            all_scores.append(scores[keep])

        if not all_scores:
            return []
        boxes = np.concatenate(all_boxes) / scale
        kps = np.concatenate(all_kps) / scale
        scores = np.concatenate(all_scores)
        keep = _nms(np.hstack([boxes, scores[:, None]]), nms_thresh)
        faces = []
        for i in keep:
            box = boxes[i].copy()
            box[[0, 2]] = box[[0, 2]].clip(0, w)
            box[[1, 3]] = box[[1, 3]].clip(0, h)
            faces.append(Face(box=box, landmarks=kps[i], det_score=float(scores[i])))
        return faces


class ArcFace:
    def __init__(self, path: Path):
        self.sess = _session(path)
        self.input_name = self.sess.get_inputs()[0].name

    def embed(self, aligned: list[np.ndarray]) -> np.ndarray:
        """Embed aligned 112x112 BGR crops. Averages each face with its mirror image."""
        if not aligned:
            return np.zeros((0, 512), dtype=np.float32)
        crops = aligned + [cv2.flip(a, 1) for a in aligned]
        blob = cv2.dnn.blobFromImages(crops, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        feats = []
        for start in range(0, len(blob), 32):
            feats.append(self.sess.run(None, {self.input_name: blob[start : start + 32]})[0])
        feats = np.concatenate(feats)
        n = len(aligned)
        emb = feats[:n] + feats[n:]
        return emb / np.linalg.norm(emb, axis=1, keepdims=True)


def reading_order(faces: list[Face]) -> list[Face]:
    """Sort faces row by row (top to bottom), each row left to right.

    Faces whose vertical centres are within ~half a face height of the row's
    first face belong to the same row, so people in a standing back row and a
    seated front row get numbered the way a person would read the photo.
    """
    if not faces:
        return faces
    by_y = sorted(faces, key=lambda f: (f.box[1] + f.box[3]) / 2)
    rows: list[list[Face]] = []
    for f in by_y:
        cy = (f.box[1] + f.box[3]) / 2
        if rows:
            anchor = rows[-1][0]
            acy = (anchor.box[1] + anchor.box[3]) / 2
            if abs(cy - acy) < 0.6 * max(anchor.height, f.height):
                rows[-1].append(f)
                continue
        rows.append([f])
    return [f for row in rows for f in sorted(row, key=lambda f: f.box[0])]


# --------------------------------------------------------------------------- #
# Public engine
# --------------------------------------------------------------------------- #
class FaceEngine:
    def __init__(self, models_dir: Path = MODELS_DIR):
        self.detector = SCRFD(models_dir / "det_10g.onnx")
        self.recognizer = ArcFace(models_dir / "w600k_r50.onnx")

    def _embed_faces(self, img: np.ndarray, faces: list[Face]) -> list[Face]:
        embs = self.recognizer.embed([align_face(img, f.landmarks) for f in faces])
        for f, e in zip(faces, embs):
            f.embedding = e
        return faces

    def detect_group(self, img: np.ndarray, min_face: int = 16) -> list[Face]:
        """Find every face in a group photo.

        Large photos are run at a higher detector resolution (up to 1280) so that
        small faces in the back row are not lost by downscaling to 640.
        """
        long_side = max(img.shape[:2])
        size = 640 if long_side <= 800 else 1280 if long_side >= 1600 else 960
        faces = self.detector.detect(img, input_size=size)
        faces = [f for f in faces if min(f.width, f.height) >= min_face]
        return self._embed_faces(img, reading_order(faces))

    def detect_reference(self, img: np.ndarray) -> tuple[Face | None, int]:
        """Find the single subject of a reference/ID photo.

        Returns (face, number_of_faces_found). If several faces are present we
        pick the largest one; if none are found we retry with padding, which
        helps on tightly cropped head-shots where the face fills the frame.
        """
        pad = 0
        faces = self.detector.detect(img, input_size=640)
        if not faces:
            h, w = img.shape[:2]
            pad = max(h, w) // 2
            img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=0)
            faces = self.detector.detect(img, input_size=640, score_thresh=0.4)
        if not faces:
            return None, 0
        face = max(faces, key=lambda f: f.width * f.height * f.det_score)
        self._embed_faces(img, [face])
        face.box -= pad  # back to original image coordinates
        face.landmarks -= pad
        return face, len(faces)
