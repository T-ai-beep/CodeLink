import inquirer from 'inquirer';
import ora from 'ora';
import { getDb, getAllHubs, getHubWithLinks, updateHub } from '../db';
import { printSuccess, printError, printWarning, printHeader, getDaysSince } from '../ui/display';
import type { NewLink } from '../db';

export async function runUpdate(): Promise<void> {
  printHeader('Update Existing Hub');

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

    const choices = hubs.map((hub) => {
      const days = getDaysSince(hub.updated_at);
      const staleMark = days >= 7 ? ' ⚠ (stale)' : '';
      return {
        name: `${hub.code.padEnd(14)} ${hub.label}${staleMark}`,
        value: hub.code,
      };
    });

    const { selectedCode } = await inquirer.prompt<{ selectedCode: string }>([
      {
        type: 'list',
        name: 'selectedCode',
        message: 'Select a hub to update:',
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

    const daysSinceUpdate = getDaysSince(hub.updated_at);
    if (daysSinceUpdate >= 7) {
      printWarning(
        `This hub has not been updated in ${daysSinceUpdate} days. Consider reviewing all links.`
      );
      console.log('');
    }

    const { label } = await inquirer.prompt<{ label: string }>([
      {
        type: 'input',
        name: 'label',
        message: 'Hub label:',
        default: hub.label,
        validate: (input: string) => {
          if (!input.trim()) {
            return 'Label cannot be empty.';
          }
          return true;
        },
        filter: (input: string) => input.trim(),
      },
    ]);

    console.log('');
    console.log('Enter new links for this hub. Existing links will be replaced.');
    if (hub.links.length > 0) {
      console.log('Current links:');
      hub.links.forEach((link, index) => {
        console.log(`  ${index + 1}. ${link.title} — ${link.url}`);
      });
    }
    console.log('');
    console.log('Add new links below. Leave title blank when done.');
    console.log('');

    const links: NewLink[] = [];
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
          printWarning('No links entered. The hub will be saved with no links.');
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

    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: `Save changes to "${hub.code}" with ${links.length} link(s)?`,
        default: true,
      },
    ]);

    if (!confirmed) {
      printWarning('Update cancelled. No changes were saved.');
      return;
    }

    const saveSpinner = ora('Saving changes...').start();

    try {
      updateHub(db, hub.id, label, links);
      saveSpinner.succeed('Hub updated successfully.');
    } catch (err) {
      saveSpinner.fail('Failed to update hub.');
      printError(String(err));
      return;
    }

    console.log('');
    printSuccess(`Hub "${hub.code}" updated with ${links.length} link(s).`);
  } catch (err) {
    printError('An unexpected error occurred: ' + String(err));
  } finally {
    db.close();
  }
}
