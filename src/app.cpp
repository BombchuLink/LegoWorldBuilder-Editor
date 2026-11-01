// WorldBuilder Level Editor, native build: the window, the map and the event loop. The game file
// handling, what the map looks like, the editing rules and the panels come from the editor's own
// JS (wbcore.js, scene.js, edit.js, editor.js, all in js/) running in QuickJS; this draws it with
// SDL3 + Dear ImGui.
//
//   worldbuilder-editor [Launcher.exe]
//   WBE_RENDERER=software|opengl|direct3d11|direct3d|vulkan  pick SDL's renderer
#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "imgui.h"
#include "imgui_internal.h"
#include "imgui_impl_sdl3.h"
#include "imgui_impl_sdlrenderer3.h"
#include "js_host.h"
#include "procstats.h"
#include "ui_bind.h"
#include "icon_rgba.h"

namespace {

constexpr float CELL = 50, SKEW = 25;  // map projection (scene.js)

// ---------------------------------------------------------------- JS calls

struct Js {
  wbe::JsHost host;
  JSValue ne = JS_UNDEFINED;

  explicit Js(wbe::UiHost* ui) {
    wbe::bind_ui(host.ctx(), ui);
    host.load_editor_script("js/wb1monsters.js");
    host.load_editor_script("js/wbcore.js");
    host.load_editor_script("js/scene.js");
    host.load_editor_script("js/edit.js");
    host.load_editor_script("js/editor.js");
    ne = host.global("NE");
  }
  ~Js() { JS_FreeValue(host.ctx(), ne); }

  // NE[fn](...args): args are taken (freed); the result is the caller's
  JSValue call(const char* fn, std::initializer_list<JSValue> args = {}) {
    JSContext* c = host.ctx();
    JSValue f = host.check(JS_GetPropertyStr(c, ne, fn));
    std::vector<JSValue> a(args);
    JSValue r = JS_Call(c, f, ne, static_cast<int>(a.size()), a.data());
    for (JSValue v : a) JS_FreeValue(c, v);
    JS_FreeValue(c, f);
    return host.check(r);
  }
  JSValue num(double d) { return JS_NewFloat64(host.ctx(), d); }
  double num_at(JSValueConst arr, int64_t i) {
    JSValue v = JS_GetPropertyInt64(host.ctx(), arr, i);
    double d = 0;
    JS_ToFloat64(host.ctx(), &d, v);
    JS_FreeValue(host.ctx(), v);
    return d;
  }
  std::string str_at(JSValueConst arr, int64_t i) {
    JSValue v = JS_GetPropertyInt64(host.ctx(), arr, i);
    std::string s = host.string_of(v);
    JS_FreeValue(host.ctx(), v);
    return s;
  }
  int64_t length(JSValueConst arr) {
    int64_t n = 0;
    JS_GetLength(host.ctx(), arr, &n);
    return n;
  }
  JSValue prop(JSValueConst obj, const char* name) { return host.check(JS_GetPropertyStr(host.ctx(), obj, name)); }
  void free(JSValue v) { JS_FreeValue(host.ctx(), v); }
};

// ---------------------------------------------------------------- colours

constexpr ImVec4 rgb(unsigned v) { return {((v >> 16) & 255) / 255.0f, ((v >> 8) & 255) / 255.0f, (v & 255) / 255.0f, 1}; }

// "#rgb", "#rgba", "#rrggbb", "#rrggbbaa" as CSS reads them
ImU32 css_color(const std::string& s, float alpha = 1) {
  auto hex = [](char c) { return c <= '9' ? c - '0' : (c | 32) - 'a' + 10; };
  int r = 0, g = 0, b = 0, a = 255;
  if (s.size() == 4 || s.size() == 5) {
    r = hex(s[1]) * 17; g = hex(s[2]) * 17; b = hex(s[3]) * 17;
    if (s.size() == 5) a = hex(s[4]) * 17;
  } else if (s.size() == 7 || s.size() == 9) {
    r = hex(s[1]) * 16 + hex(s[2]); g = hex(s[3]) * 16 + hex(s[4]); b = hex(s[5]) * 16 + hex(s[6]);
    if (s.size() == 9) a = hex(s[7]) * 16 + hex(s[8]);
  }
  return IM_COL32(r, g, b, static_cast<int>(std::lround(a * alpha)));
}

// ---------------------------------------------------------------- state

// Sprites live in shared atlas pages, so a map is a few draw calls instead of one per sprite
struct Sprite {
  SDL_Texture* tex = nullptr;  // its atlas page (null: the game has no such bitmap)
  int w = 0, h = 0;
  ImVec2 uv0, uv1;
};

struct Atlas {
  static constexpr int SIZE = 1024, PAD = 1;  // transparent border, so filtering never picks up a neighbour
  struct Page {
    SDL_Texture* tex;
    int x = 0, y = 0, row = 0;  // shelf packing
  };
  std::vector<Page> pages;

  // A page and spot for a w×h sprite, or null if it's bigger than a page
  SDL_Texture* place(SDL_Renderer* r, int w, int h, int& at_x, int& at_y) {
    int pw = w + 2 * PAD, ph = h + 2 * PAD;
    if (pw > SIZE || ph > SIZE) return nullptr;
    for (Page& p : pages) {
      if (p.x + pw > SIZE) { p.x = 0; p.y += p.row; p.row = 0; }
      if (p.y + ph <= SIZE) {
        at_x = p.x + PAD; at_y = p.y + PAD;
        p.x += pw; p.row = std::max(p.row, ph);
        return p.tex;
      }
    }
    SDL_Texture* t = SDL_CreateTexture(r, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, SIZE, SIZE);
    if (!t) return nullptr;
    std::vector<uint8_t> clear(static_cast<size_t>(SIZE) * SIZE * 4, 0);
    SDL_UpdateTexture(t, nullptr, clear.data(), SIZE * 4);
    SDL_SetTextureBlendMode(t, SDL_BLENDMODE_BLEND);
    SDL_SetTextureScaleMode(t, mode);
    pages.push_back({t});
    return place(r, w, h, at_x, at_y);
  }
  // nearest (sharp pixels) normally; linear when zoomed far out, where nearest shimmers
  SDL_ScaleMode mode = SDL_SCALEMODE_NEAREST;
  void set_scale(SDL_ScaleMode m) {
    mode = m;
    for (Page& p : pages) SDL_SetTextureScaleMode(p.tex, m);
  }
  void clear() {
    for (Page& p : pages) SDL_DestroyTexture(p.tex);
    pages.clear();
  }
};

struct Scene {
  std::vector<double> nums;  // 10 per command, see editor.js (pack)
  std::vector<std::string> strs;
  std::vector<ImU32> colors;  // strs read as colours (where they are colours)
};

struct View {
  float x = 0, y = 0, zoom = 1;
};

double prof_hover = 0, prof_ui = 0, prof_render = 0;  // ms, for WBE_SWEEP
double prof_t[3] = {}, prof_c[3] = {};  // clear, draw data, present: wall and thread-CPU ms
using wbe::thread_cpu_ms;

void apply_style();

struct App : wbe::UiHost {
  SDL_Window* window = nullptr;
  SDL_Renderer* renderer = nullptr;
  SDL_Texture* logo = nullptr;  // the app icon, for the welcome screen
  std::optional<Js> js;
  ImFont* ui_font = nullptr;
  ImFont* badge_font = nullptr;

  bool has_level = false;
  int map_w = 0, map_h = 0;
  Scene scene, over;
  std::unordered_map<std::string, Sprite> sprites;
  Atlas atlas;
  std::vector<SDL_Texture*> big;  // sprites too big for an atlas page
  View view;
  float user_zoom = 0;  // zoom chosen by the user; 0 fits each map to the window
  bool show_view = true;
  std::optional<std::pair<int, int>> cell;  // tile under the mouse (may be off the map)
  bool cell_inside = false, cell_mod = false;
  ImVec2 map_min, map_size;
  bool fit_pending = false;
  bool view_touched = false;  // panned or zoomed since the map was fitted: a resized window doesn't refit it
  ImVec2 fitted_size;
  std::array<int, 7> start_view{};
  bool panning = false;
  int map_button = -1;  // button held since a press the editor took on the map
  std::string js_error;
  bool redraw = false, quit_now = false;
  float ui_scale = 1;  // the display's scale (Windows' 125%, 150%…): the UI's sizes and fonts follow it

