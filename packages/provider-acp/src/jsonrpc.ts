import type { Readable, Writable } from "node:stream";

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcRequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type JsonRpcNotificationHandler = (method: string, params: unknown) => void;

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

/** A JSON-RPC 2.0 peer speaking newline-delimited JSON on a pair of streams. */
export class JsonRpcConnection {
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly requestHandlers = new Map<string, JsonRpcRequestHandler>();
  private notificationHandler: JsonRpcNotificationHandler | undefined;
  private closeHandler: ((error?: Error) => void) | undefined;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {
    input.setEncoding?.("utf8");
    input.on("data", (chunk: string | Buffer) => this.onData(chunk.toString()));
    input.on("close", () => this.handleClosed());
    input.on("error", (error: Error) => this.handleClosed(error));
  }

  handleRequest(method: string, handler: JsonRpcRequestHandler): this {
    this.requestHandlers.set(method, handler);
    return this;
  }

  onNotification(handler: JsonRpcNotificationHandler): this {
    this.notificationHandler = handler;
    return this;
  }

  onClosed(handler: (error?: Error) => void): this {
    this.closeHandler = handler;
    return this;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(new JsonRpcError(-32000, "Connection is closed"));
    }
    const id = this.nextId++;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) payload.params = params;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.writeLine(JSON.stringify(payload));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) payload.params = params;
    this.writeLine(JSON.stringify(payload));
  }

  respond(id: number | string, result: unknown): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id: number | string, code: number, message: string): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }

  close(): void {
    this.handleClosed();
  }

  private writeLine(line: string): void {
    if (this.closed) return;
    try {
      this.output.write(`${line}\n`);
    } catch (error) {
      this.handleClosed(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private onData(text: string): void {
    this.buffer += text;
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) this.dispatch(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Ignore malformed lines (agents sometimes log to stdout).
      return;
    }

    if (message.method !== undefined && message.id !== undefined) {
      void this.handleIncomingRequest(message);
      return;
    }
    if (message.method !== undefined) {
      this.notificationHandler?.(message.method as string, message.params);
      return;
    }
    if (message.id !== undefined) {
      this.handleResponse(message as unknown as JsonRpcResponse);
    }
  }

  private async handleIncomingRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id as number | string;
    const method = message.method as string;
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.respondError(id, -32601, `Method not found: ${method}`);
      return;
    }
    try {
      const result = await handler(message.params);
      this.respond(id, result ?? {});
    } catch (error) {
      this.respondError(
        id,
        error instanceof JsonRpcError ? error.code : -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const id = typeof message.id === "number" ? message.id : Number(message.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (message.error) {
      entry.reject(new JsonRpcError(message.error.code, message.error.message, message.error.data));
    } else {
      entry.resolve(message.result);
    }
  }

  private handleClosed(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      entry.reject(error ?? new JsonRpcError(-32000, "Connection closed"));
    }
    this.pending.clear();
    this.closeHandler?.(error);
  }
}
