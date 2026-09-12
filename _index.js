"use strict";

const http = require("http");
const net = require("net");
const crypto = require("crypto");
const {
  WebSocketServer,
  createWebSocketStream,
} = require("ws");

const PORT = Number(process.env.PORT || 9876);
const UUID = String(process.env.UUID || "").trim();
const DOMAIN = String(process.env.DOMAIN || "").trim();

const WSPATH = normalizePath(process.env.WSPATH || "/");
const SUB_PATH = normalizePath(process.env.SUB_PATH || "/autosub");

if (!UUID) {
  throw new Error("UUID is required");
}

if (!DOMAIN) {
  throw new Error("DOMAIN is required");
}

const UUID_HEX = UUID.replace(/-/g, "").toLowerCase();

if (!/^[0-9a-f]{32}$/.test(UUID_HEX)) {
  throw new Error(`Invalid UUID: ${UUID}`);
}

const UUID_BUFFER = Buffer.from(UUID_HEX, "hex");

function normalizePath(value) {
  value = String(value || "").trim();

  if (!value) {
    return "/";
  }

  value = value
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!value) {
    return "/";
  }

  return "/" + value;
}

function safeEqual(a, b) {
  if (!Buffer.isBuffer(a)) {
    a = Buffer.from(a);
  }

  if (!Buffer.isBuffer(b)) {
    b = Buffer.from(b);
  }

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

/**
 * VLESS request:
 *
 * +---------+----------------+-------+---------+------+-------+------+
 * | version | UUID(16 bytes) | addons| command | port | atyp  | addr |
 * +---------+----------------+-------+---------+------+-------+------+
 * |   1     |      16        |   1   |    1    |  2   |   1   | ...  |
 * +---------+----------------+-------+---------+------+-------+------+
 *
 * VLESS version = 0x00
 */
function parseVlessRequest(message) {
  const buf = Buffer.isBuffer(message)
    ? message
    : Buffer.from(message);

  if (buf.length < 18) {
    throw new Error("VLESS request too short");
  }

  // VLESS version is 0x00
  const version = buf[0];

  if (version !== 0x00) {
    throw new Error(
      `unsupported VLESS version: ${version}`
    );
  }

  // UUID
  const requestUUID = buf.subarray(1, 17);

  if (!safeEqual(requestUUID, UUID_BUFFER)) {
    throw new Error("VLESS UUID authentication failed");
  }

  // Addons length
  const addonsLength = buf[17];

  let offset = 18 + addonsLength;

  if (buf.length < offset + 4) {
    throw new Error("VLESS request header incomplete");
  }

  // Command
  const command = buf[offset];

  // 0x01 = TCP
  if (command !== 0x01) {
    throw new Error(
      `unsupported VLESS command: ${command}`
    );
  }

  offset += 1;

  // Port
  const port = buf.readUInt16BE(offset);
  offset += 2;

  if (port < 1 || port > 65535) {
    throw new Error(`invalid destination port: ${port}`);
  }

  // Address type
  const addressType = buf[offset];
  offset += 1;

  let host;

  switch (addressType) {
    // IPv4
    case 0x01: {
      if (buf.length < offset + 4) {
        throw new Error("VLESS IPv4 address incomplete");
      }

      host = Array.from(
        buf.subarray(offset, offset + 4)
      ).join(".");

      offset += 4;
      break;
    }

    // Domain
    case 0x02: {
      if (buf.length < offset + 1) {
        throw new Error("VLESS domain length missing");
      }

      const domainLength = buf[offset];
      offset += 1;

      if (domainLength < 1) {
        throw new Error("VLESS invalid domain length");
      }

      if (buf.length < offset + domainLength) {
        throw new Error("VLESS domain address incomplete");
      }

      host = buf
        .subarray(offset, offset + domainLength)
        .toString("utf8");

      offset += domainLength;

      if (!host) {
        throw new Error("VLESS empty destination host");
      }

      break;
    }

    // IPv6
    case 0x03: {
      if (buf.length < offset + 16) {
        throw new Error("VLESS IPv6 address incomplete");
      }

      const parts = [];

      for (let i = 0; i < 16; i += 2) {
        parts.push(
          buf.readUInt16BE(offset + i).toString(16)
        );
      }

      host = parts.join(":");

      offset += 16;
      break;
    }

    default:
      throw new Error(
        `unsupported VLESS address type: ${addressType}`
      );
  }

  return {
    version,
    host,
    port,
    initialData: buf.subarray(offset),
  };
}

function buildVlessUrl() {
  const path = encodeURIComponent(WSPATH);

  return (
    `vless://${UUID}` +
    `@${DOMAIN}:443` +
    `?encryption=none` +
    `&security=tls` +
    `&sni=${encodeURIComponent(DOMAIN)}` +
    `&type=ws` +
    `&host=${encodeURIComponent(DOMAIN)}` +
    `&path=${path}` +
    `#VLESS-${DOMAIN}`
  );
}

function buildSubscription() {
  return Buffer.from(buildVlessUrl()).toString("base64");
}

/**
 * 创建 WebSocket Server
 *
 * noServer=true：
 * 我们自己处理 HTTP Upgrade，
 * 这样可以严格控制 WSPATH。
 */
const wss = new WebSocketServer({
  noServer: true,
});

/**
 * VLESS WebSocket connection
 */
function handleVlessConnection(ws, message) {
  let request;

  try {
    request = parseVlessRequest(message);
  } catch (error) {
    console.error(
      `VLESS rejected: ${error.message}`
    );

    try {
      if (ws.readyState === ws.OPEN) {
        ws.close(1008, "VLESS request rejected");
      }
    } catch (_) {}

    return;
  }

  const {
    version,
    host,
    port,
    initialData,
  } = request;

  console.log(
    `VLESS CONNECT ${host}:${port}`
  );

  /**
   * Connection lifecycle state
   *
   * 防止多个 close/error 事件重复执行。
   */
  let closed = false;
  let socket = null;
  let duplex = null;

  function cleanup(reason) {
    if (closed) {
      return;
    }

    closed = true;

    if (reason) {
      console.log(
        `Connection cleanup ${host}:${port} (${reason})`
      );
    }

    // TCP
    if (socket) {
      try {
        socket.removeAllListeners();
      } catch (_) {}

      try {
        socket.destroy();
      } catch (_) {}

      socket = null;
    }

    // WebSocket stream
    if (duplex) {
      try {
        duplex.destroy();
      } catch (_) {}

      duplex = null;
    }

    // WebSocket
    try {
      if (
        ws.readyState === ws.OPEN ||
        ws.readyState === ws.CONNECTING
      ) {
        ws.close();
      }
    } catch (_) {}
  }

  /**
   * VLESS response:
   *
   * version = 0x00
   * addons length = 0
   */
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(
        Buffer.from([
          version,
          0x00,
        ])
      );
    }
  } catch (error) {
    console.error(
      `WebSocket response error: ${error.message}`
    );

    cleanup("websocket response failed");
    return;
  }

  /**
   * WebSocket -> Duplex Stream
   */
  try {
    duplex = createWebSocketStream(ws);
  } catch (error) {
    console.error(
      `WebSocket stream create error: ${error.message}`
    );

    cleanup("stream create failed");
    return;
  }

  /**
   * TCP connection
   */
  socket = net.createConnection({
    host,
    port,
  });

  /**
   * TCP connected
   */
  socket.once("connect", () => {
    if (closed) {
      return;
    }

    console.log(
      `TCP CONNECTED ${host}:${port}`
    );

    /**
     * VLESS 首包剩余数据
     */
    if (initialData && initialData.length > 0) {
      try {
        socket.write(initialData);
      } catch (error) {
        console.error(
          `TCP initial data error: ${error.message}`
        );

        cleanup("initial data failed");
        return;
      }
    }

    /**
     * 双向转发
     *
     * WebSocket -> TCP
     * TCP -> WebSocket
     */
    if (!closed && duplex) {
      duplex.pipe(socket);
      socket.pipe(duplex);
    }
  });

  /**
   * TCP error
   */
  socket.on("error", (error) => {
    if (closed) {
      return;
    }

    console.error(
      `TCP ERROR ${host}:${port}: ${error.message}`
    );

    cleanup("tcp error");
  });

  /**
   * TCP timeout
   *
   * 这里不主动设置 30 秒 timeout，
   * 避免正常的长连接被误杀。
   */
  socket.on("timeout", () => {
    if (closed) {
      return;
    }

    console.log(
      `TCP TIMEOUT ${host}:${port}`
    );

    cleanup("tcp timeout");
  });

  /**
   * TCP close
   */
  socket.once("close", () => {
    if (closed) {
      return;
    }

    console.log(
      `TCP CLOSED ${host}:${port}`
    );

    cleanup("tcp closed");
  });

  /**
   * Duplex error
   */
  duplex.on("error", (error) => {
    if (closed) {
      return;
    }

    /**
     * 这里重点过滤：
     *
     * WebSocket is not open:
     * readyState 2 (CLOSING)
     *
     * 这种情况通常只是客户端已经主动关闭。
     */
    if (
      error &&
      typeof error.message === "string" &&
      error.message.includes(
        "WebSocket is not open"
      )
    ) {
      cleanup("websocket closing");
      return;
    }

    console.error(
      `WebSocket stream error: ${error.message}`
    );

    cleanup("websocket stream error");
  });

  /**
   * Duplex close
   */
  duplex.once("close", () => {
    if (closed) {
      return;
    }

    console.log(
      `WebSocket stream CLOSED ${host}:${port}`
    );

    cleanup("websocket stream closed");
  });

  /**
   * WebSocket close
   *
   * 客户端主动断开时：
   *
   * WebSocket CLOSED
   *        ↓
   * destroy TCP
   */
  ws.once("close", () => {
    if (closed) {
      return;
    }

    console.log(
      `WebSocket CLOSED ${host}:${port}`
    );

    cleanup("websocket closed");
  });

  /**
   * WebSocket error
   */
  ws.once("error", (error) => {
    if (closed) {
      return;
    }

    console.error(
      `WebSocket ERROR ${host}:${port}: ${error.message}`
    );

    cleanup("websocket error");
  });

  /**
   * WebSocket 已经进入 closing 时，
   * 立即停止继续向其写入。
   */
  ws.once("close", () => {
    try {
      if (duplex && !duplex.destroyed) {
        duplex.destroy();
      }
    } catch (_) {}
  });
}

