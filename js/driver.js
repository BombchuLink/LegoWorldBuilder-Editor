/* Test driver shared by Node (V8) and the native QuickJS host: the same
 * steps the editor takes to open a Launcher.exe and save it, so the two engines' outputs can be
 * compared byte for byte.   WBE_DRIVER.run(bytes, op) -> Promise<{bytes, report}>
 *   resave     open and save without changes
 *   patch-on   every patch (and mission 1 without the tutorial), as a fresh save with the cheat ticked
 *   patch-off  every patch taken back out
 *   edit       every level renamed and one tile changed, and a mission title */
(function (root) {
  "use strict";
  const WB = root.WB || (typeof require !== "undefined" && require("./wbcore.js"));

  // [find, apply, remove] in the order buildMovie applies the Game tab's patches
  const PATCHES = [
    ["keys", "keyHandlers", "setWasdControls", "unsetWasdControls"],
    ["menu", "keyHandlers", "setMenuKey", "unsetMenuKey"],
    ["swoop", "planSwoops", "fixPlanSwoop", "unfixPlanSwoop"],
    ["deep", "deepWater", "fixDeepWater", "unfixDeepWater"],
    ["deep", "goalShadow", "fixGoalShadow", "unfixGoalShadow"],
    ["music", "levelMusic", "fixLevelMusic", "unfixLevelMusic"],
    ["monsterArt", "monsterArt", "fixMonsterArt", "unfixMonsterArt"],
    ["monsterPlans", "monsterPlans", "fixMonsterPlans", "unfixMonsterPlans"],
    ["builtMonsterSelect", "builtMonsterSelect", "fixBuiltMonsterSelect", "unfixBuiltMonsterSelect"],
    ["monsterHealth", "monsterHealth", "fixMonsterHealth", "unfixMonsterHealth"],
    ["goalSave", "goalSave", "fixGoalSave", "unfixGoalSave"],
    ["whirlpool", "whirlpoolFix", "fixWhirlpool", "unfixWhirlpool"],
    ["unlockAll", "unlockAll", "fixUnlockAll", "unfixUnlockAll"],
  ];

  async function run(bytes, op) {
    const t = [Date.now()], lap = () => t.push(Date.now());
    const movie = await WB.openMovie(bytes);
    lap();
    const game = await movie.loadGame();
    lap();
    // loadMovie's order
    const S = {};
    const finds = {};
    const find = async (key, fn) => { const a = Date.now(); S[key] = await movie[fn](); finds[fn] = Date.now() - a; };
    await find("tutorialHook", "findTutorialHook");
    await find("keyHandlers", "findKeyHandlers");
    await find("planSwoops", "findPlanSwoop");
    await find("deepWater", "findDeepWater");
    await find("levelMusic", "findLevelMusic");
    await find("goalSave", "findGoalSave");
    await find("whirlpoolFix", "findWhirlpoolFix");
    await find("builtMonsterSelect", "findBuiltMonsterSelect");
    await find("unlockAll", "findUnlockAll");
    await find("goalShadow", "findGoalShadow");
    await find("monsterPlans", "findMonsterPlans");
    await find("monsterHealth", "findMonsterHealth");
    await find("monsterArt", "findMonsterArt");
    lap();
    const installed = (p) => p[0] === "keys" ? S.keyHandlers.map((h) => h.wasd) : p[0] === "menu" ? S.keyHandlers.map((h) => h.menu) : S[p[1]].map((h) => h.fixed);
    const report = {
      edition: game.edition, levels: game.levels.length, members: movie.members.length,
      patches: PATCHES.map((p) => `${p[0]}/${p[1]}:${installed(p).map((b) => (b ? 1 : 0)).join("") || "-"}`),
      tutorial: S.tutorialHook ? (S.tutorialHook.enabled ? "on" : "off") : "-",
    };

    const changes = {};
    if (op === "edit") {
      for (const l of game.levels) {
        const lv = WB.parseLevel(l.text, game.terrain);
        lv.name = (lv.name + " edited").trim();
        const row = lv.grid[Math.floor(lv.grid.length / 2)];
        const c = row && row.find((x) => x.item < 0);
        if (c) c.t = Object.keys(game.terrain).find((k) => game.terrain[k] === "tree") || c.t;
        await movie.setText(l.member, WB.serializeLevel(lv, game.terrain));
      }
      const names = (await movie.text("level names")) || "";
      if (names) await movie.setText("level names", names.replace(/^(\s*1\s+1\s+).*$/m, "$1Édited mission ✓"));
    } else if (op === "patch-on" || op === "patch-off") {
      const on = op === "patch-on";
      if (S.tutorialHook && S.tutorialHook.enabled === on) await movie.setTutorialHook(S.tutorialHook, !on);
      for (const p of PATCHES) {
        const a = Date.now();
        for (const h of S[p[1]]) await movie[on ? p[2] : p[3]](h);
        changes[p[1] + "." + (on ? p[2] : p[3])] = Date.now() - a;
      }
      report.after = PATCHES.map((p) => `${p[0]}/${p[1]}:${installed(p).map((b) => (b ? 1 : 0)).join("") || "-"}`);
    } else if (op !== "resave") throw new Error("unknown op " + op);
    lap();
    const dcr = await movie.save();
    lap();
    const out = WB.wrapProjector(movie.wrapper, dcr);
    report.detail = { finds, changes };
    report.ms = { open: t[1] - t[0], loadGame: t[2] - t[1], findPatches: t[3] - t[2], change: t[4] - t[3], save: t[5] - t[4] };
    return { bytes: out, report };
  }

  const api = { run };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WBE_DRIVER = api;
})(typeof self !== "undefined" ? self : this);
