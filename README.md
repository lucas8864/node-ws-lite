# node-ws-lite

一个极简的 Node.js VLESS + Trojan over WebSocket TCP Bridge。

## 功能

- VLESS + WebSocket
- Trojan + WebSocket
- TCP CONNECT
- WebSocket ↔ TCP 双向转发
- VLESS/Trojan Base64 订阅
- `/` 根路径
- `/health` 健康检查
- `/sub` 订阅

不包含 SS、VMess、Hysteria、TUIC、SOCKS5、UDP、Xray、sing-box、Nginx、Caddy、cloudflared、数据库、管理后台等功能。

## 架构

```text
Client
  │ WSS
  ▼
Cloudflare
  │ WebSocket
  ▼
node-ws-lite:9876
  │
  ├── VLESS
  └── Trojan
       │
       ▼
   TCP Target
```

Node.js 本身只提供 HTTP + WebSocket，不负责 TLS。

## 环境变量

```env
UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
DOMAIN=example.com
PORT=9876
WSPATH=
SUB_PATH=sub
```

- `UUID`：VLESS 身份认证，同时用于计算 Trojan SHA-224 密码。
- `DOMAIN`：订阅生成使用的域名。
- `PORT`：监听端口，默认 `9876`。
- `WSPATH`：WebSocket 路径。为空时取 UUID 去掉 `-` 后的前 8 位。
- `SUB_PATH`：订阅路径，默认 `sub`。

## Docker Compose

```bash
cp .env.example .env
nano .env
docker compose up -d --build
docker compose ps
docker compose logs -f
```

健康检查：

```bash
curl http://127.0.0.1:9876/health
```

预期：

```text
ok
```

根路径：

```bash
curl http://127.0.0.1:9876/
```

预期：

```text
node-ws-lite
```

订阅：

```bash
curl http://127.0.0.1:9876/sub
```

返回 Base64 文本。解码后应包含：

```text
vless://
trojan://
```

## WebSocket 地址

假设：

```env
DOMAIN=example.com
UUID=5efabea4-f6d4-91fd-b8f0-17e004c89c60
```

默认 WebSocket Path：

```text
/5efabea4
```

Cloudflare 前端使用：

```text
wss://example.com/5efabea4
```

源站：

```text
http://SERVER_IP:9876/5efabea4
```

## Cloudflare

推荐结构：

```text
Client
  │
  │ WSS :443
  ▼
Cloudflare
  │
  │ WebSocket
  ▼
Server :9876
  │
  ▼
node-ws-lite
```

Node.js 不需要证书。

## 防火墙

源站只需要按实际部署情况放行 TCP `9876`。

如果只允许 Cloudflare 访问源站，应进一步按 Cloudflare 官方 IP 段限制来源。

## 常见问题

### 1. `/health` 正常，但 WebSocket 无法连接

检查：

```bash
docker compose logs --tail=100 node-ws-lite
ss -lntp | grep 9876
```

确认 Cloudflare 的 WebSocket 代理已经启用，并确认客户端 Path 与 `WSPATH` 完全一致。

### 2. 路径错误

例如配置默认 Path：

```text
/5efabea4
```

则：

```text
/foo
/ws
/
```

都不会建立代理连接。

### 3. UUID 错误

VLESS 会直接拒绝认证。

### 4. Trojan 密码

Trojan 密码由：

```text
SHA224(UUID)
```

生成。订阅接口会自动生成对应的 Trojan URL。

### 5. 容器启动失败

先检查：

```bash
docker compose logs --tail=200
docker compose config
```

然后确认 `.env` 中：

```text
UUID
DOMAIN
PORT
```

均有效。

## 手工运行

需要 Node.js 22+：

```bash
npm ci
node index.js
```

## 验收

```bash
docker compose up -d --build
curl http://127.0.0.1:9876/health
curl http://127.0.0.1:9876/
curl http://127.0.0.1:9876/sub
```

项目只有一个核心 JavaScript 文件：

```text
index.js
```

