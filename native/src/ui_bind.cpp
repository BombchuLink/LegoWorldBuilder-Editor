#include "ui_bind.h"

#include <algorithm>
#include <cctype>
#include <climits>
#include <cstdio>
#include <filesystem>
#include <unordered_map>
#include <vector>

#include "imgui_internal.h"
#include "imgui_stdlib.h"
#include "js_host.h"

namespace wbe {
namespace {

UiHost* g_host = nullptr;

float ui_scale() { return ImGui::GetStyle().FontScaleDpi > 0 ? ImGui::GetStyle().FontScaleDpi : 1.0f; }

// ---------------------------------------------------------------- arguments

std::string arg_str(JSContext* c, int argc, JSValueConst* argv, int i, const char* def = "") {
  if (i >= argc || JS_IsUndefined(argv[i]) || JS_IsNull(argv[i])) return def;
  size_t n = 0;
  const char* s = JS_ToCStringLen(c, &n, argv[i]);
  if (!s) return def;
  std::string r(s, n);
  JS_FreeCString(c, s);
  return r;
}
double arg_num(JSContext* c, int argc, JSValueConst* argv, int i, double def = 0) {
  if (i >= argc || JS_IsUndefined(argv[i])) return def;
  double d = def;
  JS_ToFloat64(c, &d, argv[i]);
  return d;
}
float arg_f(JSContext* c, int argc, JSValueConst* argv, int i, float def = 0) { return static_cast<float>(arg_num(c, argc, argv, i, def)); }
int arg_int(JSContext* c, int argc, JSValueConst* argv, int i, int def = 0) {
  double d = arg_num(c, argc, argv, i, def);
  return d != d ? def : static_cast<int>(std::clamp(d, static_cast<double>(INT_MIN), static_cast<double>(INT_MAX)));
}
bool arg_bool(JSContext* c, int argc, JSValueConst* argv, int i, bool def = false) {
  if (i >= argc || JS_IsUndefined(argv[i])) return def;
  return JS_ToBool(c, argv[i]) > 0;
}
std::vector<std::string> arg_strs(JSContext* c, int argc, JSValueConst* argv, int i) {
  std::vector<std::string> out;
  if (i >= argc) return out;
  int64_t n = 0;
  JS_GetLength(c, argv[i], &n);
  for (int64_t k = 0; k < n; k++) {
    JSValue v = JS_GetPropertyInt64(c, argv[i], k);
    size_t len = 0;
    const char* s = JS_ToCStringLen(c, &len, v);
    out.emplace_back(s ? std::string(s, len) : std::string());
    if (s) JS_FreeCString(c, s);
    JS_FreeValue(c, v);
  }
  return out;
}

ImU32 css(const std::string& s) {
  auto hex = [](char ch) { return ch <= '9' ? ch - '0' : (ch | 32) - 'a' + 10; };
  int r = 255, g = 255, b = 255, a = 255;
  if (s.size() == 7 || s.size() == 9) {
    r = hex(s[1]) * 16 + hex(s[2]); g = hex(s[3]) * 16 + hex(s[4]); b = hex(s[5]) * 16 + hex(s[6]);
    if (s.size() == 9) a = hex(s[7]) * 16 + hex(s[8]);
  }
  return IM_COL32(r, g, b, a);
}

#define FN(name) JSValue name(JSContext* c, JSValueConst, int argc, JSValueConst* argv)
#define S(i) arg_str(c, argc, argv, i)
#define F(i, d) arg_f(c, argc, argv, i, d)
/* Sizes in the JS are in logical pixels; the display's scale (Windows' 125%, 150%…) turns them into
 * real ones. PX(i, d): a size argument in real pixels; LOGICAL(v): a measured size back for the JS. */
#define PX(i, d) (arg_f(c, argc, argv, i, d) * ui_scale())
#define LOGICAL(v) JS_NewFloat64(c, (v) / ui_scale())
#define I(i, d) arg_int(c, argc, argv, i, d)
#define B(i, d) arg_bool(c, argc, argv, i, d)
#define UNUSED_ARGS (void)c, (void)argc, (void)argv
const JSValue UNDEF = JS_UNDEFINED;

// ---------------------------------------------------------------- text and layout

FN(ui_text) { std::string s = S(0); ImGui::TextUnformatted(s.c_str()); return UNDEF; }
FN(ui_textDisabled) { std::string s = S(0); ImGui::TextDisabled("%s", s.c_str()); return UNDEF; }
FN(ui_textWrapped) { std::string s = S(0); ImGui::TextWrapped("%s", s.c_str()); return UNDEF; }
// textColored("#rrggbb", text, wrap)
FN(ui_textColored) {
  std::string s = S(1);
  ImGui::PushStyleColor(ImGuiCol_Text, css(S(0)));
  if (B(2, false)) ImGui::TextWrapped("%s", s.c_str()); else ImGui::TextUnformatted(s.c_str());
  ImGui::PopStyleColor();
  return UNDEF;
}
// heading(text, color): a section title: small capitals, muted (or that colour)
FN(ui_heading) {
  std::string s = S(0), col = S(1);
  for (char& ch : s) ch = static_cast<char>(std::toupper(static_cast<unsigned char>(ch)));
  ImGui::Dummy({0, 4});
  ImGui::PushFont(nullptr, ImGui::GetStyle().FontSizeBase * 0.8f);  // (before the display scale)
  ImGui::PushStyleColor(ImGuiCol_Text, col.empty() ? ImGui::GetStyleColorVec4(ImGuiCol_TextDisabled) : ImGui::ColorConvertU32ToFloat4(css(col)));
  ImGui::PushStyleVar(ImGuiStyleVar_ItemSpacing, {ImGui::GetStyle().ItemSpacing.x, 2});
  ImGui::TextUnformatted(s.c_str());
  ImGui::PopStyleVar();
  ImGui::PopStyleColor();
  ImGui::PopFont();
  return UNDEF;
}
FN(ui_separator) { UNUSED_ARGS; ImGui::Separator(); return UNDEF; }
FN(ui_sameLine) { float sp = F(1, -1);
  ImGui::SameLine(PX(0, 0), sp < 0 ? sp : sp * ui_scale()); return UNDEF; }
FN(ui_spacing) { UNUSED_ARGS; ImGui::Spacing(); return UNDEF; }
FN(ui_newLine) { UNUSED_ARGS; ImGui::NewLine(); return UNDEF; }
FN(ui_alignText) { UNUSED_ARGS; ImGui::AlignTextToFramePadding(); return UNDEF; }
FN(ui_indent) { ImGui::Indent(PX(0, 0)); return UNDEF; }
FN(ui_unindent) { ImGui::Unindent(PX(0, 0)); return UNDEF; }
FN(ui_setNextItemWidth) { ImGui::SetNextItemWidth(PX(0, 0)); return UNDEF; }
FN(ui_availWidth) { UNUSED_ARGS; return LOGICAL(ImGui::GetContentRegionAvail().x); }
FN(ui_cursorX) { UNUSED_ARGS; return LOGICAL(ImGui::GetCursorPosX()); }
FN(ui_frameHeight) { UNUSED_ARGS; return LOGICAL(ImGui::GetFrameHeightWithSpacing()); }
FN(ui_textWidth) { std::string t = S(0); return LOGICAL(ImGui::CalcTextSize(t.c_str()).x); }
FN(ui_textLineHeight) { UNUSED_ARGS; return LOGICAL(ImGui::GetTextLineHeightWithSpacing()); }
FN(ui_pushId) { std::string s = S(0); ImGui::PushID(s.c_str()); return UNDEF; }
FN(ui_popId) { UNUSED_ARGS; ImGui::PopID(); return UNDEF; }
FN(ui_beginDisabled) { ImGui::BeginDisabled(B(0, true)); return UNDEF; }
FN(ui_endDisabled) { UNUSED_ARGS; ImGui::EndDisabled(); return UNDEF; }
FN(ui_tooltip) {
  std::string s = S(0);
  if (!s.empty() && ImGui::IsItemHovered(ImGuiHoveredFlags_ForTooltip | ImGuiHoveredFlags_AllowWhenDisabled)) {
    ImGui::BeginTooltip();
    ImGui::PushTextWrapPos(ImGui::GetFontSize() * 30);
    ImGui::TextUnformatted(s.c_str());
    ImGui::PopTextWrapPos();
    ImGui::EndTooltip();
  }
  return UNDEF;
}
FN(ui_itemClicked) { return JS_NewBool(c, ImGui::IsItemClicked(I(0, 0))); }
FN(ui_keyPressed) {
  std::string k = S(0);
  ImGuiKey key = k == "enter" ? ImGuiKey_Enter : k == "escape" ? ImGuiKey_Escape : ImGuiKey_None;
  return JS_NewBool(c, key != ImGuiKey_None && ImGui::IsKeyPressed(key, false));
}

// ---------------------------------------------------------------- buttons and choices

// flow(width): stay on the line if an item that wide still fits, else start a new one
FN(ui_flow) { ui_flow_item(PX(0, 0)); return UNDEF; }
// width(label, kind): how wide a "button" or "checkbox" with that label is
FN(ui_width) {
  std::string label = S(0), kind = S(1);
  float t = ImGui::CalcTextSize(label.c_str(), nullptr, true).x;
  const ImGuiStyle& st = ImGui::GetStyle();
  return LOGICAL(kind == "checkbox" ? ImGui::GetFrameHeight() + st.ItemInnerSpacing.x + t : t + st.FramePadding.x * 2);
}

/* Button looks: "accent" yellow, "primary" (or "on") blue, "ghost" no frame,
 * "pill" a round segment button (yellow when on); returns how many style colours/vars it pushed */
std::pair<int, int> push_kind(const std::string& kind, bool on) {
  auto col = [](ImGuiCol k, ImU32 v) { ImGui::PushStyleColor(k, v); };
  if (kind == "accent" || (kind == "pill" && on)) {
    col(ImGuiCol_Button, IM_COL32(0xff, 0xcf, 0x1a, 255)); col(ImGuiCol_ButtonHovered, IM_COL32(0xff, 0xd9, 0x4a, 255));
    col(ImGuiCol_ButtonActive, IM_COL32(0xf0, 0xc0, 0x10, 255)); col(ImGuiCol_Text, IM_COL32(0x1b, 0x1b, 0x1b, 255));
    col(ImGuiCol_Border, IM_COL32(0xff, 0xcf, 0x1a, 255));
    int vars = 0;
    if (kind == "pill") { ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 12); vars++; }
    return {5, vars};
  }
  if (kind == "primary" || on) {
    col(ImGuiCol_Button, IM_COL32(0x2a, 0x7d, 0xe1, 255)); col(ImGuiCol_ButtonHovered, IM_COL32(0x3a, 0x8b, 0xf0, 255));
    col(ImGuiCol_ButtonActive, IM_COL32(0x22, 0x6c, 0xc6, 255)); col(ImGuiCol_Text, IM_COL32_WHITE);
    col(ImGuiCol_Border, IM_COL32(0x2a, 0x7d, 0xe1, 255));
    return {5, 0};
  }
  if (kind == "ghost" || kind == "tool") {
    col(ImGuiCol_Button, 0); col(ImGuiCol_Border, 0);
    return {2, 0};
  }
  if (kind == "pill") { ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, 12); return {0, 1}; }
  return {0, 0};
}
// button(label, width, height, kind)
FN(ui_button) {
  std::string s = S(0);
  auto [nc, nv] = push_kind(S(3), false);
  bool r = ImGui::Button(s.c_str(), {PX(1, 0), PX(2, 0)});
  ImGui::PopStyleColor(nc);
  ImGui::PopStyleVar(nv);
  return JS_NewBool(c, r);
}
FN(ui_smallButton) { std::string s = S(0); return JS_NewBool(c, ImGui::SmallButton(s.c_str())); }
// toggle(label, on, disabled, kind): a button that shows whether it's on ("tool": frameless till on, "pill")
FN(ui_toggle) {
  std::string s = S(0);
  bool on = B(1, false), off = B(2, false);
  auto [nc, nv] = push_kind(S(3), on);
  ImGui::BeginDisabled(off);
  bool r = ImGui::Button(s.c_str());
  ImGui::EndDisabled();
  ImGui::PopStyleColor(nc);
  ImGui::PopStyleVar(nv);
  return JS_NewBool(c, r);
}
FN(ui_checkbox) {
  std::string s = S(0);
  bool v = B(1, false);
  ImGui::Checkbox(s.c_str(), &v);
  return JS_NewBool(c, v);
}
// selectable(label, selected): a list row; the selected one has a blue bar on its left
FN(ui_selectable) {
  std::string s = S(0);
  bool sel = B(1, false);
  bool r = ImGui::Selectable(s.c_str(), sel);
  if (sel) {
    ImVec2 a = ImGui::GetItemRectMin(), b = ImGui::GetItemRectMax();
    ImGui::GetWindowDrawList()->AddRectFilled({a.x - 4, a.y}, {a.x - 1, b.y}, IM_COL32(0x2a, 0x7d, 0xe1, 255));
  }
  return JS_NewBool(c, r);
}
// combo(label, index, items): the chosen index; items starting "## " are group headings
FN(ui_combo) {
  std::string label = S(0);
  int idx = I(1, -1);
  auto items = arg_strs(c, argc, argv, 2);
  const char* preview = idx >= 0 && idx < static_cast<int>(items.size()) ? items[idx].c_str() : "";
  if (ImGui::BeginCombo(label.c_str(), preview, ImGuiComboFlags_HeightLarge)) {
    for (int i = 0; i < static_cast<int>(items.size()); i++) {
      if (items[i].rfind("## ", 0) == 0) {
        if (items[i].size() > 3) ImGui::SeparatorText(items[i].c_str() + 3);
        continue;
      }
      ImGui::PushID(i);
      if (ImGui::Selectable(items[i].c_str(), i == idx)) idx = i;
      if (i == I(1, -1) && ImGui::IsWindowAppearing()) ImGui::SetScrollHereY();
      ImGui::PopID();
    }
    ImGui::EndCombo();
  }
  return JS_NewInt32(c, idx);
}