  void set_ui_scale(float s) {
    if (!(s > 0.5f && s < 8)) s = 1;
    ui_scale = s;
    ImGuiStyle& st = ImGui::GetStyle();
    st = ImGuiStyle();
    ImGui::StyleColorsDark();
    apply_style();
    st.ScaleAllSizes(s);
    st.FontScaleDpi = s;
    redraw = true;
  }
  std::string want_level;  // WBE_LEVEL

  std::mutex dialog_mutex;
  std::vector<std::pair<std::string, std::optional<std::string>>> dialog_results;
  Uint32 wake_event = 0;

  // -------------------------------------------------------------- JS calls

  // NE[fn](...) for its side effects; an exception is shown in the status bar
  void run(const char* fn, std::initializer_list<JSValue> args = {}) {
    try {
      js->free(js->call(fn, args));
    } catch (const std::exception& e) {
      report(e);
    }
  }
  void run_async(const char* fn, std::initializer_list<JSValue> args = {}) {
    try {
      js->free(js->host.await(js->call(fn, args)));
    } catch (const std::exception& e) {
      report(e);
    }
  }
  void report(const std::exception& e) {
    js_error = e.what();
    SDL_Log("JS: %s", e.what());
    size_t nl = js_error.find('\n');
    if (nl != std::string::npos) js_error.resize(nl);
  }
  bool call_bool(const char* fn, std::initializer_list<JSValue> args = {}) {
    try {
      JSValue r = js->call(fn, args);
      bool b = JS_ToBool(js->host.ctx(), r) > 0;
      js->free(r);
      return b;
    } catch (const std::exception& e) {
      report(e);
      return false;
    }
  }
  JSValue str(const std::string& s) { return JS_NewStringLen(js->host.ctx(), s.data(), s.size()); }

  // -------------------------------------------------------------- UiHost

  bool sprite(const std::string& name, wbe::UiSprite& out) override {
    auto it = sprites.find(name);
    if (it == sprites.end() || !it->second.tex) return false;
    out.tex = static_cast<ImTextureID>(reinterpret_cast<intptr_t>(it->second.tex));
    out.w = it->second.w;
    out.h = it->second.h;
    out.uv0 = it->second.uv0;
    out.uv1 = it->second.uv1;
    return true;
  }

  struct DialogReq {
    App* app;
    std::string kind;
  };
  void file_dialog(const std::string& kind, bool save, const std::string& start, const std::string& ext) override {
    static const SDL_DialogFileFilter exe[] = {{"Game launcher", "exe"}, {"All files", "*"}};
    static const SDL_DialogFileFilter dcr[] = {{"Shockwave movie", "dcr"}, {"All files", "*"}};
    static const SDL_DialogFileFilter txt[] = {{"Text", "txt"}, {"All files", "*"}};
    const SDL_DialogFileFilter* f = ext == "dcr" ? dcr : ext == "txt" ? txt : exe;
    auto cb = [](void* user, const char* const* files, int) {
      auto* req = static_cast<DialogReq*>(user);
      {
        std::lock_guard lock(req->app->dialog_mutex);
        std::optional<std::string> path;
        if (files && files[0]) path = files[0];
        req->app->dialog_results.emplace_back(req->kind, path);
      }
      SDL_Event e{};
      e.type = req->app->wake_event;
      SDL_PushEvent(&e);
      delete req;
    };
    // WBE_DIALOG_ANSWER=<path>: answer every dialog with that path at once (for tests)
    if (const char* answer = std::getenv("WBE_DIALOG_ANSWER")) {
      std::lock_guard lock(dialog_mutex);
      dialog_results.emplace_back(kind, *answer ? std::optional<std::string>(answer) : std::nullopt);
      return;
    }
    auto* req = new DialogReq{this, kind};
    const char* where = start.empty() ? nullptr : start.c_str();
    if (save) SDL_ShowSaveFileDialog(cb, req, window, f, 2, where);
    else SDL_ShowOpenFileDialog(cb, req, window, f, 2, where, false);
  }
  std::string prefs_file() override {
    static std::string path = [] {
      char* p = SDL_GetPrefPath("worldbuilder", "editor");
      std::string s = p ? std::string(p) + "prefs.json" : "worldbuilder-editor-prefs.json";
      SDL_free(p);
      return s;
    }();
    return path;
  }
  void quit() override { quit_now = true; }

  std::string status_text() {
    try {
      JSValue s = js->call("statusLine");
      std::string st = js->str_at(s, 0);
      js->free(s);
      return st;
    } catch (const std::exception& e) {
      return e.what();
    }
  }

  void request_quit() {
    if (call_bool("unsaved")) run("askQuit");
    else quit_now = true;
  }

  void deliver_dialogs() {
    std::vector<std::pair<std::string, std::optional<std::string>>> got;
    {
      std::lock_guard lock(dialog_mutex);
      got.swap(dialog_results);
    }
    for (auto& [kind, path] : got) {
      run_async("onDialog", {str(kind), path ? str(*path) : JS_NULL});
      redraw = true;
    }
  }

  void open_start_file(const std::string& path) {
    run_async("openPath", {str(path), want_level.empty() ? JS_UNDEFINED : str(want_level)});
  }

  // -------------------------------------------------------------- what the JS changed

  void sync() {
    try {
      JSValue r = js->call("poll");
      int flags = static_cast<int>(js->num_at(r, 0));
      float dx = static_cast<float>(js->num_at(r, 1)), dy = static_cast<float>(js->num_at(r, 2));
      show_view = js->num_at(r, 3) != 0;
      has_level = js->num_at(r, 4) != 0;
      js->free(r);
      if (flags) {
        redraw = true;
        JSValue t = js->call("title");
        SDL_SetWindowTitle(window, js->host.string_of(t).c_str());
        js->free(t);
      }
      if (flags & 8) clear_sprites();
      if (flags & 4) {
        view.x -= (dx * CELL - dy * SKEW) * view.zoom;
        view.y -= dy * CELL * view.zoom;
      }
      if (flags & 2) fit_pending = true;
      if ((flags & 3) && has_level) {
        JSValue s = js->call("size");
        map_w = static_cast<int>(js->num_at(s, 0));
        map_h = static_cast<int>(js->num_at(s, 1));
        js->free(s);
        JSValue sv = js->call("startView");
        for (int k = 0; k < 7; k++) start_view[k] = static_cast<int>(js->num_at(sv, k));
        js->free(sv);
        rebuild_scene();
      }
      if (call_bool("hasPending")) {
        load_pending_sprites();
        redraw = true;
        if (has_level) rebuild_scene();
      }
    } catch (const std::exception& e) {
      report(e);
    }
  }

  void read_scene(JSValue r, Scene& out) {
    JSValue nums = js->prop(r, "nums"), strs = js->prop(r, "strs");
    size_t off = 0, len = 0, bpe = 0;
    JSValue buf = js->host.check(JS_GetTypedArrayBuffer(js->host.ctx(), nums, &off, &len, &bpe));
    size_t blen = 0;
    uint8_t* p = JS_GetArrayBuffer(js->host.ctx(), &blen, buf);
    out.nums.assign(reinterpret_cast<double*>(p + off), reinterpret_cast<double*>(p + off + len));
    out.strs.clear();
    for (int64_t k = 0, n = js->length(strs); k < n; k++) out.strs.push_back(js->str_at(strs, k));
    out.colors.clear();
    for (auto& s : out.strs) out.colors.push_back(!s.empty() && s[0] == '#' ? css_color(s) : 0);
    for (JSValue v : {buf, nums, strs}) js->free(v);
  }

  // The level's map as scene.js draws it, loading the sprites it uses until it has them all
  void rebuild_scene() {
    for (int pass = 0; pass < 4; pass++) {
      JSValue r = js->call("scene");
      read_scene(r, scene);
      js->free(r);
      if (!call_bool("hasPending")) return;
      load_pending_sprites();
    }
  }

  void rebuild_overlay() {
    try {
      JSValue r = js->call("overlay", {JS_NewBool(js->host.ctx(), panning || ImGui::IsKeyDown(ImGuiKey_Space))});
      read_scene(r, over);
      js->free(r);
    } catch (const std::exception& e) {
      over = {};
      report(e);
    }
  }

