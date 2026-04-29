import chalk from 'chalk';
import Table from 'cli-table3';
import type { Hub, HubWithLinks } from '../db';

export function printSuccess(message: string): void {
  console.log(chalk.green('✓ ' + message));
}

export function printError(message: string): void {
  console.log(chalk.red('✗ ' + message));
}

export function printWarning(message: string): void {
  console.log(chalk.yellow('⚠ ' + message));
}

export function printInfo(message: string): void {
  console.log(chalk.cyan('ℹ ' + message));
}

export function printHeader(title: string): void {
  const line = '─'.repeat(title.length + 4);
  console.log('');
  console.log(chalk.bold.blue('┌' + line + '┐'));
  console.log(chalk.bold.blue('│  ' + title + '  │'));
  console.log(chalk.bold.blue('└' + line + '┘'));
  console.log('');
}

export function printHubTable(hubs: Hub[]): void {
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
    ],
    colWidths: [14, 30, 22, 22],
    style: { head: [], border: ['grey'] },
  });

  for (const hub of hubs) {
    const daysSinceUpdate = getDaysSince(hub.updated_at);
    const updatedLabel =
      daysSinceUpdate >= 7
        ? chalk.yellow(formatDate(hub.updated_at) + ' ⚠')
        : chalk.green(formatDate(hub.updated_at));

    table.push([
      chalk.cyan(hub.code),
      hub.label,
      chalk.grey(formatDate(hub.created_at)),
      updatedLabel,
    ]);
  }

  console.log(table.toString());
}

export function printHubDetail(hub: HubWithLinks): void {
  printHeader(`Hub: ${hub.code}`);

  const metaTable = new Table({
    style: { head: [], border: ['grey'] },
  });

  metaTable.push(
    [chalk.bold('Code'), chalk.cyan(hub.code)],
    [chalk.bold('Label'), hub.label],
    [chalk.bold('Created'), formatDate(hub.created_at)],
    [chalk.bold('Last Updated'), formatLastUpdated(hub.updated_at)]
  );

  console.log(metaTable.toString());
  console.log('');

  if (hub.links.length === 0) {
    printWarning('No links attached to this hub.');
    return;
  }

  console.log(chalk.bold('Links:'));
  console.log('');

  const linksTable = new Table({
    head: [
      chalk.bold.white('#'),
      chalk.bold.white('Title'),
      chalk.bold.white('URL'),
    ],
    colWidths: [5, 28, 50],
    style: { head: [], border: ['grey'] },
  });

  hub.links.forEach((link, index) => {
    linksTable.push([
      chalk.grey(String(index + 1)),
      link.title,
      chalk.blue.underline(link.url),
    ]);
  });

  console.log(linksTable.toString());
}

function formatDate(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatLastUpdated(isoString: string): string {
  const days = getDaysSince(isoString);
  const dateStr = formatDate(isoString);

  if (days === 0) {
    return chalk.green(dateStr + ' (today)');
  } else if (days === 1) {
    return chalk.green(dateStr + ' (yesterday)');
  } else if (days < 7) {
    return chalk.green(dateStr + ` (${days} days ago)`);
  } else {
    return chalk.yellow(dateStr + ` (${days} days ago) ⚠`);
  }
}

export function getDaysSince(isoString: string): number {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}
