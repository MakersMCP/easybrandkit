"use strict";

// Why the kit starts no browser from this process's temp folder, in its own
// words, or false, as a test's skip takes them. partedTemp: on Linux, and on
// the other systems whose browser gets stand-ins, one whose path holds
// PATH's delimiter, where the browser's stand-ins could not come first on
// its PATH (see chrome.js launch). roomlessTemp: on Linux and macOS one
// whose path leaves the browser no room for the socket it makes there, as
// org.chromium.Chromium.XXXXXX/SingletonSocket for Chromium, whose name is
// the longest of the four browsers' (see chrome.js socketTooLong): 107
// bytes at most on Linux and 103 on macOS. A test that starts a browser, or
// a program in its place that needs what the browser needs, skips with
// those; the tests of these refusals themselves run there too.

const os = require("node:os");
const path = require("node:path");

const temp = path.resolve(os.tmpdir());
const partedTemp = process.platform !== "win32" && process.platform !== "darwin" && temp.includes(path.delimiter) && `the path of the temp folder, ${temp}, has a ${path.delimiter} in it, which parts the folders of PATH, so the browser is not started from it`;
const socket = Buffer.byteLength(path.join(temp, "org.chromium.Chromium.XXXXXX", "SingletonSocket"));
const roomlessTemp = process.platform !== "win32" && socket > (process.platform === "linux" ? 107 : 103) && `the path of the temp folder, ${temp}, is too long for the socket the browser makes in it, whose path would be ${socket} bytes`;

module.exports = { partedTemp, roomlessTemp };