  void load_pending_sprites() {
    JSValue list = js->host.await(js->call("loadPending"));
    for (int64_t i = 0, n = js->length(list); i < n; i++) {
      JSValue e = JS_GetPropertyInt64(js->host.ctx(), list, i);
      std::string name = js->str_at(e, 0);
      int w = static_cast<int>(js->num_at(e, 1)), h = static_cast<int>(js->num_at(e, 2));
      JSValue px = JS_GetPropertyInt64(js->host.ctx(), e, 5);
      Sprite s{nullptr, w, h, {0, 0}, {1, 1}};
      if (w > 0 && h > 0 && !JS_IsNull(px)) {
        size_t n2 = 0;
        uint8_t* rgba = JS_GetUint8Array(js->host.ctx(), &n2, px);
        int ax = 0, ay = 0;
        if (SDL_Texture* page = atlas.place(renderer, w, h, ax, ay)) {
          SDL_Rect r{ax, ay, w, h};
          SDL_UpdateTexture(page, &r, rgba, w * 4);
          s.tex = page;
          s.uv0 = {static_cast<float>(ax) / Atlas::SIZE, static_cast<float>(ay) / Atlas::SIZE};
          s.uv1 = {static_cast<float>(ax + w) / Atlas::SIZE, static_cast<float>(ay + h) / Atlas::SIZE};
        } else if ((s.tex = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, w, h))) {
          SDL_UpdateTexture(s.tex, nullptr, rgba, w * 4);
          SDL_SetTextureBlendMode(s.tex, SDL_BLENDMODE_BLEND);
          SDL_SetTextureScaleMode(s.tex, atlas.mode);
          big.push_back(s.tex);
        }
      }
      sprites[name] = s;
      js->free(px);
      js->free(e);
    }
    js->free(list);
  }

  // Sharp pixels down to 75% zoom; smoothing below that
  void set_smooth(bool on) {
    SDL_ScaleMode m = on ? SDL_SCALEMODE_LINEAR : SDL_SCALEMODE_NEAREST;
    if (m == atlas.mode) return;
    atlas.set_scale(m);
    for (SDL_Texture* t : big) SDL_SetTextureScaleMode(t, m);
  }

  void clear_sprites() {
    atlas.clear();
    for (SDL_Texture* t : big) SDL_DestroyTexture(t);
    big.clear();
    sprites.clear();
  }

  void fit_view() {
    JSValue v = js->call("fit", {js->num(map_size.x), js->num(map_size.y), js->num(user_zoom)});
    view = {static_cast<float>(js->num_at(v, 0)), static_cast<float>(js->num_at(v, 1)), static_cast<float>(js->num_at(v, 2))};
    js->free(v);
    view_touched = false;
    fitted_size = map_size;
  }

  void zoom_at(float sx, float sy, float f) {
    float nz = std::clamp(view.zoom * f, 0.15f, 4.0f);
    view.x = sx - (sx - view.x) * nz / view.zoom;
    view.y = sy - (sy - view.y) * nz / view.zoom;
    view.zoom = user_zoom = nz;
    view_touched = true;
  }

  // The tile under a point of the map area (sx < 0: the mouse isn't over it); tells the editor when
  // that, or Alt/Ctrl, changes
  void update_hover(float sx, float sy) {
    if (!has_level) return;
    bool inside = sx >= 0 && sy >= 0 && sx < map_size.x && sy < map_size.y;
    std::optional<std::pair<int, int>> c;
    if (inside || map_button >= 0) {
      JSValue v = js->call("cellAt", {js->num(view.x), js->num(view.y), js->num(view.zoom), js->num(sx), js->num(sy)});
      c = {{static_cast<int>(js->num_at(v, 0)), static_cast<int>(js->num_at(v, 1))}};
      js->free(v);
    }
    const ImGuiIO& io = ImGui::GetIO();
    bool mod = io.KeyAlt || io.KeyCtrl;
    if (c == cell && inside == cell_inside && mod == cell_mod) return;
    cell = c;
    cell_inside = inside;
    cell_mod = mod;
    run("mouseMove", {js->num(c ? c->first : -1), js->num(c ? c->second : -1), JS_NewBool(js->host.ctx(), inside || map_button >= 0), JS_NewBool(js->host.ctx(), mod)});
    redraw = true;
  }

  // -------------------------------------------------------------- drawing

  ImVec2 to_screen(float x, float y) const { return {map_min.x + view.x + x * view.zoom, map_min.y + view.y + y * view.zoom}; }

  // A tile's diamond
  void face_points(int tx, int ty, float inset, ImVec2 out[4]) const {
    float ox = tx * CELL - ty * SKEW, oy = ty * CELL;
    out[0] = to_screen(ox + 1 + inset, oy + inset);
    out[1] = to_screen(ox + 51 - inset, oy + inset);
    out[2] = to_screen(ox + 26 - inset, oy + 50 - inset);
    out[3] = to_screen(ox - 24 + inset, oy + 50 - inset);
  }

  // A closed outline in dashes of `on`/`off` screen pixels; like the canvas, the pattern runs on
  // around the corners
  static void dashed(ImDrawList* dl, const ImVec2* pts, int n, ImU32 col, float thick, float on, float off) {
    if (!(on > 0.05f) || !(off > 0.05f)) {
      dl->AddPolyline(pts, n, col, ImDrawFlags_Closed, thick);
      return;
    }
    const double period = static_cast<double>(on) + off;
    double phase = 0;
    for (int i = 0; i < n; i++) {
      ImVec2 a = pts[i], b = pts[(i + 1) % n];
      double dx = b.x - a.x, dy = b.y - a.y, len = std::hypot(dx, dy);
      if (!(len > 0) || len > 1e6) continue;
      // each pass ends at a dash boundary or the corner, so this takes ~2·len/period passes
      double t = 0;
      for (int guard = 0; t < len && guard < 100000; guard++) {
        double in = std::fmod(phase, period);
        bool drawing = in < on;
        double step = std::max(1e-3, std::min(len - t, (drawing ? on : period) - in));
        if (drawing) {
          dl->AddLine({static_cast<float>(a.x + dx * t / len), static_cast<float>(a.y + dy * t / len)},
                      {static_cast<float>(a.x + dx * std::min(len, t + step) / len), static_cast<float>(a.y + dy * std::min(len, t + step) / len)}, col, thick);
        }
        t += step;
        phase += step;
      }
    }
  }

  void draw_badge(ImDrawList* dl, const std::string& text, float x, float y, ImU32 bg, ImU32 fg, ImU32 outline, bool has_outline) {
    float z = view.zoom, size = 11 * z;
    ImVec2 ts = badge_font->CalcTextSizeA(size, FLT_MAX, 0, text.c_str());
    float w = ts.x / z + 8;
    ImVec2 a = to_screen(x - w / 2, y - 8), b = to_screen(x + w / 2, y + 8);
    dl->AddRectFilled(a, b, bg, 8 * z);
    if (has_outline) dl->AddRect(a, b, outline, 8 * z, 0, std::max(1.0f, z));
    ImVec2 c = to_screen(x, y + 0.5f);
    dl->AddText(badge_font, size, {c.x - ts.x / 2, c.y - ts.y / 2}, fg, text.c_str());
  }

