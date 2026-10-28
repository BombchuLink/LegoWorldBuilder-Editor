// Apply the editor's game fixes to a Launcher.exe or .dcr:  node patch_game.js <file>...
//  - WASD scrolls the map instead of the arrow keys, Q takes apart the selected model
//  - Esc opens (and closes) the in-game menu
//  - picking up two copies of a plan quickly no longer leaves its plans-bar icon stuck over the map
//  - levels can start swimmers and plans on deep water ("waterunit,vehicle,tugboat,water_undiggable")
//  - levels can choose their music with a "music=music_game_a" line in [map]
//  - reaching a goal no longer freezes the game while progress is saved (it's saved when the mission ends)
// Writes <file>.orig-<n> as a backup first. Fixes that are already in a file are left alone.
const fs = require("fs");
const WB = require("./wbcore.js");

async function pending(mv) {
  const handlers = await mv.findKeyHandlers();
  const keys = handlers.filter((h) => !h.wasd), menu = handlers.filter((h) => !h.menu);
  const swoops = (await mv.findPlanSwoop()).filter((h) => !h.fixed);
  const deep = (await mv.findDeepWater()).filter((h) => !h.fixed);
  const music = (await mv.findLevelMusic()).filter((h) => !h.fixed);
  const goalSave = (await mv.findGoalSave()).filter((h) => !h.fixed);
  return { keys, menu, swoops, deep, music, goalSave };
}

(async () => {
  for (const path of process.argv.slice(2)) {
    const mv = await WB.openMovie(fs.readFileSync(path));
    await mv.loadGame();
    const { keys, menu, swoops, deep, music, goalSave } = await pending(mv);
    if (!keys.length && !menu.length && !swoops.length && !deep.length && !music.length && !goalSave.length) { console.log(`${path}: nothing to do`); continue; }
    for (const h of keys) await mv.setWasdControls(h);
    for (const h of menu) await mv.setMenuKey(h);
    for (const h of swoops) await mv.fixPlanSwoop(h);
    for (const h of deep) await mv.fixDeepWater(h);
    for (const h of music) await mv.fixLevelMusic(h);
    for (const h of goalSave) await mv.fixGoalSave(h);
    const dcr = await mv.save();
    const out = mv.wrapper ? WB.wrapProjector(mv.wrapper, dcr) : dcr;
    const check = await WB.openMovie(out);
    await check.loadGame();
    const left = await pending(check);
    if (left.keys.length || left.menu.length || left.swoops.length || left.deep.length || left.music.length || left.goalSave.length) throw new Error(`${path}: patch didn't verify`);
    let backup = path + ".orig", n = 1;
    while (fs.existsSync(backup)) backup = `${path}.orig-${++n}`;
    fs.copyFileSync(path, backup);
    fs.writeFileSync(path, out);
    const done = `${keys.length ? `WASD/Q keys (${keys.length}) ` : ""}${menu.length ? `Esc menu (${menu.length}) ` : ""}${swoops.length ? `plan pickup fix (${swoops.length}) ` : ""}${deep.length ? "deep water " : ""}${music.length ? "level music " : ""}${goalSave.length ? "goal save " : ""}`;
    console.log(`${path}: ${done.trim()}: backup in ${backup}`);
  }
})();
