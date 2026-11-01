/* The editor's JS: its state, tools and panels. The editing rules come from edit.js and what the
 * map looks like from scene.js. It draws its panels with the UI functions the C++ host
 * provides (a thin layer over Dear ImGui, see src/ui_bind.cpp) and hands the map to the host as
 * numbers in a Float64Array plus a string table. Global NE.
 *
 * The host calls, each frame: layout(), drawLevels(), drawToolbar(), drawSide(), drawModals();
 * on the map: mouseDown/mouseMove/mouseUp, key(); then poll() to learn what changed, scene() and
 * overlay() for the drawing, runJobs() for anything asynchronous the panels started. */
(function (root) {
  "use strict";
  const WB = root.WB, WBScene = root.WBScene, WBEdit = root.WBEdit;
  const UI = root.UI, NATIVE = root.NATIVE;

  const S = {
    movie: null, game: null, scene: null, levels: [], cur: -1, fileName: "", filePath: null,
    info: new Map(), pending: new Set(), textEdits: new Map(), patchOn: {}, imported: null,
    tool: "paint", prevTool: null,
    brush: { kind: "terrain", char: "." }, objCat: "model",
    pileDraft: [["yellow", 10], ["energy", 1]], planCount: 10, goalTarget: "anything", whirlId: "1",
    sel: null, drag: null, hover: null, hoverText: "", mod: false, hideGhost: false,
    clip: null, pasting: false,
    showGrid: true, showView: true,
    status: "Open a World Builder Launcher.exe to start.",
    tab: "palette", tabForce: null, textBuf: null, textFor: null,
    modal: null, jobs: [], flags: 0, shift: [0, 0],
    levelsShown: true, sideW: 360,
  };
  // poll() flags
  const F_SCENE = 1, F_LEVEL = 2, F_SHIFT = 4, F_OPENED = 8;

  const E = WBEdit.create(S, { status: setStatus });
  const L = () => S.levels[S.cur];
  const lvl = () => L() && L().lv;
  const inMap = (x, y) => E.inMap(lvl(), x, y);
  const displayName = (n) => S.scene.displayName(n);
  const baseOf = (p) => p[0].replace(/^water/, "");
  const basename = (p) => String(p).replace(/^.*[/\\]/, "");
  const dirname = (p) => (p ? String(p).replace(/[/\\][^/\\]*$/, "") : "");
  function setStatus(t) { S.status = t; }
  const later = (fn) => S.jobs.push(fn);

  // ---------------------------------------------------------------- preferences (prefs.json)

  let prefs = {};
  function loadPrefs() { try { prefs = JSON.parse((NATIVE && NATIVE.prefsLoad()) || "{}") || {}; } catch (e) { prefs = {}; } }
  const pref = (k) => prefs[k];
  function setPref(k, v) { prefs[k] = v; try { if (NATIVE) NATIVE.prefsSave(JSON.stringify(prefs)); } catch (e) { /* not saved */ } }
  loadPrefs();
  S.showGrid = pref("showGrid") !== false;
  S.showView = pref("showView") !== false;
  if (pref("levelsShown") === false) S.levelsShown = false;
  if (+pref("sideW") > 0) S.sideW = +pref("sideW");

  // ---------------------------------------------------------------- opening

  async function open(bytes, path, want) {
    const movie = await WB.openMovie(bytes);
    if (!movie.wrapper) throw new Error("That isn't a game launcher. Open Launcher.exe from a World Builder game folder.");
    const game = await movie.loadGame();
    if (!game.levels.length) throw new Error("This movie has no WorldBuilder levels in it.");
    await loadMovie(movie, game, path, want);
  }

  async function loadMovie(movie, game, path, want) {
    Object.assign(S, {
      movie, game, fileName: basename(path), filePath: path, info: new Map(), pending: new Set(), textEdits: new Map(),
      imported: null, sel: null, drag: null, clip: null, pasting: false, hover: null, hoverText: "", textFor: null,
    });
    S.levels = game.levels.map((l) => ({ ...l, lv: null, dirty: false, undo: [], redo: [] }));
    S.scene = WBScene.create({
      game,
      sprite: spriteInfo,
      hasSprite,
      // a monster's icon counts while the Monster plans patch is ticked (it's added to the game on save)
      planIcon: (s) => (S.monsterPlanIcons && S.monsterPlanIcons.has(s) ? !!S.patchOn.monsterPlans : hasSprite(s)),
      showGrid: () => S.showGrid,
    });
    await E.loadFinds();
    E.initPatches(pref("patches" + game.edition) || null);
    S.flags |= F_OPENED;
    // WBE_LEVEL, else the level last edited in this game, else world 1 mission 1
    const by = (m) => S.levels.findIndex((l) => l.member === m);
    const pick = [want && by(want), by(pref("level" + game.edition)), S.levels.findIndex((l) => l.world === 1 && l.mission === 1)].find((i) => i >= 0);
    selectLevel(pick >= 0 ? pick : 0);
  }

  // Put a .dcr's movie inside the open Launcher.exe; it reaches the file on the next save
  async function importDcr(path) {
    const movie = await WB.openMovie(NATIVE.readFile(path));
    if (movie.wrapper) throw new Error("That's a program, not a .dcr movie.");
    const game = await movie.loadGame();
    if (!game.levels.length) throw new Error("This movie has no WorldBuilder levels in it.");
    const go = async () => {
      movie.wrapper = S.movie.wrapper;
      await loadMovie(movie, game, S.filePath);
      S.imported = basename(path);
      setStatus(`Imported ${basename(path)}. Save to write it into ${S.fileName}.`);
    };
    if (game.edition !== S.game.edition) {
      const ed = (e) => "World Builder" + (e === 2 ? " 2" : "");
      confirm(`${basename(path)} is ${ed(game.edition)}, but ${S.fileName} is ${ed(S.game.edition)}. Import it anyway?`, "Import", () => later(go));
    } else await go();
  }

  function hasSprite(name) {
    if (S.monsterArtMembers && S.monsterArtMembers.has(name)) return !!S.patchOn.monsterArt;
    const m = S.movie.byName.get(name);
    return !!m && m.type === 1;
  }
  // {w, h, regX, regY} of a loaded sprite, else null (and it's queued for loading)
  function spriteInfo(name) {
    const v = S.info.get(name);
    if (v === undefined) S.pending.add(name);
    return v || null;
  }
  const need = (name) => { if (name) spriteInfo(name); return name || ""; };

  // ---------------------------------------------------------------- levels, undo

  function ensureParsed(e) {
    if (!e.lv) e.lv = WB.parseLevel(e.text, S.game.terrain);
    return e.lv;
  }
  function selectLevel(i) {
    S.cur = i;
    ensureParsed(L());
    setPref("level" + S.game.edition, L().member);
    S.sel = null;
    S.drag = null;
    S.hover = null;
    S.hoverText = "";
    S.textFor = null;
    S.flags |= F_LEVEL | F_SCENE;
  }
  function snapshot() {
    const lv = lvl();
    return JSON.stringify({ name: lv.name, center: lv.center, items: lv.items, inventory: lv.inventory, mapExtra: lv.mapExtra, other: lv.other, grid: lv.grid });
  }
  function pushUndo() {
    const e = L();
    e.undo.push(snapshot());
    if (e.undo.length > 200) e.undo.shift();
    e.redo = [];
  }
  function changed() {
    const e = L();
    e.dirty = true;
    e.textCache = null;
    S.textFor = null;
    refreshHover();
    S.flags |= F_SCENE;
  }
  function undo() {
    const e = L();
    if (!e || !e.undo.length) return;
    e.redo.push(snapshot());
    Object.assign(lvl(), JSON.parse(e.undo.pop()));
    changed();
  }
  function redo() {
    const e = L();
    if (!e || !e.redo.length) return;
    e.undo.push(snapshot());
    Object.assign(lvl(), JSON.parse(e.redo.pop()));
    changed();
  }
  // one undoable change to the current level: fn() returns false if nothing changed
  function edit(fn) {
    pushUndo();
    if (fn() === false) L().undo.pop();
    else changed();
  }
  function refreshHover() {
    S.hoverText = S.hover && inMap(...S.hover) ? S.scene.cellLabel(lvl(), ...S.hover) : "";
  }

  // ---------------------------------------------------------------- tools and brush

  const canErase = () => S.brush.kind === "object";
  function setTool(t) {
    if (t === "erase" && !canErase()) { setStatus("Erase removes objects: pick an object brush first (or right-click an object to delete it)."); return; }
    if (t !== "select" && S.pasting) stopPasting();
    S.tool = t;
  }
  function setBrushTerrain(ch) {
    S.brush = { kind: "terrain", char: ch };
    if (!["paint", "fill"].includes(S.tool)) setTool("paint");
    S.sel = null;
  }
  function setBrushObject(o) {
    S.brush = { kind: "object", ...o };
    S.objCat = E.categoryOf(o);
    if (S.tool !== "paint") setTool("paint");
  }
  function showTab(t) { S.tab = t; S.tabForce = t; }
  // Brush with an object picks objects up (terrain brushes and Fill never do; Select always does)
  const selectsObjects = () => S.tool === "select" || (S.tool === "paint" && S.brush.kind === "object");

  function recipeBrush(name) {
    const rows = E.recipeRows(name);
    if (!rows) { setStatus(`The game doesn't list a recipe for ${displayName(name)}.`); return; }
    S.pileDraft = rows;
    setBrushObject({ type: "pile" });
    showTab("palette");
    setStatus(`Brush: brick pile for ${displayName(name)} (${rows.map(([res, n]) => `${n} ${res}`).join(", ")}).`);
  }
  function pickAt(x, y) {
    const b = E.pickAt(lvl(), x, y);
    if (!b) return;
    if (b.kind === "terrain") { setBrushTerrain(b.char); return; }
    const { kind, ...o } = b;
    setBrushObject(o);
    setTool("paint");
  }

  function startPasting() {
    S.pasting = true;
    S.sel = null;
    setStatus(`Copied ${S.clip.w}×${S.clip.h} tiles. Click the map to place a copy (its top-left corner goes on the tile under the mouse); Esc stops.`);
  }
  function stopPasting() { S.pasting = false; setStatus(""); }

  function startStroke(op, x, y) {
    pushUndo();
    S.drag = { op, changed: op(x, y) };
    if (S.drag.changed) S.flags |= F_SCENE;
    refreshHover();
  }
  const opApply = (x, y) => E.applyBrush(lvl(), x, y);
  const opErase = (x, y) => E.eraseAt(lvl(), x, y);

  // ---------------------------------------------------------------- the map's mouse and keys

  // button 0 left, 1 right, 2 middle (SDL order differs from the DOM's: right is 1 here).
  // Returns false when the press should pan the map instead.
  function mouseDown(x, y, button, shift, ctrl, alt, space) {
    if (!lvl()) return false;
    const onObject = inMap(x, y) && lvl().grid[y][x].item >= 0;
    // right-click on an object deletes it (dragging keeps deleting); elsewhere right-drag pans
    if (button === 1 && onObject && !space) { startStroke(opErase, x, y); return true; }
    if (button !== 0 || space) return false;
    if (!inMap(x, y)) return true;
    if (S.tool === "select" && S.pasting) { edit(() => E.pasteAt(lvl(), S.clip, x, y)); return true; }
    // Shift + Brush drags out a filled rectangle; Shift + Select copies one (from anywhere, even an object)
    const rectDrag = (S.tool === "paint" || S.tool === "select") && shift;
    // Shift+click on a plan loads the brush with a pile of the bricks its model needs
    if (shift && onObject && E.isPlanAt(lvl(), x, y)) {
      if (rectDrag) S.drag = { rect: [x, y, x, y], plan: true, copy: S.tool === "select" };
      else recipeBrush(lvl().items[lvl().grid[y][x].item].parts[1]);
      return true;
    }
    if (onObject && S.tool === "paint" && (alt || ctrl)) {
      edit(() => { const r = E.replaceAt(lvl(), x, y); if (r) S.sel = null; return r; });
      return true;
    }
    // Objects: pressing on one selects it, and dragging moves it straight away
    if (onObject && selectsObjects() && !rectDrag) {
      const fresh = !S.sel || S.sel[0] !== x || S.sel[1] !== y;
      S.sel = [x, y];
      S.drag = { move: { from: [x, y], to: [x, y] } };
      if (fresh && S.tool === "select") showTab("inspect");
      return true;
    }
    if (S.tool !== "select") S.sel = null;
    switch (S.tool) {
      case "paint":
        if (rectDrag) S.drag = { rect: [x, y, x, y] };
        else startStroke(opApply, x, y);
        break;
      case "erase": startStroke(opErase, x, y); break;
      case "fill": edit(() => E.floodFill(lvl(), x, y)); break;
      case "pick": pickAt(x, y); break;
      case "select": S.drag = { rect: [x, y, x, y], copy: true }; break;
      case "start": // one click from the Level tab's "Pick on map", then back to the previous tool
        edit(() => { lvl().center = [x + 1, y + 1]; });
        setTool(S.prevTool || "paint");
        setStatus("Start view set.");
        break;
    }
    return true;
  }

  function mouseMove(x, y, inside, mod) {
    S.mod = !!mod;
    if (!lvl()) return;
    const nh = inside && inMap(x, y) ? [x, y] : null;
    if (S.drag && nh) {
      if (S.drag.move) { S.drag.move.to = [x, y]; S.flags |= F_SCENE; }
      else if (S.drag.rect) { S.drag.rect[2] = x; S.drag.rect[3] = y; }
      else if (S.drag.op(x, y)) { S.drag.changed = true; S.flags |= F_SCENE; }
    }
    if (String(nh) !== String(S.hover)) {
      S.hover = nh;
      refreshHover();
    }
  }

  function mouseUp() {
    const d = S.drag;
    if (!d) return;
    S.drag = null;
    if (d.move) {
      S.flags |= F_SCENE;
      if (E.canMove(lvl(), d.move.from, d.move.to)) {
        pushUndo();
        E.moveObject(lvl(), d.move.from, d.move.to);
        S.sel = d.move.to;
        changed();
      } else if (String(d.move.from) !== String(d.move.to)) {
        setStatus("That object can't stand on that tile (or the object there can't stand on this one).");
      }
    } else if (d.rect && d.plan && d.rect[0] === d.rect[2] && d.rect[1] === d.rect[3]) {
      recipeBrush(lvl().items[lvl().grid[d.rect[1]][d.rect[0]].item].parts[1]);
    } else if (d.copy && d.rect[0] === d.rect[2] && d.rect[1] === d.rect[3]) {
      S.sel = [d.rect[0], d.rect[1]];
      showTab("inspect");
    } else if (d.copy) {
      S.clip = E.copyArea(lvl(), ...d.rect);
      startPasting();
    } else if (d.rect) {
      edit(() => E.fillRect(lvl(), ...d.rect));
    } else if (d.changed) changed();
    else L().undo.pop();
  }

  // key: a lower-case letter, "escape", "delete"; returns whether it was used
  function key(k, ctrl, shift) {
    if (S.modal) return false;
    if (ctrl) {
      if (k === "z") { shift ? redo() : undo(); return true; }
      if (k === "y") { redo(); return true; }
      if (k === "s") { if (S.movie) openSave(); return true; }
      // pick up the last copied tiles again (they can go into another level too)
      if (k === "v" && S.clip && lvl()) { setTool("select"); startPasting(); return true; }
      if (k === "o") { requestOpen(); return true; }
      return false;
    }
    if (k === "l") { S.levelsShown = !S.levelsShown; setPref("levelsShown", S.levelsShown); return true; }
    if (!lvl()) return false;
    if (k === "escape" && S.tool === "start") { setTool(S.prevTool || "paint"); setStatus(""); return true; }
    if (k === "escape" && S.pasting) { stopPasting(); return true; }
    const map = { b: "paint", f: "fill", e: "erase", i: "pick", s: "select" };
    if (map[k]) { setTool(map[k]); return true; }
    if (k === "escape" && S.sel) { S.sel = null; return true; }
    if (k === "delete" && S.sel) { edit(() => E.eraseAt(lvl(), ...S.sel)); return true; }
    return false;
  }

  // What the mouse pointer looks like over the map: "grab", "grabbing", "pointer", "copy" or "crosshair"
  function cursor() {
    const h = S.hover && lvl() && inMap(...S.hover) ? S.hover : null;
    const overObject = h && lvl().grid[h[1]][h[0]].item >= 0;
    const overSelected = overObject && S.sel && String(S.sel) === String(h);
    const objectTools = selectsObjects();
    return S.drag && S.drag.move ? "grabbing"
      : S.tool === "pick" || (S.tool === "select" && S.pasting) ? "copy"
      : objectTools && overSelected ? "grab"
      : objectTools && overObject ? "pointer"
      : S.tool === "select" ? "pointer" : "crosshair";
  }

  // ---------------------------------------------------------------- drawing commands for the host

  /* Commands as 10 numbers each (string fields are indices into strs, -1 for none):
   *   0 img   name x y            1 imgs  name x y w h
   *   2 badge text x y bg fg outline
   *   3 face  tx ty inset fill stroke lineWidth screenPx dashOn dashOff
   *   4 alpha a
   *   5 tiles x0 y0 x1 y1 stroke lineWidth screenPx dashOn dashOff   (outline of a block of tiles)
   *   6 popup tx ty heading target   (the game's goal popup over tile tx, ty)
   * Sprites that aren't loaded yet are left out; after loadPending() the scene is worth asking for again. */
  function pack(cmds) {
    const strs = [], ids = new Map();
    const str = (s) => { if (s == null) return -1; let k = ids.get(s); if (k === undefined) { k = strs.length; strs.push(s); ids.set(s, k); } return k; };
    const nums = new Float64Array(cmds.length * 10);
    cmds.forEach((c, n) => {
      const o = n * 10;
      switch (c[0]) {
        case "img": nums.set([0, str(c[1]), c[2], c[3]], o); break;
        case "imgs": nums.set([1, str(c[1]), c[2], c[3], c[4], c[5]], o); break;
        case "badge": nums.set([2, str(c[1]), c[2], c[3], str(c[4]), str(c[5]), str(c[6])], o); break;
        case "face": nums.set([3, c[1], c[2], c[3], str(c[4]), str(c[5]), c[6], c[7] ? 1 : 0, c[8] ? c[8][0] : 0, c[8] ? c[8][1] : 0], o); break;
        case "alpha": nums.set([4, c[1]], o); break;
        case "popup": nums.set([6, c[1], c[2], str(c[3]), str(c[4])], o); break;
        case "tiles": nums.set([5, c[1], c[2], c[3], c[4], str(c[5]), c[6], c[7] ? 1 : 0, c[8] ? c[8][0] : 0, c[8] ? c[8][1] : 0], o); break;
      }
    });
    return { nums, strs };
  }

  // The level's map; while an object is dragged, its old tile (and one it would swap with) shows faded
  function scene() {
    const lv = lvl();
    const mv = S.drag && S.drag.move;
    const moving = mv && String(mv.from) !== String(mv.to);
    const faded = moving ? (x, y) => String([x, y]) === String(mv.from) || String([x, y]) === String(mv.to) : null;
    return pack(S.scene.map(lv, undefined, faded));
  }

  // What follows the mouse and the selection, drawn over the map (hideGhost: panning)
  function overlay(hideGhost) {
    const lv = lvl(), out = [];
    if (!lv) return pack(out);
    const obj = (p, x, y) => out.push(...S.scene.object(p, x, y, true));
    const mv = S.drag && S.drag.move;
    if (mv && String(mv.from) !== String(mv.to)) {
      const ok = E.canMove(lv, mv.from, mv.to);
      const [a, b] = E.movedParts(lv, mv.from, mv.to);
      out.push(["alpha", ok ? 0.9 : 0.45]);
      obj(a || lv.items[lv.grid[mv.from[1]][mv.from[0]].item].parts, ...mv.to);
      if (b && ok) obj(b, ...mv.from);
      out.push(["alpha", 1]);
      if (!ok) out.push(["face", mv.to[0], mv.to[1], 1, "#ff3b3040", "#ff5d5d", 2, true, null]);
    }
    const h = S.hover && inMap(...S.hover) ? S.hover : null;
    // the brush object, faintly, wherever a click would put it down
    if (h && !hideGhost && (!S.drag || S.drag.op) && ["paint", "fill"].includes(S.tool) && S.brush.kind === "object") {
      const c = lv.grid[h[1]][h[0]];
      const p = (c.item < 0 || S.tool === "fill" || S.mod) && E.ghostParts(lv, ...h);
      if (p) { out.push(["alpha", 0.7]); obj(p, ...h); out.push(["alpha", 1]); }
    }
    // the copied tiles, where a click would place them
    if (h && !hideGhost && S.pasting && S.clip && S.tool === "select" && !S.drag) {
      const [hx, hy] = h, { w, h: ch, cells } = S.clip;
      out.push(["alpha", 0.75]);
      cells.forEach((row, j) => row.forEach((src, i) => {
        const name = S.scene.terrainSprite(src.t, src.parts);
        const [ox, oy] = WBScene.cellOrigin(hx + i, hy + j);
        if (name !== "terrain.hole" && spriteInfo(name)) { const s = S.info.get(name); out.push(["img", name, Math.round(ox - s.regX), Math.round(oy - s.regY)]); }
      }));
      cells.forEach((row, j) => row.forEach((src, i) => { if (src.parts) obj(src.parts, hx + i, hy + j); }));
      out.push(["alpha", 1]);
      out.push(["tiles", hx, hy, hx + w, hy + ch, "#2a7de1", 2, true, [8, 5]]);
    }
    if (S.drag && S.drag.rect) {
      const [x0, y0, x1, y1] = S.drag.rect;
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        if (inMap(x, y)) out.push(["face", x, y, 0, S.drag.copy ? "#2a7de140" : "#ffcf1a40", null, 0, false, null]);
      }
    }
    if (S.sel && inMap(...S.sel)) out.push(["face", S.sel[0], S.sel[1], 1, null, "#2a7de1", 3, true, null]);
    if (h) out.push(["face", h[0], h[1], 1, null, "#ffcf1a", 2, true, null]);
    // a goal's objective shows while the mouse is over it, on top of everything, as in the game
    if (h && !mv) {
      const c = lv.grid[h[1]][h[0]];
      const p = c.item >= 0 && lv.items[c.item].parts;
      if (p && (p[0] === "goal" || p[0] === "bonusgoal")) out.push(["popup", h[0], h[1], p[0] === "goal" ? "Mission Goal:" : "Bonus Goal:", E.goalObjective(p[1])]);
    }
    return pack(out);
  }

  const hasPending = () => S.pending.size > 0;

  // Decode the sprites asked for since the last call: [[name, w, h, regX, regY, rgba]] (rgba null if
  // the game has no such bitmap). The editor keeps only their sizes; the pixels go to the host.
  async function loadPending() {
    const out = [];
    for (const name of [...S.pending]) {
      S.pending.delete(name);
      let bm = await S.movie.bitmap(name);
      if (!bm && S.monsterArtMembers.has(name)) bm = WB.wb1MonsterSprite(name);
      if (!bm && S.monsterPlanIcons.has(name)) { const ic = S.monsterPlanIcons.get(name).icon; bm = { ...ic, rgba: new Uint8ClampedArray(ic.rgba) }; }
      S.info.set(name, bm ? { w: bm.w, h: bm.h, regX: bm.regX, regY: bm.regY } : null);
      out.push([name, bm ? bm.w : 0, bm ? bm.h : 0, bm ? bm.regX : 0, bm ? bm.regY : 0, bm ? new Uint8Array(bm.rgba.buffer, bm.rgba.byteOffset, bm.rgba.length) : null]);
    }
    return out;
  }

  // [width, height] in tiles
  function size() { const lv = lvl(); return lv ? [lv.grid.length ? lv.grid[0].length : 0, lv.grid.length] : [0, 0]; }
  const label = (x, y) => S.scene.cellLabel(lvl(), x, y);
  // [x, y] tile under a screen point
  const cellAt = (vx, vy, zoom, sx, sy) => WBScene.screenToCell({ x: vx, y: vy, zoom }, sx, sy);
  // [x, y, zoom] that fits the level in a width×height window (zoom > 0 keeps that zoom)
  function fit(width, height, zoom) {
    const [w, h] = size();
    const v = WBScene.fitView(w, h, width, height, zoom > 0 ? zoom : null);
    return [v.x, v.y, v.zoom];
  }
  // [left, top, right, bottom (tiles), centerX, centerY (tile, 0-based), hasCenter]
  function startView() {
    const lv = lvl(), [w, h] = size();
    if (!lv) return [0, 0, 0, 0, 0, 0, 0];
    const { left, top, c } = WBScene.startViewRect(lv, w, h);
    return [left, top, Math.min(w, left + WBScene.VIEW_W), Math.min(h, top + WBScene.VIEW_H), c[0] - 1, c[1] - 1, lv.center ? 1 : 0];
  }
  // What changed since the last poll: [flags, shiftX, shiftY (tiles the old map moved by), showView, hasLevel]
  function poll() {
    if (S.flags) S.ver = (S.ver || 0) + 1; // anything that changes the map or level invalidates the panels' caches
    const r = [S.flags, S.shift[0], S.shift[1], S.showView ? 1 : 0, lvl() ? 1 : 0];
    S.flags = 0;
    S.shift = [0, 0];
    return r;
  }
  // [level list width (0: hidden), side panel width (0: none)]
  // (the side panel gives way in a narrow window, leaving the map at least a third)
  const layout = (total) => {
    const left = S.levelsShown ? 230 : 34;
    return [left, S.game ? Math.max(240, Math.min(S.sideW, (total - left) * 0.5)) : 0];
  };
  function setSideWidth(w) { S.sideW = Math.max(260, Math.min(700, Math.round(w))); setPref("sideW", S.sideW); }
  const statusLine = () => [S.status, S.hoverText];

  // Run what the panels started that has to wait (files, saving); errors are shown in a box
  async function runJobs() {
    while (S.jobs.length) {
      const fn = S.jobs.shift();
      try { await fn(); } catch (e) { alert(e.message || String(e)); setStatus(e.message || String(e)); }
    }
  }
  const hasJobs = () => S.jobs.length > 0;

  // ---------------------------------------------------------------- files

  // The host's file dialog answered (path null: cancelled), or a file was dropped on the window
  async function onDialog(kind, path) {
    if (!path) return;
    try {
      switch (kind) {
        case "open": case "drop":
          if (/\.dcr$/i.test(path)) {
            if (!S.movie) { alert("Open the game's Launcher.exe first, then use Import .dcr… to bring this movie into it."); return; }
            if (E.unsaved()) confirm("You have unsaved changes. Import this movie anyway?", "Import", () => later(() => importDcr(path)));
            else await importDcr(path);
            return;
          }
          if (S.movie && E.unsaved()) { confirm("You have unsaved changes. Open another file anyway?", "Open", () => later(() => openPath(path))); return; }
          await openPath(path);
          return;
        case "dcr": await importDcr(path); return;
        case "saveExe": await save("exe", withExt(path, "exe")); return;
        case "saveDcr": await save("dcr", withExt(path, "dcr")); return;
        case "txtExport": {
          path = withExt(path, "txt");
          NATIVE.writeFile(path, new TextEncoder().encode(E.levelText(L()).replace(/\n/g, "\r\n")));
          setStatus(`Exported ${basename(path)}.`);
          return;
        }
        case "txtImport":
          S.textBuf = new TextDecoder().decode(NATIVE.readFile(path));
          applyText();
          return;
      }
    } catch (e) {
      alert(`Couldn't ${kind === "saveExe" || kind === "saveDcr" ? "save" : "open"} that file.\n\n${e.message}`);
      setStatus(e.message);
    }
  }
  async function openPath(path, want) {
    setStatus(`Reading ${basename(path)}…`);
    try {
      await open(NATIVE.readFile(path), path, want);
      setStatus(`Opened ${basename(path)}.`);
    } catch (e) {
      setStatus("Couldn't open that file: " + e.message);
      alert("Couldn't open that file.\n\n" + e.message);
    }
  }
  function requestOpen() {
    if (S.movie && E.unsaved()) confirm("You have unsaved changes. Open another file anyway?", "Open", () => NATIVE.fileDialog("open", false, dirname(S.filePath), "exe"));
    else NATIVE.fileDialog("open", false, dirname(S.filePath), "exe");
  }
  function requestImport() {
    const go = () => NATIVE.fileDialog("dcr", false, dirname(S.filePath), "dcr");
    if (E.unsaved()) confirm("You have unsaved changes. Import a movie anyway?", "Import", go); else go();
  }
  const withExt = (p, ext) => (/\.[^./\\]+$/.test(p) ? p : p + "." + ext);

  // kind "exe" saves the Launcher.exe; "dcr" exports just the movie and leaves the edits unsaved
  async function save(kind, path) {
    const dcr = await E.buildMovie();
    const exe = kind === "exe";
    const bytes = exe ? WB.wrapProjector(S.movie.wrapper, dcr) : dcr;
    const backup = NATIVE.saveFile(path, bytes);
    const mb = (bytes.length / 1048576).toFixed(2);
    if (exe) {
      setPref("patches" + S.game.edition, E.markSaved());
      S.filePath = path;
      S.fileName = basename(path);
      S.textFor = null;
      setStatus(`Saved ${S.fileName} (${mb} MB).`);
    } else setStatus(`Exported ${basename(path)} (${mb} MB).${E.unsaved() ? ` ${S.fileName} isn't saved yet.` : ""}`);
    if (backup) setStatus(`${S.status} The original was kept as ${basename(backup)}.`);
  }
  function openSave() {
    if (!S.movie) return;
    S.modal = { kind: "save", issues: E.saveProblems() };
  }
  // the host asks before closing the window
  const unsaved = () => !!S.movie && E.unsaved();
  function askQuit() { confirm("You have unsaved changes. Quit anyway?", "Quit", () => NATIVE.quit()); }

  // ---------------------------------------------------------------- dialogs

  function alert(text) { S.modal = { kind: "alert", text }; }
  function confirm(text, yes, onYes) { S.modal = { kind: "confirm", text, yes, onYes }; }

  // ---------------------------------------------------------------- panels: helpers

  const MUTED = "#9097a6", ERR = "#ff5d5d", WARN = "#f2a33a", OK = "#3fae49";
  const note = (t) => UI.textColored(MUTED, t, true);
  // a label to the left of a control
  function field(label, draw) {
    UI.alignText();
    UI.text(label);
    UI.sameLine(110);
    UI.setNextItemWidth(-1);
    return draw();
  }
  const comboOf = (label, value, entries) => {
    // entries: [value, label] or "## group"
    const items = entries.map((e) => (typeof e === "string" ? e : e[1]));
    const idx = entries.findIndex((e) => typeof e !== "string" && e[0] === value);
    const r = UI.combo(label, idx, items);
    return r !== idx && r >= 0 && typeof entries[r] !== "string" ? entries[r][0] : undefined;
  };
  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v) || lo));

  function pileEditor(rows, onchange) {
    rows.forEach((row, i) => {
      UI.pushId("pile" + i);
      UI.setNextItemWidth(Math.max(80, UI.availWidth() - 130));
      const r = comboOf("##res", row[0], S.game.resources.map((x) => [x, x]));
      if (r !== undefined) { row[0] = r; onchange(rows); }
      UI.sameLine();
      UI.setNextItemWidth(90);
      const n = UI.inputInt("##n", row[1], 1, 999);
      if (n !== row[1]) { row[1] = n; onchange(rows); }
      UI.sameLine();
      if (UI.button("×") && rows.length > 1) { rows.splice(i, 1); onchange(rows); }
      UI.tooltip("Remove");
      UI.popId();
    });
    if (UI.button("+ Add bricks")) { rows.push(["blue", 10]); onchange(rows); }
  }

  /* What a goal needs: any model, a particular vehicle, building or monster brought to the goal,
   * or "collect N <monster>" (monsters delivered to capture-zone tiles). */
  function goalTargetField(id, value, onchange) {
    const monsters = E.placeable("monster");
    const c = E.parseCollect(value);
    const entries = [];
    let group = "";
    for (const [v, lbl, g] of E.goalTargets(value)) {
      if (g !== group) { entries.push("## " + g); group = g; }
      entries.push([v, lbl]);
    }
    entries.push("## Capture zone", ["__collect__", "Collect monsters…"]);
    UI.pushId(id);
    const r = field("Needs", () => comboOf("##target", c ? "__collect__" : value, entries));
    if (r !== undefined) onchange(r === "__collect__" ? `collect 1 ${monsters[0] || "crab"}` : r);
    if (c) {
      UI.indent(110);
      UI.setNextItemWidth(90);
      const n = UI.inputInt("##count", c.n, 1, 99);
      UI.sameLine();
      UI.setNextItemWidth(-1);
      const m = comboOf("##monster", c.monster, [...new Set([...monsters, c.monster])].map((x) => [x, displayName(x)]));
      if (n !== c.n || m !== undefined) onchange(`collect ${n} ${m || c.monster}`);
      note("Monsters have to be brought to capture-zone tiles.");
      UI.unindent(110);
    }
    UI.popId();
  }

  // ---------------------------------------------------------------- level list and toolbar

  function drawLevels() {
    if (!S.levelsShown) {
      if (UI.button("»", -1)) { S.levelsShown = true; setPref("levelsShown", true); }
      UI.tooltip("Show the level list (L)");
      return;
    }
    UI.alignText();
    UI.text("Levels");
    UI.sameLine(UI.availWidth() - 22 + UI.cursorX());
    if (UI.smallButton("«")) { S.levelsShown = false; setPref("levelsShown", false); }
    UI.tooltip("Hide the level list (L)");
    const footer = S.game ? 4 : 1;
    UI.beginChild("list", 0, -UI.frameHeight() * footer - 8, false);
    let world = null;
    S.levels.forEach((l, i) => {
      if (l.world !== world) {
        world = l.world;
        UI.heading(world === 999 ? "Tutorial button map" : `World ${world}`, "#ffcf1a");
      }
      const num = l.world === 999 ? "–" : String(l.mission);
      if (UI.levelRow(l.member, num, E.listName(l), l.dirty, i === S.cur)) selectLevel(i);
      UI.tooltip(l.dirty ? `${l.member} (unsaved changes)` : l.member);
    });
    UI.endChild();
    if (S.game) {
      UI.textColored(MUTED, `World Builder${S.game.edition === 2 ? " 2" : ""} · ${S.levels.length} levels · editor ${NATIVE.version()}`, false);
      if (UI.button("Save…", -1, 0, "accent")) openSave();
      UI.tooltip("Write Launcher.exe with all your changes, or export the .dcr (Ctrl+S)");
      if (UI.button("Import .dcr…", -1)) requestImport();
      UI.tooltip("Replace the game in this Launcher.exe with a .dcr movie (written on the next save)");
    }
    if (UI.button("Open Launcher.exe…", -1, 0, S.game ? "ghost" : "primary")) requestOpen();
    UI.tooltip("Open Launcher.exe from a World Builder game folder (Ctrl+O)");
  }

  const TOOLS = [
    ["paint", "Brush", "Paint terrain or place objects (B). Hold Shift and drag to fill a rectangle. Click an object to select it, drag it to move it, or Alt/Ctrl+click it to replace it with the brush. Shift+click a plan to get a pile of the bricks its model needs."],
    ["fill", "Fill", "Flood fill matching terrain (F). Click an object to replace all connected copies of it with the brush."],
    ["erase", "Erase", "Remove objects (E)"],
    ["pick", "Eyedropper", "Pick a tile or object from the map (I)"],
    ["select", "Select", "Click a tile to inspect it and edit its object (S). Drag over tiles (Shift+drag to start on an object) to copy them, then click the map to place copies; Esc stops, Ctrl+V picks the copy up again."],
  ];
  function drawToolbar() {
    if (!lvl()) return;
    let first = true;
    const flow = (w) => { if (!first) UI.flow(w); first = false; };
    for (const [id, lbl, tip] of TOOLS) {
      const off = id === "erase" && !canErase();
      flow(UI.width(lbl, "button"));
      if (UI.toggle(lbl, S.tool === id, off, "tool")) setTool(id);
      UI.tooltip(off ? tip + ". Pick an object brush first." : tip);
    }
    flow(UI.width("Undo", "button"));
    if (UI.button("Undo", 0, 0, "ghost")) undo();
    UI.tooltip("Ctrl+Z");
    flow(UI.width("Redo", "button"));
    if (UI.button("Redo", 0, 0, "ghost")) redo();
    UI.tooltip("Ctrl+Y or Ctrl+Shift+Z");
    flow(UI.width("Grid", "checkbox"));
    const g = UI.checkbox("Grid", S.showGrid);
    if (g !== S.showGrid) { S.showGrid = g; setPref("showGrid", g); S.flags |= F_SCENE; }
    flow(UI.width("Start view", "checkbox"));
    const v = UI.checkbox("Start view", S.showView);
    if (v !== S.showView) { S.showView = v; setPref("showView", v); }
  }

  // ---------------------------------------------------------------- side panel

  function drawSide() {
    if (!lvl()) return;
    if (UI.beginTabBar("tabs")) {
      for (const [id, lbl] of [["palette", "Palette"], ["inspect", "Tile"], ["level", "Level"], ["text", "Text"], ["game", "Game"]]) {
        if (UI.tab(lbl, S.tabForce === id, (S.tabForce || S.tab) === id)) S.tab = id;
      }
      S.tabForce = null;
      UI.endTabBar();
    }
    const probs = cached("probs", () => WB.validateLevel(lvl(), S.game));
    // room for the problems, wrapped to the panel's width (up to 7 lines; more scroll)
    const wide = UI.availWidth();
    const lines = [...probs.errs, ...probs.warns].reduce((n, t) => n + Math.ceil((UI.textWidth(t) + 20) / wide), 0);
    UI.beginChild("tab", 0, -(Math.max(1, Math.min(7, lines)) * UI.textLineHeight() + 14), false);
    try {
      ({ palette: palettePanel, inspect: tilePanel, level: levelPanel, text: textPanel, game: gamePanel })[S.tab]();
    } finally {
      UI.endChild();
    }
    UI.separator();
    UI.beginChild("problems", 0, 0, false);
    if (!probs.errs.length && !probs.warns.length) UI.textColored(OK, "✓ No problems found", true);
    for (const e of probs.errs) UI.textColored(ERR, "✖ " + e, true);
    for (const w of probs.warns) UI.textColored(WARN, "⚠ " + w, true);
    UI.endChild();
  }

  // Work the panels would otherwise redo every frame, kept until the level, the game or a patch changes
  const cache = new Map();
  function cached(key, fn) {
    const tag = `${S.ver}:${S.cur}`;
    const c = cache.get(key);
    if (c && c.tag === tag && c.game === S.game) return c.v;
    const v = fn();
    cache.set(key, { tag, game: S.game, v });
    return v;
  }

  // Swatches in rows that fill the panel; each item: {id, sprite, label, title, on, onClick, onRight}
  function swatches(items, size) {
    const per = Math.max(1, Math.floor((UI.availWidth() + 6) / (size + 6)));
    items.forEach((it, i) => {
      if (i % per) UI.sameLine(0, 6);
      if (UI.swatch(it.id, need(it.sprite), it.label, it.on, size)) it.onClick();
      if (it.onRight && UI.itemClicked(1)) it.onRight();
      UI.tooltip(it.title);
    });
  }

  function palettePanel() {
    const cur = E.brushId(S.brush), ground = S.brush.ground ? "t:" + S.brush.ground : null;
    UI.heading("Terrain");
    swatches(cached("terrain", () => E.terrainPalette()).map(([ch, t]) => ({
      id: "t:" + ch, sprite: t === "hole" ? "" : "terrain." + t, label: ch, title: `${WB.TERRAIN_LABELS[t] || t}: "${ch}"`,
      on: cur === "t:" + ch || ground === "t:" + ch, onClick: () => setBrushTerrain(ch),
    })), 52);
    UI.heading("Objects");
    for (const [k, lbl] of WBEdit.CATS) {
      if (UI.toggle(lbl, S.objCat === k, false, "pill")) S.objCat = k;
      UI.sameLine(0, 4);
    }
    UI.newLine();
    const { items, note: msg } = cached("pal" + S.objCat, () => E.objectPalette(S.objCat));
    if (msg) note(msg);
    swatches(items.map((it) => ({
      id: E.brushId({ kind: "object", ...it.o }), sprite: it.sprite, label: it.label, title: it.title,
      on: cur === E.brushId({ kind: "object", ...it.o }), onClick: () => setBrushObject(it.o),
      // right-click on a plan: a pile of the bricks that model needs
      onRight: it.o.type === "plan" ? () => recipeBrush(it.o.name) : null,
    })), 64);
    brushOptions();
  }

  function brushOptions() {
    const b = S.brush;
    if (b.kind !== "object") return;
    UI.heading(E.brushTitle(b));
    if (b.type === "plan") S.planCount = field("Uses", () => UI.inputInt("##uses", S.planCount, 1, 99));
    else if (b.type === "pile") pileEditor(S.pileDraft, (rows) => (S.pileDraft = rows));
    else if (b.type === "goal") goalTargetField("brushgoal", S.goalTarget, (v) => (S.goalTarget = v));
    else if (b.type === "whirlpool") S.whirlId = String(field("Pair number", () => UI.inputInt("##pair", +S.whirlId || 1, 1, 99)));
    else if (b.type === "unit") note(E.unitTooltip(b.cls, b.name).split("\n").slice(1).join(" · ") || displayName(b.name));
    const g = E.groundName(b);
    note(g
      ? `Picked with the eyedropper: paints ${g.toLowerCase()} under it too. Click the object in the palette to place it on any ground.`
      : "Placed on water tiles, objects automatically become their water version.");
  }

  function tilePanel() {
    const lv = lvl();
    if (!S.sel || !inMap(...S.sel)) { note("Use the Select tool (S) and click a tile to inspect it and edit its object."); return; }
    const [x, y] = S.sel;
    const c = lv.grid[y][x];
    UI.heading(`Tile ${x + 1}, ${y + 1}`);
    const t = field("Terrain", () => comboOf("##terrain", c.t, Object.entries(S.game.terrain).map(([ch, tn]) => [ch, `${WB.TERRAIN_LABELS[tn] || tn}  (${ch})`])));
    if (t !== undefined) edit(() => E.setCellTerrain(lv, x, y, t));
    if (c.item < 0) { note("No object here."); return; }
    const parts = lv.items[c.item].parts.slice();
    const base = baseOf(parts);
    const set = (np) => edit(() => { c.item = E.itemIndexFor(lv, np); c.t = WB.itemIsWater(np) ? "w" : "."; });
    UI.separator();
    UI.text(S.scene.describeParts(parts));
    if (base === "unit") {
      const cls = parts[1];
      const m = field("Model", () => comboOf("##model", parts[2], [...new Set([...E.placeable(cls), parts[2]])].map((n) => [n, displayName(n)])));
      if (m !== undefined) set([parts[0], cls, m]);
      note(E.unitTooltip(cls, parts[2]).split("\n").slice(1).join(" · "));
    } else if (base === "plan") {
      const m = field("Model", () => comboOf("##model", parts[1], [...new Set([...E.planModels(), parts[1]])].map((n) => [n, displayName(n)])));
      if (m !== undefined) set([parts[0], m, parts[2]]);
      const n = field("Uses", () => UI.inputInt("##uses", +parts[2] || 1, 1, 99));
      if (n !== (+parts[2] || 1)) set([parts[0], parts[1], String(n)]);
    } else if (base === "pile") {
      const rows = [];
      for (let i = 1; i + 1 < parts.length; i += 2) rows.push([parts[i], +parts[i + 1] || 1]);
      pileEditor(rows, (r) => set([parts[0], ...r.flatMap(([a, n]) => [a, String(n)])]));
    } else if (base === "goal" || base === "bonusgoal") {
      const k = field("Kind", () => comboOf("##kind", base, [["goal", "Mission goal"], ["bonusgoal", "Bonus goal"]]));
      if (k !== undefined) set([k, ...parts.slice(1)]);
      goalTargetField("tilegoal", parts[1], (v) => set([parts[0], v, ...parts.slice(2)]));
    } else if (base === "whirlpool") {
      const n = field("Pair number", () => UI.inputInt("##pair", +parts[1] || 1, 1, 99));
      if (n !== (+parts[1] || 1)) set(["whirlpool", String(n)]);
    }
    UI.spacing();
    if (UI.button("Remove object")) edit(() => { c.item = -1; });
  }

  function levelPanel() {
    const lv = lvl(), e = L();
    const h = lv.grid.length, w = h ? lv.grid[0].length : 0;
    UI.heading(`World ${e.world} · Mission ${e.mission}  (${e.member})`);
    if (S.game.titles.size) {
      const t = field("Mission title", () => UI.inputText("##title", E.missionTitle(e)));
      if (t !== E.missionTitle(e)) later(async () => { await E.setMissionTitle(e, t); setStatus("Mission title changed (saved with the game file)."); });
    }
    const nm = field("Internal name", () => UI.inputText("##name", lv.name));
    if (nm !== lv.name) edit(() => { lv.name = nm.replace(/,/g, " "); });
    note("The mission title is what the world map shows. The internal name is the level's own name= line.");

    // Music: a "music=" line in [map], which the game reads once its mission start is fixed (on save)
    const current = E.levelMusic(lv);
    const tracks = S.game.musicTracks || [];
    const can = S.levelMusic.length > 0 && S.patchOn.music;
    UI.beginDisabled(!can);
    const entries = [["", "Random (as normal)"], ...tracks.map((t) => [t, WBEdit.trackName(t)])];
    if (current && !tracks.includes(current)) entries.push([current, current]);
    const mu = field("Music", () => comboOf("##music", current, entries));
    if (mu !== undefined) edit(() => E.setLevelMusic(lv, mu));
    UI.endDisabled();
    if (!S.levelMusic.length) note("This game file can't be set up to choose music per level.");
    else if (!S.patchOn.music) note("Turn on \"Music per level\" on the Game tab to choose this level's music.");

    const tn = E.tutorialNote(e);
    if (tn) { UI.heading("Tutorial"); note(tn); }

    UI.heading("Start view");
    const center = lv.center || [0, 0];
    UI.setNextItemWidth(90);
    const cx = UI.inputInt("##cx", center[0], 0, 999);
    UI.sameLine();
    UI.setNextItemWidth(90);
    const cy = UI.inputInt("##cy", center[1], 0, 999);
    if (cx !== center[0] || cy !== center[1]) edit(() => { lv.center = [cx, cy]; });
    UI.sameLine();
    if (UI.button("Auto")) edit(() => { lv.center = null; });
    UI.tooltip("Let the game center the map");
    UI.sameLine();
    if (UI.toggle("Pick on map", S.tool === "start", false)) {
      if (S.tool !== "start") S.prevTool = S.tool;
      setTool("start");
      setStatus("Click the map where the camera should start (Esc cancels).");
    }
    UI.tooltip("Click a tile on the map to start the camera there (Esc cancels)");

    UI.heading("Map size");
    const fillChar = S.brush.kind === "terrain" ? S.brush.char : "@";
    // the view stays put: when the top or left edge changes, it shifts so the existing tiles don't move
    const rs = (side, delta) => {
      pushUndo();
      const [dx, dy] = E.resizeMap(lv, side, delta, fillChar);
      S.shift = [S.shift[0] + dx, S.shift[1] + dy];
      S.flags |= F_SHIFT;
      changed();
    };
    const m = mockMap();
    const hit = UI.resizer(m.nums, m.strs, MOCK_COLS, MOCK_ROWS, `${w} × ${h}`);
    if (hit) rs(hit.slice(0, -1), hit.endsWith("+") ? 1 : -1);
    note("New rows and columns are filled with the selected terrain brush (or holes).");

    UI.heading("Starting plans (inventory)");
    const all = E.planModels();
    lv.inventory.forEach((inv, i) => {
      UI.pushId("inv" + i);
      UI.setNextItemWidth(Math.max(80, UI.availWidth() - 130));
      const n = comboOf("##plan", inv.name, [...new Set([...all, inv.name])].map((m) => [m, displayName(m)]));
      if (n !== undefined) edit(() => { inv.name = n; });
      UI.sameLine();
      UI.setNextItemWidth(90);
      const k = UI.inputInt("##count", inv.count, 1, 99);
      if (k !== inv.count) edit(() => { inv.count = k; });
      UI.sameLine();
      if (UI.button("×")) edit(() => { lv.inventory.splice(i, 1); });
      UI.tooltip("Remove");
      UI.popId();
    });
    if (UI.button("+ Add starting plan")) edit(() => { lv.inventory.push({ name: all[0] || "buggy", count: 10 }); });

    UI.heading("Level");
    UI.beginDisabled(!e.dirty);
    if (UI.button("Revert to saved")) {
      confirm("Throw away your changes to this level?", "Revert", () => {
        e.lv = WB.parseLevel(e.text, S.game.terrain);
        e.dirty = false;
        e.undo = []; e.redo = [];
        e.textCache = null;
        S.sel = null;
        S.textFor = null;
        S.flags |= F_SCENE;
      });
    }
    UI.endDisabled();
    UI.sameLine();
    if (UI.button("Clear map")) confirm("Replace this map with empty grass? (You can undo this.)", "Clear", () => edit(() => E.clearMap(lv)));

    UI.heading("Game");
    note("Mission unlocks, unit settings, descriptions and other text the whole game shares.");
    if (UI.button("Edit game texts…")) openTexts();
    UI.tooltip("Edit other text members (mission unlocks, descriptions…)");
  }

  /* A little made-up map drawn from the game's own tiles and objects, for the map-size control
   * Kept once all its sprites are loaded. */
  const MOCK_COLS = 6, MOCK_ROWS = 3;
  function mockMap() {
    if (S.mock && S.mock.game === S.game) return S.mock.packed;
    const rows = [
      ["normal", "tree", "normal", "normal", "water", "water"],
      ["mountain", "normal", "normal", "normal", "normal", "water"],
      ["normal", "normal", "tree", "normal", "normal", "normal"],
    ];
    const have = new Set(Object.values(S.game.terrain));
    const veh = E.placeable("vehicle")[0];
    const res = S.game.resources.includes("yellow") ? "yellow" : S.game.resources[0];
    const out = [];
    let ready = true;
    rows.forEach((row, y) => row.forEach((t, x) => {
      const name = "terrain." + (have.has(t) ? t : "normal"), sp = spriteInfo(name);
      if (!sp) { ready = false; return; }
      const [ox, oy] = WBScene.cellOrigin(x, y);
      out.push(["img", name, Math.round(ox - sp.regX), Math.round(oy - sp.regY)]);
    }));
    const objects = [veh && [["unit", "vehicle", veh], 1, 1], res && [["pile", res, "10"], 4, 2]].filter(Boolean);
    for (const [parts, x, y] of objects) {
      const cmds = S.scene.object(parts, x, y, true);
      if (S.pending.size) ready = false;
      out.push(...cmds);
    }
    const packed = pack(out);
    if (ready) S.mock = { game: S.game, packed };
    return packed;
  }

  // The level exactly as the game reads it; the editor's copy follows the level until it's edited here
  function textPanel() {
    const e = L();
    if (S.textFor !== e) { S.textFor = e; S.textBuf = E.levelText(e); }
    note("This is the level exactly as the game reads it. Edit it directly and press Apply.");
    S.textBuf = UI.textEditor("leveltext", S.textBuf, -UI.frameHeight() - 8);
    if (UI.button("Apply", 0, 0, "primary")) applyText();
    UI.sameLine();
    if (UI.button("Export .txt…")) NATIVE.fileDialog("txtExport", true, dirname(S.filePath), "txt");
    UI.sameLine();
    if (UI.button("Import .txt…")) NATIVE.fileDialog("txtImport", false, dirname(S.filePath), "txt");
  }
  function applyText() {
    const parsed = WB.parseLevel(S.textBuf, S.game.terrain);
    if (!parsed.grid.length) { alert("No map rows found (lines starting with map=)."); return; }
    pushUndo();
    Object.assign(lvl(), parsed);
    changed();
    S.flags |= F_LEVEL;
  }

  function gamePanel() {
    UI.heading("Game patches");
    note("Changes to the game itself, made when you save. Unticking one takes it back out of the game.");
    for (const p of E.patchRows()) {
      UI.spacing();
      UI.beginDisabled(!p.available);
      const v = UI.checkbox(p.label + "##" + p.id, p.on);
      UI.endDisabled();
      if (v !== p.on) { E.setPatch(p.id, v); S.flags |= F_SCENE; }
      if (p.desc) { UI.indent(28); note(p.desc); UI.unindent(28); }
    }
  }

  // ---------------------------------------------------------------- modal dialogs

  function openTexts() {
    const names = E.otherTexts();
    S.modal = { kind: "texts", names, sel: -1, buf: "", src: null };
    selectText(0);
  }
  function selectText(i) {
    const m = S.modal;
    m.sel = i;
    later(async () => { m.buf = await E.textOf(m.names[i]); m.src = m.names[i]; });
  }

  function drawModals() {
    const m = S.modal;
    if (!m) return;
    const titles = { alert: "WorldBuilder Level Editor", confirm: "Are you sure?", save: "Save", texts: "Game text members" };
    const title = titles[m.kind] + "###modal";
    if (!m.opened) { UI.openPopup(title); m.opened = true; }
    const big = m.kind === "texts";
    if (!UI.beginModal(title, big ? 760 : 460, big ? 560 : 0)) { if (S.modal === m) S.modal = null; return; }
    const close = () => { UI.closePopup(); if (S.modal === m) S.modal = null; };
    if (m.kind === "alert") {
      UI.textWrapped(m.text);
      UI.spacing();
      if (UI.button("OK", 120, 0, "primary") || UI.keyPressed("enter")) close();
    } else if (m.kind === "confirm") {
      UI.textWrapped(m.text);
      UI.spacing();
      if (UI.button(m.yes, 120, 0, "primary")) { close(); m.onYes(); }
      UI.sameLine();
      if (UI.button("Cancel", 120) || UI.keyPressed("escape")) close();
    } else if (m.kind === "save") {
      const dirty = S.levels.filter((l) => l.dirty);
      if (S.imported) UI.textWrapped(`Imported from ${S.imported}.`);
      UI.textWrapped(dirty.length || S.textEdits.size
        ? `Changed: ${dirty.length} level${dirty.length === 1 ? "" : "s"}${S.textEdits.size ? ` and ${S.textEdits.size} text member${S.textEdits.size === 1 ? "" : "s"}` : ""}.`
        : "No levels or texts have changed.");
      const { add, remove } = E.patchSummary();
      if (add.length || remove.length) UI.textWrapped([add.length ? `Adds: ${add.join(", ")}. ` : "", remove.length ? `Removes: ${remove.join(", ")}.` : ""].join(""));
      if (m.issues.length) {
        UI.textColored(ERR, "These levels would break in the game:", true);
        for (const t of m.issues) note(t);
      }
      UI.textWrapped(`Save over ${S.fileName} in the game folder to play your levels. Export .dcr writes just the movie (${E.dcrName()}, the browser version) without saving ${S.fileName}.`);
      note("Progress (unlocked missions) is kept in the game's Prefs folder and isn't affected.");
      UI.spacing();
      UI.beginDisabled(m.issues.length > 0);
      if (UI.button(`Save ${S.fileName}`, 0, 0, "accent")) { close(); later(() => save("exe", S.filePath)); }
      UI.tooltip(`Write over ${S.filePath} (the first save keeps the original as ${S.fileName}.orig)`);
      UI.flow(UI.width("Save as…", "button"));
      if (UI.button("Save as…")) { close(); NATIVE.fileDialog("saveExe", true, dirname(S.filePath), "exe"); }
      const ex = `Export ${E.dcrName()}…`;
      UI.flow(UI.width(ex, "button"));
      if (UI.button(ex)) { close(); NATIVE.fileDialog("saveDcr", true, dirname(S.filePath), "dcr"); }
      UI.endDisabled();
      UI.flow(UI.width("Cancel", "button"));
      if (UI.button("Cancel") || UI.keyPressed("escape")) close();
    } else if (m.kind === "texts") {
      note("Other data the game stores as text: mission unlocks (worlds), unit settings (config), descriptions and labels. Changes are saved with the game file.");
      UI.beginChild("names", 200, -UI.frameHeight() - 8, true);
      m.names.forEach((n, i) => {
        if (UI.selectable((S.textEdits.has(n) ? "● " : "") + n + "##" + n, i === m.sel)) selectText(i);
      });
      UI.endChild();
      UI.sameLine();
      UI.beginChild("edit", 0, -UI.frameHeight() - 8, false);
      if (m.src != null) m.buf = UI.textEditor("member:" + m.src, m.buf, -1);
      UI.endChild();
      const name = m.names[m.sel];
      UI.textColored(MUTED, name === "worlds" ? "Columns: world, mission, missions it unlocks (tab separated)." : "", false);
      UI.sameLine(UI.availWidth() + UI.cursorX() - 230);
      UI.beginDisabled(m.src !== name);
      if (UI.button("Apply change")) {
        S.textEdits.set(name, m.buf);
        setStatus(`Changed text "${name}" (saved with the game file).`);
      }
      UI.endDisabled();
      UI.sameLine();
      if (UI.button("Close") || UI.keyPressed("escape")) close();
    }
    UI.endPopup();
  }

  root.NE = {
    onDialog, openPath, poll, layout, setSideWidth, statusLine, scene, overlay, hasPending, loadPending,
    size, label, cellAt, fit, startView, mouseDown, mouseMove, mouseUp, key, cursor,
    drawLevels, drawToolbar, drawSide, drawModals, runJobs, hasJobs, unsaved, askQuit,
    hasLevel: () => !!lvl(),
    title: () => (S.movie ? `${E.unsaved() ? "● " : ""}${S.fileName} · WorldBuilder Level Editor` : `WorldBuilder Level Editor ${NATIVE.version()}`),
  };
})(typeof self !== "undefined" ? self : this);
