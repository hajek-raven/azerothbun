import { ArrayBufferSink } from "bun";

/** The part of a Bun `Socket` these buffers use. */
type Writable = {
  write(data: Uint8Array): number;
  end(): void;
};

/**
 * Byte queues for one connection.
 *
 * Received chunks are joined until a whole packet is there. Bun hands every `data` call a fresh
 * buffer, so the first chunk is kept as is.
 *
 * Bun sockets do not buffer writes. Packets sent during one turn of the event loop are joined in an
 * `ArrayBufferSink` and written once from a microtask, the way `WorldSocket::Update` drains
 * `_bufferQueue` into one `MessageBuffer`. Bytes the kernel does not take stay queued until `drain`.
 */
export class SocketBuffers {
  private input: Uint8Array = new Uint8Array(0);
  private readonly output = new ArrayBufferSink();
  private queued = 0;
  private flushScheduled = false;
  private state: "open" | "closing" | "closed" = "open";

  constructor(private readonly socket: Writable) {
    this.output.start({ stream: true, asUint8Array: true, highWaterMark: 4096 });
  }

  /** False once `close` was called or the peer is gone. */
  get open(): boolean {
    return this.state === "open";
  }

  get received(): Uint8Array {
    return this.input;
  }

  receive(data: Uint8Array): void {
    if (this.input.length === 0) {
      this.input = data;
      return;
    }
    const joined = new Uint8Array(this.input.length + data.length);
    joined.set(this.input, 0);
    joined.set(data, this.input.length);
    this.input = joined;
  }

  /** The next `length` received bytes. The view stays valid after later `receive` calls. */
  take(length: number): Uint8Array {
    const bytes = this.input.subarray(0, length);
    this.input = this.input.subarray(length);
    return bytes;
  }

  discardReceived(): void {
    this.input = new Uint8Array(0);
  }

  send(packet: Uint8Array): void {
    if (this.state !== "open") {
      return;
    }
    this.output.write(packet);
    this.queued += packet.length;
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  /** Called from the microtask queued by `send` and from the socket `drain` handler. */
  flush(): void {
    this.flushScheduled = false;
    if (this.state === "closed") {
      return;
    }
    if (this.queued > 0) {
      const data = this.output.flush() as Uint8Array;
      const wrote = this.socket.write(data);
      if (wrote < 0) {
        this.queued = 0;
        this.state = "closed";
        return;
      }
      if (wrote < data.length) {
        this.output.write(data.subarray(wrote));
        this.queued = data.length - wrote;
        return;
      }
      this.queued = 0;
    }
    if (this.state === "closing") {
      this.state = "closed";
      this.socket.end();
    }
  }

  /** Writes what is queued, then closes. Matches `DelayedCloseSocket`. */
  close(): void {
    if (this.state !== "open") {
      return;
    }
    this.state = "closing";
    this.flush();
  }
}
