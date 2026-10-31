# WorldBuilder Level Editor

A level editor for LEGO *World Builder* and *World Builder 2*

This editor was made to work with the "Project Brick Game Archive" (Part 3) release of World Builder. It's possible it might work with other versions but idk that might require more tinkering.

The editor can be booted by either using the electron wrapper, or index.html in a web browser.

## Patches

Saving a .exe applies the following patches to a game. Each one can be switched on or off on the **Game** tab; switching one off and saving restores the game's original code for it. Here's a list of all the patches.
 - Picking up two copies of the same plan in quick succession no longer bugs the UI
 - ESC can open/close the menu
 - W A S D replace the functionality of Up/Down/Left/Right
 - Q is now a shortcut for "take apart"
 - Objects that can exist in deep water can be placed in deep water, including goals
 - Each level can chose which music track plays (instead of random)
 - Plans for monsters (except the boulder)
 - Built monsters can't be controlled (they're no longer selected when they finish building)
 - Built monsters have inverse health compared to the energy brick used
 - On saving World 1 map 1, the Tutorial map is moved to map 999
 - Taking a unit apart on a whirlpool after teleporting no longer leaves that whirlpool pair unusable
 - Reaching a goal or bonus goal no longer freezes the game: progress is saved when the mission ends (End/Restart) instead
 - Cheat (off unless you tick it): every mission and world is unlocked from the start

`node patch_game.js <file>...` (in this folder) applies these changes (all but the tutorial switch and the cheat) to a `Launcher.exe` directly, keeping a `.orig` backup.


