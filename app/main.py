"""Local web server: serves the UI and the two recognition endpoints.

Run:  python -m app.main     (then open http://127.0.0.1:8000)

Everything happens on this machine. Nothing is sent anywhere.

Built on Starlette (pure Python) rather than FastAPI: FastAPI needs the
compiled `pydantic_core` module, which Windows Smart App Control blocked on
the demo laptop.
"""
from __future__ import annotations

import base64
import hashlib
import re
import threading
import uuid
import webbrowser
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .face_engine import Face, FaceEngine, load_image
from .matcher import DEFAULT_THRESHOLD, match_faces

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
MAX_DISPLAY_SIDE = 2000  # group photo is re-encoded at most this big for the browser
MIN_RELIABLE_FACE = 40  # px; smaller faces get a "low quality" flag

engine: FaceEngine | None = None
engine_lock = threading.Lock()


def get_engine() -> FaceEngine:
    global engine
    with engine_lock:
        if engine is None:
            engine = FaceEngine()
        return engine


# --------------------------------------------------------------------------- #
# In-memory state (single local user, so a module-level store is enough)
# --------------------------------------------------------------------------- #
@dataclass
class Person:
    name: str
    embedding: np.ndarray
    thumb: str


class State:
    def __init__(self) -> None:
        self.people: list[Person] = []
        self.embedding_cache: dict[str, tuple[np.ndarray | None, int, str | None]] = {}
        self.results: OrderedDict[str, tuple[np.ndarray, int]] = OrderedDict()  # result_id -> probes

    def gallery(self) -> tuple[np.ndarray, list[str]]:
        if not self.people:
            return np.zeros((0, 512), dtype=np.float32), []
        return np.stack([p.embedding for p in self.people]), [p.name for p in self.people]

    def remember_result(self, probes: np.ndarray, gallery_version: int) -> str:
        rid = uuid.uuid4().hex
        self.results[rid] = (probes, gallery_version)
        while len(self.results) > 20:
            self.results.popitem(last=False)
        return rid


state = State()
gallery_version = 0


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def name_from_filename(filename: str) -> str:
    """'priya_sharma.jpg' / 'folder/Priya Sharma.jpg' -> 'Priya Sharma'."""
    stem = Path(filename.replace("\\", "/")).stem
    stem = re.sub(r"[_\.]+", " ", stem)
    stem = re.sub(r"\s+", " ", stem).strip()
    if stem.islower() or stem.isupper():
        stem = stem.title()
    return stem or "Unnamed"


def face_thumb(img: np.ndarray, face: Face, size: int = 96) -> str:
    x1, y1, x2, y2 = face.box
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    half = max(x2 - x1, y2 - y1) * 0.75
    h, w = img.shape[:2]
    a, b = int(max(0, cx - half)), int(max(0, cy - half))
    c, d = int(min(w, cx + half)), int(min(h, cy + half))
    crop = img[b:d, a:c]
    if crop.size == 0:
        return ""
    crop = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return "data:image/jpeg;base64," + base64.b64encode(buf).decode() if ok else ""


def image_data_url(img: np.ndarray, quality: int = 88) -> str:
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return "data:image/jpeg;base64," + base64.b64encode(buf).decode()


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        self.status, self.message = status, message


def build_matches(probes: np.ndarray, threshold: float) -> list[dict]:
    gallery, names = state.gallery()
    return [
        {"index": m.face_index, "name": m.name, "score": round(m.score, 3), "best_guess": m.best_guess}
        for m in match_faces(probes, gallery, names, threshold)
    ]


def parse_threshold(value) -> float:
    try:
        t = float(value)
    except (TypeError, ValueError):
        return DEFAULT_THRESHOLD
    return min(max(t, 0.0), 1.0)


