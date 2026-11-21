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

// The note of the page's words alone, which a test of the card leaves out.
const WORDS_NOTE = /^(The|Some of the) page's headings and button labels were not read: /;
const withoutWordsNote = (notes) => notes.filter((note) => !WORDS_NOTE.test(note));

// Whether a run's notes say that the card was not drawn for want of time,
// as on a busy machine: its tab stopped answering, or the run's time ran
// out.
const cardTimedOut = (notes) => notes.some((note) => /^The card could not be drawn: (the browser tab stopped answering|the run's time ran out)/.test(note));

// A run a test needs the card of, made again while a busy machine kept the
// card's tab from answering in time, three times at most: a card that is
// never drawn in time fails the test all the same. run gives { kit }.
async function drawingCard(run) {
  for (let tries = 1; ; tries++) {
    const done = await run();
    if (tries === 3 || !cardTimedOut(done.kit.notes)) return done;
  }
}

module.exports = { BUSY_NOTE, withoutBusyNotes, withoutUndrawnCard, withoutWordsNote, cardTimedOut, drawingCard };
