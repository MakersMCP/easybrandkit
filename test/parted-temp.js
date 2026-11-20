"use strict";

// Why the kit starts no browser from this process's temp folder, in its own
// words, or false: on Linux, and on the other systems whose browser gets
// stand-ins, one whose path holds PATH's delimiter, where the browser's
// stand-ins could not come first on its PATH (see chrome.js launch). A test
// that starts a browser, or a program in its place, from a folder in it
// skips with that.

const os = require("node:os");
const path = require("node:path");

const partedTemp = process.platform !== "win32" && process.platform !== "darwin" && os.tmpdir().includes(path.delimiter) && `the path of the temp folder, ${os.tmpdir()}, has a ${path.delimiter} in it, which parts the folders of PATH, so the browser is not started from it`;

module.exports = { partedTemp };
