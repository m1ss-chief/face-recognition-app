# Research

What I looked at before choosing the solution: the problem, the existing tools, the data I could test on, and why I picked what I picked.

## 1. Understanding the problem

From the brief, and from what the demo will actually test:

| Brief says | What it means for the design |
|---|---|
| "Open **one folder** … 50 people … file name is the person's name" | **One photo per person**, so this is *one-shot* recognition. There is nothing to train; each person is described from a single image. The name comes from the file name, so it has to cope with `Priya_Sharma.jpg`, `priya sharma.JPG` and so on. |
| "Upload one group photo of about 10 people" | Faces in a group photo are **small**: often 40–100 px wide in a 4000 px photo. People are at angles, partly hidden, unevenly lit. Detection quality matters as much as recognition. |
| "Some people in the photo are **not in the folder**" | This is an **open-set** problem. The app must be able to say "nobody in the folder". A plain nearest match would wrongly name every stranger, so a **threshold** is needed. |
| "**Real** group photo", "our own folder" | The demo data is unseen. The folder photos may be ID-style headshots, selfies or crops. The system must be robust, not tuned to my test set. |
| "Fully offline", "no online APIs" | All models run locally on a laptop CPU. No cloud face APIs (AWS Rekognition, Azure Face, Gemini Vision). |
| "Easy to use and look good" | The users are office staff, not engineers: a graphical UI, no terminal, clear results. |

Typical failure modes to design against:
1. Missing small or angled faces.
2. Giving a stranger a known person's name (false accept).
3. Calling a known person "unknown" because their folder photo is very different (false reject).
4. Giving the **same name to two faces**.
5. Photos taken on a phone that show up rotated (EXIF orientation).

## 2. Face recognition options compared

Modern face recognition has two stages: **detect** faces (boxes plus 5 landmarks), then **embed** each aligned face into a vector, where the same person gives nearby vectors. Matching means comparing vectors.

