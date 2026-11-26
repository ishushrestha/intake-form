import { chromium, type BrowserContext, type Page } from "playwright";
import { assertAllowedUrl, type AllowedHostSet } from "../allowlist.js";

export interface RecordsAdminTarget {
  readonly baseUrl: string;
  readonly username: string;
  readonly password: string;
}

export interface ProposedRecordsEntry {
  readonly artistId: string;
  readonly artistName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly address: string;
  readonly imagePath: string;
}

export interface RecordsAdminPlaybook {
  readonly submitEntry: (
    target: RecordsAdminTarget,
    proposed: ProposedRecordsEntry,
    screenshotPath: string,
  ) => Promise<{ readonly entryId: string }>;
}

/**
 * Read the new entry ID after the create form navigates.
 * records-admin does not show a labeled Entry ID on the detail page; the id is
 * the last path segment of `/artists/:artistId/entries/:entryId`.
 */
export function entryIdFromPageUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const match = parsed.pathname.match(/\/entries\/([^/]+)\/?$/);
  const id = match?.[1];
  if (id === undefined || id.length === 0 || id === "new") {
    return undefined;
  }
  return id;
}

async function applyHostAllowlist(context: BrowserContext, allowedHosts: AllowedHostSet): Promise<void> {
  await context.route("**/*", async (route) => {
    try {
      assertAllowedUrl(route.request().url(), allowedHosts);
    } catch {
      await route.abort();
      return;
    }
    await route.fallback();
  });
}

async function screenshotBestEffort(page: Page | undefined, screenshotPath: string): Promise<void> {
  if (page === undefined) {
    return;
  }
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
}

async function loginIfNeeded(page: Page, target: RecordsAdminTarget): Promise<void> {
  const loginHeading = page.getByRole("heading", { name: "Log in" });
  if ((await loginHeading.count()) === 0) {
    return;
  }
  await page.getByRole("textbox", { name: "Username" }).fill(target.username);
  await page.getByRole("textbox", { name: "Password" }).fill(target.password);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("heading", { name: "Artists" }).waitFor();
}

async function openOrCreateArtist(page: Page, proposed: ProposedRecordsEntry): Promise<void> {
  await page.getByRole("heading", { name: "Artists" }).waitFor();
  const artistsTable = page.getByRole("table", { name: "Artists" });
  const row = artistsTable.getByRole("row").filter({
    has: page.getByRole("cell", { name: proposed.artistId, exact: true }),
  });
  if ((await row.count()) > 0) {
    await row.getByRole("link").click();
    await page.getByText(`ID ${proposed.artistId}`, { exact: false }).waitFor();
    return;
  }
  await page.getByRole("button", { name: "Create artist" }).click();
  await page.getByRole("heading", { name: "Create artist" }).waitFor();
  await page.getByRole("textbox", { name: "Name" }).fill(proposed.artistName);
  await page.getByRole("button", { name: "Create artist" }).click();
  await page.getByRole("button", { name: "Create entry" }).waitFor();
}

async function createEntry(page: Page, proposed: ProposedRecordsEntry): Promise<string> {
  await page.getByRole("button", { name: "Create entry" }).click();
  await page.getByRole("heading", { name: "Create entry" }).waitFor();
  await page.getByRole("textbox", { name: "First name" }).fill(proposed.firstName);
  await page.getByRole("textbox", { name: "Last name" }).fill(proposed.lastName);
  await page.getByRole("textbox", { name: "Address" }).fill(proposed.address);
  await page.getByLabel("Image").setInputFiles(proposed.imagePath);
  await page.getByRole("button", { name: "Create entry" }).click();
  await page.getByRole("button", { name: "Back to artist", exact: true }).waitFor();
  await page.waitForURL((url) => entryIdFromPageUrl(url.toString()) !== undefined);
  const entryId = entryIdFromPageUrl(page.url());
  if (entryId === undefined) {
    throw new Error("The records-admin page did not show a labeled entry ID; the URL after create had none.");
  }
  return entryId;
}

export function createRecordsAdminPlaybook(options: {
  readonly headed: boolean;
  readonly allowedHosts: AllowedHostSet;
}): RecordsAdminPlaybook {
  return {
    submitEntry: async (target, proposed, screenshotPath) => {
      const origin = assertAllowedUrl(target.baseUrl, options.allowedHosts).origin;
      const browser = await chromium.launch({ headless: !options.headed });
      let page: Page | undefined;
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await applyHostAllowlist(context, options.allowedHosts);
        page = await context.newPage();
        await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
        await loginIfNeeded(page, target);
        await openOrCreateArtist(page, proposed);
        const entryId = await createEntry(page, proposed);
        await screenshotBestEffort(page, screenshotPath);
        return { entryId };
      } catch (error) {
        await screenshotBestEffort(page, screenshotPath);
        throw error;
      } finally {
        await browser.close();
      }
    },
  };
}
