import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import Table from 'cli-table3';
import { getDb, getAllHubs, getHubWithLinks } from '../db';
import type { HubWithLinks } from '../db';
import { printError, printWarning, printHeader } from '../ui/display';

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatLastUpdated(isoString: string): string {
  const days = Math.floor((Date.now() - new Date(isoString).getTime()) / (1000 * 60 * 60 * 24));
  const dateStr = formatDate(isoString);
  if (days === 0) return chalk.green(dateStr + ' (today)');
  if (days === 1) return chalk.green(dateStr + ' (yesterday)');
  if (days < 7) return chalk.green(dateStr + ` (${days} days ago)`);
  return chalk.yellow(dateStr + ` (${days} days ago) ⚠`);
}

function formatExpiry(hub: HubWithLinks): string {
  if (hub.expires_at === null) {
    return chalk.grey('No expiry');
  }
  const now = Math.floor(Date.now() / 1000);
  const expDate = new Date(hub.expires_at * 1000).toLocaleString();
  if (hub.expires_at <= now) {
    const daysAgo = Math.floor((now - hub.expires_at) / (60 * 60 * 24));
    return chalk.red(`EXPIRED: ${expDate} (${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago)`);
  }
  const daysLeft = Math.ceil((hub.expires_at - now) / (60 * 60 * 24));
  return chalk.green(`Expires: ${expDate} (${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining)`);
}

function renderHubDetail(hub: HubWithLinks): void {
  printHeader(`Hub: ${hub.code}`);

  const metaTable = new Table({
    style: { head: [], border: ['grey'] },
  });

  metaTable.push(
    [chalk.bold('Code'), chalk.cyan(hub.code)],
    [chalk.bold('Label'), hub.label],
    [chalk.bold('Created'), formatDate(hub.created_at)],
    [chalk.bold('Last Updated'), formatLastUpdated(hub.updated_at)],
    [chalk.bold('Expires'), formatExpiry(hub)]
  );

  if (hub.fallback_msg) {
    metaTable.push([chalk.bold('Fallback'), hub.fallback_msg]);
  }

  console.log(metaTable.toString());
  console.log('');

  if (hub.links.length === 0) {
    printWarning('No links attached to this hub.');
    return;
  }

  console.log(chalk.bold('Links:'));
  console.log('');

  const linksTable = new Table({
    head: [chalk.bold.white('#'), chalk.bold.white('Title'), chalk.bold.white('URL')],
    colWidths: [5, 28, 50],
    style: { head: [], border: ['grey'] },
  });

  hub.links.forEach((link, index) => {
    linksTable.push([chalk.grey(String(index + 1)), link.title, chalk.blue.underline(link.url)]);
  });

  console.log(linksTable.toString());
}

export async function runView(): Promise<void> {
  printHeader('View Hub');

  let db;
  try {
    db = getDb();
  } catch (err) {
    printError('Failed to connect to database: ' + String(err));
    return;
  }

  try {
    const loadSpinner = ora('Loading hubs...').start();
    const hubs = getAllHubs(db);
    loadSpinner.stop();

    if (hubs.length === 0) {
      printWarning('No hubs exist yet. Use "create" to add one.');
      return;
    }

    const choices = hubs.map((hub) => ({
      name: `${hub.code.padEnd(14)} ${hub.label}`,
      value: hub.code,
    }));

    const { selectedCode } = await inquirer.prompt<{ selectedCode: string }>([
      {
        type: 'list',
        name: 'selectedCode',
        message: 'Select a hub to view:',
        choices,
      },
    ]);

    const fetchSpinner = ora('Fetching hub details...').start();
    const hub = getHubWithLinks(db, selectedCode);
    fetchSpinner.stop();

    if (!hub) {
      printError(`Hub "${selectedCode}" could not be found.`);
      return;
    }

    renderHubDetail(hub);
  } catch (err) {
    printError('An unexpected error occurred: ' + String(err));
  } finally {
    db.close();
  }
}
