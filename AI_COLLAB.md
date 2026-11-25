# AI Collaboration

I built this with **Claude Code** (Claude Opus 5.5) in VS Code, in one continuous session, starting from the brief PDF. Below is how we reached a shared understanding, the key decisions, who suggested what, and the evidence. The full chat history is in [`chat-history/`](chat-history/).

**How I worked with the AI:**
- I made it **explain the plan before building**.
- It had to **offer options with trade-offs** instead of choosing silently.
- I tested its claims against **measured results and screenshots**, not its word.
- I made the **product decisions** myself: the engine, the app form, the layout, the quality bar, what counts as "done".

---

## Decision 1: Plan first, then build

- **AI suggested:** straight after reading the brief, it started setting up the laptop (installing Git and Python) and was about to start coding.
- **I decided:** stop and explain the whole plan first: the pipeline, the tech, how "unknown" works, the test data and the order of work.
- **Why:** the brief judges "understanding of the problem". I wanted to agree on the approach before any code existed, so I could change it cheaply.
- **Evidence:** chat excerpt #1. The AI wrote out the plan (pipeline → threshold → one-name-per-face → UI → docs) and only continued after I said "go with step 1".

## Decision 2: Face recognition engine

- **AI suggested:** three options with trade-offs:
  - SCRFD + ArcFace through ONNX (recommended);
  - OpenCV YuNet + SFace (easiest install);
  - dlib `face_recognition` (needs C++ build tools).
- **I decided:** SCRFD + ArcFace through ONNX.
- **Why:** the demo is a *real* group photo with strangers in it, so accuracy on small, angled faces matters most. Running the ONNX files directly avoids the C++ compiler problem on Windows.
- **Evidence:** on 20 test group photos, 205/205 faces were detected, 148/148 known people were named correctly and 57/57 strangers were marked unknown. See [RESEARCH.md §2 and §4](RESEARCH.md).

## Decision 3: How office staff use it

- **AI suggested:** a local web app (recommended), a desktop window (pywebview) or Streamlit.
- **I decided:** a local web app: one command, then everything happens in the browser.
- **Why:** office staff shouldn't touch a terminal. The browser has a built-in folder picker. Streamlit looks generic, and the UI is scored.
- **Evidence:** `run.bat` opens the browser; no terminal steps are needed after setup.

## Decision 4: Where the test data comes from

- **AI suggested:** I asked where test data could come from, since the brief gives none. It compared LFW, Pins/CelebA, Wikimedia Commons group photos, WIDER FACE and Gemini-generated people.
- **I decided:** LFW for a measurable test set: a 50-person folder plus collage group photos that use *different* photos of the same people, with strangers added. Real group photos are for a final check.
- **Why:** with LFW every right answer is known, so I can measure accuracy and tune the "unknown" threshold instead of guessing. Gemini faces aren't consistent between images, so they'd give misleading accuracy.
- **Evidence:** chat excerpt #2; `scripts/make_test_data.py`, `scripts/evaluate.py`, the threshold sweep table in RESEARCH.md.

## Decision 5: Changing course when the AI's choice failed on my laptop

- **AI suggested:** FastAPI for the server.
- **What happened:** on my laptop, Windows **Smart App Control blocked** FastAPI's compiled dependency: `ImportError: DLL load failed while importing _pydantic_core: An Application Control policy has blocked this file.`
- **I decided:** accept the AI's proposed fix: move to **Starlette** (pure Python, what FastAPI is built on) and drop the optional compiled extras, rather than trying other package versions and hoping one gets through.
- **Why:** the demo runs **on this laptop**. A fix that depends on which DLLs Windows happens to allow could break live in front of the examiners.
- **Evidence:** commit `48f9ec1` (the reason is in the commit message); before the change, the AI tested which modules load and only `pydantic_core` failed.

## Decision 6: UI layout (I overrode the AI's recommendation)

