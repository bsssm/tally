/** Minimal SSE `data:` line extractor for usage sniffing on pass-through streams. Bodies are never stored. */
export class SSEUsageSniffer {
  private buf = "";
  constructor(private readonly onData: (json: Record<string, unknown>) => void) {}
  push(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        this.onData(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        /* partial or non-JSON line: ignore */
      }
    }
  }
}
