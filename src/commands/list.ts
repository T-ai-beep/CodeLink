import ora from 'ora';
import { getDb, getAllHubs } from '../db';
import { printError, printHeader, printHubTable } from '../ui/display';

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

    printHubTable(hubs);

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
