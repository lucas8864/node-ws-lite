"use strict";

const http = require("http");
const net = require("net");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const {
  WebSocketServer,
  createWebSocketStream,
} = require("ws");

/* =========================================================
 * 基础配置
 * ======================================================= */

const PORT = Number(
  process.env.PORT || "9876"
);

const UUID = String(
  process.env.UUID || ""
).trim();

const DOMAIN = String(
  process.env.DOMAIN || ""
).trim();

const WSPATH = normalizePath(
  process.env.WSPATH || "/"
);

const SUB_PATH = normalizePath(
  process.env.SUB_PATH || "/autosub"
);

/* =========================================================
 * 外网 CFIP 地址源
 * ======================================================= */

const IP_SOURCE_URL =
  "https://raw.githubusercontent.com/lucas8864/WorkerVless2sub/refs/heads/main/addressesapi.txt";

/*
 * 每次最多随机选择 99 个 CFIP
 */
const IP_SELECT_COUNT = 99;

/*
 * CFIP 缓存时间：
 * 1 小时
 */
const IP_CACHE_TTL =
  60 * 60 * 1000;

/*
 * CFIP 缓存
 */
let preferredIPCache = {
  timestamp: 0,
  items: [],
};

/* =========================================================
 * UUID 校验
 * ======================================================= */

if (!UUID) {
  throw new Error(
    "UUID is required"
  );
}

if (!DOMAIN) {
  throw new Error(
    "DOMAIN is required"
  );
}

const UUID_HEX = UUID
  .replace(/-/g, "")
  .toLowerCase();

if (
  !/^[0-9a-f]{32}$/.test(
    UUID_HEX
  )
) {
  throw new Error(
    `Invalid UUID: ${UUID}`
  );
}

const UUID_BUFFER = Buffer.from(
  UUID_HEX,
  "hex"
);

/* =========================================================
 * 路径规范化
 * ======================================================= */

function normalizePath(value) {
  value = String(
    value || ""
  ).trim();

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

/* =========================================================
 * 安全比较
 * ======================================================= */

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

  return crypto.timingSafeEqual(
    a,
    b
  );
}

/* =========================================================
 * VLESS 请求解析
 * ======================================================= */

