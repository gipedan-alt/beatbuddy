/*
 * Live tempo: mocked MIDI output. Run: node test/tempo.js
 * Loads the songbook script from src/songs.template.html (same script as songs.html)
 * and checks CC106/CC107 bytes, ±1 BPM, the 40–300 clamp, and that a nudge does not
 * resend the song, cancel auto-start, or change the saved song list.
 */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');
var assert = require('assert');

// Values created inside the vm have that realm's Array prototype, so compare by value.
function eq(actual, expected, msg) {
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(expected), msg || JSON.stringify(actual));
}

var root = path.join(__dirname, '..');
var template = fs.readFileSync(path.join(root, 'src/songs.template.html'), 'utf8');
var page = fs.readFileSync(path.join(root, 'songs.html'), 'utf8');

function appScript(html) {
  var m = html.match(/<script>\n([\s\S]*)<\/script>\s*<\/body>/);
  if (!m) throw new Error('app script not found');
  return m[1];
}

assert.strictEqual(appScript(template), appScript(page), 'songs.html script drifted from the template');

function loadApi(html) {
  var sandbox = { console: console, module: { exports: {} }, URL: URL };
  vm.createContext(sandbox);
  vm.runInContext(appScript(html), sandbox, { filename: 'songs.template.html' });
  return sandbox.module.exports;
}

var api = loadApi(template);
assert.strictEqual(loadApi(page).BPM_DEFAULT, 120);

function mockOut() {
  var sent = [];
  return {
    sent: sent,
    send: function (bytes) { sent.push(Array.prototype.slice.call(bytes)); }
  };
}

function clock() {
  var q = [];
  var n = 0;
  return {
    q: q,
    setTimeout: function (fn, ms) { var id = ++n; q.push({ id: id, fn: fn, ms: ms, cleared: false }); return id; },
    clearTimeout: function (id) { q.forEach(function (t) { if (t.id === id) t.cleared = true; }); },
    flushNext: function () {
      var t = q.shift();
      if (!t) throw new Error('no timer');
      if (!t.cleared) t.fn();
      return t;
    }
  };
}

function hex(bytes) {
  return bytes.map(function (b) { return b.toString(16).toUpperCase().padStart(2, '0'); }).join(' ');
}

// Manual fw 4.1.6 "Tempo MSB & Tempo LSB": BPM = CC106 * 128 + CC107, MSB then LSB, range 40–300.
// Examples reconstructed from the manual's table: 40, 127, 128, 300.
var cases = [
  [40, 1, 0xB0, 0, 40],
  [127, 1, 0xB0, 0, 127],
  [128, 1, 0xB0, 1, 0],
  [152, 1, 0xB0, 1, 24],
  [120, 1, 0xB0, 0, 120],
  [300, 1, 0xB0, 2, 44],
  [256, 1, 0xB0, 2, 0],
  [120, 16, 0xBF, 0, 120]
];
cases.forEach(function (c) {
  var msgs = api.tempoMessages(c[0], c[1]);
  eq(msgs, [[c[2], 106, c[3]], [c[2], 107, c[4]]], hex(msgs[0]) + ' / ' + c);
  assert.strictEqual(msgs[0][2] * 128 + msgs[1][2], c[0]);
  assert.ok(msgs[0][2] <= 127 && msgs[1][2] <= 127);
});

for (var bpm = 40; bpm <= 300; bpm++) {
  var built = api.buildSongMessages({ folder: 1, songnum: 1, bpm: bpm }, 1).tempo;
  var live = api.tempoMessages(bpm, 1);
  eq(built, live, 'song-select tempo and live tempo diverged at ' + bpm);
  assert.strictEqual(built[0][2] * 128 + built[1][2], bpm);
  assert.strictEqual(api.nudgeTempo(bpm, 1), bpm === 300 ? 300 : bpm + 1);
  assert.strictEqual(api.nudgeTempo(bpm, -1), bpm === 40 ? 40 : bpm - 1);
  assert.strictEqual(api.nudgeTempo(bpm, 2), bpm, 'step other than 1');
  assert.strictEqual(api.nudgeTempo(bpm, 10), bpm);
  assert.strictEqual(api.nudgeTempo(bpm, 0), bpm);
  assert.strictEqual(api.nudgeTempo(bpm, -5), bpm);
}

eq(api.tempoMessages(39, 1), api.tempoMessages(40, 1));
eq(api.tempoMessages(999, 1), api.tempoMessages(300, 1));
eq(api.tempoMessages(NaN, 1), api.tempoMessages(120, 1));

