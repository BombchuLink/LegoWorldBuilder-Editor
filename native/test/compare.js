// Runs native/js/driver.js in Node (V8) and in the native QuickJS
// build on the same game files, and checks the files they write are the same.
//   node test/compare.js <out dir> <Launcher.exe>...
// Byte-identical output is "same"; otherwise every resource is compared after decompression
// ("same content": only zlib's choices differ) and anything else is a failure.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const WB = require("../../wbcore.js");
const driver = require("../js/driver.js");

const BIN = process.env.WBE_CORE || path.join(__dirname, "../build/wbe-core");
const OPS = ["resave", "patch-on", "patch-off", "edit"];

async function sameContent(a, b) {
  const [ma, mb] = [await WB.openMovie(a), await WB.openMovie(b)];
  const diffs = [];
  if (Buffer.compare(Buffer.from(ma.wrapper.stub), Buffer.from(mb.wrapper.stub)) || Buffer.compare(Buffer.from(ma.wrapper.trailer), Buffer.from(mb.wrapper.trailer))) diffs.push("projector stub/trailer");
  if (ma.entries.length !== mb.entries.length) diffs.push(`entry count ${ma.entries.length} vs ${mb.entries.length}`);
  for (let i = 0; i < Math.min(ma.entries.length, mb.entries.length); i++) {
    const ea = ma.entries[i], eb = mb.entries[i];
    if (ea.id !== eb.id || ea.tag !== eb.tag || ea.usize !== eb.usize || ea.ctype !== eb.ctype) { diffs.push(`entry ${i} header`); continue; }
    if (ea.id === 2) continue;
    const da = await ma.data(ea.id), db = await mb.data(eb.id);
    if (!!da !== !!db || (da && Buffer.compare(Buffer.from(da), Buffer.from(db)))) diffs.push(`entry ${ea.id} ${ea.tag} data`);
  }
  return diffs;
}

(async () => {
  const [outDir, ...files] = process.argv.slice(2);
  fs.mkdirSync(outDir, { recursive: true });
  let failed = 0;
  for (const file of files) {
    const input = fs.readFileSync(file);
    const label = path.basename(path.dirname(file)) + "/" + path.basename(file);
    for (const op of OPS) {
      const v8 = await driver.run(new Uint8Array(input.buffer, input.byteOffset, input.length), op);
      const nativeOut = path.join(outDir, `${label.replace(/\W+/g, "_")}.${op}.native.exe`);
      const r = spawnSync(BIN, [file, op, nativeOut], { encoding: "utf8" });
      if (r.status !== 0) { console.log(`FAIL ${label} ${op}: native exited ${r.status} ${r.error || ""}\n${r.stderr}`); failed++; continue; }
      const lines = r.stdout.trim().split("\n");
      const qReport = JSON.parse(lines[0]), qNative = JSON.parse(lines[1]).native;
      const rss = qNative.peakRssMB * 1024;
      const nb = fs.readFileSync(nativeOut);
      const strip = (x) => JSON.stringify({ ...x, ms: undefined, detail: undefined });
      let verdict;
      if (strip(qReport) !== strip(v8.report)) verdict = "FAIL reports differ";
      else if (Buffer.compare(nb, Buffer.from(v8.bytes)) === 0) verdict = "same bytes";
      else { const d = await sameContent(nb, v8.bytes); verdict = d.length ? "FAIL " + d.slice(0, 5).join(", ") : "same content"; }
      if (verdict.startsWith("FAIL")) failed++;
      const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
      console.log(`${verdict.padEnd(14)} ${label.padEnd(36)} ${op.padEnd(9)} V8 ${String(sum(v8.report.ms)).padStart(4)} ms | QuickJS ${String(sum(qReport.ms)).padStart(5)} ms (${Object.entries(qReport.ms).map(([k, v]) => k + " " + v).join(", ")}), peak RSS ${(rss / 1024).toFixed(0)} MB, JS heap ${qNative.jsHeapMB} MB`);
      if (process.env.DETAIL) {
        const top = (o) => Object.entries(o).filter(([, v]) => v >= 20).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
        console.log(`               QuickJS slow steps: ${top({ ...qReport.detail.finds, ...qReport.detail.changes })}`);
        console.log(`               V8 slow steps:      ${top({ ...v8.report.detail.finds, ...v8.report.detail.changes }) || "-"}`);
      }
      if (op === "resave") console.log(`               patches before: ${qReport.patches.join(" ")} tutorial ${qReport.tutorial}`);
      if (verdict.startsWith("FAIL")) { console.log("  V8 report:", strip(v8.report)); console.log("  QJS report:", strip(qReport)); }
    }
  }
  console.log(failed ? `${failed} FAILED` : "all match");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
