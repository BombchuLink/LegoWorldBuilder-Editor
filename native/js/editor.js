/* The native editor's side of the JS: opens a game with wbcore.js and describes its maps with
 * scene.js, in a form the C++ front end reads quickly (numbers in a Float64Array, strings in a
 * table). Global NE. */
(function (root) {
  "use strict";
  const WB = root.WB, WBScene = root.WBScene;

  // Patches whose additions show up on the map, and the rest, found in loadMovie's order (app.js)
  const FINDS = [
    ["tutorialHook", "findTutorialHook"], ["keyHandlers", "findKeyHandlers"], ["planSwoops", "findPlanSwoop"],
    ["deepWater", "findDeepWater"], ["levelMusic", "findLevelMusic"], ["goalSave", "findGoalSave"],
    ["whirlpoolFix", "findWhirlpoolFix"], ["builtMonsterSelect", "findBuiltMonsterSelect"], ["unlockAll", "findUnlockAll"],
    ["goalShadow", "findGoalShadow"], ["monsterPlans", "findMonsterPlans"], ["monsterHealth", "findMonsterHealth"],
    ["monsterArt", "findMonsterArt"],
  ];

  const S = { movie: null, game: null, levels: [], scene: null, info: new Map(), pending: new Set(), monsterArtMembers: new Set(), planIcons: new Map() };

  async function open(bytes) {
    const movie = await WB.openMovie(bytes);
    if (!movie.wrapper) throw new Error("That isn't a game launcher. Open Launcher.exe from a World Builder game folder.");
    const game = await movie.loadGame();
    if (!game.levels.length) throw new Error("This movie has no WorldBuilder levels in it.");
    const P = {};
    for (const [k, fn] of FINDS) P[k] = await movie[fn]();
    // As the editor starts a file without saved choices (initPatches): each patch as the file has it,
    // or all of them (but the cheat) on a game that has none yet
    const present = (hs, inst) => hs.some((h) => inst(h) || !!h.old);
    const fixed = (h) => h.fixed;
    const fresh = ![
      present(P.keyHandlers, (h) => h.wasd), present(P.keyHandlers, (h) => h.menu),
      ...["planSwoops", "levelMusic", "goalSave", "whirlpoolFix", "builtMonsterSelect", "unlockAll", "monsterPlans", "monsterHealth", "monsterArt"].map((k) => present(P[k], fixed)),
      present([...P.deepWater, ...P.goalShadow], fixed),
    ].some(Boolean);
    const on = (hs) => hs.length > 0 && (fresh || present(hs, fixed));
    Object.assign(S, { movie, game, info: new Map(), pending: new Set() });
    S.patchOn = { monsterArt: on(P.monsterArt), monsterPlans: on(P.monsterPlans), deep: on([...P.deepWater, ...P.goalShadow]) };
    S.monsterArtMembers = new Set(P.monsterArt.flatMap((h) => h.targets.map((t) => t.member)));
    S.planIcons = new Map();
    for (const h of P.monsterPlans) for (const t of h.targets) S.planIcons.set(t.member, t);
    // what a ticked patch adds counts as there (syncGoalShadows)
    for (const h of P.monsterArt) for (const n of h.monsters) if (S.patchOn.monsterArt) game.placeable.monster.add(n);
    for (const h of P.monsterPlans) for (const t of h.targets) if (S.patchOn.monsterPlans) game.planIcons.add(t.name);
    S.levels = game.levels.map((l) => ({ ...l, lv: null }));
    S.scene = WBScene.create({
      game,
      sprite: (name) => { const v = S.info.get(name); if (v === undefined) S.pending.add(name); return v || null; },
      hasSprite,
      planIcon: (s) => (S.planIcons.has(s) ? S.patchOn.monsterPlans : hasSprite(s)),
      showGrid: () => S.showGrid,
    });
    S.showGrid = true;
    return { edition: game.edition, levels: S.levels.map((l) => [l.world, l.mission, game.titles.get(`${l.world} ${l.mission}`) || l.title || l.member, l.member]) };
  }

  function hasSprite(name) {
    if (S.monsterArtMembers.has(name)) return !!S.patchOn.monsterArt;
    const m = S.movie.byName.get(name);
    return !!m && m.type === 1;
  }

  const level = (i) => {
    const e = S.levels[i];
    if (!e.lv) e.lv = WB.parseLevel(e.text, S.game.terrain);
    return e.lv;
  };

  // [width, height] in tiles
  function size(i) { const lv = level(i); return [lv.grid.length ? lv.grid[0].length : 0, lv.grid.length]; }

  /* The whole map as {nums: Float64Array, strs}: 10 numbers per command (string fields are indices
   * into strs, -1 for none):
   *   0 img   name x y            1 imgs  name x y w h
   *   2 badge text x y bg fg outline
   *   3 face  tx ty inset fill stroke lineWidth screenPx dashOn dashOff
   *   4 alpha a
   * Sprites it needed that aren't loaded yet are left out (or replaced as the editor does); after
   * loadPending() the scene is worth asking for again. */
  function scene(i, showGrid) {
    S.showGrid = !!showGrid;
    const cmds = S.scene.map(level(i));
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
      }
    });
    return { nums, strs };
  }

  const hasPending = () => S.pending.size > 0;

  // Decode the sprites the last scene asked for: [[name, w, h, regX, regY, rgba]] (rgba null if the
  // game has no such bitmap). The editor keeps only their sizes; the pixels go to the caller.
  async function loadPending() {
    const out = [];
    for (const name of [...S.pending]) {
      S.pending.delete(name);
      let bm = await S.movie.bitmap(name);
      if (!bm && S.monsterArtMembers.has(name)) bm = WB.wb1MonsterSprite(name);
      if (!bm && S.planIcons.has(name)) { const ic = S.planIcons.get(name).icon; bm = { ...ic, rgba: new Uint8ClampedArray(ic.rgba) }; }
      S.info.set(name, bm ? { w: bm.w, h: bm.h, regX: bm.regX, regY: bm.regY } : null);
      out.push([name, bm ? bm.w : 0, bm ? bm.h : 0, bm ? bm.regX : 0, bm ? bm.regY : 0, bm ? new Uint8Array(bm.rgba.buffer, bm.rgba.byteOffset, bm.rgba.length) : null]);
    }
    return out;
  }

  const label = (i, x, y) => S.scene.cellLabel(level(i), x, y);
  // [x, y] tile under a screen point
  const cellAt = (vx, vy, zoom, sx, sy) => WBScene.screenToCell({ x: vx, y: vy, zoom }, sx, sy);
  // [x, y, zoom] that fits level i in a width×height window (zoom > 0 keeps that zoom)
  function fit(i, width, height, zoom) {
    const [w, h] = size(i);
    const v = WBScene.fitView(w, h, width, height, zoom > 0 ? zoom : null);
    return [v.x, v.y, v.zoom];
  }
  // [left, top, right, bottom (tiles), centerX, centerY (tile, 0-based), hasCenter]
  function startView(i) {
    const lv = level(i), [w, h] = size(i);
    const { left, top, c } = WBScene.startViewRect(lv, w, h);
    return [left, top, Math.min(w, left + WBScene.VIEW_W), Math.min(h, top + WBScene.VIEW_H), c[0] - 1, c[1] - 1, lv.center ? 1 : 0];
  }

  root.NE = { open, size, scene, hasPending, loadPending, label, cellAt, fit, startView };
})(typeof self !== "undefined" ? self : this);