  void draw_scene(ImDrawList* dl, const Scene& sc) {
    set_smooth(view.zoom < 0.75f);
    float alpha = 1;
    const ImVec2 lo = map_min, hi{map_min.x + map_size.x, map_min.y + map_size.y};
    auto visible = [&](ImVec2 a, ImVec2 b) { return b.x >= lo.x && a.x <= hi.x && b.y >= lo.y && a.y <= hi.y; };
    auto with_alpha = [&](ImU32 c) { return (c & 0x00ffffff) | (static_cast<ImU32>(std::lround(((c >> 24) & 255) * alpha)) << 24); };
    auto color = [&](double i) { return with_alpha(sc.colors[static_cast<size_t>(i)]); };
    const auto& n = sc.nums;
    for (size_t o = 0; o + 10 <= n.size(); o += 10) {
      switch (static_cast<int>(n[o])) {
        case 0:
        case 1: {
          auto it = sprites.find(sc.strs[static_cast<size_t>(n[o + 1])]);
          if (it == sprites.end() || !it->second.tex) break;
          const Sprite& s = it->second;
          float w = n[o] == 0 ? s.w : static_cast<float>(n[o + 4]), h = n[o] == 0 ? s.h : static_cast<float>(n[o + 5]);
          ImVec2 a = to_screen(static_cast<float>(n[o + 2]), static_cast<float>(n[o + 3]));
          ImVec2 b = to_screen(static_cast<float>(n[o + 2]) + w, static_cast<float>(n[o + 3]) + h);
          if (visible(a, b)) dl->AddImage(static_cast<ImTextureID>(reinterpret_cast<intptr_t>(s.tex)), a, b, s.uv0, s.uv1, IM_COL32(255, 255, 255, static_cast<int>(255 * alpha)));
          break;
        }
        case 2: {
          ImVec2 c = to_screen(static_cast<float>(n[o + 2]), static_cast<float>(n[o + 3]));
          if (!visible({c.x - 200, c.y - 20}, {c.x + 200, c.y + 20})) break;
          int ol = static_cast<int>(n[o + 6]);
          draw_badge(dl, sc.strs[static_cast<size_t>(n[o + 1])], static_cast<float>(n[o + 2]), static_cast<float>(n[o + 3]),
                     color(n[o + 4]), color(n[o + 5]), ol >= 0 ? color(ol) : 0, ol >= 0);
          break;
        }
        case 3:
        case 5: {
          ImVec2 pts[4];
          int fill = -1, stroke;
          float lw;
          bool screen_px;
          double on, off;
          if (n[o] == 3) {
            face_points(static_cast<int>(n[o + 1]), static_cast<int>(n[o + 2]), static_cast<float>(n[o + 3]), pts);
            fill = static_cast<int>(n[o + 4]);
            stroke = static_cast<int>(n[o + 5]);
            lw = static_cast<float>(n[o + 6]);
            screen_px = n[o + 7] != 0;
            on = n[o + 8];
            off = n[o + 9];
          } else {
            // a block of tiles: corners of the tiles x0..x1, y0..y1 (exclusive ends)
            auto p = [&](double x, double y) { return to_screen(static_cast<float>(x * CELL - y * SKEW + 1), static_cast<float>(y * CELL)); };
            pts[0] = p(n[o + 1], n[o + 2]); pts[1] = p(n[o + 3], n[o + 2]); pts[2] = p(n[o + 3], n[o + 4]); pts[3] = p(n[o + 1], n[o + 4]);
            stroke = static_cast<int>(n[o + 5]);
            lw = static_cast<float>(n[o + 6]);
            screen_px = n[o + 7] != 0;
            on = n[o + 8];
            off = n[o + 9];
          }
          if (!visible({std::min(pts[3].x, pts[0].x), pts[0].y}, {std::max(pts[1].x, pts[2].x), pts[2].y})) break;
          if (fill >= 0) dl->AddConvexPolyFilled(pts, 4, color(fill));
          if (stroke >= 0) {
            float w = screen_px ? lw : lw * view.zoom;
            // dashes are in map pixels
            float k = view.zoom;
            if (on > 0) dashed(dl, pts, 4, color(stroke), w, static_cast<float>(on) * k, static_cast<float>(off) * k);
            else dl->AddPolyline(pts, 4, color(stroke), ImDrawFlags_Closed, w);
          }
          break;
        }
        case 4: alpha = static_cast<float>(n[o + 1]); break;
        case 7: {
          // big white text with a dark outline, so the art under it still shows
          const std::string& t = sc.strs[static_cast<size_t>(n[o + 1])];
          float size = 20 * view.zoom;
          ImVec2 ts = badge_font->CalcTextSizeA(size, FLT_MAX, 0, t.c_str());
          ImVec2 c = to_screen(static_cast<float>(n[o + 2]), static_cast<float>(n[o + 3]));
          ImVec2 tp{std::round(c.x - ts.x / 2), std::round(c.y - ts.y / 2)};
          if (!visible(tp, {tp.x + ts.x, tp.y + ts.y})) break;
          float r = std::max(1.0f, 1.5f * view.zoom);
          ImU32 dark = with_alpha(IM_COL32(0x06, 0x2a, 0x4d, 235));
          for (int k = 0; k < 8; k++) {
            float a = k * 0.785398f;
            dl->AddText(badge_font, size, {tp.x + std::cos(a) * r, tp.y + std::sin(a) * r}, dark, t.c_str());
          }
          dl->AddText(badge_font, size, tp, with_alpha(IM_COL32_WHITE), t.c_str());
          break;
        }
        case 6:
          draw_goal_popup(dl, static_cast<int>(n[o + 1]), static_cast<int>(n[o + 2]), sc.strs[static_cast<size_t>(n[o + 3])], sc.strs[static_cast<size_t>(n[o + 4])]);
          break;
      }
    }
  }

  /* The game's goal popup: a white speech bubble pointing at a spot 20px above the tile, with a
   * heading, the goal's target and "AT THIS LOCATION". At least the game's own size, so it stays
   * readable when zoomed out. */
  void draw_goal_popup(ImDrawList* dl, int tx, int ty, const std::string& head, const std::string& target) {
    const float k = std::max(1.0f, view.zoom);
    const char* lines[3] = {head.c_str(), target.c_str(), "AT THIS LOCATION"};
    const float sizes[3] = {13 * k, 12 * k, 8 * k};
    const float pad = 9 * k, gap = 3 * k;
    float w = 60 * k, h = 2 * pad;
    ImVec2 ts[3];
    for (int i = 0; i < 3; i++) {
      ts[i] = badge_font->CalcTextSizeA(sizes[i], FLT_MAX, 0, lines[i]);
      w = std::max(w, ts[i].x + 2 * pad);
      h += ts[i].y + (i ? gap : 0);
    }
    // the point's tip
    ImVec2 tip = to_screen(tx * CELL - ty * SKEW + 10, ty * CELL - 20);
    float tail = 8 * k;
    ImVec2 a{std::round(tip.x - w / 2), std::round(tip.y - tail - h)}, b{a.x + w, a.y + h};
    const ImU32 ink = IM_COL32(0, 0, 0, 255), paper = IM_COL32(255, 255, 255, 255);
    float r = 7 * k, line = std::max(2.0f, 2 * k);
    dl->AddRectFilled({a.x + 2 * k, a.y + 3 * k}, {b.x + 2 * k, b.y + 3 * k}, IM_COL32(0, 0, 0, 70), r);  // shadow
    dl->AddRectFilled(a, b, paper, r);
    dl->AddRect(a, b, ink, r, 0, line);
    ImVec2 t0{tip.x - 7 * k, b.y - line}, t1{tip.x + 7 * k, b.y - line};
    dl->AddTriangleFilled(t0, t1, tip, paper);
    dl->AddLine({t0.x, b.y - line / 2}, tip, ink, line);
    dl->AddLine({t1.x, b.y - line / 2}, tip, ink, line);
    float y = a.y + pad;
    for (int i = 0; i < 3; i++) {
      dl->AddText(badge_font, sizes[i], {std::round(a.x + (w - ts[i].x) / 2), std::round(y)}, ink, lines[i]);
      y += ts[i].y + gap;
    }
  }

  void draw_start_view(ImDrawList* dl) {
    // the game window's first view: dashed outline, and a dot on the center tile when one is set
    auto p = [&](int x, int y) { return to_screen(x * CELL - y * SKEW + 1, y * CELL); };
    ImVec2 pts[4] = {p(start_view[0], start_view[1]), p(start_view[2], start_view[1]), p(start_view[2], start_view[3]), p(start_view[0], start_view[3])};
    dashed(dl, pts, 4, css_color("#ffffffb0"), 2, 10 * view.zoom, 6 * view.zoom);
    if (start_view[6]) {
      ImVec2 c = to_screen(start_view[4] * CELL - start_view[5] * SKEW + 13, start_view[5] * CELL + 25);
      dl->AddCircleFilled(c, 5 * view.zoom, IM_COL32_WHITE);
      dl->AddCircle(c, 5 * view.zoom, css_color("#1b1b1b"), 0, 2 * view.zoom);
    }
  }

  // -------------------------------------------------------------- UI

