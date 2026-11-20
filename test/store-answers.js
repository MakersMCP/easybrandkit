"use strict";

// The stores' answers in tests, in place of the requests the kit makes to
// them over https (https.get, see stores.js): answer(url, options) gives
// { status, headers, body } for a request, or a promise of one, or fails as
// a request that fails does, or gives undefined for a request that is to go
// on as https.get makes it. Each answered request is kept, with the options
// it was made with, the lookup it connects through among them.

const https = require("node:https");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

function storeAnswers(t, answer) {
  const asked = [];
  const real = https.get;
  t.mock.method(https, "get", function (url, options, callback) {
    const at = new URL(String(url));
    let answered;
    try {
      answered = answer(at, options);
    } catch (err) {
      answered = Promise.reject(err);
    }
    if (answered === undefined) return real.call(this, url, options, callback);
    asked.push({ url: at.href, options });
    const req = new EventEmitter();
    req.destroy = () => req;
    Promise.resolve(answered).then(
      ({ status = 200, headers = {}, body = "" } = {}) => callback(Object.assign(Readable.from([Buffer.from(body)], { objectMode: false }), { statusCode: status, headers })),
      (err) => req.emit("error", err),
    );
    return req;
  });
  return asked;
}

// A request that never answers, and fails as Node's own does once the
// request's signal is aborted, as the kit's time limit for it does. It
// keeps the process up meanwhile, as a socket that waits does: the timer
// of that limit does not.
const neverAnswers = (options) =>
  new Promise((resolve, reject) => {
    const waiting = setInterval(() => {}, 1_000);
    options.signal.addEventListener("abort", () => {
      clearInterval(waiting);
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" }));
    });
  });

module.exports = { storeAnswers, neverAnswers };
