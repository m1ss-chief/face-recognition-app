# AI Collaboration

I used **Claude Code** in VS Code as a coding assistant on this project. I set the direction, made the product and technical decisions, and checked every result myself. The assistant mostly helped with research, writing code faster and testing.

**How I worked:**
- I agreed the plan before any code was written.
- When there was a real choice, I asked for options with trade-offs and picked one myself.
- I trusted measured results and screenshots, not claims.
- I decided the engine, the app form, the layout, the quality bar and what counts as "done".

---

## Key decisions

### 1. Plan first, then build
I paused setup and wrote out the full approach first: pipeline, tech, how "unknown" works, test data and order of work. The brief judges understanding of the problem, and changing a plan is cheaper than changing code.

### 2. Face recognition engine
I compared SCRFD + ArcFace (ONNX), OpenCV YuNet + SFace, and dlib `face_recognition`, and chose **SCRFD + ArcFace through ONNX**. The demo uses a real group photo with strangers, so accuracy on small, angled faces matters most, and running the ONNX files directly avoids needing C++ build tools on Windows.
*Result:* on 20 test group photos, 205/205 faces detected, 148/148 known people named correctly, 57/57 strangers marked unknown ([RESEARCH.md §2 and §4](RESEARCH.md)).

### 3. How office staff use it
I chose a **local web app** over a desktop window or Streamlit: one command, then everything happens in the browser. Staff never touch a terminal, the browser has a folder picker, and Streamlit looks generic. `run.bat` opens the browser.

### 4. Test data
The brief gives no data, so I built a measurable test set from **LFW**: a 50-person folder plus collage group photos using *different* photos of the same people, with strangers added. Every right answer is known, so I could measure accuracy and tune the "unknown" threshold instead of guessing. I ruled out AI-generated faces because they aren't consistent between images. See `scripts/make_test_data.py`, `scripts/evaluate.py` and the threshold sweep in RESEARCH.md.

### 5. Switching from FastAPI to Starlette
Windows **Smart App Control blocked** FastAPI's compiled dependency on my laptop (`DLL load failed while importing _pydantic_core`). Rather than trying package versions until one got through, I moved to **Starlette** (pure Python, what FastAPI is built on). The demo runs on this laptop, so the fix can't depend on which DLLs Windows happens to allow. See commit `48f9ec1`.

### 6. UI layout
I reviewed four layouts (three-panel, wizard, photo-first, hybrid) and picked **photo-first, results below**. The photo *is* the answer, so it should be the biggest thing on screen, and the cards underneath read well when screen-sharing. Commit `00e85b8`.

### 7. Raising the UI quality bar
The first version was clean but plain. Since UI/UX is judged and non-technical users judge an app by how it feels, I pushed for more polish: bundled Inter font (still offline), a dark stage for the photo, a scanning animation, animated name tags, a spotlight on hover, "Strong / Good / Weak match" wording, a "Might be X?" hint, Ctrl+V paste, drag and drop and upload progress. I checked it in Edge in light/dark and desktop/mobile, which caught overlapping name tags, jumping numbers and a toast covering buttons.

### 8. Numbering and one name per person
- Faces are numbered **in reading order** (row by row), because that's how staff read a group photo. I changed this after seeing #2 top-left and #1 bottom-left.
- Each name is used **at most once per photo**. A real person can't appear twice, and a duplicate name between look-alikes is worse than an honest "unknown".

See `reading_order()` in `app/face_engine.py` and `match_faces()` in `app/matcher.py`.

### 9. Auditing against the brief
Before polishing further, I checked the work against the brief point by point. A working app isn't the whole deliverable, and the audit showed three docs missing and a thin README. That was my time-management mistake: I should have written the docs alongside the code. This file, RESEARCH.md, ARCHITECTURE.md and the README came from that audit.

### 10. Redesign to my own spec
The single-page version still looked generic, so I wrote a full design spec: a sidebar app called "Who's In?" with a forest green / ivory / amber palette, Manrope + DM Sans, an Overview dashboard, a 3-step Identify wizard, People Library and Recent Sessions pages, CSV export, label toggles and an "Unrecognised faces" section.
- I kept plain HTML/CSS/JS instead of React + Vite + Tailwind, because Node.js isn't on the demo laptop. Fonts and Lucide icons are bundled locally so the app stays offline.
- Nothing is faked: processing shows only real stages, "confidence" is the real similarity score, and since the browser hides a folder's full path, the app says so instead of inventing one.
- Testing at desktop, tablet and phone widths caught a misleading "closest match" on a face with 0.08 similarity, a collapsed results panel and sideways scrolling on phones.
