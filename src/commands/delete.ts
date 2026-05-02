import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import { getDb, getAllHubs, getHubWithLinks, deleteHub, isHubExpired } from '../db';
import { printSuccess, printError, printWarning, printHeader } from '../ui/display';

export async function runDelete(): Promise<void> {
  printHeader('Delete Hub');

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
      printWarning('No hubs exist yet. Nothing to delete.');
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
        message: 'Select a hub to delete:',
        choices,
      },
    ]);

    const fetchSpinner = ora('Loading hub details...').start();
    const hub = getHubWithLinks(db, selectedCode);
    fetchSpinner.stop();

    if (!hub) {
      printError(`Hub "${selectedCode}" could not be found.`);
      return;
    }

    const expiryStatus =
      hub.expires_at === null
        ? chalk.grey('No expiry')
        : isHubExpired(hub)
        ? chalk.red('EXPIRED ' + new Date(hub.expires_at * 1000).toLocaleDateString())
        : chalk.green('Expires ' + new Date(hub.expires_at * 1000).toLocaleDateString());

    console.log('');
    console.log(chalk.bold('This will permanently delete:'));
    console.log('');
    console.log(`  Code:   ${chalk.cyan(hub.code)}`);
    console.log(`  Label:  ${hub.label}`);
    console.log(`  Links:  ${hub.links.length}`);
    console.log(`  Expiry: ${expiryStatus}`);
    console.log('');

    const { confirmation } = await inquirer.prompt<{ confirmation: string }>([
      {
        type: 'input',
        name: 'confirmation',
        message: `Type ${chalk.cyan(hub.code)} to confirm deletion:`,
      },
    ]);

    if (confirmation.trim().toUpperCase() !== hub.code) {
      printWarning('Deletion cancelled. No changes were made.');
      return;
    }

    const deleteSpinner = ora('Deleting hub...').start();

    try {
      deleteHub(db, hub.id);
      deleteSpinner.succeed('Done.');
    } catch (err) {
      deleteSpinner.fail('Failed to delete hub.');
      printError(String(err));
      return;
    }

    console.log('');
    printSuccess(`Hub ${hub.code} deleted.`);
  } catch (err) {
    printError('An unexpected error occurred: ' + String(err));
  } finally {
    db.close();
  }
}