/* Number and text fields hand their value back only when the edit is finished (Enter, leaving the
 * field, or a step button), so typing "12" is one change, not two; meanwhile they show what's typed. */
std::unordered_map<ImGuiID, int> g_live_int;
std::unordered_map<ImGuiID, std::string> g_live_str;

FN(ui_inputInt) {
  std::string label = S(0);
  int v = I(1, 0), lo = I(2, INT_MIN), hi = I(3, INT_MAX);
  ImGuiID id = ImGui::GetID(label.c_str());
  auto it = g_live_int.find(id);
  int cur = it != g_live_int.end() ? it->second : v;
  ImGui::InputInt(label.c_str(), &cur);
  cur = std::clamp(cur, lo, hi);
  if (ImGui::IsItemDeactivatedAfterEdit()) { g_live_int.erase(id); return JS_NewInt32(c, cur); }
  if (ImGui::IsItemActive()) {
    g_live_int[id] = cur;
    // a step button press changes the value straight away
    if (!ImGui::GetIO().WantTextInput && cur != v) { g_live_int.erase(id); return JS_NewInt32(c, cur); }
  } else g_live_int.erase(id);
  return JS_NewInt32(c, v);
}
FN(ui_inputText) {
  std::string label = S(0), v = S(1);
  ImGuiID id = ImGui::GetID(label.c_str());
  auto it = g_live_str.find(id);
  std::string cur = it != g_live_str.end() ? it->second : v;
  ImGui::InputText(label.c_str(), &cur);
  if (ImGui::IsItemDeactivatedAfterEdit()) { g_live_str.erase(id); return JS_NewString(c, cur.c_str()); }
  if (ImGui::IsItemActive()) g_live_str[id] = cur; else g_live_str.erase(id);
  return JS_NewString(c, v.c_str());
}
// textEditor(id, text, height): a multi-line editor; returns the text as it stands
FN(ui_textEditor) {
  std::string id = S(0), v = S(1);
  ImGui::InputTextMultiline(("##" + id).c_str(), &v, {-1, PX(2, -1)}, ImGuiInputTextFlags_AllowTabInput);
  return JS_NewStringLen(c, v.data(), v.size());
}

