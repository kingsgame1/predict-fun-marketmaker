#!/bin/bash

############################################################
# 🚀 激活验证服务器 - 一键部署脚本
############################################################

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 打印带颜色的消息
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_header() {
    echo ""
    echo -e "${BLUE}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC}  $1"
    echo -e "${BLUE}╚══════════════════════════════════════════════════════╝${NC}"
    echo ""
}

# 检查是否为root用户
check_root() {
    if [ "$EUID" -ne 0 ]; then
        print_error "请使用root用户或sudo运行此脚本"
        exit 1
    fi
}

# 检测操作系统
detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        VERSION=$VERSION_ID
    else
        print_error "无法检测操作系统"
        exit 1
    fi

    print_success "检测到操作系统: $OS $VERSION"
}

# 安装Node.js
install_nodejs() {
    print_header "安装Node.js"

    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v)
        print_success "Node.js已安装: $NODE_VERSION"
        return
    fi

    print_info "安装Node.js 18.x..."

    if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
        apt-get install -y nodejs
    elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ]; then
        curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
        yum install -y nodejs
    else
        print_error "不支持的操作系统: $OS"
        exit 1
    fi

    print_success "Node.js安装完成"
    node --version
    npm --version
}

# 安装PM2
install_pm2() {
    print_header "安装PM2进程管理器"

    if command -v pm2 &> /dev/null; then
        PM2_VERSION=$(pm2 -v)
        print_success "PM2已安装: $PM2_VERSION"
        return
    fi

    print_info "安装PM2..."
    npm install -g pm2

    print_success "PM2安装完成"
    pm2 -v
}

# 创建项目目录
create_project_dir() {
    print_header "创建项目目录"

    PROJECT_DIR="/opt/predict-fun-activation"

    if [ -d "$PROJECT_DIR" ]; then
        print_warning "项目目录已存在: $PROJECT_DIR"
        read -p "是否删除并重新创建? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            rm -rf "$PROJECT_DIR"
            print_info "已删除旧目录"
        else
            print_info "使用现有目录"
        fi
    fi

    mkdir -p "$PROJECT_DIR"
    cd "$PROJECT_DIR"

    print_success "项目目录: $PROJECT_DIR"
}

