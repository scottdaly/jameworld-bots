// Run me: node tests/preview-test.js
// Pure filesystem test for nominatedPreview(): the agent's own screenshot is
// used only when it is a real PNG of sane size at the agreed path.
process.env.TOASTER_MAX_PREVIEW_BYTES = "4096";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { nominatedPreview } = require("../toaster-feature.js");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (extra ? "\n     " + extra : "")); }
}

const root = path.join(os.tmpdir(), "toaster-preview-test-" + Date.now());
const workDir = path.join(root, "job");
const scratch = workDir + "-scratch";
fs.mkdirSync(scratch, { recursive: true });
const target = path.join(scratch, "preview.png");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 1),
]);

check("nothing nominated -> null", nominatedPreview(workDir) === null);

fs.writeFileSync(target, PNG);
check("a real PNG at <workDir>-scratch/preview.png is picked up",
  nominatedPreview(workDir) === target, String(nominatedPreview(workDir)));

fs.writeFileSync(target, Buffer.from("<html>not a picture</html>" + "x".repeat(100)));
check("an HTML body (a failed curl, say) is refused", nominatedPreview(workDir) === null);

fs.writeFileSync(target, PNG.subarray(0, 20));
check("a truncated file is refused", nominatedPreview(workDir) === null);

fs.writeFileSync(target, Buffer.concat([PNG, Buffer.alloc(5000, 2)]));
check("an oversize file is refused", nominatedPreview(workDir) === null);

fs.rmSync(target); fs.mkdirSync(target);
check("a directory at that path is refused", nominatedPreview(workDir) === null);

// The path the prompt tells the agent to use must be the path checked here.
const prompt = fs.readFileSync(path.join(__dirname, "..", "feature-prompt.md"), "utf8");
check("feature-prompt.md tells the agent to write $PWD-scratch/preview.png",
  prompt.includes("$PWD-scratch/preview.png"));

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