// ---------------------------------------------------------------- containers

FN(ui_beginTabBar) { std::string s = S(0); return JS_NewBool(c, ImGui::BeginTabBar(s.c_str())); }
FN(ui_endTabBar) { UNUSED_ARGS; ImGui::EndTabBar(); return UNDEF; }
// tab(label, select, current): whether it's the open tab; select makes it so; current: it was open last frame
FN(ui_tab) {
  std::string s = S(0);
  // muted until open, then a yellow line under it
  bool cur = B(2, false);
  if (!cur) ImGui::PushStyleColor(ImGuiCol_Text, ImGui::GetStyleColorVec4(ImGuiCol_TextDisabled));
  bool open = ImGui::BeginTabItem(s.c_str(), nullptr, B(1, false) ? ImGuiTabItemFlags_SetSelected : 0);
  if (!cur) ImGui::PopStyleColor();
  if (open) {
    ImVec2 a = ImGui::GetItemRectMin(), b = ImGui::GetItemRectMax();
    ImGui::GetWindowDrawList()->AddRectFilled({a.x, b.y - 2}, {b.x, b.y}, IM_COL32(0xff, 0xcf, 0x1a, 255));
    ImGui::EndTabItem();
  }
  return JS_NewBool(c, open);
}
FN(ui_beginChild) {
  std::string s = S(0);
  ImGui::BeginChild(s.c_str(), {PX(1, 0), PX(2, 0)}, B(3, false) ? ImGuiChildFlags_Borders : 0);
  return UNDEF;
}
FN(ui_endChild) { UNUSED_ARGS; ImGui::EndChild(); return UNDEF; }
FN(ui_openPopup) { std::string s = S(0); ImGui::OpenPopup(s.c_str()); return UNDEF; }
// beginModal(title, width, height): height 0 fits the contents
FN(ui_beginModal) {
  std::string s = S(0);
  ImGui::SetNextWindowPos(ImGui::GetMainViewport()->GetCenter(), ImGuiCond_Appearing, {0.5f, 0.5f});
  float w = PX(1, 460), h = PX(2, 0);
  if (h > 0) ImGui::SetNextWindowSize({w, h}, ImGuiCond_Appearing);
  else ImGui::SetNextWindowSizeConstraints({w, 0}, {w, FLT_MAX});
  return JS_NewBool(c, ImGui::BeginPopupModal(s.c_str(), nullptr, h > 0 ? 0 : ImGuiWindowFlags_AlwaysAutoResize));
}
FN(ui_endPopup) { UNUSED_ARGS; ImGui::EndPopup(); return UNDEF; }
FN(ui_closePopup) { UNUSED_ARGS; ImGui::CloseCurrentPopup(); return UNDEF; }

