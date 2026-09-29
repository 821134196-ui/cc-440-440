#!/usr/bin/env python3
"""单条本地启动命令:

    python3 run.py            # 初始化数据库 + 生成演示样例 + 启动服务(8000 端口)
    python3 run.py --reset    # 清空数据后重新生成
    python3 run.py --port 9000

测试: python3 -m unittest discover -s tests -v
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from esports.api import serve
from esports.db import Database, init_db
from esports.seed import seed_base, seed_demo
from esports.services import ArenaService


def main() -> None:
    ap = argparse.ArgumentParser(description="电竞馆电脑包机与外设交接系统")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--db", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                 "data", "esports.db"))
    ap.add_argument("--reset", action="store_true", help="删除已有数据后重新初始化")
    args = ap.parse_args()

    if args.reset and os.path.exists(args.db):
        os.remove(args.db)
    os.makedirs(os.path.dirname(args.db), exist_ok=True)

    db = Database(args.db)
    init_db(db)
    svc = ArenaService(db)
    seed_base(db)
    seed_demo(db, svc)  # 生成包机、故障、结账样例
    serve(svc, args.port)


if __name__ == "__main__":
    main()
