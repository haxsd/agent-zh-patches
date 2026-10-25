#!/usr/bin/env node
'use strict';
/**
 * agent-zh-patches 统一入口。
 *
 *   node tools/zh.js <detect|status|doctor|scan|pending|merge|verify|plan|apply|audit|restore> \
 *     --app cursor|devin [--data <dir>] [--app-dir <dir>] [--json]
 */
const { run } = require('../core/commands');

process.exit(run(process.argv.slice(2)));
