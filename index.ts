/**
 * SearxNG Extension
 *
 * Adds two LLM-callable tools backed by a self-hosted SearxNG instance:
 *
 *   web_search   – query the SearxNG instance and return ranked results
 *   web_fetch    – fetch a URL and return readable text content
 *
 * Configuration (in order of precedence):
 *   1. Environment variables
 *        SEARXNG_URL          base URL of the instance, e.g. http://searx.lan:8080
 *        SEARXNG_API_KEY      optional bearer token if the instance requires one
 *        SEARXNG_USER_AGENT   optional UA override
 *   2. JSON file at ~/.pi/agent/searxng.json
 *        { "baseUrl": "...", "apiKey": "...", "userAgent": "...",
 *          "defaultLanguage": "en", "defaultCategories": "general",
 *          "timeoutMs": 15000, "maxFetchChars": 60000 }
 *
 * The SearxNG instance must have the JSON output format enabled. In
 * settings.yml that means:
 *
 *   search:
 *     formats:
 *       - html
 *       - json
 *
 * Place this file at ~/.pi/agent/extensions/searxng.ts and run `/reload`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface SearxNGConfig {
	baseUrl?: string;
	apiKey?: string;
	userAgent?: string;
	defaultLanguage?: string;
	defaultCategories?: string;
	timeoutMs?: number;
	maxFetchChars?: number;
}

function loadConfig(): SearxNGConfig {
	const cfg: SearxNGConfig = {};

	// JSON file first (lowest precedence)
	try {
		const p = join(homedir(), ".pi", "agent", "searxng.json");
		const raw = readFileSync(p, "utf8");
		Object.assign(cfg, JSON.parse(raw) as SearxNGConfig);
	} catch {
		/* missing or invalid – ignore */
	}

	// Env vars override file
	if (process.env.SEARXNG_URL) cfg.baseUrl = process.env.SEARXNG_URL;
	if (process.env.SEARXNG_API_KEY) cfg.apiKey = process.env.SEARXNG_API_KEY;
	if (process.env.SEARXNG_USER_AGENT) cfg.userAgent = process.env.SEARXNG_USER_AGENT;

	// Strip trailing slash on baseUrl for predictable joining
	if (cfg.baseUrl) cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, "");

	return cfg;
}

function requireBaseUrl(cfg: SearxNGConfig): string {
	if (!cfg.baseUrl) {
		throw new Error(
			"SearxNG base URL is not configured. Set SEARXNG_URL env var or create ~/.pi/agent/searxng.json with { \"baseUrl\": \"http://your-host:8080\" }.",
		);
	}
	return cfg.baseUrl;
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	if (!a) return b;
	const ctrl = new AbortController();
	const onAbort = () => ctrl.abort();
	if (a.aborted) ctrl.abort();
	else a.addEventListener("abort", onAbort, { once: true });
	if (b.aborted) ctrl.abort();
	else b.addEventListener("abort", onAbort, { once: true });
	return ctrl.signal;
}

async function timedFetch(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<Response> {
	const timer = new AbortController();
	const id = setTimeout(() => timer.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: mergeSignals(signal, timer.signal) });
	} finally {
		clearTimeout(id);
	}
}

// ---------- HTML -> text helpers ----------

const HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	copy: "©",
	reg: "®",
	trade: "™",
};

function decodeEntities(input: string): string {
	return input
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
			try {
				return String.fromCodePoint(parseInt(hex, 16));
			} catch {
				return "";
			}
		})
		.replace(/&#(\d+);/g, (_, dec) => {
			try {
				return String.fromCodePoint(parseInt(dec, 10));
			} catch {
				return "";
			}
		})
		.replace(/&([a-zA-Z]+);/g, (m, name) => HTML_ENTITIES[name] ?? m);
}

function htmlToText(html: string): { title: string | undefined; text: string } {
	// Title
	const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	const title = titleMatch ? decodeEntities(titleMatch[1]).trim().replace(/\s+/g, " ") : undefined;

	// Try to keep the main body if present
	let body = html;
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (bodyMatch) body = bodyMatch[1];

	// Drop non-content blocks
	body = body
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<template[\s\S]*?<\/template>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<head[\s\S]*?<\/head>/gi, " ");

	// Block-level tags become newlines so paragraphs stay separated
	body = body
		.replace(/<\s*br\s*\/?\s*>/gi, "\n")
		.replace(/<\/?(p|div|section|article|header|footer|nav|aside|li|tr|h[1-6]|pre|blockquote)\b[^>]*>/gi, "\n");

	// Strip the rest of the tags
	body = body.replace(/<[^>]+>/g, " ");

	// Decode entities and collapse whitespace
	let text = decodeEntities(body);
	text = text.replace(/[\t\u00A0 ]+/g, " ");
	text = text.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
	text = text.trim();

	return { title, text };
}

