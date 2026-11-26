export interface SseEvent {
  readonly event?: string;
  readonly data: string;
}

/**
 * Parses a Server-Sent Events (SSE) byte stream into discrete event frames.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseEvent | undefined => {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      return undefined;
    }
    const frame: SseEvent = {
      ...(currentEvent !== undefined ? { event: currentEvent } : {}),
      data: dataLines.join('\n'),
    };
    currentEvent = undefined;
    dataLines = [];
    return frame;
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line === '') {
          const frame = flush();
          if (frame) yield frame;
        } else if (line.startsWith(':')) {
          // SSE comment line
        } else if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }

        newlineIndex = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const rawLine of buffer.split(/\r?\n/u)) {
        if (rawLine.startsWith('event:')) currentEvent = rawLine.slice(6).trim();
        else if (rawLine.startsWith('data:')) dataLines.push(rawLine.slice(5).trimStart());
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}