eq(api.initialBpm({ bpm: 152 }), { bpm: 152, isDefault: false });
eq(api.initialBpm({ bpm: 40 }), { bpm: 40, isDefault: false });
eq(api.initialBpm({ bpm: 300 }), { bpm: 300, isDefault: false });
eq(api.initialBpm({ bpm: null }), { bpm: 120, isDefault: true });
eq(api.initialBpm({}), { bpm: 120, isDefault: true });
eq(api.initialBpm({ bpm: 39 }), { bpm: 120, isDefault: true });
eq(api.initialBpm({ bpm: 301 }), { bpm: 120, isDefault: true });
assert.strictEqual(api.buildSongMessages({ folder: 1, songnum: 1, bpm: null }, 1).tempo, null);
assert.strictEqual(api.buildSongMessages({ folder: 1, songnum: 1 }, 1).tempo, null);

// Song select still sends bank, folder, program change, then delayed tempo — and nothing else.
var t = clock();
var out = mockOut();
var opened = [];
var song = { key: 'r6', title: 'All Who Are Thirsty', folder: 1, songnum: 27, bpm: 152, tab: 'https://tabs.ultimate-guitar.com/tab/x' };
var live = api.initialBpm(song);
var r = api.tapSong(song, {
  out: out, win: { open: function (url) { opened.push(url); } },
  setTimeout: t.setTimeout, clearTimeout: t.clearTimeout,
  ch: 1, delay: 400, openTabs: true, autoStart: true, startDelay: 600,
  tempoNow: function () { return live.bpm; }
});
assert.strictEqual(r.sent, true);
assert.strictEqual(r.opened, true);
eq(opened, ['https://tabs.ultimate-guitar.com/tab/x']);
eq(out.sent, [
  [0xB0, 0x00, 0],
  [0xB0, 0x20, 0],
  [0xC0, 26]
]);
assert.strictEqual(r.cancelled, false);
assert.strictEqual(r.startAt, 1000);

// Nudge +1 while the beat's tempo/start timers are still pending. Must not cancel them.
var cancelBefore = r.cancel;
var cancelledFlag = false;
var realCancel = r.cancel;
r.cancel = function () { cancelledFlag = true; realCancel(); };
live = { bpm: api.nudgeTempo(live.bpm, 1), isDefault: false };
assert.strictEqual(live.bpm, 153);
api.tempoMessages(live.bpm, 1).forEach(function (b) { out.send(b); });
assert.strictEqual(cancelledFlag, false, 'nudge must not cancel the song timers');
assert.strictEqual(r.cancelled, false);
eq(out.sent.slice(3), [
  [0xB0, 106, 1],
  [0xB0, 107, 25]
]);

// Queued tempo follows the nudge (153), then auto-start still fires. No second song select.
t.flushNext();
eq(out.sent.slice(5), [
  [0xB0, 106, 1],
  [0xB0, 107, 25]
]);
t.flushNext();
eq(out.sent[out.sent.length - 1], [0xB0, 114, 1]);
out.sent.forEach(function (b, i) {
  if (i < 3) return;
  assert.notStrictEqual(b[0] & 0xF0, 0xC0, 'program change after the nudge');
});
eq(out.sent.filter(function (b) { return b[0] === 0xFC; }), []);
assert.strictEqual(out.sent.filter(function (b) { return b[1] === 114; }).length, 1);

// Further ±1 while "playing": only a tempo pair, song stays running.
var mark = out.sent.length;
live.bpm = api.nudgeTempo(live.bpm, -1);
api.tempoMessages(live.bpm, 1).forEach(function (b) { out.send(b); });
assert.strictEqual(live.bpm, 152);
eq(out.sent.slice(mark), [[0xB0, 106, 1], [0xB0, 107, 24]]);
assert.strictEqual(r.cancelled, false);
void cancelBefore;

// A new song resets to its own bpm. The previous auto-start must not leak,
// and the new delayed tempo is the new song's bpm, not the nudged one.
var songB = { key: 'r12', title: 'Champion', folder: 3, songnum: 3, bpm: 72, tab: null };
r.cancel();
assert.strictEqual(r.cancelled, true);
live = api.initialBpm(songB);
eq(live, { bpm: 72, isDefault: false });
var outB = mockOut();
var tB = clock();
var openedB = [];
var rB = api.tapSong(songB, {
  out: outB, win: { open: function (url) { openedB.push(url); } },
  setTimeout: tB.setTimeout, clearTimeout: tB.clearTimeout,
  ch: 1, delay: 400, openTabs: true, autoStart: false, startDelay: 600,
  tempoNow: function () { return live.bpm; }
});
eq(openedB, [], 'no tab on a song that has none, and the nudge did not open one');
eq(outB.sent, [
  [0xB0, 0x00, 0],
  [0xB0, 0x20, 2],
  [0xC0, 2]
]);
tB.flushNext();
eq(outB.sent.slice(3), [[0xB0, 106, 0], [0xB0, 107, 72]]);
assert.strictEqual(tB.q.length, 0, 'auto-start was off, so no start timer');
assert.strictEqual(rB.cancelled, false);

