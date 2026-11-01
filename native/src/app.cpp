// WorldBuilder Level Editor, native build (stage 2): open a Launcher.exe, pick a level, look at
// its map (pan, zoom, hover). The game file handling and what the map looks like come from the
// editor's own JS (wbcore.js, scene.js) running in QuickJS; this draws it with SDL3 + Dear ImGui.
//
//   worldbuilder-native [Launcher.exe]
//   WBE_RENDERER=software|opengl|vulkan  pick SDL's renderer (default: SDL's choice)
#include <SDL3/SDL.h>
#include <SDL3/SDL_main.h>
#include <sys/resource.h>
#include <time.h>

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
#include "imgui_impl_sdl3.h"
#include "imgui_impl_sdlrenderer3.h"
#include "js_host.h"

namespace {

constexpr float CELL = 50, SKEW = 25;  // map projection (scene.js)

// ---------------------------------------------------------------- JS calls

struct Js {
  wbe::JsHost host;
  JSValue ne = JS_UNDEFINED;

  Js() {
    host.load_editor_script("wb1monsters.js");
    host.load_editor_script("wbcore.js");
    host.load_editor_script("scene.js");
    host.load_editor_script("native/js/editor.js");
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
    pages.push_back({t});
    return place(r, w, h, at_x, at_y);
  }
  void set_scale(SDL_ScaleMode m) { for (Page& p : pages) SDL_SetTextureScaleMode(p.tex, m); }
  void clear() {
    for (Page& p : pages) SDL_DestroyTexture(p.tex);
    pages.clear();
  }
};

struct Level {
  int world, mission;
  std::string title, member;
};

struct Scene {
  std::vector<double> nums;  // 10 per command, see editor.js
  std::vector<std::string> strs;
  std::vector<ImU32> colors;  // strs read as colours (where they are colours)
};

struct View {
  float x = 0, y = 0, zoom = 1;
};

double prof_hover = 0, prof_ui = 0, prof_render = 0;  // ms, for WBE_SWEEP
double prof_t[3] = {}, prof_c[3] = {};  // clear, draw data, present: wall and thread-CPU ms
double thread_cpu_ms() { timespec t; clock_gettime(CLOCK_THREAD_CPUTIME_ID, &t); return t.tv_sec * 1e3 + t.tv_nsec / 1e6; }

struct App {
  SDL_Window* window = nullptr;
  SDL_Renderer* renderer = nullptr;
  std::optional<Js> js;
  ImFont* ui_font = nullptr;
  ImFont* badge_font = nullptr;

  std::string file_name, status = "Open a World Builder Launcher.exe to start.";
  int edition = 0;
  std::vector<Level> levels;
  int cur = -1;
  int map_w = 0, map_h = 0;
  Scene scene;
  std::unordered_map<std::string, Sprite> sprites;
  Atlas atlas;
  std::vector<SDL_Texture*> big;  // sprites too big for an atlas page
  bool smooth = false;  // sprites are filtered (zoomed out) or sharp (zoomed in)
  View view;
  float user_zoom = 0;  // zoom chosen by the user; 0 fits each map to the window
  bool show_grid = true, show_view = true;
  std::optional<std::pair<int, int>> hover;
  std::string hover_text;
  ImVec2 map_min, map_size;
  bool fit_pending = false;
  std::array<int, 7> start_view{};

  std::mutex dialog_mutex;
  std::optional<std::string> dialog_result;
  Uint32 wake_event = 0;

  // -------------------------------------------------------------- game

