import inquirer from 'inquirer';
import ora from 'ora';
import { getDb, getAllHubs, getHubWithLinks, updateHub, updateHubExpiry, clearHubExpiry } from '../db';
import { printSuccess, printError, printWarning, printInfo, printHeader, getDaysSince } from '../ui/display';
import type { NewLink } from '../db';

function validateDate(input: string): true | string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return 'Use format YYYY-MM-DD (e.g. 2025-06-15).';
  }
  const d = new Date(input + 'T00:00:00');
  if (isNaN(d.getTime())) {
    return 'Invalid date. Please enter a real calendar date.';
  }
  return true;
}

function validateTime(input: string): true | string {
  if (!/^\d{2}:\d{2}$/.test(input)) {
    return 'Use format HH:MM in 24h (e.g. 14:30).';
  }
  const [h, m] = input.split(':').map(Number);
  if (h < 0 || h > 23 || m < 0 || m > 59) {
    return 'Invalid time. Hours 00–23, minutes 00–59.';
  }
  return true;
}

function toUnixTimestamp(date: string, time: string): number {
  return Math.floor(new Date(`${date}T${time}:00`).getTime() / 1000);
}

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

    let expiresAt: number | null = null;
    let fallbackMsg: string = '';
    let shouldClearExpiry: boolean = false;

    console.log('');

    if (hub.expires_at !== null) {
      const currentExpiry = new Date(hub.expires_at * 1000).toLocaleString();
      printInfo(`Current expiry: ${currentExpiry}`);

      const { removeExpiry } = await inquirer.prompt<{ removeExpiry: boolean }>([
        {
          type: 'confirm',
          name: 'removeExpiry',
          message: 'Remove expiry?',
          default: false,
        },
      ]);

      if (removeExpiry) {
        shouldClearExpiry = true;
      } else {
        const { changeExpiry } = await inquirer.prompt<{ changeExpiry: boolean }>([
          {
            type: 'confirm',
            name: 'changeExpiry',
            message: 'Update expiry?',
            default: false,
          },
        ]);

        if (changeExpiry) {
          const { expiryDate } = await inquirer.prompt<{ expiryDate: string }>([
            {
              type: 'input',
              name: 'expiryDate',
              message: 'Expiry date (YYYY-MM-DD):',
              validate: validateDate,
            },
          ]);

          const { expiryTime } = await inquirer.prompt<{ expiryTime: string }>([
            {
              type: 'input',
              name: 'expiryTime',
              message: 'Expiry time (HH:MM, 24h, local time):',
              validate: validateTime,
            },
          ]);

          const { expFallback } = await inquirer.prompt<{ expFallback: string }>([
            {
              type: 'input',
              name: 'expFallback',
              message: 'Fallback message (shown after expiry):',
              default: hub.fallback_msg ?? '',
              validate: (input: string) =>
                input.trim() ? true : 'Fallback message cannot be empty.',
              filter: (input: string) => input.trim(),
            },
          ]);

          expiresAt = toUnixTimestamp(expiryDate, expiryTime);
          fallbackMsg = expFallback;
        }
      }
    } else {
      const { setExpiry } = await inquirer.prompt<{ setExpiry: boolean }>([
        {
          type: 'confirm',
          name: 'setExpiry',
          message: 'Set an expiry for this hub?',
          default: false,
        },
      ]);

      if (setExpiry) {
        const { expiryDate } = await inquirer.prompt<{ expiryDate: string }>([
          {
            type: 'input',
            name: 'expiryDate',
            message: 'Expiry date (YYYY-MM-DD):',
            validate: validateDate,
          },
        ]);

        const { expiryTime } = await inquirer.prompt<{ expiryTime: string }>([
          {
            type: 'input',
            name: 'expiryTime',
            message: 'Expiry time (HH:MM, 24h, local time):',
            validate: validateTime,
          },
        ]);

        const { expFallback } = await inquirer.prompt<{ expFallback: string }>([
          {
            type: 'input',
            name: 'expFallback',
            message: 'Fallback message (shown after expiry):',
            validate: (input: string) =>
              input.trim() ? true : 'Fallback message cannot be empty.',
            filter: (input: string) => input.trim(),
          },
        ]);

        expiresAt = toUnixTimestamp(expiryDate, expiryTime);
        fallbackMsg = expFallback;
      }
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
      if (shouldClearExpiry) {
        clearHubExpiry(db, hub.id);
      } else if (expiresAt !== null) {
        updateHubExpiry(db, hub.id, expiresAt, fallbackMsg);
      }
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
