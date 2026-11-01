// The UI and NATIVE globals the native editor's JS (native/js/editor.js) draws its panels with and
// reaches files through: a thin layer over Dear ImGui, and the few things a page would ask the
// desktop for (files, file dialogs, preferences).
#pragma once
#include <string>

#include "imgui.h"
#include "quickjs.h"

namespace wbe {

struct UiSprite {
  ImTextureID tex{};
  int w = 0, h = 0;
  ImVec2 uv0, uv1;
};

class UiHost {
 public:
  virtual ~UiHost() = default;
  // A loaded sprite by name (false: not loaded, or the game has none)
  virtual bool sprite(const std::string& name, UiSprite& out) = 0;
  // Show an open or save dialog; the answer reaches NE.onDialog(kind, path) later
  virtual void file_dialog(const std::string& kind, bool save, const std::string& start, const std::string& ext) = 0;
  // Where prefs.json lives
  virtual std::string prefs_file() = 0;
  virtual void quit() = 0;
};

void bind_ui(JSContext* ctx, UiHost* host);

// Put the next item, `width` wide, on the same line as the last one if it fits in the window
void ui_flow_item(float width);

}  // namespace wbe
