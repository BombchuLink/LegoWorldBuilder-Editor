/* The editing rules (used by native/js/editor.js, kept free of any UI so they can be tested on
 * their own): what the brush puts down and what can stand where, moving, filling, copying and pasting tiles,
 * resizing a map, a level's music and mission title, the game patches, and building the movie to
 * save. No DOM; needs wbcore.js (WB).
 *
 * WBEdit.create(S, hooks) works on the editor's state S, read afresh at every call:
 *   S.game, S.movie, S.scene (scene.js), S.levels ([{world, mission, member, text, lv, dirty}]),
 *   S.textEdits (Map of changed text members), S.patchOn (the Game tab's choices),
 *   the brush: S.brush ({kind: "terrain", char} or {kind: "object", type, cls, name, goal, ground}),
 *   S.planCount, S.pileDraft ([[resource, n]]), S.goalTarget, S.whirlId,
 *   and what loadFinds() stores (S.deepWater, S.tutorialHook, S.monsterPlans...).
 * hooks.status(text) shows a message in the status bar. */
(function (root) {
  "use strict";
  const WB = root.WB || (typeof require !== "undefined" && require("./wbcore.js"));

  // The patch finders, in the order the editor runs them when it opens a game
  const FINDS = [
    ["tutorialHook", "findTutorialHook"], ["keyHandlers", "findKeyHandlers"], ["planSwoops", "findPlanSwoop"],
    // units and plans can only start on deep water when the level loader can be (or is) fixed
    ["deepWater", "findDeepWater"],
    // levels can pick their music once mission start is fixed to read it
    ["levelMusic", "findLevelMusic"],
    // reaching a goal saves progress mid-game and freezes it; the fix saves when the mission ends
    ["goalSave", "findGoalSave"],
    // a unit taken apart on a whirlpool after teleporting leaves the pair blocked for good
    ["whirlpoolFix", "findWhirlpoolFix"],
    // a monster built from a plan comes out selected, so it can be driven like a vehicle
    ["builtMonsterSelect", "findBuiltMonsterSelect"], ["unlockAll", "findUnlockAll"],
    // goals draw a shadow named after their terrain; deep water has none until the patch adds it
    ["goalShadow", "findGoalShadow"],
    // monsters get plans once the game has their plans-bar icons; the editor shows them from the start
    ["monsterPlans", "findMonsterPlans"], ["monsterHealth", "findMonsterHealth"],
    // WB2's T Rex and scorpion can be placed once the patch gives them their WB1 artwork
    ["monsterArt", "findMonsterArt"],
  ];

  // Object palette categories; boulders are "monsters" to the game but act as obstacles, so they live under Misc
  const CATS = [["model", "Models"], ["monster", "Monsters"], ["plan", "Plans"], ["misc", "Misc"]];
  // volcano looks exactly like mountain but has no minimap icon, and no level uses it
  const HIDDEN_TERRAIN = new Set(["volcano"]);

  // The in-game tracks' names; any other track shows as "Track <letter>"
  const TRACK_NAMES = {
    music_game_a: "Blue And Green Makes...", music_game_i: "Joy of Bricks",
    music_game_6: "Sly Solutions", music_game_8: "Brain Builder",
  };
  const trackName = (t) => TRACK_NAMES[t] || "Track " + t.replace(/^music_game_/, "").toUpperCase();
  const MUSIC_LINE = /^music\s*=\s*(.*)$/i;
  const TUTORIAL_LABEL = "Mission 1 without the tutorial";

  const titleCase = (s) => s.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
  const partsKey = (p) => p.join(",");
  const baseOf = (p) => p[0].replace(/^water/, "");

  function create(S, hooks = {}) {
    const status = (t) => hooks.status && hooks.status(t);
    const game = () => S.game;
    const displayName = (n) => S.scene.displayName(n);

    // ---------------------------------------------------------------- what the game has

    async function loadFinds() {
      for (const [k, fn] of FINDS) S[k] = await S.movie[fn]();
      const g = game();
      S.goalShadowsBase = new Set(g.goalShadows);
      S.monsterArtMembers = new Set(S.monsterArt.flatMap((h) => h.targets.map((t) => t.member)));
      S.placeableMonstersBase = new Set(g.placeable.monster);
      S.planIconsBase = new Set(g.planIcons);
      // member -> monster plan target (its icon is added to the game on save)
      S.monsterPlanIcons = new Map();
      for (const h of S.monsterPlans) for (const t of h.targets) S.monsterPlanIcons.set(t.member, t);
    }

    function placeable(cls) { return (game().units[cls] || []).filter((n) => game().placeable[cls].has(n)); }
    function unitClassOf(name) {
      for (const cls of ["vehicle", "building", "monster"]) if ((game().units[cls] || []).includes(name)) return cls;
      return "vehicle";
    }
    // Models a plan can be for: vehicles, buildings and (with their icons) monsters, never the boulder
    function planModels() {
      return [...placeable("vehicle"), ...placeable("building"), ...placeable("monster").filter((n) => n !== "boulder")].filter((n) => S.scene.planSpriteName(n));
    }
    function unitTooltip(cls, n) {
      if (n === "boulder") return "I rock!";
      const c = game().config[cls] && game().config[cls][n];
      let t = displayName(n);
      if (c) {
        if (c.recipe) t += "\nRecipe: " + S.scene.recipeText(c.recipe);
        if (c.terrain) t += "\nTerrain: " + [].concat(c.terrain).join(", ");
      }
      return t;
    }
    const isBoulder = (o) => o.type === "unit" && o.cls === "monster" && o.name === "boulder";
    function categoryOf(o) {
      if (o.type === "plan") return "plan";
      if (o.type !== "unit" || isBoulder(o)) return "misc";
      return o.cls === "monster" ? "monster" : "model";
    }
    // Terrain swatches: [char, terrain name]
    const terrainPalette = () => Object.entries(game().terrain).filter(([, t]) => !HIDDEN_TERRAIN.has(t));
    /* The object swatches of a category: [{o (brush object), sprite, label, title}], and a note to
     * show above them (or null) */
    function objectPalette(cat) {
      const out = [];
      const add = (o, sprite, label, title) => out.push({ o, sprite, label, title });
      const addUnit = (cls, n) => add({ type: "unit", cls, name: n },
        S.scene.unitSpriteName(cls, n, false) || S.scene.unitSpriteName(cls, n, true), displayName(n), unitTooltip(cls, n));
      let note = null;
      if (cat === "model") {
        for (const cls of ["vehicle", "building"]) for (const n of placeable(cls)) addUnit(cls, n);
      } else if (cat === "monster") {
        for (const n of placeable("monster")) if (n !== "boulder") addUnit("monster", n);
      } else if (cat === "plan") {
        if (S.monsterPlans.length && !S.patchOn.monsterPlans) note = "Plans for monsters: switch on the Monster plans patch on the Game tab.";
        for (const n of planModels()) {
          const recipe = S.scene.recipeOf(n);
          add({ type: "plan", name: n }, S.scene.planSpriteName(n), displayName(n), recipe ? S.scene.recipeText(recipe) : displayName(n));
        }
      } else if (cat === "misc") {
        add({ type: "pile" }, "resource.yellow.4", "Brick pile", "A pile of bricks (set its contents below)");
        if (placeable("monster").includes("boulder")) addUnit("monster", "boulder");
        add({ type: "goal", goal: "goal" }, "goal.goal", "Mission goal", "Mission goal: bring the required model here");
        add({ type: "goal", goal: "bonusgoal" }, "goal.bonus", "Bonus goal", "Bonus goal: optional harder target");
        add({ type: "whirlpool" }, "terrain.water_whirlpool", "Whirlpool", "Whirlpools teleport water units; place two with the same number");
      }
      return { items: out, note };
    }
    function brushId(b) {
      if (b.kind === "terrain") return "t:" + b.char;
      return ["o", b.type, b.cls || "", b.name || "", b.goal || ""].join(":");
    }
    // The heading over the brush options, e.g. "Plan: Buggy on Water"
    function brushTitle(b) {
      const what = { plan: () => `Plan: ${displayName(b.name)}`, pile: () => "Brick pile", whirlpool: () => "Whirlpool",
        goal: () => (b.goal === "goal" ? "Mission goal" : "Bonus goal"), unit: () => displayName(b.name) }[b.type];
      const g = groundName(b);
      return `Placing: ${what ? what() : "object"}${g ? " on " + g : ""}`;
    }
    const groundName = (b) => b.ground && (WB.TERRAIN_LABELS[game().terrain[b.ground]] || game().terrain[b.ground]);
    const terrainLabel = (ch) => { const t = game().terrain[ch]; return WB.TERRAIN_LABELS[t] || t || ch; };

    /* What a goal can need: [value, label, group] for any model, a particular vehicle, building or
     * monster, plus the target given if the list doesn't know it */
    function goalTargets(value) {
      const out = [["anything", "Anything", ""]];
      for (const [cls, group] of [["vehicle", "Vehicles"], ["building", "Buildings"], ["monster", "Monsters & animals"]]) {
        for (const n of placeable(cls)) out.push([n, displayName(n), group]);
      }
      if (value && !/^collect\s/.test(value) && !out.some((o) => o[0] === value)) out.push([value, value, "Other"]);
      return out;
    }
    const parseCollect = (v) => { const m = /^collect\s+(\d+)\s+(\w+)$/.exec(v || ""); return m ? { n: +m[1], monster: m[2] } : null; };
    function goalObjective(target) {
      if (!target || target === "anything") return "Anything";
      const c = parseCollect(target);
      if (c) return `Collect ${c.n} ${displayName(c.monster)}`;
      return displayName(target);
    }

    // ---------------------------------------------------------------- tiles and objects

    function itemIndexFor(lv, parts) {
      const k = partsKey(parts);
      let i = lv.items.findIndex((it) => partsKey(it.parts) === k);
      if (i < 0) { lv.items.push({ key: "", parts: parts.slice() }); i = lv.items.length - 1; }
      return i;
    }
    function withWater(parts, water) {
      const p = parts.slice();
      const base = baseOf(p);
      if (base === "unit" || base === "plan") p.length = 3; // drops a deep-water terrain
      if (["unit", "plan", "pile"].includes(base)) p[0] = (water ? "water" : "") + base;
      else if (base === "goal" || base === "bonusgoal") {
        p.length = Math.min(p.length, 2);
        if (water) p.push("water");
      }
      return p;
    }
    function isWaterChar(c) { return WB.isWaterTerrain(game().terrain[c]); }
    function terrainChar(name) { return Object.keys(game().terrain).find((k) => game().terrain[k] === name); }
    // the terrain character under an object
    function groundChar(parts) { return terrainChar(WB.itemTerrain(parts)) ?? (WB.itemIsWater(parts) ? "w" : "."); }

    /* The version of an object that can stand on terrain ch, or null if the game doesn't allow it:
     * goals store any terrain but holes, units, plans and piles have a land and a water version
     * (units only where they can go; swimmers that can use deep water, and plans, can also have
     * deep water as a fourth field, which the readmap fix makes the game read), whirlpools need
     * plain water. */
    const canStartDeep = (kind) => S.patchOn.deep && S.deepWater.some((h) => kind in h.kinds);
    function partsOn(p, ch) {
      const t = game().terrain[ch];
      const base = baseOf(p);
      if (base === "goal" || base === "bonusgoal") return t === "hole" ? null : t === "normal" || !t ? p.slice(0, 2) : [...p.slice(0, 2), t];
      if (base === "whirlpool") return t === "water" ? p : null;
      if (base === "unit") {
        if (t === "normal") return WB.unitCanUse(game(), p[1], p[2], false) ? ["unit", p[1], p[2]] : null;
        if (t === "water") return WB.unitCanUse(game(), p[1], p[2], true) ? ["waterunit", p[1], p[2]] : null;
        const deep = WB.isWaterTerrain(t) && canStartDeep("waterunit") && WB.unitTerrains(game(), p[1], p[2]).includes(t);
        return deep ? ["waterunit", p[1], p[2], t] : null;
      }
      if (base === "plan" && t === "water_undiggable" && canStartDeep("waterplan")) return ["waterplan", p[1], p[2], t];
      if (t === "normal" || t === "water") return withWater(p, t === "water");
      return null;
    }

    // What the brush would put down on a land or water tile
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
    // What the brush ghost under the mouse shows on tile x, y (null: nothing)
    function ghostParts(lv, x, y) {
      const b = S.brush, c = lv.grid[y][x];
      if (b.kind !== "object") return null;
      const water = b.ground ? b.ground === "w" : c.item >= 0 ? WB.itemIsWater(lv.items[c.item].parts) : isWaterChar(c.t);
      return brushParts(water);
    }

    // Terrain paints under objects too (see setCellTerrain); an object brush leaves existing
    // objects alone: click one to select it, Alt/Ctrl+click to replace it, right-click to delete it
    function applyBrush(lv, x, y) {
      if (S.brush.kind === "terrain") return setCellTerrain(lv, x, y, S.brush.char);
      const c = lv.grid[y] && lv.grid[y][x];
      if (!c || c.item >= 0) return false;
      const before = c.t + ":" + c.item;
      if (S.brush.kind === "object") {
        // An eyedropped object keeps the ground it was picked from; otherwise it follows the tile,
        // and where it can't stand there the tile becomes grass or water under it
        const ch = S.brush.ground || c.t;
        const raw = brushParts(isWaterChar(ch));
        const parts = partsOn(raw, ch) || raw;
        c.item = itemIndexFor(lv, parts);
        c.t = groundChar(parts);
      }
      return before !== c.t + ":" + c.item;
    }

    /* Set the ground of one tile (terrain brush, Tile tab), keeping its object where the game allows
     * (see partsOn) and removing it otherwise. Returns whether the tile changed. */
    function setCellTerrain(lv, x, y, ch) {
      const c = lv.grid[y] && lv.grid[y][x];
      if (!c) return false;
      const before = c.t + ":" + c.item;
      const t = game().terrain[ch];
      if (c.item >= 0) {
        const p = lv.items[c.item].parts;
        const keep = partsOn(p, ch);
        if (keep) c.item = itemIndexFor(lv, keep);
        else {
          c.item = -1;
          status(`Removed ${S.scene.describeParts(p)}: it can't be on ${(WB.TERRAIN_LABELS[t] || t || ch).toLowerCase()}.`);
        }
      }
      c.t = ch;
      // the billboard's artwork spills over the tile to its left; a hole there (as in the game's
      // own levels) keeps units from driving through it
      let left = false;
      if (t === "billboard" && x > 0 && terrainChar("hole") && lv.grid[y][x - 1].t !== terrainChar("hole")) {
        left = setCellTerrain(lv, x - 1, y, terrainChar("hole"));
      }
      return left || before !== c.t + ":" + c.item;
    }

    // Moving an object: it takes the land or water version that suits its new tile;
    // an object already on that tile swaps places with it.
    function movedParts(lv, from, to) {
      const a = lv.grid[from[1]][from[0]], b = lv.grid[to[1]][to[0]];
      return [partsOn(lv.items[a.item].parts, b.t), b.item >= 0 ? partsOn(lv.items[b.item].parts, a.t) : null];
    }
    const inMap = (lv, x, y) => !!lv && y >= 0 && y < lv.grid.length && x >= 0 && x < lv.grid[0].length;
    function canMove(lv, from, to) {
      if (!inMap(lv, ...to) || String(from) === String(to)) return false;
      const b = lv.grid[to[1]][to[0]];
      const [pa, pb] = movedParts(lv, from, to);
      return !!pa && (b.item < 0 || !!pb);
    }
    function moveObject(lv, from, to) {
      const a = lv.grid[from[1]][from[0]], b = lv.grid[to[1]][to[0]];
      const [pa, pb] = movedParts(lv, from, to);
      const put = (cell, parts) => { cell.item = itemIndexFor(lv, parts); cell.t = groundChar(parts); };
      put(b, pa);
      if (pb) put(a, pb); else a.item = -1;
    }

    // Swap the object on a tile for the brush (Alt/Ctrl+click, Fill): a terrain brush clears the object
    function replaceAt(lv, x, y) {
      const c = lv.grid[y] && lv.grid[y][x];
      if (!c || c.item < 0) return false;
      if (S.brush.kind === "terrain") { c.item = -1; c.t = S.brush.char; return true; }
      const ch = S.brush.ground || groundChar(lv.items[c.item].parts);
      const raw = brushParts(isWaterChar(ch));
      const parts = partsOn(raw, ch) || raw;
      const before = c.item;
      c.item = itemIndexFor(lv, parts);
      c.t = groundChar(parts);
      return before !== c.item;
    }

    function eraseAt(lv, x, y) {
      const c = lv.grid[y] && lv.grid[y][x];
      if (!c || c.item < 0) return false;
      c.item = -1;
      return true;
    }

    function floodFill(lv, x, y) {
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
      let any = false;
      for (const [cx, cy] of region) if (target != null ? replaceAt(lv, cx, cy) : applyBrush(lv, cx, cy)) any = true;
      return any;
    }

    // Brush over a rectangle (Shift+drag with the Brush)
    function fillRect(lv, x0, y0, x1, y1) {
      let any = false;
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        if (inMap(lv, x, y) && applyBrush(lv, x, y)) any = true;
      }
      return any;
    }

    // Select tool: copy a rectangle of tiles with their objects ({w, h, cells}), then place copies
    // of it (the given tile takes the copy's top-left corner; anything already there is replaced)
    function copyArea(lv, x0, y0, x1, y1) {
      [x0, x1] = [Math.max(0, Math.min(x0, x1)), Math.min(lv.grid[0].length - 1, Math.max(x0, x1))];
      [y0, y1] = [Math.max(0, Math.min(y0, y1)), Math.min(lv.grid.length - 1, Math.max(y0, y1))];
      const cells = [];
      for (let y = y0; y <= y1; y++) {
        cells.push(lv.grid[y].slice(x0, x1 + 1).map((c) => ({ t: c.t, parts: c.item >= 0 ? lv.items[c.item].parts.slice() : null })));
      }
      return { w: x1 - x0 + 1, h: y1 - y0 + 1, cells };
    }
    function pasteAt(lv, clip, x, y) {
      let any = false;
      clip.cells.forEach((row, j) => row.forEach((src, i) => {
        if (!inMap(lv, x + i, y + j)) return;
        const c = lv.grid[y + j][x + i], before = c.t + ":" + c.item;
        c.t = src.t;
        c.item = src.parts ? itemIndexFor(lv, src.parts) : -1;
        if (before !== c.t + ":" + c.item) any = true;
      }));
      return any;
    }

    /* The brush the eyedropper picks from a tile: {kind: "terrain", char} or {kind: "object", ...};
     * picking an object also sets its settings (plan uses, pile, goal target, whirlpool number) */
    function pickAt(lv, x, y) {
      const c = lv.grid[y][x];
      if (c.item < 0) return { kind: "terrain", char: c.t };
      const p = lv.items[c.item].parts;
      const base = baseOf(p);
      // Pick up the ground under the object too (always grass or water), so both get placed
      const ground = groundChar(p);
      if (base === "unit") return { kind: "object", type: "unit", cls: p[1], name: p[2], ground };
      if (base === "plan") { S.planCount = +p[2] || 1; return { kind: "object", type: "plan", name: p[1], ground }; }
      if (base === "pile") {
        const d = [];
        for (let i = 1; i + 1 < p.length; i += 2) d.push([p[i], +p[i + 1] || 1]);
        S.pileDraft = d;
        return { kind: "object", type: "pile", ground };
      }
      if (base === "goal" || base === "bonusgoal") { S.goalTarget = p[1]; return { kind: "object", type: "goal", goal: base, ground }; }
      if (base === "whirlpool") { S.whirlId = p[1]; return { kind: "object", type: "whirlpool" }; }
      return null;
    }
    // The bricks a model's recipe needs, as pile rows ([[resource, n]]), or null if the game has none
    function recipeRows(name) {
      const cfg = game().config[unitClassOf(name)] && game().config[unitClassOf(name)][name];
      const rows = Object.entries((cfg && cfg.recipe) || {}).filter(([res, n]) => game().resources.includes(res) && +n > 0);
      return rows.length ? rows.map(([res, n]) => [res, +n]) : null;
    }
    const isPlanAt = (lv, x, y) => { const c = lv.grid[y][x]; return c.item >= 0 && baseOf(lv.items[c.item].parts) === "plan"; };

    /* Add (delta 1) or remove (-1) a row or column on one side, filling new tiles with fillChar.
     * Returns how far the old cells moved in the grid, [dx, dy] (nonzero only for the top/left edge). */
    function resizeMap(lv, side, delta, fillChar) {
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

    // Everything but the name: empty grass, no starting plans
    function clearMap(lv) {
      for (const row of lv.grid) for (const c of row) { c.t = "."; c.item = -1; }
      lv.inventory = [];
    }

    // ---------------------------------------------------------------- the Level tab

    function levelMusic(lv) {
      const m = lv.mapExtra.map((l) => MUSIC_LINE.exec(l)).find(Boolean);
      return m ? m[1].trim() : "";
    }
    // a "music=" line in [map], which the game reads once its mission start is fixed (on save)
    function setLevelMusic(lv, track) {
      lv.mapExtra = lv.mapExtra.filter((l) => !MUSIC_LINE.test(l));
      if (track) lv.mapExtra.push("music=" + track);
    }

    function missionTitle(l) { return game().titles.get(`${l.world} ${l.mission}`) || ""; }
    // The level list's name for a level
    const listName = (l) => titleCase(missionTitle(l) || (l.lv ? l.lv.name : l.title) || l.member);
    // Titles are one "world mission title" line each in the "level names" text member
    async function setMissionTitle(l, title) {
      title = title.replace(/[\r\n]/g, " ").trim();
      game().titles.set(`${l.world} ${l.mission}`, title);
      const base = S.textEdits.has("level names") ? S.textEdits.get("level names") : (await S.movie.text("level names")) || "";
      const lines = base.split("\n");
      const i = lines.findIndex((ln) => { const m = /^\s*(\d+)\s+(\d+)\s/.exec(ln); return m && +m[1] === l.world && +m[2] === l.mission; });
      const line = `${l.world} ${l.mission} ${title}`;
      if (i >= 0) lines[i] = line; else lines.push(line);
      S.textEdits.set("level names", lines.join("\n"));
    }

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

    // The level as the game reads it
    function levelText(l) {
      if (!l.dirty) return l.text;
      if (!l.textCache) l.textCache = WB.serializeLevel(l.lv, game().terrain);
      return l.textCache;
    }

    // Text members for the "Edit game texts" list: mission unlocks, unit settings first, no maps
    function otherTexts() {
      return S.movie.textMembers().filter((n) => !/^map\d+\.\d+$/.test(n)).sort((a, b) => {
        const pri = (n) => (n === "worlds" ? 0 : n === "config" ? 1 : n === "terrainmap" ? 2 : 3);
        return pri(a) - pri(b) || a.localeCompare(b);
      });
    }
    async function textOf(name) { return S.textEdits.has(name) ? S.textEdits.get(name) : (await S.movie.text(name)) || ""; }

    // ---------------------------------------------------------------- game patches

    /* Changes the editor can make to the game's own code. Each can be switched on or off on the Game
     * tab; saving adds or takes out each one to match (taking one out restores the original code). */
    const M = () => S.movie;
    const PATCHES = [
      { id: "keys", label: "WASD to scroll, Q to take apart",
        handlers: () => S.keyHandlers, installed: (h) => h.wasd, apply: (h) => M().setWasdControls(h), remove: (h) => M().unsetWasdControls(h) },
      { id: "menu", label: "Esc opens the menu",
        handlers: () => S.keyHandlers, installed: (h) => h.menu, apply: (h) => M().setMenuKey(h), remove: (h) => M().unsetMenuKey(h) },
      { id: "swoop", label: "Fix plan icon getting stuck on pickup",
        handlers: () => S.planSwoops, installed: (h) => h.fixed, apply: (h) => M().fixPlanSwoop(h), remove: (h) => M().unfixPlanSwoop(h) },
      // two changes in one: the level loader reads a deep-water terrain for units and plans, and the
      // game gets a goal shadow for deep water (goals draw one named after their terrain)
      { id: "deep", label: "Objects on deep water",
        handlers: () => [...S.deepWater, ...S.goalShadow], installed: (h) => h.fixed,
        apply: (h) => (h.goalShadow ? M().fixGoalShadow(h) : M().fixDeepWater(h)),
        remove: (h) => (h.goalShadow ? M().unfixGoalShadow(h) : M().unfixDeepWater(h)) },
      { id: "music", label: "Music per level",
        handlers: () => S.levelMusic, installed: (h) => h.fixed, apply: (h) => M().fixLevelMusic(h), remove: (h) => M().unfixLevelMusic(h) },
      { id: "monsterArt", label: "T Rex and scorpion", desc: "Adds their animations from World Builder 1, so levels and plans can use them.",
        handlers: () => S.monsterArt, installed: (h) => h.fixed, apply: (h) => M().fixMonsterArt(h), remove: (h) => M().unfixMonsterArt(h) },
      { id: "monsterPlans", label: "Monster plans",
        handlers: () => S.monsterPlans, installed: (h) => h.fixed, apply: (h) => M().fixMonsterPlans(h), remove: (h) => M().unfixMonsterPlans(h) },
      { id: "builtMonsterSelect", label: "Built monsters can't be controlled", desc: "A monster built from a plan isn't selected when it's done.",
        handlers: () => S.builtMonsterSelect, installed: (h) => h.fixed, apply: (h) => M().fixBuiltMonsterSelect(h), remove: (h) => M().unfixBuiltMonsterSelect(h) },
      { id: "monsterHealth", label: "Built monsters have inverse health", desc: "Health is 100 minus the energy brick's charge.",
        handlers: () => S.monsterHealth, installed: (h) => h.fixed, apply: (h) => M().fixMonsterHealth(h), remove: (h) => M().unfixMonsterHealth(h) },
      { id: "goalSave", label: "No freeze at goals", desc: "Progress saves when the mission ends instead.",
        handlers: () => S.goalSave, installed: (h) => h.fixed, apply: (h) => M().fixGoalSave(h), remove: (h) => M().unfixGoalSave(h) },
      { id: "whirlpool", label: "Fix whirlpools stuck after take-apart", desc: "Taking a unit apart on a whirlpool no longer blocks the pair.",
        handlers: () => S.whirlpoolFix, installed: (h) => h.fixed, apply: (h) => M().fixWhirlpool(h), remove: (h) => M().unfixWhirlpool(h) },
      { id: "unlockAll", label: "Cheat: unlock all levels", off: true,
        handlers: () => S.unlockAll, installed: (h) => h.fixed, apply: (h) => M().fixUnlockAll(h), remove: (h) => M().unfixUnlockAll(h) },
    ];
    const patchAvailable = (p) => p.handlers().length > 0;
    const patchInstalled = (p) => patchAvailable(p) && p.handlers().every(p.installed);
    const patchesChanged = () => !!S.patchOn && (PATCHES.some((p) => patchAvailable(p) && S.patchOn[p.id] !== patchInstalled(p)) ||
      (S.patchOn.tutorial != null && !!S.tutorialHook && S.patchOn.tutorial === S.tutorialHook.enabled));

    /* Each patch stays as the file has it. A file with none could be an untouched game (which gets
     * every patch but the cheat) or one saved with them all switched off, so that's told apart by the
     * choices last saved for this game (saved: {id: on}, or null). */
    function initPatches(saved) {
      // an older version of a patch (h.old) counts as there: it stays on, and saving updates it
      const present = (p) => p.handlers().some((h) => p.installed(h) || !!h.old);
      const fresh = !PATCHES.some(present);
      S.patchOn = {};
      for (const p of PATCHES) {
        // partly there (a file from before a patch gained its second half): on, and saving completes it.
        // A patch newer than the choices last saved (not in them) starts as it would on a fresh game.
        const known = saved && p.id in saved;
        const on = fresh ? (known ? saved[p.id] : !p.off) : present(p) || (!known && !p.off);
        S.patchOn[p.id] = patchAvailable(p) && on;
      }
      S.patchOn.tutorial = null; // null: off once mission 1 is edited (tutorialOff)
      syncPatched();
    }

    /* Level checks (and the palette) see what a ticked patch adds on save as there already: the deep-water
     * goal shadow, monster plan icons, and the T Rex and scorpion as placeable */
    function syncPatched() {
      const g = game();
      g.planIcons = new Set(S.planIconsBase);
      for (const h of S.monsterPlans) for (const t of h.targets) {
        if (S.patchOn.monsterPlans) g.planIcons.add(t.name);
        else g.planIcons.delete(t.name);
      }
      g.placeable.monster = new Set(S.placeableMonstersBase);
      for (const h of S.monsterArt) for (const n of h.monsters) {
        if (S.patchOn.monsterArt) g.placeable.monster.add(n);
        else g.placeable.monster.delete(n);
      }
      g.goalShadows = new Set(S.goalShadowsBase);
      if (S.patchOn.deep && S.goalShadow.length) g.goalShadows.add("water_undiggable");
      else if (S.goalShadow.length) g.goalShadows.delete("water_undiggable");
    }
    // The Game tab's rows: [{id, label, desc, on, available}]
    function patchRows() {
      const rows = PATCHES.map((p) => ({ id: p.id, label: p.label, available: patchAvailable(p), on: !!S.patchOn[p.id],
        desc: patchAvailable(p) ? p.desc || "" : "This game file doesn't have the code this changes." }));
      if (S.tutorialHook) rows.push({ id: "tutorial", label: TUTORIAL_LABEL, available: true, on: tutorialOff(), desc: "Turns on by itself when you edit mission 1." });
      return rows;
    }
    function setPatch(id, on) {
      S.patchOn[id] = on;
      if (id !== "tutorial") syncPatched();
    }
    // What saving will change in the game's own code, per the Game tab: {add: [labels], remove: [labels]}
    function patchSummary() {
      const add = [], remove = [];
      for (const p of PATCHES) {
        if (!patchAvailable(p) || S.patchOn[p.id] === patchInstalled(p)) continue;
        (S.patchOn[p.id] ? add : remove).push(p.label);
      }
      if (S.tutorialHook && S.tutorialHook.enabled === tutorialOff()) (tutorialOff() ? add : remove).push(TUTORIAL_LABEL);
      return { add, remove };
    }

    // ---------------------------------------------------------------- saving

    const unsaved = () => S.levels.some((l) => l.dirty) || !!(S.textEdits && S.textEdits.size) || !!S.imported || patchesChanged();
    const dcrName = () => (S.game && S.game.edition === 2 ? "worldbuilder2.dcr" : "worldbuilder.dcr");

    // Changed levels that would break the game: ["World 1 mission 2: ..."]
    function saveProblems() {
      const issues = [];
      for (const l of S.levels.filter((x) => x.dirty)) {
        const v = WB.validateLevel(l.lv, game());
        if (v.errs.length) issues.push(`World ${l.world} mission ${l.mission}: ${v.errs.join(" ")}`);
      }
      return issues;
    }

    // Apply pending edits and rebuild the movie (the .dcr bytes)
    async function buildMovie() {
      for (const l of S.levels) if (l.dirty) await S.movie.setText(l.member, WB.serializeLevel(l.lv, game().terrain));
      for (const [name, text] of S.textEdits) await S.movie.setText(name, text);
      if (S.tutorialHook && S.tutorialHook.enabled === tutorialOff()) await S.movie.setTutorialHook(S.tutorialHook, !tutorialOff());
      for (const p of PATCHES) for (const h of p.handlers()) await (S.patchOn[p.id] ? p.apply(h) : p.remove(h));
      return S.movie.save();
    }

    // After saving the Launcher.exe: nothing is unsaved. Returns the patch choices to remember for this game.
    function markSaved() {
      for (const l of S.levels) if (l.dirty) { l.text = WB.serializeLevel(l.lv, game().terrain); l.dirty = false; l.textCache = null; }
      S.textEdits.clear();
      S.imported = null;
      for (const p of PATCHES) if (patchAvailable(p)) S.patchOn[p.id] = patchInstalled(p);
      S.patchOn.tutorial = null;
      return Object.fromEntries(PATCHES.map((p) => [p.id, S.patchOn[p.id]]));
    }

    return {
      loadFinds, placeable, unitClassOf, planModels, unitTooltip, isBoulder, categoryOf, terrainPalette, objectPalette,
      brushId, brushTitle, groundName, terrainLabel, goalTargets, parseCollect, goalObjective,
      itemIndexFor, withWater, isWaterChar, terrainChar, groundChar, partsOn, brushParts, ghostParts,
      applyBrush, setCellTerrain, movedParts, inMap, canMove, moveObject, replaceAt, eraseAt, floodFill, fillRect,
      copyArea, pasteAt, pickAt, recipeRows, isPlanAt, resizeMap, clearMap,
      levelMusic, setLevelMusic, missionTitle, listName, setMissionTitle, isFirstMission, tutorialOff, tutorialNote,
      levelText, otherTexts, textOf,
      PATCHES, patchAvailable, patchInstalled, patchesChanged, initPatches, syncPatched, patchRows, setPatch, patchSummary,
      unsaved, dcrName, saveProblems, buildMovie, markSaved,
    };
  }

  const api = { create, CATS, FINDS, TRACK_NAMES, trackName, titleCase, partsKey, TUTORIAL_LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WBEdit = api;
})(typeof self !== "undefined" ? self : this);
