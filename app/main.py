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
import time
import uuid
import webbrowser
from collections import OrderedDict
from dataclasses import dataclass, field
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
MAX_SESSIONS = 30


@dataclass
class Person:
    name: str
    embedding: np.ndarray
    thumb: str
    files: list[str]
    parts: list[np.ndarray] = field(default_factory=list)  # one embedding per photo

    def rebuild(self) -> None:
        """Average the per-photo embeddings into one template."""
        emb = np.mean(self.parts, axis=0)
        self.embedding = emb / np.linalg.norm(emb)


@dataclass
class Session:
    """One analysed group photo, kept in memory until the app is closed."""
    id: str
    filename: str
    created: float
    probes: np.ndarray
    gallery_version: int
    threshold: float
    image: str
    preview: str
    width: int
    height: int
    faces: list[dict]

    def counts(self) -> dict:
        known = sum(1 for f in self.faces if f["name"])
        return {"faces": len(self.faces), "identified": known, "unknown": len(self.faces) - known}

    def summary(self) -> dict:
        marks = [[round(f["box"][0] / self.width, 4), round(f["box"][1] / self.height, 4),
                  round(f["box"][2] / self.width, 4), round(f["box"][3] / self.height, 4), bool(f["name"])]
                 for f in self.faces]
        return {"id": self.id, "filename": self.filename, "created": self.created,
                "preview": self.preview, "threshold": self.threshold, "marks": marks, **self.counts()}

    def full(self) -> dict:
        return {"result_id": self.id, "session_id": self.id, "filename": self.filename,
                "created": self.created, "threshold": self.threshold, "image": self.image,
                "width": self.width, "height": self.height, "faces": self.faces,
                "stale": self.gallery_version != gallery_version}


class State:
    def __init__(self) -> None:
        self.people: list[Person] = []
        self.issues: list[dict] = []
        self.folder: str = ""
        self.files_received = 0
        self.embedding_cache: dict[str, tuple[np.ndarray | None, int, str | None]] = {}
        self.sessions: OrderedDict[str, Session] = OrderedDict()
        self.photos_analysed = 0

    def gallery(self) -> tuple[np.ndarray, list[str]]:
        if not self.people:
            return np.zeros((0, 512), dtype=np.float32), []
        return np.stack([p.embedding for p in self.people]), [p.name for p in self.people]

    def add_session(self, session: Session) -> None:
        self.sessions[session.id] = session
        self.photos_analysed += 1
        while len(self.sessions) > MAX_SESSIONS:
            self.sessions.popitem(last=False)

    def gallery_info(self) -> dict:
        return {
            "count": len(self.people),
            "folder": self.folder,
            "files_received": self.files_received,
            "people": [{"name": p.name, "thumb": p.thumb, "files": p.files} for p in self.people],
            "issues": self.issues,
        }


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


def base_name(path: str) -> str:
    return path.replace("\\", "/").rsplit("/", 1)[-1]


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
def read_reference(eng: FaceEngine, data: bytes) -> tuple[np.ndarray | None, int, str | None]:
    """Embedding, face count and thumbnail for one reference photo (cached by content hash)."""
    key = hashlib.sha1(data).hexdigest()
    if key not in state.embedding_cache:
        try:
            img = load_image(data)
        except Exception:  # noqa: BLE001
            raise ValueError("unreadable") from None
        face, n_faces = eng.detect_reference(img)
        state.embedding_cache[key] = (
            face.embedding if face is not None else None,
            n_faces,
            face_thumb(img, face) if face is not None else None,
        )
    return state.embedding_cache[key]