  void map_input() {
    ImGuiIO& io = ImGui::GetIO();
    ImVec2 m{io.MousePos.x - map_min.x, io.MousePos.y - map_min.y};
    bool hovered = ImGui::IsItemHovered();
    bool space = ImGui::IsKeyDown(ImGuiKey_Space) && !io.WantTextInput;
    if (has_level && hovered && !panning && map_button < 0) {
      // ImGui: 0 left, 1 right, 2 middle
      for (int b = 0; b < 3; b++) {
        if (!ImGui::IsMouseClicked(b)) continue;
        update_hover(m.x, m.y);
        bool took = cell && call_bool("mouseDown", {js->num(cell->first), js->num(cell->second), js->num(b), JS_NewBool(js->host.ctx(), io.KeyShift),
                                                    JS_NewBool(js->host.ctx(), io.KeyCtrl), JS_NewBool(js->host.ctx(), io.KeyAlt), JS_NewBool(js->host.ctx(), space)});
        if (took) map_button = b;
        else if (b != 0 || space) panning = true;
        redraw = true;
        sync();
        break;
      }
    }
    if (panning) {
      if (io.MouseDelta.x != 0 || io.MouseDelta.y != 0) view_touched = true;
      view.x += io.MouseDelta.x;
      view.y += io.MouseDelta.y;
      if (!ImGui::IsMouseDown(0) && !ImGui::IsMouseDown(1) && !ImGui::IsMouseDown(2)) panning = false;
    }
    if (hovered && io.MouseWheel != 0 && has_level) zoom_at(m.x, m.y, std::exp(io.MouseWheel * 0.15f));
    update_hover(hovered || map_button >= 0 ? m.x : -1, hovered || map_button >= 0 ? m.y : -1);
    if (map_button >= 0 && !ImGui::IsMouseDown(map_button)) {
      map_button = -1;
      run("mouseUp");
      redraw = true;
    }
    sync();
    if (hovered && has_level) {
      if (panning) ImGui::SetMouseCursor(ImGuiMouseCursor_ResizeAll);
      else if (space) ImGui::SetMouseCursor(ImGuiMouseCursor_Hand);
      else {
        std::string c;
        try {
          JSValue v = js->call("cursor");
          c = js->host.string_of(v);
          js->free(v);
        } catch (const std::exception& e) {
          report(e);
        }
        ImGui::SetMouseCursor(c == "grabbing" ? ImGuiMouseCursor_ResizeAll : c == "grab" || c == "pointer" || c == "copy" ? ImGuiMouseCursor_Hand : ImGuiMouseCursor_Arrow);
      }
    }
  }

  // Editor shortcuts, when no text field has the keyboard
  void keys() {
    ImGuiIO& io = ImGui::GetIO();
    if (io.WantTextInput) return;
    static const std::pair<ImGuiKey, const char*> ks[] = {
        {ImGuiKey_B, "b"}, {ImGuiKey_F, "f"}, {ImGuiKey_E, "e"}, {ImGuiKey_I, "i"}, {ImGuiKey_S, "s"}, {ImGuiKey_L, "l"},
        {ImGuiKey_Z, "z"}, {ImGuiKey_Y, "y"}, {ImGuiKey_V, "v"}, {ImGuiKey_O, "o"},
        {ImGuiKey_Escape, "escape"}, {ImGuiKey_Delete, "delete"},
    };
    for (auto& [k, name] : ks) {
      if (!ImGui::IsKeyPressed(k, k == ImGuiKey_Z || k == ImGuiKey_Y)) continue;
      if (io.KeyAlt) continue;
      if (call_bool("key", {str(name), JS_NewBool(js->host.ctx(), io.KeyCtrl), JS_NewBool(js->host.ctx(), io.KeyShift)})) redraw = true;
    }
  }

  // NE[fn]() that draws ImGui widgets
  void draw_js(const char* fn) {
    try {
      js->free(js->call(fn));
    } catch (const std::exception& e) {
      report(e);
    }
  }

  void ui() {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(vp->WorkPos);
    ImGui::SetNextWindowSize(vp->WorkSize);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {0, 0});
    ImGui::SetNextWindowScroll({0, -1});  // never scrolled sideways (Shift+wheel)
    ImGui::Begin("##main", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_NoSavedSettings);
    ImGui::PopStyleVar();
    keys();

    float left_w = 230, side_w = 0;
    try {
      JSValue l = js->call("layout", {js->num(ImGui::GetContentRegionAvail().x / ui_scale)});
      left_w = static_cast<float>(js->num_at(l, 0)) * ui_scale;
      side_w = static_cast<float>(js->num_at(l, 1)) * ui_scale;
      js->free(l);
    } catch (const std::exception& e) {
      report(e);
    }
    const float grip = side_w > 0 ? 6 * ui_scale : 0;

    // level list
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {6, 6});
    ImGui::SetNextWindowScroll({0, -1});  // never scrolled sideways (Shift+wheel)
    ImGui::BeginChild("levels", {left_w, 0}, ImGuiChildFlags_Borders | ImGuiChildFlags_AlwaysUseWindowPadding);
    draw_js("drawLevels");
    ImGui::EndChild();
    ImGui::PopStyleVar();
    ImGui::SameLine(0, 0);

    // toolbar, map, status bar
    float mid_w = std::max(100.0f, ImGui::GetContentRegionAvail().x - side_w - grip);
    ImGui::SetNextWindowScroll({0, -1});  // never scrolled sideways (Shift+wheel)
    ImGui::BeginChild("middle", {mid_w, 0}, 0, ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
    ImGui::Dummy({0, 2});
    ImGui::Indent(8);
    draw_js("drawToolbar");
    if (has_level) {
      auto bw = [](const char* l) { return ImGui::CalcTextSize(l).x + ImGui::GetStyle().FramePadding.x * 2; };
      // right-aligned: on the toolbar's row when it fits there, otherwise on a row of its own
      std::string pct = std::to_string(static_cast<int>(std::lround(view.zoom * 100))) + "%";
      float zw = bw("-") + bw(pct.c_str()) + bw("+") + bw("Fit") + 3 * ImGui::GetStyle().ItemSpacing.x;
      float right = ImGui::GetWindowPos().x + ImGui::GetWindowSize().x - 8;  // the toolbar's 8px indent, mirrored
      bool fits = ImGui::GetItemRectMax().x + ImGui::GetStyle().ItemSpacing.x + zw <= right;
      if (fits) ImGui::SameLine();
      ImGui::SetCursorScreenPos({std::max(ImGui::GetCursorScreenPos().x, right - zw), ImGui::GetCursorScreenPos().y});
      if (ImGui::Button("-")) zoom_at(map_size.x / 2, map_size.y / 2, 0.8f);
      ImGui::SetItemTooltip("Zoom out");
      ImGui::SameLine();
      if (ImGui::Button(pct.c_str())) {
        zoom_at(map_size.x / 2, map_size.y / 2, 1 / view.zoom);
        view.x = std::round(view.x);
        view.y = std::round(view.y);
      }
      ImGui::SetItemTooltip("100%%: the game's own size");
      ImGui::SameLine();
      if (ImGui::Button("+")) zoom_at(map_size.x / 2, map_size.y / 2, 1.25f);
      ImGui::SetItemTooltip("Zoom in");
      ImGui::SameLine();
      if (ImGui::Button("Fit")) { user_zoom = 0; fit_view(); }
      ImGui::SetItemTooltip("Fit the map to the window");
    } else {
      ImGui::NewLine();
    }
    ImGui::Unindent(8);

    float status_h = ImGui::GetFrameHeightWithSpacing();
    ImVec2 avail = ImGui::GetContentRegionAvail();
    map_min = ImGui::GetCursorScreenPos();
    map_size = {avail.x, std::max(50.0f, avail.y - status_h)};
    // with no level the map is only a backdrop: an InvisibleButton here would take the clicks meant
    // for the welcome screen's Open button, which is drawn over it
    if (has_level) ImGui::InvisibleButton("map", map_size, ImGuiButtonFlags_MouseButtonLeft | ImGuiButtonFlags_MouseButtonRight | ImGuiButtonFlags_MouseButtonMiddle);
    else ImGui::Dummy(map_size);
    if (has_level && !view_touched && (map_size.x != fitted_size.x || map_size.y != fitted_size.y)) fit_pending = true;
    if (fit_pending && has_level) { fit_view(); fit_pending = false; }
    map_input();

    ImDrawList* dl = ImGui::GetWindowDrawList();
    dl->PushClipRect(map_min, {map_min.x + map_size.x, map_min.y + map_size.y}, true);
    dl->AddRectFilledMultiColor(map_min, {map_min.x + map_size.x, map_min.y + map_size.y}, css_color("#1b3352"), css_color("#1b3352"), css_color("#0b1522"), css_color("#0b1522"));
    if (has_level) {
      draw_scene(dl, scene);
      if (show_view) draw_start_view(dl);
      rebuild_overlay();
      draw_scene(dl, over);
    }
    dl->PopClipRect();
    if (!has_level) {
      // welcome: the icon, the name, an Open button and the version
      if (!logo && (logo = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_RGBA32, SDL_TEXTUREACCESS_STATIC, 128, 128))) {
        SDL_UpdateTexture(logo, nullptr, kIconRgba128, 128 * 4);
        SDL_SetTextureBlendMode(logo, SDL_BLENDMODE_BLEND);
        SDL_SetTextureScaleMode(logo, SDL_SCALEMODE_LINEAR);
      }
      if (logo) {
        float sz = std::min(128.0f, 96 * ui_scale);
        ImVec2 a{map_min.x + (map_size.x - sz) / 2, map_min.y + map_size.y / 2 - 62 * ui_scale - sz};
        ImGui::GetWindowDrawList()->AddImage(static_cast<ImTextureID>(reinterpret_cast<intptr_t>(logo)), a, {a.x + sz, a.y + sz});
      }
      const char* t = "WorldBuilder Level Editor";
      ImVec2 ts = ImGui::CalcTextSize(t);
      ImGui::SetCursorScreenPos({map_min.x + (map_size.x - ts.x) / 2, map_min.y + map_size.y / 2 - 50});
      ImGui::TextUnformatted(t);
      ImGui::SetCursorScreenPos({map_min.x + map_size.x / 2 - 110 * ui_scale, map_min.y + map_size.y / 2 - 20 * ui_scale});
      if (ImGui::Button("Open Launcher.exe...", {220 * ui_scale, 40 * ui_scale})) file_dialog("open", false, "", "exe");
      const char* v = "Version " WBE_VERSION;
      ImGui::SetCursorScreenPos({map_min.x + (map_size.x - ImGui::CalcTextSize(v).x) / 2, map_min.y + map_size.y / 2 + 30 * ui_scale});
      ImGui::TextDisabled("%s", v);
      ImGui::SetCursorScreenPos({map_min.x, map_min.y + map_size.y});
    }

    ImGui::Indent(8);
    ImGui::AlignTextToFramePadding();
    if (!js_error.empty()) {
      ImGui::TextColored({1, 0.36f, 0.36f, 1}, "Error: %s", js_error.c_str());
      ImGui::SameLine();
      if (ImGui::SmallButton("x")) js_error.clear();
    } else {
      try {
        JSValue s = js->call("statusLine");
        std::string st = js->str_at(s, 0), hv = js->str_at(s, 1);
        js->free(s);
        ImGui::TextUnformatted(st.c_str());
        if (!hv.empty()) {
          ImGui::SameLine(0, 24);
          ImGui::TextDisabled("%s", hv.c_str());
        }
      } catch (const std::exception& e) {
        report(e);
      }
    }
    ImGui::Unindent(8);
    ImGui::EndChild();

    // side panel, with a grip on its left edge to resize it
    if (side_w > 0) {
      ImGui::SameLine(0, 0);
      ImGui::InvisibleButton("grip", {grip, ImGui::GetContentRegionAvail().y});
      if (ImGui::IsItemHovered() || ImGui::IsItemActive()) ImGui::SetMouseCursor(ImGuiMouseCursor_ResizeEW);
      if (ImGui::IsItemActive() && ImGui::GetIO().MouseDelta.x != 0) run("setSideWidth", {js->num((side_w - ImGui::GetIO().MouseDelta.x) / ui_scale)});
      if (ImGui::IsItemHovered() && ImGui::IsMouseDoubleClicked(0)) run("setSideWidth", {js->num(360)});
      ImGui::SameLine(0, 0);
      ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {8, 6});
      ImGui::SetNextWindowScroll({0, -1});  // never scrolled sideways (Shift+wheel)
      ImGui::BeginChild("side", {0, 0}, ImGuiChildFlags_Borders | ImGuiChildFlags_AlwaysUseWindowPadding);
      draw_js("drawSide");
      ImGui::EndChild();
      ImGui::PopStyleVar();
    }
    draw_js("drawModals");
    ImGui::End();
  }

  // After a frame: what the panels started (files, saving), and what they changed
  void after_frame() {
    if (call_bool("hasJobs")) {
      run_async("runJobs");
      redraw = true;
    }
    sync();
  }
};