# --------------------------------------------------------------------------- #
# Core work (synchronous; run in a worker thread so the server stays responsive)
# --------------------------------------------------------------------------- #
def do_load_gallery(files: list[tuple[str, bytes]]) -> dict:
    """Replace the known-people gallery with the images from the chosen folder."""
    global gallery_version
    eng = get_engine()
    people: list[Person] = []
    issues: list[dict] = []
    seen: set[str] = set()

    for filename, data in files:
        name = name_from_filename(filename)
        key = hashlib.sha1(data).hexdigest()
        if key in state.embedding_cache:
            emb, n_faces, thumb = state.embedding_cache[key]
        else:
            try:
                img = load_image(data)
            except Exception:  # noqa: BLE001
                issues.append({"name": name, "file": filename, "problem": "Could not read this image"})
                continue
            face, n_faces = eng.detect_reference(img)
            emb = face.embedding if face is not None else None
            thumb = face_thumb(img, face) if face is not None else None
            state.embedding_cache[key] = (emb, n_faces, thumb)

        if emb is None:
            issues.append({"name": name, "file": filename, "problem": "No face found"})
            continue
        if n_faces > 1:
            issues.append({"name": name, "file": filename,
                           "problem": f"{n_faces} faces found, used the largest one", "warning": True})
        if name in seen:
            issues.append({"name": name, "file": filename,
                           "problem": "Same name as another photo, both photos used", "warning": True})
        seen.add(name)
        people.append(Person(name=name, embedding=emb, thumb=thumb or ""))

    if not people:
        raise ApiError(400, "No usable face photos were found in that folder.")

    # Several photos of one person: average their embeddings into one template.
    merged: dict[str, list[Person]] = {}
    for p in people:
        merged.setdefault(p.name, []).append(p)
    new_people = []
    for name, ps in merged.items():
        emb = np.mean([p.embedding for p in ps], axis=0)
        new_people.append(Person(name=name, embedding=emb / np.linalg.norm(emb), thumb=ps[0].thumb))
    new_people.sort(key=lambda p: p.name.lower())
    state.people = new_people
    gallery_version += 1

    return {
        "count": len(state.people),
        "people": [{"name": p.name, "thumb": p.thumb} for p in state.people],
        "issues": issues,
    }


def do_identify(filename: str, data: bytes, threshold: float) -> dict:
    """Detect every face in the group photo and name it (or 'unknown')."""
    if not state.people:
        raise ApiError(400, "Open the folder of known people first.")
    try:
        img = load_image(data)
    except Exception:  # noqa: BLE001
        raise ApiError(400, f"Could not read '{filename}' as an image.") from None
    faces = get_engine().detect_group(img)

    h, w = img.shape[:2]
    scale = min(1.0, MAX_DISPLAY_SIDE / max(h, w))
    display = cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img

    probes = np.stack([f.embedding for f in faces]) if faces else np.zeros((0, 512), dtype=np.float32)
    result_id = state.remember_result(probes, gallery_version)
    matches = build_matches(probes, threshold)

    return {
        "result_id": result_id,
        "image": image_data_url(display),
        "width": display.shape[1],
        "height": display.shape[0],
        "faces": [
            {
                **m,
                "box": [round(float(v) * scale, 1) for v in f.box],
                "thumb": face_thumb(img, f),
                "low_quality": min(f.width, f.height) < MIN_RELIABLE_FACE,
            }
            for f, m in zip(faces, matches)
        ],
    }


# --------------------------------------------------------------------------- #
# HTTP handlers
# --------------------------------------------------------------------------- #
async def status(request: Request) -> JSONResponse:
    return JSONResponse({"people": len(state.people), "default_threshold": DEFAULT_THRESHOLD})


async def load_gallery(request: Request) -> JSONResponse:
    form = await request.form(max_files=5000, max_fields=5000)
    files = []
    for f in form.getlist("files"):
        if isinstance(f, UploadFile) and Path(f.filename or "").suffix.lower() in IMAGE_EXTS:
            files.append((f.filename or "", await f.read()))
    if not files:
        return JSONResponse({"error": "That folder has no photos (.jpg, .png, .webp)."}, 400)
    return JSONResponse(await run_in_threadpool(do_load_gallery, files))


async def identify(request: Request) -> JSONResponse:
    form = await request.form()
    photo = form.get("photo")
    if not isinstance(photo, UploadFile):
        return JSONResponse({"error": "Please choose a group photo."}, 400)
    data = await photo.read()
    threshold = parse_threshold(form.get("threshold"))
    return JSONResponse(await run_in_threadpool(do_identify, photo.filename or "photo", data, threshold))


async def rematch(request: Request) -> JSONResponse:
    """Re-run matching at a new threshold without re-detecting faces (slider)."""
    body = await request.json()
    rid = body.get("result_id")
    if rid not in state.results:
        return JSONResponse({"error": "Result expired, please upload the photo again."}, 404)
    probes, version = state.results[rid]
    if version != gallery_version:
        return JSONResponse({"error": "The folder changed, please upload the photo again."}, 409)
    return JSONResponse({"matches": build_matches(probes, parse_threshold(body.get("threshold")))})


async def index(request: Request) -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


async def api_error(request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse({"error": exc.message}, exc.status)


app = Starlette(
    routes=[
        Route("/", index),
        Route("/api/status", status),
        Route("/api/gallery", load_gallery, methods=["POST"]),
        Route("/api/identify", identify, methods=["POST"]),
        Route("/api/rematch", rematch, methods=["POST"]),
        Mount("/static", StaticFiles(directory=STATIC_DIR), name="static"),
    ],
    exception_handlers={ApiError: api_error},
)


def main() -> None:
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    print("Loading face models...")
    get_engine()
    url = f"http://127.0.0.1:{args.port}"
    print(f"Ready. Open {url}")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
