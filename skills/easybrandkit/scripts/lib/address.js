"use strict";

// Addresses on this machine or on a private network: loopback, private and
// link-local ones, and names such as localhost. easybrandkit opens a page on
// one only when the address the user gave is on that same host. A site, a
// store listing or a page's own redirect never leads it there on its own,
// to another program that listens on this machine, a router's page or a
// cloud server's metadata.

const net = require("net");
const { promises: dns } = require("dns");
const { isPublicAddress } = require("./stores");

// The names Chrome takes as this machine itself: localhost, and any name
// under it.
const OWN_NAME = /(^|\.)localhost\.?$/i;

// An address's host, without the brackets of an IPv6 one.
const bare = (url) => url.hostname.replace(/^\[|\]$/g, "");

// Whether an address is on a local or private network by its form alone: an
// IP address that is not public, or a name of this machine's own.
function localByForm(url) {
  const host = bare(url);
  return net.isIP(host) ? !isPublicAddress(host) : OWN_NAME.test(host);
}

// How long a name is looked up for. Chrome looks it up again itself, and a
// name that is not found is a page it cannot open.
const LOOKUP_WAIT = 5_000;

// Whether an address is on a local or private network: by its form, or a
// name any of whose addresses is. A name that cannot be looked up is not.
async function onLocalNetwork(url) {
  if (localByForm(url)) return true;
  const host = bare(url);
  if (net.isIP(host)) return false;
  let timer;
  try {
    const found = await Promise.race([dns.lookup(host, { all: true, verbatim: true }), new Promise((resolve) => (timer = setTimeout(resolve, LOOKUP_WAIT, [])))]);
    return found.some((record) => !isPublicAddress(record.address));
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Where such an address is, in words that can follow it.
const LOCAL = "is on a local or private network";

// Whether a web page may be opened or read when the address the user gave
// is given: always on that same host, and elsewhere when it is not on a
// local or private network. What is not a web page is not asked about here.
async function mayOpen(raw, given) {
  const url = new URL(raw);
  if (!/^https?:$/.test(url.protocol)) return true;
  return url.host.toLowerCase() === new URL(given).host.toLowerCase() || !(await onLocalNetwork(url));
}

module.exports = { localByForm, onLocalNetwork, mayOpen, LOCAL };
