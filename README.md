# WorldBuilder Level Editor

A level editor for LEGO *World Builder* and *World Builder 2*: paint the maps, place units, plans,
brick piles, goals and whirlpools, change mission titles, music and starting plans, and fix some of
the games' bugs.

This editor was made to work with the "Project Brick Game Archive" (Part 3) release of World Builder. It's possible it might work with other versions but idk that might require more tinkering.

## Getting it

Download the archive for your system from the releases page:

- **Windows 7 or later:** `WorldBuilderEditor-1.1-windows.zip`. Unzip it and run `WorldBuilderEditor.exe`. Nothing to install.
- **Linux (x86-64, glibc 2.35+: Ubuntu 22.04, Debian 12, Fedora 36, Mint 21, SteamOS 3 and newer):** `WorldBuilderEditor-1.1-linux-x86_64.tar.gz`. Unpack it and run `./worldbuilder-editor`; `./install.sh` adds it to your applications menu.

Then open `Launcher.exe` from your World Builder game folder. The `README.txt` in the archive covers the tools, keys and saving.

Since 1.1 the editor is a small native program (SDL3 + Dear ImGui, with its JavaScript core running in QuickJS) instead of an Electron app: about 70 MB of memory instead of 280 MB, and a 3.5 MB download instead of a 288 MB `node_modules`. See [CHANGELOG.md](CHANGELOG.md) and, for building it, [native/README.md](native/README.md).

## What's where

- `wbcore.js`: reading and writing the games: the Shockwave movie inside `Launcher.exe`, its levels and text, and the patches.
- `scene.js`: what the map looks like (which sprite goes where).
- `edit.js`: the editing rules (what can stand where, filling, moving, resizing, building the movie to save).
- `native/`: the program: the editor's state, tools and panels (`native/js/editor.js`) and the C++ window that runs it.
- `patch_game.js`, `wb1_monster_sprites.js`: command-line tools (Node), see below.

## Patches

Saving a .exe applies the following patches to a game. Each one can be switched on or off on the **Game** tab; switching one off and saving restores the game's original code for it. Here's a list of all the patches.
 - Picking up two copies of the same plan in quick succession no longer bugs the UI
 - ESC can open/close the menu
 - W A S D replace the functionality of Up/Down/Left/Right
 - Q is now a shortcut for "take apart"
 - Objects that can exist in deep water can be placed in deep water, including goals
 - Each level can chose which music track plays (instead of random)
 - World Builder 2's T Rex and scorpion get their animations from World Builder 1, so they can be placed and built (WB2 only has their frozen sprites; without this they cause a script error). The sprites are in `wb1monsters.js`, made by `node wb1_monster_sprites.js <World Builder 1 .dcr>` (in this folder)
 - Plans for monsters (except the boulder)
 - Built monsters can't be controlled (they're no longer selected when they finish building)
 - Built monsters have inverse health compared to the energy brick used
 - On saving World 1 map 1, the Tutorial map is moved to map 999
 - Taking a unit apart on a whirlpool after teleporting no longer leaves that whirlpool pair unusable
 - Reaching a goal or bonus goal no longer freezes the game: progress is saved when the mission ends (End/Restart) instead
 - Cheat (off unless you tick it): every mission and world is unlocked from the start

`node patch_game.js <file>...` (in this folder) applies these changes (all but the tutorial switch and the cheat) to a `Launcher.exe` directly, keeping a `.orig` backup.


