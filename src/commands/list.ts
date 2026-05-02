import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getDb, getAllHubs } from '../db';
import type { Hub } from '../db';
import { printError, printWarning, printHeader } from '../ui/display';

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatUpdated(isoString: string): string {
  const days = Math.floor((Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24));
  const dateStr = formatDate(isoString);
  return days >= 7 ? chalk.yellow(dateStr + ' ⚠') : chalk.green(dateStr);
}

function formatExpiryCell(hub: Hub): string {
  if (hub.expires_at === null) {
    return chalk.dim('—');
  }
  const now = Math.floor(Date.now() / 1000);
  const dateStr = new Date(hub.expires_at * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  if (hub.expires_at <= now) {
    return chalk.red('✖ ' + dateStr);
  }
  const daysLeft = Math.ceil((hub.expires_at - now) / (60 * 60 * 24));
  if (daysLeft < 3) {
    return chalk.yellow('⚠ ' + dateStr);
  }
  return chalk.green(dateStr);
}

function printHubsTable(hubs: Hub[]): void {
  if (hubs.length === 0) {
    printWarning('No hubs found. Use "create" to add one.');
    return;
  }

  const table = new Table({
    head: [
      chalk.bold.white('Code'),
      chalk.bold.white('Label'),
      chalk.bold.white('Created'),
      chalk.bold.white('Last Updated'),
      chalk.bold.white('Expiry'),
    ],
    colWidths: [14, 26, 18, 18, 20],
    style: { head: [], border: ['grey'] },
  });

  for (const hub of hubs) {
    table.push([
      chalk.cyan(hub.code),
      hub.label,
      chalk.grey(formatDate(hub.created_at)),
      formatUpdated(hub.updated_at),
      formatExpiryCell(hub),
    ]);
  }

  console.log(table.toString());
}

export async function runList(): Promise<void> {
  printHeader('All Hubs');

  let db;
  try {
    db = getDb();
  } catch (err) {
    printError('Failed to connect to database: ' + String(err));
    return;
  }

  try {
    const spinner = ora('Loading hubs...').start();
    const hubs = getAllHubs(db);
    spinner.stop();

    printHubsTable(hubs);

    if (hubs.length > 0) {
      console.log('');
      console.log(`Total: ${hubs.length} hub(s)`);
    }
  } catch (err) {
    printError('An unexpected error occurred: ' + String(err));
  } finally {
    db.close();
  }
}