/* resizer(nums, strs, cols, rows, label): the Level tab's map-size control: a
 * little map (scene commands, see editor.js pack, in map pixels for a cols×rows block of tiles)
 * with round + and − buttons on each edge; hovering a pair lights up the edge it changes.
 * Returns "top+", "left-"... for a click, else "". */
FN(ui_resizer) {
  if (argc < 5) return JS_NewString(c, "");
  size_t off = 0, len = 0, bpe = 0;
  JSValue buf = JS_GetTypedArrayBuffer(c, argv[0], &off, &len, &bpe);
  size_t blen = 0;
  uint8_t* raw = JS_IsException(buf) ? nullptr : JS_GetArrayBuffer(c, &blen, buf);
  std::vector<double> n;
  if (raw) n.assign(reinterpret_cast<double*>(raw + off), reinterpret_cast<double*>(raw + off + len));
  JS_FreeValue(c, buf);
  auto strs = arg_strs(c, argc, argv, 1);
  float cols = F(2, 6), rows = F(3, 3);
  std::string label = S(4);

  const float k0 = ui_scale(), BW = 28 * k0, BH = 26 * k0, GAP = 4 * k0;
  float W = ImGui::GetContentRegionAvail().x;
  float mw = std::min(190.0f * k0, W - 2 * (BW + 8 * k0)), mh = 106 * k0;
  ImVec2 o = ImGui::GetCursorScreenPos();
  float cx = o.x + W / 2;
  ImVec2 m0{cx - mw / 2, o.y + BH + 6 * k0}, m1{m0.x + mw, m0.y + mh};
  std::string hit;
  const char* hover_side = nullptr;
  auto pair = [&](const char* side, ImVec2 at, bool vertical) {
    for (int k = 0; k < 2; k++) {
      ImGui::SetCursorScreenPos(vertical ? ImVec2{at.x, at.y + k * (BH + GAP)} : ImVec2{at.x + k * (BW + GAP), at.y});
      bool plus = k == 0;
      std::string id = std::string(plus ? "+" : "\u2212") + "##" + side;
      ImGui::PushStyleVar(ImGuiStyleVar_FrameRounding, BH / 2);
      ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, {0, 0});
      ImGui::PushStyleColor(ImGuiCol_ButtonHovered, plus ? IM_COL32(0x3f, 0xae, 0x49, 255) : IM_COL32(0xe3, 0x00, 0x0b, 255));
      if (ImGui::Button(id.c_str(), {BW, BH})) hit = std::string(side) + (plus ? "+" : "-");
      ImGui::PopStyleColor();
      ImGui::PopStyleVar(2);
      bool row = std::string(side) == "top" || std::string(side) == "bottom";
      ImGui::SetItemTooltip("%s a %s on the %s", plus ? "Add" : "Remove", row ? "row" : "column", side);
      if (ImGui::IsItemHovered()) hover_side = side;
    }
  };
  float pw = 2 * BW + GAP, ph = 2 * BH + GAP;
  pair("top", {cx - pw / 2, o.y}, false);
  pair("left", {m0.x - BW - 8 * k0, (m0.y + m1.y) / 2 - ph / 2}, true);
  pair("right", {m1.x + 8 * k0, (m0.y + m1.y) / 2 - ph / 2}, true);
  pair("bottom", {cx - pw / 2, m1.y + 6 * k0}, false);

  // the map: fitted into the box, with headroom for tall trees and models
  const float CELLW = 50, SKEWW = 25;
  float x0 = -rows * SKEWW - 26, x1 = cols * CELLW + 30, y0 = -40, y1 = rows * CELLW + 6;
  float k = std::min(mw / (x1 - x0), mh / (y1 - y0));
  ImVec2 org{(m0.x + m1.x) / 2 - (x1 + x0) / 2 * k, (m0.y + m1.y) / 2 - (y1 + y0) / 2 * k};
  auto P = [&](float x, float y) { return ImVec2{org.x + x * k, org.y + y * k}; };
  ImDrawList* dl = ImGui::GetWindowDrawList();
  float alpha = 1;
  for (size_t i = 0; i + 10 <= n.size(); i += 10) {
    int kind = static_cast<int>(n[i]);
    if (kind == 4) { alpha = static_cast<float>(n[i + 1]); continue; }
    if (kind != 0 && kind != 1) continue;
    size_t si = static_cast<size_t>(n[i + 1]);
    UiSprite sp;
    if (si >= strs.size() || !g_host || !g_host->sprite(strs[si], sp)) continue;
    float w = kind == 0 ? sp.w : static_cast<float>(n[i + 4]), h = kind == 0 ? sp.h : static_cast<float>(n[i + 5]);
    ImVec2 a = P(static_cast<float>(n[i + 2]), static_cast<float>(n[i + 3]));
    dl->AddImage(sp.tex, a, {a.x + w * k, a.y + h * k}, sp.uv0, sp.uv1, IM_COL32(255, 255, 255, static_cast<int>(255 * alpha)));
  }
  // the edge a hovered pair changes, lit in yellow
  if (hover_side) {
    std::string sd = hover_side;
    auto corner = [&](float tx, float ty) { return P(tx * CELLW - ty * SKEWW + 1, ty * CELLW); };
    ImVec2 a, b, d;
    if (sd == "top") { a = corner(0, 0); b = corner(cols, 0); d = {0, -3}; }
    else if (sd == "bottom") { a = corner(0, rows); b = corner(cols, rows); d = {0, 22 * k + 3}; }
    else if (sd == "left") { a = corner(0, 0); b = corner(0, rows); d = {-5, 0}; }
    else { a = corner(cols, 0); b = corner(cols, rows); d = {5, 0}; }
    dl->AddLine({a.x + d.x, a.y + d.y}, {b.x + d.x, b.y + d.y}, IM_COL32(0xff, 0xcf, 0x1a, 255), 4);
  }
  // the size, in a dark pill at the bottom right
  ImFont* font = ImGui::GetFont();
  float fs = ImGui::GetFontSize() * 0.9f;
  ImVec2 ts = font->CalcTextSizeA(fs, FLT_MAX, 0, label.c_str());
  ImVec2 l1{m1.x - 2, m1.y + 4}, l0{l1.x - ts.x - 14, l1.y - ts.y - 2};
  dl->AddRectFilled(l0, l1, IM_COL32(0, 0, 0, 170), 9);
  dl->AddText(font, fs, {l0.x + 7, l0.y + 1}, IM_COL32_WHITE, label.c_str());

  ImGui::SetCursorScreenPos(o);
  ImGui::Dummy({W, BH + 12 * k0 + mh + BH});
  return JS_NewString(c, hit.c_str());
}

