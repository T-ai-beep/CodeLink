import inquirer from 'inquirer';
import ora from 'ora';
import { getDb, hubExists, createHub } from '../db';
import { printSuccess, printError, printWarning, printHeader } from '../ui/display';
import type { NewLink } from '../db';

export async function runCreate(): Promise<void> {
  printHeader('Create New Hub');

  try {
    const { code } = await inquirer.prompt<{ code: string }>([
      {
        type: 'input',
        name: 'code',
        message: 'Enter a short code for this hub (e.g. SKN, BIO101):',
        validate: (input: string) => {
          const trimmed = input.trim();
          if (!trimmed) {
            return 'Code cannot be empty.';
          }
          if (!/^[A-Za-z0-9]+$/.test(trimmed)) {
            return 'Code must be alphanumeric (letters and numbers only).';
          }
          if (trimmed.length > 12) {
            return 'Code must be 12 characters or fewer.';
          }
          return true;
        },
        filter: (input: string) => input.trim().toUpperCase(),
      },
    ]);

    const checkSpinner = ora('Checking if code is available...').start();
    let db;
    try {
      db = getDb();
    } catch (err) {
      checkSpinner.fail('Failed to connect to database.');
      printError(String(err));
      return;
    }

    if (hubExists(db, code)) {
      checkSpinner.fail(`Code "${code}" is already in use.`);
      printWarning('Choose a different code or use "update" to modify the existing hub.');
      return;
    }

    checkSpinner.succeed(`Code "${code}" is available.`);

    const { label } = await inquirer.prompt<{ label: string }>([
      {
        type: 'input',
        name: 'label',
        message: 'Enter a descriptive label for this hub:',
        validate: (input: string) => {
          if (!input.trim()) {
            return 'Label cannot be empty.';
          }
          return true;
        },
        filter: (input: string) => input.trim(),
      },
    ]);

    const links: NewLink[] = [];

    console.log('');
    console.log('Add links to this hub. Enter an empty title when you are done.');
    console.log('');

    let addingLinks = true;
    while (addingLinks) {
      const { title } = await inquirer.prompt<{ title: string }>([
        {
          type: 'input',
          name: 'title',
          message: `Link ${links.length + 1} title (leave blank to finish):`,
          filter: (input: string) => input.trim(),
        },
      ]);

      if (!title) {
        if (links.length === 0) {
          printWarning('No links added. You can add links later using "update".');
        }
        addingLinks = false;
        break;
      }

      const { url } = await inquirer.prompt<{ url: string }>([
        {
          type: 'input',
          name: 'url',
          message: `Link ${links.length + 1} URL:`,
          validate: (input: string) => {
            if (!input.trim()) {
              return 'URL cannot be empty.';
            }
            try {
              new URL(input.trim());
              return true;
            } catch {
              return 'Please enter a valid URL (e.g. https://example.com).';
            }
          },
          filter: (input: string) => input.trim(),
        },
      ]);

      links.push({ title, url });
    }

    const saveSpinner = ora('Creating hub...').start();

    try {
      createHub(db, { code, label }, links);
      saveSpinner.succeed('Hub created successfully.');
    } catch (err) {
      saveSpinner.fail('Failed to create hub.');
      printError(String(err));
      return;
    } finally {
      db.close();
    }

    console.log('');
    printSuccess(`Hub "${code}" is now live with ${links.length} link(s).`);
  } catch (err) {
    printError('An unexpected error occurred: ' + String(err));
  }
}
