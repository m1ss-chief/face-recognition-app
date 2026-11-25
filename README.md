# Who's in the Photo?

**Task A** · An offline face-recognition web app for an office. Open a folder of known people, upload a group photo, and every face gets a name or is marked **Unknown**, shown on the photo and as a list.

- Runs entirely on your laptop. The only internet use is a one-time model download during setup.
- No cloud, no online APIs, no AI services inside the app.
- Works in any modern browser (Edge, Chrome, Firefox) on Windows. macOS and Linux also work using the manual steps below.

| Doc | What's in it |
|---|---|
| [RESEARCH.md](RESEARCH.md) | Options compared, what was picked and rejected, with links |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Architecture diagram and trade-offs |
| [AI_COLLAB.md](AI_COLLAB.md) | Key decisions, how I steered the AI, chat excerpts and full history |

---

## Install (once, needs internet)

**You need:** Windows 10/11, [Python 3.11](https://www.python.org/downloads/release/python-3119/) (tick "Add python.exe to PATH" during install) and about 1 GB of free disk space.

1. Download this repo: **Code → Download ZIP** and unzip it, or `git clone https://github.com/m1ss-chief/face-recognition-app`.
2. Double-click **`setup.bat`**. It will:
   - create a private Python environment in `.venv\`;
   - install the packages in `requirements.txt`;
   - download the two face models (about 275 MB) into `models\`.

After this, the internet is never used again.

<details>
<summary>Manual setup (macOS / Linux / if you prefer a terminal)</summary>

```bash
python3.11 -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python scripts/download_models.py
```
</details>

## Run (offline)

Double-click **`run.bat`**. A small black window opens (that's the app's engine, so keep it open) and your browser opens **http://127.0.0.1:8000**.

Terminal alternative: `.venv\Scripts\python -m app.main` (options: `--port 8001`, `--no-browser`).

## Use it

The app has four pages in the left sidebar: **Overview**, **Identify People**, **People Library** and **Recent Sessions**. Click **Start identification**, then:

1. **People Library: Browse folders.** Choose the folder of known people: one photo per person, with the file named after them, e.g. `Priya Sharma.jpg`.
   - JPG, PNG, WEBP and BMP are accepted. Other files are ignored.
   - Your browser asks "Upload N files to this site?". Click **Upload**. The "site" is your own computer; nothing leaves it.
   - You see the people found, and any photos that need attention (no face, several faces).
2. **Group Photograph: Choose photograph.** Pick the group photo, drop it anywhere on the window, or paste it with **Ctrl+V**. Check the preview, then click **Identify faces**.
3. **Identification Results:**
   - green numbered labels mark identified people;
   - dashed terracotta labels mark **Unknown** people, who are also shown in the *Unrecognised faces* section;
   - **People detected** lists every face in the same numbered order. Click a face in the list or on the photo to link the two and see the similarity score.
   - Use the **Labels / Identified / Unknown / Boxes** toggles to change what's drawn on the photo.
   - Move **Match strictness** to be more relaxed or more strict (the result updates instantly).
   - **Download annotated photo** saves a labelled JPG. **Export CSV** saves the list as a spreadsheet.

**People Library** shows every reference photo with search and a grid or list view. **Recent Sessions** lets you reopen earlier results; they're kept until the app is closed.

## Test it without your own photos

The repo has scripts that build a practice set from the public LFW dataset (Labeled Faces in the Wild). This uses the internet once.

```bat
.venv\Scripts\python scripts\make_test_data.py   :: builds data\known (50 people) + data\groups (20 group photos)
.venv\Scripts\python scripts\evaluate.py         :: accuracy at different strictness levels
```

- Each group photo uses a *different* photo of each known person than the one in the folder, plus 2–4 people who are not in the folder.
- `data\groups\group_XX.json` holds the ground truth.

Results on this set at the default strictness (0.35):
- **205 / 205** faces detected;
- **148 / 148** known people named correctly;
- **57 / 57** people who aren't in the folder marked Unknown.

These are collages and easier than a real group photo; see the limitations in [ARCHITECTURE.md](ARCHITECTURE.md#known-limitations).

## Troubleshooting

| Problem | Fix |
|---|---|
| `DLL load failed … An Application Control policy has blocked this file` | Windows **Smart App Control** is blocking a compiled Python package. The app avoids the package that triggered this on our laptop (`pydantic_core`). If another package is blocked, run `setup.bat` again or turn Smart App Control off. |
| `Please run setup.bat first` | Run `setup.bat` once (it needs internet). |
| `Model not found` | Run `.venv\Scripts\python scripts\download_models.py`. |
| Port 8000 already in use | `run.bat --port 8001` |
| Browser says it can't reach the app | The black `run.bat` window was closed. Start it again. |
| A known person shows as Unknown | Move **Matching strictness** towards *Relaxed*, or use a clearer, front-facing photo of them in the folder. |
| A stranger gets someone's name | Move **Matching strictness** towards *Strict*. |

## Project layout

```
app/
  face_engine.py   SCRFD face detection + ArcFace embeddings (onnxruntime, CPU)
  matcher.py       cosine similarity + one-to-one name assignment + "unknown" threshold
  main.py          local Starlette web server: /api/gallery, /api/identify, /api/rematch
static/            the UI (plain HTML/CSS/JS, no build step; bundled fonts and icons)
scripts/
  download_models.py   one-time model download (setup only)
  make_test_data.py    practice data from LFW (development only)
  evaluate.py          accuracy + threshold sweep (development only)
setup.bat / run.bat    one-click install and start
```

## Licences and credits

- Face models: InsightFace `buffalo_l` (SCRFD-10GF detector, ArcFace R50 recogniser) from [deepinsight/insightface](https://github.com/deepinsight/insightface). The pretrained models are for **non-commercial research use**, which suits this task. A commercial product would need a licence or other models; see RESEARCH.md.
- Fonts: [Manrope](https://github.com/sharanda/manrope) and [DM Sans](https://github.com/googlefonts/dm-fonts), SIL Open Font License (`static/fonts/LICENSE-*.txt`). Bundled, so no internet is needed.
- Icons: [Lucide](https://lucide.dev), ISC licence (`static/fonts/LICENSE-Lucide.txt`). Bundled in `static/icons.js`.
- Practice data: [LFW](https://vis-www.cs.umass.edu/lfw/). It is downloaded by the script and not stored in this repo.
