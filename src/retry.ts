/**
 * Mark a narrow set of CPA transport failures as retryable for Pi.
 *
 * Only failures where nothing reached the user are relabeled: once text,
 * thinking, or a tool call has streamed, Pi's retry would repeat billable work
 * and duplicate output, so those errors are left for the user to decide on.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";

const TRANSIENT_STREAM_ERROR =
	/\bclosed network connection\b|\bstream disconnected before completion\b|\binvalid (?:codex )?sse (?:data )?json\b/i;
const NETWORK_ERROR_PREFIX = "network error:";

function hasStreamedOutput(message: AssistantMessage): boolean {
	return message.content.some((block) => {
		if (block.type === "text") return block.text.length > 0;
		if (block.type === "thinking") return block.thinking.length > 0;
		return true;
	});
}

export function normalizeTransientError(
	message: AssistantMessage,
	isRetryable: (message: AssistantMessage) => boolean,
): AssistantMessage | undefined {
	if (message.stopReason !== "error" || !message.errorMessage) return undefined;
	if (!TRANSIENT_STREAM_ERROR.test(message.errorMessage)) return undefined;
	if (isRetryable(message) || hasStreamedOutput(message)) return undefined;
	return { ...message, errorMessage: `${NETWORK_ERROR_PREFIX} ${message.errorMessage}` };
}
