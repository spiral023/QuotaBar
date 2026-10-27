import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const [format, ...files] = process.argv.slice(2);
assert(["npm", "bun"].includes(format) && files.length === 2);
for (const file of files) {
  const report = JSON.parse(readFileSync(file, "utf8"));
  assert(report && typeof report === "object" && !Array.isArray(report) && !report.error, `${file}: invalid audit response`);
  if (format === "npm") {
    assert(Number.isInteger(report.metadata?.dependencies?.total) && report.metadata.dependencies.total > 0, `${file}: missing dependency coverage`);
    for (const severity of ["high", "critical"]) assert(report.metadata?.vulnerabilities?.[severity] === 0, `${file}: ${severity} findings`);
    assert(report.vulnerabilities && typeof report.vulnerabilities === "object", `${file}: missing findings object`);
  } else {
    assert(readFileSync("bun.lock", "utf8").includes('"packages"'), "Missing populated Bun lockfile");
    for (const [name, advisories] of Object.entries(report)) {
      assert(Array.isArray(advisories) && advisories.length > 0, `${file}: invalid advisory list for ${name}`);
      for (const advisory of advisories) {
        assert(["low", "moderate", "high", "critical"].includes(advisory.severity) && typeof advisory.url === "string", `${file}: malformed advisory`);
        assert(!["high", "critical"].includes(advisory.severity), `${file}: ${name} has ${advisory.severity} findings`);
      }
    }
  }
  console.log(`${file}: valid ${format} audit, no high or critical findings`);
}
