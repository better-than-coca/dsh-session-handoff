/**
 * Read and search the raw event log of the current session.
 *
 * A forked child inherits the parent's raw events verbatim, so the child can
 * recover any earlier detail without cross-session search: the route points at
 * seq numbers that exist in its own log. This module is the lookup half of
 * that route and needs no SQLite full-text index.
 */

/**
 * Snapshot the raw event log of a session across the two supported shapes.
 * @param session - target session.
 * @returns the durable event array, possibly empty.
 */
export function sessionEvents(session) {
    if (session === undefined || session === null) return [];
    if (typeof session.snapshotEvents === 'function') {
        const events = session.snapshotEvents();
        return Array.isArray(events) ? events : [];
    }
    if (Array.isArray(session.events)) return session.events;
    return [];
}

/**
 * Extract the human-readable text of one event.
 * @param event - durable session event.
 * @returns text blocks joined by newlines, or a JSON fallback.
 */
export function eventText(event) {
    const data = event?.data;
    if (data === undefined || data === null) return '';
    const parts = [];
    const message = data.message ?? data;
    const content = message?.content;
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
            else if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
        }
    }
    if (parts.length > 0) return parts.join('\n');
    if (typeof data.text === 'string') return data.text;
    try {
        return JSON.stringify(data);
    } catch {
        return '';
    }
}

function snippet(text, query, radius) {
    const flat = text.replace(/\s+/g, ' ');
    if (query === '') return flat.slice(0, radius * 2);
    const at = flat.toLowerCase().indexOf(query.toLowerCase());
    if (at < 0) return flat.slice(0, radius * 2);
    const start = Math.max(0, at - radius);
    return (start > 0 ? '…' : '') + flat.slice(start, at + query.length + radius) + '…';
}

/**
 * Literal substring search across the raw event log.
 * @param events - event array from {@link sessionEvents}.
 * @param query - literal text to look for (case-insensitive).
 * @param limit - maximum number of hits.
 * @returns matching lines, newest last.
 */
export function searchEvents(events, query, limit) {
    const hits = [];
    for (let index = events.length - 1; index >= 0 && hits.length < limit; index -= 1) {
        const event = events[index];
        const text = eventText(event);
        if (text === '') continue;
        if (text.toLowerCase().indexOf(query.toLowerCase()) < 0) continue;
        hits.push({ seq: event.seq, type: event.type, text: snippet(text, query, 120) });
    }
    return hits.reverse();
}

/**
 * Read one event in full plus optional neighbours.
 * @param events - event array from {@link sessionEvents}.
 * @param seq - target event sequence number.
 * @param before - number of preceding events to include.
 * @param after - number of following events to include.
 * @returns rendered text, or an explanation when the seq is absent.
 */
export function readEventDetail(events, seq, before, after) {
    const target = events.find((event) => event.seq === seq);
    if (target === undefined) return 'No event at seq ' + seq + ' in this session.';
    const first = Math.max(0, seq - before);
    const last = Math.min(events.length - 1, seq + after);
    const lines = [];
    for (let index = first; index <= last; index += 1) {
        const event = events[index];
        if (event === undefined) continue;
        const marker = event.seq === seq ? '>>' : '  ';
        const body = event.seq === seq
            ? '\n' + (eventText(event) || JSON.stringify(event.data)).slice(0, 6000)
            : ' ' + snippet(eventText(event) || JSON.stringify(event.data), '', 90);
        lines.push(marker + ' [' + event.seq + '] ' + event.type + body);
    }
    return lines.join('\n');
}
