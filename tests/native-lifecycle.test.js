import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { runTaskChefMcpProcess } from "../src/mcp-process.js";

for (const event of ["SIGTERM", "SIGINT", "end", "close", "protocol", "parent"]) {
  test(`native runtime closes transport and resources on ${event}`, async () => {
    const processObject = new EventEmitter();
    processObject.stdin = new EventEmitter();
    processObject.stderr = { write() {} };
    let closeTransport = 0, closeServer = 0, closeMonitor = 0, parent;
    const server = { server: {}, async connect() {}, async close() { closeServer++; } };
    const task = runTaskChefMcpProcess({
      server, processObject,
      transport: { async close() { closeTransport++; } },
      installParentMonitor: ({ onParentLoss }) => { parent = onParentLoss; return { close() { closeMonitor++; } }; },
    });
    await new Promise(resolve => setImmediate(resolve));
    if (event === "protocol") server.server.onclose();
    else if (event === "parent") parent();
    else if (event === "end" || event === "close") processObject.stdin.emit(event);
    else processObject.emit(event);
    await task;
    assert.equal(closeTransport, 1);
    assert.equal(closeServer, 1);
    assert.equal(closeMonitor, 1);
  });
}