// levelRow(id, number, name, dirty, selected): a level list row: the mission number in a column, the
// name, and a yellow dot when it has unsaved changes
FN(ui_levelRow) {
  std::string id = S(0), num = S(1), name = S(2);
  bool dirty = B(3, false), sel = B(4, false);
  ImGui::PushID(id.c_str());
  ImVec2 p = ImGui::GetCursorScreenPos();
  bool r = ImGui::Selectable("##row", sel);
  ImVec2 a = ImGui::GetItemRectMin(), b = ImGui::GetItemRectMax();
  ImDrawList* dl = ImGui::GetWindowDrawList();
  if (sel) dl->AddRectFilled({a.x - 4, a.y}, {a.x - 1, b.y}, IM_COL32(0x2a, 0x7d, 0xe1, 255));
  float col = ImGui::CalcTextSize("00").x;
  float y = p.y + (b.y - a.y - ImGui::GetTextLineHeight()) / 2;
  ImVec2 nw = ImGui::CalcTextSize(num.c_str());
  dl->AddText({p.x + col - nw.x, y}, ImGui::GetColorU32(ImGuiCol_TextDisabled), num.c_str());
  dl->PushClipRect(a, {b.x - (dirty ? 14 : 0), b.y}, true);
  dl->AddText({p.x + col + 8, y}, ImGui::GetColorU32(ImGuiCol_Text), name.c_str());
  dl->PopClipRect();
  if (dirty) dl->AddCircleFilled({b.x - 7, (a.y + b.y) / 2}, 3.5f, IM_COL32(0xff, 0xcf, 0x1a, 255));
  ImGui::PopID();
  return JS_NewBool(c, r);
}

