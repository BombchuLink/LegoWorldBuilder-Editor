// wbe-core <Launcher.exe> <resave|patch-on|patch-off|edit> [out.exe]
// Runs the editor's wbcore.js in QuickJS through js/driver.js (the same steps Node runs in
// test/compare.js) and prints the driver's report.
#include <chrono>
#include <cstdio>
#include <exception>

#include "procstats.h"

#include "js_host.h"

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: %s <Launcher.exe> <resave|patch-on|patch-off|edit> [out.exe]\n", argv[0]);
    return 2;
  }
  try {
    auto t0 = std::chrono::steady_clock::now();
    wbe::JsHost js;
    js.load_editor_script("js/wb1monsters.js");
    js.load_editor_script("js/wbcore.js");
    js.load_editor_script("js/driver.js");
    auto t1 = std::chrono::steady_clock::now();

    auto input = wbe::read_file(argv[1]);
    JSContext* ctx = js.ctx();
    JSValue driver = js.global("WBE_DRIVER");
    JSValue run = js.check(JS_GetPropertyStr(ctx, driver, "run"));
    JSValue args[2] = {js.new_bytes(input), JS_NewString(ctx, argv[2])};
    JSValue result = js.await(JS_Call(ctx, run, driver, 2, args));
    for (JSValue& a : args) JS_FreeValue(ctx, a);

    JSValue bytes = JS_GetPropertyStr(ctx, result, "bytes");
    JSValue report = JS_GetPropertyStr(ctx, result, "report");
    JSValue json = js.check(JS_JSONStringify(ctx, report, JS_UNDEFINED, JS_UNDEFINED));
    auto out = js.bytes_of(bytes);
    auto t2 = std::chrono::steady_clock::now();
    if (argc > 3) wbe::write_file(argv[3], out);

    JSMemoryUsage mu;
    JS_ComputeMemoryUsage(js.rt(), &mu);
    auto ms = [](auto a, auto b) { return std::chrono::duration_cast<std::chrono::milliseconds>(b - a).count(); };
    std::printf("%s\n", js.string_of(json).c_str());
    std::printf("{\"native\":{\"loadScriptsMs\":%lld,\"runMs\":%lld,\"outBytes\":%zu,\"jsHeapMB\":%.1f,\"peakRssMB\":%.1f}}\n",
                static_cast<long long>(ms(t0, t1)), static_cast<long long>(ms(t1, t2)), out.size(),
                mu.memory_used_size / 1048576.0, wbe::peak_memory_mb());
    for (JSValue v : {json, report, bytes, result, run, driver}) JS_FreeValue(ctx, v);
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "error: %s\n", e.what());
    return 1;
  }
}
