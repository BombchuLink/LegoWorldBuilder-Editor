// A QuickJS context set up to run the editor's wbcore.js: zlib for its (de)compression, the
// few browser APIs it uses, a way to load the editor's scripts and to wait for its promises.
#pragma once
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

#include "quickjs.h"

namespace wbe {

// A JS exception, with the script's stack trace in what()
struct JsError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

class JsHost {
 public:
  JsHost();
  ~JsHost();
  JsHost(const JsHost&) = delete;
  JsHost& operator=(const JsHost&) = delete;

  JSContext* ctx() const { return ctx_; }
  JSRuntime* rt() const { return rt_; }

  // Run a classic script (like a <script> tag) from the editor folder, e.g. "wbcore.js"
  void load_editor_script(const std::string& name);
  void eval_script(const std::string& src, const std::string& filename);

  // Run queued promise jobs until `promise` settles; returns its value (caller frees) or throws
  JSValue await(JSValue promise);

  // globalThis[name]
  JSValue global(const char* name);

  JSValue new_bytes(std::span<const uint8_t> bytes);
  // A Uint8Array's (or ArrayBuffer's) bytes, copied out
  std::vector<uint8_t> bytes_of(JSValueConst v);
  std::string string_of(JSValueConst v);

  // Throws JsError if v is an exception (and frees it); otherwise returns v
  JSValue check(JSValue v);

  // Folder holding wbcore.js: $WBE_EDITOR_DIR, else the one the build was made from
  static std::string editor_dir();

 private:
  [[noreturn]] void throw_pending();
  JSRuntime* rt_;
  JSContext* ctx_;
};

std::vector<uint8_t> read_file(const std::string& path);
void write_file(const std::string& path, std::span<const uint8_t> bytes);

}  // namespace wbe
