#!/usr/bin/env node
import inquirer from 'inquirer';
import chalk from 'chalk';
import { runCreate } from './commands/create';
import { runUpdate } from './commands/update';
import { runView } from './commands/view';
import { runList } from './commands/list';

const BANNER = `
${chalk.bold.blue('╔═══════════════════════════════╗')}
${chalk.bold.blue('║')}  ${chalk.bold.cyan('EduCode')} ${chalk.grey('— School Hub Manager')}  ${chalk.bold.blue('║')}
${chalk.bold.blue('╚═══════════════════════════════╝')}
`;

type Command = 'create' | 'update' | 'view' | 'list' | 'exit';

const COMMAND_HANDLERS: Record<Exclude<Command, 'exit'>, () => Promise<void>> = {
  create: runCreate,
  update: runUpdate,
  view: runView,
  list: runList,
};

async function selectCommand(): Promise<Command> {
  const { command } = await inquirer.prompt<{ command: Command }>([
    {
      type: 'list',
      name: 'command',
      message: 'What would you like to do?',
      choices: [
        { name: `${chalk.green('create')}  — Create a new hub with a short code`, value: 'create' },
        { name: `${chalk.yellow('update')}  — Update an existing hub's links`, value: 'update' },
        { name: `${chalk.cyan('view')}    — View full details of a hub`, value: 'view' },
        { name: `${chalk.blue('list')}    — List all active hubs`, value: 'list' },
        new inquirer.Separator(),
        { name: `${chalk.grey('exit')}    — Quit EduCode`, value: 'exit' },
      ],
    },
  ]);
  return command;
}

async function main(): Promise<void> {
  console.log(BANNER);

  const args = process.argv.slice(2);
  const directCommand = args[0] as Command | undefined;

  if (directCommand && directCommand in COMMAND_HANDLERS) {
    const handler = COMMAND_HANDLERS[directCommand as Exclude<Command, 'exit'>];
    await handler();
    return;
  }

  if (directCommand && directCommand !== undefined) {
    console.log(chalk.red(`Unknown command: "${directCommand}"`));
    console.log(chalk.grey('Available commands: create, update, view, list'));
    console.log('');
  }

  let running = true;
  while (running) {
    try {
      const command = await selectCommand();

      if (command === 'exit') {
        console.log('');
        console.log(chalk.grey('Goodbye!'));
        running = false;
        break;
      }

      const handler = COMMAND_HANDLERS[command];
      await handler();
      console.log('');
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.message.includes('force closed') || err.message.includes('User force closed'))
      ) {
        console.log('');
        console.log(chalk.grey('Goodbye!'));
        running = false;
        break;
      }
      console.log(chalk.red('Unexpected error: ' + String(err)));
    }
  }
}

main().catch((err) => {
  console.error(chalk.red('Fatal error: ' + String(err)));
  process.exit(1);
});
