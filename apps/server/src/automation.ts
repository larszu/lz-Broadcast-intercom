// Keyword rules: a word in a transcript line sends a webhook or an OSC message.
//
// The use case is the show caller's "standby" or "go" reaching a playback or
// lighting console without someone pressing a key, and "emergency" paging a
// stage manager's phone through a webhook. A rule only ever SENDS: nothing in
// a transcript line may choose what runs on the core machine, which is why
// there is no local-command action.
import dgram from "node:dgram";
import type { CaptionFeed, KeywordAction, KeywordRule } from "@broadcast/shared";

export interface TranscriptHit {
	channelId: string;
	channelName: string;
	sender: string;
	text: string;
	ts: number;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole word or phrase, case-insensitive, Unicode-aware: "go" fires on
 * "Go!" and "standby, go" but not on "going" or "cargo". Whitespace inside a
 * phrase matches any run of whitespace — speech recognition does not promise
 * single spaces.
 */
export function keywordMatches(keyword: string, text: string): boolean {
	const words = keyword.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return false;
	const pattern = words.map(escapeRegExp).join("\\s+");
	return new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export function matchingRules(rules: KeywordRule[], hit: Pick<TranscriptHit, "channelId" | "text">): KeywordRule[] {
	return rules.filter(
		(r) => r.enabled && (!r.channelId || r.channelId === hit.channelId) && keywordMatches(r.keyword, hit.text),
	);
}

/** Validates user input; returns the error text or null. */
export function ruleError(rule: Partial<KeywordRule>): string | null {
	if (!rule.keyword || !String(rule.keyword).trim()) return "keyword is empty";
	const a = rule.action as KeywordAction | undefined;
	if (!a) return "action is missing";
	if (a.kind === "webhook") {
		let u: URL;
		try {
			u = new URL(a.url);
		} catch {
			return "webhook URL is not a URL";
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") return "webhook URL must be http or https";
		return null;
	}
	if (a.kind === "osc") return oscTargetError(a);
	return "unknown action";
}

function oscTargetError(t: { host?: string; port?: number; address?: string }): string | null {
	if (!t.host || !String(t.host).trim()) return "OSC host is empty";
	if (!Number.isInteger(t.port) || (t.port as number) < 1 || (t.port as number) > 65535) return "OSC port must be 1–65535";
	if (!String(t.address ?? "").startsWith("/")) return "OSC address must start with /";
	return null;
}

// ── OSC 1.0 encoding (strings only) ─────────────────────────────────────────
// Strings are NUL-terminated and padded to a multiple of four bytes.
function oscString(s: string): Buffer {
	const raw = Buffer.from(s, "utf8");
	const len = Math.ceil((raw.length + 1) / 4) * 4;
	const out = Buffer.alloc(len);
	raw.copy(out);
	return out;
}

function oscInt(n: number): Buffer {
	const out = Buffer.alloc(4);
	out.writeInt32BE(n);
	return out;
}

/** Strings become `s`, integers `i` (int32, big-endian). */
export function encodeOscMessage(address: string, args: Array<string | number>): Buffer {
	const tags = "," + args.map((a) => (typeof a === "number" ? "i" : "s")).join("");
	return Buffer.concat([oscString(address), oscString(tags), ...args.map((a) => (typeof a === "number" ? oscInt(a) : oscString(a)))]);
}

function sendOsc(host: string, port: number, msg: Buffer): Promise<string | null> {
	const sock = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
	return new Promise<string | null>((resolve) => {
		sock.send(msg, port, host, (err) => {
			sock.close();
			resolve(err ? `OSC send failed: ${err.message}` : null);
		});
	});
}

const WEBHOOK_TIMEOUT_MS = 3000;

/** Sends the action; resolves with an error text or null. Never throws. */
export async function fireAction(rule: KeywordRule, hit: TranscriptHit): Promise<string | null> {
	const a = rule.action;
	try {
		if (a.kind === "webhook") {
			const res = await fetch(a.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rule: { id: rule.id, keyword: rule.keyword }, ...hit }),
				signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
			});
			return res.ok ? null : `webhook answered ${res.status}`;
		}
		return await sendOsc(a.host, a.port, encodeOscMessage(a.address, [hit.text, hit.channelName, hit.sender, rule.keyword]));
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}

/**
 * A rule fires at most once per second. A recogniser that splits one spoken
 * "go" across two final results, or a caller who says "go, go", must not
 * fire a cue twice.
 */
const MIN_INTERVAL_MS = 1000;
const lastFired = new Map<string, number>();

export function dueRules(rules: KeywordRule[], hit: TranscriptHit): KeywordRule[] {
	return matchingRules(rules, hit).filter((r) => {
		const last = lastFired.get(r.id) ?? -Infinity;
		if (hit.ts - last < MIN_INTERVAL_MS) return false;
		lastFired.set(r.id, hit.ts);
		return true;
	});
}

// ── Live caption feed ───────────────────────────────────────────────────────
// Every final transcript line of the chosen channels goes out as one OSC
// message, e.g. to LZ Vision Mixer's `/lzvm/caption s:text [i:layer]`. The
// mixer reads the first argument as the caption and a second one only as a
// layer number, so the speaker is folded into the text instead of being sent
// as an extra string.

export function defaultCaptionFeed(): CaptionFeed {
	return { enabled: false, host: "127.0.0.1", port: 4210, address: "/lzvm/caption", channelIds: [], includeSpeaker: false };
}

/** Validates user input; returns the error text or null. */
export function captionFeedError(feed: Partial<CaptionFeed>): string | null {
	const err = oscTargetError(feed);
	if (err) return err;
	if (!Array.isArray(feed.channelIds)) return "channelIds must be a list";
	if (feed.layer !== undefined && (!Number.isInteger(feed.layer) || feed.layer < 1)) return "layer must be a whole number from 1";
	return null;
}

/** The OSC message for a line, or null when the feed is off or the channel is not selected. */
export function captionMessage(feed: CaptionFeed | undefined, hit: Pick<TranscriptHit, "channelId" | "sender" | "text">): Buffer | null {
	if (!feed?.enabled) return null;
	if (feed.channelIds.length > 0 && !feed.channelIds.includes(hit.channelId)) return null;
	const text = hit.text.trim();
	if (!text) return null;
	const caption = feed.includeSpeaker && hit.sender ? `${hit.sender}: ${text}` : text;
	return encodeOscMessage(feed.address, feed.layer !== undefined ? [caption, feed.layer] : [caption]);
}

/**
 * Lines go out as they come, but no more than `max` within `windowMs`: a
 * recogniser stuck in a loop must not flood the show network.
 */
export function createRateLimiter(max: number, windowMs: number): (ts: number) => boolean {
	const sent: number[] = [];
	return (ts) => {
		while (sent.length > 0 && ts - sent[0] >= windowMs) sent.shift();
		if (sent.length >= max) return false;
		sent.push(ts);
		return true;
	};
}

export const CAPTION_MAX_PER_SECOND = 10;

export function sendCaption(feed: CaptionFeed, msg: Buffer): Promise<string | null> {
	return sendOsc(feed.host, feed.port, msg).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
}
