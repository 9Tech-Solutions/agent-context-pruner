//#region ../../packages/domain/src/text.ts
/** `text` cut to `limit` characters, ending in `…` when it was longer. */
function truncate(text, limit) {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}
/** Head and tail of `text` around a `[… N chars omitted …]` note, or `text` when short. */
function abridge(text, head, tail) {
	if (text.length <= head + tail + 40) return text;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}
//#endregion
//#region ../../packages/domain/src/state/history.ts
const STATE_CONTEXT = "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.";
/** Added to `context` only when the person gave instructions, so other states stay byte-identical. */
const INSTRUCTIONS_NOTE = "`instructions` is what the person asked this compaction to keep or focus on: a tool call it points to should stay.";
function inputText(input, limit) {
	let json;
	try {
		json = JSON.stringify(input);
	} catch {
		json = "[unserializable input]";
	}
	return truncate(json, limit);
}
function resultNote(call) {
	return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;
}
/** A call's input as `key=value` pairs on one line, cut to `limit` characters. */
function inputLine(input, limit) {
	return truncate(Object.entries(input).map(([key, value]) => {
		return `${key}=${(typeof value === "string" ? value : inputText({ [key]: value }, 200)).replace(/\s+/g, " ")}`;
	}).join(" "), limit);
}
/** One call as a single line, for when the structured form is too costly. */
function compactCall(call, inputChars) {
	const outcome = call.isError ? "error" : "ok";
	return `${call.id} ${call.tool} ${inputLine(call.input, inputChars)} → ${outcome} ${call.resultChars}ch`;
}
function callsByMessage(calls) {
	const byMessage = /* @__PURE__ */ new Map();
	for (const call of calls) byMessage.set(call.callIndex, [...byMessage.get(call.callIndex) ?? [], call]);
	return byMessage;
}
/** The history entries of a state: every message with text or calls, tool inputs capped. */
function historyEntries(messages, calls, inputChars) {
	const byMessage = callsByMessage(calls);
	const entries = [];
	messages.forEach((message, i) => {
		const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
			id: call.id,
			tool: call.tool,
			input: inputText(call.input, inputChars),
			result: resultNote(call)
		}));
		if (message.text.trim().length === 0 && toolCalls.length === 0) return;
		const entry = {
			i,
			role: message.role,
			text: message.text
		};
		entries.push(toolCalls.length > 0 ? {
			...entry,
			tool_calls: toolCalls
		} : entry);
	});
	return entries;
}
/** The last three user prompts, used as the goal when none is given. */
function goalFromMessages(messages) {
	return messages.filter((message) => message.role === "user" && message.text.trim().length > 0 && (message.toolResults ?? []).length === 0).slice(-3).map((message) => truncate(message.text, 500)).join("\n");
}
//#endregion
//#region ../../packages/domain/src/apply.ts
/** Results within this many characters of the head are kept whole: the note would not save anything. */
const NOTE_SLACK = 120;
const NOTE_INPUT_CHARS = 160;
/** A dropped result: its first `headChars` characters and a note saying how much was cut. */
function truncatedResultText(text, isError, headChars) {
	if (text.length <= headChars + NOTE_SLACK) return text;
	const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
	const error = isError ? " (error)" : "";
	return `${head}[agent-context-pruner truncated ${text.length - headChars} chars of this tool result${error}; re-run the tool if needed]`;
}
/**
* The note left where a dropped call's result was: which tool, with which
* input, and how much it returned, so the model knows what it no longer has
* and what to re-run. There is no summary, so without it the model cannot tell.
*/
function droppedCallNote(call) {
	const input = inputLine(call.input, NOTE_INPUT_CHARS);
	return `[agent-context-pruner removed tool call ${input ? `${call.tool} ${input}` : call.tool} (${call.isError ? `an error, ${call.resultChars} chars` : `${call.resultChars} chars of output`}); re-run it if needed]`;
}
function actionsByToolUseId(decisions, calls) {
	const byId = new Map(calls.map((call) => [call.id, call]));
	const actions = /* @__PURE__ */ new Map();
	for (const decision of decisions) {
		const call = byId.get(decision.id);
		if (call && decision.action !== "keep") actions.set(call.tool_use_id, {
			action: decision.action,
			call
		});
	}
	return actions;
}
function rebuildToolUse(tool, actions, headChars) {
	if (actions.get(tool.tool_use_id)?.action !== "drop_result") return tool;
	const text = truncatedResultText(tool.text ?? "", tool.isError ?? false, headChars);
	if ((tool.text ?? "") === text) return tool;
	const copy = {
		tool_use_id: tool.tool_use_id,
		tool: tool.tool,
		input: tool.input,
		text
	};
	return tool.isError ? {
		...copy,
		isError: true
	} : copy;
}
function rebuildToolResult(result, actions, headChars) {
	if (actions.get(result.tool_use_id)?.action !== "drop_result") return result;
	const text = truncatedResultText(result.text, result.isError ?? false, headChars);
	if (text === result.text) return result;
	return {
		tool_use_id: result.tool_use_id,
		text,
		isError: result.isError ?? false
	};
}
/** The message's text with a note for each dropped call whose result it held. */
function withNotes(message, actions, settings) {
	if (!settings.noteDroppedCalls) return message.text;
	const notes = (message.toolResults ?? []).flatMap((result) => {
		const planned = actions.get(result.tool_use_id);
		return planned?.action === "drop_call" ? [droppedCallNote(planned.call)] : [];
	});
	return [message.text, ...notes].filter((part) => part.length > 0).join("\n");
}
/** The message with `actions` applied: the same object when nothing changed, null when nothing is left. */
function rebuildMessage(message, actions, settings) {
	const dropped = (id) => actions.get(id)?.action === "drop_call";
	const results = message.toolResults ?? [];
	const toolUses = message.toolUses.filter((tool) => !dropped(tool.tool_use_id)).map((tool) => rebuildToolUse(tool, actions, settings.headChars));
	const toolResults = results.filter((result) => !dropped(result.tool_use_id)).map((result) => rebuildToolResult(result, actions, settings.headChars));
	if (toolUses.length === message.toolUses.length && toolResults.length === results.length && toolUses.every((tool, index) => tool === message.toolUses[index]) && toolResults.every((result, index) => result === results[index])) return message;
	const text = withNotes(message, actions, settings);
	if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) return null;
	const rebuilt = {
		role: message.role,
		text,
		toolUses
	};
	return toolResults.length > 0 ? {
		...rebuilt,
		toolResults
	} : rebuilt;
}
/**
* Rebuilds the conversation from the decisions. A dropped call disappears
* together with its result, leaving a one-line note where the result was
* (unless `noteDroppedCalls` is false); a dropped result keeps a bounded head
* and a note. Messages left empty are removed. Untouched messages come back as
* the same objects they came in as, so host adapters can keep their own handles.
*/
function applyDecisions(messages, decisions, calls, headChars, options = {}) {
	const actions = actionsByToolUseId(decisions, calls);
	if (actions.size === 0) return [...messages];
	const settings = {
		headChars,
		noteDroppedCalls: options.noteDroppedCalls ?? true
	};
	return messages.map((message) => rebuildMessage(message, actions, settings)).filter((message) => message !== null);
}
/** Characters of text, tool input and tool output a message holds. */
function messageChars(message) {
	let total = message.text.length;
	for (const tool of message.toolUses) try {
		total += JSON.stringify(tool.input).length;
	} catch {
		total += 20;
	}
	for (const result of message.toolResults ?? []) total += result.text.length;
	return total;
}
//#endregion
//#region ../../packages/domain/src/decision.ts
/**
* Keep call and result when `keepResult` reaches the threshold, keep only the
* call when `keepCall` does, otherwise drop both. Pinned calls are always kept.
*/
function decideCall(call, score, options) {
	const base = {
		id: call.id,
		tool: call.tool,
		...score
	};
	if (call.pinned) return {
		...base,
		action: "keep",
		reason: "pinned"
	};
	if (score.keepResult >= options.keepThreshold) return {
		...base,
		action: "keep",
		reason: "kept"
	};
	if (score.keepCall >= options.keepThreshold) return {
		...base,
		action: "drop_result",
		reason: "result_dropped"
	};
	return {
		...base,
		action: "drop_call",
		reason: "call_dropped"
	};
}
//#endregion
//#region ../../packages/domain/src/named.ts
/** Input keys that hold the file a call works on, across hosts. */
const PATH_KEYS = [
	"file_path",
	"path",
	"filePath",
	"notebook_path"
];
/** The file a call works on, read from the first path key it has, with forward slashes. */
function callPath(input, keys = PATH_KEYS) {
	const value = keys.map((key) => input[key]).find((v) => typeof v === "string");
	return typeof value === "string" ? value.trim().replace(/\\/g, "/") : void 0;
}
/** Path-like words of the instructions (`src/auth.ts`, `README.md`), lower-cased with forward slashes. */
function namedPaths(instructions) {
	return (instructions.match(/[\w.@~-]*[./\\][\w./\\@~-]+/g) ?? []).map((word) => word.replace(/\\/g, "/").replace(/[.,;:]+$/, "").toLowerCase()).filter((word) => word.length >= 3);
}
/** Whether `path` is one the person named: the same path, or one ending in `/<named>`. */
function isNamed(path, named) {
	const lower = path.toLowerCase();
	return named.some((word) => lower === word || lower.endsWith(`/${word}`));
}
/**
* Pins the calls on files the person named in the compaction's instructions
* (`/compact keep src/auth.ts`), so they stay whole whatever a model scores:
* what the person asked to keep is not left to a model's judgment.
*/
function pinNamed(calls, instructions) {
	const named = namedPaths(instructions);
	if (named.length === 0) return [...calls];
	return calls.map((call) => {
		if (call.pinned) return call;
		const path = callPath(call.input);
		return path && isNamed(path, named) ? {
			...call,
			pinned: true
		} : call;
	});
}
//#endregion
//#region ../../packages/domain/src/options.ts
const DEFAULT_OPTIONS = {
	goal: "",
	instructions: "",
	keepThreshold: .5,
	preserveRecentMessages: 6,
	maxStateTokens: 25e3,
	truncateHeadChars: 300,
	noteDroppedCalls: true
};
function finite(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
/** Caller options first, then the model's defaults, then `DEFAULT_OPTIONS`; non-finite values are ignored. */
function resolveOptions(options = {}, model = {}) {
	const keepThreshold = finite(model.keepThreshold, DEFAULT_OPTIONS.keepThreshold);
	const maxStateTokens = finite(model.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens);
	const preserve = finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages);
	const head = finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars);
	return {
		goal: options.goal ?? DEFAULT_OPTIONS.goal,
		instructions: options.instructions?.trim() ?? DEFAULT_OPTIONS.instructions,
		keepThreshold: finite(options.keepThreshold, keepThreshold),
		preserveRecentMessages: Math.max(0, Math.floor(preserve)),
		maxStateTokens: Math.max(1, finite(options.maxStateTokens, maxStateTokens)),
		truncateHeadChars: Math.max(0, Math.floor(head)),
		noteDroppedCalls: options.noteDroppedCalls ?? DEFAULT_OPTIONS.noteDroppedCalls
	};
}
//#endregion
//#region ../../packages/domain/src/result.ts
function ok(value) {
	return {
		ok: true,
		value
	};
}
function err(error) {
	return {
		ok: false,
		error
	};
}
//#endregion
//#region ../../packages/domain/src/tokens.ts
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;
/**
* Estimates tokens without a tokenizer: a word costs one token per six
* letters, a digit half a token, any other symbol nine tenths. Calibrated by
* fast-jev-compaction against the usage Jev reports for real transcripts,
* where it lands 2 to 18% above the true count. Other models ship their own
* estimator through `ModelCapabilities` when this one does not fit.
*/
function estimateTokens(text) {
	let tokens = 0;
	for (const [piece] of text.matchAll(TOKEN_PIECES)) {
		const first = piece.charCodeAt(0);
		if (first >= 48 && first <= 57) tokens += piece.length / 2;
		else if (first >= 65 && first <= 90 || first >= 97 && first <= 122) tokens += 1 + Math.floor((piece.length - 1) / 6);
		else tokens += .9;
	}
	return Math.ceil(tokens);
}
//#endregion
//#region ../../packages/domain/src/tool-call.ts
function isPinned(index, total, preserveRecentMessages) {
	return index === 0 || index >= total - preserveRecentMessages;
}
function resultsById(messages) {
	const results = /* @__PURE__ */ new Map();
	messages.forEach((message, index) => {
		for (const result of message.toolResults ?? []) results.set(result.tool_use_id, {
			index,
			result
		});
	});
	return results;
}
/**
* Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
* result are not candidates: there is nothing to drop yet.
*/
function collectToolCalls(messages, preserveRecentMessages) {
	const results = resultsById(messages);
	const pinned = (index) => isPinned(index, messages.length, preserveRecentMessages);
	const calls = [];
	messages.forEach((message, callIndex) => {
		for (const tool of message.toolUses) {
			const found = results.get(tool.tool_use_id);
			if (!found) continue;
			calls.push({
				id: `t${calls.length + 1}`,
				tool_use_id: tool.tool_use_id,
				tool: tool.tool,
				input: tool.input,
				callIndex,
				resultIndex: found.index,
				resultChars: found.result.text.length,
				isError: found.result.isError ?? false,
				pinned: pinned(callIndex) || pinned(found.index)
			});
		}
	});
	return calls;
}
//#endregion
//#region ../../packages/domain/src/state/fit.ts
/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [
	1e3,
	200,
	60
];
const COMPACT_INPUT_CHARS = 60;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;
function stateOf(goal, instructions, history) {
	if (!instructions) return {
		context: STATE_CONTEXT,
		goal,
		history
	};
	return {
		context: `${STATE_CONTEXT} ${INSTRUCTIONS_NOTE}`,
		goal,
		instructions,
		history
	};
}
function contextOf(messages, calls, options) {
	const goal = options.goal || goalFromMessages(messages);
	const instructions = options.instructions?.trim() ?? "";
	const estimate = options.estimateTokens ?? estimateTokens;
	const empty = stateOf(goal, instructions, []);
	return {
		messages,
		calls,
		goal,
		instructions,
		limit: options.maxStateTokens,
		estimate,
		baseTokens: estimate(JSON.stringify(empty)),
		pinned: (entry) => isPinned(entry.i, messages.length, options.preserveRecentMessages)
	};
}
function entryTokens(ctx, entry) {
	return ctx.estimate(JSON.stringify(entry)) + 1;
}
function draftOf(ctx, history) {
	const perEntry = history.map((entry) => entryTokens(ctx, entry));
	return {
		history,
		perEntry,
		tokens: ctx.baseTokens + perEntry.reduce((sum, n) => sum + n, 0)
	};
}
function fits(ctx, draft) {
	return draft.tokens <= ctx.limit;
}
function fitted(ctx, draft, stage) {
	return { fitted: {
		state: stateOf(ctx.goal, ctx.instructions, draft.history),
		tokens: draft.tokens,
		stage
	} };
}
function replaceEntry(ctx, draft, index, entry) {
	const tokens = entryTokens(ctx, entry);
	return {
		history: draft.history.with(index, entry),
		perEntry: draft.perEntry.with(index, tokens),
		tokens: draft.tokens - (draft.perEntry[index] ?? 0) + tokens
	};
}
/** Applies `change` entry by entry in `order`, stopping as soon as the state fits. */
function shrinkEach(ctx, start, order, stage, change) {
	let draft = start;
	for (const index of order) {
		const entry = draft.history[index];
		const next = entry && change(entry);
		if (!next) continue;
		draft = replaceEntry(ctx, draft, index, next);
		if (fits(ctx, draft)) return fitted(ctx, draft, stage);
	}
	return { draft };
}
/** Tool inputs truncated to 1000, then 200, then 60 characters. */
function fitInputs(ctx) {
	let draft = draftOf(ctx, historyEntries(ctx.messages, ctx.calls, INPUT_CHARS[0]));
	if (fits(ctx, draft)) return fitted(ctx, draft, "full");
	for (const limit of INPUT_CHARS.slice(1)) {
		draft = draftOf(ctx, historyEntries(ctx.messages, ctx.calls, limit));
		if (fits(ctx, draft)) return fitted(ctx, draft, `inputs<=${limit}`);
	}
	return { draft };
}
const abridgeTexts = (ctx, draft, order) => shrinkEach(ctx, draft, order, "texts abridged", (entry) => entry.text.length <= 590 ? void 0 : {
	...entry,
	text: abridge(entry.text, TEXT_HEAD, TEXT_TAIL)
});
const collapseOldTexts = (ctx, draft, order) => shrinkEach(ctx, draft, order, "old messages collapsed", (entry) => {
	if (ctx.pinned(entry) || entry.text.length === 0) return void 0;
	const original = ctx.messages[entry.i]?.text.length ?? entry.text.length;
	return {
		...entry,
		text: `[… ${original} chars omitted …]`
	};
});
const compactOldCalls = (ctx, draft, order) => {
	const byMessage = callsByMessage(ctx.calls);
	return shrinkEach(ctx, draft, order, "old calls compacted", (entry) => {
		const own = byMessage.get(entry.i);
		if (ctx.pinned(entry) || !own) return void 0;
		return {
			...entry,
			tool_calls: own.map((call) => compactCall(call, COMPACT_INPUT_CHARS))
		};
	});
};
/** Old messages that carry no call are left out, oldest first. */
const leaveOutOldMessages = (ctx, draft, order) => {
	const left = /* @__PURE__ */ new Set();
	const kept = () => draft.history.filter((_, index) => !left.has(index));
	let tokens = draft.tokens;
	for (const index of order) {
		const entry = draft.history[index];
		if (!entry || ctx.pinned(entry) || entry.tool_calls) continue;
		left.add(index);
		tokens -= draft.perEntry[index] ?? 0;
		if (tokens <= ctx.limit) return fitted(ctx, {
			history: kept(),
			perEntry: [],
			tokens
		}, "old messages left out");
	}
	return { draft: draftOf(ctx, kept()) };
};
function foldable(ctx, entry) {
	return !ctx.pinned(entry) && entry.text.length === 0 && typeof entry.tool_calls?.[0] === "string";
}
/** Folds runs of adjacent old call-only entries into one, keeping every call line. */
function mergeCallRuns(ctx, history) {
	const merged = [];
	for (const entry of history) {
		const previous = merged.at(-1);
		if (previous && previous.role === entry.role && foldable(ctx, previous) && foldable(ctx, entry)) {
			const lines = [...previous.tool_calls, ...entry.tool_calls];
			merged[merged.length - 1] = {
				...previous,
				tool_calls: lines
			};
			continue;
		}
		merged.push(entry);
	}
	return merged;
}
function shrinkOrder(ctx, draft) {
	const indices = draft.history.map((_, index) => index);
	const pinnedAt = (index) => {
		const entry = draft.history[index];
		return entry !== void 0 && ctx.pinned(entry);
	};
	return [...indices.filter((index) => !pinnedAt(index)), ...indices.filter(pinnedAt)];
}
const SHRINK_STAGES = [
	abridgeTexts,
	collapseOldTexts,
	compactOldCalls,
	leaveOutOldMessages
];
/**
* Builds the state from the whole conversation and shrinks it in stages until
* it fits `maxStateTokens`: tool inputs are truncated, long texts abridged
* (oldest first, pinned messages last), old messages collapsed to a note, old
* tool calls reduced to one line each, old call-less messages left out, and
* runs of old call-only messages folded together.
*/
function fitState(messages, calls, options) {
	const ctx = contextOf(messages, calls, options);
	const first = fitInputs(ctx);
	if ("fitted" in first) return ok(first.fitted);
	let draft = first.draft;
	const order = shrinkOrder(ctx, draft);
	for (const stage of SHRINK_STAGES) {
		const step = stage(ctx, draft, order);
		if ("fitted" in step) return ok(step.fitted);
		draft = step.draft;
	}
	const merged = draftOf(ctx, mergeCallRuns(ctx, draft.history));
	const last = fitted(ctx, merged, "old calls merged");
	if (fits(ctx, merged) && "fitted" in last) return ok(last.fitted);
	return err({
		kind: "state_too_large",
		message: `history too large for the model (~${merged.tokens} tokens after truncation, limit ${ctx.limit})`,
		tokens: merged.tokens,
		limit: ctx.limit
	});
}
//#endregion
//#region ../../packages/domain/src/compact.ts
const KEEP_ALL = {
	keepCall: 1,
	keepResult: 1
};
function isProbability(value) {
	return Number.isFinite(value) && value >= 0 && value <= 1;
}
async function askModel(model, request) {
	try {
		const response = await model.score(request);
		if (response.ok) return response;
		return err({
			kind: "model_failed",
			message: `${model.id}: ${response.error.message}`,
			cause: response.error
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const cause = {
			kind: "unexpected",
			message
		};
		return err({
			kind: "model_failed",
			message: `${model.id} threw: ${message}`,
			cause
		});
	}
}
function checkScores(candidates, scores) {
	for (const call of candidates) {
		const score = scores.get(call.id);
		if (!score || !isProbability(score.keepCall) || !isProbability(score.keepResult)) return err({
			kind: "invalid_score",
			message: `missing or out-of-range score for ${call.id} (${call.tool})`
		});
	}
	return ok(scores);
}
async function scoreCandidates(messages, calls, model, options) {
	const candidates = calls.filter((call) => !call.pinned);
	if (candidates.length === 0) return ok({
		scores: /* @__PURE__ */ new Map(),
		requests: 0,
		fitted: null
	});
	const goal = options.goal || goalFromMessages(messages);
	const estimateTokens = model.capabilities.estimateTokens;
	const fitted = model.capabilities.state === "global" ? fitState(messages, calls, {
		...options,
		goal,
		estimateTokens
	}) : ok(null);
	if (!fitted.ok) return fitted;
	const state = fitted.value?.state ?? null;
	const stateTokens = fitted.value?.tokens ?? 0;
	const { instructions } = options;
	const response = await askModel(model, {
		goal,
		instructions,
		state,
		stateTokens,
		candidates,
		calls,
		messages
	});
	if (!response.ok) return response;
	const scores = checkScores(candidates, response.value.scores);
	if (!scores.ok) return scores;
	return ok({
		scores: scores.value,
		requests: response.value.requests,
		fitted: fitted.value
	});
}
function count(decisions, reason) {
	return decisions.filter((decision) => decision.reason === reason).length;
}
function chars(messages) {
	return messages.reduce((sum, message) => sum + messageChars(message), 0);
}
function statsOf(model, before, after, decisions, scored, started) {
	return {
		model: model.id,
		messagesBefore: before.length,
		messagesAfter: after.length,
		charsBefore: chars(before),
		charsAfter: chars(after),
		calls: decisions.length,
		kept: count(decisions, "kept"),
		resultsDropped: count(decisions, "result_dropped"),
		callsDropped: count(decisions, "call_dropped"),
		pinned: count(decisions, "pinned"),
		stateTokens: scored.fitted?.tokens ?? 0,
		stateStage: scored.fitted?.stage ?? "",
		requests: scored.requests,
		ms: Date.now() - started
	};
}
/**
* Compacts a transcript by asking `model`, for every tool call outside the
* pinned first and newest messages, whether the call and whether its result
* must stay. Text is never rewritten. Returns an error instead of throwing
* when the model fails or the history cannot be fitted; the caller decides
* what to fall back to.
*/
async function compact(messages, model, options = {}) {
	const started = Date.now();
	const resolved = resolveOptions(options, {
		keepThreshold: model.capabilities.defaultKeepThreshold,
		maxStateTokens: model.capabilities.maxStateTokens
	});
	const calls = pinNamed(collectToolCalls(messages, resolved.preserveRecentMessages), resolved.instructions);
	const scored = await scoreCandidates(messages, calls, model, resolved);
	if (!scored.ok) return scored;
	const decisions = calls.map((call) => decideCall(call, scored.value.scores.get(call.id) ?? KEEP_ALL, resolved));
	const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars, { noteDroppedCalls: resolved.noteDroppedCalls });
	return ok({
		messages: kept,
		decisions,
		stats: statsOf(model, messages, kept, decisions, scored.value, started)
	});
}
/** Share of characters removed: 0 when nothing was, 1 when everything was. */
function reductionRatio(result) {
	const { charsBefore, charsAfter } = result.stats;
	return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}
//#endregion
//#region ../../packages/models/src/batch.ts
/** Splits `items` into batches that each stay within the token budget and the item cap. */
function batchByBudget(items, costOf, limits) {
	const batches = [];
	let current = [];
	let used = 0;
	for (const item of items) {
		const cost = costOf(item);
		if (cost > limits.budget) return err({
			kind: "limit",
			message: `the state leaves no room for questions (${limits.budget} tokens left, one call needs ${cost})`
		});
		if (current.length > 0 && (used + cost > limits.budget || current.length >= limits.maxItems)) {
			batches.push(current);
			current = [];
			used = 0;
		}
		current.push(item);
		used += cost;
	}
	if (current.length > 0) batches.push(current);
	return ok(batches);
}
/** Maps `items` through `fn` with at most `limit` calls in flight, keeping the order. */
async function mapLimited(items, limit, fn) {
	const results = [];
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next;
			next += 1;
			results[index] = await fn(items[index]);
		}
	};
	const workers = Math.max(1, Math.min(limit, items.length));
	await Promise.all(Array.from({ length: workers }, worker));
	return results;
}
//#endregion
//#region ../../packages/models/src/heuristic/model.ts
const READ_TOOLS = [
	"read",
	"read_file",
	"view",
	"notebookread"
];
const WRITE_TOOLS = [
	"edit",
	"multiedit",
	"write",
	"notebookedit",
	"write_file",
	"edit_file",
	"apply_patch"
];
const KEEP = {
	keepCall: 1,
	keepResult: 1
};
const DROP_CALL = {
	keepCall: .1,
	keepResult: .1
};
const DROP_RESULT = {
	keepCall: .9,
	keepResult: .1
};
function rulesOf(options) {
	const reads = new Set((options.readTools ?? READ_TOOLS).map((t) => t.toLowerCase()));
	const writes = new Set((options.writeTools ?? WRITE_TOOLS).map((t) => t.toLowerCase()));
	const keys = options.pathKeys ?? PATH_KEYS;
	return {
		isRead: (tool) => reads.has(tool.toLowerCase()),
		isWrite: (tool) => writes.has(tool.toLowerCase()),
		pathOf: (call) => callPath(call.input, keys),
		largeResultChars: options.largeResultChars ?? 4e3
	};
}
/**
* Scores one call from what happened after it:
* a file read again later is superseded (drop the call),
* a file changed later has stale contents (keep the call, truncate the result),
* a failed call retried successfully is settled (truncate the result),
* and a large result is truncated. Everything else stays.
*/
function scoreCall(call, calls, rules) {
	const later = calls.filter((other) => other.callIndex > call.callIndex);
	const path = rules.pathOf(call);
	const touches = (other, kind) => kind(other.tool) && rules.pathOf(other) === path;
	if (path && rules.isRead(call.tool)) {
		if (later.some((other) => touches(other, rules.isRead))) return DROP_CALL;
		if (later.some((other) => touches(other, rules.isWrite))) return DROP_RESULT;
	}
	if (call.isError && later.some((other) => other.tool === call.tool && !other.isError)) return DROP_RESULT;
	if (call.resultChars > rules.largeResultChars) return DROP_RESULT;
	return KEEP;
}
/**
* A decision model that needs no model at all: deterministic rules over the
* tool calls. Free, offline, and the fallback when a hosted or local model fails.
*/
function createHeuristicModel(options = {}) {
	const rules = rulesOf(options);
	return {
		id: "heuristic:v1",
		capabilities: {
			state: "none",
			maxStateTokens: 0,
			estimateTokens,
			defaultKeepThreshold: .5
		},
		score: async (request) => {
			const scores = request.candidates.map((call) => [call.id, scoreCall(call, request.calls, rules)]);
			return ok({
				scores: new Map(scores),
				requests: 0
			});
		}
	};
}
//#endregion
//#region ../../packages/models/src/systemone/wire.ts
/** The two questions asked about one call: keep the call, keep its full result. */
function questionsFor(call) {
	return {
		[`call_${call.id}`]: {
			type: "noul",
			instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`
		},
		[`result_${call.id}`]: {
			type: "noul",
			instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`
		}
	};
}
function requestBody(model, state, questions) {
	return JSON.stringify({
		model,
		state,
		questions
	});
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Validates a SystemOne response; `unwrap` strips a provider envelope first. */
function parseResponse(response, unwrap) {
	if (!response.ok) return err({
		kind: "http",
		message: `request failed (${response.status}): ${response.text.slice(0, 200)}`
	});
	let parsed;
	try {
		parsed = JSON.parse(response.text);
	} catch {
		return err({
			kind: "invalid_response",
			message: "response is not valid JSON"
		});
	}
	const body = unwrap(parsed);
	if (!isRecord(body) || !isRecord(body["answers"])) return err({
		kind: "invalid_response",
		message: "response is missing answers"
	});
	return ok({ answers: body["answers"] });
}
/** The probability of one `noul` answer. */
function noulAnswer(answers, name) {
	const answer = answers[name];
	const value = isRecord(answer) ? answer["noul"] : void 0;
	if (typeof value === "number" && Number.isFinite(value)) return ok(value);
	return err({
		kind: "invalid_response",
		message: `invalid answer for ${name}`
	});
}
/** Strips Cloudflare's `{ result, success }` REST envelope when present. */
function unwrapCloudflare(body) {
	return isRecord(body) && isRecord(body["result"]) && "success" in body ? body["result"] : body;
}
//#endregion
//#region ../../packages/models/src/systemone/profiles.ts
const identity = (body) => body;
function root(baseUrl) {
	return baseUrl.replace(/\/+$/, "");
}
function needs(field, profile) {
	return err({
		kind: "config",
		message: `the ${profile} profile needs ${field}`
	});
}
const PROFILES = {
	typesafe: {
		id: "typesafe",
		defaultModel: "jev-latest",
		requiresApiKey: true,
		maxRequestTokens: 3e4,
		maxStateTokens: 25e3,
		maxQuestionsPerRequest: Number.POSITIVE_INFINITY,
		keepThreshold: .5,
		endpoint: (config) => ok(`${root(config.baseUrl ?? "https://api.typesafe.ai")}/v1/systemone`),
		unwrap: identity
	},
	cloudflare: {
		id: "cloudflare",
		defaultModel: "clef",
		requiresApiKey: true,
		maxRequestTokens: 6e4,
		maxStateTokens: 5e4,
		maxQuestionsPerRequest: 64,
		keepThreshold: .5,
		endpoint: (config, model) => {
			if (!config.accountId) return needs("an accountId", "cloudflare");
			return ok(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/ai/run/@cf/cloudflare/${encodeURIComponent(model)}`);
		},
		unwrap: unwrapCloudflare
	},
	ollama: {
		id: "ollama",
		defaultModel: "nimble",
		requiresApiKey: false,
		maxRequestTokens: 14e3,
		maxStateTokens: 11e3,
		maxQuestionsPerRequest: 64,
		keepThreshold: .5,
		endpoint: (config) => ok(`${root(config.baseUrl ?? "http://localhost:11434")}/v1/systemone`),
		unwrap: identity
	},
	custom: {
		id: "custom",
		requiresApiKey: false,
		maxRequestTokens: 15e3,
		maxStateTokens: 12e3,
		maxQuestionsPerRequest: 64,
		keepThreshold: .5,
		endpoint: (config) => config.baseUrl ? ok(`${root(config.baseUrl)}/v1/systemone`) : needs("a baseUrl", "custom"),
		unwrap: identity
	}
};
//#endregion
//#region ../../packages/models/src/systemone/model.ts
/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;
const DEFAULT_CONCURRENCY = 8;
function headersFor(apiKey) {
	const json = { "content-type": "application/json" };
	return apiKey ? {
		...json,
		authorization: `Bearer ${apiKey}`
	} : json;
}
function resolveSettings(config) {
	const profile = PROFILES[config.profile];
	if (!profile) return err({
		kind: "config",
		message: `unknown SystemOne profile: ${String(config.profile)}`
	});
	const model = config.model ?? profile.defaultModel;
	if (!model) return err({
		kind: "config",
		message: `the ${profile.id} profile needs a model name`
	});
	if (profile.requiresApiKey && !config.apiKey) return err({
		kind: "config",
		message: `the ${profile.id} profile needs an API key`
	});
	const endpoint = profile.endpoint(config, model);
	if (!endpoint.ok) return endpoint;
	return ok({
		profile,
		model,
		endpoint: endpoint.value,
		headers: headersFor(config.apiKey),
		maxRequestTokens: config.maxRequestTokens ?? profile.maxRequestTokens,
		maxStateTokens: config.maxStateTokens ?? profile.maxStateTokens,
		maxQuestionsPerRequest: config.maxQuestionsPerRequest ?? profile.maxQuestionsPerRequest,
		keepThreshold: config.keepThreshold ?? profile.keepThreshold,
		maxConcurrency: config.maxConcurrency ?? DEFAULT_CONCURRENCY
	});
}
function scoresFrom(answers, batch) {
	const scores = /* @__PURE__ */ new Map();
	for (const call of batch) {
		const keepCall = noulAnswer(answers, `call_${call.id}`);
		if (!keepCall.ok) return keepCall;
		const keepResult = noulAnswer(answers, `result_${call.id}`);
		if (!keepResult.ok) return keepResult;
		scores.set(call.id, {
			keepCall: keepCall.value,
			keepResult: keepResult.value
		});
	}
	return ok(scores);
}
async function askBatch(settings, transport, state, batch) {
	const questions = Object.fromEntries(batch.flatMap((call) => Object.entries(questionsFor(call))));
	let response;
	try {
		response = await transport({
			url: settings.endpoint,
			method: "POST",
			headers: settings.headers,
			body: requestBody(settings.model, state, questions)
		});
	} catch (error) {
		return err({
			kind: "transport",
			message: error instanceof Error ? error.message : String(error)
		});
	}
	const parsed = parseResponse(response, settings.profile.unwrap);
	return parsed.ok ? scoresFrom(parsed.value.answers, batch) : parsed;
}
function merge(answered) {
	const scores = /* @__PURE__ */ new Map();
	for (const batch of answered) {
		if (!batch.ok) return batch;
		for (const [id, score] of batch.value) scores.set(id, score);
	}
	return ok({
		scores,
		requests: answered.length
	});
}
/**
* Splits the candidates into as many requests as the limits need, resends the
* full state with every request, runs them concurrently, and merges answers.
*/
async function score(settings, transport, request) {
	const state = request.state;
	if (!state) return err({
		kind: "config",
		message: "SystemOne models need the conversation state"
	});
	const batches = batchByBudget(request.candidates, (call) => estimateTokens(JSON.stringify(questionsFor(call))), {
		budget: settings.maxRequestTokens - request.stateTokens - REQUEST_OVERHEAD_TOKENS,
		maxItems: Math.max(1, Math.floor(settings.maxQuestionsPerRequest / 2))
	});
	if (!batches.ok) return batches;
	return merge(await mapLimited(batches.value, settings.maxConcurrency, (batch) => askBatch(settings, transport, state, batch)));
}
/**
* A decision model for any server speaking the SystemOne request format:
* TypeSafe Jev, Cloudflare Clef, Ollama, or a custom `/v1/systemone` server.
*/
function createSystemOneModel(config, transport) {
	const settings = resolveSettings(config);
	if (!settings.ok) return settings;
	const s = settings.value;
	return ok({
		id: `systemone:${s.profile.id}:${s.model}`,
		capabilities: {
			state: "global",
			maxStateTokens: s.maxStateTokens,
			estimateTokens,
			defaultKeepThreshold: s.keepThreshold
		},
		score: (request) => score(s, transport, request)
	});
}
//#endregion
//#region src/models.ts
/** `auto`: TypeSafe when a key is there, then Cloudflare, then the rules. */
function autoProvider(config, secrets) {
	if (config.apiKey || secrets.typesafeApiKey) return "typesafe";
	if (secrets.cloudflareApiToken && (config.accountId || secrets.cloudflareAccountId)) return "cloudflare";
	return "heuristic";
}
function apiKeyFor(profile, config, secrets) {
	if (config.apiKey) return config.apiKey;
	if (profile === "typesafe") return secrets.typesafeApiKey;
	if (profile === "cloudflare") return secrets.cloudflareApiToken;
}
function systemOneConfig(profile, config, secrets) {
	return {
		profile,
		model: config.model,
		apiKey: apiKeyFor(profile, config, secrets),
		baseUrl: config.baseUrl,
		accountId: config.accountId ?? secrets.cloudflareAccountId
	};
}
/** Picks the configured decision model and the rules-based fallback behind it. */
function chooseModels(config, secrets, transport) {
	const provider = config.provider === "auto" ? autoProvider(config, secrets) : config.provider;
	const heuristic = createHeuristicModel();
	if (provider === "heuristic") return ok({
		primary: heuristic,
		fallback: null,
		notes: []
	});
	const model = createSystemOneModel(systemOneConfig(provider, config, secrets), transport);
	if (model.ok) {
		const fallback = config.fallbackToHeuristic ? heuristic : null;
		return ok({
			primary: model.value,
			fallback,
			notes: []
		});
	}
	if (!config.fallbackToHeuristic) return err(model.error.message);
	return ok({
		primary: heuristic,
		fallback: null,
		notes: [`${provider} unavailable (${model.error.message}); using the rules-based model`]
	});
}
//#endregion
//#region src/session.ts
function toolUseSummary(tool) {
	const summary = {
		tool_use_id: tool.tool_use_id,
		tool: tool.tool,
		input: { ...tool.input }
	};
	const withText = tool.text === void 0 ? summary : {
		...summary,
		text: tool.text
	};
	return tool.isError ? {
		...withText,
		isError: true
	} : withText;
}
function toolResultSummary(result) {
	return {
		tool_use_id: result.tool_use_id,
		text: result.text,
		isError: result.isError ?? false
	};
}
/**
* Maps the compacted transcript back onto session messages. Whatever came
* back unchanged (a message, a tool use, a tool result) is the engine's own
* object, handle included, so the engine keeps it whole. Anything rebuilt is a
* fresh message without a handle, which the engine reads as built: its stored
* tool record (`result`) is left behind with the bulk that was cut.
*/
function toSessionMessages(input, output) {
	const messages = new Map(input.map((m) => [m, m]));
	const uses = new Map(input.flatMap((m) => m.toolUses.map((tool) => [tool, tool])));
	const results = new Map(input.flatMap((m) => (m.toolResults ?? []).map((result) => [result, result])));
	return output.map((message) => {
		const own = messages.get(message);
		if (own) return own;
		const rebuilt = {
			role: message.role,
			text: message.text,
			toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool))
		};
		const toolResults = (message.toolResults ?? []).map((result) => results.get(result) ?? toolResultSummary(result));
		return toolResults.length > 0 ? {
			...rebuilt,
			toolResults
		} : rebuilt;
	});
}
/** Rows Claude Code adds for slash commands and reminders: not the person's prompts. */
const HOST_MARKUP = /^\s*<(command-name|command-message|command-args|local-command-[a-z-]+|system-reminder)>/;
/**
* The goal for the model: the person's last three prompts, leaving out the
* rows Claude Code writes for slash commands, which would otherwise crowd them out.
*/
function promptGoal(messages) {
	return messages.filter((m) => m.role === "user" && m.text.trim().length > 0 && (m.toolResults ?? []).length === 0 && !HOST_MARKUP.test(m.text)).slice(-3).map((m) => m.text.length > 500 ? `${m.text.slice(0, 499)}…` : m.text).join("\n");
}
//#endregion
//#region src/summary.ts
/** Room the engine leaves for one `$.ui.log` line, with margin for the prefix. */
const LOG_LINE_CHARS = 1900;
function percent(ratio) {
	return `${Math.round(ratio * 100)}%`;
}
/** One line for the toast: reduction, decision counts, model and state size. */
function summarize(result) {
	const { stats } = result;
	const parts = [
		stats.kept > 0 ? `${stats.kept} kept` : "",
		stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : "",
		stats.callsDropped > 0 ? `${stats.callsDropped} calls dropped` : "",
		stats.pinned > 0 ? `${stats.pinned} pinned` : ""
	].filter(Boolean);
	const state = stats.stateStage ? `, state ~${stats.stateTokens} tokens (${stats.stateStage})` : "";
	return `${percent(reductionRatio(result))} reduction; ${parts.join(", ") || "no tool calls"}; ${stats.model}${state}, ${stats.requests} request(s)`;
}
/** Every unpinned decision with both probabilities, split into lines the log can hold. */
function decisionLogLines(result) {
	const entries = result.decisions.filter((d) => d.reason !== "pinned").map((d) => `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`);
	if (entries.length === 0) return ["decisions: (none)"];
	const chunks = [];
	let current = "";
	for (const entry of entries) {
		const next = current ? `${current} ${entry}` : entry;
		if (current && next.length > LOG_LINE_CHARS) {
			chunks.push(current);
			current = entry;
		} else current = next;
	}
	chunks.push(current);
	return chunks.map((chunk, index) => chunks.length === 1 ? `decisions: ${chunk}` : `decisions (${index + 1}/${chunks.length}): ${chunk}`);
}
//#endregion
//#region src/run.ts
/**
* Compacts a session transcript with the configured model, passing on what
* the person asked the compaction to keep (the text after `/compact`), retries with the
* rules-based model when that fails, and hands the result back only when it
* removed enough. Every other outcome is a fallback to the built-in summary.
*/
async function compactSession(messages, config, secrets, transport, instructions) {
	const choice = chooseModels(config, secrets, transport);
	if (!choice.ok) return {
		kind: "fallback",
		reason: choice.error,
		log: []
	};
	const { primary, fallback, notes } = choice.value;
	const log = [...notes];
	const options = {
		...config.compact,
		instructions,
		goal: promptGoal(messages)
	};
	let outcome = await compact(messages, primary, options);
	if (!outcome.ok && fallback) {
		log.push(`${primary.id} failed (${outcome.error.message}); retrying with ${fallback.id}`);
		outcome = await compact(messages, fallback, options);
	}
	if (!outcome.ok) return {
		kind: "fallback",
		reason: outcome.error.message,
		log
	};
	const result = outcome.value;
	log.push(...decisionLogLines(result));
	if (reductionRatio(result) < config.minReductionRatio) return {
		kind: "fallback",
		reason: `below the ${percent(config.minReductionRatio)} minimum: ${summarize(result)}`,
		log
	};
	return {
		kind: "replaced",
		messages: toSessionMessages(messages, result.messages),
		result,
		log
	};
}
//#endregion
//#region src/compact-hook.ts
const TOAST_MS = 15e3;
/** Told to core's summarizer of the stand-in: its answer is dropped, so it should be one line. */
const DISCARD_NOTE = "agent-context-pruner: this summary is discarded unread; reply with one short sentence.";
/** The answer to a `precompute` dispatch: pruning runs when the compaction itself runs. */
const PRECOMPUTE_SKIP = "agent-context-pruner prunes when the compaction runs";
function notify($, text) {
	$.ui.log(text);
	$.ui.toast(text, { timeoutMs: TOAST_MS });
}
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** HTTP through the engine: a hooks module has no Node and no global network. */
function engineTransport($) {
	return async (request) => {
		const response = await $.http.fetch(request.url, {
			method: request.method,
			headers: { ...request.headers },
			body: request.body
		});
		return {
			status: response.status,
			ok: response.ok,
			text: response.text
		};
	};
}
async function readSecrets($) {
	const [typesafeApiKey, cloudflareApiToken, cloudflareAccountId] = await Promise.all([
		$.env.get("TYPESAFE_API_KEY"),
		$.env.get("CLOUDFLARE_API_TOKEN"),
		$.env.get("CLOUDFLARE_ACCOUNT_ID")
	]);
	return {
		typesafeApiKey,
		cloudflareApiToken,
		cloudflareAccountId
	};
}
/**
* A small stand-in transcript for core: the last few messages with text,
* rebuilt without handles or tool blocks, so core's own summary of it is cheap.
*/
function probeOf(messages) {
	const texts = messages.filter((m) => m.text.trim().length > 0).slice(-4).map((m) => ({
		role: m.role,
		text: m.text,
		toolUses: []
	}));
	if (texts.length > 0) return texts;
	return [{
		role: "user",
		text: "(compacted by agent-context-pruner)",
		toolUses: []
	}];
}
/**
* Classic PreCompact hooks run only inside core's compaction, and a plugin
* cannot raise them itself. So core compacts the stand-in transcript: its
* PreCompact hooks run as they always do, and its summary is then dropped.
* Core is told so (DISCARD_NOTE), which keeps that summary to a line.
* Answers core's skip when a hook blocked the compaction, null otherwise.
*/
async function runPreCompactHooks($, e, next) {
	const started = Date.now();
	const instructions = e.instructions ? `${e.instructions}

${DISCARD_NOTE}` : DISCARD_NOTE;
	const core = await next({
		...e,
		instructions,
		messages: probeOf(e.messages)
	});
	const usage = "usage" in core && core.usage ? `, ${core.usage.output_tokens} output tokens` : "";
	$.ui.log(`PreCompact hooks ran through core compaction in ${Date.now() - started} ms${usage}`);
	return "skip" in core && typeof core.skip === "string" ? { skip: core.skip } : null;
}
async function finish($, e, next, outcome, config) {
	if (config.runPreCompactHooks) {
		const skipped = await runPreCompactHooks($, e, next).catch((error) => {
			$.ui.log(`PreCompact hooks through core failed (${messageOf(error)}); keeping the pruned history`);
			return null;
		});
		if (skipped) {
			notify($, `compaction skipped (${skipped.skip})`);
			return skipped;
		}
	}
	notify($, `${`kept ${outcome.messages.length}/${e.messages.length} messages, no summary`} (${summarize(outcome.result)})`);
	return { messages: outcome.messages };
}
/**
* The `session.compact` hook: prunes with the configured model, lets core run
* the classic PreCompact hooks, and falls back to core's own summary whenever
* pruning fails or would remove too little.
*/
async function handleCompact(config, $, e, next) {
	if (e.trigger === "precompute") return { skip: PRECOMPUTE_SKIP };
	let outcome;
	try {
		const secrets = await readSecrets($);
		outcome = await compactSession(e.messages, config, secrets, engineTransport($), e.instructions);
	} catch (error) {
		notify($, `fallback to built-in summary (${messageOf(error)})`);
		return next(e);
	}
	for (const line of outcome.log) $.ui.log(line);
	if (outcome.kind === "fallback") {
		notify($, `fallback to built-in summary (${outcome.reason})`);
		return next(e);
	}
	return finish($, e, next, outcome, config);
}
//#endregion
//#region src/config.ts
const PROVIDERS = [
	"auto",
	"typesafe",
	"cloudflare",
	"ollama",
	"custom",
	"heuristic"
];
const HOOK_DEFAULTS = {
	compactAtPercent: 60,
	minReductionRatio: .25,
	fallbackToHeuristic: true,
	runPreCompactHooks: true
};
function text(options, key) {
	const value = options[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : void 0;
}
function number(options, key) {
	const value = options[key];
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function flag(options, key) {
	const value = options[key];
	return typeof value === "boolean" ? value : void 0;
}
function isProvider(value) {
	return PROVIDERS.some((provider) => provider === value);
}
/** Reads the plugin's options; anything missing or malformed takes the default. */
function resolveHookConfig(options) {
	const provider = text(options, "provider");
	return {
		provider: isProvider(provider) ? provider : "auto",
		model: text(options, "model"),
		apiKey: text(options, "apiKey"),
		baseUrl: text(options, "baseUrl"),
		accountId: text(options, "accountId"),
		compact: {
			keepThreshold: number(options, "keepThreshold"),
			preserveRecentMessages: number(options, "preserveRecentMessages"),
			truncateHeadChars: number(options, "truncateHeadChars"),
			noteDroppedCalls: flag(options, "noteDroppedCalls")
		},
		compactAtPercent: number(options, "compactAtPercent") ?? HOOK_DEFAULTS.compactAtPercent,
		minReductionRatio: number(options, "minReductionRatio") ?? HOOK_DEFAULTS.minReductionRatio,
		fallbackToHeuristic: flag(options, "fallbackToHeuristic") ?? HOOK_DEFAULTS.fallbackToHeuristic,
		runPreCompactHooks: text(options, "preCompactHooks") !== "skip"
	};
}
//#endregion
//#region src/register.ts
const register = (on, options) => {
	const config = resolveHookConfig(options);
	let compacting = false;
	on("session.compact", ($, e, next) => handleCompact(config, $, e, next));
	on("turn.complete", async ($, e, next) => {
		if (compacting || config.compactAtPercent <= 0) return next(e);
		try {
			const { context } = await $.session.usage();
			if ((context.percent ?? 0) < config.compactAtPercent) return next(e);
			compacting = true;
			await $.session.compact();
		} catch (error) {
			$.ui.log(`auto-compact skipped (${messageOf(error)})`);
		} finally {
			compacting = false;
		}
		return next(e);
	});
};
//#endregion
export { register };
