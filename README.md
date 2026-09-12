# node-ws-lite

一个基于 **Node.js + WebSocket** 实现的轻量级 **VLESS over WebSocket** 服务端。

项目定位为简单、轻量、易部署，适合运行在 Docker 环境中，并可配合 **Cloudflare、Nginx、Caddy 等反向代理**提供 HTTPS / WSS 接入。

---

## ✨ 特性

* 🚀 基于 Node.js 实现，运行开销低
* 🔌 支持 VLESS over WebSocket
* 🔐 UUID 身份认证
* 🌐 支持 IPv4 / IPv6 / 域名目标地址
* 🐳 原生支持 Docker
* 🔒 支持只读文件系统运行
* 🛡️ Docker 容器默认移除 Linux capabilities
* 🌍 支持通过反向代理提供 HTTPS / WSS
* 📦 无需数据库
* 🧩 配置简单，适合快速部署
* 📡 提供 VLESS 配置及订阅接口

---

## 🏗️ 工作原理

整体连接流程：

```text
┌──────────────┐
│   VLESS 客户端 │
└──────┬───────┘
       │
       │ HTTPS / WSS
       ▼
┌──────────────────┐
│ Cloudflare / Nginx│
│    反向代理       │
└────────┬─────────┘
         │
         │ WebSocket
         ▼
┌──────────────────┐
│   node-ws-lite   │
│  VLESS WS Server │
└────────┬─────────┘
         │
         │ TCP
         ▼
┌──────────────────┐
│    目标服务器     │
└──────────────────┘
```

客户端首先通过 WebSocket 与 `node-ws-lite` 建立连接。

服务端验证 VLESS UUID 后，根据 VLESS 请求中的目标地址建立 TCP 连接，并将数据在：

```text
WebSocket ⇄ TCP
```

之间进行双向转发。

---

## 📋 环境要求

建议运行环境：

* Linux
* Docker
* Docker Compose

如果直接运行 Node.js：

* Node.js 18+
* npm

---

## 📁 项目结构

```text
node-ws-lite/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── package-lock.json
├── index.js
├── .env.example
├── .gitignore
├── .dockerignore
└── README.md
```

---

## ⚙️ 配置

项目通过环境变量进行配置。

创建 `.env`：

```env
PORT=9876

UUID=your-uuid-here

DOMAIN=your-domain.com

WSPATH=your-ws-path

SUB_PATH=autosub
```

### 配置说明

| 变量         | 说明           | 示例                                     |
| ---------- | ------------ | -------------------------------------- |
| `PORT`     | 服务监听端口       | `9876`                                 |
| `UUID`     | VLESS UUID   | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `DOMAIN`   | 对外使用的域名      | `node.example.com`                     |
| `WSPATH`   | WebSocket 路径 | `00c9f6c2`                             |
| `SUB_PATH` | 订阅接口路径       | `autosub`                              |

建议：

* `UUID` 使用随机 UUID
* `WSPATH` 不要使用过于明显的路径
* `.env` 不要提交到 GitHub
* 生产环境不要直接使用示例配置

---

## 🚀 Docker 部署

### 1. 克隆项目

```bash
git clone https://github.com/你的用户名/node-ws-lite.git

cd node-ws-lite
```

### 2. 创建配置文件

```bash
cp .env.example .env
```

编辑：

```bash
nano .env
```

例如：

```env
PORT=9876
UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
DOMAIN=node.example.com
WSPATH=00c9f6c2
SUB_PATH=autosub
```

---

### 3. 构建镜像

```bash
docker compose build
```

---

### 4. 启动服务

```bash
docker compose up -d
```

查看容器：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f
```

---

## 🔍 检查服务状态

查看容器：

```bash
docker ps
```

应该能够看到：

```text
node-ws-lite
```

检查端口：

```bash
ss -lntp | grep 9876
```

也可以测试 HTTP：

```bash
curl http://127.0.0.1:9876/
```

如果服务正常运行，应能够获得服务端返回的信息。

---

## 🔗 VLESS 配置

项目启动后会生成对应的 VLESS 配置。

基本格式：

```text
vless://UUID@DOMAIN:443?encryption=none&security=tls&sni=DOMAIN&type=ws&host=DOMAIN&path=%2FWSPATH#node-ws-lite
```

例如：

```text
vless://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx@node.example.com:443?encryption=none&security=tls&sni=node.example.com&type=ws&host=node.example.com&path=%2F00c9f6c2#node-ws-lite
```

其中：

```text
UUID
DOMAIN
WSPATH
```

需要与服务器 `.env` 中的配置保持一致。

---

## 🌐 HTTPS / WSS 部署

推荐不要直接让 Node.js 服务承担公网 HTTPS。

建议架构：

```text
Internet
   │
   │ HTTPS / WSS
   ▼
Cloudflare / Nginx / Caddy
   │
   │ HTTP / WebSocket
   ▼
127.0.0.1:9876
   │
   ▼