  void open(const std::string& path) {
    try {
      auto t0 = SDL_GetTicks();
      auto bytes = wbe::read_file(path);
      clear_sprites();
      levels.clear();
      cur = -1;
      JSValue r = js->host.await(js->call("open", {js->host.new_bytes(bytes)}));
      {
        JSValue e = js->prop(r, "edition");
        double d = 0;
        JS_ToFloat64(js->host.ctx(), &d, e);
        js->free(e);
        edition = static_cast<int>(d);
      }
      JSValue lv = js->prop(r, "levels");
      for (int64_t i = 0, n = js->length(lv); i < n; i++) {
        JSValue l = JS_GetPropertyInt64(js->host.ctx(), lv, i);
        levels.push_back({static_cast<int>(js->num_at(l, 0)), static_cast<int>(js->num_at(l, 1)), js->str_at(l, 2), js->str_at(l, 3)});
        js->free(l);
      }
      js->free(lv);
      js->free(r);
      file_name = path.substr(path.find_last_of("/\\") + 1);
      SDL_SetWindowTitle(window, (file_name + " · WorldBuilder Level Editor").c_str());
      // WBE_LEVEL=<member> (e.g. map1.1) opens that level, else world 1 mission 1
      const char* want = std::getenv("WBE_LEVEL");
      int first = 0;
      for (size_t i = 0; i < levels.size(); i++) {
        if (want ? levels[i].member == want : levels[i].world == 1 && levels[i].mission == 1) { first = static_cast<int>(i); break; }
      }
      select_level(first);
      status = "Opened " + file_name + " (" + std::to_string(SDL_GetTicks() - t0) + " ms).";
    } catch (const std::exception& e) {
      status = std::string("Couldn't open that file: ") + e.what();
      SDL_Log("%s", status.c_str());
    }
  }

  void select_level(int i) {
    cur = i;
    JSValue s = js->call("size", {js->num(i)});
    map_w = static_cast<int>(js->num_at(s, 0));
    map_h = static_cast<int>(js->num_at(s, 1));
    js->free(s);
    JSValue sv = js->call("startView", {js->num(i)});
    for (int k = 0; k < 7; k++) start_view[k] = static_cast<int>(js->num_at(sv, k));
    js->free(sv);
    hover.reset();
    fit_pending = true;  // once the map area's size is known
    rebuild_scene();
  }

