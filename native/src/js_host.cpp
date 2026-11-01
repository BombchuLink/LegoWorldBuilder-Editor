#include "js_host.h"

#include <zlib.h>

#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>

#if defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace wbe {

namespace fs = std::filesystem;

fs::path fs_path(const std::string& utf8) { return fs::path(std::u8string(utf8.begin(), utf8.end())); }
std::string utf8_of(const fs::path& p) {
  std::u8string s = p.u8string();
  return std::string(s.begin(), s.end());
}

std::vector<uint8_t> read_file(const std::string& path) {
  std::ifstream f(fs_path(path), std::ios::binary);
  if (!f) throw std::runtime_error("Can't read " + path);
  return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}

void write_file(const std::string& path, std::span<const uint8_t> bytes) {
  std::ofstream f(fs_path(path), std::ios::binary);
  f.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  if (!f) throw std::runtime_error("Can't write " + path);
}

void replace_file(const std::string& from, const std::string& to) {
#if defined(_WIN32)
  // MinGW's std::filesystem::rename won't replace an existing file
  if (!MoveFileExW(fs_path(from).c_str(), fs_path(to).c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
    throw std::runtime_error("Couldn't replace " + to + " (Windows error " + std::to_string(GetLastError()) + ")");
#else
  std::error_code ec;
  fs::rename(fs_path(from), fs_path(to), ec);
  if (ec) throw std::runtime_error("Couldn't replace " + to + ": " + ec.message());
#endif
}

fs::path program_dir() {
  std::error_code ec;
#if defined(_WIN32)
  std::wstring buf(32768, L'\0');
  DWORD n = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
  if (n == 0 || n >= buf.size()) return {};
  buf.resize(n);
  return fs::path(buf).parent_path();
#elif defined(__linux__)
  fs::path exe = fs::read_symlink("/proc/self/exe", ec);
  return ec ? fs::path() : exe.parent_path();
#else
  return {};
#endif
}

namespace {

// zlib-wrapped deflate, as the browser's DecompressionStream("deflate") / CompressionStream("deflate")
JSValue js_inflate(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  size_t len = 0;
  uint8_t* in = argc ? JS_GetUint8Array(ctx, &len, argv[0]) : nullptr;
  if (!in) return JS_EXCEPTION;
  z_stream z{};
  if (inflateInit(&z) != Z_OK) return JS_ThrowInternalError(ctx, "inflateInit failed");
  std::vector<uint8_t> out(len * 4 + 64);
  z.next_in = in;
  z.avail_in = static_cast<uInt>(len);
  int r;
  do {
    if (z.total_out == out.size()) out.resize(out.size() * 2);
    z.next_out = out.data() + z.total_out;
    z.avail_out = static_cast<uInt>(out.size() - z.total_out);
    r = inflate(&z, Z_NO_FLUSH);
  } while (r == Z_OK || (r == Z_BUF_ERROR && z.avail_out == 0));
  size_t n = z.total_out;
  inflateEnd(&z);
  if (r != Z_STREAM_END) return JS_ThrowTypeError(ctx, "inflate: corrupt data (zlib %d)", r);
  return JS_NewUint8ArrayCopy(ctx, out.data(), n);
}

JSValue js_deflate(JSContext* ctx, JSValueConst, int argc, JSValueConst* argv) {
  size_t len = 0;
  uint8_t* in = argc ? JS_GetUint8Array(ctx, &len, argv[0]) : nullptr;
  if (!in) return JS_EXCEPTION;
  uLongf n = compressBound(static_cast<uLong>(len));
  std::vector<uint8_t> out(n);
  if (compress2(out.data(), &n, in, static_cast<uLong>(len), Z_DEFAULT_COMPRESSION) != Z_OK)
    return JS_ThrowInternalError(ctx, "deflate failed");
  return JS_NewUint8ArrayCopy(ctx, out.data(), n);
}

// What wbcore.js needs from a browser beyond the language (QuickJS has atob already)
const char* kPrelude = R"JS(
globalThis.self = globalThis;
if (typeof TextEncoder === "undefined") {
  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(s = "") {
      const out = [];
      for (const ch of String(s)) {
        let c = ch.codePointAt(0);
        if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return Uint8Array.from(out);
    }
  };
}
)JS";

}  // namespace

JsHost::JsHost() {
  rt_ = JS_NewRuntime();
  ctx_ = JS_NewContext(rt_);
  JSValue g = JS_GetGlobalObject(ctx_);
  JSValue z = JS_NewObject(ctx_);
  JS_SetPropertyStr(ctx_, z, "inflate", JS_NewCFunction(ctx_, js_inflate, "inflate", 1));
  JS_SetPropertyStr(ctx_, z, "deflate", JS_NewCFunction(ctx_, js_deflate, "deflate", 1));
  JS_SetPropertyStr(ctx_, g, "WB_ZLIB", z);
  JS_FreeValue(ctx_, g);
  eval_script(kPrelude, "<prelude>");
}

JsHost::~JsHost() {
  JS_FreeContext(ctx_);
  JS_FreeRuntime(rt_);
}

// The folder with wbcore.js: $WBE_EDITOR_DIR; else "data" beside the program (a release); else beside
// the program or up to three folders above it (a build in editor/native/build finds editor/); else
// where the source was when it was built
std::string JsHost::editor_dir() {
  const char* env = std::getenv("WBE_EDITOR_DIR");
  if (env && *env) return env;
  std::error_code ec;
  fs::path d = program_dir();
  // a release keeps them in a "data" folder beside the program
  if (!d.empty() && fs::exists(d / "data" / "wbcore.js", ec)) return utf8_of(d / "data");
  for (int up = 0; up < 4 && !d.empty(); up++, d = d.parent_path()) {
    if (fs::exists(d / "wbcore.js", ec) && fs::exists(d / "native" / "js" / "editor.js", ec)) return utf8_of(d);
    if (d == d.parent_path()) break;
  }
  return WBE_EDITOR_DIR;
}

void JsHost::load_editor_script(const std::string& name) {
  std::string path = editor_dir() + "/" + name;
  auto src = read_file(path);
  eval_script(std::string(src.begin(), src.end()), path);
}

void JsHost::eval_script(const std::string& src, const std::string& filename) {
  // JS_Eval needs a NUL after the source
  JS_FreeValue(ctx_, check(JS_Eval(ctx_, src.c_str(), src.size(), filename.c_str(), JS_EVAL_TYPE_GLOBAL)));
}

JSValue JsHost::check(JSValue v) {
  if (JS_IsException(v)) throw_pending();
  return v;
}

void JsHost::throw_pending() {
  JSValue e = JS_GetException(ctx_);
  std::string msg = string_of(e);
  if (JS_IsError(e)) {
    JSValue st = JS_GetPropertyStr(ctx_, e, "stack");
    if (JS_IsString(st)) msg += "\n" + string_of(st);
    JS_FreeValue(ctx_, st);
  }
  JS_FreeValue(ctx_, e);
  throw JsError(msg);
}

JSValue JsHost::await(JSValue promise) {
  check(promise);
  for (;;) {
    switch (JS_PromiseState(ctx_, promise)) {
      case JS_PROMISE_NOT_A_PROMISE:
        return promise;
      case JS_PROMISE_FULFILLED: {
        JSValue r = JS_PromiseResult(ctx_, promise);
        JS_FreeValue(ctx_, promise);
        return r;
      }
      case JS_PROMISE_REJECTED: {
        JSValue r = JS_PromiseResult(ctx_, promise);
        JS_FreeValue(ctx_, promise);
        JS_Throw(ctx_, r);
        throw_pending();
      }
      case JS_PROMISE_PENDING: {
        JSContext* c;
        int r = JS_ExecutePendingJob(rt_, &c);
        if (r < 0) throw_pending();
        if (r == 0) {
          JS_FreeValue(ctx_, promise);
          throw JsError("A promise never settled (it waits on something the native host doesn't have)");
        }
      }
    }
  }
}

JSValue JsHost::global(const char* name) {
  JSValue g = JS_GetGlobalObject(ctx_);
  JSValue v = JS_GetPropertyStr(ctx_, g, name);
  JS_FreeValue(ctx_, g);
  return check(v);
}

JSValue JsHost::new_bytes(std::span<const uint8_t> bytes) {
  return check(JS_NewUint8ArrayCopy(ctx_, bytes.data(), bytes.size()));
}

std::vector<uint8_t> JsHost::bytes_of(JSValueConst v) {
  size_t n = 0;
  if (uint8_t* p = JS_GetUint8Array(ctx_, &n, v)) return {p, p + n};
  JS_FreeValue(ctx_, JS_GetException(ctx_));
  if (uint8_t* p = JS_GetArrayBuffer(ctx_, &n, v)) return {p, p + n};
  throw_pending();
}

std::string JsHost::string_of(JSValueConst v) {
  size_t n = 0;
  const char* s = JS_ToCStringLen(ctx_, &n, v);
  if (!s) return "<unprintable>";
  std::string out(s, n);
  JS_FreeCString(ctx_, s);
  return out;
}

}  // namespace wbe
