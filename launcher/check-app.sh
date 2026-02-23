#!/bin/bash

echo "🔍 检查桌面启动器状态..."
echo ""

# 检查Electron进程
if pgrep -f "predict-fun-launcher" > /dev/null; then
    echo "✅ 桌面启动器正在运行"
    echo ""
    echo "进程信息："
    ps aux | grep -E "predict-fun-launcher|Electron" | grep -v grep | head -5
    echo ""
    echo "💡 如果窗口没有显示，可能的原因："
    echo "  1. 窗口在其他桌面空间 - 使用 Mission Control 切换"
    echo "  2. 窗口被隐藏 - 检查 Dock 栏"
    echo "  3. 窗口在后台 - 点击应用图标"
else
    echo "❌ 桌面启动器未运行"
    echo ""
    echo "尝试启动..."
    cd /Users/cc/Desktop/CC/predict-fun-market-maker/launcher
    npm start
fi
