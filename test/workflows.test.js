"use strict";

// The workflows that test the kit on every push and before every release:
// the runners and the Node.js versions they test on, the step that lets
// Chrome's sandbox start placed before the tests, and a publish that waits
// for every test job. Read as text: Node comes with no YAML parser.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", name), "utf8");

for (const name of ["test.yml", "publish.yml"]) {
  test(`${name} tests on Ubuntu 22.04, Ubuntu 24.04 and ubuntu-latest, each with Node.js 22 and 24, and lets Chrome's sandbox start before the tests`, () => {
    const text = read(name);
    assert.match(text, /\n {6}fail-fast: false\n/);
    assert.match(text, /\n {8}os: \[ubuntu-22\.04, ubuntu-24\.04, ubuntu-latest\]\n {8}node: \[22, 24\]\n {4}runs-on: \$\{\{ matrix\.os \}\}\n/);
    assert.match(text, /\n {10}node-version: \$\{\{ matrix\.node \}\}\n/);
    const sandbox = text.indexOf("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
    const tests = text.indexOf("run: npm test");
    assert.ok(sandbox !== -1 && tests !== -1 && sandbox < tests, "the step that lets Chrome's sandbox start comes before npm test");
  });
}

test("publish.yml publishes only once every test job has passed, and only a tag that is the package's version", () => {
  const text = read("publish.yml");
  assert.match(text, /\n {2}publish:\n {4}needs: test\n/);
  assert.match(text, /test "\$\{GITHUB_REF_NAME#v\}" = "\$version"/);
  assert.ok(text.indexOf("Check the tag matches the version") < text.indexOf("npm publish --provenance"), "the tag is checked before the publish");
});
