#!/bin/bash

echo "🔍 正在激活 Predict.fun Console 窗口..."
echo ""

# 方法1：尝试使用 AppleScript（需要辅助功能权限）
osascript -e 'tell application "System Events"'
osascript -e 'set frontmost of first process whose unix id is 20744' 2>/dev/null

# 方法2：打开应用
open -a "Electron" 2>/dev/null

echo "✅ 窗口应该已经显示"
echo ""
echo "如果仍然看不到窗口，请："
echo "  1. 按 F3 打开 Mission Control"
echo "  2. 或点击 Dock 栏中的 Electron 图标"
