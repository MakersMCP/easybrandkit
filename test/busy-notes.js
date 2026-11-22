"use strict";

// The notes a run adds on a busy machine, that the tab did not give all of
// the page's words in time or that the card could not be drawn in time (see
// kit.js), which a test that is not about them leaves out of an exact
// comparison of a run's notes: with them, such a test failed on load alone.
// A card that could not be drawn for any other reason, as a script error of
// the card's own page or an empty picture, is no such note, and fails the
// comparison.

// The note of the page's words, whose reasons are all of time: the run's ran
// out, or the tab stopped answering.
const WORDS_NOTE = /^(The|Some of the) page's headings and button labels were not read: /;

// The card's note for the reasons a busy machine gives: its tab stopped
// answering, the run's time ran out, or the browser did not open the card's
// tab or answer the kit's connection to it in time.
const CARD_BUSY = /^The card could not be drawn: (the browser tab stopped answering|the run's time ran out|the browser did not (open a tab|answer the kit's connection to its tab) (in \d+ s|before the run's time ran out))/;

const busyNote = (note) => WORDS_NOTE.test(note) || CARD_BUSY.test(note);

const withoutBusyNotes = (notes) => notes.filter((note) => !busyNote(note));

// The files of a kit as a test lists them, without card.png when a busy
// machine kept the card from being drawn, which the notes then say.
const withoutUndrawnCard = (names, notes) => (notes.some((note) => CARD_BUSY.test(note)) ? names.filter((name) => name !== "card.png") : names);

// The note of the page's words alone, which a test of the card leaves out.
const withoutWordsNote = (notes) => notes.filter((note) => !WORDS_NOTE.test(note));

// Whether a run's notes say that the card was not drawn for want of time,
// as on a busy machine.
const cardTimedOut = (notes) => notes.some((note) => CARD_BUSY.test(note));

// A run a test needs the card of, made again while a busy machine kept the
// card from being drawn in time, three times at most: a card that is never
// drawn in time fails the test all the same. run gives { kit }.
async function drawingCard(run) {
  for (let tries = 1; ; tries++) {
    const done = await run();
    if (tries === 3 || !cardTimedOut(done.kit.notes)) return done;
  }
}

module.exports = { CARD_BUSY, busyNote, withoutBusyNotes, withoutUndrawnCard, withoutWordsNote, cardTimedOut, drawingCard };
