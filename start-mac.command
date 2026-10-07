#!/bin/bash
# macOS 双击运行（首次需要：右键 → 打开，或在终端执行 chmod +x start-mac.command）
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没有检测到 Node.js，请先安装：https://nodejs.org/  （或 brew install node）"
  echo ""
  read -r -p "按回车键退出…"
  exit 1
fi

echo ""
echo "  正在启动号码整理工具，浏览器会自动打开……"
echo "  首次使用请点右上角「设置」，填入通义千问 API Key。"
echo ""
node server.js --open
read -r -p "按回车键退出…"
