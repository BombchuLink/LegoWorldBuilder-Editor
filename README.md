# WorldBuilder Level Editor

A level editor for LEGO *World Builder* and *World Builder 2*

This editor was made to work with the "Project Brick Game Archive" (Part 3) release of World Builder. It's possible it might work with other versions but idk that might require more tinkering.

## Getting it

Download the archive for your system from the releases page:

- **Windows 7 or later:** `WorldBuilderEditor-1.1-windows.zip`. Unzip it and run `WorldBuilderEditor.exe`. 
- **Linux (x86-64, glibc 2.35+: Ubuntu 22.04, Debian 12, Fedora 36, Mint 21, SteamOS 3 and newer):** `WorldBuilderEditor-1.1-linux-x86_64.tar.gz`. Unpack it and run `./worldbuilder-editor`; `./install.sh` adds it to your applications menu.

## Patches

Saving a .exe applies the following patches to a game. Each one can be switched on or off on the **Game** tab; switching one off and saving restores the game's original code for it. Here's a list of all the patches.
 - W A S D replace the functionality of Up/Down/Left/Right
 - ESC can open/close the menu
 - Q is now a shortcut for "take apart"
 - Picking up two copies of the same plan in quick succession no longer bugs the UI
 - Objects that can exist in deep water can now be placed in deep water.
 - Each level can chose which music track plays (instead of random)
 - T Rex and scorpion are properly ported from World Builder 1
 - Plans for all monsters instead of just the Lion.
 - Built monsters can have inverse health compared to the energy brick used to build them
 - On saving World 1 map 1, the Tutorial map is moved to map 999
 - Taking a unit apart on a whirlpool after teleporting no longer leaves that whirlpool pair unusable
 - Reaching a goal or bonus goal no longer freezes the game: progress is saved when the mission ends (End/Restart) instead
 - Cheat (off unless you tick it): every mission and world is unlocked from the start

`node patch_game.js <file>...` (in this folder) applies these changes (all but the tutorial switch and the cheat) to a `Launcher.exe` directly, keeping a `.orig` backup.

## Licence

The editor is under the [MIT No Attribution](LICENSE) licence (MIT-0). The release builds include SDL3, Dear ImGui, QuickJS-ng and zlib (zlib and MIT licences) and the Fredoka font (SIL Open Font License); their licences ship in each archive's `licenses` folder.
