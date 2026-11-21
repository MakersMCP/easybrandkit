"use strict";

// The notes a run adds on a busy machine, that the tab did not give all of
// the page's words in time or that the card could not be drawn (see
// kit.js), which a test that is not about them leaves out of an exact
// comparison of a run's notes: with them, such a test failed on load alone.

const BUSY_NOTE = /^((The|Some of the) page's headings and button labels were not read|The card could not be drawn): /;

const withoutBusyNotes = (notes) => notes.filter((note) => !BUSY_NOTE.test(note));

// The files of a kit as a test lists them, without card.png when the card
// could not be drawn, which the notes then say.
const withoutUndrawnCard = (names, notes) => (notes.some((note) => note.startsWith("The card could not be drawn: ")) ? names.filter((name) => name !== "card.png") : names);

module.exports = { BUSY_NOTE, withoutBusyNotes, withoutUndrawnCard };
