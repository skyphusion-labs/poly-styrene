// Usage: node scripts/check-bundle-exports.mjs <wrangler.jsonc> <bundle.js>
//
// Fails unless the built bundle exports every class the config names (workflows, durable objects,
// containers, exports). A wrangler dry run checks the bundle builds; it does not check that a class
// the config binds is still exported, and a missing one fails only at the real deploy.
import { readFileSync, statSync } from "node:fs";

const [configPath, bundlePath] = process.argv.slice(2);
if (!configPath || !bundlePath) {
  console.error("usage: check-bundle-exports.mjs <wrangler.jsonc> <bundle.js>");
  process.exit(2);
}

// JSONC: drop full-line and trailing // comments (none of our strings contain //).
const raw = readFileSync(configPath, "utf8")
  .split("\n")
  .map((line) => line.replace(/(^|[^:"])\/\/.*$/, "$1"))
  .join("\n");
const config = JSON.parse(raw);

const wanted = new Set();
for (const w of config.workflows ?? []) wanted.add(w.class_name);
for (const b of config.durable_objects?.bindings ?? []) wanted.add(b.class_name);
for (const c of config.containers ?? []) wanted.add(c.class_name);
for (const name of Object.keys(config.exports ?? {})) wanted.add(name);
if (wanted.size === 0) {
  console.error(`no classes found in ${configPath}; refusing to report a pass on an empty list`);
  process.exit(1);
}

let size = 0;
try {
  size = statSync(bundlePath).size;
} catch {
  console.error(`bundle not found: ${bundlePath}`);
  process.exit(1);
}
if (size === 0) {
  console.error(`bundle is empty: ${bundlePath}`);
  process.exit(1);
}

const bundle = readFileSync(bundlePath, "utf8");
const exported = new Set();
for (const m of bundle.matchAll(/export\s*\{([^}]*)\}/g)) {
  for (const part of m[1].split(",")) {
    const name = part.trim().split(/\s+as\s+/).pop()?.trim();
    if (name) exported.add(name);
  }
}

const missing = [...wanted].filter((n) => !exported.has(n));
console.log(`bundle ${size} bytes; config classes: ${[...wanted].sort().join(", ")}`);
if (missing.length) {
  console.error(`bundle does not export: ${missing.join(", ")}`);
  process.exit(1);
}
console.log("every bound class is exported");