  // The level's map as scene.js draws it, loading the sprites it uses until it has them all
  void rebuild_scene() {
    for (int pass = 0; pass < 4; pass++) {
      JSValue r = js->call("scene", {js->num(cur), JS_NewBool(js->host.ctx(), show_grid)});
      JSValue nums = js->prop(r, "nums"), strs = js->prop(r, "strs");
      size_t off = 0, len = 0, bpe = 0;
      JSValue buf = js->host.check(JS_GetTypedArrayBuffer(js->host.ctx(), nums, &off, &len, &bpe));
      size_t blen = 0;
      uint8_t* p = JS_GetArrayBuffer(js->host.ctx(), &blen, buf);
      scene.nums.assign(reinterpret_cast<double*>(p + off), reinterpret_cast<double*>(p + off + len));
      scene.strs.clear();
      for (int64_t k = 0, n = js->length(strs); k < n; k++) scene.strs.push_back(js->str_at(strs, k));
      scene.colors.clear();
      for (auto& s : scene.strs) scene.colors.push_back(!s.empty() && s[0] == '#' ? css_color(s) : 0);
      for (JSValue v : {buf, nums, strs, r}) js->free(v);

      JSValue pending = js->call("hasPending");
      bool more = JS_ToBool(js->host.ctx(), pending);
      js->free(pending);
      if (!more) return;
      load_pending_sprites();
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
          big.push_back(s.tex);
        }
      }
      sprites[name] = s;
      js->free(px);
      js->free(e);
    }
    js->free(list);
  }

  void clear_sprites() {
    atlas.clear();
    for (SDL_Texture* t : big) SDL_DestroyTexture(t);
    big.clear();
    sprites.clear();
  }

  // Like the canvas: smoothing only when zoomed out
  void set_smooth(bool on) {
    if (on == smooth) return;
    smooth = on;
    SDL_ScaleMode m = on ? SDL_SCALEMODE_LINEAR : SDL_SCALEMODE_NEAREST;
    atlas.set_scale(m);
    for (SDL_Texture* t : big) SDL_SetTextureScaleMode(t, m);
  }

  void fit_view() {
    JSValue v = js->call("fit", {js->num(cur), js->num(map_size.x), js->num(map_size.y), js->num(user_zoom)});
    view = {static_cast<float>(js->num_at(v, 0)), static_cast<float>(js->num_at(v, 1)), static_cast<float>(js->num_at(v, 2))};
    js->free(v);
  }

  void zoom_at(float sx, float sy, float f) {
    float nz = std::clamp(view.zoom * f, 0.15f, 4.0f);
    view.x = sx - (sx - view.x) * nz / view.zoom;
    view.y = sy - (sy - view.y) * nz / view.zoom;
    view.zoom = user_zoom = nz;
  }

  void update_hover(float sx, float sy) {
    std::optional<std::pair<int, int>> h;
    if (cur >= 0 && sx >= 0 && sy >= 0 && sx < map_size.x && sy < map_size.y) {
      JSValue c = js->call("cellAt", {js->num(view.x), js->num(view.y), js->num(view.zoom), js->num(sx), js->num(sy)});
      int x = static_cast<int>(js->num_at(c, 0)), y = static_cast<int>(js->num_at(c, 1));
      js->free(c);
      if (x >= 0 && y >= 0 && x < map_w && y < map_h) h = {{x, y}};
    }
    if (h == hover) return;
    hover = h;
    hover_text.clear();
    if (hover) {
      JSValue t = js->call("label", {js->num(cur), js->num(hover->first), js->num(hover->second)});
      hover_text = js->host.string_of(t);
      js->free(t);
    }
  }

  // -------------------------------------------------------------- drawing

  ImVec2 to_screen(float x, float y) const { return {map_min.x + view.x + x * view.zoom, map_min.y + view.y + y * view.zoom}; }

  // A tile's diamond, as facePath in app.js
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

  void draw_map(ImDrawList* dl) {
    set_smooth(view.zoom < 1);
    float alpha = 1;
    const ImVec2 lo = map_min, hi{map_min.x + map_size.x, map_min.y + map_size.y};
    auto visible = [&](ImVec2 a, ImVec2 b) { return b.x >= lo.x && a.x <= hi.x && b.y >= lo.y && a.y <= hi.y; };
    auto with_alpha = [&](ImU32 c) { return (c & 0x00ffffff) | (static_cast<ImU32>(std::lround(((c >> 24) & 255) * alpha)) << 24); };
    const auto& n = scene.nums;
    for (size_t o = 0; o + 10 <= n.size(); o += 10) {
      switch (static_cast<int>(n[o])) {
        case 0:
        case 1: {
          const Sprite& s = sprites[scene.strs[static_cast<size_t>(n[o + 1])]];
          if (!s.tex) break;
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
          draw_badge(dl, scene.strs[static_cast<size_t>(n[o + 1])], static_cast<float>(n[o + 2]), static_cast<float>(n[o + 3]),
                     with_alpha(scene.colors[static_cast<size_t>(n[o + 4])]), with_alpha(scene.colors[static_cast<size_t>(n[o + 5])]),
                     ol >= 0 ? with_alpha(scene.colors[ol]) : 0, ol >= 0);
          break;
        }
        case 3: {
          ImVec2 pts[4];
          face_points(static_cast<int>(n[o + 1]), static_cast<int>(n[o + 2]), static_cast<float>(n[o + 3]), pts);
          if (!visible({pts[3].x, pts[0].y}, {pts[1].x, pts[2].y})) break;
          int fill = static_cast<int>(n[o + 4]), stroke = static_cast<int>(n[o + 5]);
          if (fill >= 0) dl->AddConvexPolyFilled(pts, 4, with_alpha(scene.colors[fill]));
          if (stroke >= 0) {
            float lw = n[o + 7] != 0 ? static_cast<float>(n[o + 6]) : static_cast<float>(n[o + 6]) * view.zoom;
            ImU32 col = with_alpha(scene.colors[stroke]);
            if (n[o + 8] > 0) dashed(dl, pts, 4, col, lw, static_cast<float>(n[o + 8]) * view.zoom, static_cast<float>(n[o + 9]) * view.zoom);
            else dl->AddPolyline(pts, 4, col, ImDrawFlags_Closed, lw);
          }
          break;
        }
        case 4: alpha = static_cast<float>(n[o + 1]); break;
      }
    }
  }

  void draw_overlay(ImDrawList* dl) {
    if (show_view) {
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
    if (hover) {
      ImVec2 pts[4];
      face_points(hover->first, hover->second, 1, pts);
      dl->AddPolyline(pts, 4, css_color("#ffcf1a"), ImDrawFlags_Closed, 2.0f);
    }
  }

  // -------------------------------------------------------------- UI

  void open_dialog() {
    static const SDL_DialogFileFilter filters[] = {{"Game launcher", "exe"}};
    SDL_ShowOpenFileDialog(
        [](void* user, const char* const* files, int) {
          auto* app = static_cast<App*>(user);
          if (files && files[0]) {
            std::lock_guard lock(app->dialog_mutex);
            app->dialog_result = files[0];
          }
          SDL_Event e{};
          e.type = app->wake_event;
          SDL_PushEvent(&e);
        },
        this, window, filters, 1, nullptr, false);
  }

  void ui() {
    const ImGuiViewport* vp = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(vp->WorkPos);
    ImGui::SetNextWindowSize(vp->WorkSize);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, {0, 0});
    ImGui::Begin("##main", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoBringToFrontOnFocus | ImGuiWindowFlags_NoSavedSettings);
    ImGui::PopStyleVar();

    // level list
    ImGui::BeginChild("levels", {230, 0}, ImGuiChildFlags_Borders);
    if (ImGui::Button("Open Launcher.exe...", {-1, 0})) open_dialog();
    ImGui::Separator();
    int world = -1;
    for (size_t i = 0; i < levels.size(); i++) {
      const Level& l = levels[i];
      if (l.world != world) {
        world = l.world;
        ImGui::SeparatorText(world == 999 ? "Tutorial button map" : ("World " + std::to_string(world)).c_str());
      }
      std::string label = (l.world == 999 ? std::string("-") : std::to_string(l.mission)) + "  " + l.title + "##" + l.member;
      if (ImGui::Selectable(label.c_str(), static_cast<int>(i) == cur)) select_level(static_cast<int>(i));
      if (ImGui::IsItemHovered()) ImGui::SetTooltip("%s", l.member.c_str());
    }
    ImGui::EndChild();
    ImGui::SameLine(0, 0);

    // toolbar, map, status bar
    ImGui::BeginGroup();
    ImGui::Dummy({0, 2});
    ImGui::Indent(8);
    bool redo = false;
    redo |= ImGui::Checkbox("Grid", &show_grid);
    ImGui::SameLine();
    ImGui::Checkbox("Start view", &show_view);
    ImGui::SameLine();
    ImGui::TextDisabled("|");
    ImGui::SameLine();
    if (ImGui::Button("-")) zoom_at(map_size.x / 2, map_size.y / 2, 0.8f);
    ImGui::SameLine();
    if (ImGui::Button((std::to_string(static_cast<int>(std::lround(view.zoom * 100))) + "%").c_str())) {
      zoom_at(map_size.x / 2, map_size.y / 2, 1 / view.zoom);
      view.x = std::round(view.x);
      view.y = std::round(view.y);
    }
    ImGui::SameLine();
    if (ImGui::Button("+")) zoom_at(map_size.x / 2, map_size.y / 2, 1.25f);
    ImGui::SameLine();
    if (ImGui::Button("Fit")) { user_zoom = 0; fit_view(); }
    ImGui::Unindent(8);
    if (redo && cur >= 0) rebuild_scene();

    float status_h = ImGui::GetFrameHeightWithSpacing();
    ImVec2 avail = ImGui::GetContentRegionAvail();
    map_min = ImGui::GetCursorScreenPos();
    map_size = {avail.x, std::max(50.0f, avail.y - status_h)};
    ImGui::InvisibleButton("map", map_size, ImGuiButtonFlags_MouseButtonLeft | ImGuiButtonFlags_MouseButtonRight | ImGuiButtonFlags_MouseButtonMiddle);
    if (fit_pending && cur >= 0) { fit_view(); fit_pending = false; }
    ImGuiIO& io = ImGui::GetIO();
    ImVec2 m{io.MousePos.x - map_min.x, io.MousePos.y - map_min.y};
    if (ImGui::IsItemActive() && (ImGui::IsMouseDown(ImGuiMouseButton_Right) || ImGui::IsMouseDown(ImGuiMouseButton_Middle) ||
                                  (ImGui::IsMouseDown(ImGuiMouseButton_Left) && ImGui::IsKeyDown(ImGuiKey_Space)))) {
      view.x += io.MouseDelta.x;
      view.y += io.MouseDelta.y;
    }
    if (ImGui::IsItemHovered() && io.MouseWheel != 0 && cur >= 0) zoom_at(m.x, m.y, std::exp(io.MouseWheel * 0.15f));
    if (cur >= 0) update_hover(ImGui::IsItemHovered() ? m.x : -1, ImGui::IsItemHovered() ? m.y : -1);

    ImDrawList* dl = ImGui::GetWindowDrawList();
    dl->PushClipRect(map_min, {map_min.x + map_size.x, map_min.y + map_size.y}, true);
    dl->AddRectFilledMultiColor(map_min, {map_min.x + map_size.x, map_min.y + map_size.y}, css_color("#1b3352"), css_color("#1b3352"), css_color("#0b1522"), css_color("#0b1522"));
    if (cur >= 0) {
      draw_map(dl);
      draw_overlay(dl);
    }
    dl->PopClipRect();

    ImGui::Indent(8);
    ImGui::AlignTextToFramePadding();
    ImGui::TextUnformatted(status.c_str());
    if (!hover_text.empty()) {
      ImGui::SameLine(0, 24);
      ImGui::TextDisabled("%s", hover_text.c_str());
    }
    ImGui::Unindent(8);
    ImGui::EndGroup();
    ImGui::End();
  }
};