// ---------------------------------------------------------------- benchmark (WBE_SWEEP=1)
// A synthetic test (the one the 1.0 Electron editor was measured with): 240 frames hovering over
// tiles, then 240 frames panning, at the same positions; prints CPU (all threads) and memory.

double cpu_ms() { return wbe::process_cpu_ms(); }
long pss_kb() { return wbe::memory_kb(); }

struct Sweep {
  int phase = 0, frame = 0;  // 0 settle, 1 idle, 2 hover, 3 pan, 4 done
  double cpu0 = 0;
  Uint64 t0 = 0;
  std::string out;
  ImVec2 last{};
  ImVec2 pos(App& app, int i) {
    return {100.0f + static_cast<float>((i * 7) % static_cast<int>(app.map_size.x - 200)), 100.0f + static_cast<float>((i * 13) % static_cast<int>(app.map_size.y - 200))};
  }
  void mark(const char* name) {
    char buf[160];
    std::snprintf(buf, sizeof buf, "\"%s\": {\"wallMs\": %.0f, \"cpuMs\": %.0f}, ", name, (SDL_GetTicksNS() - t0) / 1e6, cpu_ms() - cpu0);
    out += buf;
  }
  void start() { cpu0 = cpu_ms(); t0 = SDL_GetTicksNS(); frame = 0; }
  // before each frame; returns false when it's finished
  bool step(App& app) {
    if (phase == 0 && frame == 0) {
      char buf[64];
      std::snprintf(buf, sizeof buf, "\"openedMs\": %llu, ", static_cast<unsigned long long>(SDL_GetTicks()));
      out += buf;  // launch to the first frame of the opened map (SDL_Init is at the start of main)
    }
    if (phase == 0 && ++frame > 30) { phase = 1; start(); }
    else if (phase == 1) {
      // idle: nothing happens for as long as the hover test takes at 60 fps; the editor draws nothing
      if (SDL_GetTicksNS() - t0 > 4000000000ull) { mark("idle4s"); phase = 2; start(); }
      else SDL_Delay(50);
    } else if (phase == 2) {
      ImVec2 p = pos(app, frame);
      Uint64 h0 = SDL_GetTicksNS();
      app.update_hover(p.x, p.y);
      prof_hover += (SDL_GetTicksNS() - h0) / 1e6;
      if (++frame >= 240) { mark("hover"); phase = 3; start(); last = pos(app, 0); }
    } else if (phase == 3) {
      ImVec2 p = pos(app, frame);
      app.view.x += p.x - last.x;
      app.view.y += p.y - last.y;
      last = p;
      if (++frame >= 240) { mark("pan"); phase = 4; }
    }
    return phase != 4;
  }
};

/* ImGui's draw data on an SDL_Renderer. Replaces ImGui_ImplSDLRenderer3_RenderDrawData, which
 * (1.92) hands SDL every vertex from a draw call's start to the end of its list, so a list of N
 * vertices in K draw calls costs about K×N colour conversions (the map: 55 calls over 12k vertices,
 * ~3.6 ms a frame), and which sets every texture to linear filtering, undoing the map's sharp
 * pixels when zoomed in. Here each call gets just the vertices its indices use, and textures keep
 * their own filtering. */
