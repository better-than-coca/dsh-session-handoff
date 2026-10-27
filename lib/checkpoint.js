/**
 * Checkpoint framing.
 *
 * The exact preamble and tags the host uses for its own compaction checkpoints,
 * so a handed-off session treats the injected text as established background
 * rather than as a request it should answer.
 */

export const SUMMARY_OPEN_TAG = '<compacted-summary>';
export const SUMMARY_CLOSE_TAG = '</compacted-summary>';
export const CHECKPOINT_PREAMBLE = 'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';

/**
 * Wrap checkpoint text in the host's framing.
 * @param summaryText - the generated checkpoint body.
 * @returns framed text ready to inject or append.
 */
export function frameCheckpoint(summaryText) {
    return [CHECKPOINT_PREAMBLE, '', SUMMARY_OPEN_TAG, summaryText, SUMMARY_CLOSE_TAG].join('\n');
}