def do_load_gallery(files: list[tuple[str, bytes]]) -> dict:
    """Replace the known-people gallery with the images from the chosen folder."""
    global gallery_version
    eng = get_engine()
    people: list[Person] = []
    issues: list[dict] = []
    seen: set[str] = set()

    for filename, data in files:
        name = name_from_filename(filename)
        try:
            emb, n_faces, thumb = read_reference(eng, data)
        except ValueError:
            issues.append({"name": name, "file": filename, "problem": "Could not read this image"})
            continue
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
        people.append(Person(name=name, embedding=emb, thumb=thumb or "", files=[base_name(filename)], parts=[emb]))

    if not people:
        raise ApiError(400, "No usable face photos were found in that folder.")

    # Several photos of one person: average their embeddings into one template.
    merged: dict[str, list[Person]] = {}
    for p in people:
        merged.setdefault(p.name, []).append(p)
    new_people = []
    for name, ps in merged.items():
        person = Person(name=name, embedding=ps[0].embedding, thumb=ps[0].thumb,
                        files=[f for p in ps for f in p.files], parts=[p.embedding for p in ps])
        person.rebuild()
        new_people.append(person)
    new_people.sort(key=lambda p: p.name.lower())
    state.people = new_people
    state.issues = issues
    first = files[0][0].replace("\\", "/")
    state.folder = first.split("/", 1)[0] if "/" in first else ""
    state.files_received = len(files)
    gallery_version += 1
    return state.gallery_info()


# --------------------------------------------------------------------------- #
# Library edits. These change the in-app library only, never the files on disk.
# --------------------------------------------------------------------------- #
def clean_name(value) -> str:
    name = re.sub(r"\s+", " ", str(value or "")).strip()
    if not name:
        raise ApiError(400, "Please type a name.")
    if len(name) > 80:
        raise ApiError(400, "That name is too long (80 characters at most).")
    return name


def find_person(name: str) -> Person:
    for p in state.people:
        if p.name == name:
            return p
    raise ApiError(404, f"\u201c{name}\u201d is not in the library.")


def library_changed() -> None:
    global gallery_version
    state.people.sort(key=lambda p: p.name.lower())
    gallery_version += 1


def do_add_people(entries: list[tuple[str, str, bytes]]) -> dict:
    """Add one photo per entry (name, filename, bytes). Same name = extra photo of that person."""
    eng = get_engine()
    added, problems = [], []
    for raw_name, filename, data in entries:
        name = clean_name(raw_name or name_from_filename(filename))
        try:
            emb, n_faces, thumb = read_reference(eng, data)
        except ValueError:
            problems.append(f"{base_name(filename)}: could not read this image")
            continue
        if emb is None:
            problems.append(f"{base_name(filename)}: no face found")
            continue
        existing = next((p for p in state.people if p.name == name), None)
        if existing:
            existing.parts.append(emb)
            existing.files.append(base_name(filename))
            existing.rebuild()
        else:
            state.people.append(Person(name=name, embedding=emb, thumb=thumb or "",
                                       files=[base_name(filename)], parts=[emb]))
        if n_faces > 1:
            state.issues.append({"name": name, "file": filename,
                                 "problem": f"{n_faces} faces found, used the largest one", "warning": True})
        state.files_received += 1
        added.append(name)
    if not added:
        raise ApiError(400, "No face was found. " + "; ".join(problems))
    library_changed()
    return {**state.gallery_info(), "added": added, "problems": problems}


def do_rename(old: str, new) -> dict:
    person = find_person(old)
    new = clean_name(new)
    if new != old and any(p.name == new for p in state.people):
        raise ApiError(409, f"Someone called \u201c{new}\u201d is already in the library.")
    person.name = new
    for issue in state.issues:
        if issue["name"] == old:
            issue["name"] = new
    library_changed()
    return state.gallery_info()


def do_remove(name: str) -> dict:
    person = find_person(name)
    state.people.remove(person)
    state.issues = [i for i in state.issues if i["name"] != name or not i.get("warning")]
    library_changed()
    return state.gallery_info()