void render_draw_data(ImDrawData* dd, SDL_Renderer* renderer) {
  int fb_w = static_cast<int>(dd->DisplaySize.x * dd->FramebufferScale.x), fb_h = static_cast<int>(dd->DisplaySize.y * dd->FramebufferScale.y);
  if (fb_w <= 0 || fb_h <= 0) return;
  if (dd->Textures)
    for (ImTextureData* t : *dd->Textures)
      if (t->Status != ImTextureStatus_OK) ImGui_ImplSDLRenderer3_UpdateTexture(t);
  SDL_SetRenderViewport(renderer, nullptr);
  static std::vector<SDL_FColor> colors;
  static std::vector<int> idx;
  const ImVec2 off = dd->DisplayPos, scale = dd->FramebufferScale;
  for (const ImDrawList* dl : dd->CmdLists) {
    const ImDrawVert* vtx = dl->VtxBuffer.Data;
    const ImDrawIdx* ib = dl->IdxBuffer.Data;
    for (const ImDrawCmd& cmd : dl->CmdBuffer) {
      if (cmd.UserCallback) {
        if (cmd.UserCallback != ImDrawCallback_ResetRenderState) cmd.UserCallback(dl, &cmd);
        continue;
      }
      ImVec2 c0{std::max(0.0f, (cmd.ClipRect.x - off.x) * scale.x), std::max(0.0f, (cmd.ClipRect.y - off.y) * scale.y)};
      ImVec2 c1{std::min(static_cast<float>(fb_w), (cmd.ClipRect.z - off.x) * scale.x), std::min(static_cast<float>(fb_h), (cmd.ClipRect.w - off.y) * scale.y)};
      if (c1.x <= c0.x || c1.y <= c0.y || cmd.ElemCount == 0) continue;
      SDL_Rect clip{static_cast<int>(c0.x), static_cast<int>(c0.y), static_cast<int>(c1.x - c0.x), static_cast<int>(c1.y - c0.y)};
      SDL_SetRenderClipRect(renderer, &clip);
      // the vertices this call uses
      const ImDrawIdx* ci = ib + cmd.IdxOffset;
      unsigned lo = ~0u, hi = 0;
      for (unsigned i = 0; i < cmd.ElemCount; i++) { lo = std::min<unsigned>(lo, ci[i]); hi = std::max<unsigned>(hi, ci[i]); }
      const ImDrawVert* v = vtx + cmd.VtxOffset + lo;
      int n = static_cast<int>(hi - lo + 1);
      idx.resize(cmd.ElemCount);
      for (unsigned i = 0; i < cmd.ElemCount; i++) idx[i] = static_cast<int>(ci[i] - lo);
      colors.resize(n);
      for (int i = 0; i < n; i++) {
        ImU32 c = v[i].col;
        colors[i] = {(c & 255) / 255.0f, ((c >> 8) & 255) / 255.0f, ((c >> 16) & 255) / 255.0f, (c >> 24) / 255.0f};
      }
      SDL_RenderGeometryRaw(renderer, reinterpret_cast<SDL_Texture*>(static_cast<intptr_t>(cmd.GetTexID())),
                            &v->pos.x, sizeof(ImDrawVert), colors.data(), sizeof(SDL_FColor), &v->uv.x, sizeof(ImDrawVert),
                            n, idx.data(), static_cast<int>(cmd.ElemCount), sizeof(int));
    }
  }
  SDL_SetRenderClipRect(renderer, nullptr);
}

// The first of these font files that exists; merge: add its glyphs to the last font loaded
ImFont* load_font(const std::vector<std::string>& candidates, float size, bool merge = false) {
  ImFontConfig cfg;
  cfg.MergeMode = merge;
  for (const std::string& p : candidates) {
    if (SDL_GetPathInfo(p.c_str(), nullptr)) return ImGui::GetIO().Fonts->AddFontFromFileTTF(p.c_str(), size, &cfg);
  }
  return nullptr;
}

/* The editor's look (from the 1.0 editor's style sheet): dark slate panels, blue for what's
 * selected, yellow for accents, rounded 6px controls and the Fredoka font. */
namespace theme {
const ImVec4 bg = rgb(0x15171c), panel = rgb(0x1d2027), panel2 = rgb(0x252933), line = rgb(0x333845), text = rgb(0xe7e9ee),
             muted = rgb(0x9097a6), yellow = rgb(0xffcf1a), blue = rgb(0x2a7de1), hover = rgb(0x2c313d), sel = rgb(0x2b3446);
}

void apply_style() {
  using namespace theme;
  ImGuiStyle& st = ImGui::GetStyle();
  st.WindowPadding = {10, 10};
  st.FramePadding = {9, 4};
  st.ItemSpacing = {6, 6};
  st.ItemInnerSpacing = {6, 4};
  st.IndentSpacing = 16;
  st.ScrollbarSize = 10;
  st.GrabMinSize = 12;
  st.WindowRounding = 10;
  st.ChildRounding = 0;
  st.FrameRounding = 6;
  st.PopupRounding = 6;
  st.ScrollbarRounding = 6;
  st.GrabRounding = 6;
  st.TabRounding = 0;
  st.WindowBorderSize = 1;
  st.ChildBorderSize = 1;
  st.PopupBorderSize = 1;
  st.FrameBorderSize = 1;
  st.TabBorderSize = 0;
  st.TabBarBorderSize = 1;
  st.TabBarOverlineSize = 0;
  st.SeparatorTextBorderSize = 1;
  st.SeparatorTextPadding = {0, 4};
  st.SeparatorTextAlign = {0, 0.5f};
  st.WindowTitleAlign = {0, 0.5f};
  st.SelectableTextAlign = {0, 0.5f};

  ImVec4* c = st.Colors;
  c[ImGuiCol_Text] = text;
  c[ImGuiCol_TextDisabled] = muted;
  c[ImGuiCol_WindowBg] = bg;
  c[ImGuiCol_ChildBg] = panel;
  c[ImGuiCol_PopupBg] = panel;
  c[ImGuiCol_Border] = line;
  c[ImGuiCol_BorderShadow] = {0, 0, 0, 0};
  c[ImGuiCol_FrameBg] = bg;
  c[ImGuiCol_FrameBgHovered] = rgb(0x1a1d23);
  c[ImGuiCol_FrameBgActive] = rgb(0x1a1d23);
  c[ImGuiCol_TitleBg] = panel2;
  c[ImGuiCol_TitleBgActive] = panel2;
  c[ImGuiCol_TitleBgCollapsed] = panel2;
  c[ImGuiCol_MenuBarBg] = panel;
  c[ImGuiCol_ScrollbarBg] = {0, 0, 0, 0};
  c[ImGuiCol_ScrollbarGrab] = line;
  c[ImGuiCol_ScrollbarGrabHovered] = rgb(0x4a5163);
  c[ImGuiCol_ScrollbarGrabActive] = muted;
  c[ImGuiCol_CheckMark] = rgb(0xffffff);
  c[ImGuiCol_SliderGrab] = blue;
  c[ImGuiCol_SliderGrabActive] = rgb(0x3a8bf0);
  c[ImGuiCol_Button] = panel2;
  c[ImGuiCol_ButtonHovered] = hover;
  c[ImGuiCol_ButtonActive] = rgb(0x343a48);
  c[ImGuiCol_Header] = sel;
  c[ImGuiCol_HeaderHovered] = rgb(0x262b36);
  c[ImGuiCol_HeaderActive] = sel;
  c[ImGuiCol_Separator] = line;
  c[ImGuiCol_SeparatorHovered] = blue;
  c[ImGuiCol_SeparatorActive] = blue;
  c[ImGuiCol_ResizeGrip] = {0, 0, 0, 0};
  c[ImGuiCol_ResizeGripHovered] = blue;
  c[ImGuiCol_ResizeGripActive] = blue;
  c[ImGuiCol_InputTextCursor] = text;
  c[ImGuiCol_Tab] = panel;
  c[ImGuiCol_TabHovered] = panel2;
  c[ImGuiCol_TabSelected] = panel;
  c[ImGuiCol_TabSelectedOverline] = yellow;
  c[ImGuiCol_TabDimmed] = panel;
  c[ImGuiCol_TabDimmedSelected] = panel;
  c[ImGuiCol_TabDimmedSelectedOverline] = yellow;
  c[ImGuiCol_TextSelectedBg] = ImVec4(blue.x, blue.y, blue.z, 0.45f);
  c[ImGuiCol_DragDropTarget] = yellow;
  c[ImGuiCol_NavCursor] = blue;
  c[ImGuiCol_ModalWindowDimBg] = {0, 0, 0, 0.62f};
}

}  // namespace

