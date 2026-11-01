/* What the map looks like, as drawing commands: which sprite stands for each tile and object and
 * where it goes, in map pixels. The editor (native/js/editor.js) hands them to the C++ host, which
 * draws them with SDL.
 * No DOM; needs wbcore.js (WB).
 *
 * A scene is made for one game with an env:
 *   game                     WB game data (terrain, config...)
 *   sprite(name)             {w, h, regX, regY} once the bitmap is ready, else null (may start loading it)
 *   hasSprite(name)          whether the game has (or will have, with its patches) that bitmap
 *   planIcon(name)           whether a plans-menu picture can be shown (default: hasSprite)
 *   showGrid()               whether tile outlines are drawn
 *
 * Commands (arrays, in map pixels):
 *   ["img", name, x, y]                 sprite with its top-left at x, y
 *   ["imgs", name, x, y, w, h]          sprite scaled into that box
 *   ["badge", text, x, y, bg, fg, outline]  rounded label centered on x, y (16 high; outline may be null)
 *   ["face", x, y, inset, fill, stroke, lineWidth, screenPx, dash]  a tile's diamond (fill/stroke may be
 *                                       null; screenPx: lineWidth is in screen pixels; dash: [on, off] or null)
 *   ["alpha", a]                        opacity for what follows */