/**
 * WebSocket connection
 */
wss.on("connection", (ws, request) => {
  ws.once("message", (message) => {
    handleVlessConnection(ws, message);
  });

  /**
   * 客户端建立 WS 后一直不发送 VLESS 请求，
   * 防止连接长期占用。
   */
  const handshakeTimer = setTimeout(() => {
    if (ws.readyState === ws.OPEN) {
      console.error(
        "WebSocket handshake timeout"
      );

      try {
        ws.close(1008, "handshake timeout");
      } catch (_) {}
    }
  }, 15000);

  ws.once("message", () => {
    clearTimeout(handshakeTimer);
  });

  ws.once("close", () => {
    clearTimeout(handshakeTimer);
  });

  ws.once("error", () => {
    clearTimeout(handshakeTimer);
  });
});

/**
 * HTTP Server
 */
const server = http.createServer((req, res) => {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  /**
   * 首页
   */
  if (url.pathname === "/") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
    });

    res.end(
      [
        "node-ws-lite",
        "",
        `WebSocket path: ${WSPATH}`,
        `Subscription path: ${SUB_PATH}`,
        `Domain: ${DOMAIN}`,
      ].join("\n")
    );

    return;
  }

  /**
   * Subscription
   */
  if (url.pathname === SUB_PATH) {
    const subscription = buildSubscription();

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });

    res.end(subscription);

    return;
  }

  /**
   * Other paths
   */
  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8",
  });

  res.end("404 Not Found");
});

