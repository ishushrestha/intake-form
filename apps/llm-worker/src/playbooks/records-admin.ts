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
  ) => Promise<{ readonly entryId: string; readonly artistId: string }>;
}

export function artistNotFoundMessage(artistId: string): string {
  return `Artist ${artistId} not found in records-admin`;
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

/** Artist ID from `/artists/:artistId` on the rendered page URL. */
export function artistIdFromPageUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const match = parsed.pathname.match(/\/artists\/([^/]+)/);
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
  const artists = page.getByRole("heading", { name: "Artists" });
  const alert = page.getByRole("alert");
  try {
    await Promise.race([artists.waitFor({ timeout: 8000 }), alert.waitFor({ timeout: 8000 })]);
  } catch {
    throw new Error("records-admin login failed");
  }
  if ((await artists.count()) === 0) {
    throw new Error("records-admin login failed");
  }
}

async function openOrCreateArtist(page: Page, proposed: ProposedRecordsEntry): Promise<void> {
  await page.getByRole("heading", { name: "Artists" }).waitFor();
  const requestedId = proposed.artistId.trim();
  if (requestedId.length > 0) {
    const artistsTable = page.getByRole("table", { name: "Artists" });
    const row = artistsTable.getByRole("row").filter({
      has: page.getByRole("cell", { name: requestedId, exact: true }),
    });
    if ((await row.count()) === 0) {
      throw new Error(artistNotFoundMessage(requestedId));
    }
    await row.getByRole("link").click();
    await page.getByText(`ID ${requestedId}`, { exact: false }).waitFor();
    return;
  }
  await page.getByRole("button", { name: "Create artist" }).click();
  await page.getByRole("heading", { name: "Create artist" }).waitFor();
  await page.getByRole("textbox", { name: "Name" }).fill(proposed.artistName);
  await page.getByRole("button", { name: "Create artist" }).click();
  await page.getByRole("button", { name: "Create entry" }).waitFor();
}

async function createEntry(page: Page, proposed: ProposedRecordsEntry): Promise<{ entryId: string; artistId: string }> {
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
  const artistId = artistIdFromPageUrl(page.url());
  if (entryId === undefined) {
    throw new Error("The records-admin page did not show a labeled entry ID; the URL after create had none.");
  }
  if (artistId === undefined) {
    throw new Error("The records-admin page did not show the artist ID after creating the entry.");
  }
  return { entryId, artistId };
}

export function createRecordsAdminPlaybook(options: {
  readonly headed: boolean;
  readonly allowedHosts: AllowedHostSet;
  readonly httpCredentials?: { readonly username: string; readonly password: string };
}): RecordsAdminPlaybook {
  return {
    submitEntry: async (target, proposed, screenshotPath) => {
      const origin = assertAllowedUrl(target.baseUrl, options.allowedHosts).origin;
      const browser = await chromium.launch({ headless: !options.headed });
      let page: Page | undefined;
      try {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 900 },
          httpCredentials: options.httpCredentials,
        });
        await applyHostAllowlist(context, options.allowedHosts);
        page = await context.newPage();
        await page.goto(`${origin}/login`, { waitUntil: "networkidle" });
        await loginIfNeeded(page, target);
        await openOrCreateArtist(page, proposed);
        const created = await createEntry(page, proposed);
        await screenshotBestEffort(page, screenshotPath);
        return created;
      } catch (error) {
        await screenshotBestEffort(page, screenshotPath);
        throw error;
      } finally {
        await browser.close();
      }
    },
  };
}