(function (root) {
  "use strict";
  const WB = root.WB || (typeof require !== "undefined" && require("./wbcore.js"));

  // Projection used by the game (map_display.posToLoc): 50px cells, each row shifted 25px left.
  const CELL = 50, SKEW = 25;
  // Where the game draws things relative to a tile's position, measured from the real game
  const OBJ_DX = 10, OBJ_DY = 16; // vehicles and monsters (buildings have no offset)
  // resource.generic: up to 4 brick sprites, biggest amount first; 8px lower on water
  const PILE_SPOTS = [[22, 7], [17, 18], [12, 28], [6, 39]];
  const PILE_WATER_DY = 8;
  const VIEW_W = 12, VIEW_H = 9; // tiles visible in the game window
  // models shown facing right in the editor (everything else faces down, or right if it has no down)
  const FACE_RIGHT = new Set(["duck", "forklift", "freighter", "snail", "steamshovel", "tugboat", "guard_tower"]);

  const cellOrigin = (x, y) => [x * CELL - y * SKEW, y * CELL];

  // view: {x, y, zoom}, screen point -> tile
  function screenToCell(view, sx, sy) {
    const wx = (sx - view.x) / view.zoom, wy = (sy - view.y) / view.zoom;
    const y = Math.floor(wy / CELL);
    const ly = wy - y * CELL;
    const x = Math.floor((wx + y * SKEW + ly / 2) / CELL);
    return [x, y];
  }

  // The view that fits a w×h-tile map in a width×height window (zoom: a fixed zoom, or null to fit)
  function fitView(w, h, width, height, zoom) {
    const mapW = w * CELL + h * SKEW + 40, mapH = h * CELL + 60;
    const z = zoom || Math.max(0.2, Math.min(2, Math.min(width / mapW, height / mapH)));
    return { zoom: z, x: (width - (w * CELL - h * SKEW) * z) / 2, y: (height - h * CELL * z) / 2 - 10 * z };
  }

  // The part of the map the game shows first; mirrors map_display.readmap
  function startViewRect(lv, w, h) {
    const c = lv.center || [Math.floor(w / 2) + 1, Math.floor(h / 2)];
    let left = Math.trunc(c[0] - VIEW_W / 2 + 1), top = Math.trunc(c[1] - VIEW_H / 2);
    left = Math.max(1, Math.min(left, w - VIEW_W + 1));
    top = Math.max(1, Math.min(top, h - VIEW_H + 1));
    return { left: left - 1, top: top - 1, c };
  }

  // Tiles within (and a margin around) a window, for drawing only what shows:
  // {y0, y1, xFrom(y), xTo(y)} for a w×h map seen through view in a width×height window
  function visibleRange(w, h, view, width, height, margin) {
    const left = -view.x / view.zoom - margin, right = (width - view.x) / view.zoom + margin;
    const top = -view.y / view.zoom - margin, bottom = (height - view.y) / view.zoom + margin;
    return {
      y0: Math.max(0, Math.floor(top / CELL)), y1: Math.min(h, Math.ceil(bottom / CELL)),
      // a row's tiles start SKEW further left per row
      xFrom: (y) => Math.max(0, Math.floor((left + y * SKEW) / CELL)),
      xTo: (y) => Math.min(w, Math.ceil((right + y * SKEW) / CELL)),
    };
  }

  function create(env) {
    const game = env.game;
    const sprite = (n) => (n ? env.sprite(n) : null);
    const hasSprite = env.hasSprite;
    const planIcon = env.planIcon || hasSprite;

    // ---- which bitmap stands for what

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
      if (name === "defender2" || name === "defender3") c.push(`${cls}.defender.down`, `${cls}.defender`);
      return c.find(hasSprite) || null;
    }

    function planSpriteName(name) {
      const n = name === "repairbot" ? "repairBot" : name;
      return [`vehicle.${n}.plan`, `building.${n}.plan`, `monster.${n}.plan`].find(planIcon) || null;
    }

    function pileSpriteName(res, amount) {
      if (res === "energy" || res === "wheel") return `resource.${res}`;
      // pPileSetup.countversions: 1 -> .1, 2+ -> .2, 6+ -> .3, 13+ -> .4
      const step = amount >= 13 ? 4 : amount >= 6 ? 3 : amount >= 2 ? 2 : 1;
      return [`resource.${res}.${step}`, `resource.${res}.1`, `resource.${res}`].find(hasSprite) || null;
    }

    function terrainSprite(ch, p) {
      if (p) return p[0] === "whirlpool" ? "terrain.water_whirlpool" : "terrain." + WB.itemTerrain(p);
      const t = game.terrain[ch];
      return t ? "terrain." + t : "terrain.normal";
    }

    // ---- commands

    // a sprite drawn at its registration point; false if it isn't ready
    function img(out, name, x, y) {
      const s = sprite(name);
      if (!s) return false;
      out.push(["img", name, Math.round(x - s.regX), Math.round(y - s.regY)]);
      return true;
    }
    // centered on (x, y) and shrunk to fit, ignoring the registration point
    // (plans-menu pictures are registered for the plans panel, not the map)
    function fitted(out, name, x, y, maxW, maxH, maxScale = 1) {
      const s = sprite(name);
      if (!s) return false;
      const k = Math.min(maxScale, maxW / s.w, maxH / s.h);
      out.push(["imgs", name, Math.round(x - (s.w * k) / 2), Math.round(y - (s.h * k) / 2), s.w * k, s.h * k]);
      return true;
    }
    const badge = (out, text, x, y, bg = "#111c", fg = "#fff", outline = null) => out.push(["badge", String(text), x, y, bg, fg, outline]);

    function planCount(out, p, x, y) {
      const [ox, oy] = cellOrigin(x, y);
      badge(out, "×" + (p[2] || 1), ox - 4, oy + 40, "#fff", "#111", "#111");
    }

    // An object on tile x, y; withCount false leaves out a plan's ×N badge, so the map can draw
    // them all on top afterwards
    function object(out, p, x, y, withCount = true) {
      const [ox, oy] = cellOrigin(x, y);
      const cx = ox + OBJ_DX, cy = oy + OBJ_DY;
      const base = p[0].replace(/^water/, "");
      const water = WB.itemIsWater(p);
      if (base === "unit") {
        // The game offsets only vehicles and monsters; buildings sit at the tile's own loc
        const [ux, uy] = p[1] === "building" ? [ox, oy] : [cx, cy];
        if (!img(out, unitSpriteName(p[1], p[2], water), ux, uy)) badge(out, p[2], ox + 13, oy + 25);
      } else if (base === "plan") {
        // The game shows only a blueprint (plan.generic); the editor puts the model's plans-menu
        // picture behind it, with the paper in the tile's bottom-right corner
        if (!fitted(out, planSpriteName(p[1]), ox + 11, oy + 18, 50, 40, 1.6)) badge(out, p[1], ox + 11, oy + 18);
        img(out, "plan.generic", ox + 5, oy + 14);
        if (withCount) planCount(out, p, x, y);
      } else if (base === "pile") {
        const res = [];
        for (let i = 1; i + 1 < p.length; i += 2) if (+p[i + 1] > 0) res.push([p[i], +p[i + 1]]);
        res.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        const wy = water ? PILE_WATER_DY : 0;
        res.slice(0, PILE_SPOTS.length).forEach(([r, n], i) => {
          img(out, pileSpriteName(r, n), ox + PILE_SPOTS[i][0], oy + PILE_SPOTS[i][1] + wy);
        });
      } else if (base === "goal" || base === "bonusgoal") {
        // The game puts a shadow at the tile's loc (lower on water, whose surface sits lower)
        // and floats the goal above it; here the goal hovers centered over its shadow
        const shadowName = water || WB.isWaterTerrain(p[2]) ? "goal.shadow.water" : "goal.shadow.normal";
        const shadow = sprite(shadowName);
        let gx = ox + 13, gy = oy + 26;
        if (shadow) {
          img(out, shadowName, ox, oy);
          gx = ox - shadow.regX + shadow.w / 2;
          gy = oy - shadow.regY + shadow.h / 2 - 2;
        }
        const gname = base === "goal" ? "goal.goal" : "goal.bonus";
        const g = sprite(gname);
        if (g) out.push(["img", gname, Math.round(gx - g.w / 2), Math.round(gy - g.h)]);
        else badge(out, base === "goal" ? "!" : "★", gx, gy - 12);
      } else if (base === "whirlpool") {
        badge(out, "⟳ " + p[1], ox + 13, oy + 25, "#0a4f8cdd");
      } else badge(out, p[0], ox + 13, oy + 25, "#a00d");
      return out;
    }

    /* The whole map: terrain back to front, tile outlines, objects, then plan counts over
     * everything. range (from visibleRange) limits it to what shows; faded(x, y) dims a tile's object. */
    function map(lv, range, faded) {
      const out = [];
      const h = lv.grid.length, w = h ? lv.grid[0].length : 0;
      const r = range || { y0: 0, y1: h, xFrom: () => 0, xTo: () => w };
      const each = (fn) => { for (let y = r.y0; y < r.y1; y++) for (let x = r.xFrom(y), xe = r.xTo(y); x < xe; x++) fn(lv.grid[y][x], x, y); };
      each((c, x, y) => {
        const [ox, oy] = cellOrigin(x, y);
        const tname = terrainSprite(c.t, c.item >= 0 ? lv.items[c.item].parts : null);
        if (tname === "terrain.hole") {
          out.push(["face", x, y, 2, null, "#ffffff30", 1, false, [4, 4]]);
          return;
        }
        if (!img(out, tname, ox, oy)) out.push(["face", x, y, 0, "#3b7d3b", null, 0, false, null]);
        if (c.item < 0 && game.terrain[c.t] == null) badge(out, c.t, ox + 13, oy + 25, "#a00d");
      });
      if (env.showGrid()) {
        each((c, x, y) => {
          if (game.terrain[c.t] === "hole" && c.item < 0) return;
          out.push(["face", x, y, 0, null, "#00000026", 1, true, null]);
        });
      }
      each((c, x, y) => {
        if (c.item < 0) return;
        const dim = faded && faded(x, y);
        if (dim) out.push(["alpha", 0.3]);
        object(out, lv.items[c.item].parts, x, y, false);
        if (dim) out.push(["alpha", 1]);
      });
      each((c, x, y) => {
        if (c.item < 0 || lv.items[c.item].parts[0].replace(/^water/, "") !== "plan") return;
        const dim = faded && faded(x, y);
        if (dim) out.push(["alpha", 0.3]);
        planCount(out, lv.items[c.item].parts, x, y);
        if (dim) out.push(["alpha", 1]);
      });
      return out;
    }

    // ---- words

    function displayName(name) {
      for (const cls of ["vehicle", "building", "monster"]) {
        const c = game.config[cls] && game.config[cls][name];
        if (c && c.name) return c.name;
      }
      return name.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
    }
    /* What a unit is, for people: the game files every unit you control under "vehicle", but its
     * config gives animals and robots a kind (WB2 picks their click sound by it) */
    function unitKind(cls, name) {
      const info = game.config && game.config[cls] && game.config[cls][String(name).toLowerCase()];
      return (cls === "vehicle" && info && info.kind) || cls;
    }
    function recipeOf(name) {
      for (const cls of ["vehicle", "building", "monster"]) {
        const c = game.config[cls] && game.config[cls][name];
        if (c && c.recipe) return c.recipe;
      }
      return null;
    }
    const recipeText = (recipe) => Object.entries(recipe).map(([k, v]) => `${v} ${k}`).join(", ");

    function describeParts(p) {
      const base = p[0].replace(/^water/, "");
      const onWater = WB.itemIsWater(p) ? " (on water)" : "";
      if (base === "unit") return `${displayName(p[2])}: ${unitKind(p[1], p[2])}${onWater}`;
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

    // The status-bar text for a tile
    function cellLabel(lv, x, y) {
      const c = lv.grid[y][x];
      let s = `(${x + 1}, ${y + 1}) `;
      if (c.item >= 0) {
        const p = lv.items[c.item].parts;
        s += p[2] === "boulder" && p[0].replace(/^water/, "") === "unit" ? "I rock!" : describeParts(p);
        // plans also list the bricks their model needs
        const recipe = p[0].replace(/^water/, "") === "plan" && recipeOf(p[1]);
        if (recipe) s += `: needs ${recipeText(recipe)}`;
      } else s += WB.TERRAIN_LABELS[game.terrain[c.t]] || game.terrain[c.t] || `unknown "${c.t}"`;
      return s;
    }

    return {
      unitSpriteName, planSpriteName, pileSpriteName, terrainSprite,
      object: (p, x, y, withCount) => object([], p, x, y, withCount), map,
      displayName, unitKind, recipeOf, recipeText, describeParts, cellLabel,
    };
  }

  const api = { CELL, SKEW, VIEW_W, VIEW_H, cellOrigin, screenToCell, fitView, startViewRect, visibleRange, create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WBScene = api;
})(typeof self !== "undefined" ? self : this);