function parseVlessRequest(message) {
  const buf = Buffer.isBuffer(message)
    ? message
    : Buffer.from(message);

  if (buf.length < 18) {
    throw new Error(
      "VLESS request too short"
    );
  }

  const version = buf[0];

  if (version !== 0x00) {
    throw new Error(
      `unsupported VLESS version: ${version}`
    );
  }

  const requestUUID =
    buf.subarray(1, 17);

  if (
    !safeEqual(
      requestUUID,
      UUID_BUFFER
    )
  ) {
    throw new Error(
      "VLESS UUID authentication failed"
    );
  }

  const addonsLength = buf[17];

  let offset =
    18 + addonsLength;

  if (buf.length < offset + 4) {
    throw new Error(
      "VLESS request header incomplete"
    );
  }

  const command = buf[offset];

  if (command !== 0x01) {
    throw new Error(
      `unsupported VLESS command: ${command}`
    );
  }

  offset += 1;

  const port =
    buf.readUInt16BE(offset);

  offset += 2;

  if (
    port < 1 ||
    port > 65535
  ) {
    throw new Error(
      `invalid destination port: ${port}`
    );
  }

  const addressType =
    buf[offset];

  offset += 1;

  let host;

  switch (addressType) {
    case 0x01: {
      if (buf.length < offset + 4) {
        throw new Error(
          "VLESS IPv4 address incomplete"
        );
      }

      host = Array.from(
        buf.subarray(
          offset,
          offset + 4
        )
      ).join(".");

      offset += 4;

      break;
    }

    case 0x02: {
      if (buf.length < offset + 1) {
        throw new Error(
          "VLESS domain length missing"
        );
      }

      const domainLength =
        buf[offset];

      offset += 1;

      if (domainLength < 1) {
        throw new Error(
          "VLESS invalid domain length"
        );
      }

      if (
        buf.length <
        offset + domainLength
      ) {
        throw new Error(
          "VLESS domain address incomplete"
        );
      }

      host = buf
        .subarray(
          offset,
          offset + domainLength
        )
        .toString("utf8");

      offset += domainLength;

      if (!host) {
        throw new Error(
          "VLESS empty destination host"
        );
      }

      break;
    }

    case 0x03: {
      if (buf.length < offset + 16) {
        throw new Error(
          "VLESS IPv6 address incomplete"
        );
      }

      const parts = [];

      for (
        let i = 0;
        i < 16;
        i += 2
      ) {
        parts.push(
          buf
            .readUInt16BE(
              offset + i
            )
            .toString(16)
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
    initialData:
      buf.subarray(offset),
  };
}

/* =========================================================
 * 解析外网 CFIP 地址列表
 *
 * 外网文件格式：
 *
 * IP:PORT#备注
 *
 * 例如：
 *
 * 104.17.120.125:443#微测_|_香港_|_HK_|_HKG_|_移动
 *
 * 最终保存：
 *
 * {
 *   ip: "104.17.120.125",
 *   port: 443,
 *   remark: "微测_|_香港_|_HK_|_HKG_|_移动"
 * }
 * ======================================================= */

function parseIPList(text) {
  const result = [];
  const seen = new Set();

  const lines = String(
    text || ""
  ).split(/\r?\n/);

  for (const line of lines) {
    const value =
      line.trim();

    if (
      !value ||
      value.startsWith("#")
    ) {
      continue;
    }

    /*
     * IP:PORT#remark
     */
    const match = value.match(
      /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})(?:#(.*))?$/
    );

    if (!match) {
      continue;
    }

    const ip = match[1];

    const port = Number(
      match[2]
    );

    const remark =
      String(
        match[3] || ""
      ).trim();

    /*
     * 端口校验
     */
    if (
      port < 1 ||
      port > 65535
    ) {
      continue;
    }

    /*
     * IPv4 校验
     */
    const parts =
      ip.split(".");

    if (
      parts.length !== 4 ||
      parts.some(
        (part) => {
          const value =
            Number(part);

          return (
            !Number.isInteger(
              value
            ) ||
            value < 0 ||
            value > 255
          );
        }
      )
    ) {
      continue;
    }

    /*
     * IP:PORT 去重
     */
    const key =
      `${ip}:${port}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    result.push({
      ip,
      port,
      remark,
    });
  }

  return result;
}

/* =========================================================
 * Fisher-Yates 随机
 * ======================================================= */

function shuffle(array) {
  const result = [
    ...array,
  ];

  for (
    let i = result.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() *
        (i + 1)
      );

    [
      result[i],
      result[j],
    ] = [
      result[j],
      result[i],
    ];
  }

  return result;
}

/* =========================================================
 * 从外网获取 CFIP
 * ======================================================= */

async function fetchPreferredIPs() {
  console.log(
    "========================================"
  );

  console.log(
    "Fetching CFIP list from external source..."
  );

  console.log(
    `Source: ${IP_SOURCE_URL}`
  );

  const response =
    await fetch(
      IP_SOURCE_URL,
      {
        headers: {
          "User-Agent":
            "node-ws-lite",
          "Accept":
            "text/plain",
        },
      }
    );

  if (!response.ok) {
    throw new Error(
      `IP source HTTP ${response.status}`
    );
  }

  const text =
    await response.text();

  const allIPs =
    parseIPList(text);

  if (allIPs.length === 0) {
    throw new Error(
      "IP source returned no valid IP addresses"
    );
  }

  /*
   * 随机选择 99 个
   */
  const selected =
    shuffle(allIPs).slice(
      0,
      Math.min(
        IP_SELECT_COUNT,
        allIPs.length
      )
    );

  console.log(
    `External CFIP count: ${allIPs.length}`
  );

  console.log(
    `Selected CFIP count: ${selected.length}`
  );

  console.log(
    "========================================"
  );

  return selected;
}

/* =========================================================
 * 获取 CFIP 缓存
 *
 * 缓存 1 小时
 *
 * 如果刷新失败：
 * 使用上一批缓存
 * ======================================================= */

async function getPreferredIPs() {
  const now =
    Date.now();

  const cacheValid =
    preferredIPCache.items.length > 0 &&
    now -
      preferredIPCache.timestamp <
      IP_CACHE_TTL;

  /*
   * 缓存有效
   */
  if (cacheValid) {
    const ageMinutes =
      Math.floor(
        (
          now -
          preferredIPCache.timestamp
        ) / 60000
      );

    console.log(
      `Using cached CFIP list (${ageMinutes} min old)`
    );

    return preferredIPCache.items;
  }

  /*
   * 缓存过期或第一次获取
   */
  try {
    const items =
      await fetchPreferredIPs();

    preferredIPCache = {
      timestamp:
        Date.now(),
      items,
    };

    console.log(
      `CFIP cache refreshed: ${items.length} nodes`
    );

    console.log(
      "CFIP cache TTL: 60 minutes"
    );

    return items;
  } catch (error) {
    /*
     * 如果存在旧缓存，
     * 继续使用旧缓存
     */
    if (
      preferredIPCache.items.length > 0
    ) {
      console.error(
        `Failed to refresh CFIP: ${error.message}`
      );

      console.log(
        `Using previous cached CFIP: ${preferredIPCache.items.length}`
      );

      return preferredIPCache.items;
    }

    /*
     * 第一次获取失败，
     * 没有任何缓存
     */
    throw error;
  }
}

/* =========================================================
 * 原始域名节点
 *
 * vless://${UUID}@${DOMAIN}:443
 *
 * TLS
 * ======================================================= */

function buildOriginalDomainUrl() {
  return (
    `vless://${UUID}` +
    `@${DOMAIN}:443` +
    `?encryption=none` +
    `&security=tls` +
    `&sni=${encodeURIComponent(DOMAIN)}` +
    `&type=ws` +
    `&host=${encodeURIComponent(DOMAIN)}` +
    `&path=${encodeURIComponent(WSPATH)}` +
    `#cf-node-${encodeURIComponent(DOMAIN)}`
  );
}

/* =========================================================
 * CFIP 节点
 *
 * IP:PORT
 *
 * TLS
 *
 * SNI = DOMAIN
 *
 * Host = DOMAIN
 *
 * 别名 = addressesapi.txt # 后面的完整内容
 * ======================================================= */

function buildPreferredIPUrl(
  ip,
  port,
  remark
) {
  /*
   * 如果外部数据没有备注，
   * 使用 IP:PORT 作为兜底名称。
   */
  const nodeName =
    String(
      remark || `${ip}:${port}`
    ).trim();

  return (
    `vless://${UUID}` +
    `@${ip}:${port}` +
    `?encryption=none` +
    `&security=tls` +
    `&sni=${encodeURIComponent(DOMAIN)}` +
    `&type=ws` +
    `&host=${encodeURIComponent(DOMAIN)}` +
    `&path=${encodeURIComponent(WSPATH)}` +
    `#${encodeURIComponent(nodeName)}`
  );
}

/* =========================================================
 * 构建订阅
 *
 * 1 个原始域名节点
 *
 * +
 *
 * 99 个 CFIP TLS 节点
 *
 * 最后整体 Base64
 * ======================================================= */

async function buildSubscription() {
  const nodes = [];

  /*
   * 1.
   * 原始域名节点
   */
  nodes.push(
    buildOriginalDomainUrl()
  );

  /*
   * 2.
   * 获取外网 CFIP
   */
  const preferredIPs =
    await getPreferredIPs();

  /*
   * 3.
   * 生成 CFIP TLS 节点
   */
  for (
    const item of preferredIPs
  ) {
    nodes.push(
      buildPreferredIPUrl(
        item.ip,
        item.port,
        item.remark
      )
    );
  }

  /*
   * 4.
   * 明文节点列表
   */
  const content =
    nodes.join("\n");

  /*
   * 5.
   * 整体 Base64
   */
  const encoded =
    Buffer
      .from(
        content,
        "utf8"
      )
      .toString("base64");

  console.log(
    `Subscription generated: ${nodes.length} nodes`
  );

  return encoded;
}

/* =========================================================
 * WebSocket Server
 * ======================================================= */

const wss =
  new WebSocketServer({
    noServer: true,
  });

/* =========================================================
 * VLESS TCP 连接处理
 * ======================================================= */

function handleVlessConnection(
  ws,
  message
) {
  let request;

  try {
    request =
      parseVlessRequest(
        message
      );
  } catch (error) {
    console.error(
      `VLESS rejected: ${error.message}`
    );

    try {
      if (
        ws.readyState ===
        ws.OPEN
      ) {
        ws.close(
          1008,
          "VLESS request rejected"
        );
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

    if (socket) {
      try {
        socket.removeAllListeners();
      } catch (_) {}

      try {
        socket.destroy();
      } catch (_) {}

      socket = null;
    }

    if (duplex) {
      try {
        duplex.destroy();
      } catch (_) {}

      duplex = null;
    }

    try {
      if (
        ws.readyState ===
          ws.OPEN ||
        ws.readyState ===
          ws.CONNECTING
      ) {
        ws.close();
      }
    } catch (_) {}
  }

  /*
   * VLESS response
   */
  try {
    if (
      ws.readyState ===
      ws.OPEN
    ) {
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

    cleanup(
      "websocket response failed"
    );

    return;
  }

  /*
   * 创建 WebSocket Stream
   */
  try {
    duplex =
      createWebSocketStream(
        ws
      );
  } catch (error) {
    console.error(
      `WebSocket stream create error: ${error.message}`
    );

    cleanup(
      "stream create failed"
    );

    return;
  }

  /*
   * 创建 TCP
   */
  socket =
    net.createConnection({
      host,
      port,
    });

  /*
   * TCP connected
   */
  socket.once(
    "connect",
    () => {
      if (closed) {
        return;
      }

      console.log(
        `TCP CONNECTED ${host}:${port}`
      );

      /*
       * 发送 VLESS 初始数据
       */
      if (
        initialData &&
        initialData.length > 0
      ) {
        try {
          socket.write(
            initialData
          );
        } catch (error) {
          console.error(
            `TCP initial data error: ${error.message}`
          );

          cleanup(
            "initial data failed"
          );

          return;
        }
      }

      /*
       * 双向转发
       */
      if (
        !closed &&
        duplex
      ) {
        duplex.pipe(
          socket
        );

        socket.pipe(
          duplex
        );
      }
    }
  );

  /*
   * TCP error
   */
  socket.on(
    "error",
    (error) => {
      if (closed) {
        return;
      }

      console.error(
        `TCP ERROR ${host}:${port}: ${error.message}`
      );

      cleanup(
        "tcp error"
      );
    }
  );

  /*
   * TCP timeout
   */
  socket.on(
    "timeout",
    () => {
      if (closed) {
        return;
      }

      console.log(
        `TCP TIMEOUT ${host}:${port}`
      );

      cleanup(
        "tcp timeout"
      );
    }
  );

  /*
   * TCP close
   */
  socket.once(
    "close",
    () => {
      if (closed) {
        return;
      }

      console.log(
        `TCP CLOSED ${host}:${port}`
      );

      cleanup(
        "tcp closed"
      );
    }
  );

  /*
   * WebSocket stream error
   */
  duplex.on(
    "error",
    (error) => {
      if (closed) {
        return;
      }

      if (
        error &&
        typeof error.message ===
          "string" &&
        error.message.includes(
          "WebSocket is not open"
        )
      ) {
        cleanup(
          "websocket closing"
        );

        return;
      }

      console.error(
        `WebSocket stream error: ${error.message}`
      );

      cleanup(
        "websocket stream error"
      );
    }
  );

  /*
   * WebSocket stream close
   */
  duplex.once(
    "close",
    () => {
      if (closed) {
        return;
      }

      console.log(
        `WebSocket stream CLOSED ${host}:${port}`
      );

      cleanup(
        "websocket stream closed"
      );
    }
  );

  /*
   * WebSocket close
   */
  ws.once(
    "close",
    () => {
      if (closed) {
        return;
      }

      console.log(
        `WebSocket CLOSED ${host}:${port}`
      );

      cleanup(
        "websocket closed"
      );
    }
  );

  /*
   * WebSocket error
   */
  ws.once(
    "error",
    (error) => {
      if (closed) {
        return;
      }

      console.error(
        `WebSocket ERROR ${host}:${port}: ${error.message}`
      );

      cleanup(
        "websocket error"
      );
    }
  );
}

/* =========================================================
 * WebSocket connection
 * ======================================================= */

wss.on(
  "connection",
  (ws, request) => {
    ws.once(
      "message",
      (message) => {
        handleVlessConnection(
          ws,
          message
        );
      }
    );

    /*
     * 15 秒握手超时
     */
    const handshakeTimer =
      setTimeout(
        () => {
          if (
            ws.readyState ===
            ws.OPEN
          ) {
            console.error(
              "WebSocket handshake timeout"
            );

            try {
              ws.close(
                1008,
                "handshake timeout"
              );
            } catch (_) {}
          }
        },
        15000
      );

    ws.once(
      "message",
      () => {
        clearTimeout(
          handshakeTimer
        );
      }
    );

    ws.once(
      "close",
      () => {
        clearTimeout(
          handshakeTimer
        );
      }
    );

    ws.once(
      "error",
      () => {
        clearTimeout(
          handshakeTimer
        );
      }
    );
  }
);

/* =========================================================
 * HTTP Server
 * ======================================================= */

const server =
  http.createServer(
    async (req, res) => {
      const url =
        new URL(
          req.url,
          `http://${req.headers.host || "localhost"}`
        );

      /* ===================================================
       * 首页
       * ================================================= */

      if (
        url.pathname === "/"
      ) {
        const indexPath =
          path.join(
            __dirname,
            "index.html"
          );

        try {
          let html =
            fs.readFileSync(
              indexPath,
              "utf8"
            );

          html = html
            .replaceAll(
              "__WSPATH__",
              WSPATH
            )
            .replaceAll(
              "__SUB_PATH__",
              SUB_PATH
            )
            .replaceAll(
              "__DOMAIN__",
              DOMAIN
            );

          res.writeHead(
            200,
            {
              "Content-Type":
                "text/html; charset=utf-8",

              "Cache-Control":
                "no-cache",
            }
          );

          res.end(
            html
          );
        } catch (error) {
          console.error(
            `Failed to read index.html: ${error.message}`
          );

          res.writeHead(
            500,
            {
              "Content-Type":
                "text/plain; charset=utf-8",
            }
          );

          res.end(
            "500 Internal Server Error"
          );
        }

        return;
      }

      /* ===================================================
       * Base64 订阅
       * ================================================= */

      if (
        url.pathname ===
        SUB_PATH
      ) {
        try {
          const subscription =
            await buildSubscription();

          res.writeHead(
            200,
            {
              "Content-Type":
                "text/plain; charset=utf-8",

              "Cache-Control":
                "no-store",

              "Content-Length":
                Buffer.byteLength(
                  subscription,
                  "utf8"
                ),
            }
          );

          /*
           * 这里返回的是：
           *
           * Base64(100 个 VLESS 节点)
           */
          res.end(
            subscription
          );
        } catch (error) {
          console.error(
            `Subscription build failed: ${error.message}`
          );

          res.writeHead(
            503,
            {
              "Content-Type":
                "text/plain; charset=utf-8",

              "Cache-Control":
                "no-store",
            }
          );

          res.end(
            "503 Subscription temporarily unavailable"
          );
        }

        return;
      }

      /* ===================================================
       * 404
       * ================================================= */

      res.writeHead(
        404,
        {
          "Content-Type":
            "text/plain; charset=utf-8",
        }
      );

      res.end(
        "404 Not Found"
      );
    }
  );

/* =========================================================
 * HTTP Upgrade
 * ======================================================= */

server.on(
  "upgrade",
  (
    request,
    socket,
    head
  ) => {
    let url;

    try {
      url =
        new URL(
          request.url,
          `http://${request.headers.host || "localhost"}`
        );
    } catch (_) {
      socket.destroy();
      return;
    }

    /*
     * 只允许指定 WebSocket Path
     */
    if (
      url.pathname !==
      WSPATH
    ) {
      socket.write(
        "HTTP/1.1 404 Not Found\r\n" +
        "Connection: close\r\n" +
        "\r\n"
      );

      socket.destroy();

      return;
    }

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
  }
);

/* =========================================================
 * HTTP Server Error
 * ======================================================= */

server.on(
  "error",
  (error) => {
    console.error(
      `HTTP SERVER ERROR: ${error.message}`
    );
  }
);

/* =========================================================
 * 启动
 * ======================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "========================================"
    );

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
      `CFIP source: ${IP_SOURCE_URL}`
    );

    console.log(
      "CFIP cache: 60 minutes"
    );

    console.log(
      "CFIP selection: 99"
    );

    console.log(
      "CFIP security: TLS"
    );

    console.log(
      `VLESS: ${buildOriginalDomainUrl()}`
    );

    console.log(
      "========================================"
    );
  }
);