- **AI suggested:** its own plan was a three-panel workspace: inputs on the left, photo in the middle, results on the right.
- **I decided:** I asked "what different options do you have?". It showed 4 layouts with mock-ups (three-panel, wizard, photo-first, hybrid), and I picked **C: photo-first, results below**.
- **Why:** the photo *is* the answer, so it should be the biggest thing on screen. Cards underneath work like a contact sheet, which reads well when screen-sharing in the demo.
- **Evidence:** chat excerpt #3; commit `00e85b8`.

## Decision 7: Raising the UI quality bar

- **AI suggested:** a clean but plain first version (system fonts, flat cards).
- **I decided:** partway through, I told it I wanted "a very beautiful UI that actually feels attractive, UI and UX both".
- **Why:** UI/UX is a judging criterion, and non-technical users judge an app by how it feels.
- **What changed because of this:**
  - a bundled Inter font (still offline) and a dark "lightbox" stage for the photo;
  - a scanning animation while faces are found, and name tags that animate in;
  - a spotlight on the face when you hover its card;
  - "Strong / Good / Weak match" wording and a "Might be X?" hint for close unknowns;
  - paste with Ctrl+V, drag and drop anywhere, and upload progress.
- **Evidence:** commit `00e85b8`. The AI checked the result by driving the real app in Edge and taking screenshots (light and dark, desktop and mobile). From those screenshots it found and fixed overlapping name tags, numbering that jumped around, and a toast covering buttons.

## Decision 8: Numbering, and one name per person

- **AI suggested:** faces numbered left to right; each name assigned to at most one face.
- **I decided:**
  - Numbering: after seeing screenshots where #2 was top-left and #1 bottom-left, number faces **in reading order** (row by row).
  - Names: keep one-to-one assignment. When I asked "what if I want to match multiple people in a single photo?", it explained that every face is matched separately and a name is used once per photo. I agreed, because a real person can't appear twice.
- **Why:** staff read a group photo row by row. Duplicate names between look-alikes are worse than an honest "unknown".
- **Evidence:** `app/face_engine.py` `reading_order()`, `app/matcher.py` `match_faces()`.

## Decision 9: Checking the work against the brief

- **AI suggested:** keep building features and test on real photos.
- **I decided:** stop and audit everything against the brief, point by point.
- **Why:** a working app isn't the deliverable; the brief also requires four docs.
- **Evidence:** the audit found 3 docs missing and the README nearly empty, and showed the deadline had already passed. This file, RESEARCH.md, ARCHITECTURE.md and the README came from that audit. That was my mistake in time management: I should have asked for the docs alongside the code.

---

## Chat excerpts

### Chat excerpt #1: getting the plan before code (Decision 1)
> **me:** first tell me how are we planning to do this task.
>
> **AI:** Git and Python 3.11 are now installed. I've paused there so you can check the plan before any code gets written. … The app runs fully offline on your laptop. Office staff open a folder of 50 named photos, upload one group photo, and see a name or "unknown" on every face, plus a list. … Each group face is compared with all 50 known faces. If the closest match is similar enough, it gets that name; otherwise it's marked **unknown**. Each person in the folder can be assigned to at most one face … Shall I go ahead with step 1, or would you change anything first?
>
> **me:** where can we get the test data? and go with step 1

### Chat excerpt #2: test data (Decision 4)
> **me:** where can we get the test data?
>
> **AI:** … **LFW (Labeled Faces in the Wild)** … 13k photos of 5.7k named public figures … **Main source.** Pick 50 people with 2+ photos: one goes in the folder, the others go into group photos. People we leave out become the "unknowns". … **Your own photos** … Gemini faces aren't always consistent between images, so check them first.

### Chat excerpt #3: choosing the layout myself (Decisions 6 and 7)
> **AI:** Should I go ahead with that layout [three-panel], or do you want something different …?
>
> **me:** what different options do you have?
>
> **AI:** *(shows 4 mock-ups: A. Three-panel workspace · B. Guided steps (wizard) · C. Photo-first, results below · D. Hybrid)*
>
> **me:** *(selects)* C. Photo-first, results below
>
> **me (while it was building):** i want a very beautiful UI that actually feels attractive UI and UX both should be very nicely working and aesthetic

---

## Full chat history

The complete conversation, from my very first prompt (the brief PDF plus the repo link), is in [`chat-history/`](chat-history/).