// No saved bpm: song select sends no tempo (unchanged). The control starts at 120.
// Pressing − sends 119 only. A pending auto-start is not cancelled.
var bare = { key: 'r168', title: 'A Mighty Fortress Is Our God', folder: 17, songnum: 6, bpm: null, tab: 'http://example.com/tab' };
eq(api.initialBpm(bare), { bpm: 120, isDefault: true });
var outC = mockOut();
var tC = clock();
var opensC = 0;
live = api.initialBpm(bare);
var rC = api.tapSong(bare, {
  out: outC, win: { open: function () { opensC++; } },
  setTimeout: tC.setTimeout, clearTimeout: tC.clearTimeout,
  ch: 3, delay: 400, openTabs: true, autoStart: true, startDelay: 600,
  tempoNow: function () { return live.bpm; }
});
assert.strictEqual(opensC, 1);
eq(outC.sent, [
  [0xB2, 0x00, 0],
  [0xB2, 0x20, 16],
  [0xC2, 5]
]);
assert.strictEqual(rC.startAt, 1000);
live = { bpm: api.nudgeTempo(live.bpm, -1), isDefault: false };
assert.strictEqual(live.bpm, 119);
api.tempoMessages(live.bpm, 3).forEach(function (b) { outC.send(b); });
eq(outC.sent.slice(3), [[0xB2, 106, 0], [0xB2, 107, 119]]);
assert.strictEqual(rC.cancelled, false);
tC.flushNext();
eq(outC.sent[outC.sent.length - 1], [0xB2, 114, 1], 'auto-start still sent on channel 3');

// At the clamp, a further step does not emit another tempo message.
var atMax = api.nudgeTempo(300, 1);
assert.strictEqual(atMax, 300);
var atMin = api.nudgeTempo(40, -1);
assert.strictEqual(atMin, 40);

// Stop and Start beat are unchanged, and Start still cancels pending timers.
eq(api.STOP, [0xFC]);
var outD = mockOut();
var tD = clock();
var rD = api.tapSong({ folder: 2, songnum: 4, bpm: 90, tab: null }, {
  out: outD, win: { open: function () {} },
  setTimeout: tD.setTimeout, clearTimeout: tD.clearTimeout,
  ch: 1, delay: 400, openTabs: false, autoStart: true, startDelay: 600
});
var started = api.startBeat({ out: outD, ch: 1, cancel: rD.cancel });
assert.strictEqual(started.sent, true);
eq(started.bytes, [0xB0, 114, 1]);
assert.strictEqual(rD.cancelled, true);
eq(outD.sent[outD.sent.length - 1], [0xB0, 114, 1]);
tD.flushNext();
assert.ok(outD.sent.every(function (b) { return !(b[1] === 106); }), 'cancelled tempo never sends');

// Without tempoNow, the delayed tempo is exactly the song bpm (previous behaviour).
var outE = mockOut();
var tE = clock();
api.tapSong({ folder: 1, songnum: 1, bpm: 128, tab: null }, {
  out: outE, win: { open: function () {} },
  setTimeout: tE.setTimeout, clearTimeout: tE.clearTimeout,
  ch: 1, delay: 400, openTabs: false, autoStart: false
});
tE.flushNext();
eq(outE.sent, [
  [0xB0, 0x00, 0],
  [0xB0, 0x20, 0],
  [0xC0, 0],
  [0xB0, 106, 1],
  [0xB0, 107, 0]
]);

// Song data in the committed page is the existing 199-song book, unchanged.
var jsonMatch = page.match(/<script type="application\/json" id="songs-data">\n(.*)\n<\/script>/);
assert.ok(jsonMatch, 'songs-data block');
var digest = crypto.createHash('sha256').update(jsonMatch[1]).digest('hex');
assert.strictEqual(digest, '799dac110425bb6fe8c99b17399185227b6d4161d6cf7f5d49bddc471c6564fa');
var songs = JSON.parse(jsonMatch[1]);
assert.strictEqual(songs.length, 199);
var praise = songs.filter(function (s) { return s.title === 'Praise' && s.artist === 'Elevation Worship'; })[0];
assert.strictEqual(praise.bpm, 127);
assert.strictEqual(praise.folder, 26);
assert.strictEqual(praise.songnum, 4);
var bareSong = songs.filter(function (s) { return s.key === 'r168'; })[0];
assert.strictEqual(bareSong.bpm, null);
assert.strictEqual(songs.filter(function (s) { return s.bpm == null; }).length, 15);

console.log('ok ' + songs.length + ' songs, tempo bytes checked for 40–300');