int main(int argc, char** argv) {
  if (!SDL_Init(SDL_INIT_VIDEO)) {
    std::fprintf(stderr, "SDL: %s\n", SDL_GetError());
    return 1;
  }
  App app;
  app.wake_event = SDL_RegisterEvents(1);
  {
    // 1400×900 at the display's scale, but no bigger than the screen
    SDL_DisplayID d = SDL_GetPrimaryDisplay();
    float k = d ? SDL_GetDisplayContentScale(d) : 1;
    if (!(k > 0.5f)) k = 1;
    int w = static_cast<int>(1400 * k), h = static_cast<int>(900 * k);
    SDL_Rect r;
    if (d && SDL_GetDisplayUsableBounds(d, &r)) { w = std::min(w, r.w); h = std::min(h, r.h); }
    app.window = SDL_CreateWindow("WorldBuilder Level Editor", w, h, SDL_WINDOW_RESIZABLE);
  }
  if (app.window) {
    if (SDL_Surface* icon = SDL_CreateSurfaceFrom(64, 64, SDL_PIXELFORMAT_RGBA32, const_cast<unsigned char*>(kIconRgba), 64 * 4)) {
      SDL_SetWindowIcon(app.window, icon);
      SDL_DestroySurface(icon);
    }
  }
  const char* want = std::getenv("WBE_RENDERER");
  // WBE_RENDERER, else SDL's choice; if that fails (an old graphics driver, a virtual machine,
  // remote desktop), the next one down until one works
  if (app.window) {
    if (want && *want) app.renderer = SDL_CreateRenderer(app.window, want);
    if (!app.renderer) app.renderer = SDL_CreateRenderer(app.window, nullptr);
    for (const char* r : {"direct3d11", "direct3d", "opengl", "software"}) {
      if (app.renderer) break;
      app.renderer = SDL_CreateRenderer(app.window, r);
    }
  }
  if (!app.window || !app.renderer) {
    std::fprintf(stderr, "SDL: %s\n", SDL_GetError());
    return 1;
  }
  SDL_SetRenderVSync(app.renderer, 1);

  IMGUI_CHECKVERSION();
  ImGui::CreateContext();
  ImGuiIO& io = ImGui::GetIO();
  io.IniFilename = nullptr;
  app.set_ui_scale(SDL_GetWindowDisplayScale(app.window));
  // Fredoka (fonts/), and a system font for the symbols it lacks
  // (✓ ⚠ ● …): DejaVu on Linux, Segoe UI Symbol on Windows (7 and later), else Arial
  const std::string fonts = wbe::JsHost::editor_dir() + "/fonts/";
  const char* windir = std::getenv("WINDIR");
  const std::string win = std::string(windir ? windir : "C:\\Windows") + "\\Fonts\\";
  const std::vector<std::string> ui_main = {fonts + "Fredoka-Regular.ttf"}, bold_main = {fonts + "Fredoka-SemiBold.ttf"};
  const std::vector<std::string> ui_fonts = {"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
                                             "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", win + "seguisym.ttf",
                                             win + "segoeui.ttf", win + "arial.ttf"};
  const std::vector<std::string> bold_fonts = {"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
                                               "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", win + "segoeuib.ttf",
                                               win + "arialbd.ttf"};
  app.ui_font = load_font(ui_main, 16);
  if (app.ui_font) load_font(ui_fonts, 15, true);
  else app.ui_font = load_font(ui_fonts, 15);
  if (!app.ui_font) app.ui_font = io.Fonts->AddFontDefault();
  // map labels (Fredoka 600, 11px)
  app.badge_font = load_font(bold_main, 11);
  if (!app.badge_font) app.badge_font = load_font(bold_fonts, 11);
  if (!app.badge_font) app.badge_font = app.ui_font;
  ImGui_ImplSDL3_InitForSDLRenderer(app.window, app.renderer);
  ImGui_ImplSDLRenderer3_Init(app.renderer);

  try {
    app.js.emplace(&app);
  } catch (const std::exception& e) {
    std::fprintf(stderr, "Couldn't load the editor's scripts: %s\n", e.what());
    return 1;
  }
  if (const char* z = std::getenv("WBE_ZOOM")) app.user_zoom = static_cast<float>(std::atof(z));  // e.g. 1 for 100%
  io.ConfigErrorRecoveryEnableAssert = false;  // a script error mid-panel is reported, not fatal
  if (const char* l = std::getenv("WBE_LEVEL")) app.want_level = l;
  if (argc > 1) app.open_start_file(argv[1]);
  app.sync();

  // Draw only when something happened (a few frames after, so ImGui settles)
  int frames = 3;
  std::optional<Sweep> sweep;
  if (std::getenv("WBE_SWEEP")) sweep.emplace();
  const char* bench = std::getenv("WBE_BENCH");  // seconds: quit after that long, printing timings
  Uint64 quit_at = bench ? SDL_GetTicks() + static_cast<Uint64>(std::atof(bench) * 1000) : 0;
  for (bool running = true; running;) {
    SDL_Event e;
    // ImGui shows a tooltip once the mouse has rested on an item for a moment; while one is on its way,
    // wake up to draw it instead of sleeping until the mouse moves again
    const ImGuiContext& g = *ImGui::GetCurrentContext();
    bool tooltip_due = g.HoverItemDelayId != 0 && g.HoverItemDelayTimer < 0.6f;
    int wait = quit_at ? 100 : tooltip_due ? 30 : -1;
    bool got = frames > 0 || sweep ? SDL_PollEvent(&e) : SDL_WaitEventTimeout(&e, wait);
    if (!got && tooltip_due && frames <= 0) frames = 1;
    while (got) {
      ImGui_ImplSDL3_ProcessEvent(&e);
      if (e.type == SDL_EVENT_QUIT || (e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED && e.window.windowID == SDL_GetWindowID(app.window))) {
        if (quit_at) app.quit_now = true; else app.request_quit();
      }
      if (e.type == SDL_EVENT_WINDOW_DISPLAY_SCALE_CHANGED) app.set_ui_scale(SDL_GetWindowDisplayScale(app.window));
      if (e.type == SDL_EVENT_DROP_FILE && e.drop.data) {
        std::lock_guard lock(app.dialog_mutex);
        app.dialog_results.emplace_back("drop", std::string(e.drop.data));
      }
      frames = 3;
      got = SDL_PollEvent(&e);
    }
    app.deliver_dialogs();
    if (app.quit_now) running = false;
    const char* shot = std::getenv("WBE_SHOT");  // with WBE_BENCH: save the last frame there (.bmp)
    bool last = quit_at && SDL_GetTicks() >= quit_at;
    if (last) { running = false; frames = 1; }
    if (sweep) {
      if (sweep->step(app)) frames = sweep->phase == 1 ? 0 : 1;
      else {
        std::printf("RENDERER %s\n", SDL_GetRendererName(app.renderer));
        std::printf("SPLIT wall/cpu ms: clear %.0f/%.0f, drawdata %.0f/%.0f, present %.0f/%.0f\n", prof_t[0], prof_c[0], prof_t[1], prof_c[1], prof_t[2], prof_c[2]);
        std::printf("PROF hover-js %.0f ms, ui+drawlists %.0f ms, render-submit %.0f ms\n", prof_hover, prof_ui, prof_render);
        std::printf("SWEEP {%s\"pssMB\": %.1f, \"status\": \"%s\"}\n", sweep->out.c_str(), pss_kb() / 1024.0, app.status_text().c_str());
        running = false;
      }
    }
    if (frames <= 0) continue;
    frames--;
    ImGui_ImplSDLRenderer3_NewFrame();
    ImGui_ImplSDL3_NewFrame();
    ImGui::NewFrame();
    Uint64 u0 = SDL_GetTicksNS();
    app.ui();
    ImGui::Render();
    app.after_frame();
    if (app.redraw) { frames = std::max(frames, 2); app.redraw = false; }
    Uint64 u1 = SDL_GetTicksNS();
    bool prof = sweep && sweep->phase >= 2;
    auto lap = [&, w = SDL_GetTicksNS(), c = thread_cpu_ms()](int k) mutable {
      if (prof) { prof_t[k] += (SDL_GetTicksNS() - w) / 1e6; prof_c[k] += thread_cpu_ms() - c; }
      w = SDL_GetTicksNS(); c = thread_cpu_ms();
    };
    SDL_SetRenderDrawColor(app.renderer, 0x15, 0x17, 0x1c, 255);
    SDL_RenderClear(app.renderer);
    lap(0);
    render_draw_data(ImGui::GetDrawData(), app.renderer);
    lap(1);
    if (last && shot) {
      if (SDL_Surface* px = SDL_RenderReadPixels(app.renderer, nullptr)) { SDL_SaveBMP(px, shot); SDL_DestroySurface(px); }
    }
    if (sweep && sweep->phase >= 2 && sweep->frame == 1) std::printf("FRAME vertices %d, indices %d, draw calls %d\n", ImGui::GetDrawData()->TotalVtxCount, ImGui::GetDrawData()->TotalIdxCount, [] { int n = 0; for (auto* l : ImGui::GetDrawData()->CmdLists) n += l->CmdBuffer.Size; return n; }());
    if (sweep && sweep->phase >= 2) { prof_ui += (u1 - u0) / 1e6; prof_render += (SDL_GetTicksNS() - u1) / 1e6; }
    SDL_RenderPresent(app.renderer);
    lap(2);
  }
  if (quit_at) std::printf("status: %s\n", app.status_text().c_str());

  app.clear_sprites();
  if (app.logo) SDL_DestroyTexture(app.logo);
  app.js.reset();
  ImGui_ImplSDLRenderer3_Shutdown();
  ImGui_ImplSDL3_Shutdown();
  ImGui::DestroyContext();
  SDL_DestroyRenderer(app.renderer);
  SDL_DestroyWindow(app.window);
  SDL_Quit();
  return 0;
}