def do_clear() -> dict:
    state.people, state.issues, state.folder, state.files_received = [], [], "", 0
    library_changed()
    return state.gallery_info()


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
    matches = build_matches(probes, threshold)

    ph, pw = display.shape[:2]
    pscale = min(1.0, 480 / max(ph, pw))
    preview = cv2.resize(display, (round(pw * pscale), round(ph * pscale)), interpolation=cv2.INTER_AREA)

    session = Session(
        id=uuid.uuid4().hex,
        filename=base_name(filename),
        created=time.time(),
        probes=probes,
        gallery_version=gallery_version,
        threshold=threshold,
        image=image_data_url(display),
        preview=image_data_url(preview, 80),
        width=display.shape[1],
        height=display.shape[0],
        faces=[
            {
                **m,
                "box": [round(float(v) * scale, 1) for v in f.box],
                "thumb": face_thumb(img, f),
                "low_quality": min(f.width, f.height) < MIN_RELIABLE_FACE,
            }
            for f, m in zip(faces, matches)
        ],
    )
    state.add_session(session)
    return session.full()


# --------------------------------------------------------------------------- #
# HTTP handlers
# --------------------------------------------------------------------------- #
async def status(request: Request) -> JSONResponse:
    sessions = list(state.sessions.values())
    return JSONResponse({
        "people": len(state.people),
        "default_threshold": DEFAULT_THRESHOLD,
        "stats": {
            "photos_analysed": state.photos_analysed,
            "identified": sum(s.counts()["identified"] for s in sessions),
            "unknown": sum(s.counts()["unknown"] for s in sessions),
        },
    })


async def get_gallery(request: Request) -> JSONResponse:
    return JSONResponse(state.gallery_info())


async def clear_gallery(request: Request) -> JSONResponse:
    return JSONResponse(do_clear())


async def add_people(request: Request) -> JSONResponse:
    form = await request.form(max_files=500, max_fields=1000)
    photos, names = form.getlist("photos"), form.getlist("names")
    entries = []
    for i, f in enumerate(photos):
        if isinstance(f, UploadFile) and Path(f.filename or "").suffix.lower() in IMAGE_EXTS:
            entries.append((str(names[i]) if i < len(names) else "", f.filename or "", await f.read()))
    if not entries:
        return JSONResponse({"error": "Choose a JPG, PNG or WEBP photo of the person."}, 400)
    return JSONResponse(await run_in_threadpool(do_add_people, entries))


async def edit_person(request: Request) -> JSONResponse:
    body = await request.json()
    if request.method == "DELETE":
        return JSONResponse(do_remove(str(body.get("name", ""))))
    return JSONResponse(do_rename(str(body.get("name", "")), body.get("new_name")))


async def list_sessions(request: Request) -> JSONResponse:
    return JSONResponse({"sessions": [s.summary() for s in reversed(state.sessions.values())]})


async def get_session(request: Request) -> JSONResponse:
    s = state.sessions.get(request.path_params["sid"])
    if s is None:
        return JSONResponse({"error": "That session is no longer available. "
                                      "Sessions are kept only until the app is closed."}, 404)
    return JSONResponse(s.full())


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
    s = state.sessions.get(body.get("result_id"))
    if s is None:
        return JSONResponse({"error": "Result expired, please upload the photo again."}, 404)
    if s.gallery_version != gallery_version:
        return JSONResponse({"error": "The people folder changed since this photo was analysed. "
                                      "Run it again to use the new folder."}, 409)
    threshold = parse_threshold(body.get("threshold"))
    matches = build_matches(s.probes, threshold)
    for m in matches:
        s.faces[m["index"]].update(m)
    s.threshold = threshold
    return JSONResponse({"matches": matches})


async def index(request: Request) -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


async def api_error(request: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse({"error": exc.message}, exc.status)


app = Starlette(
    routes=[
        Route("/", index),
        Route("/api/status", status),
        Route("/api/gallery", load_gallery, methods=["POST"]),
        Route("/api/gallery", get_gallery, methods=["GET"]),
        Route("/api/gallery", clear_gallery, methods=["DELETE"]),
        Route("/api/people", add_people, methods=["POST"]),
        Route("/api/people", edit_person, methods=["PUT", "DELETE"]),
        Route("/api/sessions", list_sessions),
        Route("/api/sessions/{sid}", get_session),
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
