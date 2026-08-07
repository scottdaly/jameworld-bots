#!/usr/bin/env node
// Patch ai-sdk-provider-gemini-cli to bypass Gemini 3.x's mandatory
// thoughtSignature on functionCall parts.
//
// As of provider v2.0.1 the package does NOT preserve `thoughtSignature`
// across multi-turn tool calls. Gemini 3.x rejects requests where prior
// functionCall parts lack a signature, which kills the multi-step tool loop.
//
// SYNTHETIC_THOUGHT_SIGNATURE = "skip_thought_signature_validator" is the
// magic string the official Gemini CLI uses for the same purpose; Google's
// API accepts it as a placeholder. We inject it on every outgoing
// functionCall part so multi-step tool use works.
//
// Remove this patch once upstream lands real signature preservation.

const fs = require("fs");
const path = require("path");

const FILE = "node_modules/ai-sdk-provider-gemini-cli/dist/index.mjs";
const MARK = "/* DATA_BOY_THOUGHT_SIG_PATCH */";

const NEEDLE = `      case "tool-call":
        parts.push({
          functionCall: {
            name: part.toolName,
            args: part.input || {}
          }
        });
        break;`;

// thoughtSignature is a property of the Part (sibling to functionCall), not
// inside functionCall itself. Per gemini-cli-core's hardenHistory:
// only the FIRST function call in a model turn needs a signature.
const REPLACEMENT = `      case "tool-call": { ${MARK}
        const _newPart = {
          functionCall: {
            name: part.toolName,
            args: part.input || {}
          }
        };
        if (!parts.some((p) => "functionCall" in p)) {
          _newPart.thoughtSignature = "skip_thought_signature_validator";
        }
        parts.push(_newPart);
        break;
      }`;

const full = path.resolve(FILE);
if (!fs.existsSync(full)) {
  console.error(`Patch target not found: ${full}`);
  process.exit(1);
}
let src = fs.readFileSync(full, "utf8");
if (src.includes(MARK)) {
  console.log("Already patched, skipping.");
  process.exit(0);
}
if (!src.includes(NEEDLE)) {
  console.error("Patch needle not found — provider source has drifted. Manual review needed.");
  process.exit(2);
}
src = src.replace(NEEDLE, REPLACEMENT);
fs.writeFileSync(full, src);
console.log("Patched ai-sdk-provider-gemini-cli mapAssistantMessage with thoughtSignature bypass.");
