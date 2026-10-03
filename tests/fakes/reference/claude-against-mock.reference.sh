#!/bin/bash
# usage: cc.sh <cfgdir> <args...>  ; runs claude against the mock with an isolated config dir
CFG=$1; shift
exec env -i HOME="$HOME" PATH="$PATH" TERM=dumb USER="$USER" ANTHROPIC_BASE_URL=http://127.0.0.1:47811 ANTHROPIC_API_KEY=sk-ant-fake-000 \
  CLAUDE_CONFIG_DIR="$CFG" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 $EXTRA_ENV claude "$@"
