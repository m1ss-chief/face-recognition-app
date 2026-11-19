/* Who's in the Photo? front-end. Plain JS, no build step, no network beyond localhost. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const IMAGE_RE = /\.(jpe?g|png|webp|bmp)$/i;

  const state = {
    people: [],
    issues: [],
    threshold: 0.35,
    photoFile: null,
    result: null,
    busy: false,
  };

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg, kind = "info", ms = 4200) {
    const el = document.createElement("div");
    el.className = `toast ${kind === "error" ? "error" : ""}`;
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => { el.classList.add("leaving"); setTimeout(() => el.remove(), 250); }, ms);
  }

  function show(id, on = true) { $(id).classList.toggle("hidden", !on); }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    let body = {};
    try { body = await res.json(); } catch { /* ignore */ }
    if (!res.ok) throw new Error(body.error || `Something went wrong (${res.status}).`);
    return body;
  }

  // XHR so we can show real upload progress for big folders.
  function uploadWithProgress(url, form, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.upload.onload = () => onProgress(1);
      xhr.onload = () => {
        const body = xhr.response || {};
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new Error(body.error || `Something went wrong (${xhr.status}).`));
      };
      xhr.onerror = () => reject(new Error("The app server is not running. Start it again with run.bat."));
      xhr.send(form);
    });
  }

  // Similarity -> friendly words. Cosine similarity of ArcFace embeddings:
  // same person is usually 0.4-0.8, different people usually below 0.25.
  function quality(score) {
    if (score >= 0.55) return "Strong match";
    if (score >= 0.42) return "Good match";
    return "Weak match";
  }
  const barWidth = (score) => Math.round(Math.min(1, Math.max(0.06, (score - 0.15) / 0.6)) * 100);

  // ------------------------------------------------------------------ steps
  function updateSteps() {
    const hasPeople = state.people.length > 0;
    $("step1").classList.toggle("active", !hasPeople);
    $("step1").classList.toggle("done", hasPeople);
    $("step1State").textContent = hasPeople ? "Done" : "Start here";
    show("step1Action", !hasPeople);
    show("step1Done", hasPeople);
    $("step2").classList.toggle("active", hasPeople);
    $("step2State").textContent = hasPeople ? "Ready" : "Next";
    $("choosePhotoBtn").disabled = !hasPeople;

    if (hasPeople) {
      $("step1DoneText").textContent = `${state.people.length} people ready`;
      $("doneFaces").innerHTML = state.people.slice(0, 5)
        .map((p, i) => `<img src="${p.thumb}" alt="" style="animation-delay:${i * 60}ms">`).join("");
    }

    show("folderChip", hasPeople);
    $("folderChipText").textContent = `${state.people.length} people`;
    $("chipFaces").innerHTML = state.people.slice(0, 3).map((p) => `<img src="${p.thumb}" alt="">`).join("");
    show("folderChipWarn", state.issues.length > 0);
  }

  // ------------------------------------------------------------------ folder
  async function loadFolder(files) {
    const images = files.filter((f) => IMAGE_RE.test(f.name));
    if (!images.length) {
      toast("That folder has no photos in it (JPG, PNG or WEBP).", "error");
      return;
    }
    if (state.busy) return;
    state.busy = true;
    closeDrawer();
    if (state.result) resetToStart(false);

    show("step1Action", false);
    show("step1Done", false);
    show("step1Progress", true);
    $("progressBar").style.width = "0%";
    $("progressText").textContent = `Uploading ${images.length} photos…`;
    $("progressPct").textContent = "0%";
    $("step1Progress").classList.remove("indeterminate");

    const form = new FormData();
    images.forEach((f) => form.append("files", f, f.webkitRelativePath || f.relativePath || f.name));

    try {
      const data = await uploadWithProgress("/api/gallery", form, (p) => {
        const pct = Math.round(p * 100);
        $("progressBar").style.width = `${pct}%`;
        $("progressPct").textContent = `${pct}%`;
        if (p >= 1) {
          $("progressText").textContent = `Learning ${images.length} faces…`;
          $("progressPct").textContent = "";
          $("step1Progress").classList.add("indeterminate");
        }
      });
      state.people = data.people;
      state.issues = data.issues;
      const errors = data.issues.filter((i) => !i.warning).length;
      if (errors) toast(`${errors} photo${errors > 1 ? "s" : ""} skipped. Click the people button to see why.`, "error", 6000);
      if (state.photoFile) identify(state.photoFile);
    } catch (err) {
      toast(err.message, "error", 6000);
    } finally {
      state.busy = false;
      show("step1Progress", false);
      updateSteps();
      renderPeople();
    }
  }

  // ------------------------------------------------------------------ photo
  async function identify(file) {
    if (!state.people.length) {
      toast("First open the folder of known people (step 1).", "error");
      return;
    }
    if (!file.type.startsWith("image/") && !IMAGE_RE.test(file.name || "")) {
      toast("That file is not a photo. Use JPG, PNG or WEBP.", "error");
      return;
    }
    if (state.busy) return;
    state.busy = true;
    state.photoFile = file;
    state.result = null;

    // Show the photo straight away with a scanning effect.
    const url = URL.createObjectURL(file);
    const img = $("photo");
    img.src = url;
    $("overlay").innerHTML = "";
    show("start", false);
    show("stage", true);
    show("results", false);
    $("photoWrap").classList.add("scanning");
    show("scan", true);
    show("stageStatus", true);
    $("stageStatusText").textContent = "Finding faces…";

    const form = new FormData();
    form.append("photo", file, file.name || "photo.jpg");
    form.append("threshold", String(state.threshold));
    try {
      const t0 = performance.now();
      const data = await api("/api/identify", { method: "POST", body: form });
      // keep the scan visible briefly so the transition doesn't flicker
      const wait = Math.max(0, 500 - (performance.now() - t0));
      await new Promise((r) => setTimeout(r, wait));
      state.result = data;
      img.src = data.image; // server copy: correctly rotated, boxes line up
      await img.decode().catch(() => {});
      URL.revokeObjectURL(url);
      renderResults(true);
    } catch (err) {
      toast(err.message, "error", 6000);
      URL.revokeObjectURL(url);
      resetToStart(true);
    } finally {
      state.busy = false;
      $("photoWrap").classList.remove("scanning");
      show("scan", false);
      show("stageStatus", false);
    }
  }

  function resetToStart(keepPhoto) {
    state.result = null;
    if (!keepPhoto) state.photoFile = null;
    show("stage", false);
    show("results", false);
    show("start", true);
    $("overlay").innerHTML = "";
    updateSteps();
  }

  // ------------------------------------------------------------------ results
  function faceLabel(f) {
    return f.name || "Unknown";
  }

  function unknownHint(f) {
    if (f.best_guess && f.score >= state.threshold - 0.08 && f.score >= 0.22) {
      return `Might be <b>${esc(f.best_guess)}</b>?`;
    }
    return "Not in the folder";
  }

  function renderResults(animate) {
    const r = state.result;
    if (!r) return;
    const faces = r.faces;
    const known = faces.filter((f) => f.name).length;
    const unknown = faces.length - known;

    // summary
    $("resultsTitle").textContent = faces.length
      ? `${faces.length} ${faces.length === 1 ? "person" : "people"} in this photo`
      : "No one found";
    $("summary").innerHTML = `
      <span class="pill known"><span class="dot"></span><b>${known}</b> recognised</span>
      <span class="pill unknown"><span class="dot"></span><b>${unknown}</b> unknown</span>`;

    // boxes
    const overlay = $("overlay");
    overlay.classList.toggle("settled", !animate);
    overlay.innerHTML = faces.map((f, i) => {
      const [x1, y1, x2, y2] = f.box;
      const left = (x1 / r.width) * 100, top = (y1 / r.height) * 100;
      const w = ((x2 - x1) / r.width) * 100, h = ((y2 - y1) / r.height) * 100;
      const above = "";
      const delay = animate ? `animation-delay:${120 + i * 70}ms;` : "animation:none;";
      return `<div class="fbox${f.name ? "" : " unknown"}${above}" data-i="${i}" tabindex="0"
                role="button" aria-label="Face ${i + 1}: ${esc(faceLabel(f))}"
                style="left:${left}%;top:${top}%;width:${w}%;height:${h}%;${delay}">
                <span class="tag"><span class="num">${i + 1}</span><span class="label">${esc(faceLabel(f))}</span></span>
              </div>`;
    }).join("");

    // cards
    $("cards").innerHTML = faces.map((f, i) => {
      const delay = animate ? `animation-delay:${200 + i * 50}ms` : "animation:none";
      const body = f.name
        ? `<p class="name">${esc(f.name)}</p>
           <p class="meta">${quality(f.score)}</p>
           <div class="conf"><div class="conf-bar"><span style="width:${barWidth(f.score)}%"></span></div><small>${f.score.toFixed(2)}</small></div>`
        : `<p class="name">Unknown</p>
           <p class="meta">${unknownHint(f)}</p>`;
      const lq = f.low_quality ? `<span class="badge-lq">Small face · less reliable</span>` : "";
      return `<article class="card${f.name ? "" : " unknown"}" data-i="${i}" tabindex="0" style="${delay}">
                <div class="thumb"><img src="${f.thumb}" alt=""><span class="num">${i + 1}</span></div>
                <div class="card-body">${body}${lq}</div>
              </article>`;
    }).join("");

    show("noFaces", faces.length === 0);
    show("results", true);
    layoutTags();
    renderPeople();
  }

  // Place name tags so they never cover each other: try below the face, then
  // above; if neither fits, shrink the tag to just its number (the full name
  // still appears on hover and in the list below).
  function layoutTags() {
    const overlay = $("overlay");
    const bounds = overlay.getBoundingClientRect();
    if (!bounds.width) return;
    overlay.classList.add("measuring"); // freeze entry animations so rects are final
    const placed = [];
    const hits = (a) => placed.some((b) => a.left < b.right + 2 && a.right > b.left - 2 && a.top < b.bottom + 2 && a.bottom > b.top - 2);
    const inside = (a) => a.top >= bounds.top - 2 && a.bottom <= bounds.bottom + 2;
    const boxes = [...overlay.querySelectorAll(".fbox")];
    // faces count as obstacles too, so tags don't sit on someone's face
    const faceRects = boxes.map((b) => b.getBoundingClientRect());

    boxes.forEach((box, i) => {
      const tag = box.querySelector(".tag");
      box.classList.remove("tag-above", "mini");
      tag.style.setProperty("--dx", "0px");
      const fit = () => {
        let rect = tag.getBoundingClientRect();
        // keep tags inside the photo horizontally
        let dx = 0;
        if (rect.left < bounds.left + 2) dx = bounds.left + 2 - rect.left;
        if (rect.right > bounds.right - 2) dx = bounds.right - 2 - rect.right;
        tag.style.setProperty("--dx", `${dx}px`);
        rect = tag.getBoundingClientRect();
        const others = faceRects.filter((_, j) => j !== i);
        const onFace = others.some((a) => rect.left < a.right && rect.right > a.left && rect.top < a.bottom && rect.bottom > a.top);
        return { rect, ok: inside(rect) && !hits(rect) && !onFace };
      };
      const attempts = [[false, false], [true, false], [false, true], [true, true]]; // [above, mini]
      let chosen = null;
      for (const [above, mini] of attempts) {
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
    overlay.classList.remove("measuring");
  }

  // hover / focus linking between photo boxes and cards
  function highlight(i, on) {
    const box = document.querySelector(`.fbox[data-i="${i}"]`);
    const card = document.querySelector(`.card[data-i="${i}"]`);
    box?.classList.toggle("hl", on);
    card?.classList.toggle("hl", on);
    $("overlay").classList.toggle("dim", on);
  }

  function bindLinking() {
    for (const root of [$("overlay"), $("cards")]) {
      root.addEventListener("mouseover", (e) => {
        const el = e.target.closest("[data-i]");
        if (el) highlight(el.dataset.i, true);
      });
      root.addEventListener("mouseout", (e) => {
        const el = e.target.closest("[data-i]");
        if (el && !el.contains(e.relatedTarget)) highlight(el.dataset.i, false);
      });
      root.addEventListener("focusin", (e) => {
        const el = e.target.closest("[data-i]");
        if (el) highlight(el.dataset.i, true);
      });
      root.addEventListener("focusout", (e) => {
        const el = e.target.closest("[data-i]");
        if (el) highlight(el.dataset.i, false);
      });
    }
    const activate = (e) => {
      const el = e.target.closest("[data-i]");
      if (!el) return;
      const i = el.dataset.i;
      if (el.classList.contains("card")) {
        $("stage").scrollIntoView({ behavior: "smooth", block: "center" });
        const box = document.querySelector(`.fbox[data-i="${i}"]`);
        if (box) { box.classList.remove("flash"); void box.offsetWidth; box.classList.add("flash"); }
      } else {
        document.querySelector(`.card[data-i="${i}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    };
    $("overlay").addEventListener("click", activate);
    $("cards").addEventListener("click", activate);
    for (const root of [$("overlay"), $("cards")]) {
      root.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(e); } });
    }
  }

  // ------------------------------------------------------------------ strictness slider
  let rematchTimer = null;
  let rematchSeq = 0;
  function onThreshold() {
    state.threshold = parseFloat($("threshold").value);
    if (!state.result) return;
    clearTimeout(rematchTimer);
    rematchTimer = setTimeout(async () => {
      const seq = ++rematchSeq;
      try {
        const data = await api("/api/rematch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result_id: state.result.result_id, threshold: state.threshold }),
        });
        if (seq !== rematchSeq || !state.result) return;
        data.matches.forEach((m) => Object.assign(state.result.faces[m.index], m));
        renderResults(false);
      } catch (err) {
        toast(err.message, "error");
      }
    }, 120);
  }

  // ------------------------------------------------------------------ download
  async function download() {
    const r = state.result;
    if (!r) return;
    const img = new Image();
    img.src = r.image;
    await img.decode();

    const W = r.width, H = r.height;
    const fs = Math.max(13, Math.round(W / 85));
    const lw = Math.max(2, Math.round(W / 500));
    const th = Math.round(fs * 1.6);
    const font = `700 ${fs}px Inter, "Segoe UI", sans-serif`;
    const colors = (f) => (f.name ? ["#0e9f6e", "#ffffff"] : ["#f0a020", "#241703"]);

    // 1) Plan label positions (same rules as on screen: below, above, else number only).
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
      let text = `${i + 1}  ${faceLabel(f)}`;
      let rect = tryText(text);
      let mini = false;
      if (!rect) {
        mini = true;
        text = `${i + 1}`;
        rect = tryText(text) || { x: x1, y: Math.min(H - th, y2 + lw * 2), w: measure.measureText(text).width + fs, h: th };
      }
      placed.push(rect);
      return { text, rect, mini };
    });

    // 2) If any label had to be shortened, add a legend under the photo.
    const legend = labels.some((l) => l.mini)
      ? r.faces.map((f, i) => `${i + 1}. ${faceLabel(f)}`).join("   ·   ")
      : "";
    const legendLines = [];
    if (legend) {
      measure.font = `600 ${fs}px Inter, "Segoe UI", sans-serif`;
      let line = "";
      for (const part of legend.split("   ·   ")) {
        const next = line ? `${line}   ·   ${part}` : part;
        if (measure.measureText(next).width > W - fs * 2 && line) { legendLines.push(line); line = part; }
        else line = next;
      }
      if (line) legendLines.push(line);
    }
    const legendH = legendLines.length ? legendLines.length * fs * 1.6 + fs * 1.6 : 0;

    // 3) Draw.
    const c = document.createElement("canvas");
    c.width = W;
    c.height = Math.round(H + legendH);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    ctx.lineWidth = lw;
    r.faces.forEach((f) => {
      const [x1, y1, x2, y2] = f.box;
      ctx.strokeStyle = colors(f)[0];
      ctx.setLineDash(f.name ? [] : [lw * 3, lw * 2]);
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    });
    ctx.setLineDash([]);
    ctx.font = font;
    ctx.textBaseline = "middle";
    labels.forEach(({ text, rect }, i) => {
      const [bg, ink] = colors(r.faces[i]);
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(rect.x, rect.y, rect.w, rect.h, th / 2);
      ctx.fill();
      ctx.fillStyle = ink;
      ctx.fillText(text, rect.x + fs / 2, rect.y + th / 2);
    });
    if (legendLines.length) {
      ctx.font = `600 ${fs}px Inter, "Segoe UI", sans-serif`;
      ctx.fillStyle = "#17161a";
      legendLines.forEach((line, k) => ctx.fillText(line, fs, H + fs * 1.6 * (k + 1)));
    }

    c.toBlob((blob) => {
      const a = document.createElement("a");
      const base = (state.photoFile?.name || "photo").replace(/\.[^.]+$/, "");
      a.href = URL.createObjectURL(blob);
      a.download = `${base} - labelled.jpg`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }, "image/jpeg", 0.92);
  }

  // ------------------------------------------------------------------ drawer
  function renderPeople() {
    const q = $("peopleSearch").value.trim().toLowerCase();
    const seen = new Set((state.result?.faces || []).filter((f) => f.name).map((f) => f.name));
    const list = state.people.filter((p) => p.name.toLowerCase().includes(q));
    $("drawerSub").textContent = `${state.people.length} people` + (seen.size ? ` · ${seen.size} in the current photo` : "");
    $("peopleGrid").innerHTML = list.length
      ? list.map((p) => `<div class="person${seen.has(p.name) ? " seen" : ""}"><img src="${p.thumb}" alt="" loading="lazy"><span>${esc(p.name)}</span></div>`).join("")
      : `<p class="muted">No names match “${esc(q)}”.</p>`;

    if (state.issues.length) {
      $("issues").innerHTML = `<h3>${state.issues.length} photo${state.issues.length > 1 ? "s" : ""} need attention</h3><ul>` +
        state.issues.map((i) => `<li class="${i.warning ? "" : "err"}"><b>${esc(String(i.file).split(/[\\/]/).pop())}</b>: ${esc(i.problem)}</li>`).join("") + "</ul>";
    }
    show("issues", state.issues.length > 0);
  }

  let lastFocus = null;
  function openDrawer() {
    lastFocus = document.activeElement;
    renderPeople();
    show("drawerBackdrop", true);
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
    setTimeout(() => $("drawerClose").focus(), 50);
  }
  function closeDrawer() {
    if (!$("drawer").classList.contains("open")) return;
    $("drawer").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    show("drawerBackdrop", false);
    lastFocus?.focus?.();
  }

  // ------------------------------------------------------------------ drag & drop / paste
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
    const hint = (on, text) => {
      show("dropHint", on);
      if (text) $("dropHintText").textContent = text;
    };
    window.addEventListener("dragenter", (e) => {
      if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
      depth++;
      const n = e.dataTransfer.items?.length || 0;
      hint(true, !state.people.length || n > 1 ? "Drop the people folder" : "Drop the group photo");
    });
    window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) hint(false); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      depth = 0;
      hint(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const { files, hadDir } = await entriesToFiles(dt.items || []);
      const all = files.length ? files : [...dt.files];
      if (hadDir || all.length > 1) loadFolder(all);
      else if (all.length === 1) identify(all[0]);
    });
    window.addEventListener("paste", (e) => {
      const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
      if (file) identify(file);
    });
  }

  // ------------------------------------------------------------------ wire up
  function init() {
    const openFolder = () => { $("folderInput").value = ""; $("folderInput").click(); };
    const choosePhoto = () => { $("photoInput").value = ""; $("photoInput").click(); };

    $("openFolderBtn").addEventListener("click", openFolder);
    $("changeFolderBtn").addEventListener("click", openFolder);
    $("changeFolderInline").addEventListener("click", openFolder);
    $("choosePhotoBtn").addEventListener("click", choosePhoto);
    $("newPhotoBtn").addEventListener("click", choosePhoto);
    $("folderInput").addEventListener("change", (e) => loadFolder([...e.target.files]));
    $("photoInput").addEventListener("change", (e) => e.target.files[0] && identify(e.target.files[0]));
    $("folderChip").addEventListener("click", openDrawer);
    $("viewPeopleBtn").addEventListener("click", openDrawer);
    $("drawerClose").addEventListener("click", closeDrawer);
    $("drawerBackdrop").addEventListener("click", closeDrawer);
    $("peopleSearch").addEventListener("input", renderPeople);
    $("threshold").addEventListener("input", onThreshold);
    $("downloadBtn").addEventListener("click", () => download().catch((e) => toast(e.message, "error")));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

    bindLinking();
    bindDrop();
    let resizeTimer;
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!state.result) return;
        $("overlay").classList.add("settled"); // don't replay entry animations
        layoutTags();
      }, 80);
    }).observe($("photoWrap"));

    api("/api/status")
      .then((s) => {
        state.threshold = s.default_threshold;
        $("threshold").value = s.default_threshold;
      })
      .catch(() => toast("Can't reach the app server. Start it with run.bat.", "error", 8000));
    updateSteps();
  }

  init();
})();
