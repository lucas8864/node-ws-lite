services:
  node-ws-lite:
    build:
      context: .
      dockerfile: Dockerfile

    container_name: node-ws-lite

    restart: unless-stopped

    environment:
      PORT: ${PORT:-9876}
      UUID: ${UUID}
      DOMAIN: ${DOMAIN}
      WSPATH: ${WSPATH:-00c9f6c2}
      SUB_PATH: ${SUB_PATH:-autosub}

    ports:
      - "${PORT:-9876}:9876"

    read_only: true

    security_opt:
      - no-new-privileges:true

    cap_drop:
      - ALL
