/* Who's In? — front-end. Plain JS, no build step, talks only to the local server (127.0.0.1). */
(() => {
  "use strict";

  // ================================================================== helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const IMAGE_RE = /\.(jpe?g|png|webp|bmp)$/i;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = (name, cls = "") => `<svg class="ico ${cls}" viewBox="0 0 24 24" aria-hidden="true">${(window.ICONS || {})[name] || ""}</svg>`;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const pad = (n) => String(n).padStart(2, "0");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const baseName = (p) => String(p || "").split(/[\\/]/).pop();
  const fmtBytes = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1048576).toFixed(1)} MB`);
  function fmtWhen(ts) {
    const d = new Date(ts * 1000);
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
    return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
  }
  // Cosine similarity of ArcFace embeddings: same person is usually 0.4–0.8.
  const quality = (s) => (s >= 0.55 ? "Strong match" : s >= 0.42 ? "Good match" : "Weak match");

  // ================================================================== state
  const state = {
    route: null,
    gallery: null,          // { count, folder, files_received, people:[{name,thumb,files}], issues }
    folderFiles: null,      // File[] from the last chosen folder (for "Refresh")
    loadingGallery: null,   // { folder, total, pct, phase }
    galleryError: null,
    photo: null,            // { file, url, name, size, width, height, ok }
    processing: null,       // { phase: upload|analyse|done, pct }
    result: null,           // full session object from the server
    resultFromWizard: false,
    selected: null,
    show: { labels: true, identified: true, unknown: true, boxes: true },
    wizardStep: 1,
    threshold: 0.35,
    stats: null,
    sessions: null,
    libView: "grid",
    libQuery: "",
  };

  // ================================================================== server
  function markServer(ok) {
    $("#serverDot").classList.toggle("down", !ok);
    $("#serverText").textContent = ok ? "Processing locally" : "Engine not running";
    $(".local-note small").textContent = ok ? "No cloud · No external AI" : "Start it again with run.bat";
  }

  async function api(url, opts) {
    let res;
    try { res = await fetch(url, opts); } catch {
      markServer(false);
      throw new Error("The local engine is not running. Start it again with run.bat.");
    }
    markServer(true);
    let body = {};
    try { body = await res.json(); } catch { /* empty body */ }
    if (!res.ok) throw new Error(body.error || `Something went wrong (${res.status}).`);
    return body;
  }

  // XHR so uploads report real progress.
  function upload(url, form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.upload.onload = () => onProgress(1);
      xhr.onload = () => {
        markServer(true);
        const body = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Something went wrong (${xhr.status}).`));
      };
      xhr.onerror = () => { markServer(false); reject(new Error("The local engine is not running. Start it again with run.bat.")); };
      xhr.send(form);
    });
  }

  async function refreshData() {
    try {
      const [st, ss] = await Promise.all([api("/api/status"), api("/api/sessions")]);
      state.stats = st.stats;
      state.sessions = ss.sessions;
    } catch { /* keep what we had */ }
    updateNav();
  }

  function updateNav() {
    const p = state.gallery?.count || 0, s = state.sessions?.length || 0;
    $("#navPeople").hidden = !p; $("#navPeople").textContent = p;
    $("#navSessions").hidden = !s; $("#navSessions").textContent = s;
  }

  // ================================================================== toasts
  function toast(msg, kind = "ok", ms = 4200) {
    const el = document.createElement("div");
    el.className = `toast ${kind === "error" ? "error" : ""}`;
    el.innerHTML = `${ic(kind === "error" ? "triangle-alert" : "check")}<span>${esc(msg)}</span>`;
    $("#toasts").appendChild(el);
    setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 220); }, ms);
  }

  // ================================================================== router
  const render = {};
  function route() {
    const [name, arg] = (location.hash.replace(/^#\/?/, "") || "overview").split("/");
    const view = render[name] ? name : "overview";
    const changed = state.route?.name !== view || state.route?.arg !== arg;
    state.route = { name: view, arg };
    $$(".view").forEach((el) => { el.hidden = el.dataset.view !== view; });
    if (changed) {
      const el = $(`#view-${view}`);
      el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
      window.scrollTo({ top: 0 });
    }
    const navKey = view === "results" ? (state.resultFromWizard ? "identify" : "sessions") : view;
    $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === navKey));
    render[view](arg);
  }
  function refreshView() {
    const n = state.route?.name;
    if (n && n !== "results") render[n](state.route.arg);
  }
  const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };

  // ================================================================== overview
  render.overview = () => {
    const now = new Date(), h = now.getHours();
    $("#greeting").textContent = h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
    $("#todayLabel").textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    paintOverview();
    refreshData().then(() => state.route?.name === "overview" && paintOverview());
  };

  function heroVisual() {
    const s = state.sessions?.[0];
    const people = state.gallery?.people || [];
    let inner, caption;
    if (s) {
      inner = `<img src="${esc(s.preview)}" alt="">` + (s.marks || []).slice(0, 14).map((m) =>
        `<span class="mini-box${m[4] ? "" : " unknown"}" style="left:${m[0] * 100}%;top:${m[1] * 100}%;width:${(m[2] - m[0]) * 100}%;height:${(m[3] - m[1]) * 100}%"></span>`).join("");
      caption = `${s.filename} · ${s.identified} of ${s.faces} named`;
    } else if (people.length) {
      inner = `<div class="print-mosaic">${people.slice(0, 12).map((p) => `<img src="${esc(p.thumb)}" alt="">`).join("")}</div>`;
      caption = `${plural(people.length, "person", "people")} in your library`;
    } else {
      inner = `<div class="print-blank">
          <div class="sil"><span class="mini-box"><span>Identified</span></span></div>
          <div class="sil"><span class="mini-box"><span>Identified</span></span></div>
          <div class="sil"><span class="mini-box unknown"><span>Unknown</span></span></div>
        </div>`;
      caption = "Your first group photo";
    }
    return `<div class="print print-back"><div class="print-img"></div></div>
      <div class="print print-main"><div class="print-img">${inner}</div><span class="print-caption">${esc(caption)}</span></div>`;
  }

  function paintOverview() {
    $("#heroVisual").innerHTML = heroVisual();
    const g = state.gallery, st = state.stats;
    const metric = (tone, label, value, foot) => `
      <article class="metric ${tone}">
        <div class="metric-top">${label}</div>
        ${value === null ? `<div class="skel" style="height:30px;width:56px;margin-top:12px"></div>` : `<div class="metric-value">${value}</div>`}
        <div class="metric-foot">${foot}</div>
      </article>`;
    $("#metrics").innerHTML = [
      metric("", "People in library", g ? g.count : 0, g ? (g.folder ? `From “${esc(g.folder)}”` : "Reference folder loaded") : "No folder opened yet"),
      metric("", "Photos analysed", st ? st.photos_analysed : null, "Since the app was started"),
      metric("ok", "People identified", st ? st.identified : null, "Across recent sessions"),
      metric("warm", "Unknown faces", st ? st.unknown : null, "Not in your library"),
    ].join("");

    const ss = state.sessions;
    if (ss === null) {
      $("#activity").innerHTML = `<div style="padding:18px 22px;display:grid;gap:12px">${'<div class="skel" style="height:38px"></div>'.repeat(3)}</div>`;
    } else if (!ss.length) {
      $("#activity").innerHTML = `
        <div class="empty-row">
          <span class="empty-art sm">${ic("history")}</span>
          <div><b>No activity yet</b><p>Photos you analyse appear here, with how many people were recognised.</p></div>
          <a class="btn" href="#/identify">Identify a photo ${ic("arrow-right")}</a>
        </div>`;
    } else {
      $("#activity").innerHTML = `
        <table class="table">
          <thead><tr><th>Session</th><th class="hide-sm">Date &amp; time</th><th class="num">Detected</th><th class="num hide-sm">Identified</th><th class="num hide-sm">Unknown</th><th class="hide-sm">Result</th></tr></thead>
          <tbody>${ss.slice(0, 5).map((s) => `
            <tr data-act="open-session" data-id="${s.id}" tabindex="0">
              <td><div class="sess-cell"><img src="${esc(s.preview)}" alt=""><b title="${esc(s.filename)}">${esc(s.filename)}</b></div></td>
              <td class="hide-sm">${fmtWhen(s.created)}</td>
              <td class="num">${s.faces}</td>
              <td class="num hide-sm">${s.identified}</td>
              <td class="num hide-sm">${s.unknown}</td>
              <td class="hide-sm"><span class="ratio" title="${s.identified} of ${s.faces} faces named"><span style="flex:${s.identified}"></span><span class="u" style="flex:${s.unknown}"></span></span></td>
            </tr>`).join("")}
          </tbody>
        </table>`;
    }
  }

  // ================================================================== identify wizard
  function stepperItems(current, done) {
    const names = ["People Library", "Group Photograph", "Identification Results"];
    return names.map((n, i) => {
      const k = i + 1;
      const cls = k === current ? "current" : done.includes(k) ? "done" : "";
      const act = done.includes(k) && k !== current && k < 3 ? ` data-act="step" data-step="${k}"` : "";
      return `<li class="${cls}"${act}${k === current ? ' aria-current="step"' : ""}><span class="step-no">${pad(k)}</span><span class="step-name">${n}</span></li>`;
    }).join("");
  }

  const FOLDER_ART = `<div class="folder-art" aria-hidden="true"><div class="back"></div><div class="sheet"></div><div class="front"></div></div>`;

  function galleryProgressHtml() {
    const lg = state.loadingGallery;
    return `
      <div class="picker">
        ${FOLDER_ART}
        <div>
          <h2>Reading ${lg.folder ? `“${esc(lg.folder)}”` : "your folder"}</h2>
          <p>Each photo is checked for a face and turned into a face signature, on this computer.</p>
          <div class="progress">
            <div class="progress-label"><span id="gText"></span><b id="gPct"></b></div>
            <div class="bar" id="gBar"><span></span></div>
          </div>
        </div>
      </div>`;
  }
  function paintGalleryProgress() {
    const lg = state.loadingGallery;
    if (!lg || !$("#gBar")) return;
    const uploading = lg.phase === "upload";
    $("#gText").textContent = uploading ? `Uploading ${plural(lg.total, "photo")} to the local engine` : `Finding and reading ${plural(lg.total, "face")}`;
    $("#gPct").textContent = uploading ? `${Math.round(lg.pct * 100)}%` : "";
    $("#gBar").classList.toggle("indeterminate", !uploading);
    $("#gBar span").style.width = uploading ? `${Math.round(lg.pct * 100)}%` : "";
  }

  function issuesHtml(issues) {
    if (!issues?.length) return "";
    const errs = issues.filter((i) => !i.warning).length;
    return `
      <details class="issues"${errs ? " open" : ""}>
        <summary class="issues-head">${ic("triangle-alert")}${plural(issues.length, "photo")} need${issues.length === 1 ? "s" : ""} attention${errs ? ` · ${errs} skipped` : ""}<span class="issues-toggle">Show details</span></summary>
        <ul>${issues.map((i) => `<li><span class="chip ${i.warning ? "unknown" : "err"}">${i.warning ? "Warning" : "Skipped"}</span><span><b>${esc(baseName(i.file))}</b> — ${esc(i.problem)}</span></li>`).join("")}</ul>
      </details>`;
  }

  function pickerHtml() {
    return `
      <div class="picker">
        ${FOLDER_ART}
        <div>
          <h2>Choose reference folder</h2>
          <p>Select a folder containing photographs of the people you want to recognise. Each file name becomes that person's name, like <b>Priya Sharma.jpg</b>.</p>
          <div class="picker-meta">
            <span>${ic("image")}JPG, JPEG, PNG</span>
            <span>${ic("users")}One photo per person</span>
            <span>${ic("lock")}Photos never leave this computer</span>
          </div>
        </div>
        <div class="picker-actions">
          <button class="btn btn-primary btn-lg" type="button" data-act="open-folder">${ic("folder-open")}Browse folders</button>
          <span class="tiny">or drag the folder onto this window</span>
        </div>
      </div>
      ${state.galleryError ? `<div class="notice err">${ic("triangle-alert")}<span>${esc(state.galleryError)}</span></div>` : ""}`;
  }

  function step1Html() {
    const head = `<div class="wz-head"><h1>Start with your people.</h1><p>Choose the folder containing individual reference photographs.</p></div>`;
    if (state.loadingGallery) {
      return head + galleryProgressHtml() +
        `<div class="ref-grid">${'<div class="ref"><div class="ph skel"></div><div class="skel" style="height:10px;width:70%"></div></div>'.repeat(10)}</div>`;
    }
    const g = state.gallery;
    if (!g) return head + pickerHtml();
    const shown = g.people.slice(0, 17);
    const more = g.count - shown.length;
    return head + `
      <div class="folder-summary">
        <div class="folder-id">
          <span class="badge-ico">${ic("folder")}</span>
          <div><h3>${esc(g.folder || "Selected folder")}</h3><p>Folder on this computer · the browser keeps the full path private</p></div>
        </div>
        <div class="facts">
          <div class="fact"><b>${g.files_received}</b><span>Images found</span></div>
          <div class="fact"><b>${g.count}</b><span>People ready</span></div>
          <div class="fact${g.issues.length ? " warn" : ""}"><b>${g.issues.length}</b><span>Need attention</span></div>
        </div>
      </div>
      <div class="ref-grid">
        ${shown.map((p, i) => `<div class="ref" style="animation-delay:${i * 18}ms" title="${esc(p.files.join(", "))}"><img src="${esc(p.thumb)}" alt=""><span>${esc(p.name)}</span></div>`).join("")}
        ${more > 0 ? `<a class="ref more" href="#/library"><span class="ph">+${more}</span><span>View all</span></a>` : ""}
      </div>
      ${issuesHtml(g.issues)}
      <div class="wz-foot">
        <button class="btn" type="button" data-act="open-folder">${ic("folder-open")}Choose a different folder</button>
        <button class="btn btn-primary btn-lg" type="button" data-act="step" data-step="2">Continue to group photo ${ic("arrow-right")}</button>
      </div>`;
  }

  function step2Html() {
    const head = `<div class="wz-head"><h1>Who's in the picture?</h1><p>Upload a group photograph and let the application identify familiar faces.</p></div>`;
    const g = state.gallery;
    const back = `<button class="btn btn-quiet" type="button" data-act="step" data-step="1">${ic("arrow-left")}People library · ${plural(g.count, "person", "people")}</button>`;
    const p = state.photo;
    if (!p) {
      return head + `
        <div class="dropzone" id="dropzone" data-act="choose-photo" role="button" tabindex="0" aria-label="Choose a group photograph">
          <div class="dz-icon">${ic("image-up")}</div>
          <h2>Drop your group photo here</h2>
          <p>or browse files from your computer</p>
          <button class="btn btn-primary" type="button" data-act="choose-photo">${ic("image")}Choose photograph</button>
          <p class="dz-formats">JPG, JPEG or PNG · you can also paste with <kbd>Ctrl</kbd> <kbd>V</kbd></p>
        </div>
        <div class="wz-foot">${back}<button class="btn btn-primary btn-lg" type="button" disabled>${ic("scan-face")}Identify faces</button></div>`;
    }
    const ready = p.ok === true;
    return head + `
      <div class="photo-ready">
        <div class="preview-frame">${p.ok === false ? `<div class="empty"><div class="empty-art err">${ic("image")}</div><h3>This file can't be shown</h3><p>Use a JPG, JPEG or PNG photograph.</p></div>` : `<img src="${p.url}" alt="Selected group photograph">`}</div>
        <aside class="file-card">
          <div><p class="eyebrow" style="margin-bottom:6px">Selected photograph</p><p class="file-name">${esc(p.name)}</p></div>
          <dl class="kv">
            <dt>Dimensions</dt><dd>${p.width ? `${p.width} × ${p.height} px` : p.ok === false ? "—" : "Reading…"}</dd>
            <dt>File size</dt><dd>${fmtBytes(p.size)}</dd>
            <dt>Compared with</dt><dd>${plural(g.count, "person", "people")}</dd>
          </dl>
          <div class="file-actions">
            <button class="btn btn-sm" type="button" data-act="choose-photo">${ic("replace")}Replace</button>
            <button class="btn btn-sm btn-danger-quiet" type="button" data-act="remove-photo">${ic("trash-2")}Remove</button>
          </div>
          <div class="cta-block">
            <button class="btn btn-primary btn-lg" type="button" data-act="identify" ${ready ? "" : "disabled"}>${ic("scan-face")}Identify faces</button>
            <span class="tiny">Usually takes a few seconds · runs on this computer</span>
          </div>
        </aside>
      </div>
      <div class="wz-foot">${back}</div>`;
  }

  function processingHtml() {
    const p = state.photo, n = state.gallery.count;
    return `
      <div class="wz-head"><h1>Identifying faces…</h1><p>This usually takes a few seconds.</p></div>
      <div class="processing">
        <div class="scan-frame"><img src="${p.url}" alt="Group photograph being analysed"></div>
        <aside class="proc-card" role="status" aria-live="polite">
          <h3>Working on ${esc(p.name)}</h3>
          <ul class="proc-steps" id="procSteps">
            <li data-phase="upload"><span class="dot">${ic("check")}</span><div>Sending photo to the local engine<small id="procUp">0%</small></div></li>
            <li data-phase="analyse"><span class="dot">${ic("check")}</span><div>Detecting and matching faces<small>Comparing every face with ${plural(n, "person", "people")}</small></div></li>
            <li data-phase="done"><span class="dot">${ic("check")}</span><div>Preparing results</div></li>
          </ul>
          <p class="local-tag">${ic("lock")}Your images are being processed locally.</p>
        </aside>
      </div>`;
  }
  function paintProcessing() {
    const pr = state.processing;
    if (!pr || !$("#procSteps")) return;
    const order = ["upload", "analyse", "done"], at = order.indexOf(pr.phase);
    $$("#procSteps li").forEach((li, i) => {
      li.classList.toggle("done", i < at);
      li.classList.toggle("active", i === at);
    });
    $("#procUp").textContent = pr.phase === "upload" ? `${Math.round(pr.pct * 100)}%` : "Done";
  }

  render.identify = () => {
    let step = state.processing ? 3 : state.gallery && !state.loadingGallery && state.wizardStep === 2 ? 2 : 1;
    const done = [];
    if (state.gallery && !state.loadingGallery) done.push(1);
    if (state.processing) done.push(2);
    $("#stepper").innerHTML = stepperItems(step, done);
    $("#wizard").innerHTML = step === 1 ? step1Html() : step === 2 ? step2Html() : processingHtml();
    if (step === 1) paintGalleryProgress();
    if (step === 3) paintProcessing();
  };

  // ================================================================== folder
  async function loadFolder(files) {
    const images = files.filter((f) => IMAGE_RE.test(f.name));
    if (state.loadingGallery) return;
    if (!images.length) {
      state.galleryError = "That folder has no photographs in it. Use JPG, JPEG or PNG files, each named after the person.";
      toast(state.galleryError, "error", 6000);
      refreshView();
      return;
    }
    const folder = (images[0].webkitRelativePath || images[0].relativePath || "").split("/").filter(Boolean)[0] || "";
    state.loadingGallery = { folder: images.length > 1 || (images[0].webkitRelativePath || images[0].relativePath) ? folder : "", total: images.length, pct: 0, phase: "upload" };
    state.galleryError = null;
    state.wizardStep = 1;
    refreshView();

    const form = new FormData();
    images.forEach((f) => form.append("files", f, f.webkitRelativePath || f.relativePath || f.name));
    try {
      const data = await upload("/api/gallery", form, (p) => {
        state.loadingGallery.pct = p;
        if (p >= 1) state.loadingGallery.phase = "learn";
        paintGalleryProgress();
      });
      state.gallery = data;
      state.folderFiles = images;
      if (state.result) state.result.stale = true;
      const skipped = data.issues.filter((i) => !i.warning).length;
      toast(`${plural(data.count, "person", "people")} ready${skipped ? ` · ${skipped} photo${skipped > 1 ? "s" : ""} skipped` : ""}`);
    } catch (err) {
      state.galleryError = err.message;
      toast(err.message, "error", 6000);
    } finally {
      state.loadingGallery = null;
      updateNav();
      refreshView();
    }
  }

  // ================================================================== photo
  function setPhoto(file) {
    if (!(file.type.startsWith("image/") || IMAGE_RE.test(file.name || ""))) {
      toast("That file isn't a photograph. Use JPG, JPEG or PNG.", "error");
      return false;
    }
    if (state.photo) URL.revokeObjectURL(state.photo.url);
    const url = URL.createObjectURL(file);
    state.photo = { file, url, name: file.name || "Pasted image.png", size: file.size, width: 0, height: 0, ok: null };
    const img = new Image();
    img.onload = () => {
      if (state.photo?.url !== url) return;
      Object.assign(state.photo, { width: img.naturalWidth, height: img.naturalHeight, ok: true });
      if (state.route?.name === "identify") render.identify();
    };
    img.onerror = () => {
      if (state.photo?.url !== url) return;
      state.photo.ok = false;
      if (state.route?.name === "identify") render.identify();
    };
    img.src = url;
    return true;
  }

  function takePhoto(file) {
    if (state.processing || !setPhoto(file)) return;
    if (!state.gallery) {
      toast("Photo kept for step 2. First choose the people folder.");
      state.wizardStep = 1;
    } else {
      state.wizardStep = 2;
    }
    go("#/identify");
  }

  async function identify() {
    const p = state.photo;
    if (!state.gallery || !p?.ok || state.processing) return;
    state.processing = { phase: "upload", pct: 0 };
    render.identify();
    const form = new FormData();
    form.append("photo", p.file, p.name);
    form.append("threshold", String(state.threshold));
    const t0 = performance.now();
    try {
      const data = await upload("/api/identify", form, (pct) => {
        state.processing.pct = pct;
        if (pct >= 1) state.processing.phase = "analyse";
        paintProcessing();
      });
      state.processing.phase = "done";
      paintProcessing();
      await sleep(Math.max(250, 800 - (performance.now() - t0)));
      state.result = data;
      state.resultFromWizard = true;
      state.selected = null;
      state.processing = null;
      URL.revokeObjectURL(p.url);
      state.photo = null;
      state.wizardStep = 2;
      go(`#/results/${data.session_id}`);
      refreshData();
    } catch (err) {
      state.processing = null;
      toast(err.message, "error", 6000);
      if (state.route?.name === "identify") render.identify();
    }
  }

  // ================================================================== results
  render.results = async (id) => {
    const root = $("#resultsRoot");
    let r = state.result?.session_id === id ? state.result : null;
    if (!r) {
      root.innerHTML = `<div class="skel" style="height:34px;width:46%;margin-bottom:12px"></div><div class="skel" style="height:18px;width:30%;margin-bottom:28px"></div><div class="skel" style="height:56vh;border-radius:20px"></div>`;
      try {
        r = await api(`/api/sessions/${encodeURIComponent(id || "")}`);
      } catch (err) {
        root.innerHTML = `<div class="empty boxed"><div class="empty-art warm">${ic("history")}</div><h3>This session isn't available</h3><p>${esc(err.message)}</p><a class="btn btn-primary" href="#/sessions">See recent sessions</a></div>`;
        return;
      }
      if (state.route?.arg !== id) return;
      state.result = r;
      state.resultFromWizard = false;
      state.selected = null;
      $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === "sessions"));
    }
    state.threshold = r.threshold;
    paintResults(r);
  };

  function paintResults(r) {
    const top = state.resultFromWizard
      ? `<ol class="stepper" aria-label="Progress">${stepperItems(3, [1, 2])}</ol>`
      : `<a class="crumb" href="#/sessions">${ic("arrow-left")}Recent sessions</a>`;
    const t = (key, label, extra = "") => `<button class="toggle" type="button" data-act="toggle" data-key="${key}" aria-pressed="${state.show[key]}">${extra}${label}</button>`;
    $("#resultsRoot").innerHTML = `
      ${top}
      <div class="res-head">
        <div><h1 id="resTitle"></h1><p id="resLede"></p><div class="res-stats" id="resStats"></div></div>
        <div class="head-actions">
          <button class="btn" type="button" data-act="csv">${ic("file-spreadsheet")}Export CSV</button>
          <button class="btn btn-primary" type="button" data-act="download">${ic("download")}Download annotated photo</button>
        </div>
      </div>
      ${r.stale ? `<div class="notice">${ic("triangle-alert")}<span>The people library changed after this photo was analysed, so these names come from the earlier folder. <button class="link" type="button" data-act="run-another">Run it again</button> to use the current library.</span></div>` : ""}
      <div class="res-layout">
        <section class="viewer" aria-label="Photograph">
          <div class="viewer-bar">
            <div class="toggles" role="group" aria-label="Show on photo">
              ${t("labels", "Labels", ic("tag"))}${t("identified", "Identified", '<span class="sw"></span>')}${t("unknown", "Unknown", '<span class="sw u"></span>')}${t("boxes", "Boxes", ic("scan-face"))}
            </div>
            <div class="strict" title="How similar a face must be to a library photo before it gets a name">
              <label for="threshold">Match strictness</label>
              <span>Relaxed</span><input id="threshold" type="range" min="0.2" max="0.6" step="0.01" value="${r.threshold}" ${r.stale ? "disabled" : ""} aria-describedby="strictHelp"><span>Strict</span>
              <output id="strictVal" for="threshold">${r.threshold.toFixed(2)}</output>
              <span id="strictHelp" hidden>Higher strictness gives fewer names but fewer mistakes.</span>
            </div>
          </div>
          <div class="stage"><div class="photo-wrap" id="photoWrap">
            <img id="photo" src="${r.image}" alt="Group photograph with face labels" width="${r.width}" height="${r.height}">
            <div class="overlay" id="overlay"></div>
          </div></div>
          <div class="viewer-foot">
            <span><b>${esc(r.filename)}</b> · ${r.width} × ${r.height} px · ${fmtWhen(r.created)}</span>
            <span class="legend"><span><i></i>Identified</span><span><i class="u"></i>Unknown</span></span>
          </div>
        </section>
        <aside class="side-panel" aria-label="People detected">
          <header class="panel-head"><div><h3>People detected</h3><p class="muted">Select a face to see it on the photo.</p></div></header>
          <ul class="res-list" id="resList"></ul>
        </aside>
      </div>
      <div id="unknownSlot"></div>
      <div class="res-actions">
        <div><button class="btn" type="button" data-act="run-another">${ic("refresh-cw")}Run another identification</button></div>
        <div><a class="btn btn-quiet" href="#/overview">${ic("layout-dashboard")}Return to overview</a></div>
      </div>`;
    paintResultData(r, true);
    const img = $("#photo");
    (img.complete ? Promise.resolve() : img.decode().catch(() => {}))
      .then(() => document.fonts?.ready)
      .then(() => requestAnimationFrame(() => layoutTags()));
  }

  function libraryThumb(name) {
    return state.gallery?.people.find((p) => p.name === name)?.thumb || "";
  }

  function itemHtml(f, i, thr) {
    const known = !!f.name;
    // Only mention a "closest" library face when it is at least somewhat similar;
    // at very low similarity it would just be a random face.
    const close = !known && f.best_guess && f.score >= 0.2;
    const refName = known ? f.name : close ? f.best_guess : null;
    const refThumb = refName ? libraryThumb(refName) : "";
    const pct = Math.round(Math.max(0, Math.min(1, f.score)) * 100);
    const explain = known
      ? `Matched with the library photo of <b>${esc(f.name)}</b>. A name is given when similarity is ${thr.toFixed(2)} or more.`
      : close
        ? `The closest library face is <b>${esc(f.best_guess)}</b>, but similarity ${f.score.toFixed(2)} is below the ${thr.toFixed(2)} needed for a name.`
        : `No one in the library looks like this person (highest similarity ${f.score.toFixed(2)}).`;
    return `
      <li class="res-item${known ? "" : " unknown"}" data-i="${i}">
        <button class="res-row" type="button" data-act="sel" data-i="${i}" aria-expanded="false">
          <span class="res-no">${pad(i + 1)}</span>
          <img class="res-thumb" src="${esc(f.thumb)}" alt="">
          <span style="min-width:0"><span class="res-name">${esc(f.name || "Unknown")}</span><span class="res-sub">${known ? quality(f.score) : "Not in library"}${f.low_quality ? " · small face" : ""}</span></span>
          <span class="res-score" title="Similarity to the library photo">${known ? f.score.toFixed(2) : ""}</span>
        </button>
        <div class="res-detail"><div><div class="detail-inner">
          ${refThumb ? `<div class="compare"><figure><img src="${esc(f.thumb)}" alt=""><figcaption>In photo</figcaption></figure><span class="vs">vs</span><figure><img src="${esc(refThumb)}" alt=""><figcaption>Library</figcaption></figure></div>` : ""}
          <div class="simbar"><span>Similarity</span><div class="bar"><span style="width:${pct}%"></span><i style="left:${thr * 100}%" title="Strictness ${thr.toFixed(2)}"></i></div><b>${f.score.toFixed(2)}</b></div>
          <p>${explain}</p>
          ${f.low_quality ? `<p>${ic("triangle-alert", "ico-sm")} This face is very small in the photo, so the result is less reliable.</p>` : ""}
        </div></div></div>
      </li>`;
  }

  function paintResultData(r, animate) {
    const faces = r.faces;
    const known = faces.filter((f) => f.name).length, unknown = faces.length - known;
    $("#resTitle").textContent = faces.length ? "Here's who's in the picture." : "No faces found in this picture.";
    $("#resLede").innerHTML = faces.length
      ? `We found and analysed ${plural(faces.length, "face")} in <b>${esc(r.filename)}</b>.`
      : "Try a photo where faces are larger, well lit and facing the camera.";
    if ($("#strictVal")) $("#strictVal").textContent = r.threshold.toFixed(2);
    $("#resStats").innerHTML = `
      <div class="res-stat"><b>${faces.length}</b><span>Faces detected</span></div>
      <div class="res-stat ok"><b>${known}</b><span>Identified</span></div>
      <div class="res-stat unknown"><b>${unknown}</b><span>Unknown</span></div>`;

    const ov = $("#overlay");
    ov.classList.toggle("settled", !animate);
    ov.innerHTML = faces.map((f, i) => {
      const [x1, y1, x2, y2] = f.box;
      const style = `left:${(x1 / r.width) * 100}%;top:${(y1 / r.height) * 100}%;width:${((x2 - x1) / r.width) * 100}%;height:${((y2 - y1) / r.height) * 100}%;` +
        (animate ? `animation-delay:${100 + i * 60}ms` : "");
      return `<div class="fbox${f.name ? "" : " unknown"}" data-i="${i}" data-act="sel" tabindex="0" role="button" aria-label="Face ${i + 1}: ${esc(f.name || "Unknown")}" style="${style}">
          <span class="tag"><span class="n">${i + 1}</span><span class="l">${esc(f.name || "Unknown")}</span></span></div>`;
    }).join("");

    $("#resList").innerHTML = faces.length
      ? faces.map((f, i) => itemHtml(f, i, r.threshold)).join("")
      : `<li class="empty"><div class="empty-art warm">${ic("scan-face")}</div><h3>No faces</h3><p>Nothing that looks like a face was found.</p></li>`;

    const unk = faces.map((f, i) => [f, i]).filter(([f]) => !f.name);
    $("#unknownSlot").innerHTML = unk.length ? `
      <section class="unknowns">
        <h3>Unrecognised faces <em>${unk.length}</em></h3>
        <p>These people were detected but could not be matched with your reference library.</p>
        <div class="unknown-row">${unk.map(([f, i]) => `<button class="unknown-face" type="button" data-act="sel" data-i="${i}" data-scroll="photo"><img src="${esc(f.thumb)}" alt="Unknown face ${i + 1}"><span>${pad(i + 1)}</span></button>`).join("")}</div>
      </section>` : "";

    applyShow();
    applySelection();
  }

  function applyShow() {
    const ov = $("#overlay");
    if (!ov) return;
    ov.classList.toggle("no-labels", !state.show.labels);
    ov.classList.toggle("no-boxes", !state.show.boxes);
    $$(".fbox", ov).forEach((b) => {
      const unknown = b.classList.contains("unknown");
      b.classList.toggle("filtered", unknown ? !state.show.unknown : !state.show.identified);
    });
    $$('.toggle[data-act="toggle"]').forEach((t) => t.setAttribute("aria-pressed", String(state.show[t.dataset.key])));
  }

  function applySelection() {
    const s = state.selected;
    $$(".fbox").forEach((b) => b.classList.toggle("sel", Number(b.dataset.i) === s));
    $$(".res-item").forEach((li) => {
      const on = Number(li.dataset.i) === s;
      li.classList.toggle("sel", on);
      li.querySelector(".res-row")?.setAttribute("aria-expanded", String(on));
    });
  }

  function select(i, from) {
    state.selected = state.selected === i ? null : i;
    applySelection();
    if (state.selected === null) return;
    const box = $(`.fbox[data-i="${i}"]`);
    if (from === "photo") {
      const item = $(`.res-item[data-i="${i}"]`);
      const list = $("#resList");
      if (item && list) {
        const top = item.offsetTop - list.clientHeight / 2 + item.clientHeight / 2;
        list.scrollTo({ top, behavior: "smooth" });
        if (getComputedStyle(list).maxHeight === "none") item.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } else if (box) {
      const rect = $("#photoWrap").getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > innerHeight || from === "unknowns") $("#photoWrap").scrollIntoView({ behavior: "smooth", block: "center" });
      box.classList.remove("pulse"); void box.offsetWidth; box.classList.add("pulse");
    }
  }

  function hover(i, on) {
    $(`.fbox[data-i="${i}"]`)?.classList.toggle("hl", on);
    $(`.res-item[data-i="${i}"]`)?.classList.toggle("hl", on);
  }

  // Place labels so they don't cover each other or other faces: below the face,
  // then above; if neither fits, show only the number (full name on hover / in the list).
  function layoutTags() {
    const ov = $("#overlay");
    if (!ov || !state.show.labels) return;
    const bounds = ov.getBoundingClientRect();
    if (!bounds.width) return;
    ov.classList.add("measuring");
    const placed = [];
    const hits = (a) => placed.some((b) => a.left < b.right + 2 && a.right > b.left - 2 && a.top < b.bottom + 2 && a.bottom > b.top - 2);
    const inside = (a) => a.top >= bounds.top - 2 && a.bottom <= bounds.bottom + 2;
    const boxes = $$(".fbox", ov).filter((b) => !b.classList.contains("filtered"));
    const faceRects = boxes.map((b) => b.getBoundingClientRect());
    boxes.forEach((box, i) => {
      const tag = box.querySelector(".tag");
      box.classList.remove("tag-above", "mini");
      tag.style.setProperty("--dx", "0px");
      const fit = () => {
        let rect = tag.getBoundingClientRect();
        let dx = 0;
        if (rect.left < bounds.left + 2) dx = bounds.left + 2 - rect.left;
        if (rect.right > bounds.right - 2) dx = bounds.right - 2 - rect.right;
        tag.style.setProperty("--dx", `${dx}px`);
        rect = tag.getBoundingClientRect();
        const onFace = faceRects.some((a, j) => j !== i && rect.left < a.right && rect.right > a.left && rect.top < a.bottom && rect.bottom > a.top);
        return { rect, ok: inside(rect) && !hits(rect) && !onFace };
      };
      let chosen = null;
      for (const [above, mini] of [[false, false], [true, false], [false, true], [true, true]]) {
        box.classList.toggle("tag-above", above);
        box.classList.toggle("mini", mini);
        const res = fit();
        if (res.ok) { chosen = res.rect; break; }
      }
      if (!chosen) {
        box.classList.remove("tag-above");
        box.classList.add("mini");
        if (!inside(fit().rect)) box.classList.add("tag-above");
        chosen = fit().rect;
      }
      placed.push(chosen);
    });
    ov.classList.remove("measuring");
  }

  // strictness slider -> re-match stored face signatures (no re-detection)
  let rematchTimer = null, rematchSeq = 0;
  function onThreshold(value) {
    const r = state.result;
    if (!r) return;
    state.threshold = value;
    clearTimeout(rematchTimer);
    rematchTimer = setTimeout(async () => {
      const seq = ++rematchSeq;
      try {
        const data = await api("/api/rematch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result_id: r.result_id, threshold: value }),
        });
        if (seq !== rematchSeq || state.result !== r) return;
        data.matches.forEach((m) => Object.assign(r.faces[m.index], m));
        r.threshold = value;
        paintResultData(r, false);
        layoutTags();
      } catch (err) {
        toast(err.message, "error");
      }
    }, 120);
  }

  // ---------------------------------------------------------------- exports
  async function downloadPhoto() {
    const r = state.result;
    if (!r) return;
    const img = new Image();
    img.src = r.image;
    await img.decode();
    const W = r.width, H = r.height;
    const fs = Math.max(13, Math.round(W / 85));
    const lw = Math.max(2, Math.round(W / 500));
    const th = Math.round(fs * 1.7);
    const font = `650 ${fs}px Manrope, "Segoe UI", sans-serif`;
    const colors = (f) => (f.name ? ["#173F35", "#4FA27B", "#F8F8F4"] : ["#C77B48", "#D98A57", "#FFFFFF"]);
    const label = (f) => f.name || "Unknown";

    const measure = document.createElement("canvas").getContext("2d");
    measure.font = font;
    const placed = [];
    const overlaps = (a) => placed.some((b) => a.x < b.x + b.w + 2 && a.x + a.w + 2 > b.x && a.y < b.y + b.h + 2 && a.y + a.h + 2 > b.y);
    const labels = r.faces.map((f, i) => {
      const [x1, y1, x2, y2] = f.box;
      const tryText = (text) => {
        const w = measure.measureText(text).width + fs;
        const x = Math.max(2, Math.min(W - w - 2, (x1 + x2) / 2 - w / 2));
        for (const y of [y2 + lw * 2, y1 - th - lw * 2]) {
          const rect = { x, y, w, h: th };
          if (y >= 0 && y + th <= H && !overlaps(rect)) return rect;
        }
        return null;
      };
      let text = `${i + 1}  ${label(f)}`, mini = false;
      let rect = tryText(text);
      if (!rect) {
        mini = true;
        text = `${i + 1}`;
        rect = tryText(text) || { x: x1, y: Math.min(H - th, y2 + lw * 2), w: measure.measureText(text).width + fs, h: th };
      }
      placed.push(rect);
      return { text, rect, mini };
    });

    const legendLines = [];
    if (labels.some((l) => l.mini)) {
      measure.font = `600 ${fs}px "DM Sans", "Segoe UI", sans-serif`;
      let line = "";
      for (const part of r.faces.map((f, i) => `${i + 1}. ${label(f)}`)) {
        const next = line ? `${line}   ·   ${part}` : part;
        if (measure.measureText(next).width > W - fs * 2 && line) { legendLines.push(line); line = part; } else line = next;
      }
      if (line) legendLines.push(line);
    }
    const legendH = legendLines.length ? legendLines.length * fs * 1.6 + fs * 1.6 : 0;

    const c = document.createElement("canvas");
    c.width = W;
    c.height = Math.round(H + legendH);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#F8F8F4";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    ctx.lineWidth = lw;
    r.faces.forEach((f) => {
      const [x1, y1, x2, y2] = f.box;
      ctx.strokeStyle = colors(f)[1];
      ctx.setLineDash(f.name ? [] : [lw * 3, lw * 2]);
      ctx.beginPath();
      ctx.roundRect(x1, y1, x2 - x1, y2 - y1, lw * 3);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.font = font;
    ctx.textBaseline = "middle";
    labels.forEach(({ text, rect }, i) => {
      const [bg, , ink] = colors(r.faces[i]);
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, th * 0.28);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.fillText(text, rect.x + fs / 2, rect.y + th / 2);
    });
    if (legendLines.length) {
      ctx.font = `600 ${fs}px "DM Sans", "Segoe UI", sans-serif`;
      ctx.fillStyle = "#202923";
      legendLines.forEach((line, k) => ctx.fillText(line, fs, H + fs * 1.6 * (k + 1)));
    }
    c.toBlob((blob) => {
      saveBlob(blob, `${r.filename.replace(/\.[^.]+$/, "")} - identified.jpg`);
      toast("Annotated photo saved to your Downloads.");
    }, "image/jpeg", 0.92);
  }

  function exportCsv() {
    const r = state.result;
    if (!r) return;
    const when = new Date(r.created * 1000).toLocaleString();
    const rows = [["Face", "Name", "Status", "Similarity", "Strictness used", "Closest library face (unknown only)", "Small face", "Photo", "Analysed"]];
    r.faces.forEach((f, i) => rows.push([
      i + 1, f.name || "Unknown", f.name ? "Identified" : "Not in library", f.score.toFixed(3), r.threshold.toFixed(2),
      !f.name && f.best_guess && f.score >= 0.2 ? f.best_guess : "", f.low_quality ? "yes" : "no", r.filename, when,
    ]));
    const csv = "﻿" + rows.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    saveBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${r.filename.replace(/\.[^.]+$/, "")} - identification.csv`);
    toast("Identification report saved as CSV.");
  }

  function saveBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  // ================================================================== library
  render.library = () => {
    const g = state.gallery, root = $("#libraryRoot");
    $("#libraryActions").innerHTML = g && !state.loadingGallery ? `
      ${state.folderFiles ? `<button class="btn" type="button" data-act="lib-refresh" title="Read the same photos again, e.g. after editing them. To add new people, choose the folder again.">${ic("refresh-cw")}Refresh library</button>` : ""}
      <button class="btn btn-primary" type="button" data-act="open-folder">${ic("folder-open")}Choose folder</button>` : "";

    if (state.loadingGallery) {
      root.innerHTML = galleryProgressHtml() + `<div class="people-grid" style="margin-top:20px">${'<div class="skel-card"><div class="skel a"></div><div class="skel b"></div><div class="skel c"></div></div>'.repeat(10)}</div>`;
      paintGalleryProgress();
      return;
    }
    if (!g) {
      root.innerHTML = `
        <div class="empty boxed">
          <div class="empty-art">${ic("folder-open")}</div>
          <h3>No folder selected yet</h3>
          <p>Choose the folder that holds one photograph per person. Each file name becomes that person's name, and the folder stays the source of truth.</p>
          <button class="btn btn-primary btn-lg" type="button" data-act="open-folder">${ic("folder-open")}Choose reference folder</button>
        </div>
        ${state.galleryError ? `<div class="notice err" style="margin-top:16px">${ic("triangle-alert")}<span>${esc(state.galleryError)}</span></div>` : ""}`;
      return;
    }
    const errs = g.issues.filter((i) => !i.warning).length;
    root.innerHTML = `
      <div class="lib-info">
        <span class="folder">${ic("folder")}${esc(g.folder || "Selected folder")}</span>
        <span><b>${g.count}</b> people</span>
        <span><b>${g.files_received}</b> images read</span>
        ${errs ? `<span><b style="color:var(--error)">${errs}</b> skipped</span>` : ""}
        <span class="tiny" style="margin-left:auto">Names come from file names. Rename a file and refresh to change a name.</span>
      </div>
      ${issuesHtml(g.issues)}
      <div class="lib-bar" style="margin-top:18px">
        <label class="search">${ic("search")}<input id="libSearch" type="search" placeholder="Search people by name" value="${esc(state.libQuery)}" aria-label="Search people by name"></label>
        <div class="seg" role="group" aria-label="Layout">
          <button type="button" data-act="lib-view" data-v="grid" aria-pressed="${state.libView === "grid"}" aria-label="Grid">${ic("layout-grid", "ico-sm")}</button>
          <button type="button" data-act="lib-view" data-v="list" aria-pressed="${state.libView === "list"}" aria-label="List">${ic("list", "ico-sm")}</button>
        </div>
        <span class="lib-count" id="libCount"></span>
      </div>
      <div id="libList"></div>`;
    $("#libSearch").addEventListener("input", (e) => { state.libQuery = e.target.value; paintLibList(); });
    paintLibList();
  };

  function paintLibList() {
    const g = state.gallery;
    const q = state.libQuery.trim().toLowerCase();
    const warnByFile = new Map(g.issues.filter((i) => i.warning).map((i) => [baseName(i.file), i.problem]));
    const people = g.people.filter((p) => p.name.toLowerCase().includes(q));
    const invalid = g.issues.filter((i) => !i.warning && (String(i.name).toLowerCase().includes(q) || baseName(i.file).toLowerCase().includes(q)));
    $("#libCount").textContent = q ? `${people.length} of ${g.count} people` : `${plural(g.count, "person", "people")}`;
    if (!people.length && !invalid.length) {
      $("#libList").innerHTML = `<div class="empty"><div class="empty-art">${ic("search")}</div><h3>No one called “${esc(state.libQuery)}”</h3><p>Check the spelling, or add a photo named after them to the folder.</p></div>`;
      return;
    }
    const status = (p) => {
      const w = p.files.map((f) => warnByFile.get(f)).find(Boolean);
      return w ? ["warn", w] : p.files.length > 1 ? ["", `${p.files.length} photos combined`] : ["", ""];
    };
    if (state.libView === "list") {
      $("#libList").innerHTML = `<div class="people-list">${people.map((p) => {
        const [cls, text] = status(p);
        return `<div class="row"><img src="${esc(p.thumb)}" alt=""><b>${esc(p.name)}</b><span class="file">${esc(p.files.join(", "))}</span>${text ? `<span class="person-status ${cls}" style="margin:0">${esc(text)}</span>` : "<span></span>"}</div>`;
      }).join("")}${invalid.map((i) => `<div class="row"><span class="ph">${ic("triangle-alert", "ico-sm")}</span><b>${esc(i.name)}</b><span class="file">${esc(baseName(i.file))}</span><span class="person-status err" style="margin:0">${esc(i.problem)}</span></div>`).join("")}</div>`;
    } else {
      $("#libList").innerHTML = `<div class="people-grid">${people.map((p, k) => {
        const [cls, text] = status(p);
        return `<article class="person" style="animation-delay:${Math.min(k, 24) * 15}ms"><img src="${esc(p.thumb)}" alt=""><p class="person-name" title="${esc(p.name)}">${esc(p.name)}</p><p class="person-file" title="${esc(p.files.join(", "))}">${esc(p.files.join(", "))}</p>${text ? `<p class="person-status ${cls}">${esc(text)}</p>` : ""}</article>`;
      }).join("")}${invalid.map((i) => `<article class="person invalid"><div class="ph">${ic("triangle-alert", "ico-lg")}</div><p class="person-name">${esc(i.name)}</p><p class="person-file">${esc(baseName(i.file))}</p><p class="person-status err">${esc(i.problem)}</p></article>`).join("")}</div>`;
    }
  }

  // ================================================================== sessions
  render.sessions = async () => {
    const root = $("#sessionsRoot");
    if (state.sessions === null) {
      root.innerHTML = `<div class="sess-grid">${'<div class="skel-card" style="padding:0;overflow:hidden;border-radius:18px"><div class="skel" style="aspect-ratio:16/10;border-radius:0"></div><div class="skel b"></div><div class="skel c" style="margin-bottom:16px"></div></div>'.repeat(3)}</div>`;
    } else paintSessions();
    await refreshData();
    if (state.route?.name === "sessions") paintSessions();
  };

  function paintSessions() {
    const ss = state.sessions || [];
    const root = $("#sessionsRoot");
    if (!ss.length) {
      root.innerHTML = `
        <div class="empty boxed">
          <div class="empty-art">${ic("history")}</div>
          <h3>No sessions yet</h3>
          <p>When you identify the people in a photograph, it appears here so you can open the results again.</p>
          <a class="btn btn-primary btn-lg" href="#/identify">${ic("scan-face")}Start identification</a>
        </div>`;
      return;
    }
    root.innerHTML = `<div class="sess-grid">${ss.map((s, k) => `
      <article class="sess-card" style="animation-delay:${Math.min(k, 12) * 30}ms">
        <div class="sess-img"><img src="${esc(s.preview)}" alt=""></div>
        <div class="sess-body">
          <div><p class="sess-title" title="${esc(s.filename)}">${esc(s.filename)}</p><p class="sess-when">${fmtWhen(s.created)}</p></div>
          <div class="sess-counts"><span><b>${s.faces}</b>faces</span><span class="ok"><b>${s.identified}</b>identified</span><span class="u"><b>${s.unknown}</b>unknown</span></div>
          <button class="btn btn-sm" type="button" data-act="open-session" data-id="${s.id}">View results ${ic("arrow-right")}</button>
        </div>
      </article>`).join("")}</div>`;
  }

  // ================================================================== actions (event delegation)
  const openFolder = () => { $("#folderInput").value = ""; $("#folderInput").click(); };
  const choosePhoto = () => { if (state.processing) return; $("#photoInput").value = ""; $("#photoInput").click(); };
  const actions = {
    "open-folder": openFolder,
    "choose-photo": choosePhoto,
    "remove-photo": () => { if (state.photo) URL.revokeObjectURL(state.photo.url); state.photo = null; render.identify(); },
    identify,
    step: (el) => {
      const s = Number(el.dataset.step);
      if (state.route?.name === "results" && s === 3) return;
      state.wizardStep = s;
      go("#/identify");
    },
    "run-another": () => { state.wizardStep = state.gallery ? 2 : 1; go("#/identify"); },
    "open-session": (el) => { state.resultFromWizard = false; if (state.result?.session_id !== el.dataset.id) state.result = null; go(`#/results/${el.dataset.id}`); },
    sel: (el) => select(Number(el.dataset.i), el.classList.contains("fbox") ? "photo" : el.dataset.scroll === "photo" ? "unknowns" : "list"),
    toggle: (el) => { const k = el.dataset.key; state.show[k] = !state.show[k]; applyShow(); layoutTags(); },
    download: () => downloadPhoto().catch((e) => toast(e.message, "error")),
    csv: exportCsv,
    "lib-view": (el) => { state.libView = el.dataset.v; $$('[data-act="lib-view"]').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === state.libView))); paintLibList(); },
    "lib-refresh": () => state.folderFiles && loadFolder(state.folderFiles),
  };

  function bindActions() {
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el || el.disabled) return;
      const fn = actions[el.dataset.act];
      if (!fn) return;
      // the dropzone contains its own button; let only one of them act
      if (el.id === "dropzone" && e.target.closest("button") && e.target.closest("button") !== el) return;
      e.preventDefault();
      fn(el, e);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.selected !== null) { state.selected = null; applySelection(); return; }
      if ((e.key === "Enter" || e.key === " ") && e.target.matches?.('[data-act][tabindex], tr[data-act]')) {
        e.preventDefault();
        actions[e.target.dataset.act]?.(e.target, e);
      }
    });
    for (const [ev, on] of [["mouseover", true], ["mouseout", false], ["focusin", true], ["focusout", false]]) {
      document.addEventListener(ev, (e) => {
        if (state.route?.name !== "results") return;
        const el = e.target.closest?.(".fbox, .res-item, .unknown-face");
        if (!el) return;
        if (!on && el.contains(e.relatedTarget)) return;
        hover(el.dataset.i, on);
      });
    }
    $("#folderInput").addEventListener("change", (e) => { const f = [...e.target.files]; if (f.length) loadFolder(f); });
    $("#photoInput").addEventListener("change", (e) => e.target.files[0] && takePhoto(e.target.files[0]));
    document.addEventListener("input", (e) => {
      if (e.target.id !== "threshold") return;
      const v = parseFloat(e.target.value);
      $("#strictVal").textContent = v.toFixed(2);
      onThreshold(v);
    });
  }

  // ================================================================== drag & drop / paste
  async function entriesToFiles(items) {
    const out = [];
    const readAll = (reader) => new Promise((res, rej) => {
      const all = [];
      const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : res(all)), rej);
      next();
    });
    const walk = async (entry, path) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        file.relativePath = path + file.name;
        out.push(file);
      } else if (entry.isDirectory) {
        for (const child of await readAll(entry.createReader())) await walk(child, `${path}${entry.name}/`);
      }
    };
    const entries = [...items].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
    for (const e of entries) await walk(e, "");
    return { files: out, hadDir: entries.some((e) => e.isDirectory) };
  }

  function bindDrop() {
    let depth = 0;
    const veil = (on, text) => { $("#dropVeil").hidden = !on; if (text) $("#dropVeilText").textContent = text; $("#dropzone")?.classList.toggle("over", on); };
    window.addEventListener("dragenter", (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      depth++;
      const n = e.dataTransfer.items?.length || 0;
      veil(true, !state.gallery || n > 1 ? "Drop the people folder" : "Drop the group photograph");
    });
    window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) veil(false); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      depth = 0;
      veil(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const { files, hadDir } = await entriesToFiles(dt.items || []);
      const all = files.length ? files : [...dt.files];
      if (hadDir || all.length > 1) {
        if (state.route?.name !== "library") go("#/identify");
        loadFolder(all);
      } else if (all.length === 1) takePhoto(all[0]);
    });
    window.addEventListener("paste", (e) => {
      if (e.target.matches?.("input[type=search]")) return;
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
      if (file) takePhoto(file);
    });
  }

  // ================================================================== init
  async function init() {
    $$("[data-icon]").forEach((el) => { el.outerHTML = ic(el.dataset.icon); });
    bindActions();
    bindDrop();
    window.addEventListener("hashchange", route);
    let rt;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => { if (state.route?.name === "results") { $("#overlay")?.classList.add("settled"); layoutTags(); } }, 80);
    });
    try {
      const [st, g] = await Promise.all([api("/api/status"), api("/api/gallery")]);
      state.threshold = st.default_threshold;
      state.stats = st.stats;
      state.gallery = g.count ? g : null;
      state.wizardStep = state.gallery ? 2 : 1;
    } catch {
      toast("Can't reach the local engine. Start it with run.bat.", "error", 8000);
    }
    route();
    setInterval(() => { fetch("/api/status").then(() => markServer(true), () => markServer(false)); }, 20000);
  }

  init();
})();
