import { expect, test } from "bun:test";
import { SocketBuffers } from "./socket-buffers.ts";

function fakeSocket(accept = Number.POSITIVE_INFINITY) {
  const writes: number[][] = [];
  const socket = {
    writes,
    ended: 0,
    accept,
    write(bytes: Uint8Array): number {
      const taken = Math.min(bytes.length, socket.accept);
      writes.push([...bytes.subarray(0, taken)]);
      return taken;
    },
    end(): void {
      socket.ended += 1;
    },
  };
  return socket;
}

test("packets sent in one turn go out in one write", async () => {
  const socket = fakeSocket();
  const io = new SocketBuffers(socket);
  io.send(Uint8Array.of(1, 2));
  io.send(Uint8Array.of(3));
  expect(socket.writes).toEqual([]);
  await Promise.resolve();
  expect(socket.writes).toEqual([[1, 2, 3]]);
});

test("bytes the socket did not take are written again on drain, in order", async () => {
  const socket = fakeSocket(2);
  const io = new SocketBuffers(socket);
  io.send(Uint8Array.of(1, 2, 3));
  await Promise.resolve();
  io.send(Uint8Array.of(4));
  await Promise.resolve();
  socket.accept = Number.POSITIVE_INFINITY;
  io.flush();
  expect(socket.writes.flat()).toEqual([1, 2, 3, 4]);
});

test("close writes what is queued before ending, and waits for drain when the socket is full", async () => {
  const socket = fakeSocket(1);
  const io = new SocketBuffers(socket);
  io.send(Uint8Array.of(7, 8));
  io.close();
  expect(io.open).toBe(false);
  expect(socket.ended).toBe(0);
  io.send(Uint8Array.of(9));
  socket.accept = Number.POSITIVE_INFINITY;
  io.flush();
  await Promise.resolve();
  expect(socket.writes.flat()).toEqual([7, 8]);
  expect(socket.ended).toBe(1);
});

test("received chunks join and take returns them in order", () => {
  const io = new SocketBuffers(fakeSocket());
  const first = Uint8Array.of(1, 2, 3);
  io.receive(first);
  expect(io.received).toBe(first);
  io.receive(Uint8Array.of(4, 5));
  expect([...io.take(4)]).toEqual([1, 2, 3, 4]);
  expect([...io.received]).toEqual([5]);
});
