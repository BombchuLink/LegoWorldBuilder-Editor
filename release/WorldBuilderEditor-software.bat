@echo off
rem Starts the editor drawing without the graphics card, for when the window stays black or garbled.
set WBE_RENDERER=software
start "" "%~dp0WorldBuilderEditor.exe" %*
