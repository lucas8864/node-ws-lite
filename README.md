# node-ws-lite

轻量级 VLESS over WebSocket 服务端，基于 Node.js + WebSocket + TCP 实现，支持 Docker / Docker Compose 部署。

适合搭配 Cloudflare、Nginx 或其他反向代理使用。

## ✨ Features

* 🚀 Node.js 实现，轻量快速
* 🔐 VLESS 协议
* 🌐 WebSocket 传输
* 🐳 Docker / Docker Compose
* 🔑 UUID 身份认证
* 🛣️ 自定义 WebSocket Path
* 📦 VLESS Subscription
* 🔄 TCP 双向数据转发
* ☁️ 支持 Cloudflare WebSocket
* 🔒 支持 HTTPS / WSS
* 🧩 环境变量配置
* 🛡️ Docker ReadonlyRootfs

## 📁 Project Structure

```text
node-ws-lite/
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── docker-compose.yml
├── index.js
├── package.json
└── package-lock.json
```

## ⚙️ Requirements

* Linux
* Docker
* Docker Compose
* 一个可用域名
* 如果使用 Cloudflare，需要开启 WebSocket

检查 Docker：

```bash
docker --version
docker compose version
```

## 🚀 Quick Start

### 1. Clone

```bash
git clone https://github.com/你的用户名/node-ws-lite.git
cd node-ws-lite
```

### 2. 创建配置文件

复制 `.env.example`：

```bash
cp .env.example .env
```

编辑：

```bash
nano .env
```

示例：

```env
PORT=9876
UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
DOMAIN=node.example.com
WSPATH=00c9f6c2
SUB_PATH=autosub
```

参数说明：

| 参数         | 说明           | 示例                                     |
| ---------- | ------------ | -------------------------------------- |
| `PORT`     | Node.js 服务端口 | `9876`                                 |
| `UUID`     | VLESS UUID   | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `DOMAIN`   | 服务域名         | `node.example.com`                     |
| `WSPATH`   | WebSocket 路径 | `00c9f6c2`                             |
| `SUB_PATH` | 订阅路径         | `autosub`                              |

## 🐳 Docker Deploy

启动：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f --tail=100
```

停止：

```bash
docker compose down
```

重建：

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

## 🔍 Health Check

服务启动后：

```bash
curl http://127.0.0.1:9876/
```

正常情况下会返回：

```text
node-ws-lite

WebSocket path: /00c9f6c2
Subscription path: /autosub
Domain: node.example.com
```

检查端口：

```bash
ss -lntp | grep 9876
```

## 🔗 VLESS Configuration

服务启动后，日志会自动输出 VLESS 配置：

```text
VLESS: vless://...
```

基本格式：

```text
vless://UUID@DOMAIN:443?encryption=none&security=tls&sni=DOMAIN&type=ws&host=DOMAIN&path=%2FWSPATH#VLESS
```

例如：

```text
vless://xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx@node.example.com:443?encryption=none&security=tls&sni=node.example.com&type=ws&host=node.example.com&path=%2F00c9f6c2#VLESS-node.example.com
```

## 📦 Subscription

订阅地址：

```text
https://你的域名/autosub
```

例如：

```text
https://node.example.com/autosub
```

服务器会返回 Base64 编码的 VLESS 配置。

## ☁️ Cloudflare

如果使用 Cloudflare：

```text
客户端
   │
   │ HTTPS / WSS
   ▼
Cloudflare
   │
   │ WebSocket
   ▼
服务器
   │
   ▼
node-ws-lite:9876
   │
   │ TCP
   ▼
目标服务器
```

DNS 中将域名解析到服务器。

例如：

```text
node.example.com
        ↓
服务器公网 IP
```

Cloudflare 开启代理后，客户端使用：

```text
https://node.example.com
```

或：

```text
wss://node.example.com
```

WebSocket Path 使用：

```text
/00c9f6c2
```

### Cloudflare 注意事项

确保 Cloudflare 支持 WebSocket。

同时反向代理需要将：

```text
Upgrade: websocket
Connection: Upgrade
```

正确转发。

## 🔧 Nginx Example

如果前面使用 Nginx，可以参考：

```nginx
server {
    listen 443 ssl;
    server_name node.example.com;

    location /00c9f6c2 {
        proxy_pass http://127.0.0.1:9876;

        proxy_http_version 1.1;

        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }

    location /autosub {
        proxy_pass http://127.0.0.1:9876;

        proxy_set_header Host $host;
    }
}
```

## 🛠️ Troubleshooting

### 1. 容器无法启动

查看：

```bash
docker compose logs --tail=100
```

检查配置：

```bash
cat .env
```

注意不要把 `.env` 提交到 GitHub。

### 2. 检查 Node.js 代码

```bash
node --check index.js
```

正常情况下不会输出任何内容。

### 3. 检查 WebSocket Path

如果 `.env`：

```env
WSPATH=00c9f6c2
```

实际 WebSocket Path 是：

```text
/00c9f6c2
```

不要配置成：

```text
//00c9f6c2
```

### 4. VLESS UUID 错误

日志出现：

```text
VLESS UUID authentication failed
```

检查：

```bash
echo $UUID
```

以及 Docker 环境变量：

```bash
docker compose config
```

确保客户端 UUID 与服务器 `.env` 中的 UUID 一致。

### 5. TCP 连接失败

如果日志：

```text
VLESS CONNECT www.google.com:443
```

但没有：

```text
TCP CONNECTED www.google.com:443
```

说明 VLESS / WebSocket 已经进入连接处理阶段，需要检查服务器到目标地址的网络连通性。

### 6. WebSocket 连接关闭

正常情况下客户端主动断开可能出现：

```text
WebSocket CLOSED
TCP CLOSED
```

这属于正常连接生命周期。

## 🔐 Security

请注意：

* 不要把 `.env` 上传到 GitHub
* 不要公开真实 UUID
* 不要把服务器密码、Token、API Key 提交到仓库
* 建议使用随机 UUID
* 建议使用较难猜测的 WebSocket Path
* 生产环境建议使用 HTTPS / WSS
* Docker 容器默认使用只读文件系统

生成 UUID：

```bash
cat /proc/sys/kernel/random/uuid
```

## 🔄 Update

更新代码：

```bash
git pull
```

重新构建：

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

查看日志：

```bash
docker compose logs -f --tail=100
```

## 📄 License

This project is provided for learning and research purposes.

Please comply with the laws and regulations applicable to your location when using this project.

````

### 然后提交到 GitHub

保存 README 后：

```bash
cd /opt/node-ws-lite

git add README.md
git commit -m "Update README"
git push
````

如果这是第一次 push：

```bash
git push -u origin main
```

**另外建议你把 README 里的 `你的用户名` 替换成真实 GitHub 用户名。** 如果你告诉我你的 GitHub 仓库地址，我还可以把 README 里的 `clone` 地址、项目名称等全部改成最终可直接发布的版本。

