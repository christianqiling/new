#!/usr/bin/env bash
# 店内计时收费系统 启动脚本
# 用法: ./start.sh   或   PORT=8080 ./start.sh
set -e
cd "$(dirname "$0")"

# 该沙箱环境存在一个无效的 NODE_OPTIONS 预加载，需先清除
unset NODE_OPTIONS

PORT="${PORT:-3000}"
export PORT
echo "正在启动店内计时收费系统 (端口 $PORT)…"
exec node src/server.js