// ---------------------------------------------------------------- benchmark (WBE_SWEEP=1)
// The same synthetic test the Electron harness runs: 240 frames hovering over tiles, then 240
// frames panning, at the same positions; prints CPU (all threads) and memory.

double cpu_ms() {
  rusage ru{};
  getrusage(RUSAGE_SELF, &ru);
  return (ru.ru_utime.tv_sec + ru.ru_stime.tv_sec) * 1e3 + (ru.ru_utime.tv_usec + ru.ru_stime.tv_usec) / 1e3;
}
long pss_kb() {
  std::ifstream f("/proc/self/smaps_rollup");
  std::string line;
  while (std::getline(f, line)) if (line.rfind("Pss:", 0) == 0) return std::atol(line.c_str() + 4);
  return 0;
}

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

ImFont* load_font(const char* const* candidates, float size) {
  for (const char* const* p = candidates; *p; p++) {
    if (SDL_GetPathInfo(*p, nullptr)) return ImGui::GetIO().Fonts->AddFontFromFileTTF(*p, size);
  }
  return nullptr;
}

}  // namespace

int main(int argc, char** argv) {
  if (!SDL_Init(SDL_INIT_VIDEO)) {
    std::fprintf(stderr, "SDL: %s\n", SDL_GetError());
    return 1;
  }
  App app;
  app.wake_event = SDL_RegisterEvents(1);
  app.window = SDL_CreateWindow("WorldBuilder Level Editor", 1400, 900, SDL_WINDOW_RESIZABLE);
  const char* want = std::getenv("WBE_RENDERER");
  app.renderer = SDL_CreateRenderer(app.window, want && *want ? want : nullptr);
  if (!app.window || !app.renderer) {
    std::fprintf(stderr, "SDL: %s\n", SDL_GetError());
    return 1;
  }
  SDL_SetRenderVSync(app.renderer, 1);

  IMGUI_CHECKVERSION();
  ImGui::CreateContext();
  ImGuiIO& io = ImGui::GetIO();
  io.IniFilename = nullptr;
  ImGui::StyleColorsDark();
  static const char* const ui_fonts[] = {"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/TTF/DejaVuSans.ttf",
                                         "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf", nullptr};
  static const char* const bold_fonts[] = {"/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
                                           "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf", nullptr};
  app.ui_font = load_font(ui_fonts, 15);
  if (!app.ui_font) app.ui_font = io.Fonts->AddFontDefault();
  app.badge_font = load_font(bold_fonts, 11);
  if (!app.badge_font) app.badge_font = app.ui_font;
  ImGui_ImplSDL3_InitForSDLRenderer(app.window, app.renderer);
  ImGui_ImplSDLRenderer3_Init(app.renderer);

  try {
    app.js.emplace();
  } catch (const std::exception& e) {
    std::fprintf(stderr, "Couldn't load the editor's scripts: %s\n", e.what());
    return 1;
  }
  if (const char* z = std::getenv("WBE_ZOOM")) app.user_zoom = static_cast<float>(std::atof(z));  // e.g. 1 for 100%
  if (argc > 1) app.open(argv[1]);

  // Draw only when something happened (a few frames after, so ImGui settles)
  int frames = 3;
  std::optional<Sweep> sweep;
  if (std::getenv("WBE_SWEEP")) sweep.emplace();
  const char* bench = std::getenv("WBE_BENCH");  // seconds: quit after that long, printing timings
  Uint64 quit_at = bench ? SDL_GetTicks() + static_cast<Uint64>(std::atof(bench) * 1000) : 0;
  for (bool running = true; running;) {
    SDL_Event e;
    bool got = frames > 0 || sweep ? SDL_PollEvent(&e) : SDL_WaitEventTimeout(&e, quit_at ? 100 : -1);
    while (got) {
      ImGui_ImplSDL3_ProcessEvent(&e);
      if (e.type == SDL_EVENT_QUIT || (e.type == SDL_EVENT_WINDOW_CLOSE_REQUESTED && e.window.windowID == SDL_GetWindowID(app.window))) running = false;
      frames = 3;
      got = SDL_PollEvent(&e);
    }
    {
      std::optional<std::string> path;
      {
        std::lock_guard lock(app.dialog_mutex);
        path.swap(app.dialog_result);
      }
      if (path) app.open(*path);
    }
    const char* shot = std::getenv("WBE_SHOT");  // with WBE_BENCH: save the last frame there (.bmp)
    bool last = quit_at && SDL_GetTicks() >= quit_at;
    if (last) { running = false; frames = 1; }
    if (sweep) {
      if (sweep->step(app)) frames = sweep->phase == 1 ? 0 : 1;
      else {
        std::printf("RENDERER %s\n", SDL_GetRendererName(app.renderer));
        std::printf("SPLIT wall/cpu ms: clear %.0f/%.0f, drawdata %.0f/%.0f, present %.0f/%.0f\n", prof_t[0], prof_c[0], prof_t[1], prof_c[1], prof_t[2], prof_c[2]);
        std::printf("PROF hover-js %.0f ms, ui+drawlists %.0f ms, render-submit %.0f ms\n", prof_hover, prof_ui, prof_render);
        std::printf("SWEEP {%s\"pssMB\": %.1f, \"status\": \"%s\"}\n", sweep->out.c_str(), pss_kb() / 1024.0, app.status.c_str());
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
  if (quit_at) std::printf("status: %s\n", app.status.c_str());

  app.clear_sprites();
  app.js.reset();
  ImGui_ImplSDLRenderer3_Shutdown();
  ImGui_ImplSDL3_Shutdown();
  ImGui::DestroyContext();
  SDL_DestroyRenderer(app.renderer);
  SDL_DestroyWindow(app.window);
  SDL_Quit();
  return 0;
}
