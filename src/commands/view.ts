import inquirer from 'inquirer';
import ora from 'ora';
import { getDb, getAllHubs, getHubWithLinks } from '../db';
import { printError, printWarning, printHeader, printHubDetail } from '../ui/display';

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

    printHubDetail(hub);
  } catch (err) {
    printError('An unexpected error occurred: ' + String(err));
  } finally {
    db.close();
  }
}