// swatch(id, sprite, label, on, size): a palette button, the sprite fitted in a square with a label under it
FN(ui_swatch) {
  std::string id = S(0), name = S(1), label = S(2);
  bool on = B(3, false);
  float size = PX(4, 52);
  ImFont* font = ImGui::GetFont();
  float fs = ImGui::GetFontSize() * 0.8f;
  float lh = fs + 4;
  ImGui::PushID(id.c_str());
  ImVec2 p = ImGui::GetCursorScreenPos();
  bool clicked = ImGui::InvisibleButton("sw", {size, size + lh});
  bool hovered = ImGui::IsItemHovered();
  ImDrawList* dl = ImGui::GetWindowDrawList();
  ImVec2 q{p.x + size, p.y + size + lh};
  dl->AddRectFilled(p, q, hovered ? IM_COL32(0x2c, 0x31, 0x3d, 255) : IM_COL32(0x25, 0x29, 0x33, 255), 6);
  if (on) dl->AddRect(p, q, IM_COL32(0xff, 0xcf, 0x1a, 255), 6.0f, 0, 2.0f);
  else dl->AddRect(p, q, hovered ? IM_COL32(0x4a, 0x51, 0x63, 255) : IM_COL32(0x33, 0x38, 0x45, 255), 6.0f);
  UiSprite s;
  float box = size - 6;
  if (!name.empty() && g_host && g_host->sprite(name, s) && s.w > 0 && s.h > 0) {
    float k = std::min({box / s.w, box / s.h, 1.5f});
    float w = s.w * k, h = s.h * k;
    ImVec2 a{p.x + (size - w) / 2, p.y + (size - h) / 2};
    dl->AddImage(s.tex, a, {a.x + w, a.y + h}, s.uv0, s.uv1);
  } else if (name.empty()) {
    // a hole: just the tile's dashed outline
    float k = box / 52;
    ImVec2 o{p.x + 3, p.y + 3 + 8 * k};
    ImVec2 pts[4] = {{o.x + 14 * k, o.y}, {o.x + 50 * k, o.y}, {o.x + 36 * k, o.y + 30 * k}, {o.x, o.y + 30 * k}};
    for (int i = 0; i < 4; i++) {
      ImVec2 a = pts[i], b = pts[(i + 1) % 4];
      for (float t = 0; t < 1; t += 0.2f) {
        dl->AddLine({a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t}, {a.x + (b.x - a.x) * (t + 0.1f), a.y + (b.y - a.y) * (t + 0.1f)}, IM_COL32(255, 255, 255, 128));
      }
    }
  }
  ImVec2 ts = font->CalcTextSizeA(fs, FLT_MAX, 0, label.c_str());
  float tx = ts.x <= size - 4 ? p.x + (size - ts.x) / 2 : p.x + 2;
  dl->PushClipRect({p.x + 2, p.y}, {q.x - 2, q.y}, true);
  dl->AddText(font, fs, {tx, p.y + size + 1}, ImGui::GetColorU32(ImGuiCol_Text), label.c_str());
  dl->PopClipRect();
  ImGui::PopID();
  return JS_NewBool(c, clicked);
}