# 复制服务器文件
copy_server_files() {
    print_header "复制服务器文件"

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    print_info "从 $SCRIPT_DIR 复制文件..."

    cp -r "$SCRIPT_DIR"/* "$PROJECT_DIR/"

    print_success "文件复制完成"
}

# 安装依赖
install_dependencies() {
    print_header "安装项目依赖"

    cd "$PROJECT_DIR"
    npm install

    print_success "依赖安装完成"
}

# 生成管理员密钥
generate_admin_key() {
    print_header "生成管理员API密钥"

    ADMIN_KEY=$(openssl rand -base64 32)

    print_success "管理员API密钥已生成"
    print_warning "请妥善保存此密钥，丢失后无法恢复！"
    echo ""
    echo -e "${RED}管理员API密钥: $ADMIN_KEY${NC}"
    echo ""

    # 保存到文件
    echo "$ADMIN_KEY" > "$PROJECT_DIR/.admin_key"
    chmod 600 "$PROJECT_DIR/.admin_key"
    print_success "密钥已保存到: $PROJECT_DIR/.admin_key"
}

# 配置环境变量
configure_env() {
    print_header "配置环境变量"

    ENV_FILE="$PROJECT_DIR/.env"

    # 读取管理员密钥
    if [ -f "$PROJECT_DIR/.admin_key" ]; then
        ADMIN_KEY=$(cat "$PROJECT_DIR/.admin_key")
    else
        print_error "找不到管理员密钥"
        exit 1
    fi

    # 创建.env文件
    cat > "$ENV_FILE" << EOF
# 激活验证服务器配置
# 生成时间: $(date)

# 服务器端口
ACTIVATION_PORT=3000

# 数据库路径
DB_PATH=./activations.db

# RSA密钥路径（首次运行会自动生成）
RSA_PRIVATE_KEY_PATH=./keys/private.pem
RSA_PUBLIC_KEY_PATH=./keys/public.pem

# ⚠️ 管理员API密钥（必须保密）
ADMIN_API_KEY=$ADMIN_KEY

# 速率限制
MAX_REQUESTS_PER_MINUTE=60

# 最大设备绑定数
MAX_ACTIVATIONS_PER_KEY=3

# 日志级别
LOG_LEVEL=info
EOF

    print_success "环境配置已保存到: $ENV_FILE"
}

# 配置防火墙
configure_firewall() {
    print_header "配置防火墙"

    if [ "$OS" = "ubuntu" ] || [ "$OS" = "debian" ]; then
        if command -v ufw &> /dev/null; then
            print_info "配置UFW防火墙..."
            ufw allow 3000/tcp
            ufw allow 22/tcp
            ufw --force enable
            print_success "UFW防火墙配置完成"
        else
            print_warning "UFW未安装，跳过防火墙配置"
        fi
    elif [ "$OS" = "centos" ] || [ "$OS" = "rhel" ]; then
        if command -v firewall-cmd &> /dev/null; then
            print_info "配置firewalld..."
            firewall-cmd --permanent --add-port=3000/tcp
            firewall-cmd --reload
            print_success "firewalld配置完成"
        else
            print_warning "firewalld未安装，跳过防火墙配置"
        fi
    fi
}

# 启动服务器
start_server() {
    print_header "启动激活验证服务器"

    cd "$PROJECT_DIR"

    # 使用PM2启动
    pm2 start validate-server.js --name activation-server

    # 保存PM2配置
    pm2 save

    # 设置开机自启
    pm2 startup systemd -u root --hp /root

    print_success "服务器启动成功"
}

# 验证服务
verify_service() {
    print_header "验证服务状态"

    sleep 2

    # 检查PM2状态
    pm2 status

    # 测试健康检查
    print_info "测试健康检查..."
    if curl -s http://localhost:3000/health > /dev/null; then
        print_success "健康检查通过"
    else
        print_error "健康检查失败"
        exit 1
    fi
}

# 显示公钥
show_public_key() {
    print_header "服务器公钥"

    if [ -f "$PROJECT_DIR/keys/public.pem" ]; then
        print_info "服务器公钥（用于客户端配置）："
        echo ""
        cat "$PROJECT_DIR/keys/public.pem"
        echo ""
        print_warning "请将此公钥复制到客户端的 .env 文件中的 ACTIVATION_SERVER_PUBLIC_KEY 变量"
    else
        print_warning "公钥文件将在服务器首次启动时自动生成"
        print_info "请稍后使用以下命令查看："
        echo "  cat $PROJECT_DIR/keys/public.pem"
    fi
}

# 显示完成信息
show_completion() {
    print_header "部署完成"

    echo ""
    echo -e "${GREEN}🎉 激活验证服务器部署成功！${NC}"
    echo ""
    echo "📋 重要信息："
    echo "  - 项目目录: $PROJECT_DIR"
    echo "  - 服务端口: 3000"
    echo "  - 管理员密钥: $(cat $PROJECT_DIR/.admin_key)"
    echo "  - 公钥文件: $PROJECT_DIR/keys/public.pem"
    echo ""
    echo "🔧 常用命令："
    echo "  - 查看状态: pm2 status"
    echo "  - 查看日志: pm2 logs activation-server"
    echo "  - 重启服务: pm2 restart activation-server"
    echo "  - 停止服务: pm2 stop activation-server"
    echo ""
    echo "📚 下一步："
    echo "  1. 配置域名和SSL证书（可选）"
    echo "  2. 配置客户端连接到此服务器"
    echo "  3. 测试激活码生成和验证"
    echo ""
    echo "📖 详细文档: $PROJECT_DIR/README.md"
    echo ""
}

# 主函数
main() {
    print_header "🚀 激活验证服务器 - 一键部署"

    print_info "开始部署..."
    echo ""

    check_root
    detect_os
    install_nodejs
    install_pm2
    create_project_dir
    copy_server_files
    install_dependencies
    generate_admin_key
    configure_env
    configure_firewall
    start_server
    verify_service
    show_public_key
    show_completion

    print_success "部署完成！"
}

# 运行主函数
main
