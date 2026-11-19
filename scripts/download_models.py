"""One-time setup: download the InsightFace buffalo_l ONNX models.

This is the ONLY step that needs internet. After it finishes, the app runs
fully offline. We keep just the two models we use:
  - det_10g.onnx   : SCRFD-10GF face detector (boxes + 5 landmarks)
  - w600k_r50.onnx : ArcFace ResNet-50 recogniser (512-d embedding)
"""
import hashlib
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
NEEDED = ["det_10g.onnx", "w600k_r50.onnx"]
MODELS_DIR = Path(__file__).resolve().parent.parent / "models"


def main() -> int:
    MODELS_DIR.mkdir(exist_ok=True)
    if all((MODELS_DIR / n).exists() for n in NEEDED):
        print("Models already present in", MODELS_DIR)
        return 0
    print("Downloading", URL, "(~280 MB, one time only)...")
    with urllib.request.urlopen(URL) as r:
        blob = r.read()
    print("Downloaded", len(blob) // (1024 * 1024), "MB, sha256", hashlib.sha256(blob).hexdigest()[:16])
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        for info in z.infolist():
            name = Path(info.filename).name
            if name in NEEDED:
                (MODELS_DIR / name).write_bytes(z.read(info))
                print("  saved", name)
    missing = [n for n in NEEDED if not (MODELS_DIR / n).exists()]
    if missing:
        print("ERROR: missing", missing)
        return 1
    print("Done. The app can now run offline.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
