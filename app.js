/* WorldBuilder Level Editor UI. Depends on wbcore.js (global WB). */
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  };

  // Projection used by the game (map_display.posToLoc): 50px cells, each row shifted 25px left.
  const CELL = 50, SKEW = 25;
  // Where the game draws things relative to a tile's position, measured from the real game
  const OBJ_DX = 10, OBJ_DY = 16; // vehicles and monsters (buildings have no offset)
  // resource.generic: up to 4 brick sprites, biggest amount first; 8px lower on water
  const PILE_SPOTS = [[22, 7], [17, 18], [12, 28], [6, 39]];
  const PILE_WATER_DY = 8;
  const VIEW_W = 12, VIEW_H = 9; // tiles visible in the game window

  // Editor preferences, kept between visits (wbe.* in localStorage)
  const prefs = {
    get(k) { try { return localStorage.getItem("wbe." + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("wbe." + k, String(v)); } catch (e) { /* storage unavailable */ } },
  };

  const S = {
    movie: null, game: null, fileName: "", filePath: null,
    levels: [], cur: -1,
    tool: "paint",
    brush: { kind: "terrain", char: "." },
    objCat: "model",
    pileDraft: [["yellow", 10], ["energy", 1]],
    planCount: 10, goalTarget: "anything", whirlId: "1",
    view: { x: 0, y: 0, zoom: 1 },
    hover: null, sel: null, drag: null,
    sprites: new Map(),
    showGrid: prefs.get("showGrid") !== "0", showView: prefs.get("showView") !== "0",
    zoom: parseFloat(prefs.get("zoom")) || null, // map zoom chosen by the user; null fits the map to the window
    textMember: null,
    clip: null, pasting: false, // tiles copied with the Select tool, and whether clicks place them
  };

  const canvas = $("#map");
  let panning = null; // active pan drag
  let spaceDown = false; // Space held: left-drag pans
  const ctx = canvas.getContext("2d");

  // ------------------------------------------------------------------ loading

  // file: a browser File, or { name, path, data } from the desktop app
  const readFile = async (file) => file.data || new Uint8Array(await file.arrayBuffer());

  // The editor always edits a Launcher.exe; a .dcr only comes in through Import .dcr…
  async function openFile(file) {
    if (/\.dcr$/i.test(file.name)) {
      if (S.movie) { if (confirmDiscard()) importDcr(file); }
      else alert("Open the game's Launcher.exe first, then use Import .dcr… to bring this movie into it.");
      return;
    }
    setStatus(`Reading ${file.name}…`);
    try {
      const movie = await WB.openMovie(await readFile(file));
      if (!movie.wrapper) throw new Error("That isn't a game launcher. Open Launcher.exe from a World Builder game folder.");
      const game = await movie.loadGame();
      if (!game.levels.length) throw new Error("This movie has no WorldBuilder levels in it.");
      await loadMovie(movie, game, file);
      setStatus(`Opened ${file.name}.`);
    } catch (e) {
      console.error(e);
      setStatus("Couldn't open that file: " + e.message);
      alert("Couldn't open that file.\n\n" + e.message);
    }
  }

  // Put a .dcr's movie inside the open Launcher.exe; it reaches the file on the next save
  async function importDcr(file) {
    setStatus(`Reading ${file.name}…`);
    try {
      const movie = await WB.openMovie(await readFile(file));
      if (movie.wrapper) throw new Error("That's a program, not a .dcr movie.");
      const game = await movie.loadGame();
      if (!game.levels.length) throw new Error("This movie has no WorldBuilder levels in it.");
      if (game.edition !== S.game.edition &&
          !confirm(`${file.name} is World Builder${game.edition === 2 ? " 2" : ""}, but ${S.fileName} is World Builder${S.game.edition === 2 ? " 2" : ""}. Import it anyway?`)) {
        setStatus("Import cancelled.");
        return;
      }
      movie.wrapper = S.movie.wrapper;
      await loadMovie(movie, game, { name: S.fileName, path: S.filePath });
      S.imported = file.name;
      setStatus(`Imported ${file.name}. Save to write it into ${S.fileName}.`);
    } catch (e) {
      console.error(e);
      setStatus("Couldn't import that file: " + e.message);
      alert("Couldn't import that file.\n\n" + e.message);
    }
  }

  async function loadMovie(movie, game, file) {
    S.movie = movie;
    S.game = game;
    S.fileName = file.name;
    S.filePath = file.path || null;
    document.title = `${file.name} · WorldBuilder Level Editor`;
    S.sprites.clear();
    S.mockMap = null;
    S.levels = game.levels.map((l) => ({ ...l, lv: null, dirty: false, undo: [], redo: [] }));
    S.textEdits = new Map();
    S.imported = null;
    S.tutorialHook = await movie.findTutorialHook();
    S.keyHandlers = await movie.findKeyHandlers();
    S.planSwoops = await movie.findPlanSwoop();
    // units and plans can only start on deep water when the level loader can be (or is) fixed
    S.deepWater = await movie.findDeepWater();
    // levels can pick their music once mission start is fixed to read it
    S.levelMusic = await movie.findLevelMusic();
    // reaching a goal saves progress mid-game and freezes it; the fix saves when the mission ends
    S.goalSave = await movie.findGoalSave();
    // a unit taken apart on a whirlpool after teleporting leaves the pair blocked for good
    S.whirlpoolFix = await movie.findWhirlpoolFix();
    // a monster built from a plan comes out selected, so it can be driven like a vehicle
    S.builtMonsterSelect = await movie.findBuiltMonsterSelect();
    S.unlockAll = await movie.findUnlockAll();
    // goals draw a shadow named after their terrain; deep water has none until the patch adds it
    S.goalShadow = await movie.findGoalShadow();
    S.goalShadowsBase = new Set(game.goalShadows);
    // monsters get plans once the game has their plans-bar icons; the editor shows them from the start
    S.monsterPlans = await movie.findMonsterPlans();
    S.monsterHealth = await movie.findMonsterHealth();
    S.planIconsBase = new Set(game.planIcons);
    S.monsterPlanIcons = new Map();
    for (const h of S.monsterPlans) for (const t of h.targets) {
      S.monsterPlanIcons.set(t.member, t.name);
      if (!movie.byName.has(t.member)) {
        const p = createImageBitmap(new ImageData(new Uint8ClampedArray(t.icon.rgba), t.icon.w, t.icon.h))
          .then((img) => ({ img, w: t.icon.w, h: t.icon.h, regX: t.icon.regX, regY: t.icon.regY }));
        S.sprites.set(t.member, p);
        p.then((r) => S.sprites.set(t.member, r));
      }
    }
    initPatches();
    syncGoalShadows();
    $("#gameLabel").textContent = `World Builder${game.edition === 2 ? " 2" : ""} · ${file.name} · ${game.levels.length} levels`;
    $("#welcome").hidden = true;
    $("#toolbar").hidden = false;
    $("#side").hidden = false;
    $("#levelTools").hidden = false;
    $("#btnSaveMini").hidden = false;
    $("#zoomBar").hidden = false;
    await preloadSprites();
    buildTerrainPalette();
    buildObjectCats();
    buildLevelList();
    // reopen the level last edited in this game, else world 1 mission 1
    const last = S.levels.findIndex((l) => l.member === prefs.get("level" + game.edition));
    const first = S.levels.findIndex((l) => l.world === 1 && l.mission === 1);
    selectLevel(last >= 0 ? last : first >= 0 ? first : 0);
  }

  async function sprite(name) {
    if (S.sprites.has(name)) return S.sprites.get(name);
    const p = (async () => {
      const bm = await S.movie.bitmap(name);
      if (!bm) return null;
      const img = await createImageBitmap(new ImageData(bm.rgba, bm.w, bm.h));
      return { img, w: bm.w, h: bm.h, regX: bm.regX, regY: bm.regY };
    })();
    S.sprites.set(name, p);
    const r = await p;
    S.sprites.set(name, r);
    return r;
  }
  // synchronous lookup for drawing; kicks off loading and redraws when ready
  function spriteNow(name) {
    const v = S.sprites.get(name);
    if (v === undefined) { sprite(name).then(() => draw()); return null; }
    return v instanceof Promise ? null : v;
  }

  /* Matte ink: only the white around the outside of a bitmap is see-through, white inside its
   * outline stays white (the plain decode makes all pure white transparent) */
  function matteNow(name) {
    const key = name + "#matte";
    const v = S.sprites.get(key);
    if (v !== undefined) return v instanceof Promise ? null : v;
    const p = (async () => {
      const bm = await S.movie.bitmap(name);
      if (!bm) return null;
      const { w, h, rgba } = bm;
      const outside = new Uint8Array(w * h);
      const stack = [];
      for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
      for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
      while (stack.length) {
        const i = stack.pop();
        if (outside[i] || rgba[i * 4 + 3]) continue;
        outside[i] = 1;
        const x = i % w;
        if (x > 0) stack.push(i - 1);
        if (x < w - 1) stack.push(i + 1);
        if (i >= w) stack.push(i - w);
        if (i < w * (h - 1)) stack.push(i + w);
      }
      for (let i = 0; i < w * h; i++) if (!outside[i] && !rgba[i * 4 + 3]) rgba[i * 4 + 3] = 255;
      const img = await createImageBitmap(new ImageData(rgba, w, h));
      return { img, w, h, regX: bm.regX, regY: bm.regY };
    })();
    S.sprites.set(key, p);
    p.then((r) => { S.sprites.set(key, r); draw(); });
    return null;
  }

  async function preloadSprites() {
    const names = Object.values(S.game.terrain).map((t) => "terrain." + t);
    names.push("terrain.water_whirlpool", "goal.goal", "goal.bonus", "goal.shadow.normal", "goal.shadow.water", "plan.generic");
    for (const r of S.game.resources) names.push(`resource.${r}`, `resource.${r}.1`, `resource.${r}.2`, `resource.${r}.3`, `resource.${r}.4`);
    await Promise.all(names.map((n) => sprite(n)));
    matteNow("goal_bubble");
  }

  function hasSprite(name) { return S.movie.byName.has(name) && S.movie.byName.get(name).type === 1; }

  // Which bitmap represents a unit, plan or pile on the map
  // models shown facing right in the editor (everything else faces down, or right if it has no down)
  const FACE_RIGHT = new Set(["duck", "forklift", "freighter", "snail", "steamshovel", "tugboat", "guard_tower"]);
  function unitSpriteName(cls, name, water) {
    const n = name === "repairbot" ? "repairBot" : name;
    const c = [];
    if (FACE_RIGHT.has(name)) {
      if (water) c.push(`${cls}.${n}.water.right`);
      c.push(`${cls}.${n}.right`);
    }
    if (water) c.push(`${cls}.${n}.water.down`, `${cls}.${n}.water.right`, `${cls}.${n}.water.left`);
    c.push(`${cls}.${n}.down`, `${cls}.${n}.down.stand`, `${cls}.${n}`, `${cls}.${n}.1`, `${cls}.${n}.right`,
      `${cls}.${n}.left`, `${cls}.${n}.down.walk.1`, `${cls}.${n}.right.walk.1`, `${cls}.${n}.frozen`, `${cls}.${n}.plan`);
    if (name === "defender2" || name === "defender3") c.push(...unitSpriteCandidates(cls, "defender"));
    return c.find(hasSprite) || null;
  }
  function unitSpriteCandidates(cls, n) { return [`${cls}.${n}.down`, `${cls}.${n}`]; }

  function planSpriteName(name) {
    const n = name === "repairbot" ? "repairBot" : name;
    // a monster's icon counts while the Monster plans patch is ticked (it's added to the game on save)
    const icon = (s) => (S.monsterPlanIcons && S.monsterPlanIcons.has(s) ? S.patchOn && S.patchOn.monsterPlans : hasSprite(s));
    return [`vehicle.${n}.plan`, `building.${n}.plan`, `monster.${n}.plan`].find(icon) || null;
  }
  // Models a plan can be for: vehicles, buildings and (with their icons) monsters, never the boulder
  function planModels() {
    return [...placeable("vehicle"), ...placeable("building"), ...placeable("monster").filter((n) => n !== "boulder")].filter(planSpriteName);
  }

  function pileSpriteName(res, amount) {
    if (res === "energy" || res === "wheel") return `resource.${res}`;
    // pPileSetup.countversions: 1 -> .1, 2+ -> .2, 6+ -> .3, 13+ -> .4
    const step = amount >= 13 ? 4 : amount >= 6 ? 3 : amount >= 2 ? 2 : 1;
    return [`resource.${res}.${step}`, `resource.${res}.1`, `resource.${res}`].find(hasSprite) || null;
  }

  function placeable(cls) { return (S.game.units[cls] || []).filter((n) => S.game.placeable[cls].has(n)); }

  function unitClassOf(name) {
    for (const cls of ["vehicle", "building", "monster"]) if ((S.game.units[cls] || []).includes(name)) return cls;
    return "vehicle";
  }
  function displayName(name) {
    for (const cls of ["vehicle", "building", "monster"]) {
      const c = S.game.config[cls] && S.game.config[cls][name];
      if (c && c.name) return c.name;
    }
    return name.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

  // ------------------------------------------------------------------ level state

  const L = () => S.levels[S.cur];
  const lvl = () => L() && L().lv;

  function ensureParsed(entry) {
    if (!entry.lv) entry.lv = WB.parseLevel(entry.text, S.game.terrain);
    return entry.lv;
  }

  function snapshot() {
    const lv = lvl();
    return JSON.stringify({ name: lv.name, center: lv.center, items: lv.items, inventory: lv.inventory, mapExtra: lv.mapExtra, other: lv.other, grid: lv.grid });
  }
  function restore(snap) {
    const o = JSON.parse(snap);
    Object.assign(lvl(), o);
  }
  function pushUndo() {
    const e = L();
    e.undo.push(snapshot());
    if (e.undo.length > 200) e.undo.shift();
    e.redo = [];
  }
  function refreshHover() {
    $("#hoverText").textContent = S.hover && inMap(...S.hover) ? cellLabel(...S.hover) : "";
  }

  function changed() {
    refreshHover();
    const e = L();
    e.dirty = true;
    e.textCache = null;
    refreshLevelList();
    refreshPanels();
    draw();
  }
  function undo() {
    const e = L();
    if (!e || !e.undo.length) return;
    e.redo.push(snapshot());
    restore(e.undo.pop());
    changed();
  }
  function redo() {
    const e = L();
    if (!e || !e.redo.length) return;
    e.undo.push(snapshot());
    restore(e.redo.pop());
    changed();
  }

  function selectLevel(i) {
    S.cur = i;
    prefs.set("level" + S.game.edition, L().member);
    ensureParsed(L());
    S.sel = null;
    buildLevelList();
    refreshPanels();
    fitView();
  }

  // item helpers
  function partsKey(p) { return p.join(","); }
  function itemIndexFor(parts) {
    const lv = lvl();
    const k = partsKey(parts);
    let i = lv.items.findIndex((it) => partsKey(it.parts) === k);
    if (i < 0) { lv.items.push({ key: "", parts: parts.slice() }); i = lv.items.length - 1; }
    return i;
  }
  function withWater(parts, water) {
    const p = parts.slice();
    const base = p[0].replace(/^water/, "");
    if (base === "unit" || base === "plan") p.length = 3; // drops a deep-water terrain
    if (["unit", "plan", "pile"].includes(base)) p[0] = (water ? "water" : "") + base;
    else if (base === "goal" || base === "bonusgoal") {
      p.length = Math.min(p.length, 2);
      if (water) p.push("water");
    }
    return p;
  }
  function isWaterChar(c) { return WB.isWaterTerrain(S.game.terrain[c]); }
  function terrainChar(name) { return Object.keys(S.game.terrain).find((k) => S.game.terrain[k] === name); }
  // the terrain character under an object
  function groundChar(parts) { return terrainChar(WB.itemTerrain(parts)) ?? (WB.itemIsWater(parts) ? "w" : "."); }

  /* The version of an object that can stand on terrain ch, or null if the game doesn't allow it:
   * goals store any terrain but holes, units, plans and piles have a land and a water version
   * (units only where they can go; swimmers that can use deep water, and plans, can also have
   * deep water as a fourth field, which the readmap fix makes the game read), whirlpools need
   * plain water. */
  const canStartDeep = (kind) => S.patchOn.deep && S.deepWater.some((h) => kind in h.kinds);
  function partsOn(p, ch) {
    const t = S.game.terrain[ch];
    const base = p[0].replace(/^water/, "");
    if (base === "goal" || base === "bonusgoal") return t === "hole" ? null : t === "normal" || !t ? p.slice(0, 2) : [...p.slice(0, 2), t];
    if (base === "whirlpool") return t === "water" ? p : null;
    if (base === "unit") {
      if (t === "normal") return WB.unitCanUse(S.game, p[1], p[2], false) ? ["unit", p[1], p[2]] : null;
      if (t === "water") return WB.unitCanUse(S.game, p[1], p[2], true) ? ["waterunit", p[1], p[2]] : null;
      const deep = WB.isWaterTerrain(t) && canStartDeep("waterunit") && WB.unitTerrains(S.game, p[1], p[2]).includes(t);
      return deep ? ["waterunit", p[1], p[2], t] : null;
    }
    if (base === "plan" && t === "water_undiggable" && canStartDeep("waterplan")) return ["waterplan", p[1], p[2], t];
    if (t === "normal" || t === "water") return withWater(p, t === "water");
    return null;
  }

  // What the brush would put down on a given cell
  function brushParts(waterCell) {
    const b = S.brush;
    if (b.kind !== "object") return null;
    switch (b.type) {
      case "unit": return withWater(["unit", b.cls, b.name], waterCell);
      case "plan": return withWater(["plan", b.name, String(S.planCount)], waterCell);
      case "pile": return withWater(["pile", ...S.pileDraft.flatMap(([r, n]) => [r, String(n)])], waterCell);
      case "goal": return withWater([b.goal, S.goalTarget], waterCell);
      case "whirlpool": return ["whirlpool", String(S.whirlId)];
    }
    return null;
  }

  // Terrain paints under objects too (see setCellTerrain); an object brush leaves existing
  // objects alone: click one to select it, Alt/Ctrl+click to replace it, right-click to delete it
  function applyBrush(x, y) {
    if (S.brush.kind === "terrain") return setCellTerrain(x, y, S.brush.char);
    const lv = lvl();
    const c = lv.grid[y] && lv.grid[y][x];
    if (!c || c.item >= 0) return false;
    const before = c.t + ":" + c.item;
    if (S.brush.kind === "object") {
      // An eyedropped object keeps the ground it was picked from; otherwise it follows the tile,
      // and where it can't stand there the tile becomes grass or water under it
      const ch = S.brush.ground || c.t;
      const raw = brushParts(isWaterChar(ch));
      const parts = partsOn(raw, ch) || raw;
      c.item = itemIndexFor(parts);
      c.t = groundChar(parts);
    }
    return before !== c.t + ":" + c.item;
  }

  /* Set the ground of one tile (terrain brush, Tile tab), keeping its object where the game allows
   * (see partsOn) and removing it otherwise. Returns whether the tile changed. */
  function setCellTerrain(x, y, ch) {
    const lv = lvl();
    const c = lv.grid[y] && lv.grid[y][x];
    if (!c) return false;
    const before = c.t + ":" + c.item;
    const t = S.game.terrain[ch];
    if (c.item >= 0) {
      const p = lv.items[c.item].parts;
      const keep = partsOn(p, ch);
      if (keep) c.item = itemIndexFor(keep);
      else {
        c.item = -1;
        setStatus(`Removed ${describeParts(p)}: it can't be on ${(WB.TERRAIN_LABELS[t] || t || ch).toLowerCase()}.`);
      }
    }
    c.t = ch;
    // the billboard's artwork spills over the tile to its left; a hole there (as in the game's
    // own levels) keeps units from driving through it
    let left = false;
    if (t === "billboard" && x > 0 && terrainChar("hole") && lv.grid[y][x - 1].t !== terrainChar("hole")) {
      left = setCellTerrain(x - 1, y, terrainChar("hole"));
    }
    return left || before !== c.t + ":" + c.item;
  }

  // A brush/erase stroke keeps the operation it started with for the whole drag
  function startStroke(op, x, y) {
    pushUndo();
    S.drag = { op, changed: op(x, y) };
    refreshHover();
    draw();
  }


  // Moving an object: it takes the land or water version that suits its new tile;
  // an object already on that tile swaps places with it.
  function fitParts(parts, cell) {
    return partsOn(parts, cell.t);
  }
  function movedParts(from, to) {
    const lv = lvl();
    const a = lv.grid[from[1]][from[0]], b = lv.grid[to[1]][to[0]];
    return [fitParts(lv.items[a.item].parts, b), b.item >= 0 ? fitParts(lv.items[b.item].parts, a) : null];
  }
  function canMove(from, to) {
    if (!inMap(...to) || String(from) === String(to)) return false;
    const lv = lvl();
    const a = lv.grid[from[1]][from[0]], b = lv.grid[to[1]][to[0]];
    const [pa, pb] = movedParts(from, to);
    return !!pa && (b.item < 0 || !!pb);
  }
  function moveObject(from, to) {
    const lv = lvl();
    const a = lv.grid[from[1]][from[0]], b = lv.grid[to[1]][to[0]];
    const [pa, pb] = movedParts(from, to);
    const put = (cell, parts) => { cell.item = itemIndexFor(parts); cell.t = groundChar(parts); };
    put(b, pa);
    if (pb) put(a, pb); else a.item = -1;
  }

  // Swap the object on a tile for the brush (Alt/Ctrl+click, Fill): a terrain brush clears the object
  function replaceAt(x, y) {
    const lv = lvl();
    const c = lv.grid[y] && lv.grid[y][x];
    if (!c || c.item < 0) return false;
    if (S.brush.kind === "terrain") { c.item = -1; c.t = S.brush.char; return true; }
    const ch = S.brush.ground || groundChar(lv.items[c.item].parts);
    const raw = brushParts(isWaterChar(ch));
    const parts = partsOn(raw, ch) || raw;
    const before = c.item;
    c.item = itemIndexFor(parts);
    c.t = groundChar(parts);
    return before !== c.item;
  }

  function eraseAt(x, y) {
    const c = lvl().grid[y] && lvl().grid[y][x];
    if (!c || c.item < 0) return false;
    c.item = -1;
    return true;
  }

  function floodFill(x, y) {
    const lv = lvl();
    const start = lv.grid[y][x];
    // On an object: replace every connected copy of that object with the brush
    // (land and water versions count as the same)
    const sameObject = (c) => partsKey(withWater(lv.items[c.item].parts, false));
    const target = start.item >= 0 ? sameObject(start) : null;
    // Remember the terrain/object up front: painting the first tile changes the start cell
    const t = start.t;
    const match = target != null ? (c) => c && c.item >= 0 && sameObject(c) === target : (c) => c && c.item < 0 && c.t === t;
    const seen = new Set();
    const region = [];
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const k = cx + "," + cy;
      if (seen.has(k)) continue;
      seen.add(k);
      if (!match(lv.grid[cy] && lv.grid[cy][cx])) continue;
      region.push([cx, cy]);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    for (const [cx, cy] of region) target != null ? replaceAt(cx, cy) : applyBrush(cx, cy);
  }

  // Select tool: copy a rectangle of tiles with their objects, then place copies of it with clicks
  // (the hovered tile takes the copy's top-left corner; anything already there is replaced)
  function copyArea(x0, y0, x1, y1) {
    const lv = lvl();
    [x0, x1] = [Math.max(0, Math.min(x0, x1)), Math.min(lv.grid[0].length - 1, Math.max(x0, x1))];
    [y0, y1] = [Math.max(0, Math.min(y0, y1)), Math.min(lv.grid.length - 1, Math.max(y0, y1))];
    const cells = [];
    for (let y = y0; y <= y1; y++) {
      cells.push(lv.grid[y].slice(x0, x1 + 1).map((c) => ({ t: c.t, parts: c.item >= 0 ? lv.items[c.item].parts.slice() : null })));
    }
    S.clip = { w: x1 - x0 + 1, h: y1 - y0 + 1, cells };
    startPasting();
  }
  function startPasting() {
    S.pasting = true;
    if (S.sel) { S.sel = null; refreshPanels(); }
    setStatus(`Copied ${S.clip.w}×${S.clip.h} tiles. Click the map to place a copy (its top-left corner goes on the tile under the mouse); Esc stops.`);
    updateCursor();
    draw();
  }
  function stopPasting() {
    S.pasting = false;
    setStatus("");
    updateCursor();
    draw();
  }
  function pasteAt(x, y) {
    const lv = lvl();
    let any = false;
    S.clip.cells.forEach((row, j) => row.forEach((src, i) => {
      if (!inMap(x + i, y + j)) return;
      const c = lv.grid[y + j][x + i], before = c.t + ":" + c.item;
      c.t = src.t;
      c.item = src.parts ? itemIndexFor(src.parts) : -1;
      if (before !== c.t + ":" + c.item) any = true;
    }));
    return any;
  }

  // Brush becomes a brick pile holding the recipe of the plan's model (Shift+click on the map)
  function pickRecipe(x, y) {
    const lv = lvl();
    recipeBrush(lv.items[lv.grid[y][x].item].parts[1]);
  }
  function recipeBrush(name) {
    const cfg = S.game.config[unitClassOf(name)] && S.game.config[unitClassOf(name)][name];
    const rows = Object.entries((cfg && cfg.recipe) || {}).filter(([res, n]) => S.game.resources.includes(res) && +n > 0);
    if (!rows.length) { setStatus(`The game doesn't list a recipe for ${displayName(name)}.`); return; }
    S.pileDraft = rows.map(([res, n]) => [res, +n]);
    setBrushObject({ type: "pile" });
    showTab("palette");
    setStatus(`Brush: brick pile for ${displayName(name)} (${rows.map(([res, n]) => `${n} ${res}`).join(", ")}).`);
  }

  function pickAt(x, y) {
    const lv = lvl();
    const c = lv.grid[y][x];
    if (c.item < 0) { setBrushTerrain(c.t); return; }
    const p = lv.items[c.item].parts;
    const base = p[0].replace(/^water/, "");
    // Pick up the ground under the object too (always grass or water), so both get placed
    const ground = groundChar(p);
    if (base === "unit") setBrushObject({ type: "unit", cls: p[1], name: p[2], ground });
    else if (base === "plan") { S.planCount = +p[2] || 1; setBrushObject({ type: "plan", name: p[1], ground }); }
    else if (base === "pile") {
      const d = [];
      for (let i = 1; i + 1 < p.length; i += 2) d.push([p[i], +p[i + 1] || 1]);
      S.pileDraft = d;
      setBrushObject({ type: "pile", ground });
    } else if (base === "goal" || base === "bonusgoal") { S.goalTarget = p[1]; setBrushObject({ type: "goal", goal: base, ground }); }
    else if (base === "whirlpool") { S.whirlId = p[1]; setBrushObject({ type: "whirlpool" }); }
    setTool("paint");
  }

  // ------------------------------------------------------------------ rendering

  function cellOrigin(x, y) { return [x * CELL - y * SKEW, y * CELL]; }
  function screenToCell(sx, sy) {
    const v = S.view;
    const wx = (sx - v.x) / v.zoom, wy = (sy - v.y) / v.zoom;
    const y = Math.floor(wy / CELL);
    const ly = wy - y * CELL;
    const x = Math.floor((wx + y * SKEW + ly / 2) / CELL);
    return [x, y];
  }
  function inMap(x, y) { const lv = lvl(); return lv && y >= 0 && y < lv.grid.length && x >= 0 && x < lv.grid[0].length; }

  function resizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    draw();
  }

  function fitView() {
    const lv = lvl();
    if (!lv) return;
    const r = canvas.getBoundingClientRect();
    const h = lv.grid.length, w = h ? lv.grid[0].length : 0;
    const mapW = w * CELL + h * SKEW + 40, mapH = h * CELL + 60;
    const z = S.zoom || Math.max(0.2, Math.min(2, Math.min(r.width / mapW, r.height / mapH)));
    S.view.zoom = z;
    $("#zoomLabel").textContent = Math.round(z * 100) + "%";
    S.view.x = (r.width - (w * CELL - h * SKEW) * z) / 2;
    S.view.y = (r.height - h * CELL * z) / 2 - 10 * z;
    draw();
  }

  function facePath(c, x, y, inset = 0) {
    const [ox, oy] = cellOrigin(x, y);
    c.beginPath();
    c.moveTo(ox + 1 + inset, oy + inset);
    c.lineTo(ox + 51 - inset, oy + inset);
    c.lineTo(ox + 26 - inset, oy + 50 - inset);
    c.lineTo(ox - 24 + inset, oy + 50 - inset);
    c.closePath();
  }

  function drawSprite(c, name, x, y) {
    const s = name && spriteNow(name);
    if (!s) return false;
    c.drawImage(s.img, Math.round(x - s.regX), Math.round(y - s.regY));
    return true;
  }

  // Centered on (x, y) and shrunk to fit, ignoring the registration point
  // (plans-menu pictures are registered for the plans panel, not the map)
  function drawFitted(c, name, x, y, maxW, maxH, maxScale = 1) {
    const s = name && spriteNow(name);
    if (!s) return false;
    const k = Math.min(maxScale, maxW / s.w, maxH / s.h);
    c.drawImage(s.img, Math.round(x - (s.w * k) / 2), Math.round(y - (s.h * k) / 2), s.w * k, s.h * k);
    return true;
  }

  function goalObjective(target) {
    if (!target || target === "anything") return "Anything";
    const m = /^collect\s+(\d+)\s+(\w+)$/.exec(target);
    if (m) return `Collect ${m[1]} ${displayName(m[2])}`;
    return displayName(target);
  }

  function drawPlanCount(c, p, x, y) {
    const [ox, oy] = cellOrigin(x, y);
    badge(c, "×" + (p[2] || 1), ox - 4, oy + 40, "#fff", "#111", "#111");
  }

  function badge(c, text, x, y, bg = "#111c", fg = "#fff", outline = null) {
    c.font = "600 11px Fredoka, system-ui, sans-serif";
    const w = c.measureText(text).width + 8;
    c.fillStyle = bg;
    c.beginPath();
    c.roundRect(x - w / 2, y - 8, w, 16, 8);
    c.fill();
    if (outline) { c.strokeStyle = outline; c.lineWidth = 1; c.stroke(); }
    c.fillStyle = fg;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, x, y + 0.5);
  }

  function terrainSpriteForCell(lv, c) {
    return terrainSprite(c.t, c.item >= 0 ? lv.items[c.item].parts : null);
  }
  function terrainSprite(ch, p) {
    if (p) return p[0] === "whirlpool" ? "terrain.water_whirlpool" : "terrain." + WB.itemTerrain(p);
    const t = S.game.terrain[ch];
    return t ? "terrain." + t : "terrain.normal";
  }

  // Faint copy of the copied tiles under the cursor, where a click would place them
  function drawPasteGhost() {
    if (!S.pasting || !S.clip || S.tool !== "select" || !S.hover || !inMap(...S.hover) || panning || spaceDown || S.drag) return;
    const [hx, hy] = S.hover, { w, h, cells } = S.clip;
    ctx.globalAlpha = 0.75;
    cells.forEach((row, j) => row.forEach((src, i) => {
      const name = terrainSprite(src.t, src.parts);
      if (name !== "terrain.hole") drawSprite(ctx, name, ...cellOrigin(hx + i, hy + j));
    }));
    cells.forEach((row, j) => row.forEach((src, i) => { if (src.parts) drawObject(ctx, src.parts, hx + i, hy + j); }));
    ctx.globalAlpha = 1;
    const p = (x, y) => [x * CELL - y * SKEW + 1, y * CELL];
    ctx.beginPath();
    ctx.moveTo(...p(hx, hy)); ctx.lineTo(...p(hx + w, hy)); ctx.lineTo(...p(hx + w, hy + h)); ctx.lineTo(...p(hx, hy + h)); ctx.closePath();
    ctx.setLineDash([8, 5]);
    ctx.strokeStyle = "#2a7de1";
    ctx.lineWidth = 2 / S.view.zoom;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // withCount false leaves out a plan's ×N badge, so the map can draw them all on top afterwards
  function drawObject(c, p, x, y, withCount = true) {
    const [ox, oy] = cellOrigin(x, y);
    const cx = ox + OBJ_DX, cy = oy + OBJ_DY;
    const base = p[0].replace(/^water/, "");
    const water = WB.itemIsWater(p);
    if (base === "unit") {
      // The game offsets only vehicles and monsters; buildings sit at the tile's own loc
      const [ux, uy] = p[1] === "building" ? [ox, oy] : [cx, cy];
      if (!drawSprite(c, unitSpriteName(p[1], p[2], water), ux, uy)) badge(c, p[2], ox + 13, oy + 25);
    } else if (base === "plan") {
      // The game shows only a blueprint (plan.generic); the editor puts the model's plans-menu
      // picture behind it, with the paper in the tile's bottom-right corner
      if (!drawFitted(c, planSpriteName(p[1]), ox + 11, oy + 18, 50, 40, 1.6)) badge(c, p[1], ox + 11, oy + 18);
      drawSprite(c, "plan.generic", ox + 5, oy + 14);
      if (withCount) drawPlanCount(c, p, x, y);
    } else if (base === "pile") {
      const res = [];
      for (let i = 1; i + 1 < p.length; i += 2) if (+p[i + 1] > 0) res.push([p[i], +p[i + 1]]);
      res.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const wy = water ? PILE_WATER_DY : 0;
      res.slice(0, PILE_SPOTS.length).forEach(([r, n], i) => {
        drawSprite(c, pileSpriteName(r, n), ox + PILE_SPOTS[i][0], oy + PILE_SPOTS[i][1] + wy);
      });
    } else if (base === "goal" || base === "bonusgoal") {
      // The game puts a shadow at the tile's loc (lower on water, whose surface sits lower)
      // and floats the goal above it; here the goal hovers centered over its shadow
      const shadowName = water || WB.isWaterTerrain(p[2]) ? "goal.shadow.water" : "goal.shadow.normal";
      const shadow = spriteNow(shadowName);
      let gx = ox + 13, gy = oy + 26;
      if (shadow) {
        drawSprite(c, shadowName, ox, oy);
        gx = ox - shadow.regX + shadow.w / 2;
        gy = oy - shadow.regY + shadow.h / 2 - 2;
      }
      const g = spriteNow(base === "goal" ? "goal.goal" : "goal.bonus");
      if (g) c.drawImage(g.img, Math.round(gx - g.w / 2), Math.round(gy - g.h));
      else badge(c, base === "goal" ? "!" : "★", gx, gy - 12);
    } else if (base === "whirlpool") {
      badge(c, "⟳ " + p[1], ox + 13, oy + 25, "#0a4f8cdd");
    } else badge(c, p[0], ox + 13, oy + 25, "#a00d");
  }

  // Faint copy of the brush object under the cursor, wherever a click would put it down
  function drawGhost(lv) {
    if (!["paint", "fill"].includes(S.tool) || !S.hover || !inMap(...S.hover) || panning || spaceDown) return;
    const [x, y] = S.hover;
    const c = lv.grid[y][x];
    const b = S.brush;
    // Objects only: terrain sprites have their own heights and don't overlay cleanly
    if (b.kind !== "object") return;
    if (c.item >= 0 && !(S.tool === "fill" || modDown)) return;
    const water = b.ground ? b.ground === "w" : c.item >= 0 ? WB.itemIsWater(lv.items[c.item].parts) : isWaterChar(c.t);
    const parts = brushParts(water);
    if (!parts) return;
    ctx.globalAlpha = 0.7;
    drawObject(ctx, parts, x, y);
    ctx.globalAlpha = 1;
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const lv = lvl();
    if (!lv) return;
    const v = S.view;
    ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.x, dpr * v.y);
    ctx.imageSmoothingEnabled = v.zoom < 1;
    const h = lv.grid.length, w = h ? lv.grid[0].length : 0;

    // terrain, back to front
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = lv.grid[y][x];
        const [ox, oy] = cellOrigin(x, y);
        const tname = terrainSpriteForCell(lv, c);
        if (tname === "terrain.hole") {
          facePath(ctx, x, y, 2);
          ctx.setLineDash([4, 4]); ctx.strokeStyle = "#ffffff30"; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
          continue;
        }
        if (!drawSprite(ctx, tname, ox, oy)) {
          facePath(ctx, x, y);
          ctx.fillStyle = "#3b7d3b";
          ctx.fill();
        }
        if (c.item < 0 && S.game.terrain[c.t] == null) badge(ctx, c.t, ox + 13, oy + 25, "#a00d");
      }
    }
    if (S.showGrid) {
      ctx.strokeStyle = "#00000026";
      ctx.lineWidth = 1 / v.zoom;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (S.game.terrain[lv.grid[y][x].t] === "hole" && lv.grid[y][x].item < 0) continue;
        facePath(ctx, x, y);
        ctx.stroke();
      }
    }
    // objects; while one is being dragged, its old tile (and a tile it would swap with) shows faded
    const mv = S.drag && S.drag.move;
    const moving = mv && String(mv.from) !== String(mv.to);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = lv.grid[y][x];
      if (c.item < 0) continue;
      const faded = moving && (String([x, y]) === String(mv.from) || String([x, y]) === String(mv.to));
      if (faded) ctx.globalAlpha = 0.3;
      drawObject(ctx, lv.items[c.item].parts, x, y, false);
      ctx.globalAlpha = 1;
    }
    // plan counts go over everything, including objects on the rows in front
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const c = lv.grid[y][x];
      if (c.item < 0 || lv.items[c.item].parts[0].replace(/^water/, "") !== "plan") continue;
      if (moving && (String([x, y]) === String(mv.from) || String([x, y]) === String(mv.to))) ctx.globalAlpha = 0.3;
      drawPlanCount(ctx, lv.items[c.item].parts, x, y);
      ctx.globalAlpha = 1;
    }
    if (moving) {
      const ok = canMove(mv.from, mv.to);
      const [a, b] = movedParts(mv.from, mv.to);
      ctx.globalAlpha = ok ? 0.9 : 0.45;
      drawObject(ctx, a || lv.items[lv.grid[mv.from[1]][mv.from[0]].item].parts, ...mv.to);
      if (b && ok) drawObject(ctx, b, ...mv.from);
      ctx.globalAlpha = 1;
      if (!ok) {
        facePath(ctx, mv.to[0], mv.to[1], 1);
        ctx.fillStyle = "#ff3b3040"; ctx.fill();
        ctx.strokeStyle = "#ff5d5d"; ctx.lineWidth = 2 / v.zoom; ctx.stroke();
      }
    }
    if (!S.drag || S.drag.op) drawGhost(lv);
    drawPasteGhost();
    // start view
    if (S.showView) drawStartView(lv, w, h);
    // selection / hover / rect preview
    if (S.drag && S.drag.rect) {
      const [x0, y0, x1, y1] = S.drag.rect;
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        if (!inMap(x, y)) continue;
        facePath(ctx, x, y);
        ctx.fillStyle = S.drag.copy ? "#2a7de140" : "#ffcf1a40";
        ctx.fill();
      }
    }
    if (S.sel && inMap(S.sel[0], S.sel[1])) {
      facePath(ctx, S.sel[0], S.sel[1], 1);
      ctx.strokeStyle = "#2a7de1"; ctx.lineWidth = 3 / v.zoom; ctx.stroke();
    }
    if (S.hover && inMap(S.hover[0], S.hover[1])) {
      facePath(ctx, S.hover[0], S.hover[1], 1);
      ctx.strokeStyle = "#ffcf1a"; ctx.lineWidth = 2 / v.zoom; ctx.stroke();
    }
    // a goal's objective only shows while the mouse is over it, on top of everything
    if (S.hover && inMap(...S.hover) && !(S.drag && S.drag.move)) {
      const c = lv.grid[S.hover[1]][S.hover[0]];
      const p = c.item >= 0 && lv.items[c.item].parts;
      if (p && (p[0] === "goal" || p[0] === "bonusgoal")) drawGoalPopup(p, ...S.hover);
    }
  }

  /* The game's goal popup ("goal info popup beh"): a speech bubble pointing at a spot 20px above
   * the tile, with a heading, the goal's target and "AT THIS LOCATION". The bubble is cut from
   * the game's goal_bubble bitmap (corners, edges, point) and sized to fit the text. Drawn at
   * least at the game's own size so it stays readable when zoomed out. */
  const POPUP_LINES = [
    ['900 13px "Arial Black", "Arial", sans-serif', 0],
    ['900 11px "Arial Black", "Arial", sans-serif', 0],
    ['bold 7px "04b_08", "Arial", sans-serif', 0],
  ];
  function drawGoalPopup(p, x, y) {
    const art = matteNow("goal_bubble");
    if (!art) return;
    const v = S.view, dpr = window.devicePixelRatio || 1;
    const [ox, oy] = cellOrigin(x, y);
    const k = Math.max(1, v.zoom);
    ctx.save();
    // origin at the tip of the bubble's point
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (v.x + (ox + 10) * v.zoom), dpr * (v.y + (oy - 20) * v.zoom));
    ctx.imageSmoothingEnabled = false;

    // measure each line's ink so every gap and margin is the same
    const texts = [p[0] === "goal" ? "Mission Goal:" : "Bonus Goal:", goalObjective(p[1]), "AT THIS LOCATION"];
    const m = texts.map((t, i) => {
      ctx.font = POPUP_LINES[i][0];
      const r = ctx.measureText(t);
      return { w: Math.ceil(r.width), up: Math.ceil(Math.max(r.actualBoundingBoxAscent, ctx.measureText("H").actualBoundingBoxAscent)), down: Math.ceil(r.actualBoundingBoxDescent) };
    });
    const BORDER = 3, PAD = 7, GAP = 4;
    const w = Math.max(60, ...m.map((l) => l.w)) + 2 * (BORDER + PAD);
    const h = m.reduce((a, l) => a + l.up + l.down, 0) + GAP * (m.length - 1) + 2 * (BORDER + PAD);
    const left = -Math.round(w / 2), top = -5 - h; // the point hangs 6px below the body, its tip at y=0
    drawBubble(art, left, top, w, h);

    ctx.fillStyle = "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    let yy = top + BORDER + PAD;
    texts.forEach((t, i) => {
      ctx.font = POPUP_LINES[i][0];
      yy += m[i].up;
      ctx.fillText(t, left + w / 2, yy);
      yy += m[i].down + GAP;
    });
    ctx.restore();
  }

  // goal_bubble is 157×70: 8px corners, a 3px border, body rows 0–63, and the point
  // (columns 70–86, tip at column 78) hanging below to row 69
  function drawBubble(art, left, top, w, h) {
    const img = art.img, C = 8, SW = art.w, BODY = 64;
    const piece = (sx, sy, sw, sh, dx, dy, dw, dh) => ctx.drawImage(img, sx, sy, sw, sh, left + dx, top + dy, dw, dh);
    ctx.fillStyle = "#fff";
    ctx.fillRect(left + 3, top + 3, w - 6, h - 6);
    piece(0, 0, C, C, 0, 0, C, C);
    piece(SW - C, 0, C, C, w - C, 0, C, C);
    piece(0, BODY - C, C, C, 0, h - C, C, C);
    piece(SW - C, BODY - C, C, C, w - C, h - C, C, C);
    piece(C, 0, 1, C, C, 0, w - 2 * C, C); // top edge
    piece(C, BODY - C, 1, C, C, h - C, w - 2 * C, C); // bottom edge
    piece(0, C, C, 1, 0, C, C, h - 2 * C); // left edge
    piece(SW - C, C, C, 1, w - C, C, C, h - 2 * C); // right edge
    // the point, centered under the body, covering the bottom edge where it joins
    piece(70, BODY - C, 17, C + 6, Math.round(w / 2) - 8, h - C, 17, C + 6);
  }

  function startViewRect(lv, w, h) {
    // mirrors map_display.readmap: scroll so the center tile sits mid-window
    const c = lv.center || [Math.floor(w / 2) + 1, Math.floor(h / 2)];
    let left = Math.trunc(c[0] - VIEW_W / 2 + 1), top = Math.trunc(c[1] - VIEW_H / 2);
    left = Math.max(1, Math.min(left, w - VIEW_W + 1));
    top = Math.max(1, Math.min(top, h - VIEW_H + 1));
    return { left: left - 1, top: top - 1, c };
  }

  function drawStartView(lv, w, h) {
    const { left, top, c } = startViewRect(lv, w, h);
    const x0 = left, y0 = top, x1 = Math.min(w, left + VIEW_W), y1 = Math.min(h, top + VIEW_H);
    const p = (x, y) => [x * CELL - y * SKEW + 1, y * CELL];
    ctx.beginPath();
    ctx.moveTo(...p(x0, y0)); ctx.lineTo(...p(x1, y0)); ctx.lineTo(...p(x1, y1)); ctx.lineTo(...p(x0, y1)); ctx.closePath();
    ctx.setLineDash([10, 6]);
    ctx.strokeStyle = "#ffffffb0";
    ctx.lineWidth = 2 / S.view.zoom;
    ctx.stroke();
    ctx.setLineDash([]);
    if (lv.center) {
      const [ox, oy] = cellOrigin(c[0] - 1, c[1] - 1);
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(ox + 13, oy + 25, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#1b1b1b"; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ input

  // Erase removes objects, so it only makes sense with an object brush
  const canErase = () => S.brush.kind === "object";
  function setTool(t) {
    if (t === "erase" && !canErase()) { setStatus("Erase removes objects: pick an object brush first (or right-click an object to delete it)."); return; }
    if (t !== "select" && S.pasting) stopPasting();
    S.tool = t;
    markTools();
    updateCursor();
  }
  function markTools() {
    for (const b of document.querySelectorAll("#toolset button")) b.classList.toggle("on", b.dataset.tool === S.tool);
    const er = $('#toolset [data-tool="erase"]');
    er.setAttribute("aria-disabled", String(!canErase()));
    er.title = canErase() ? "Remove objects (E)" : "Remove objects (E). Pick an object brush first.";
  }

  // Brush with an object picks objects up (terrain brushes and Fill never do; Select always does)
  function selectsObjects() {
    return S.tool === "select" || (S.tool === "paint" && S.brush.kind === "object");
  }

  const replacing = (e) => S.tool === "paint" && (e.altKey || e.ctrlKey);
  let modDown = false; // Alt or Ctrl held: the ghost shows a replace preview over objects

  function updateCursor() {
    const t = S.tool;
    const h = S.hover && inMap(...S.hover) ? S.hover : null;
    const overObject = h && lvl().grid[h[1]][h[0]].item >= 0;
    const overSelected = overObject && S.sel && String(S.sel) === String(h);
    const objectTools = selectsObjects();
    canvas.style.cursor = panning || (S.drag && S.drag.move) ? "grabbing" : spaceDown ? "grab"
      : t === "pick" || (t === "select" && S.pasting) ? "copy"
      : objectTools && overSelected ? "grab"
      : objectTools && overObject ? "pointer"
      : t === "select" ? "pointer" : "crosshair";
  }

  function cellLabel(x, y) {
    const lv = lvl();
    const c = lv.grid[y][x];
    let s = `(${x + 1}, ${y + 1}) `;
    if (c.item >= 0) {
      const p = lv.items[c.item].parts;
      s += p[2] === "boulder" && p[0].replace(/^water/, "") === "unit" ? "I rock!" : describeParts(p);
      // plans also list the bricks their model needs
      const recipe = p[0].replace(/^water/, "") === "plan" && recipeOf(p[1]);
      if (recipe) s += `: needs ${recipeText(recipe)}`;
    } else s += WB.TERRAIN_LABELS[S.game.terrain[c.t]] || S.game.terrain[c.t] || `unknown "${c.t}"`;
    return s;
  }

  function describeParts(p) {
    const base = p[0].replace(/^water/, "");
    const onWater = WB.itemIsWater(p) ? " (on water)" : "";
    if (base === "unit") return `${displayName(p[2])}: ${p[1]}${onWater}`;
    if (base === "plan") return `Plan: ${displayName(p[1])} ×${p[2]}${onWater}`;
    if (base === "pile") {
      const r = [];
      for (let i = 1; i + 1 < p.length; i += 2) r.push(`${p[i + 1]} ${p[i]}`);
      return `Brick pile: ${r.join(", ")}${onWater}`;
    }
    if (base === "goal") return `Mission goal: ${p[1]}${onWater}`;
    if (base === "bonusgoal") return `Bonus goal: ${p[1]}${onWater}`;
    if (base === "whirlpool") return `Whirlpool #${p[1]}`;
    return p.join(",");
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("pointerdown", (e) => {
    if (!lvl()) return;
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const [x, y] = screenToCell(e.clientX - r.left, e.clientY - r.top);
    const onObject = inMap(x, y) && lvl().grid[y][x].item >= 0;
    // right-click on an object deletes it (dragging keeps deleting); elsewhere right-drag pans
    if (e.button === 2 && onObject && !spaceDown) {
      startStroke(eraseAt, x, y);
      return;
    }
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
      panning = { x: e.clientX, y: e.clientY, vx: S.view.x, vy: S.view.y };
      updateCursor();
      return;
    }
    if (e.button !== 0 || !inMap(x, y)) return;
    if (S.tool === "select" && S.pasting) {
      pushUndo();
      if (pasteAt(x, y)) changed(); else { L().undo.pop(); draw(); }
      return;
    }
    // Shift + Brush drags out a filled rectangle; Shift + Select copies one (from anywhere, even an object)
    const rectDrag = (S.tool === "paint" || S.tool === "select") && e.shiftKey;
    // Shift+click on a plan loads the brush with a pile of the bricks its model needs
    // (with the Brush, only if the press doesn't turn into a rectangle drag)
    if (e.shiftKey && onObject && lvl().items[lvl().grid[y][x].item].parts[0].replace(/^water/, "") === "plan") {
      if (rectDrag) { S.drag = { rect: [x, y, x, y], plan: true, copy: S.tool === "select" }; draw(); }
      else pickRecipe(x, y);
      return;
    }
    if (onObject && replacing(e)) {
      pushUndo();
      if (replaceAt(x, y)) { S.sel = null; changed(); } else L().undo.pop();
      return;
    }
    // Objects: pressing on one selects it, and dragging moves it straight away
    if (onObject && selectsObjects() && !rectDrag) {
      const fresh = !S.sel || S.sel[0] !== x || S.sel[1] !== y;
      S.sel = [x, y];
      S.drag = { move: { from: [x, y], to: [x, y] } };
      if (fresh) {
        if (S.tool === "select") showTab("inspect");
        refreshPanels();
      }
      updateCursor();
      draw();
      return;
    }
    if (S.tool !== "select" && S.sel) { S.sel = null; refreshPanels(); }
    switch (S.tool) {
      case "paint":
        if (rectDrag) { S.drag = { rect: [x, y, x, y] }; draw(); }
        else startStroke(applyBrush, x, y);
        break;
      case "erase":
        startStroke(eraseAt, x, y);
        break;
      case "fill":
        pushUndo();
        floodFill(x, y);
        changed();
        break;
      case "pick":
        pickAt(x, y);
        break;
      case "select": // a click selects the tile, a drag copies the tiles it covers
        S.drag = { rect: [x, y, x, y], copy: true };
        draw();
        break;
      case "start": // one click from the Level tab's "Pick on map", then back to the previous tool
        pushUndo();
        lvl().center = [x + 1, y + 1];
        setTool(S.prevTool || "paint");
        changed();
        setStatus("Start view set.");
        break;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!lvl()) return;
    trackMod(e);
    if (panning) {
      S.view.x = panning.vx + e.clientX - panning.x;
      S.view.y = panning.vy + e.clientY - panning.y;
      draw();
      return;
    }
    const r = canvas.getBoundingClientRect();
    const [x, y] = screenToCell(e.clientX - r.left, e.clientY - r.top);
    const inside = inMap(x, y);
    const nh = inside ? [x, y] : null;
    if (S.drag && inside) {
      if (S.drag.move) S.drag.move.to = [x, y];
      else if (S.drag.rect) S.drag.rect[2] = x, S.drag.rect[3] = y;
      else if (S.drag.op(x, y)) S.drag.changed = true;
    }
    if (String(nh) !== String(S.hover) || S.drag) {
      S.hover = nh;
      $("#hoverText").textContent = inside ? cellLabel(x, y) : "";
      updateCursor();
      draw();
    }
  });
  const endDrag = () => {
    if (panning) { panning = null; updateCursor(); return; }
    if (!S.drag) return;
    const d = S.drag;
    S.drag = null;
    if (d.move) {
      if (canMove(d.move.from, d.move.to)) {
        pushUndo();
        moveObject(d.move.from, d.move.to);
        S.sel = d.move.to;
        changed();
      } else {
        if (String(d.move.from) !== String(d.move.to)) setStatus("That object can't stand on that tile (or the object there can't stand on this one).");
        draw();
      }
      updateCursor();
    } else if (d.rect && d.plan && d.rect[0] === d.rect[2] && d.rect[1] === d.rect[3]) {
      pickRecipe(d.rect[0], d.rect[1]);
      draw();
    } else if (d.copy && d.rect[0] === d.rect[2] && d.rect[1] === d.rect[3]) {
      S.sel = [d.rect[0], d.rect[1]];
      showTab("inspect");
      refreshPanels();
      updateCursor();
      draw();
    } else if (d.copy) {
      copyArea(...d.rect);
    } else if (d.rect) {
      pushUndo();
      const [x0, y0, x1, y1] = d.rect;
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        if (inMap(x, y)) applyBrush(x, y);
      }
      changed();
    } else if (d.changed) changed();
    else { L().undo.pop(); draw(); }
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => { S.hover = null; $("#hoverText").textContent = ""; draw(); });
  canvas.addEventListener("wheel", (e) => {
    if (!lvl()) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  function zoomAt(sx, sy, f) {
    const v = S.view;
    const nz = Math.max(0.15, Math.min(4, v.zoom * f));
    v.x = sx - ((sx - v.x) * nz) / v.zoom;
    v.y = sy - ((sy - v.y) * nz) / v.zoom;
    v.zoom = nz;
    S.zoom = nz;
    prefs.set("zoom", nz);
    $("#zoomLabel").textContent = Math.round(nz * 100) + "%";
    draw();
  }

  // Hold Space and drag with the left button to pan (right/middle drag also pans)
  const typing = (e) => e.target.matches("input, textarea, select") || !!document.querySelector("dialog[open]");
  window.addEventListener("keydown", (e) => {
    if (typing(e)) return;
    if (e.key === " ") {
      e.preventDefault();
      // a focused button would otherwise be "clicked" when Space is released
      if (document.activeElement && document.activeElement.matches("button")) document.activeElement.blur();
      if (!spaceDown) { spaceDown = true; updateCursor(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (S.movie) openSave(); return; }
    // pick up the last copied tiles again (they can go into another level too)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && S.clip && lvl()) { e.preventDefault(); setTool("select"); startPasting(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() === "l") { setLevelsCollapsed(!document.body.classList.contains("levels-collapsed")); return; }
    const map = { b: "paint", f: "fill", e: "erase", i: "pick", s: "select" };
    if (e.key === "Escape" && S.tool === "start") { setTool(S.prevTool || "paint"); setStatus(""); return; }
    if (e.key === "Escape" && S.pasting) { stopPasting(); return; }
    if (map[e.key.toLowerCase()] && lvl()) setTool(map[e.key.toLowerCase()]);
    if (e.key === "Escape" && S.sel && lvl()) { S.sel = null; refreshPanels(); updateCursor(); draw(); return; }
    if (e.key === "Delete" && S.sel && lvl()) { pushUndo(); if (eraseAt(...S.sel)) changed(); else L().undo.pop(); }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key !== " " || !spaceDown) return;
    e.preventDefault();
    spaceDown = false;
    updateCursor();
  });
  window.addEventListener("blur", () => { spaceDown = false; modDown = false; updateCursor(); draw(); });
  const trackMod = (e) => {
    const on = e.altKey || e.ctrlKey;
    if (on !== modDown) { modDown = on; if (lvl()) draw(); }
  };
  window.addEventListener("keydown", trackMod);
  window.addEventListener("keyup", (e) => { if (e.key === "Alt") e.preventDefault(); trackMod(e); });

  // ------------------------------------------------------------------ palette

  async function thumb(name, size = 48) {
    const s = name && (await sprite(name));
    const cv = el("canvas", { width: size, height: size });
    if (!s) return cv;
    const c = cv.getContext("2d");
    const k = Math.min(size / s.w, size / s.h, 1.5);
    c.imageSmoothingQuality = "high";
    c.drawImage(s.img, (size - s.w * k) / 2, (size - s.h * k) / 2, s.w * k, s.h * k);
    return cv;
  }

  function setBrushTerrain(ch) {
    S.brush = { kind: "terrain", char: ch };
    if (!["paint", "fill"].includes(S.tool)) setTool("paint");
    markTools();
    if (S.sel) { S.sel = null; refreshPanels(); draw(); }
    updateCursor();
    markSwatches();
    buildBrushOpts();
  }
  function setBrushObject(o) {
    S.brush = { kind: "object", ...o };
    S.objCat = categoryOf(o);
    if (S.tool !== "paint") setTool("paint");
    markTools();
    buildObjectCats();
    markSwatches();
    buildBrushOpts();
  }
  function brushId(b) {
    if (b.kind === "terrain") return "t:" + b.char;
    return ["o", b.type, b.cls || "", b.name || "", b.goal || ""].join(":");
  }
  function markSwatches() {
    const id = brushId(S.brush);
    const ground = S.brush.ground ? "t:" + S.brush.ground : null;
    for (const s of document.querySelectorAll(".swatch")) s.classList.toggle("on", s.dataset.id === id || s.dataset.id === ground);
  }

  const HIDDEN_TERRAIN = new Set(["volcano"]);
  function buildTerrainPalette() {
    const box = $("#palTerrain");
    box.replaceChildren();
    // volcano looks exactly like mountain but has no minimap icon, and no level uses it
    const order = Object.entries(S.game.terrain).filter(([, t]) => !HIDDEN_TERRAIN.has(t));
    for (const [ch, t] of order) {
      const label = WB.TERRAIN_LABELS[t] || t;
      const sw = el("button", { class: "swatch", title: `${label}: "${ch}"`, "data-id": "t:" + ch, onclick: () => setBrushTerrain(ch) },
        el("span", { class: "k" }, ch));
      box.append(sw);
      thumb(t === "hole" ? null : "terrain." + t).then((cv) => {
        if (t === "hole") {
          const c = cv.getContext("2d");
          c.setLineDash([3, 3]); c.strokeStyle = "#ffffff80";
          c.beginPath(); c.moveTo(18, 12); c.lineTo(44, 12); c.lineTo(30, 38); c.lineTo(4, 38); c.closePath(); c.stroke();
        }
        sw.prepend(cv);
      });
    }
    markSwatches();
  }

  const CATS = [["model", "Models"], ["monster", "Monsters"], ["plan", "Plans"], ["misc", "Misc"]];
  // Boulders are "monsters" to the game but act as obstacles, so they live under Misc
  const isBoulder = (o) => o.type === "unit" && o.cls === "monster" && o.name === "boulder";
  function categoryOf(o) {
    if (o.type === "plan") return "plan";
    if (o.type !== "unit" || isBoulder(o)) return "misc";
    return o.cls === "monster" ? "monster" : "model";
  }
  function buildObjectCats() {
    const seg = $("#objCats");
    seg.replaceChildren(...CATS.map(([k, label]) =>
      el("button", { class: S.objCat === k ? "on" : "", onclick: () => { S.objCat = k; buildObjectCats(); } }, label)));
    buildObjectPalette();
  }

  function buildObjectPalette() {
    const box = $("#palObjects");
    box.replaceChildren();
    const add = (o, spriteName, label, title) => {
      const b = { kind: "object", ...o };
      const sw = el("button", { class: "swatch", title, "data-id": brushId(b), onclick: () => setBrushObject(o) }, el("span", { class: "lbl" }, label));
      // Right-click on a plan swatch: a pile of the bricks that model needs
      if (o.type === "plan") sw.addEventListener("contextmenu", (e) => { e.preventDefault(); recipeBrush(o.name); });
      box.append(sw);
      thumb(spriteName, 44).then((cv) => sw.prepend(cv));
    };
    const cat = S.objCat;
    const addUnit = (cls, n) =>
      add({ type: "unit", cls, name: n }, unitSpriteName(cls, n, false) || unitSpriteName(cls, n, true), displayName(n), unitTooltip(cls, n));
    if (cat === "model") {
      for (const cls of ["vehicle", "building"]) for (const n of placeable(cls)) addUnit(cls, n);
    } else if (cat === "monster") {
      for (const n of placeable("monster")) if (n !== "boulder") addUnit("monster", n);
    } else if (cat === "plan") {
      if (S.monsterPlans.length && !S.patchOn.monsterPlans)
        box.append(el("p", { class: "muted small", style: "grid-column: 1 / -1; margin: 0 0 4px" }, "Plans for monsters: switch on the Monster plans patch on the Game tab."));
      for (const n of planModels()) {
        const recipe = recipeOf(n);
        add({ type: "plan", name: n }, planSpriteName(n), displayName(n), recipe ? recipeText(recipe) : displayName(n));
      }
    } else if (cat === "misc") {
      add({ type: "pile" }, "resource.yellow.4", "Brick pile", "A pile of bricks (set its contents below)");
      if (placeable("monster").includes("boulder")) addUnit("monster", "boulder");
      add({ type: "goal", goal: "goal" }, "goal.goal", "Mission goal", "Mission goal: bring the required model here");
      add({ type: "goal", goal: "bonusgoal" }, "goal.bonus", "Bonus goal", "Bonus goal: optional harder target");
      add({ type: "whirlpool" }, "terrain.water_whirlpool", "Whirlpool", "Whirlpools teleport water units; place two with the same number");
    }
    markSwatches();
  }

  function recipeOf(name) {
    for (const cls of ["vehicle", "building", "monster"]) {
      const c = S.game.config[cls] && S.game.config[cls][name];
      if (c && c.recipe) return c.recipe;
    }
    return null;
  }
  const recipeText = (recipe) => Object.entries(recipe).map(([k, v]) => `${v} ${k}`).join(", ");

  function unitTooltip(cls, n) {
    if (n === "boulder") return "I rock!";
    const c = S.game.config[cls] && S.game.config[cls][n];
    let t = displayName(n);
    if (c) {
      if (c.recipe) t += "\nRecipe: " + recipeText(c.recipe);
      if (c.terrain) t += "\nTerrain: " + [].concat(c.terrain).join(", ");
    }
    return t;
  }

  function resourceSelect(value, onchange) {
    return el("select", { onchange: (e) => onchange(e.target.value) },
      S.game.resources.map((r) => el("option", { value: r, selected: r === value }, r)));
  }

  function pileEditor(rows, onchange) {
    const box = el("div");
    const render = () => {
      box.replaceChildren(
        ...rows.map((row, i) => el("div", { class: "pile" },
          resourceSelect(row[0], (v) => { row[0] = v; onchange(rows); }),
          el("input", { type: "number", min: 1, max: 999, value: row[1], onchange: (e) => { row[1] = Math.max(1, +e.target.value || 1); onchange(rows); } }),
          el("button", { title: "Remove", onclick: () => { if (rows.length > 1) { rows.splice(i, 1); render(); onchange(rows); } } }, "×"))),
        el("div", { class: "row" }, el("button", { onclick: () => { rows.push(["blue", 10]); render(); onchange(rows); } }, "+ Add bricks")));
    };
    render();
    return box;
  }

  /* What a goal needs: any model, a particular vehicle, building or monster brought to the goal,
   * or "collect N <monster>" (monsters delivered to capture-zone tiles). */
  function goalTargetField(value, onchange) {
    const COLLECT = "__collect__";
    const monsters = placeable("monster");
    const known = new Set(["anything", ...placeable("vehicle"), ...placeable("building"), ...monsters]);
    const opt = (v, label) => el("option", { value: v, selected: v === value }, label);
    const group = (label, names) => (names.length ? el("optgroup", { label }, names.map((n) => opt(n, displayName(n)))) : null);
    const box = el("div", {});
    const render = () => {
      const c = /^collect\s+(\d+)\s+(\w+)$/.exec(value || "");
      const select = el("select", {
        onchange: (e) => {
          value = e.target.value === COLLECT ? `collect 1 ${monsters[0] || "crab"}` : e.target.value;
          onchange(value);
          render();
        },
      },
        opt("anything", "Anything"),
        group("Vehicles", placeable("vehicle")),
        group("Buildings", placeable("building")),
        group("Monsters & animals", monsters),
        el("optgroup", { label: "Capture zone" }, el("option", { value: COLLECT, selected: !!c }, "Collect monsters…")),
        // keep a target this list doesn't know about
        !c && value && !known.has(value) ? el("optgroup", { label: "Other" }, opt(value, value)) : null);
      const kids = [select];
      if (c) {
        const setCollect = (n, m) => { value = `collect ${n} ${m}`; onchange(value); };
        const count = el("input", { type: "number", min: 1, max: 99, value: c[1], style: "width:4em",
          onchange: (e) => setCollect(Math.max(1, +e.target.value || 1), monster.value) });
        const monster = el("select", { onchange: (e) => setCollect(count.value, e.target.value) },
          [...new Set([...monsters, c[2]])].map((m) => el("option", { value: m, selected: m === c[2] }, displayName(m))));
        kids.push(el("div", { class: "row", style: "margin-top:4px;gap:4px;display:flex" }, count, monster),
          el("div", { class: "muted small" }, "Monsters have to be brought to capture-zone tiles."));
      }
      box.replaceChildren(...kids);
    };
    render();
    return box;
  }

  function buildBrushOpts() {
    const box = $("#brushOpts");
    box.replaceChildren();
    const b = S.brush;
    if (b.kind !== "object") return;
    const what = { plan: () => `Plan: ${displayName(b.name)}`, pile: () => "Brick pile", whirlpool: () => "Whirlpool",
      goal: () => (b.goal === "goal" ? "Mission goal" : "Bonus goal"), unit: () => displayName(b.name) }[b.type];
    const groundName = b.ground && (WB.TERRAIN_LABELS[S.game.terrain[b.ground]] || S.game.terrain[b.ground]);
    box.append(el("div", { class: "panel-title" }, `Placing: ${what ? what() : "object"}${groundName ? " on " + groundName : ""}`));
    if (b.type === "plan") {
      box.append(el("div", { class: "field" }, el("label", {}, "Uses"),
        el("input", { type: "number", min: 1, max: 99, value: S.planCount, onchange: (e) => (S.planCount = Math.max(1, +e.target.value || 1)) })));
    } else if (b.type === "pile") {
      box.append(pileEditor(S.pileDraft, (rows) => (S.pileDraft = rows)));
    } else if (b.type === "goal") {
      box.append(el("div", { class: "field" }, el("label", {}, "Needs"), goalTargetField(S.goalTarget, (v) => (S.goalTarget = v))));
    } else if (b.type === "whirlpool") {
      box.append(el("div", { class: "field" }, el("label", {}, "Pair number"),
        el("input", { type: "number", min: 1, max: 99, value: S.whirlId, onchange: (e) => (S.whirlId = String(Math.max(1, +e.target.value || 1))) })));
    } else if (b.type === "unit") {
      box.append(el("div", { class: "muted small" }, unitTooltip(b.cls, b.name).split("\n").slice(1).join(" · ") || displayName(b.name)));
    }
    box.append(el("div", { class: "muted small", style: "margin-top:6px" }, groundName
      ? `Picked with the eyedropper: paints ${groundName.toLowerCase()} under it too. Click the object in the palette to place it on any ground.`
      : "Placed on water tiles, objects automatically become their water version."));
  }

  // ------------------------------------------------------------------ side panels

  function showTab(t) {
    for (const b of document.querySelectorAll("#sideTabs button")) b.classList.toggle("on", b.dataset.tab === t);
    for (const id of ["palette", "inspect", "level", "text", "game"]) $("#tab-" + id).hidden = id !== t;
    if (t === "text") $("#levelText").value = currentText();
  }

  function currentText() {
    const e = L();
    if (!e) return "";
    if (!e.dirty) return e.text;
    if (!e.textCache) e.textCache = WB.serializeLevel(e.lv, S.game.terrain);
    return e.textCache;
  }

  function refreshPanels() {
    if (!lvl()) return;
    buildInspector();
    buildLevelPanel();
    buildGamePanel();
    buildProblems();
    if (!$("#tab-text").hidden) $("#levelText").value = currentText();
  }

  function buildInspector() {
    const box = $("#tab-inspect");
    box.replaceChildren();
    const lv = lvl();
    if (!S.sel || !inMap(...S.sel)) {
      box.append(el("p", { class: "muted" }, "Use the Select tool (S) and click a tile to inspect it and edit its object."));
      return;
    }
    const [x, y] = S.sel;
    const c = lv.grid[y][x];
    box.append(el("div", { class: "panel-title" }, `Tile ${x + 1}, ${y + 1}`));
    const tsel = el("select", { onchange: (e) => { pushUndo(); setCellTerrain(x, y, e.target.value); changed(); } },
      Object.entries(S.game.terrain).map(([ch, t]) => el("option", { value: ch, selected: ch === c.t }, `${WB.TERRAIN_LABELS[t] || t}  (${ch})`)));
    box.append(el("div", { class: "field" }, el("label", {}, "Terrain"), tsel));
    if (c.item < 0) {
      box.append(el("p", { class: "muted small" }, "No object here."));
      return;
    }
    const parts = lv.items[c.item].parts.slice();
    const base = parts[0].replace(/^water/, "");
    const set = (np) => { pushUndo(); c.item = itemIndexFor(np); c.t = WB.itemIsWater(np) ? "w" : "."; changed(); };
    const card = el("div", { class: "card" }, el("h4", {}, describeParts(parts)));
    box.append(card);
    if (base === "unit") {
      const cls = parts[1];
      card.append(el("div", { class: "field" }, el("label", {}, "Model"),
        el("select", { onchange: (e) => set([parts[0], cls, e.target.value]) },
          [...new Set([...placeable(cls), parts[2]])].map((n) => el("option", { value: n, selected: n === parts[2] }, displayName(n))))));
      card.append(el("div", { class: "meta" }, unitTooltip(cls, parts[2]).split("\n").slice(1).join(" · ")));
    } else if (base === "plan") {
      const all = [...new Set([...planModels(), parts[1]])];
      card.append(el("div", { class: "field" }, el("label", {}, "Model"),
        el("select", { onchange: (e) => set([parts[0], e.target.value, parts[2]]) }, all.map((n) => el("option", { value: n, selected: n === parts[1] }, displayName(n))))));
      card.append(el("div", { class: "field" }, el("label", {}, "Uses"),
        el("input", { type: "number", min: 1, max: 99, value: parts[2], onchange: (e) => set([parts[0], parts[1], String(Math.max(1, +e.target.value || 1))]) })));
    } else if (base === "pile") {
      const rows = [];
      for (let i = 1; i + 1 < parts.length; i += 2) rows.push([parts[i], +parts[i + 1] || 1]);
      card.append(pileEditor(rows, (r) => set([parts[0], ...r.flatMap(([a, n]) => [a, String(n)])])));
    } else if (base === "goal" || base === "bonusgoal") {
      card.append(el("div", { class: "field" }, el("label", {}, "Kind"),
        el("select", { onchange: (e) => set([e.target.value, ...parts.slice(1)]) },
          el("option", { value: "goal", selected: base === "goal" }, "Mission goal"),
          el("option", { value: "bonusgoal", selected: base === "bonusgoal" }, "Bonus goal"))));
      card.append(el("div", { class: "field" }, el("label", {}, "Needs"), goalTargetField(parts[1], (v) => set([parts[0], v, ...parts.slice(2)]))));
    } else if (base === "whirlpool") {
      card.append(el("div", { class: "field" }, el("label", {}, "Pair number"),
        el("input", { type: "number", min: 1, max: 99, value: parts[1], onchange: (e) => set(["whirlpool", String(Math.max(1, +e.target.value || 1))]) })));
    }
    card.append(el("div", { class: "row" }, el("button", { onclick: () => { pushUndo(); c.item = -1; changed(); } }, "Remove object")));
  }

  function buildLevelPanel() {
    const box = $("#tab-level");
    box.replaceChildren();
    const lv = lvl();
    const e = L();
    const h = lv.grid.length, w = h ? lv.grid[0].length : 0;
    box.append(el("div", { class: "panel-title" }, `World ${e.world} · Mission ${e.mission}  (${e.member})`));
    const show = (label, key) => el("label", { class: "check" },
      el("input", { type: "checkbox", checked: S[key], onchange: (ev) => { S[key] = ev.target.checked; prefs.set(key, S[key] ? 1 : 0); draw(); } }), " " + label);
    box.append(el("div", { class: "row" }, show("Grid", "showGrid"), show("Start view", "showView")));
    if (S.game.titles.size) {
      box.append(el("div", { class: "field" }, el("label", {}, "Mission title"),
        el("input", { type: "text", value: missionTitle(e), onchange: (ev) => setMissionTitle(e, ev.target.value) })));
    }
    box.append(el("div", { class: "field" }, el("label", {}, "Internal name"),
      el("input", { type: "text", value: lv.name, onchange: (ev) => { pushUndo(); lv.name = ev.target.value.replace(/,/g, " "); changed(); } })));
    box.append(el("p", { class: "muted small" }, "The mission title is what the world map shows. The internal name is the level's own name= line."));

    // Music: a "music=" line in [map], which the game reads once its mission start is fixed (on save)
    const current = levelMusic(lv);
    const tracks = S.game.musicTracks || [];
    box.append(el("div", { class: "field" }, el("label", {}, "Music"),
      el("select", { disabled: !S.levelMusic.length || !S.patchOn.music, onchange: (ev) => { pushUndo(); setLevelMusic(lv, ev.target.value); changed(); } },
        el("option", { value: "" }, "Random (as normal)"),
        tracks.map((t) => el("option", { value: t, selected: t === current }, trackName(t))),
        current && !tracks.includes(current) ? el("option", { value: current, selected: true }, current) : null)));
    if (!S.levelMusic.length) box.append(el("p", { class: "muted small" }, "This game file can't be set up to choose music per level."));
    else if (!S.patchOn.music) box.append(el("p", { class: "muted small" }, "Turn on \"Music per level\" on the Game tab to choose this level's music."));

    const note = tutorialNote(e);
    if (note) box.append(el("div", { class: "card" }, el("h4", {}, "Tutorial"), el("div", { class: "meta" }, note)));

    const center = lv.center || [0, 0];
    const num = (v, f) => el("input", { type: "number", min: 0, value: v, onchange: (ev) => { pushUndo(); f(+ev.target.value || 0); changed(); } });
    box.append(el("div", { class: "field" }, el("label", {}, "Start view"),
      el("div", { class: "row", style: "margin:0" },
        num(center[0], (v) => (lv.center = [v, (lv.center || center)[1]])),
        num(center[1], (v) => (lv.center = [(lv.center || center)[0], v])),
        el("button", { title: "Let the game center the map", onclick: () => { pushUndo(); lv.center = null; changed(); } }, "Auto"),
        el("button", { title: "Click a tile on the map to start the camera there (Esc cancels)", onclick: pickStartView }, "Pick on map"))));

    box.append(el("div", { class: "panel-title" }, "Map size"));
    const fillChar = S.brush.kind === "terrain" ? S.brush.char : "@";
    // the view stays put: when the top or left edge changes, it shifts so the existing tiles don't move
    const rs = (side, delta) => {
      pushUndo();
      const [dx, dy] = resizeMap(side, delta, fillChar);
      const [ox, oy] = cellOrigin(dx, dy);
      S.view.x -= ox * S.view.zoom;
      S.view.y -= oy * S.view.zoom;
      changed();
    };
    // + and − on each edge of a little map; hovering a button lights up the edge it changes
    const edge = (side) => {
      const what = side === "top" || side === "bottom" ? "row" : "column";
      return el("div", { class: "rsEdge rs-" + side },
        el("button", { title: `Add a ${what} on the ${side}`, onclick: () => rs(side, 1) }, "+"),
        el("button", { title: `Remove the ${what} on the ${side}`, onclick: () => rs(side, -1) }, "−"));
    };
    box.append(el("div", { class: "resizer" },
      edge("top"), edge("left"),
      el("div", { class: "rsMap" }, mockMapCanvas(), el("span", {}, `${w} × ${h}`)),
      edge("right"), edge("bottom")));
    box.append(el("p", { class: "muted small" }, `New rows and columns are filled with the selected terrain brush (or holes).`));

    box.append(el("div", { class: "panel-title" }, "Starting plans (inventory)"));
    const all = planModels();
    lv.inventory.forEach((inv, i) => {
      box.append(el("div", { class: "inv" },
        el("select", { onchange: (ev) => { pushUndo(); inv.name = ev.target.value; changed(); } }, [...new Set([...all, inv.name])].map((n) => el("option", { value: n, selected: n === inv.name }, displayName(n)))),
        el("input", { type: "number", min: 1, max: 99, value: inv.count, onchange: (ev) => { pushUndo(); inv.count = Math.max(1, +ev.target.value || 1); changed(); } }),
        el("button", { title: "Remove", onclick: () => { pushUndo(); lv.inventory.splice(i, 1); changed(); } }, "×")));
    });
    box.append(el("div", { class: "row" }, el("button", { onclick: () => { pushUndo(); lv.inventory.push({ name: all[0] || "buggy", count: 10 }); changed(); } }, "+ Add starting plan")));

    box.append(el("div", { class: "panel-title" }, "Level"));
    box.append(el("div", { class: "row" },
      el("button", { onclick: revertLevel, disabled: !e.dirty }, "Revert to saved"),
      el("button", { onclick: clearLevel }, "Clear map")));

    box.append(el("div", { class: "panel-title" }, "Game"));
    box.append(el("p", { class: "muted small" }, "Mission unlocks, unit settings, descriptions and other text the whole game shares."));
    box.append(el("div", { class: "row" },
      el("button", { title: "Edit other text members (mission unlocks, descriptions…)", onclick: openTexts }, "Edit game texts…")));
  }

  /* A little made-up map drawn from the game's own tiles and objects, for the resize control.
   * Drawn once per game; each panel rebuild just copies it. */
  const MOCK_W = 340, MOCK_H = 190;
  function mockMapCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const cv = el("canvas", { class: "rsTiles", width: MOCK_W * dpr, height: MOCK_H * dpr });
    if (!S.mockMap) S.mockMap = renderMockMap(dpr);
    S.mockMap.then((src) => cv.getContext("2d").drawImage(src, 0, 0));
    return cv;
  }
  async function renderMockMap(dpr) {
    const rows = [
      ["normal", "tree", "normal", "normal", "water", "water"],
      ["mountain", "normal", "normal", "normal", "normal", "water"],
      ["normal", "normal", "tree", "normal", "normal", "normal"],
    ];
    const have = new Set(Object.values(S.game.terrain));
    const veh = placeable("vehicle")[0];
    const res = S.game.resources.includes("yellow") ? "yellow" : S.game.resources[0];
    const objects = [
      veh && [["unit", "vehicle", veh], 1, 1],
      res && [["pile", res, "10"], 4, 2],
    ].filter(Boolean);
    const names = rows.flat().map((t) => "terrain." + (have.has(t) ? t : "normal"));
    if (veh) names.push(unitSpriteName("vehicle", veh, false));
    if (res) names.push(pileSpriteName(res, 10));
    await Promise.all(names.filter(Boolean).map((n) => sprite(n)));

    const cols = rows[0].length, h = rows.length;
    const cv = document.createElement("canvas");
    cv.width = MOCK_W * dpr; cv.height = MOCK_H * dpr;
    const c = cv.getContext("2d");
    // map bounds in world pixels, with headroom for tall trees and models
    const x0 = -h * SKEW - 26, x1 = cols * CELL + 30, y0 = -40, y1 = h * CELL + 6;
    const k = Math.min(MOCK_W / (x1 - x0), MOCK_H / (y1 - y0)) * dpr;
    c.setTransform(k, 0, 0, k, (MOCK_W * dpr - (x1 + x0) * k) / 2, (MOCK_H * dpr - (y1 + y0) * k) / 2);
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = "high";
    rows.forEach((row, y) => row.forEach((t, x) => drawSprite(c, "terrain." + (have.has(t) ? t : "normal"), ...cellOrigin(x, y))));
    for (const [parts, x, y] of objects) drawObject(c, parts, x, y);
    return cv;
  }

  function pickStartView() {
    if (S.tool !== "start") S.prevTool = S.tool;
    setTool("start");
    setStatus("Click the map where the camera should start (Esc cancels).");
  }

  // The in-game tracks' names; any other track shows as "Track <letter>"
  const TRACK_NAMES = {
    music_game_a: "Blue And Green Makes...", music_game_i: "Joy of Bricks",
    music_game_6: "Sly Solutions", music_game_8: "Brain Builder",
  };
  const trackName = (t) => TRACK_NAMES[t] || "Track " + t.replace(/^music_game_/, "").toUpperCase();
  const MUSIC_LINE = /^music\s*=\s*(.*)$/i;
  function levelMusic(lv) {
    const m = lv.mapExtra.map((l) => MUSIC_LINE.exec(l)).find(Boolean);
    return m ? m[1].trim() : "";
  }
  function setLevelMusic(lv, track) {
    lv.mapExtra = lv.mapExtra.filter((l) => !MUSIC_LINE.test(l));
    if (track) lv.mapExtra.push("music=" + track);
  }

  /* Returns how far the old cells moved in the grid, [dx, dy] (nonzero only for the top/left edge). */
  function resizeMap(side, delta, fillChar) {
    const lv = lvl();
    const h = lv.grid.length, w = lv.grid[0].length;
    const blank = () => ({ t: fillChar, item: -1 });
    if (side === "top" || side === "bottom") {
      if (delta > 0) {
        const row = Array.from({ length: w }, blank);
        side === "top" ? lv.grid.unshift(row) : lv.grid.push(row);
        if (side === "top" && lv.center) lv.center[1]++;
        if (side === "top") return [0, 1];
      } else if (h > 2) {
        side === "top" ? lv.grid.shift() : lv.grid.pop();
        if (side === "top" && lv.center) lv.center[1] = Math.max(0, lv.center[1] - 1);
        if (side === "top") return [0, -1];
      }
    } else {
      if (delta > 0) {
        for (const r of lv.grid) side === "left" ? r.unshift(blank()) : r.push(blank());
        if (side === "left" && lv.center) lv.center[0]++;
        if (side === "left") return [1, 0];
      } else if (w > 2) {
        for (const r of lv.grid) side === "left" ? r.shift() : r.pop();
        if (side === "left" && lv.center) lv.center[0] = Math.max(0, lv.center[0] - 1);
        if (side === "left") return [-1, 0];
      }
    }
    return [0, 0];
  }

  function revertLevel() {
    const e = L();
    if (!confirm("Throw away your changes to this level?")) return;
    e.lv = WB.parseLevel(e.text, S.game.terrain);
    e.dirty = false;
    e.undo = []; e.redo = [];
    S.sel = null;
    refreshLevelList(); refreshPanels(); draw();
  }

  function clearLevel() {
    if (!confirm("Replace this map with empty grass? (You can undo this.)")) return;
    pushUndo();
    const lv = lvl();
    for (const row of lv.grid) for (const c of row) { c.t = "."; c.item = -1; }
    lv.inventory = [];
    changed();
  }

  function buildProblems() {
    const box = $("#problems");
    const { errs, warns } = WB.validateLevel(lvl(), S.game);
    box.replaceChildren();
    if (!errs.length && !warns.length) box.append(el("div", { class: "ok" }, "✓ No problems found"));
    for (const e of errs) box.append(el("div", { class: "e" }, "✖ " + e));
    for (const w of warns) box.append(el("div", { class: "w" }, "⚠ " + w));
  }

  // ------------------------------------------------------------------ level list

  function buildLevelList() {
    const box = $("#levelList");
    box.replaceChildren();
    let world = null;
    S.levels.forEach((l, i) => {
      if (l.world !== world) {
        world = l.world;
        box.append(el("div", { class: "world" }, world === 999 ? "Tutorial button map" : `World ${world}`));
      }
      const nm = missionTitle(l) || (l.lv ? l.lv.name : l.title) || l.member;
      box.append(el("button", { class: i === S.cur ? "on" : "", "data-i": i, title: l.member, onclick: () => selectLevel(i) },
        el("span", { class: "num" }, l.world === 999 ? "–" : String(l.mission)),
        el("span", { class: "name" }, titleCase(nm)),
        l.dirty ? el("span", { class: "dirty", title: "Unsaved changes" }) : null));
    });
  }
  function refreshLevelList() { buildLevelList(); }

  // World Builder 1 starts the tutorial when mission 1-1 is opened; editing that level switches it off
  const isFirstMission = (l) => l.world === 1 && l.mission === 1;
  // Mission 1 plays without the tutorial: as chosen on the Game tab, else once mission 1 is edited
  function tutorialOff() {
    if (!S.tutorialHook) return false;
    if (S.patchOn.tutorial != null) return S.patchOn.tutorial;
    const first = S.levels.find(isFirstMission);
    return !S.tutorialHook.enabled || !!(first && first.dirty);
  }
  function tutorialNote(l) {
    if (l.world === 999) return "This map is what the world map's Tutorial button loads. The tutorial points at specific tiles and objects, so changing them can leave its instructions pointing at the wrong place.";
    if (!isFirstMission(l) || !S.tutorialHook) return null;
    if (S.patchOn.tutorial === false) return "This mission runs the tutorial (set on the Game tab). The tutorial points at specific tiles and objects, so edits can leave its instructions pointing at the wrong place.";
    if (tutorialOff()) return "The tutorial is switched off for this mission, so it plays as a normal level (see the Game tab). The world map's Tutorial button still works.";
    return l.dirty
      ? "This mission normally runs the tutorial. Because you've edited it, saving will switch the tutorial off so it plays as a normal level (the player has to reach the goal to complete it). The world map's Tutorial button still works."
      : "This mission normally runs the tutorial. If you edit it, saving will switch the tutorial off so it plays as a normal level.";
  }

  function missionTitle(l) { return S.game.titles.get(`${l.world} ${l.mission}`) || ""; }

  // Titles are one "world mission title" line each in the "level names" text member
  async function setMissionTitle(l, title) {
    title = title.replace(/[\r\n]/g, " ").trim();
    S.game.titles.set(`${l.world} ${l.mission}`, title);
    const base = S.textEdits.has("level names") ? S.textEdits.get("level names") : (await S.movie.text("level names")) || "";
    const lines = base.split("\n");
    const i = lines.findIndex((ln) => { const m = /^\s*(\d+)\s+(\d+)\s/.exec(ln); return m && +m[1] === l.world && +m[2] === l.mission; });
    const line = `${l.world} ${l.mission} ${title}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
    S.textEdits.set("level names", lines.join("\n"));
    buildLevelList();
    setStatus(`Mission title changed (saved with the game file).`);
  }
  function titleCase(s) { return s.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()); }

  // ------------------------------------------------------------------ text tab, import/export

  $("#btnApplyText").addEventListener("click", () => {
    const txt = $("#levelText").value;
    const parsed = WB.parseLevel(txt, S.game.terrain);
    if (!parsed.grid.length) { alert("No map rows found (lines starting with map=)."); return; }
    pushUndo();
    Object.assign(lvl(), parsed);
    changed();
    fitView();
  });
  $("#btnExport").addEventListener("click", async () => {
    const e = L(), text = currentText().replace(/\n/g, "\r\n"), name = `${e.member}.txt`;
    if (!window.native) { download(new Blob([text], { type: "text/plain" }), name); return; }
    const r = await window.native.saveFile({ suggest: besideFile(name), name, ext: "txt", data: new TextEncoder().encode(text) });
    if (r) setStatus(`Exported ${r.name}.`);
  });
  $("#btnImport").addEventListener("click", () => $("#importInput").click());
  $("#importInput").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    ev.target.value = "";
    if (!f) return;
    $("#levelText").value = await f.text();
    $("#btnApplyText").click();
  });

  // ------------------------------------------------------------------ other text members

  function openTexts() {
    const list = $("#textsList");
    const names = S.movie.textMembers().filter((n) => !/^map\d+\.\d+$/.test(n)).sort((a, b) => {
      const pri = (n) => (n === "worlds" ? 0 : n === "config" ? 1 : n === "terrainmap" ? 2 : 3);
      return pri(a) - pri(b) || a.localeCompare(b);
    });
    list.replaceChildren(...names.map((n) => el("option", { value: n }, (S.textEdits.has(n) ? "● " : "") + n)));
    list.onchange = async () => {
      S.textMember = list.value;
      $("#textsEdit").value = S.textEdits.has(list.value) ? S.textEdits.get(list.value) : (await S.movie.text(list.value)) || "";
      $("#textsNote").textContent = list.value === "worlds" ? "Columns: world, mission, missions it unlocks (tab separated)." : "";
    };
    list.value = names[0];
    list.onchange();
    $("#textsDialog").showModal();
  }
  $("#btnTextsApply").addEventListener("click", (e) => {
    e.preventDefault();
    if (!S.textMember) return;
    S.textEdits.set(S.textMember, $("#textsEdit").value);
    const opt = [...$("#textsList").options].find((o) => o.value === S.textMember);
    if (opt) opt.textContent = "● " + S.textMember;
    setStatus(`Changed text "${S.textMember}" (saved with the game file).`);
  });

  // ------------------------------------------------------------------ game patches

  /* Changes the editor can make to the game's own code. Each can be switched on or off on the Game
   * tab; saving adds or takes out each one to match (taking one out restores the original code). */
  const PATCHES = [
    { id: "keys", label: "WASD to scroll, Q to take apart",
      handlers: () => S.keyHandlers, installed: (h) => h.wasd, apply: (h) => S.movie.setWasdControls(h), remove: (h) => S.movie.unsetWasdControls(h) },
    { id: "menu", label: "Esc opens the menu",
      handlers: () => S.keyHandlers, installed: (h) => h.menu, apply: (h) => S.movie.setMenuKey(h), remove: (h) => S.movie.unsetMenuKey(h) },
    { id: "swoop", label: "Fix plan icon getting stuck on pickup",
      handlers: () => S.planSwoops, installed: (h) => h.fixed, apply: (h) => S.movie.fixPlanSwoop(h), remove: (h) => S.movie.unfixPlanSwoop(h) },
    // two changes in one: the level loader reads a deep-water terrain for units and plans, and the
    // game gets a goal shadow for deep water (goals draw one named after their terrain)
    { id: "deep", label: "Objects on deep water",
      handlers: () => [...S.deepWater, ...S.goalShadow], installed: (h) => h.fixed,
      apply: (h) => (h.goalShadow ? S.movie.fixGoalShadow(h) : S.movie.fixDeepWater(h)),
      remove: (h) => (h.goalShadow ? S.movie.unfixGoalShadow(h) : S.movie.unfixDeepWater(h)) },
    { id: "music", label: "Music per level",
      handlers: () => S.levelMusic, installed: (h) => h.fixed, apply: (h) => S.movie.fixLevelMusic(h), remove: (h) => S.movie.unfixLevelMusic(h) },
    { id: "monsterPlans", label: "Monster plans",
      handlers: () => S.monsterPlans, installed: (h) => h.fixed, apply: (h) => S.movie.fixMonsterPlans(h), remove: (h) => S.movie.unfixMonsterPlans(h) },
    { id: "builtMonsterSelect", label: "Built monsters can't be controlled", desc: "A monster built from a plan isn't selected when it's done.",
      handlers: () => S.builtMonsterSelect, installed: (h) => h.fixed, apply: (h) => S.movie.fixBuiltMonsterSelect(h), remove: (h) => S.movie.unfixBuiltMonsterSelect(h) },
    { id: "monsterHealth", label: "Built monsters have inverse health", desc: "Health is 100 minus the energy brick's charge.",
      handlers: () => S.monsterHealth, installed: (h) => h.fixed, apply: (h) => S.movie.fixMonsterHealth(h), remove: (h) => S.movie.unfixMonsterHealth(h) },
    { id: "goalSave", label: "No freeze at goals", desc: "Progress saves when the mission ends instead.",
      handlers: () => S.goalSave, installed: (h) => h.fixed, apply: (h) => S.movie.fixGoalSave(h), remove: (h) => S.movie.unfixGoalSave(h) },
    { id: "whirlpool", label: "Fix whirlpools stuck after take-apart", desc: "Taking a unit apart on a whirlpool no longer blocks the pair.",
      handlers: () => S.whirlpoolFix, installed: (h) => h.fixed, apply: (h) => S.movie.fixWhirlpool(h), remove: (h) => S.movie.unfixWhirlpool(h) },
    { id: "unlockAll", label: "Cheat: unlock all levels", off: true,
      handlers: () => S.unlockAll, installed: (h) => h.fixed, apply: (h) => S.movie.fixUnlockAll(h), remove: (h) => S.movie.unfixUnlockAll(h) },
  ];
  // level checks see the deep-water goal shadow as there when the patch is ticked (it's added on save)
  function syncGoalShadows() {
    S.game.planIcons = new Set(S.planIconsBase);
    for (const h of S.monsterPlans) for (const t of h.targets) {
      if (S.patchOn.monsterPlans) S.game.planIcons.add(t.name);
      else S.game.planIcons.delete(t.name);
    }
    S.game.goalShadows = new Set(S.goalShadowsBase);
    if (S.patchOn.deep && S.goalShadow.length) S.game.goalShadows.add("water_undiggable");
    else if (S.goalShadow.length) S.game.goalShadows.delete("water_undiggable");
  }
  const TUTORIAL_LABEL = "Mission 1 without the tutorial";
  const patchAvailable = (p) => p.handlers().length > 0;
  const patchInstalled = (p) => patchAvailable(p) && p.handlers().every(p.installed);
  const patchesChanged = () => !!S.patchOn && (PATCHES.some((p) => patchAvailable(p) && S.patchOn[p.id] !== patchInstalled(p)) ||
    (S.patchOn.tutorial != null && !!S.tutorialHook && S.patchOn.tutorial === S.tutorialHook.enabled));

  /* Each patch stays as the file has it. A file with none could be an untouched game (which gets
   * every patch but the cheat) or one saved with them all switched off, so that's told apart by the choices
   * last saved for this game. */
  function initPatches() {
    // an older version of a patch (h.old) counts as there: it stays on, and saving updates it
    const present = (p) => p.handlers().some((h) => p.installed(h) || !!h.old);
    const fresh = !PATCHES.some(present);
    let saved = null;
    try { saved = JSON.parse(prefs.get("patches" + S.game.edition)); } catch (e) { /* none saved */ }
    S.patchOn = {};
    for (const p of PATCHES) {
      // partly there (a file from before a patch gained its second half): on, and saving completes it.
      // A patch newer than the choices last saved (not in them) starts as it would on a fresh game.
      const known = saved && p.id in saved;
      const on = fresh ? (known ? saved[p.id] : !p.off) : present(p) || (!known && !p.off);
      S.patchOn[p.id] = patchAvailable(p) && on;
    }
    S.patchOn.tutorial = null; // null: off once mission 1 is edited (tutorialOff)
  }

  function buildGamePanel() {
    const box = $("#tab-game");
    box.replaceChildren(el("div", { class: "panel-title" }, "Game patches"),
      el("p", { class: "muted small" }, "Changes to the game itself, made when you save. Unticking one takes it back out of the game."));
    const row = (label, desc, checked, disabled, onchange) => el("div", { class: "card" },
      el("label", { class: "check", style: "color:var(--text)" }, el("input", { type: "checkbox", checked, disabled, onchange }), " ", el("b", {}, label)),
      desc ? el("div", { class: "meta" }, desc) : null);
    for (const p of PATCHES) {
      const ok = patchAvailable(p);
      box.append(row(p.label, ok ? p.desc : "This game file doesn't have the code this changes.", S.patchOn[p.id], !ok, (ev) => {
        S.patchOn[p.id] = ev.target.checked;
        syncGoalShadows();
        if (p.id === "monsterPlans") buildObjectCats();
        refreshPanels();
      }));
    }
    if (S.tutorialHook) {
      box.append(row(TUTORIAL_LABEL,
        "Turns on by itself when you edit mission 1.",
        tutorialOff(), false, (ev) => { S.patchOn.tutorial = ev.target.checked; refreshPanels(); }));
    }
  }

  // ------------------------------------------------------------------ saving

  function openSave() {
    const dirty = S.levels.filter((l) => l.dirty);
    const issues = [];
    for (const l of dirty) {
      const v = WB.validateLevel(l.lv, S.game);
      if (v.errs.length) issues.push(`World ${l.world} mission ${l.mission}: ${v.errs.join(" ")}`);
    }
    const body = $("#saveBody");
    body.replaceChildren(...[
      S.imported ? el("p", {}, "Imported from ", el("code", {}, S.imported), ".") : null,
      el("p", {}, dirty.length || S.textEdits.size
        ? `Changed: ${dirty.length} level${dirty.length === 1 ? "" : "s"}${S.textEdits.size ? ` and ${S.textEdits.size} text member${S.textEdits.size === 1 ? "" : "s"}` : ""}.`
        : "No levels or texts have changed."),
      patchSummary(),
      issues.length ? el("div", { class: "card" }, el("h4", { style: "color:var(--err)" }, "These levels would break in the game:"), ...issues.map((t) => el("div", { class: "meta" }, t))) : null,
      el("p", {}, ["Save over ", el("code", {}, S.fileName), " in the game folder to play your levels. ",
        el("b", {}, "Export .dcr"), " writes just the movie (", el("code", {}, dcrName()), ", the browser version) without saving ", el("code", {}, S.fileName), "."]),
      el("p", { class: "muted small" }, "Progress (unlocked missions) is kept in the game's Prefs folder and isn't affected."),
    ].filter(Boolean));
    $("#btnDoSave").textContent = `Save ${S.fileName}`;
    $("#btnSaveOther").textContent = `Export ${dcrName()}…`;
    $("#btnDoSave").disabled = $("#btnSaveOther").disabled = issues.length > 0;
    $("#saveDialog").showModal();
  }

  // What saving will change in the game's own code, per the Game tab
  function patchSummary() {
    const add = [], remove = [];
    for (const p of PATCHES) {
      if (!patchAvailable(p) || S.patchOn[p.id] === patchInstalled(p)) continue;
      (S.patchOn[p.id] ? add : remove).push(p.label);
    }
    if (S.tutorialHook && S.tutorialHook.enabled === tutorialOff()) (tutorialOff() ? add : remove).push(TUTORIAL_LABEL);
    if (!add.length && !remove.length) return null;
    return el("p", {}, [add.length ? `Adds: ${add.join(", ")}. ` : "", remove.length ? `Removes: ${remove.join(", ")}.` : ""].join(""));
  }

  const dcrName = () => (S.game && S.game.edition === 2 ? "worldbuilder2.dcr" : "worldbuilder.dcr");

  // Apply pending edits and rebuild the movie (the .dcr bytes)
  async function buildMovie() {
    setStatus("Building game file…");
    for (const l of S.levels) if (l.dirty) await S.movie.setText(l.member, WB.serializeLevel(l.lv, S.game.terrain));
    for (const [name, text] of S.textEdits) await S.movie.setText(name, text);
    if (S.tutorialHook && S.tutorialHook.enabled === tutorialOff()) await S.movie.setTutorialHook(S.tutorialHook, !tutorialOff());
    for (const p of PATCHES) for (const h of p.handlers()) await (S.patchOn[p.id] ? p.apply(h) : p.remove(h));
    return S.movie.save();
  }

  // Path of `name` in the open file's folder (desktop app only)
  const besideFile = (name) => (S.filePath ? S.filePath.replace(/[^/\\]*$/, name) : null);

  // Resolves to false if cancelled; in the desktop app, to { path, name, backup } of the written file
  async function writeFile(bytes, name, exe, suggest) {
    if (window.native) return (await window.native.saveFile({ suggest, name, ext: exe ? "exe" : "dcr", data: bytes })) || false;
    const blob = new Blob([bytes], { type: "application/octet-stream" });
    if (window.showSaveFilePicker) {
      try {
        const type = exe ? { description: "Game launcher", accept: { "application/octet-stream": [".exe"] } }
          : { description: "Shockwave movie", accept: { "application/x-director": [".dcr"] } };
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [type] });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        return true;
      } catch (err) {
        if (err.name === "AbortError") return false;
      }
    }
    download(blob, name);
    return true;
  }

  function markSaved(what, size) {
    for (const l of S.levels) if (l.dirty) { l.text = WB.serializeLevel(l.lv, S.game.terrain); l.dirty = false; }
    S.textEdits.clear();
    S.imported = null;
    for (const p of PATCHES) if (patchAvailable(p)) S.patchOn[p.id] = patchInstalled(p);
    S.patchOn.tutorial = null;
    prefs.set("patches" + S.game.edition, JSON.stringify(Object.fromEntries(PATCHES.map((p) => [p.id, S.patchOn[p.id]]))));
    buildLevelList();
    refreshPanels();
    setStatus(`Saved ${what} (${(size / 1048576).toFixed(2)} MB).`);
  }

  // kind "exe" saves the open Launcher.exe; "dcr" exports just the movie and leaves the edits unsaved
  async function save(kind) {
    try {
      const dcr = await buildMovie();
      const exe = kind === "exe";
      const bytes = exe ? WB.wrapProjector(S.movie.wrapper, dcr) : dcr;
      const name = exe ? S.fileName : dcrName();
      const r = await writeFile(bytes, name, exe, exe ? S.filePath : besideFile(name));
      if (!r) { setStatus(exe ? "Save cancelled." : "Export cancelled."); return; }
      if (exe) markSaved(r.name || name, bytes.length);
      else setStatus(`Exported ${r.name || name} (${(bytes.length / 1048576).toFixed(2)} MB).${unsaved() ? ` ${S.fileName} isn't saved yet.` : ""}`);
      if (r.backup) setStatus(`${$("#statusText").textContent} The original was kept as ${r.backup.replace(/^.*[/\\]/, "")}.`);
    } catch (err) {
      console.error(err);
      alert("Saving failed: " + err.message);
      setStatus("Saving failed: " + err.message);
    }
  }

  $("#btnDoSave").addEventListener("click", (e) => {
    e.preventDefault();
    $("#saveDialog").close();
    save("exe");
  });
  $("#btnSaveOther").addEventListener("click", (e) => {
    e.preventDefault();
    $("#saveDialog").close();
    save("dcr");
  });

  function download(blob, name) {
    const a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ------------------------------------------------------------------ wiring

  function setStatus(t) { $("#statusText").textContent = t; }

  async function pickFile() {
    if (!window.native) { $("#fileInput").click(); return; }
    if (!confirmDiscard()) return;
    const f = await window.native.openFile({ near: S.filePath });
    if (f) openFile(f);
  }
  async function pickDcr() {
    if (!confirmDiscard()) return;
    if (!window.native) { $("#dcrInput").click(); return; }
    const f = await window.native.openFile({ near: S.filePath, dcr: true });
    if (f) importDcr(f);
  }
  $("#btnImport").addEventListener("click", pickDcr);
  $("#dcrInput").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f) importDcr(f);
  });
  $("#btnOpen").addEventListener("click", pickFile);
  $("#btnOpen2").addEventListener("click", pickFile);
  // desktop app: a game file named on the command line
  if (window.native) window.native.startFile().then((f) => f && openFile(f));
  $("#fileInput").addEventListener("change", (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (f && confirmDiscard()) openFile(f);
  });
  const unsaved = () => S.levels.some((l) => l.dirty) || !!(S.textEdits && S.textEdits.size) || !!S.imported || patchesChanged();
  function confirmDiscard() {
    return !unsaved() || confirm("You have unsaved changes. Open another file anyway?");
  }
  window.addEventListener("beforeunload", (e) => {
    if (unsaved()) e.preventDefault();
  });

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    const f = e.dataTransfer.files[0];
    if (!f || (!/\.dcr$/i.test(f.name) && !confirmDiscard())) return;
    const path = window.native && window.native.pathFor(f);
    openFile(path ? { name: f.name, path, arrayBuffer: () => f.arrayBuffer() } : f);
  });

  for (const b of document.querySelectorAll("#toolset button")) b.addEventListener("click", () => setTool(b.dataset.tool));
  for (const b of document.querySelectorAll("#sideTabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
  $("#btnSave").addEventListener("click", openSave);
  $("#btnSaveMini").addEventListener("click", openSave);
  // Map labels use the web font; redraw once it has loaded
  if (document.fonts) document.fonts.ready.then(draw);

  // Collapsible level list, remembered between visits
  function setLevelsCollapsed(on) {
    document.body.classList.toggle("levels-collapsed", on);
    $("#btnLevelsPane").setAttribute("aria-expanded", String(!on));
    try { localStorage.setItem("wbe.levelsCollapsed", on ? "1" : "0"); } catch (e) { /* storage unavailable */ }
  }
  $("#btnLevelsPane").addEventListener("click", () => setLevelsCollapsed(true));
  $("#btnLevelsShow").addEventListener("click", () => setLevelsCollapsed(false));
  try { if (localStorage.getItem("wbe.levelsCollapsed") === "1") setLevelsCollapsed(true); } catch (e) { /* storage unavailable */ }

  // Sidebar width (drag its left edge) and zoom (Shift+wheel over it), remembered between visits
  const app = $("#app"), grip = $("#sideGrip");
  function setSide(width, zoom) {
    if (width != null) app.style.setProperty("--side-w", Math.round(Math.max(220, Math.min(width, window.innerWidth * 0.6))) + "px");
    if (zoom != null) app.style.setProperty("--side-zoom", Math.max(0.6, Math.min(2, Math.round(zoom * 20) / 20)));
    try {
      localStorage.setItem("wbe.sideWidth", app.style.getPropertyValue("--side-w"));
      localStorage.setItem("wbe.sideZoom", app.style.getPropertyValue("--side-zoom"));
    } catch (e) { /* storage unavailable */ }
  }
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add("side-resizing");
  });
  grip.addEventListener("pointermove", (e) => {
    if (document.body.classList.contains("side-resizing")) setSide(app.getBoundingClientRect().right - e.clientX);
  });
  grip.addEventListener("pointerup", () => document.body.classList.remove("side-resizing"));
  grip.addEventListener("dblclick", () => {
    app.style.removeProperty("--side-w");
    app.style.removeProperty("--side-zoom");
    try { localStorage.removeItem("wbe.sideWidth"); localStorage.removeItem("wbe.sideZoom"); } catch (e) { /* storage unavailable */ }
  });
  $("#side").addEventListener("wheel", (e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    // Shift turns the wheel sideways in some browsers
    const d = e.deltaY || e.deltaX;
    const z = parseFloat(getComputedStyle(app).getPropertyValue("--side-zoom")) || 1;
    setSide(null, z * (d < 0 ? 1.1 : 1 / 1.1));
  }, { passive: false });
  try {
    const w = parseFloat(localStorage.getItem("wbe.sideWidth")), z = parseFloat(localStorage.getItem("wbe.sideZoom"));
    setSide(w || null, z || null);
  } catch (e) { /* storage unavailable */ }
  $("#zoomLabel").addEventListener("click", () => {
    const r = canvas.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, 1 / S.view.zoom);
    // land exactly on 1:1 pixels so sprites look as sharp as in the game
    S.view.zoom = S.zoom = 1;
    prefs.set("zoom", 1);
    S.view.x = Math.round(S.view.x);
    S.view.y = Math.round(S.view.y);
    draw();
  });
  $("#btnZoomIn").addEventListener("click", () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); });
  $("#btnZoomOut").addEventListener("click", () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 0.8); });
  new ResizeObserver(resizeCanvas).observe($("#canvasWrap"));
  setTool("paint");

  if (!("DecompressionStream" in window)) {
    setStatus("This browser is too old: it lacks DecompressionStream. Use a current Chrome, Edge, Firefox or Safari.");
  }
})();
