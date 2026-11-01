WorldBuilder Level Editor @VERSION@
====================================

A level editor for LEGO World Builder and World Builder 2: paint the maps, place units, plans,
brick piles, goals and whirlpools, change mission titles, music and starting plans, and fix some of
the games' bugs. It was made for the "Project Brick Game Archive" (Part 3) release of the games;
other versions may need more tinkering.


STARTING
--------
Windows (7 or later): run WorldBuilderEditor.exe.
Linux (x86-64, glibc 2.35 or later: Ubuntu 22.04, Debian 12, Fedora 36, Mint 21, SteamOS 3 and
newer): run ./worldbuilder-editor. ./install.sh adds it to your applications menu
(./install.sh --uninstall takes it out again).

Then click "Open Launcher.exe..." and pick Launcher.exe in your World Builder or World Builder 2
folder, or drop Launcher.exe on the window. Keep the "data" folder next to the program.


EDITING
-------
Pick a level on the left. The tools are at the top:

  Brush (B)       paint terrain or place the object picked in the Palette. Shift+drag fills a
                  rectangle. Click an object to select it, drag it to move it, Alt/Ctrl+click it to
                  replace it with the brush. Shift+click a plan for a pile of the bricks it needs.
  Fill (F)        flood-fills matching terrain, or replaces connected copies of an object
  Erase (E)       removes objects (right-click an object with any tool to delete it too)
  Eyedropper (I)  picks up a tile or object from the map
  Select (S)      click a tile to edit it on the Tile tab; drag over tiles to copy them, then click
                  to place copies (Esc stops, Ctrl+V picks the copy up again, even in another level)

  Ctrl+Z / Ctrl+Y undo / redo          Delete   remove the selected object
  Scroll          zoom                 Right or middle drag, or Space + drag: move the map
  L               hide the level list  Ctrl+S   save          Ctrl+O   open

The tabs on the right: Palette (terrain and objects), Tile (the selected tile), Level (title,
music, start view, map size, starting plans), Text (the level as the game reads it) and Game (the
game patches below). Problems that would stop a level working show at the bottom.


SAVING
------
"Save Launcher.exe" writes over the file you opened; the first time, the original is kept next to
it as Launcher.exe.orig. "Save as..." writes a copy somewhere else, and "Export .dcr" writes just
the game movie (the version that plays in a browser). Your progress in the game (unlocked
missions) is kept by the game separately and isn't affected.


GAME PATCHES
------------
Saving also changes the game itself as ticked on the Game tab; unticking one and saving puts the
original code back.
 - Picking up two copies of the same plan quickly no longer bugs the plans bar
 - Esc opens and closes the menu
 - W A S D scroll like the arrow keys, Q takes a unit apart
 - Units, plans and goals can stand on deep water
 - Each level can choose its music track
 - World Builder 2's T Rex and scorpion get their animations from World Builder 1, so they can be
   placed and built
 - Plans for monsters (except the boulder)
 - Built monsters can't be controlled (they're no longer selected when they finish building)
 - Built monsters have inverse health compared to the energy brick used
 - Reaching a goal no longer freezes the game: progress is saved when the mission ends
 - Taking a unit apart on a whirlpool after teleporting no longer leaves the pair unusable
 - On saving World 1 mission 1, the Tutorial map is moved to map 999
 - Cheat, off unless you tick it: every mission and world is unlocked from the start


IF SOMETHING GOES WRONG
-----------------------
 - A black or broken window: draw without the graphics card. On Windows, run
   WorldBuilderEditor-software.bat; on Linux, WBE_RENDERER=software ./worldbuilder-editor
 - Settings (window layout, the last level, the patch choices) are kept in
   %APPDATA%\worldbuilder\editor\prefs.json on Windows and
   ~/.local/share/worldbuilder/editor/prefs.json on Linux; delete the file to start afresh.
 - Please report problems at https://github.com/BombchuLink/LegoWorldBuilder-Editor/issues

The editor is free software under the MIT No Attribution licence (LICENSE.txt). The licences of
the libraries and font it's built with are in the "licenses" folder. LEGO and World Builder belong
to their owners.