// ---------------------------------------------------------------- NATIVE: files, dialogs, prefs

FN(nat_readFile) {
  try {
    auto bytes = read_file(S(0));
    return JS_NewUint8ArrayCopy(c, bytes.data(), bytes.size());
  } catch (const std::exception& e) {
    return JS_ThrowTypeError(c, "%s", e.what());
  }
}
std::span<const uint8_t> bytes_arg(JSContext* c, JSValueConst v) {
  size_t n = 0;
  uint8_t* p = JS_GetUint8Array(c, &n, v);
  return p ? std::span<const uint8_t>(p, n) : std::span<const uint8_t>();
}
FN(nat_writeFile) {
  try {
    if (argc < 2) return JS_ThrowTypeError(c, "writeFile(path, bytes)");
    write_file(S(0), bytes_arg(c, argv[1]));
    return UNDEF;
  } catch (const std::exception& e) {
    return JS_ThrowTypeError(c, "%s", e.what());
  }
}
/* saveFile(path, bytes): as the desktop app saves a game file. The first time a file is saved over,
 * the original is kept as <name>.orig (returned; else ""). Written beside it and renamed, so a failed
 * save never leaves half a game, keeping the old file's permissions (Launcher.exe stays executable). */
FN(nat_saveFile) {
  namespace fs = std::filesystem;
  try {
    if (argc < 2) return JS_ThrowTypeError(c, "saveFile(path, bytes)");
    std::string p = S(0), backup;
    std::error_code ec;
    bool exists = fs::exists(fs_path(p), ec);
    if (exists && !fs::exists(fs_path(p + ".orig"), ec)) {
      fs::copy_file(fs_path(p), fs_path(p + ".orig"), ec);
      if (ec) throw std::runtime_error("Couldn't keep a copy of the original: " + ec.message());
      backup = p + ".orig";
    }
    std::string tmp = p + ".saving";
    write_file(tmp, bytes_arg(c, argv[1]));
    if (exists) {
      auto perms = fs::status(fs_path(p), ec).permissions();
      if (!ec) fs::permissions(fs_path(tmp), perms, ec);  // Launcher.exe stays executable
    }
    replace_file(tmp, p);
    return JS_NewString(c, backup.c_str());
  } catch (const std::exception& e) {
    return JS_ThrowTypeError(c, "%s", e.what());
  }
}
FN(nat_fileDialog) {
  if (g_host) g_host->file_dialog(S(0), B(1, false), S(2), S(3));
  return UNDEF;
}
FN(nat_prefsLoad) {
  UNUSED_ARGS;
  try {
    auto b = read_file(g_host->prefs_file());
    return JS_NewStringLen(c, reinterpret_cast<const char*>(b.data()), b.size());
  } catch (...) {
    return JS_NewString(c, "");
  }
}
FN(nat_prefsSave) {
  std::string s = S(0);
  try { write_file(g_host->prefs_file(), {reinterpret_cast<const uint8_t*>(s.data()), s.size()}); } catch (...) { /* not saved */ }
  return UNDEF;
}
FN(nat_quit) { UNUSED_ARGS; if (g_host) g_host->quit(); return UNDEF; }
#ifndef WBE_VERSION
#define WBE_VERSION "dev"
#endif
FN(nat_version) { UNUSED_ARGS; return JS_NewString(c, WBE_VERSION); }

