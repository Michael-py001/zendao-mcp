#!/bin/bash
#
# 禅道 MCP 服务器 — 全量测试套件
#
# 2026-09-20 整理：
#   - 去掉 `test:token`（package.json 里从来没有这个脚本，这一步一直在静默失败）
#   - 去掉 `test:performance`（性能用例已随 P1 工具收敛一起删除）
#   - 补上 `test:unit`（原先漏了，而它是最快、最该先跑的一层）
#   - 状态标记改用 ASCII（[OK]/[FAIL]）—— 原来的 emoji 在非 UTF-8 终端里
#     会显示成乱码，反而分不清到底跑没跑过
#
set -e

echo "========================================="
echo "  禅道 MCP 服务器 - 全量测试套件"
echo "========================================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_message() {
    local color=$1
    local message=$2
    echo -e "${color}${message}${NC}"
}

# 环境检查
check_environment() {
    print_message "$YELLOW" "
[..] 检查测试环境..."

    if [ ! -f "package.json" ]; then
        print_message "$RED" "[FAIL] 请在项目根目录运行此脚本"
        exit 1
    fi

    if [ ! -f ".env" ]; then
        print_message "$RED" "[FAIL] .env 文件不存在"
        print_message "$YELLOW" "       请运行: cp .env.example .env"
        exit 1
    fi

    if [ ! -d "dist" ]; then
        print_message "$YELLOW" "[..] 构建项目..."
        npm run build
    fi

    print_message "$GREEN" "[OK] 环境检查通过"
}

# 清理之前的测试结果
cleanup_previous_results() {
    print_message "$YELLOW" "
[..] 清理之前的测试结果..."
    npm run test:clean 2>/dev/null || true
    print_message "$GREEN" "[OK] 清理完成"
}

# 运行单个测试层
run_tests() {
    local test_type=$1
    local test_name=$2

    print_message "$YELLOW" "
[..] 运行 $test_name 测试..."

    if npm run "test:$test_type"; then
        print_message "$GREEN" "[OK] $test_name 测试通过"
        return 0
    else
        print_message "$RED" "[FAIL] $test_name 测试失败"
        return 1
    fi
}

main() {
    local failed_tests=()

    check_environment
    cleanup_previous_results

    print_message "$GREEN" "
========================================="
    print_message "$GREEN" "  开始测试流程"
    print_message "$GREEN" "========================================="

    # 由快到慢：纯单元 -> 启动 -> 认证 -> 工具功能 -> 错误处理 -> 集成
    run_tests "unit" "单元" || failed_tests+=("单元")
    run_tests "startup" "启动" || failed_tests+=("启动")
    run_tests "auth" "认证" || failed_tests+=("认证")
    run_tests "tools" "MCP 工具功能" || failed_tests+=("MCP 工具功能")
    run_tests "errors" "错误处理" || failed_tests+=("错误处理")
    run_tests "integration" "集成" || failed_tests+=("集成")

    print_message "$YELLOW" "
[..] 生成测试覆盖率报告..."
    npm run test:coverage
    print_message "$GREEN" "[OK] 覆盖率报告已生成 (coverage/index.html)"

    print_message "$GREEN" "
========================================="
    print_message "$GREEN" "  测试完成"
    print_message "$GREEN" "========================================="

    if [ ${#failed_tests[@]} -eq 0 ]; then
        print_message "$GREEN" "
[OK] 所有测试通过！"
        print_message "$GREEN" "     覆盖率报告: coverage/index.html"
        exit 0
    else
        print_message "$RED" "
[FAIL] 以下测试失败:"
        for test in "${failed_tests[@]}"; do
            print_message "$RED" "  - $test"
        done
        print_message "$YELLOW" "
请查看上述错误信息并修复问题"
        exit 1
    fi
}

main "$@"