node-ws-lite
```

这样可以将：

```text
443
```

交给反向代理处理，而 `node-ws-lite` 只需要监听：

```text
9876
```

---

## 🔐 Nginx 反向代理示例

如果使用 Nginx，可以将 WebSocket 请求转发到：

```text
127.0.0.1:9876
```

示例配置：

```nginx
server {
    listen 443 ssl http2;
    server_name node.example.com;

    ssl_certificate     /etc/nginx/ssl/fullchain.pem;
    ssl_certificate_key /etc/nginx/ssl/private.key;

    location /00c9f6c2 {
        proxy_pass http://127.0.0.1:9876;

        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;

        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}
```

> 实际部署时请将域名、WebSocket 路径和证书路径替换为自己的配置。

---

## ☁️ Cloudflare

项目可以运行在 Cloudflare 反向代理之后。

基本结构：

```text
VLESS Client
     │
     │ WSS
     ▼
Cloudflare
     │
     │ WebSocket
     ▼
node-ws-lite
     │
     ▼
Internet
```

需要注意：

1. DNS 正确解析到服务器
2. Cloudflare 开启代理后使用 HTTPS / WSS
3. WebSocket 功能正常
4. 客户端的 `host` / `sni` / `serverName` 与域名保持一致
5. WebSocket Path 与 `WSPATH` 保持一致

---

## 📡 订阅接口

项目提供订阅接口：

```text
/autosub
```

实际地址：

```text
https://your-domain.com/autosub
```

具体订阅内容由服务端根据环境变量自动生成。

如果修改：

```env
SUB_PATH=autosub
```

则订阅路径也会随之变化。

---

## 🧩 WebSocket 路径

例如：

```env
WSPATH=00c9f6c2
```

实际 WebSocket 路径：

```text
/00c9f6c2
```

注意不要在环境变量中重复添加 `/`。

推荐：

```env
WSPATH=00c9f6c2
```

不要写成：

```env
WSPATH=/00c9f6c2
```

程序内部会统一进行路径规范化。

---

## 🔑 UUID

可以使用系统生成 UUID：

```bash
cat /proc/sys/kernel/random/uuid
```

例如：

```text
3f7f0d7e-9e2e-4e4c-a0e3-xxxxxxxxxxxx
```

然后写入：

```env
UUID=3f7f0d7e-9e2e-4e4c-a0e3-xxxxxxxxxxxx
```

---

## 🛡️ Docker 安全

项目 Docker Compose 默认采用较严格的容器运行配置：

```yaml
read_only: true
```

容器文件系统以只读方式运行。

同时：

```yaml
security_opt:
  - no-new-privileges:true
```

禁止进程通过 setuid / setgid 等方式获得额外权限。

并通过：

```yaml
cap_drop:
  - ALL
```

移除 Linux capabilities。

由于 `node-ws-lite` 本身不需要写入持久化文件，因此适合采用这种运行方式。

---

## 🔄 更新项目

拉取最新代码：

```bash
git pull
```

重新构建：

```bash
docker compose build --no-cache
```

重新创建容器：

```bash
docker compose up -d
```

查看日志：

```bash
docker compose logs -f
```

---

## 🧪 本地开发

安装依赖：

```bash
npm install
```

启动：

```bash
node index.js
```

或者：

```bash
npm start
```

检查 JavaScript 语法：

```bash
node --check index.js
```

---

## 📊 查看运行日志

Docker：

```bash
docker compose logs -f node-ws-lite
```

或者：

```bash
docker logs -f node-ws-lite
```

正常情况下可以看到类似：

```text
Server listening on 0.0.0.0:9876
```

当客户端建立 VLESS 连接后：

```text
VLESS CONNECT example.com:443
TCP CONNECTED example.com:443
```

---

## ❗ 常见问题

### 1. WebSocket 无法连接

检查：

```bash
docker compose ps
```

确认容器正在运行。

然后：

```bash
docker compose logs --tail=100
```

查看错误日志。

---

### 2. VLESS 连接失败

重点检查：

```text
UUID
DOMAIN
WSPATH
端口
TLS
WebSocket
```

确保客户端配置与服务端配置一致。

---

### 3. WebSocket Path 错误

例如服务端：

```env
WSPATH=00c9f6c2
```

那么客户端应该使用：

```text
/00c9f6c2
```

而不是：

```text
//00c9f6c2
```

---

### 4. 反向代理后无法连接

检查 Nginx / Caddy / Cloudflare 是否正确转发 WebSocket。

Nginx 至少需要：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

---

### 5. Docker 修改代码后没有生效

如果修改了：

```text
index.js
```

需要重新构建镜像：

```bash
docker compose build
docker compose up -d
```

仅仅重启旧容器不会自动将修改后的代码复制进镜像。

---

## 🔧 项目设计

项目核心流程：

```text
HTTP Server
     │
     ├── HTTP 请求
     │
     └── WebSocket Upgrade
              │
              ▼
       检查 WebSocket Path
              │
              ▼
       读取 VLESS 请求头
              │
              ▼
       验证 VLESS UUID
              │
              ▼
       解析目标地址
              │
              ▼
       创建 TCP Connection
              │
              ▼
      WebSocket ⇄ TCP
```

VLESS 请求支持：

```text
IPv4
Domain
IPv6
```

TCP 数据建立后进行双向转发：

```text
WebSocket → TCP
TCP → WebSocket
```

连接关闭时会进行相应资源清理，避免残留连接。

---

## 📦 技术栈

| 组件        | 技术                         |
| --------- | -------------------------- |
| 运行环境      | Node.js                    |
| WebSocket | ws                         |
| 协议        | VLESS                      |
| 传输        | WebSocket                  |
| 出站        | TCP                        |
| 容器        | Docker                     |
| 编排        | Docker Compose             |
| 反向代理      | Nginx / Cloudflare / Caddy |

---

## 📄 License

本项目采用 MIT License。

你可以自由使用、修改和分发本项目，但请保留原始版权及许可证声明。

---

## ⚠️ 免责声明

本项目仅用于学习、研究 Node.js、WebSocket、网络通信以及服务器部署技术。

请遵守所在国家或地区的法律法规，以及云服务商、网络服务商和相关平台的服务条款。

项目作者不对使用本项目产生的任何直接或间接后果负责。

---

## ⭐ 支持项目

如果这个项目对你有帮助，可以：

* ⭐ Star 项目
* 🐛 提交 Issue
* 🔧 提交 Pull Request
* 💡 分享你的改进方案

欢迎提交与 Node.js、WebSocket、Docker 以及 VLESS 实现相关的改进。