/**
 * HTTP Upgrade -> WebSocket
 */
server.on("upgrade", (request, socket, head) => {
  let url;

  try {
    url = new URL(
      request.url,
      `http://${request.headers.host || "localhost"}`
    );
  } catch (_) {
    socket.destroy();
    return;
  }

  /**
   * 只允许指定 WebSocket Path
   */
  if (url.pathname !== WSPATH) {
    socket.write(
      "HTTP/1.1 404 Not Found\r\n" +
      "Connection: close\r\n" +
      "\r\n"
    );

    socket.destroy();

    return;
  }

  /**
   * WebSocket Upgrade
   */
  wss.handleUpgrade(
    request,
    socket,
    head,
    (ws) => {
      wss.emit(
        "connection",
        ws,
        request
      );
    }
  );
});

/**
 * Server error
 */
server.on("error", (error) => {
  console.error(
    `HTTP SERVER ERROR: ${error.message}`
  );
});

/**
 * Start
 */
server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `node-ws-lite listening on 0.0.0.0:${PORT}`
  );

  console.log(
    `WebSocket path: ${WSPATH}`
  );

  console.log(
    `Subscription path: ${SUB_PATH}`
  );

  console.log(
    `Domain: ${DOMAIN}`
  );

  console.log(
    `VLESS: ${buildVlessUrl()}`
  );
});

