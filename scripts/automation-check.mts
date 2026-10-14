// Stichwort-Regeln: wann ein Wort im Transkript eine Aktion ausloest.
//
// WARUM ES DAS GIBT (2026-09-27): Der Smoke-Test prueft den Sendeweg ueber
// den Test-Knopf, aber nicht das Erkennen -- dafuer braeuchte er Vosk. Genau
// dort sitzen die teuren Fehler: „go" in „going" oder „cargo" loest mitten in
// der Show einen Cue aus, und ein doppelt erkanntes „go" loest ihn zweimal aus.
//
// Lauf: `npm run automation:check`
import assert from "node:assert/strict";
import {
  captionFeedError,
  captionMessage,
  createRateLimiter,
  defaultCaptionFeed,
  dueRules,
  encodeOscMessage,
  keywordMatches,
  matchingRules,
  ruleError,
} from "../apps/server/src/automation.ts";

assert.ok(keywordMatches("go", "Go!"));
assert.ok(keywordMatches("go", "standby, go"));
assert.ok(!keywordMatches("go", "going on"));
assert.ok(!keywordMatches("go", "cargo"));
assert.ok(keywordMatches("stand by", "Lights, stand   by please"), "Leerraum in der Wendung ist beliebig");
assert.ok(keywordMatches("Achtung", "achtung Bühne"), "Umlaute und Grossschreibung");
assert.ok(!keywordMatches("über", "darüber"), "Wortgrenze auch bei Umlauten");
assert.ok(keywordMatches("cue 3.5", "go cue 3.5 now"), "Sonderzeichen im Stichwort sind wortwoertlich");
assert.ok(!keywordMatches("  ", "anything"));
console.log("✓ ganze Woerter und Wendungen, ohne Gross/Klein, Unicode");

const osc = { kind: "osc" as const, host: "127.0.0.1", port: 8000, address: "/a" };
const rules = [
  { id: "a", keyword: "go", enabled: true, action: osc },
  { id: "b", keyword: "go", channelId: "ch2", enabled: true, action: osc },
  { id: "c", keyword: "go", enabled: false, action: osc },
];
assert.deepEqual(matchingRules(rules, { channelId: "ch1", text: "go" }).map((r) => r.id), ["a"]);
assert.deepEqual(matchingRules(rules, { channelId: "ch2", text: "go" }).map((r) => r.id), ["a", "b"]);
console.log("✓ Kanalfilter und abgeschaltete Regeln");

const hit = { channelId: "ch1", channelName: "SM", sender: "Caller", text: "go", ts: 10_000 };
assert.equal(dueRules([rules[0]], hit).length, 1);
assert.equal(dueRules([rules[0]], { ...hit, ts: 10_500 }).length, 0, "zweites go innerhalb einer Sekunde");
assert.equal(dueRules([rules[0]], { ...hit, ts: 11_100 }).length, 1);
console.log("✓ hoechstens einmal pro Sekunde");

assert.equal(ruleError({ keyword: "go", action: { kind: "webhook", url: "ftp://x" } }), "webhook URL must be http or https");
assert.equal(ruleError({ keyword: "go", action: { kind: "osc", host: "h", port: 70000, address: "/a" } }), "OSC port must be 1–65535");
assert.equal(ruleError({ keyword: "go", action: { kind: "osc", host: "h", port: 1, address: "a" } }), "OSC address must start with /");
assert.equal(ruleError({ keyword: "go", action: osc }), null);
console.log("✓ Eingaben werden geprueft");

const m = encodeOscMessage("/ab", ["xyz"]);
assert.equal(m.length % 4, 0);
assert.deepEqual([...m], [...Buffer.from("/ab\0,s\0\0xyz\0")]);
console.log("✓ OSC-Kodierung: NUL-terminiert, auf 4 Byte aufgefuellt");

const withInt = encodeOscMessage("/c", ["a", 3]);
assert.deepEqual([...withInt], [...Buffer.from("/c\0\0,si\0a\0\0\0"), 0, 0, 0, 3]);
console.log("✓ OSC-Kodierung: Ganzzahl als int32 big-endian");

// Live-Untertitel: jede Zeile, kein Stichwort, kein Sekundensperre -- aber
// nur die gewaehlten Kanaele und hoechstens 10 Zeilen pro Sekunde.
const feed = { ...defaultCaptionFeed(), enabled: true, port: 4210 };
const line = { channelId: "ch1", sender: "Cam 2", text: "  Kamera zwei bereit " };
assert.equal(feed.address, "/lzvm/caption");
assert.equal(captionMessage({ ...feed, enabled: false }, line), null, "abgeschaltet");
assert.equal(captionMessage(undefined, line), null, "alte Konfiguration ohne Feed");
assert.equal(captionMessage({ ...feed, channelIds: ["ch2"] }, line), null, "anderer Kanal");
assert.ok(captionMessage({ ...feed, channelIds: ["ch2", "ch1"] }, line), "gewaehlter Kanal");
assert.equal(captionMessage(feed, { ...line, text: "   " }), null, "leere Zeile");
assert.deepEqual([...captionMessage(feed, line)!], [...encodeOscMessage("/lzvm/caption", ["Kamera zwei bereit"])]);
assert.deepEqual(
  [...captionMessage({ ...feed, includeSpeaker: true, layer: 2 }, line)!],
  [...encodeOscMessage("/lzvm/caption", ["Cam 2: Kamera zwei bereit", 2])],
  "Sprecher im Text, Ebene als int -- der Mixer liest Argument 2 nur als Zahl",
);
const parts = captionMessage({ ...feed, includeSpeaker: true }, line)!.toString("utf8").split("\0").filter(Boolean);
assert.deepEqual(parts, ["/lzvm/caption", ",s", "Cam 2: Kamera zwei bereit"]);
console.log("✓ Live-Untertitel: Kanalfilter, Sprecher, Ebene, Kodierung");

const allowed = createRateLimiter(10, 1000);
const burst = Array.from({ length: 12 }, (_, i) => allowed(5_000 + i));
assert.equal(burst.filter(Boolean).length, 10, "zwoelf Zeilen in 12 ms: zwei verworfen");
assert.equal(allowed(5_999), false);
assert.equal(allowed(6_000), true, "nach einer Sekunde wieder frei");
const steady = createRateLimiter(10, 1000);
assert.ok([0, 300, 310, 320, 900].every((t) => steady(t)), "normale Sprechrate geht ungebremst durch");
console.log("✓ Live-Untertitel: hoechstens 10 pro Sekunde, sonst ungebremst");

assert.equal(captionFeedError(feed), null);
assert.equal(captionFeedError({ ...feed, host: " " }), "OSC host is empty");
assert.equal(captionFeedError({ ...feed, port: 0 }), "OSC port must be 1–65535");
assert.equal(captionFeedError({ ...feed, address: "lzvm/caption" }), "OSC address must start with /");
assert.equal(captionFeedError({ ...feed, layer: 0 }), "layer must be a whole number from 1");
assert.equal(captionFeedError({ ...feed, layer: 1.5 }), "layer must be a whole number from 1");
assert.equal(captionFeedError({ ...feed, channelIds: "ch1" as unknown as string[] }), "channelIds must be a list");
console.log("✓ Live-Untertitel: Eingaben werden geprueft");