// ---------- Extension ----------

export default function searxngExtension(pi: ExtensionAPI) {
	// ---- web_search ----
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web through the configured self-hosted SearxNG instance. Returns a ranked list of results with title, URL, and snippet.",
		promptSnippet:
			"Search the web via SearxNG for fresh information beyond your training data",
		promptGuidelines: [
			"Use web_search when the user asks about current events, recent releases, or facts you may not have, or when explicitly asked to search the web.",
			"After web_search, use web_fetch to read promising URLs in full when a snippet is not enough.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query string" }),
			count: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 20,
					description: "Maximum number of results to return (default 8)",
				}),
			),
			categories: Type.Optional(
				Type.String({
					description:
						"Comma-separated SearxNG categories, e.g. 'general', 'news', 'it', 'science', 'images'. Defaults to general.",
				}),
			),
			language: Type.Optional(
				Type.String({ description: "ISO language code, e.g. 'en', 'de'. Defaults to 'en'." }),
			),
			time_range: Type.Optional(
				StringEnum(["", "day", "week", "month", "year"] as const, {
					description: "Restrict results to a recent time window. Empty string = no filter.",
				}),
			),
			safesearch: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 2,
					description: "SearxNG safesearch level: 0=off, 1=moderate, 2=strict. Default 0.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const cfg = loadConfig();
			const baseUrl = requireBaseUrl(cfg);
			const timeoutMs = cfg.timeoutMs ?? 15000;

			const count = params.count ?? 8;
			const url = new URL(`${baseUrl}/search`);
			url.searchParams.set("q", params.query);
			url.searchParams.set("format", "json");
			url.searchParams.set("categories", params.categories ?? cfg.defaultCategories ?? "general");
			url.searchParams.set("language", params.language ?? cfg.defaultLanguage ?? "en");
			if (params.time_range) url.searchParams.set("time_range", params.time_range);
			if (typeof params.safesearch === "number")
				url.searchParams.set("safesearch", String(params.safesearch));

			onUpdate?.({
				content: [{ type: "text", text: `Searching SearxNG for: ${params.query}` }],
			});

			const headers: Record<string, string> = {
				Accept: "application/json",
				"User-Agent": cfg.userAgent ?? "pi-coding-agent/searxng-extension",
			};
			if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

			const res = await timedFetch(url.toString(), { method: "GET", headers }, timeoutMs, signal);
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(
					`SearxNG search failed: HTTP ${res.status} ${res.statusText}${body ? ` – ${body.slice(0, 300)}` : ""}`,
				);
			}

			const ct = res.headers.get("content-type") ?? "";
			if (!ct.includes("json")) {
				throw new Error(
					`SearxNG did not return JSON (content-type: ${ct}). Enable 'json' in formats in settings.yml.`,
				);
			}

			const data = (await res.json()) as {
				query?: string;
				number_of_results?: number;
				results?: Array<{
					title?: string;
					url?: string;
					content?: string;
					engine?: string;
					publishedDate?: string;
				}>;
				infoboxes?: Array<{ infobox?: string; content?: string; urls?: Array<{ url?: string; title?: string }> }>;
				suggestions?: string[];
			};

			const results = (data.results ?? []).slice(0, count);

			const lines: string[] = [];
			lines.push(`# Search results for: ${params.query}`);
			if (typeof data.number_of_results === "number") {
				lines.push(`Engine reported ~${data.number_of_results} total results.`);
			}
			lines.push("");

			if (data.infoboxes && data.infoboxes.length > 0) {
				const ib = data.infoboxes[0];
				if (ib.infobox || ib.content) {
					lines.push(`## Infobox: ${ib.infobox ?? ""}`.trim());
					if (ib.content) lines.push(ib.content.trim());
					lines.push("");
				}
			}

			if (results.length === 0) {
				lines.push("_No results returned._");
			} else {
				results.forEach((r, i) => {
					const title = (r.title ?? "(no title)").trim();
					const url = r.url ?? "";
					const snippet = (r.content ?? "").trim().replace(/\s+/g, " ");
					const meta = [r.engine, r.publishedDate].filter(Boolean).join(" • ");
					lines.push(`## ${i + 1}. ${title}`);
					lines.push(url);
					if (meta) lines.push(`_${meta}_`);
					if (snippet) lines.push(snippet);
					lines.push("");
				});
			}

			if (data.suggestions && data.suggestions.length > 0) {
				lines.push(`**Related searches:** ${data.suggestions.slice(0, 5).join(", ")}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n").trim() }],
				details: {
					query: params.query,
					count: results.length,
					results: results.map((r) => ({ title: r.title, url: r.url, engine: r.engine })),
				},
			};
		},
	});

	// ---- web_fetch ----
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch the contents of a URL over HTTP(S). HTML pages are converted to readable plain text; JSON and plain-text responses are returned as-is. Use after web_search to read a result in full.",
		promptSnippet: "Fetch a URL and return its readable text content",
		promptGuidelines: [
			"Use web_fetch to read a specific URL in full, typically after web_search surfaces a promising link.",
			"For HTML pages, web_fetch returns extracted text only; images, scripts, and styles are stripped.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL to fetch" }),
			max_chars: Type.Optional(
				Type.Integer({
					minimum: 500,
					maximum: 500000,
					description: "Maximum characters of extracted content to return (default 60000)",
				}),
			),
			raw: Type.Optional(
				Type.Boolean({
					description:
						"If true, return the raw response body instead of HTML-to-text conversion. Default false.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const cfg = loadConfig();
			const timeoutMs = cfg.timeoutMs ?? 20000;
			const maxChars = params.max_chars ?? cfg.maxFetchChars ?? 60000;

			// Basic URL validation – only allow http(s)
			let target: URL;
			try {
				target = new URL(params.url);
			} catch {
				throw new Error(`Invalid URL: ${params.url}`);
			}
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				throw new Error(`Only http and https URLs are allowed, got ${target.protocol}`);
			}

			onUpdate?.({ content: [{ type: "text", text: `Fetching ${target.toString()}` }] });

			const headers: Record<string, string> = {
				"User-Agent": cfg.userAgent ?? "pi-coding-agent/searxng-extension",
				Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
				"Accept-Language": cfg.defaultLanguage ? `${cfg.defaultLanguage},en;q=0.8` : "en,*;q=0.5",
			};

			const res = await timedFetch(
				target.toString(),
				{ method: "GET", headers, redirect: "follow" },
				timeoutMs,
				signal,
			);

			const finalUrl = res.url || target.toString();
			const contentType = res.headers.get("content-type") ?? "";
			const status = res.status;

			if (!res.ok) {
				const snippet = (await res.text().catch(() => "")).slice(0, 500);
				throw new Error(`HTTP ${status} ${res.statusText} fetching ${finalUrl}\n${snippet}`);
			}

			const rawBody = await res.text();
			let title: string | undefined;
			let body: string;
			let truncated = false;

			const isHtml = /html|xml/i.test(contentType) || /^\s*</.test(rawBody);
			if (params.raw || !isHtml) {
				body = rawBody;
			} else {
				const extracted = htmlToText(rawBody);
				title = extracted.title;
				body = extracted.text;
			}

			if (body.length > maxChars) {
				body = body.slice(0, maxChars);
				truncated = true;
			}

			const header: string[] = [];
			header.push(`# ${title ?? finalUrl}`);
			header.push(`URL: ${finalUrl}`);
			header.push(`Status: ${status}  Content-Type: ${contentType || "unknown"}  Length: ${rawBody.length} chars`);
			if (truncated) header.push(`Truncated to first ${maxChars} characters.`);
			header.push("");

			return {
				content: [{ type: "text", text: `${header.join("\n")}${body}`.trim() }],
				details: {
					url: finalUrl,
					status,
					contentType,
					title,
					bytes: rawBody.length,
					truncated,
				},
			};
		},
	});

	// Quick command for checking config without invoking the model.
	pi.registerCommand("searxng", {
		description: "Show the current SearxNG extension configuration",
		handler: async (_args, ctx) => {
			const cfg = loadConfig();
			const lines = [
				`baseUrl:           ${cfg.baseUrl ?? "(unset – set SEARXNG_URL or ~/.pi/agent/searxng.json)"}`,
				`apiKey:            ${cfg.apiKey ? "(set)" : "(none)"}`,
				`userAgent:         ${cfg.userAgent ?? "pi-coding-agent/searxng-extension (default)"}`,
				`defaultLanguage:   ${cfg.defaultLanguage ?? "en (default)"}`,
				`defaultCategories: ${cfg.defaultCategories ?? "general (default)"}`,
				`timeoutMs:         ${cfg.timeoutMs ?? 15000}`,
				`maxFetchChars:     ${cfg.maxFetchChars ?? 60000}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