| Option | What it is | Accuracy (published LFW) | Offline on a Windows laptop | Verdict |
|---|---|---|---|---|
| **InsightFace `buffalo_l`**: SCRFD-10GF + ArcFace R50 ([repo](https://github.com/deepinsight/insightface), [model zoo](https://github.com/deepinsight/insightface/tree/master/model_zoo)) | State-of-the-art open models, ONNX format | ArcFace paper reports 99.83% ([arXiv 1801.07698](https://arxiv.org/abs/1801.07698)) | Yes, via `onnxruntime` on CPU. The `insightface` pip package needs a C++ compiler on Windows, so I run the ONNX files directly. | ✅ **Chosen** |
| **OpenCV YuNet + SFace** ([opencv_zoo](https://github.com/opencv/opencv_zoo)) | Light detector and recogniser built into OpenCV | SFace about 99.4% | Yes, only `opencv-python`; models about 40 MB | Runner-up. Easiest install, but YuNet is weaker on small faces in group shots and SFace separates people less well. |
| **dlib / `face_recognition`** ([repo](https://github.com/ageitgey/face_recognition), [dlib](http://dlib.net/)) | Classic HOG/CNN detector and ResNet embedding | 99.38% (stated in its README) | Hard on Windows: needs CMake and Visual Studio build tools to compile dlib | ❌ Rejected: install risk on the demo laptop, older model, the HOG detector misses small faces |
| **DeepFace** ([repo](https://github.com/serengil/deepface)) | A Python wrapper over many models (VGG-Face, FaceNet, ArcFace…) | Depends on the chosen model | Pulls in TensorFlow (large) and downloads weights on first use | ❌ Rejected: heavy, and a hidden download at first run would break "offline at the demo" |
| **facenet-pytorch** (MTCNN + FaceNet) ([repo](https://github.com/timesler/facenet-pytorch)) | PyTorch MTCNN detector and FaceNet embeddings | About 99.6% | Needs PyTorch (about 1 GB+ install) | ❌ Rejected: big install, slower MTCNN, no accuracy advantage over ArcFace |
| **CompreFace** ([repo](https://github.com/exadel-inc/CompreFace)) | Self-hosted face recognition service | Uses InsightFace/FaceNet internally | Runs as several Docker containers | ❌ Rejected: Docker on a Windows laptop is heavy and fragile for a live demo, and it's a service, not an app |
| Cloud APIs (AWS Rekognition, Azure Face, Gemini) | Hosted APIs | High | **No** | ❌ Not allowed by the brief |

I also looked at how photo apps solve the same "who is this face" problem offline. [Immich](https://github.com/immich-app/immich), a self-hosted photo library, uses InsightFace `buffalo_l` models (detection and ArcFace) through ONNX Runtime for its face recognition. That supported the choice: the same models are proven in a real, widely used offline product.

**Why SCRFD + ArcFace won:**
- the best accuracy available offline;
- SCRFD ([arXiv 2105.04714](https://arxiv.org/abs/2105.04714)) is strong on small faces (it was designed around WIDER FACE "hard");
- it runs on CPU with only `onnxruntime`, with no compiler, no TensorFlow and no PyTorch.

**Downside:** the pretrained weights are licensed for non-commercial research. That suits a take-home task. A commercial version would need a licence or a permissively licensed model (for example OpenCV SFace, Apache-2.0).

## 3. Matching design choices

| Question | Options considered | Picked | Why |
|---|---|---|---|
| How to compare faces | Euclidean distance, cosine similarity, a trained classifier (SVM/kNN) | **Cosine similarity** of L2-normalised ArcFace embeddings | ArcFace is trained for cosine. A classifier needs several photos per person; we have one. |
| How to say "unknown" | Nearest match only; a fixed threshold; an adjustable threshold | **Threshold (default 0.35), adjustable with a slider in the UI** | Open-set problem. Unseen demo photos may differ in quality, so a person can adjust it live. |
| Two faces matching the same person | Allow duplicates; one-to-one assignment | **One-to-one** (greedy, highest similarity first) | A person can't appear twice in one photo. Removes a whole class of errors with look-alikes. |
| Face alignment | Crop the box; 5-point similarity transform | **5-point Umeyama similarity transform** to the standard 112×112 ArcFace template | ArcFace expects aligned input; cropping only the box noticeably lowers similarity. |
| Robustness tweaks | — | Flip-averaged embeddings, EXIF auto-rotate, a higher detector resolution (960/1280) for big photos, padding retry for tight headshots | Cheap fixes for the failure modes in §1. |

## 4. Data sources for testing

The brief gives no data. I compared:

| Source | Contents | Use |
|---|---|---|
| **LFW**, Labeled Faces in the Wild ([site](https://vis-www.cs.umass.edu/lfw/); downloaded via the [scikit-learn figshare mirror](https://ndownloader.figshare.com/files/5976018)) | 13k photos of 5.7k named public figures, many with several photos | ✅ **Used.** 50 people with 3+ photos form the folder (photo #1). Group photos are collages of *other* photos of them, plus people with a single photo as strangers. Every right answer is known, so accuracy can be measured. |
| WIDER FACE ([site](http://shuoyang1213.me/WIDERFACE/)) | Crowd photos with face boxes, no names | Detection only; not used for recognition |
| CelebA / VGGFace2 | Large celebrity datasets | Bigger downloads than needed; LFW was enough for tuning |
| Wikimedia Commons group photos (summits, teams) | Real group photos of named people | Planned as a realism check (see limitations) |
| Gemini-generated people (allowed by the brief for practice data) | Synthetic faces | Not used: generated "same person" images are often not consistent between images, which would produce misleading accuracy |

**Result** (`scripts/evaluate.py`, 20 group photos, 205 faces):

| Threshold | Known named correctly | Strangers marked unknown |
|---|---|---|
| 0.25 | 148/148 | 57/57 |
| **0.35 (default)** | **148/148** | **57/57** |
| 0.45 | 146/148 | 57/57 |
| 0.55 | 135/148 | 57/57 |

- There is a wide safe range (0.25–0.40). I picked 0.35, the middle of it, because real photos will score lower than collages.
- Same-person scores were mostly 0.6–0.8, with a few between 0.35 and 0.45. Different-person scores were all below 0.25.

## 5. App platform options

| Option | Verdict |
|---|---|
| Command-line tool | ❌ Office staff need a UI |
| Streamlit / Gradio | ❌ Quick, but generic-looking, and the brief scores the UI |
| Desktop window (pywebview / Electron) | ❌ More dependencies and harder to debug in a live demo |
| **Local web app** (Python server + one HTML page, opened in the browser) | ✅ One command, polished UI, the browser's own folder picker (`<input webkitdirectory>`), no build step |
| Web framework: FastAPI vs **Starlette** | Started with FastAPI. **Windows Smart App Control blocked** its compiled dependency `pydantic_core` on this laptop ("An Application Control policy has blocked this file"). Moved to Starlette, the pure-Python framework FastAPI is built on. Same features, no blocked DLL. See [Smart App Control](https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003). |

## 6. Key references

- Deng et al., *ArcFace: Additive Angular Margin Loss for Deep Face Recognition*, CVPR 2019: https://arxiv.org/abs/1801.07698
- Guo et al., *Sample and Computation Redistribution for Efficient Face Detection* (SCRFD), 2021: https://arxiv.org/abs/2105.04714
- Huang et al., *Labeled Faces in the Wild*, 2007: https://vis-www.cs.umass.edu/lfw/
- Umeyama, *Least-squares estimation of transformation parameters between two point patterns*, IEEE TPAMI 1991 (used for face alignment)
- ONNX Runtime: https://onnxruntime.ai/
- Starlette: https://www.starlette.io/