struct Entry {
  const char* name;
  JSCFunction* fn;
};

void install(JSContext* c, const char* global, std::initializer_list<Entry> fns) {
  JSValue g = JS_GetGlobalObject(c);
  JSValue o = JS_NewObject(c);
  for (const Entry& e : fns) JS_SetPropertyStr(c, o, e.name, JS_NewCFunction(c, e.fn, e.name, 0));
  JS_SetPropertyStr(c, g, global, o);
  JS_FreeValue(c, g);
}

}  // namespace

void ui_flow_item(float w) {
  const ImGuiStyle& st = ImGui::GetStyle();
  float edge = ImGui::GetWindowPos().x + ImGui::GetWindowSize().x - st.WindowPadding.x;
  if (ImGui::GetItemRectMax().x + st.ItemSpacing.x + w <= edge) ImGui::SameLine();
}

void bind_ui(JSContext* c, UiHost* host) {
  g_host = host;
  install(c, "UI", {
    {"text", ui_text}, {"textDisabled", ui_textDisabled}, {"textWrapped", ui_textWrapped}, {"textColored", ui_textColored},
    {"heading", ui_heading}, {"separator", ui_separator}, {"sameLine", ui_sameLine}, {"spacing", ui_spacing},
    {"newLine", ui_newLine}, {"alignText", ui_alignText}, {"indent", ui_indent}, {"unindent", ui_unindent},
    {"setNextItemWidth", ui_setNextItemWidth}, {"availWidth", ui_availWidth}, {"cursorX", ui_cursorX},
    {"frameHeight", ui_frameHeight}, {"textLineHeight", ui_textLineHeight}, {"textWidth", ui_textWidth}, {"pushId", ui_pushId}, {"popId", ui_popId},
    {"beginDisabled", ui_beginDisabled}, {"endDisabled", ui_endDisabled}, {"tooltip", ui_tooltip},
    {"itemClicked", ui_itemClicked}, {"keyPressed", ui_keyPressed}, {"flow", ui_flow}, {"width", ui_width},
    {"button", ui_button}, {"smallButton", ui_smallButton}, {"toggle", ui_toggle}, {"checkbox", ui_checkbox},
    {"selectable", ui_selectable}, {"combo", ui_combo}, {"inputInt", ui_inputInt}, {"inputText", ui_inputText},
    {"textEditor", ui_textEditor},
    {"beginTabBar", ui_beginTabBar}, {"endTabBar", ui_endTabBar}, {"tab", ui_tab},
    {"beginChild", ui_beginChild}, {"endChild", ui_endChild},
    {"openPopup", ui_openPopup}, {"beginModal", ui_beginModal}, {"endPopup", ui_endPopup}, {"closePopup", ui_closePopup},
    {"swatch", ui_swatch}, {"levelRow", ui_levelRow}, {"resizer", ui_resizer},
  });
  install(c, "NATIVE", {
    {"readFile", nat_readFile}, {"writeFile", nat_writeFile}, {"saveFile", nat_saveFile}, {"fileDialog", nat_fileDialog},
    {"prefsLoad", nat_prefsLoad}, {"prefsSave", nat_prefsSave}, {"quit", nat_quit}, {"version", nat_version},
  });
}

}  // namespace wbe
