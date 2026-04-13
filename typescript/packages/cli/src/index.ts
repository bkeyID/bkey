#!/usr/bin/env node
// copyright © 2025-2026 bkey inc. all rights reserved.

import { Command } from 'commander';
import { authCommand } from './commands/auth.js';
import { vaultCommand } from './commands/vault.js';
import { proxyCommand } from './commands/proxy.js';
import { wrapCommand } from './commands/wrap.js';
import { checkoutCommand } from './commands/checkout.js';
import { approveCommand } from './commands/approve.js';
import { BUILD_COMMIT, BUILD_DATE } from './lib/build-info.js';

const VERSION = '0.1.0';

const program = new Command();

program
  .name('bkey')
  .description('BKey CLI — secure credential proxy for AI agents')
  .version(VERSION);

program
  .command('version')
  .description('Show CLI version, build commit, and build date')
  .action(() => {
    console.log(`bkey ${VERSION}`);
    console.log(`commit: ${BUILD_COMMIT}`);
    console.log(`built:  ${BUILD_DATE}`);
  });

program.addCommand(authCommand);
program.addCommand(vaultCommand);
program.addCommand(proxyCommand);
program.addCommand(wrapCommand);
program.addCommand(checkoutCommand);
program.addCommand(approveCommand);

program.parse();
