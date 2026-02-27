import readline from "node:readline";

export class JsonRpcStdioClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.notificationHandlers = new Set();
    this.nextId = 1;

    this.stdoutRl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.stdoutRl.on("line", (line) => this.#onLine(line));

    child.on("exit", (code, signal) => {
      const reason = new Error(`app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      for (const pending of this.pending.values()) {
        pending.reject(reason);
      }
      this.pending.clear();
    });
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(msg, "id")) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (Object.prototype.hasOwnProperty.call(msg, "error")) {
        pending.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      for (const handler of this.notificationHandlers) {
        handler(msg);
      }
    }
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  call(method, params = undefined, timeoutMs = 60_000) {
    const id = this.nextId++;
    const payload = { method, id, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params = undefined) {
    const payload = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async close(graceMs = 800) {
    this.stdoutRl.close();
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve();
      }, graceMs);

      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
